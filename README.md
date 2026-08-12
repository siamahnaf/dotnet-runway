# Runway

Run and manage .NET projects with `dotnet watch` from a small always-available
window, instead of a pile of terminal tabs.

Two pieces, and they do very different amounts of work:

| | What it is | What it does |
| --- | --- | --- |
| **Runway.App** | A standalone Windows app | Everything — the window, the processes, the list, the logs |
| **dotnet-runway** | A VS Code extension | Navigation only: adds *right-click → Run* and keeps the app matched to your VS Code theme |

The extension is optional. The app has an **+** button that adds a project from
a file picker, so it works on its own.

## Why two pieces

A VS Code extension cannot be a real window. A webview panel is a guest inside
VS Code's window, so it inherits VS Code's title bar, its tab strip and its
taskbar identity — none of which any extension API can change. A separate
process can, and that is why the app exists:

- Its own Windows taskbar button and icon
- No tab bar, no host title bar — frameless, with custom minimise and close
- Remembers its own size and position
- Keeps running after VS Code closes

Equally, only an extension can add an entry to VS Code's Explorer right-click
menu. Neither half can do the other's job.

## Install

**1. The app** — run the installer:

```
Runway-1.0.0.msi
```

Installs to `C:\Program Files\Runway`, adds a Start-menu entry, and appears in
**Apps & Features** for a clean uninstall. The fixed path is deliberate: the
installer records it in `HKLM\SOFTWARE\Runway`, which is how the extension finds
the app.

**2. The extension** (optional):

```
code --install-extension "dotnet-runway-3.1.0.vsix"
```

Or in VS Code: Extensions → `...` → **Install from VSIX**.

If you run a project before installing the app, the extension offers to launch
the installer for you.

### Uninstall

Settings → Apps → **Runway** → Uninstall. Per-user state in `%APPDATA%\Runway\`
is left behind deliberately (your project list and window position); delete that
folder to remove every trace.

### Requirements

Both usually already present on a Windows 11 dev machine:

- .NET 9 Desktop Runtime — the app prompts with a download link if it is missing
- WebView2 Runtime — ships with Windows 11 and with Edge

## Use

Right-click a project or folder in VS Code → **Run** → *Run with https* /
*Run with http*. The extension runs:

```
Runway.exe --run <path-to.csproj> --profile https
```

The app is single-instance: a second launch forwards its arguments to the open
window over a named pipe and exits.

Projects stay in the list once added, running or not. Drag the grip on the left
of a card to reorder; the order is saved.

| Control | Does |
| --- | --- |
| ▶ / ■ | Start / stop — stop kills the whole tree: watch, `dotnet run`, and the app |
| ↻ | Restart |
| ⚡ | Hard restart: stop, full `dotnet build`, start |
| ↗ | Open the listening URL in your default browser |
| ▤ | Live output |
| 🗑 | Remove from the list |

Closing the window stops every running project first, with a progress
indicator — nothing is left orphaned holding a port.

## Stale-code protection

`dotnet watch` compiles once, then runs with `--no-build` and pushes later edits
in via Hot Reload. When Hot Reload cannot apply a change — a *rude edit* — the
running app keeps serving the **old** code. This is the classic "I changed the
file and nothing happened".

Three guards, all in the tooling, none needing a line of change in your own
projects:

1. `--non-interactive` is always passed, so watch cannot stop and wait for a
   keypress that a background process will never send.
2. Runway watches for the rude-edit message and restarts the project itself,
   after a short grace period in case watch recovers on its own.
3. Hard restart forces a real compile when you want certainty.

> A common suggestion for Razor views is to add `AddRazorRuntimeCompilation()`
> to `Program.cs`. Runway deliberately does not require that — it would mean
> every project editing its own startup code, and it only ever helps `.cshtml`.
> Detecting the failure in the tooling covers `.cs` rude edits too.

## Theming

The extension resolves your active VS Code theme — including
`workbench.colorCustomizations` — and writes it to
`%APPDATA%\Runway\theme.json`. The app watches that file, so switching theme in
VS Code repaints the window live.

Only a dozen real colours cross over; surface shades, muted text and status
tints are derived from them, so any theme works. Background brightness is
measured, so light themes get dark overlays rather than washed-out light ones.

Without the extension the app keeps its own dark palette.

## Configuration

| Setting | Purpose |
| --- | --- |
| `dotnetRunway.appPath` | Full path to `Runway.exe`. Leave empty to resolve it automatically |

The extension looks for the app in this order: the setting above, the registry
key the installer writes (`HKLM\SOFTWARE\Runway\ExePath`), `C:\Program
Files\Runway`, then a local build output for development.

App state lives in `%APPDATA%\Runway\`: `state.json` (projects, order, window
geometry), `theme.json`, and `error.log` if anything ever crashes.

## Building

Everything at once:

```powershell
.\build.ps1           # patch bump on the extension
.\build.ps1 minor     # minor bump
```

That publishes the app, builds the MSI, and packages the extension, leaving
`Runway-<version>.msi` and `dotnet-runway-<version>.vsix` in this folder.

Individually:

```bash
cd Runway.App       && dotnet publish -c Release -o dist
cd Runway.Installer && wix build Runway.wxs -o ../Runway-1.0.0.msi
cd dotnet-runway    && npm install && npm run package
```

The installer needs the WiX tool once:

```bash
dotnet tool install --global wix
```

The app's version lives in `Runway.Installer/Runway.wxs`; bump it there.

## Layout

```
VS Code Extensions/
├── Runway.App/            the standalone window
│   ├── Program.cs           entry, single instance, taskbar identity, pipe server
│   ├── MainForm.cs          frameless window, WebView2 host, message bridge
│   ├── ProjectRunner.cs     process management and output parsing
│   ├── AppState.cs          project list, ordering, window geometry
│   ├── LaunchProfiles.cs    reads launchSettings.json
│   ├── wwwroot/             the UI
│   └── dist/                build output (git-ignored; the MSI ships instead)
├── Runway.Installer/      WiX installer definition
│   └── Runway.wxs           fixed install path, registry key, Start-menu entry
├── dotnet-runway/         the VS Code extension
│   ├── extension.js         right-click menu, launches the app, exports the theme
│   └── src/
│       ├── projects.js      project discovery and launch profiles
│       └── theme.js         resolves the VS Code theme to a palette
├── build.ps1              builds app + installer + extension
├── Runway-1.0.0.msi       ← install this
└── dotnet-runway-3.1.0.vsix
```
