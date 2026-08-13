using System.Diagnostics;
using System.Management;

namespace Dotswitch;

/// <summary>One `dotnet watch` that Dotswitch is not supervising.</summary>
public sealed record StrayProcess(int Pid, string CommandLine, string Project);

/// <summary>
/// Finds `dotnet watch` processes that Dotswitch did not start.
///
/// They accumulate easily: a watch launched from a VS Code terminal, or one
/// orphaned by a crash before the tree-kill on close existed. Each keeps its
/// port bound, so the next start of the same project fails for reasons that
/// are not obvious from inside this app.
/// </summary>
public static class StrayProcesses
{
    /// <summary>
    /// Every `dotnet watch` on the machine except the trees Dotswitch owns.
    ///
    /// <paramref name="ownedRoots"/> are Dotswitch's own watch PIDs; their whole
    /// subtree is excluded, since `dotnet watch` spawns `dotnet run` which
    /// spawns the app.
    /// </summary>
    public static List<StrayProcess> Find(IEnumerable<int> ownedRoots)
    {
        var all = new Dictionary<int, (int Parent, string Name, string Cmd)>();

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process");
            foreach (var row in searcher.Get())
            {
                try
                {
                    var pid = Convert.ToInt32(row["ProcessId"]);
                    var parent = row["ParentProcessId"] is null ? 0 : Convert.ToInt32(row["ParentProcessId"]);
                    all[pid] = (parent, (row["Name"] as string) ?? "", (row["CommandLine"] as string) ?? "");
                }
                catch
                {
                    // A process that exited mid-enumeration; skip it.
                }
                finally
                {
                    row.Dispose();
                }
            }
        }
        catch
        {
            // WMI unavailable — report nothing rather than guessing.
            return new List<StrayProcess>();
        }

        // Everything descended from a PID we own, so children are not reported.
        var owned = new HashSet<int>(ownedRoots);
        var grew = true;
        while (grew)
        {
            grew = false;
            foreach (var (pid, info) in all)
            {
                if (!owned.Contains(pid) && owned.Contains(info.Parent))
                {
                    owned.Add(pid);
                    grew = true;
                }
            }
        }

        var strays = new List<StrayProcess>();
        foreach (var (pid, info) in all)
        {
            if (owned.Contains(pid)) continue;
            if (!info.Name.Equals("dotnet.exe", StringComparison.OrdinalIgnoreCase)) continue;

            // Only the watch roots. Their `dotnet run` children die with them,
            // and listing those too would triple the count for no benefit.
            var cmd = info.Cmd;
            if (string.IsNullOrEmpty(cmd)) continue;
            if (!System.Text.RegularExpressions.Regex.IsMatch(cmd, @"\bwatch\b")) continue;

            strays.Add(new StrayProcess(pid, cmd, ProjectFrom(cmd)));
        }

        return strays.OrderBy(s => s.Project).ToList();
    }

    /// <summary>Pull the project name out of a command line, for a readable list.</summary>
    private static string ProjectFrom(string commandLine)
    {
        var match = System.Text.RegularExpressions.Regex.Match(
            commandLine, @"--project\s+""?([^""\s]+)""?");
        if (match.Success)
        {
            return Path.GetFileNameWithoutExtension(match.Groups[1].Value);
        }
        return "(unknown project)";
    }

    /// <summary>Kill each stray and everything below it. Returns how many died.</summary>
    public static int Kill(IEnumerable<StrayProcess> strays)
    {
        var killed = 0;
        foreach (var stray in strays)
        {
            try
            {
                using var kill = Process.Start(new ProcessStartInfo("taskkill")
                {
                    ArgumentList = { "/PID", stray.Pid.ToString(), "/T", "/F" },
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                });
                kill?.WaitForExit(4000);
                killed++;
            }
            catch
            {
                // Already gone, or not ours to kill.
            }
        }
        return killed;
    }
}
