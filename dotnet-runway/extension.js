const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const { findProjects, hasProfile, displayName, relativeLabel } = require('./src/projects');
const { buildPalette } = require('./src/theme');

/**
 * Dotnet Runway — VS Code side.
 *
 * Navigation only. This extension does not run or manage anything: it adds the
 * Explorer right-click entry, hands the chosen project to the standalone Runway
 * window, and keeps that window's palette in step with the active VS Code
 * theme. All process management lives in the app.
 */

let context;

function cfg() {
  return vscode.workspace.getConfiguration('dotnetRunway');
}

// ── Theme export ──────────────────────────────────────────

/**
 * Resolve the active theme to a flat palette and write it where the app looks.
 *
 * Via a file rather than an argument so the window can repaint on a theme
 * change while it is already open.
 */
function exportTheme() {
  try {
    const wb = vscode.workspace.getConfiguration('workbench');
    const label = wb.get('colorTheme');
    if (!label) return;

    const palette = buildPalette({
      label,
      extensionDirs: vscode.extensions.all.map((e) => e.extensionPath),
      customizations: wb.get('colorCustomizations') || {},
    });

    const appData = process.env.APPDATA;
    if (!appData) return;

    const dir = path.join(appData, 'Runway');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(palette, null, 2));
  } catch (e) {
    // A theme we cannot parse just leaves the window on its built-in palette.
  }
}

// ── Launching the app ─────────────────────────────────────

/**
 * Where the installer records itself. Reading the registry rather than assuming
 * a path means a relocated or upgraded install is still found.
 */
function installedPathFromRegistry() {
  try {
    const out = cp.execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Runway', '/v', 'ExePath'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const match = out.match(/ExePath\s+REG_SZ\s+(.+)/i);
    if (match) {
      const exe = match[1].trim();
      if (fs.existsSync(exe)) return exe;
    }
  } catch (e) {
    // Key absent (not installed) or reg unavailable — fall through.
  }
  return null;
}

/**
 * Locate Runway.exe, most authoritative source first:
 * explicit setting, the installed copy, then a local build for development.
 */
function resolveAppPath() {
  const configured = cfg().get('appPath', '');
  if (configured && fs.existsSync(configured)) return configured;

  const installed = installedPathFromRegistry();
  if (installed) return installed;

  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Runway', 'Runway.exe'),
  ];
  // Development fallback: running straight from the build output.
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.join(
      folder.uri.fsPath, 'VS Code Extensions', 'Runway.App', 'dist', 'Runway.exe'));
    candidates.push(path.join(folder.uri.fsPath, 'Runway.App', 'dist', 'Runway.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (e) {
      // Unreadable path — keep looking.
    }
  }
  return null;
}

/** Find a bundled installer to offer, if one is sitting in the workspace. */
function findInstaller() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    for (const sub of ['VS Code Extensions', '.']) {
      try {
        const dir = path.join(folder.uri.fsPath, sub);
        const hit = fs.readdirSync(dir).find((f) => /^Runway-.*\.msi$/i.test(f));
        if (hit) return path.join(dir, hit);
      } catch (e) {
        // Directory missing — try the next.
      }
    }
  }
  return null;
}

/**
 * Runway is missing. Offer to install it or to point at an existing copy,
 * rather than failing with a path the user is expected to work out.
 */
async function promptToInstall() {
  const installer = findInstaller();
  const actions = installer ? ['Install Runway', 'Locate Runway.exe'] : ['Locate Runway.exe'];

  const pick = await vscode.window.showWarningMessage(
    'Runway is not installed. Install it to run projects from here.',
    ...actions
  );

  if (pick === 'Install Runway' && installer) {
    // Hand the .msi to the shell so Windows runs the normal install flow,
    // elevation prompt included.
    cp.spawn('cmd', ['/c', 'start', '', installer], { detached: true, stdio: 'ignore' }).unref();
    vscode.window.showInformationMessage(
      'Runway installer opened. Once it finishes, run your project again.'
    );
    return;
  }

  if (pick === 'Locate Runway.exe') {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select Runway.exe',
      canSelectMany: false,
      filters: { Executable: ['exe'] },
    });
    if (picked && picked[0]) {
      await cfg().update('appPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Runway location saved.');
    }
  }
}

/**
 * Hand a project to the app. It is single-instance, so this either starts the
 * window or forwards to the one already open.
 */
function launchInApp(csprojUri, profile) {
  const exe = resolveAppPath();
  if (!exe) {
    promptToInstall();
    return;
  }

  // Theme first, so a first launch paints correctly straight away.
  exportTheme();

  try {
    const child = cp.spawn(exe, ['--run', csprojUri.fsPath, '--profile', profile], {
      detached: true,
      stdio: 'ignore',
    });
    // Detached: the window must outlive this VS Code window.
    child.unref();
  } catch (e) {
    vscode.window.showErrorMessage(`Could not launch Runway: ${e.message}`);
  }
}

/** Open the app with no particular project. */
function openApp() {
  const exe = resolveAppPath();
  if (!exe) {
    promptToInstall();
    return;
  }
  exportTheme();
  try {
    const child = cp.spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    vscode.window.showErrorMessage(`Could not launch Runway: ${e.message}`);
  }
}

// ── Explorer right-click ──────────────────────────────────

async function run(uri, profile) {
  if (!uri || !uri.fsPath) {
    // Invoked from the palette rather than a right-click.
    openApp();
    return;
  }

  const isCsproj = uri.fsPath.toLowerCase().endsWith('.csproj');
  let projects = isCsproj ? [uri] : await findProjects(uri, 3);

  if (projects.length === 0) {
    vscode.window.showWarningMessage(`Runway: no .csproj found under ${relativeLabel(uri)}.`);
    return;
  }

  if (projects.length > 1) {
    // Prefer projects that actually declare the requested profile, but never
    // filter down to nothing.
    const checked = await Promise.all(projects.map((p) => hasProfile(p, profile)));
    const matching = projects.filter((p, i) => checked[i] !== false);
    if (matching.length > 0) projects = matching;
  }

  let project = projects[0];
  if (projects.length > 1) {
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({
        label: displayName(p),
        description: relativeLabel(p),
        uri: p,
      })),
      { title: `Run with ${profile} - which project?`, matchOnDescription: true }
    );
    if (!picked) return;
    project = picked.uri;
  } else if ((await hasProfile(project, profile)) === false) {
    const go = await vscode.window.showWarningMessage(
      `${displayName(project)} has no "${profile}" launch profile.`,
      'Run anyway'
    );
    if (go !== 'Run anyway') return;
  }

  launchInApp(project, profile);
}

/** Gate the right-click entry to workspaces that actually contain a project. */
async function refreshVisibility() {
  let active = false;
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const hits = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 1);
    active = hits.length > 0;
  }
  await vscode.commands.executeCommand('setContext', 'dotnetRunway.active', active);
}

function activate(ctx) {
  context = ctx;

  ctx.subscriptions.push(
    vscode.commands.registerCommand('dotnetRunway.https', (uri) => run(uri, 'https')),
    vscode.commands.registerCommand('dotnetRunway.http', (uri) => run(uri, 'http')),
    vscode.commands.registerCommand('dotnetRunway.openApp', openApp),
    vscode.window.onDidChangeActiveColorTheme(exportTheme),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.colorTheme') ||
          e.affectsConfiguration('workbench.colorCustomizations')) {
        exportTheme();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshVisibility)
  );

  exportTheme();
  refreshVisibility();
}

function deactivate() {
  // Nothing to clean up: the app owns every process and outlives this window.
}

module.exports = { activate, deactivate };
