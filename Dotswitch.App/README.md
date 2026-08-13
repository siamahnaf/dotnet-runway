# Dotswitch (standalone app)

A small frameless window that runs and manages .NET projects with `dotnet watch`.

This exists because a VS Code extension structurally cannot be a real window. A
webview panel is a guest inside VS Code's own window, so it always inherits
VS Code's title bar, its tab strip, and its taskbar identity — none of which any
extension API can reach. A separate process can, and does:

- **Its own Windows taskbar button**, with its own icon
  (`SetCurrentProcessExplicitAppUserModelID`, so the shell never groups it under
  whatever launched it)
- **No tab bar, no host title bar** — the bar at the top is HTML, drawn by us
- **Custom minimise, close and keep-on-top**
- **Remembers its size and position** properly, in `%APPDATA%\Dotswitch\state.json`
- Keeps running after VS Code closes

## Requirements

Already present on a typical Windows 11 dev machine, and verified on this one:

- .NET 9 desktop runtime
- WebView2 Runtime (ships with Windows 11 / Edge)

## Build

```bash
dotnet publish -c Release -o dist
```

`dist\Dotswitch.exe` is what the VS Code extension launches.

## Use

Right-click a project in VS Code → **Run** → *Run with https* / *Run with http*.
The extension shells out to:

```
Dotswitch.exe --run <path-to.csproj> --profile https
```

The app is single-instance: a second launch forwards its arguments over a named
pipe to the window already open and exits, so there is only ever one process
table and one window.

Projects stay in the list once added. Drag the grip on the left of a card to
reorder them; the order is saved.

| Control | Does |
| --- | --- |
| ▶ / ■ | Start / stop (stop kills the whole tree — watch, `dotnet run`, the app) |
| ↻ | Restart |
| ⚡ | Hard restart — stop, full `dotnet build`, start |
| ↗ | Open the listening URL in your default browser |
| ▤ | Live output |
| 🗑 | Remove from the list |

## Stale-code protection

`dotnet watch` compiles once then runs with `--no-build`, pushing later edits in
through Hot Reload. When Hot Reload cannot apply a change — a *rude edit* — the
running app keeps serving the **old** code.

Three guards, all here in the tooling, none requiring a line of change in your
own projects:

1. `--non-interactive` is always passed, so watch cannot stop and wait for a
   keypress nothing will send.
2. Dotswitch watches for the rude-edit message and restarts the project itself,
   after a short grace period in case watch recovers on its own.
3. Hard restart forces a real compile whenever you want certainty.

## Layout

| File | Role |
| --- | --- |
| `Program.cs` | Entry point, single instance, taskbar identity, pipe server |
| `MainForm.cs` | Frameless window, WebView2 host, message bridge |
| `ProjectRunner.cs` | Process management and output parsing |
| `AppState.cs` | Project list, ordering, window geometry |
| `LaunchProfiles.cs` | Reads `launchSettings.json` |
| `wwwroot/` | The UI |
