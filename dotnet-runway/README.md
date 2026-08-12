# Dotnet Runway

Run .NET projects with `dotnet watch` and manage every one of them from a single
panel inside VS Code — start, stop, restart, hard restart, switch launch
profile, and read live logs.

## The panel

`Dotnet Runway: Open Runway` (or click the status bar item) opens the control
board. By default it detaches into its own **small floating VS Code window**, so
it can sit beside the editor without taking an editor slot.

It is a VS Code *webview* — VS Code's own UI layer, the same technology behind
the Settings and Extensions screens. It is not a browser, and it draws entirely
from your active colour theme.

Each project shows a status dot, uptime, pid, the listening URL and a hot-reload
counter, with these controls:

| Control | What it does |
| --- | --- |
| **Start** | `dotnet watch run --launch-profile <profile>` |
| **Stop** | Kills the whole process tree — watch, `dotnet run`, and the app |
| **Restart** | Stop, then start again |
| **Hard restart** | Stop, run a full `dotnet build`, then start |
| **Profile** | Switch between the profiles declared in `launchSettings.json` |
| **Logs** | Live output, with Clear |
| **URL** | Opens the running app in your browser |

`Stop all` and `Refresh` sit in the toolbar. Everything in the workspace is
listed whether or not it is running, so a project can be started from the panel
alone.

## Why "hard restart" exists

`dotnet watch` compiles once, then runs the app with `--no-build` and pushes
later edits in through Hot Reload. When Hot Reload meets a change it cannot
apply — a *rude edit* — the running app keeps serving the **old** code.

Three things guard against that, all of them inside this extension — you never
have to change a line of your own project:

1. **`--non-interactive` is on by default** (`dotnetRunway.nonInteractive`).
   Without it, watch stops on a rude edit and waits for a keypress. In a managed
   background process nothing will ever answer, so the edit silently never
   arrives. This is the single most common cause of "I changed the file and
   nothing happened".
2. **Auto-restart on rude edits** (`dotnetRunway.autoRestartOnRudeEdit`). Runway
   reads watch's output, and when it sees that a change could not be applied it
   restarts the project. It allows a few seconds first, so if watch handles it
   there is no double restart.
3. **Hard restart** forces a real compile whenever you want certainty.

> A common suggestion for Razor views is to add `AddRazorRuntimeCompilation()`
> to your app's `Program.cs`. Runway deliberately does not require that: it
> would mean every project using this extension editing its own startup code,
> and it would only ever help `.cshtml` files. Detecting the failure in the
> tooling covers `.cs` rude edits too, and leaves your projects untouched.

## Explorer right-click

Right-click any folder or `.csproj` → **Run** → *Run with https* / *Run with
http*. The project starts under the panel by default; set
`dotnetRunway.runIn` to `windowsTerminal` or `vscodeTerminal` for the old
console behaviour (those are not manageable from the panel, since the process
belongs to the terminal).

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `dotnetRunway.runIn` | `panel` | Where right-click launches go |
| `dotnetRunway.floatingWindow` | `true` | Open in a floating VS Code window |
| `dotnetRunway.nonInteractive` | `true` | Pass `--non-interactive` to watch |
| `dotnetRunway.autoRestartOnRudeEdit` | `true` | Restart when hot reload cannot apply a change |
| `dotnetRunway.autoOpenPanel` | `true` | Show the panel when a project starts |
| `dotnetRunway.stripPrefix` | `Propsys.` | Trimmed from displayed project names |
| `dotnetRunway.logBufferLines` | `4000` | Log lines kept per project |

## Building a new version

```bash
npm install          # once
npm run package      # patch bump  (1.1.0 -> 1.1.1)
npm run package:minor
npm run package:major
node build.js 2.0.0  # exact version
```

The `.vsix` is written to the parent `VS Code Extensions` folder, named
`dotnet-runway-<version>.vsix`.

## Installing

```
code --install-extension "dotnet-runway-1.3.0.vsix"
```

Or in VS Code: Extensions → `...` → **Install from VSIX**.

This replaced an earlier extension called *Dotnet Project Runner*. Because the
extension id changed, VS Code treats it as a separate extension — **uninstall
the old one** or both will add entries to the right-click menu.
