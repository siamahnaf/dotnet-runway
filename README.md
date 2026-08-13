# Dotswitch

Run and manage .NET projects with `dotnet watch` from a small always-available
window, instead of a pile of terminal tabs.

Two pieces, and they do very different amounts of work:

| | What it is | What it does |
| --- | --- | --- |
| **Dotswitch.App** | A standalone Windows app | Everything — the window, the processes, the list, the logs |
| **dotswitch** | A VS Code extension | Navigation only: adds *right-click → Run* and keeps the app matched to your VS Code theme |

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
Dotswitch-1.1.0.msi
```

Installs to `C:\Program Files\Dotswitch`, adds a Start-menu entry, and appears in
**Apps & Features** for a clean uninstall. The fixed path is deliberate: the
installer records it in `HKLM\SOFTWARE\Dotswitch`, which is how the extension finds
the app.

> **Upgrading from Runway?** Nothing to uninstall first. This MSI carries
> Runway's upgrade code, so it removes the old install, its Start-menu entry and
> `C:\Program Files\Runway` on its way in, and the app copies your project list
> and window position from `%APPDATA%\Runway\` the first time it starts. The old
> extension is a separate marketplace entry and does have to go by hand.

**2. The extension** (optional):

```
code --install-extension "dotswitch-3.2.6.vsix"
```

Or in VS Code: Extensions → `...` → **Install from VSIX**. Uninstall the old
**Dotnet Runway** extension if you have it, or both right-click entries appear.

If you run a project before installing the app, the extension tells you Dotswitch
is not installed.

### Uninstall

Settings → Apps → **Dotswitch** → Uninstall. Per-user state in `%APPDATA%\Dotswitch\`
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
Dotswitch.exe --run <path-to.csproj> --profile https
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
2. Dotswitch watches for the rude-edit message and restarts the project itself,
   after a short grace period in case watch recovers on its own.
3. Hard restart forces a real compile when you want certainty.

> A common suggestion for Razor views is to add `AddRazorRuntimeCompilation()`
> to `Program.cs`. Dotswitch deliberately does not require that — it would mean
> every project editing its own startup code, and it only ever helps `.cshtml`.
> Detecting the failure in the tooling covers `.cs` rude edits too.

## Theming

The window is Dotswitch's own: two brand colours, `#FF405C` and `#E82968`, and
their shades, on either a white or a black ground.

Which ground follows **Windows** by default. The theme button in the title bar
cycles *follow Windows → light → dark* and the choice is remembered; while it is
following, changing the Windows setting repaints the window live rather than at
the next launch.

On dark, a faint brand glow sits over the black from the top-left corner and
falls away across the window; the cards are semi-transparent, so the rows nearest
the corner pick it up and the list gains depth. Light stays flat white — a wash
on a light ground reads as a stain rather than as light.

One colour is admitted from outside the brand: an emerald green, and only ever
to say *this project is up*. It appears in five places, all of them on a running
card — the row tint, the full-height rail down its left edge, the status dot, the
URL, and the dot in its profile pill. Not on the start button, not on the running
count; letting it leak into the controls would cost it the meaning it carries.
Failure keeps the deeper brand shade, and the dot changes shape as well as
colour — solid when running, a hollow ring when crashed — so the two are never
told apart by hue alone.

The extension still exports your VS Code theme to
`%APPDATA%\Dotswitch\theme.json`, and the app still watches that file, but only
the log drawer uses it now: output is coloured with your integrated terminal's
own ANSI palette. The rest of the window deliberately does not follow the
editor.

## Configuration

| Setting | Purpose |
| --- | --- |
| `dotswitch.appPath` | Full path to `Dotswitch.exe`. Leave empty to resolve it automatically |

The extension looks for the app in this order: the setting above, the registry
key the installer writes (`HKLM\SOFTWARE\Dotswitch\ExePath`), then
`C:\Program Files\Dotswitch`. If none match it prompts to install rather than
falling back to anything — a fallback would hide the fact that the app was
never installed.

Working on the app itself? Point `dotswitch.appPath` at your
`Dotswitch.App\dist\Dotswitch.exe` and the extension uses that instead.

App state lives in `%APPDATA%\Dotswitch\`: `state.json` (projects, order, window
geometry), `theme.json`, and `error.log` if anything ever crashes.

## Building

Everything at once:

```powershell
.\build.ps1           # patch bump on the extension
.\build.ps1 minor     # minor bump
```

That publishes the app, builds the MSI, and packages the extension, leaving
`Dotswitch-<version>.msi` and `dotswitch-<version>.vsix` in this folder.

Individually:

```bash
cd Dotswitch.App       && dotnet publish -c Release -o dist
cd Dotswitch.Installer && wix build Dotswitch.wxs -arch x64 -o ../Dotswitch-1.1.0.msi
cd dotswitch    && npm install && npm run package
```

The installer needs the WiX tool once:

```bash
dotnet tool install --global wix
```

The app's version lives in `Dotswitch.Installer/Dotswitch.wxs`; bump it there.

## Layout

```
VS Code Extensions/
├── Dotswitch.App/           the standalone window
│   ├── Program.cs           entry, single instance, taskbar identity, pipe server
│   ├── MainForm.cs          frameless window, WebView2 host, light/dark, bridge
│   ├── ProjectRunner.cs     process management and output parsing
│   ├── AppState.cs          project list, ordering, window geometry, theme
│   ├── LaunchProfiles.cs    reads launchSettings.json
│   ├── dotswitch.ico        every size the shell asks for, built from the logo
│   ├── wwwroot/             the UI
│   └── dist/                build output (git-ignored; the MSI ships instead)
├── Dotswitch.Installer/     WiX installer definition
│   └── Dotswitch.wxs        fixed install path, registry key, Start-menu entry
├── dotswitch/               the VS Code extension
│   ├── extension.js         right-click menu, launches the app, exports the theme
│   └── src/
│       ├── projects.js      project discovery and launch profiles
│       └── theme.js         resolves the VS Code theme to a palette
├── dotswitch.png            the logo, source for both icons
├── build.ps1                builds app + installer + extension
├── Dotswitch-1.1.0.msi      ← install this
└── dotswitch-3.2.6.vsix
```
