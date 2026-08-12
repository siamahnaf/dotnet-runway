using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

namespace Runway;

internal static class Program
{
    private const string MutexName = "Propsys.Runway.SingleInstance";
    internal const string PipeName = "Propsys.Runway.Pipe";

    /// <summary>
    /// Gives the process its own identity in the Windows shell. Without it a
    /// .NET app can be grouped under whatever launched it — which for us is
    /// VS Code, and being a separate taskbar button is the entire point.
    /// </summary>
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern void SetCurrentProcessExplicitAppUserModelID(
        [MarshalAs(UnmanagedType.LPWStr)] string appId);

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            SetCurrentProcessExplicitAppUserModelID("Propsys.Runway");
        }
        catch
        {
            // Shell API missing is not fatal — we just lose taskbar grouping.
        }

        // One window, always. A second launch (typically the VS Code extension
        // asking to run a project) hands its arguments to the live instance and
        // exits, rather than opening a rival window with its own process table.
        using var mutex = new Mutex(true, MutexName, out var isFirst);
        if (!isFirst)
        {
            ForwardToRunningInstance(args);
            return;
        }

        // A background thread throwing would otherwise take the whole window
        // down silently, killing every project it was supervising.
        Application.ThreadException += (_, e) => LogFatal("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => LogFatal("background", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            LogFatal("task", e.Exception);
            e.SetObserved();
        };
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        ApplicationConfiguration.Initialize();

        // The launch arguments belong to this instance. Previously only the
        // forwarding path read them, so starting the app *by* asking it to run
        // a project opened an empty window and did nothing.
        var form = new MainForm(args);
        StartPipeServer(form);
        Application.Run(form);
    }

    /// <summary>
    /// Record a crash somewhere findable instead of vanishing. Nothing is shown
    /// to the user: a modal error box behind a frameless window is worse than
    /// a line in a log.
    /// </summary>
    private static void LogFatal(string origin, Exception? ex)
    {
        if (ex is null) return;
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Runway");
            Directory.CreateDirectory(dir);
            File.AppendAllText(
                Path.Combine(dir, "error.log"),
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] ({origin}) {ex}{Environment.NewLine}{Environment.NewLine}");
        }
        catch
        {
            // If even logging fails there is nothing sensible left to do.
        }
    }

    private static void ForwardToRunningInstance(string[] args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(3000);
            var payload = Encoding.UTF8.GetBytes(string.Join("", args));
            client.Write(payload, 0, payload.Length);
            client.Flush();
        }
        catch
        {
            // The other instance may be shutting down. Nothing useful to do:
            // showing an error box here would be worse than silence.
        }
    }

    /// <summary>
    /// Listens for arguments forwarded by later launches. Runs for the lifetime
    /// of the process on a background thread.
    /// </summary>
    private static void StartPipeServer(MainForm form)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                    server.WaitForConnection();

                    using var ms = new MemoryStream();
                    server.CopyTo(ms);
                    var text = Encoding.UTF8.GetString(ms.ToArray());
                    var args = text.Split('', StringSplitOptions.RemoveEmptyEntries);

                    if (args.Length > 0 && !form.IsDisposed)
                    {
                        form.BeginInvoke(() => form.HandleCommandLine(args));
                    }
                }
                catch
                {
                    // A broken pipe just means that client went away; keep serving.
                    Thread.Sleep(200);
                }
            }
        })
        {
            IsBackground = true,
            Name = "runway-pipe",
        };
        thread.Start();
    }
}
