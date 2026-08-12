using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Runway;

public enum RunStatus { Stopped, Starting, Building, Running, Stopping, Crashed }

/// <summary>One project the app knows about, plus whatever it is doing now.</summary>
public sealed class ProjectEntry
{
    public string Id { get; init; } = "";          // full .csproj path
    public string Csproj { get; init; } = "";
    public string Dir { get; init; } = "";
    public string Name { get; set; } = "";
    public string RelPath { get; set; } = "";
    public List<string> Profiles { get; set; } = new();
    public string Profile { get; set; } = "https";
    public int Order { get; set; }

    public RunStatus Status { get; set; } = RunStatus.Stopped;
    public string? Url { get; set; }
    public string? LastEvent { get; set; }
    public DateTime? StartedAt { get; set; }
    public int? ExitCode { get; set; }
    public int HotReloads { get; set; }
    public int AutoRestarts { get; set; }

    internal Process? Proc;
    /// <summary>The `dotnet build` of a hard restart, so it can be cancelled too.</summary>
    internal Process? BuildProc;
    /// <summary>Set by Stop so a cancelled hard restart does not go on to start.</summary>
    internal bool CancelRequested;
    internal readonly List<string> Log = new();
    internal System.Threading.Timer? RudeTimer;
}

/// <summary>
/// Owns every child process and the state the UI renders.
///
/// Ported from the VS Code extension's runner so behaviour stays identical:
/// same arguments, same rude-edit recovery, same tree-kill on stop.
/// </summary>
public sealed class ProjectRunner : IDisposable
{
    /// <summary>
    /// Grace period before we restart a project ourselves after a rude edit.
    /// dotnet watch may or may not recover on its own and the SDK does not
    /// document which, so we let it try first and only step in if nothing
    /// happens. Correct under either behaviour.
    /// </summary>
    private const int RudeEditGraceMs = 4000;

    private static readonly Regex RudeEdit = new(
        @"rude edit|Unable to apply hot reload|hot reload.*(failed|not supported)|restart is needed",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex Listening = new(
        @"Now listening on:\s*(\S+)", RegexOptions.Compiled);

    /// <summary>
    /// Strips every escape sequence EXCEPT colour (SGR, the ones ending in 'm').
    /// Cursor moves and line erases would otherwise print as literal garbage,
    /// while the colour codes are what the log view renders.
    /// </summary>
    private static readonly Regex NonColourEscapes = new(
        @"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-9;?]*[A-Za-ln-z]|\x1B[()][0-9A-Za-z]",
        RegexOptions.Compiled);

    /// <summary>A carriage return with no newline rewrites the line in a real terminal; here it only corrupts the buffer.</summary>
    private static readonly Regex BareCarriageReturn = new(@"\r(?!\n)", RegexOptions.Compiled);

    private const int LogLimit = 4000;

    private readonly Dictionary<string, ProjectEntry> _entries = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _gate = new();

    public event Action? Changed;
    public event Action<string, string>? Logged;

    public bool AutoRestartOnRudeEdit { get; set; } = true;
    public bool NonInteractive { get; set; } = true;

    public ProjectEntry? Get(string id)
    {
        lock (_gate) return _entries.TryGetValue(id, out var e) ? e : null;
    }

    /// <summary>
    /// A snapshot, not a live view. Process output arrives on background threads
    /// and can register or drop entries while the UI is enumerating, which threw
    /// "collection was modified" mid-render.
    /// </summary>
    public IReadOnlyList<ProjectEntry> All()
    {
        lock (_gate) return _entries.Values.OrderBy(e => e.Order).ToList();
    }

    public ProjectEntry Register(ProjectEntry entry)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(entry.Id, out var existing))
            {
                existing.Name = entry.Name;
                existing.RelPath = entry.RelPath;
                existing.Profiles = entry.Profiles;
                existing.Order = entry.Order;
                if (!string.IsNullOrEmpty(entry.Profile)) existing.Profile = entry.Profile;
                return existing;
            }
            _entries[entry.Id] = entry;
            return entry;
        }
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(id, out var e) && e.Proc is null) _entries.Remove(id);
        }
        Changed?.Invoke();
    }

    public void SetProfile(string id, string profile)
    {
        var e = Get(id);
        if (e is null || e.Profile == profile) return;
        e.Profile = profile;
        Changed?.Invoke();
    }

    public string LogsFor(string id)
    {
        var e = Get(id);
        if (e is null) return "";
        lock (e.Log) return string.Concat(e.Log);
    }

    public void ClearLogs(string id)
    {
        var e = Get(id);
        if (e is null) return;
        lock (e.Log) e.Log.Clear();
    }

    // ── Lifecycle ─────────────────────────────────────────

    private string[] BuildArgs(ProjectEntry e)
    {
        var args = new List<string> { "watch" };
        // Without this, a change Hot Reload cannot apply leaves watch waiting
        // for a keypress that nothing in a headless process will ever send.
        if (NonInteractive) args.Add("--non-interactive");
        args.Add("--project");
        args.Add(Path.GetFileName(e.Csproj));
        args.Add("run");
        args.Add("--launch-profile");
        args.Add(e.Profile);
        return args.ToArray();
    }

    public void Start(string id)
    {
        var e = Get(id);
        if (e is null || e.Proc is not null) return;

        ClearRudeTimer(e);
        e.CancelRequested = false;   // a fresh start clears any earlier cancel
        e.Status = RunStatus.Starting;
        e.Url = null;
        e.ExitCode = null;
        e.LastEvent = "Starting";
        e.HotReloads = 0;
        e.StartedAt = DateTime.UtcNow;
        Changed?.Invoke();

        var args = BuildArgs(e);
        Append(e, $"\n> dotnet {string.Join(' ', args)}\n  in {e.Dir}\n\n");

        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = e.Dir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // .NET disables colour the moment stdout is redirected. These opt back
        // in, so the log view can render what a real terminal would show.
        psi.Environment["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"] = "1";
        psi.Environment["Logging__Console__FormatterOptions__ColorBehavior"] = "Enabled";
        psi.Environment["MSBUILDTERMINALLOGGER"] = "off";   // its cursor tricks do not survive a pipe

        Process proc;
        try
        {
            proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.OutputDataReceived += (_, ev) => { if (ev.Data is not null) Consume(e, ev.Data + "\n"); };
            proc.ErrorDataReceived += (_, ev) => { if (ev.Data is not null) Consume(e, ev.Data + "\n"); };
            proc.Exited += (_, _) => OnExited(e, proc);
            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            e.Status = RunStatus.Crashed;
            e.LastEvent = $"Failed to start: {ex.Message}";
            Append(e, $"Failed to start: {ex.Message}\n");
            Changed?.Invoke();
            return;
        }

        e.Proc = proc;
        Changed?.Invoke();
    }

    private void OnExited(ProjectEntry e, Process proc)
    {
        ClearRudeTimer(e);
        var deliberate = e.Status == RunStatus.Stopping;
        int? code = null;
        try { code = proc.ExitCode; } catch { }

        if (ReferenceEquals(e.Proc, proc)) e.Proc = null;
        e.ExitCode = code;
        e.Url = null;
        e.Status = deliberate || code == 0 ? RunStatus.Stopped : RunStatus.Crashed;
        e.LastEvent = deliberate ? "Stopped" : $"Exited with code {code}";
        Append(e, $"\n--- exited with code {code} ---\n");
        Changed?.Invoke();
    }

    /// <summary>
    /// Also the cancel button. A start can sit for a long time in restore or
    /// compile, and a hard restart spends that time in `dotnet build` with no
    /// watch process at all — both have to be interruptible.
    /// </summary>
    public void Stop(string id)
    {
        var e = Get(id);
        if (e is null) return;

        e.CancelRequested = true;
        ClearRudeTimer(e);

        var build = e.BuildProc;
        var proc = e.Proc;
        if (build is null && proc is null)
        {
            // Nothing live: settle the row rather than leaving it spinning.
            if (e.Status is RunStatus.Starting or RunStatus.Building)
            {
                e.Status = RunStatus.Stopped;
                e.LastEvent = "Cancelled";
                Changed?.Invoke();
            }
            return;
        }

        e.Status = RunStatus.Stopping;
        e.LastEvent = "Stopping";
        Changed?.Invoke();

        if (build is not null) KillTree(build);
        if (proc is not null) KillTree(proc);
    }

    public async Task RestartAsync(string id)
    {
        Stop(id);
        await WaitForExitAsync(id);
        Start(id);
    }

    /// <summary>
    /// Stop, compile from scratch, start again — the escape hatch for when the
    /// running app is older than the source and no reload will fix it.
    /// </summary>
    public async Task HardRestartAsync(string id)
    {
        var e = Get(id);
        if (e is null) return;

        Stop(id);
        await WaitForExitAsync(id);

        e.Status = RunStatus.Building;
        e.LastEvent = "Rebuilding";
        Changed?.Invoke();
        Append(e, $"\n> dotnet build\n  in {e.Dir}\n\n");

        var ok = await Task.Run(() =>
        {
            try
            {
                var psi = new ProcessStartInfo("dotnet")
                {
                    WorkingDirectory = e.Dir,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                psi.ArgumentList.Add("build");
                psi.ArgumentList.Add(Path.GetFileName(e.Csproj));
                psi.Environment["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"] = "1";
                psi.Environment["MSBUILDTERMINALLOGGER"] = "off";

                using var build = Process.Start(psi);
                if (build is null) return false;
                e.BuildProc = build;   // so Stop can cancel it

                build.OutputDataReceived += (_, ev) => { if (ev.Data is not null) Append(e, ev.Data + "\n"); };
                build.ErrorDataReceived += (_, ev) => { if (ev.Data is not null) Append(e, ev.Data + "\n"); };
                build.BeginOutputReadLine();
                build.BeginErrorReadLine();
                build.WaitForExit();
                return build.ExitCode == 0;
            }
            catch (Exception ex)
            {
                Append(e, $"Build error: {ex.Message}\n");
                return false;
            }
            finally
            {
                e.BuildProc = null;
            }
        });

        // Cancelled while compiling: stop here rather than starting the app the
        // user just asked us not to.
        if (e.CancelRequested)
        {
            e.Status = RunStatus.Stopped;
            e.LastEvent = "Cancelled";
            Append(e, "\n--- cancelled ---\n");
            Changed?.Invoke();
            return;
        }

        if (!ok)
        {
            e.Status = RunStatus.Crashed;
            e.LastEvent = "Build failed";
            Changed?.Invoke();
            return;
        }

        Start(id);
    }

    public async Task StopAllAsync()
    {
        foreach (var e in All().Where(x => x.Proc is not null).ToList())
        {
            Stop(e.Id);
        }
        foreach (var e in All().ToList()) await WaitForExitAsync(e.Id);
    }

    /// <summary>Poll until the tree is gone, capped so a wedged process cannot hang the UI.</summary>
    private async Task WaitForExitAsync(string id, int timeoutMs = 6000)
    {
        var waited = 0;
        while (waited < timeoutMs)
        {
            if (Get(id)?.Proc is null) return;
            await Task.Delay(100);
            waited += 100;
        }
    }

    /// <summary>
    /// dotnet watch spawns `dotnet run`, which spawns the app itself. Killing
    /// only the process we started would orphan both and leave the port bound.
    /// </summary>
    private static void KillTree(Process proc)
    {
        try
        {
            using var kill = Process.Start(new ProcessStartInfo("taskkill")
            {
                ArgumentList = { "/PID", proc.Id.ToString(), "/T", "/F" },
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            kill?.WaitForExit(4000);
        }
        catch
        {
            try { proc.Kill(true); } catch { }
        }
    }

    // ── Output parsing ────────────────────────────────────

    private void Append(ProjectEntry e, string text)
    {
        var clean = BareCarriageReturn.Replace(NonColourEscapes.Replace(text, ""), "");
        lock (e.Log)
        {
            e.Log.Add(clean);
            if (e.Log.Count > LogLimit) e.Log.RemoveRange(0, e.Log.Count - LogLimit);
        }
        Logged?.Invoke(e.Id, clean);
    }

    private static readonly Regex Sgr = new(@"\x1B\[[0-9;]*m", RegexOptions.Compiled);

    private void Consume(ProjectEntry e, string raw)
    {
        Append(e, raw);

        // Match against a colour-free copy, or an escape code adjacent to the
        // URL would be captured as part of it.
        var text = Sgr.Replace(raw, "");

        if (RudeEdit.IsMatch(text))
        {
            ScheduleAutoRestart(e);
            return;
        }

        var m = Listening.Match(text);
        if (m.Success)
        {
            ClearRudeTimer(e);
            e.Url ??= m.Groups[1].Value.Trim();
            e.Status = RunStatus.Running;
            e.LastEvent = "Running";
            Changed?.Invoke();
            return;
        }

        if (text.Contains("Hot reload of changes succeeded", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("Hot reload succeeded", StringComparison.OrdinalIgnoreCase))
        {
            e.HotReloads++;
            e.LastEvent = "Hot reloaded";
            Changed?.Invoke();
            return;
        }

        if (e.Status == RunStatus.Running &&
            (text.Contains("Restarting", StringComparison.OrdinalIgnoreCase) ||
             text.Contains("Shutdown requested", StringComparison.OrdinalIgnoreCase)))
        {
            ClearRudeTimer(e);
            e.Status = RunStatus.Starting;
            e.LastEvent = "Restarting";
            Changed?.Invoke();
        }
    }

    private void ScheduleAutoRestart(ProjectEntry e)
    {
        if (!AutoRestartOnRudeEdit || e.RudeTimer is not null) return;

        e.LastEvent = "Rude edit - restarting";
        Changed?.Invoke();

        e.RudeTimer = new System.Threading.Timer(_ =>
        {
            ClearRudeTimer(e);
            // If watch already handled it, the status will have moved on.
            if (e.Proc is null || e.Status != RunStatus.Running) return;
            e.AutoRestarts++;
            Append(e, "\n--- Runway: hot reload could not apply that change, restarting ---\n");
            _ = RestartAsync(e.Id);
        }, null, RudeEditGraceMs, Timeout.Infinite);
    }

    private static void ClearRudeTimer(ProjectEntry e)
    {
        var t = e.RudeTimer;
        e.RudeTimer = null;
        t?.Dispose();
    }

    // ── Serialisation for the UI ──────────────────────────

    public string SnapshotJson()
    {
        var rows = All().Select(e => new
        {
            id = e.Id,
            name = e.Name,
            relPath = e.RelPath,
            profile = e.Profile,
            profiles = e.Profiles,
            status = e.Status.ToString().ToLowerInvariant(),
            url = e.Url,
            pid = e.Proc?.Id,
            startedAt = e.StartedAt is null
                ? (long?)null
                : new DateTimeOffset(e.StartedAt.Value, TimeSpan.Zero).ToUnixTimeMilliseconds(),
            exitCode = e.ExitCode,
            lastEvent = e.LastEvent,
            hotReloads = e.HotReloads,
            autoRestarts = e.AutoRestarts,
        });

        return JsonSerializer.Serialize(new { type = "state", projects = rows });
    }

    public void Dispose()
    {
        foreach (var e in _entries.Values)
        {
            ClearRudeTimer(e);
            if (e.Proc is not null) KillTree(e.Proc);
        }
        _entries.Clear();
    }
}
