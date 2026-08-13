using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Dotswitch;

/// <summary>
/// The window. Frameless by design: the title bar, minimise and close are drawn
/// in HTML alongside the rest of the UI, which is what lets this be a small
/// control board rather than a document window.
/// </summary>
public sealed class MainForm : Form
{
    private const int WsSizeBox = 0x00040000;   // resizable edges + Windows snap
    private const int WmNcCalcSize = 0x0083;
    private const int WmNcLButtonDown = 0xA1;
    private const int HtCaption = 0x2;

    // Edge codes used when the UI asks to start a resize drag.
    private static readonly Dictionary<string, int> EdgeCodes = new()
    {
        ["w"] = 10, ["e"] = 11, ["n"] = 12, ["nw"] = 13,
        ["ne"] = 14, ["s"] = 15, ["sw"] = 16, ["se"] = 17,
    };

    // Windows 11 DWM attributes.
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaBorderColor = 34;
    private const int DwmwcpRound = 2;
    private const uint DwmwaColorNone = 0xFFFFFFFE;

    // Dark mode moved attribute number between Windows 10 builds; try the
    // current one and fall back, since neither errors visibly.
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;

    /// <summary>Where Windows records the light/dark choice for apps.</summary>
    private const string PersonalizeKey =
        @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

    // The two window backgrounds, mirrored from app.css. They exist here only
    // so the frame is already the right colour before WebView2 paints — a
    // white flash on a dark theme is the most obvious way to look unfinished.
    private static readonly Color DarkShell = Color.FromArgb(0x0B, 0x09, 0x0D);
    private static readonly Color LightShell = Color.FromArgb(0xFF, 0xFF, 0xFF);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private readonly WebView2 _web = new();
    private readonly ProjectRunner _runner = new();
    private readonly AppState _state = AppState.Load();
    private bool _uiReady;

    /// <summary>The theme actually in force, once the saved preference and the system have been reconciled.</summary>
    private bool _dark = true;

    /// <summary>
    /// Keeping the frame but removing its decoration is what preserves the
    /// behaviour people expect from a real window — drag-to-edge snapping,
    /// resize from any edge, a drop shadow — while leaving the chrome to us.
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // Keeps Windows snapping and the resize frame's behaviour, while
            // WM_NCCALCSIZE below stops it reserving any visible space.
            cp.Style |= WsSizeBox;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        // Windows 11 draws a 1px frame line around a sizeable window in the
        // system border colour — the pale edge you would otherwise see at the
        // top. COLOR_NONE removes it; the rounded corners then come from DWM
        // rather than being faked in CSS.
        var corner = DwmwcpRound;
        var border = unchecked((int)DwmwaColorNone);
        try
        {
            DwmSetWindowAttribute(Handle, DwmwaWindowCornerPreference, ref corner, sizeof(int));
            DwmSetWindowAttribute(Handle, DwmwaBorderColor, ref border, sizeof(int));
        }
        catch
        {
            // Pre-Windows-11: the attributes do not exist and the defaults stand.
        }

        ApplyWindowDarkMode();
    }

    /// <summary>
    /// Tells DWM which way the window leans, so the drop shadow and any frame
    /// Windows still draws match the palette inside.
    /// </summary>
    private void ApplyWindowDarkMode()
    {
        if (!IsHandleCreated) return;
        var on = _dark ? 1 : 0;
        try
        {
            if (DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkMode, ref on, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkModeLegacy, ref on, sizeof(int));
            }
        }
        catch
        {
            // Older Windows: no immersive dark mode, nothing to fall back to.
        }
    }

    protected override void WndProc(ref Message m)
    {
        // Make the client area cover the entire window. WS_SIZEBOX normally
        // reserves a frame that nothing paints, which showed through as a pale
        // translucent border along the top, right and bottom.
        if (m.Msg == WmNcCalcSize && m.WParam != IntPtr.Zero)
        {
            m.Result = IntPtr.Zero;
            return;
        }

        base.WndProc(ref m);
    }

    /// <summary>Arguments from this launch, replayed once the UI is up.</summary>
    private readonly string[] _pendingArgs;

    public MainForm(string[]? args = null)
    {
        _pendingArgs = args ?? Array.Empty<string>();
        _dark = ResolveDark(_state.Theme);

        Text = "Dotswitch";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        MinimumSize = new Size(360, 240);
        // Matches the UI's own background so there is no flash of the wrong
        // colour before WebView2 paints its first frame.
        BackColor = _dark ? DarkShell : LightShell;
        ShowInTaskbar = true;

        LoadWindowIcon();

        ApplySavedBounds();

        TopMost = _state.AlwaysOnTop;

        _web.Dock = DockStyle.Fill;
        _web.DefaultBackgroundColor = BackColor;
        Controls.Add(_web);

        _runner.Changed += OnRunnerChanged;
        _runner.Logged += OnRunnerLogged;

        // Following Windows means noticing when Windows changes: the palette has
        // to repaint under the user rather than at the next launch.
        Microsoft.Win32.SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;

        WatchTheme();
        Load += async (_, _) => await InitialiseWebViewAsync();
        FormClosing += OnFormClosing;
        ResizeEnd += (_, _) => PersistBounds();
        Move += (_, _) => PersistBounds();
    }

    // ── Light / dark ──────────────────────────────────────

    /// <summary>Reads the Windows "choose your mode" setting for apps.</summary>
    private static bool SystemPrefersDark()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(PersonalizeKey);
            // Absent on some installs, in which case Windows itself defaults to light.
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        }
        catch
        {
            return true;   // unreadable: the app's own default is the dark one
        }
    }

    private static bool ResolveDark(string? mode) => mode switch
    {
        "light" => false,
        "dark" => true,
        _ => SystemPrefersDark(),
    };

    private void OnUserPreferenceChanged(object? sender, Microsoft.Win32.UserPreferenceChangedEventArgs e)
    {
        // General is the category Windows raises for a light/dark switch. It
        // arrives on a system thread, and touching the form needs the UI one.
        if (e.Category != Microsoft.Win32.UserPreferenceCategory.General) return;
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(() => ApplyAppearance()); } catch { }
    }

    /// <summary>
    /// Reconcile the saved preference with the system, then repaint both halves
    /// of the window — the WinForms shell and the HTML inside it.
    /// </summary>
    private void ApplyAppearance()
    {
        _dark = ResolveDark(_state.Theme);

        var shell = _dark ? DarkShell : LightShell;
        BackColor = shell;
        if (!_web.IsDisposed) _web.DefaultBackgroundColor = shell;

        ApplyWindowDarkMode();
        PushAppearance();
    }

    private void PushAppearance() =>
        Post(JsonSerializer.Serialize(new
        {
            type = "appearance",
            mode = string.IsNullOrEmpty(_state.Theme) ? "system" : _state.Theme,
            dark = _dark,
        }));

    /// <summary>
    /// Prefer the .ico file, which carries every size Windows wants for the
    /// taskbar, Alt-Tab and the title bar. If it is missing, fall back to the
    /// copy embedded in the exe so we never end up on the default icon.
    /// </summary>
    private void LoadWindowIcon()
    {
        var file = Path.Combine(AppContext.BaseDirectory, "dotswitch.ico");
        try
        {
            if (File.Exists(file))
            {
                Icon = new Icon(file);
                return;
            }
        }
        catch
        {
            // Corrupt or locked — try the embedded one below.
        }

        try
        {
            var exe = Environment.ProcessPath;
            if (exe is not null) Icon = Icon.ExtractAssociatedIcon(exe);
        }
        catch
        {
            // Default icon it is.
        }
    }

    // ── Window geometry ───────────────────────────────────

    private void ApplySavedBounds()
    {
        var w = Math.Max(_state.WindowWidth, MinimumSize.Width);
        var h = Math.Max(_state.WindowHeight, MinimumSize.Height);

        // A saved position from a monitor that is no longer attached would put
        // the window somewhere unreachable, so fall back to the primary screen.
        var onScreen = _state.WindowX >= 0 && _state.WindowY >= 0 &&
            Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(
                new Rectangle(_state.WindowX, _state.WindowY, w, h)));

        Size = new Size(w, h);
        if (onScreen)
        {
            Location = new Point(_state.WindowX, _state.WindowY);
        }
        else
        {
            var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
            Location = new Point(wa.Right - w - 40, wa.Top + 60);
        }
    }

    private void PersistBounds()
    {
        if (WindowState != FormWindowState.Normal) return;
        _state.WindowX = Location.X;
        _state.WindowY = Location.Y;
        _state.WindowWidth = Size.Width;
        _state.WindowHeight = Size.Height;
        _state.Save();
    }

    // ── WebView plumbing ──────────────────────────────────

    private async Task InitialiseWebViewAsync()
    {
        // Keep the profile out of the install directory so the app works from a
        // read-only location.
        var env = await CoreWebView2Environment.CreateAsync(
            null, Path.Combine(AppState.Dir, "WebView2"));
        await _web.EnsureCoreWebView2Async(env);

        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = true;   // handy while iterating on the UI
        core.Settings.IsZoomControlEnabled = false;

        // Serve wwwroot over a virtual host: file:// would put us in an opaque
        // origin, where fetch and modern CSS features behave inconsistently.
        core.SetVirtualHostNameToFolderMapping(
            "dotswitch.local",
            Path.Combine(AppContext.BaseDirectory, "wwwroot"),
            CoreWebView2HostResourceAccessKind.Allow);

        core.WebMessageReceived += OnWebMessage;

        // Anything that would navigate away opens in the real browser instead.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };

        core.Navigate("https://dotswitch.local/index.html");
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); }
        catch { return; }

        JsonElement msg;
        try { msg = JsonDocument.Parse(raw).RootElement; }
        catch { return; }

        var type = msg.TryGetProperty("type", out var t) ? t.GetString() : null;
        var id = msg.TryGetProperty("id", out var i) ? i.GetString() : null;

        switch (type)
        {
            case "ready":
                _uiReady = true;
                LoadProjects();
                PushState();
                PushChrome();
                PushAppearance();
                PushTheme();

                // Deferred until now so a project asked for on the command line
                // starts against a UI that can actually show it.
                if (_pendingArgs.Length > 0)
                {
                    var launch = _pendingArgs.ToArray();
                    Array.Clear(_pendingArgs);
                    HandleCommandLine(launch);
                }
                break;

            case "start" when id is not null:
                _runner.Start(id);
                break;

            case "stop" when id is not null:
                _runner.Stop(id);
                break;

            case "restart" when id is not null:
                _ = _runner.RestartAsync(id);
                break;

            case "hardRestart" when id is not null:
                _ = _runner.HardRestartAsync(id);
                break;

            case "stopAll":
                _ = _runner.StopAllAsync();
                break;

            case "setProfile" when id is not null:
                {
                    var profile = msg.TryGetProperty("profile", out var p) ? p.GetString() : null;
                    if (profile is null) break;
                    _runner.SetProfile(id, profile);
                    _state.SetProfile(id, profile);
                    PushState();
                    break;
                }

            case "forget" when id is not null:
                _runner.Stop(id);
                _runner.Remove(id);
                _state.Forget(id);
                PushState();
                break;

            case "reorder":
                {
                    if (!msg.TryGetProperty("ids", out var ids) || ids.ValueKind != JsonValueKind.Array) break;
                    var order = ids.EnumerateArray()
                        .Select(x => x.GetString())
                        .Where(x => x is not null)
                        .Select(x => x!)
                        .ToList();
                    _state.Reorder(order);
                    LoadProjects();
                    PushState();
                    break;
                }

            case "requestLogs" when id is not null:
                Post(JsonSerializer.Serialize(new
                {
                    type = "logs",
                    id,
                    text = _runner.LogsFor(id),
                }));
                break;

            case "clearLogs" when id is not null:
                _runner.ClearLogs(id);
                Post(JsonSerializer.Serialize(new { type = "logs", id, text = "" }));
                break;

            case "copyLogs" when id is not null:
                {
                    // Done host-side: WinForms owns the clipboard on an STA
                    // thread, which is more dependable than the web API here.
                    var text = _runner.LogsFor(id);
                    try
                    {
                        if (string.IsNullOrEmpty(text)) Clipboard.Clear();
                        else Clipboard.SetText(text);
                    }
                    catch
                    {
                        // Another process can hold the clipboard open; the UI
                        // has already flashed its confirmation either way.
                    }
                    break;
                }

            case "openUrl" when id is not null:
                {
                    var url = _runner.Get(id)?.Url;
                    if (!string.IsNullOrWhiteSpace(url)) OpenExternal(url);
                    break;
                }

            // ── Window chrome, driven from the HTML title bar ──
            case "drag":
                ReleaseCapture();
                SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
                break;

            // With no non-client area left, Windows reports every point as
            // client and would never start a resize, so the UI's edge strips
            // tell us which border was grabbed.
            case "resize":
                {
                    var edge = msg.TryGetProperty("edge", out var ed) ? ed.GetString() : null;
                    if (edge is null || !EdgeCodes.TryGetValue(edge, out var code)) break;
                    ReleaseCapture();
                    SendMessage(Handle, WmNcLButtonDown, code, 0);
                    break;
                }

            case "addProject":
                PromptForProject();
                break;

            case "killStrays":
                KillStrayWatchers();
                break;

            case "openLink":
                {
                    var url = msg.TryGetProperty("url", out var u) ? u.GetString() : null;
                    // Only http(s), so a crafted message cannot launch a local
                    // program through the shell.
                    if (url is not null &&
                        (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                         url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)))
                    {
                        OpenExternal(url);
                    }
                    break;
                }

            case "minimise":
                WindowState = FormWindowState.Minimized;
                break;

            case "close":
                Close();
                break;

            case "pin":
                _state.AlwaysOnTop = !_state.AlwaysOnTop;
                _state.Save();
                TopMost = _state.AlwaysOnTop;
                PushChrome();
                break;

            case "setTheme":
                {
                    var mode = msg.TryGetProperty("mode", out var md) ? md.GetString() : null;
                    // Anything unrecognised means follow Windows, which is also
                    // the state the cycle returns to.
                    _state.Theme = mode is "light" or "dark" ? mode : "system";
                    _state.Save();
                    ApplyAppearance();
                    break;
                }
        }
    }

    private static void OpenExternal(string url)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url)
            {
                UseShellExecute = true,   // hands the URL to the default browser
            });
        }
        catch
        {
            // A malformed URL is not worth surfacing as a dialog.
        }
    }

    // ── State pushing ─────────────────────────────────────

    private void Post(string json)
    {
        // Marshal FIRST. Reading _web.CoreWebView2 is a control access, so
        // touching it from a process-output thread threw a cross-thread
        // exception and took the whole app down a moment after a project
        // started producing output.
        if (InvokeRequired)
        {
            try { BeginInvoke(() => Post(json)); } catch { }
            return;
        }

        if (!_uiReady || IsDisposed || _web.IsDisposed || _web.CoreWebView2 is null) return;
        try { _web.CoreWebView2.PostWebMessageAsString(json); } catch { }
    }

    private void PushState() => Post(_runner.SnapshotJson());

    private void PushChrome() =>
        Post(JsonSerializer.Serialize(new { type = "chrome", pinned = _state.AlwaysOnTop }));

    /// <summary>
    /// Hand the UI whatever palette the VS Code extension last exported.
    ///
    /// The window's own chrome is Dotswitch's palette now and does not follow
    /// the editor, but the log drawer still takes its ANSI colours from here so
    /// output looks the way it does in your integrated terminal.
    /// </summary>
    private void PushTheme()
    {
        try
        {
            var file = Path.Combine(AppState.Dir, "theme.json");
            if (!File.Exists(file)) return;

            var palette = File.ReadAllText(file);
            if (string.IsNullOrWhiteSpace(palette)) return;

            // Forwarded verbatim: the UI decides which keys it can use, so a
            // newer extension can add colours without a matching app release.
            Post("{\"type\":\"theme\",\"palette\":" + palette + "}");
        }
        catch
        {
            // Mid-write or malformed — the watcher will bring the next one.
        }
    }

    /// <summary>
    /// Re-apply the palette when the extension rewrites it, so switching theme
    /// in VS Code repaints this window without restarting it.
    /// </summary>
    private void WatchTheme()
    {
        try
        {
            Directory.CreateDirectory(AppState.Dir);
            var watcher = new FileSystemWatcher(AppState.Dir, "theme.json")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName,
                EnableRaisingEvents = true,
            };

            // Editors write in more than one operation; a short settle avoids
            // reading a half-written file.
            void Reload(object? _, FileSystemEventArgs __)
            {
                Task.Delay(150).ContinueWith(_ =>
                {
                    if (!IsDisposed) BeginInvoke(PushTheme);
                });
            }

            watcher.Changed += Reload;
            watcher.Created += Reload;
            _themeWatcher = watcher;
        }
        catch
        {
            // Without a watcher the theme still applies at startup.
        }
    }

    private FileSystemWatcher? _themeWatcher;

    private void OnRunnerChanged() => PushState();

    private void OnRunnerLogged(string id, string text) =>
        Post(JsonSerializer.Serialize(new { type = "log", id, text }));

    /// <summary>Rebuild the runner's list from the saved projects, in saved order.</summary>
    private void LoadProjects()
    {
        var order = 0;
        foreach (var saved in _state.Ordered().ToList())
        {
            if (!File.Exists(saved.Path))
            {
                // Moved or deleted since we last saw it.
                _state.Forget(saved.Path);
                continue;
            }
            RegisterProject(saved.Path, saved.Profile, order++);
        }
    }

    private ProjectEntry RegisterProject(string csproj, string? preferredProfile, int order)
    {
        var profiles = LaunchProfiles.Read(csproj);
        var available = profiles.Count > 0 ? profiles : new List<string> { "http", "https" };
        var profile =
            preferredProfile is not null && available.Contains(preferredProfile) ? preferredProfile
            : available.Contains("https") ? "https"
            : available[0];

        return _runner.Register(new ProjectEntry
        {
            Id = csproj,
            Csproj = csproj,
            Dir = Path.GetDirectoryName(csproj) ?? ".",
            Name = LaunchProfiles.DisplayName(csproj),
            RelPath = csproj,
            Profiles = available,
            Profile = profile,
            Order = order,
        });
    }

    // ── Command line, from the VS Code extension ──────────

    /// <summary>
    /// Handles <c>--run &lt;csproj&gt; [--profile https]</c>: adds the project,
    /// starts it, and brings the window forward.
    /// </summary>
    public void HandleCommandLine(string[] args)
    {
        string? csproj = null;
        string profile = "https";

        for (var i = 0; i < args.Length; i++)
        {
            if ((args[i] == "--run" || args[i] == "-r") && i + 1 < args.Length) csproj = args[++i];
            else if ((args[i] == "--profile" || args[i] == "-p") && i + 1 < args.Length) profile = args[++i];
        }

        Surface();

        if (csproj is null || !File.Exists(csproj)) return;

        _state.Remember(csproj, profile);
        LoadProjects();
        _runner.SetProfile(csproj, profile);

        var entry = _runner.Get(csproj);
        if (entry?.Proc is null) _runner.Start(csproj);
        else _ = _runner.RestartAsync(csproj);

        PushState();
    }

    private void Surface()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        BringToFront();
    }

    /// <summary>
    /// Adds a project from the app itself, so the VS Code extension is a
    /// convenience rather than a requirement.
    /// </summary>
    private void PromptForProject()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Add a .NET project",
            Filter = "Project files (*.csproj)|*.csproj",
            CheckFileExists = true,
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        var csproj = dialog.FileName;
        var profiles = LaunchProfiles.Read(csproj);
        var profile = profiles.Contains("https") ? "https"
            : profiles.Count > 0 ? profiles[0]
            : "https";

        _state.Remember(csproj, profile);
        LoadProjects();
        PushState();
    }

    /// <summary>
    /// Find and offer to kill `dotnet watch` processes Dotswitch did not start —
    /// left behind by a VS Code terminal, or orphaned by an earlier crash.
    /// They hold their ports, which makes the next start of that project fail
    /// for reasons nothing in this window explains.
    /// </summary>
    private void KillStrayWatchers()
    {
        var owned = _runner.All()
            .Select(e => e.Proc?.Id)
            .Where(id => id.HasValue)
            .Select(id => id!.Value);

        var strays = StrayProcesses.Find(owned);

        if (strays.Count == 0)
        {
            MessageBox.Show(this,
                "No stray dotnet watch processes found.\n\nEverything running is managed by Dotswitch.",
                "Dotswitch", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var list = string.Join("\n", strays.Take(15).Select(s => $"    {s.Project}  (pid {s.Pid})"));
        if (strays.Count > 15) list += $"\n    ...and {strays.Count - 15} more";

        var answer = MessageBox.Show(this,
            $"Found {strays.Count} dotnet watch process(es) not managed by Dotswitch:\n\n{list}\n\n" +
            "Terminate them and everything they started?",
            "Terminate stray processes",
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);

        if (answer != DialogResult.Yes) return;

        var killed = StrayProcesses.Kill(strays);
        MessageBox.Show(this,
            $"Terminated {killed} of {strays.Count}.",
            "Dotswitch", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    /// <summary>
    /// Closing must not orphan the children. Nothing else would reap them, and
    /// they would keep their ports bound with no window left to stop them from.
    /// The first close request starts the shutdown and is cancelled; the UI
    /// shows what is happening, and the real close follows once they are down.
    /// </summary>
    private bool _shuttingDown;

    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        PersistBounds();

        if (_shuttingDown) return;   // second pass — let it through

        var live = _runner.All().Count(x => x.Proc is not null);
        if (live == 0)
        {
            ReleaseResources();
            return;
        }

        e.Cancel = true;
        _shuttingDown = true;
        Post(JsonSerializer.Serialize(new { type = "closing", count = live }));

        try
        {
            await _runner.StopAllAsync();
        }
        catch
        {
            // Whatever happens, the window must still close.
        }

        ReleaseResources();
        Close();
    }

    /// <summary>
    /// SystemEvents keeps a static handler list, so an unhooked form would be
    /// kept alive and then called after disposal.
    /// </summary>
    private void ReleaseResources()
    {
        try { Microsoft.Win32.SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged; } catch { }
        _themeWatcher?.Dispose();
        _runner.Dispose();
    }
}
