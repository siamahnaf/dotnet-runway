const vscode = require('vscode');
const path = require('path');

// Directories that never hold a project we want to launch.
const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.vscode', 'Properties']);

/**
 * Collect .csproj files under `dir`. Shallowest wins: if the folder itself holds
 * projects we stop there rather than dragging in every project of a subtree.
 * Used by the Explorer right-click, where the user has pointed at one place.
 */
async function findProjects(dir, depth) {
  let entries;
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch (e) {
    return [];
  }

  const found = [];
  const subdirs = [];
  for (const [name, type] of entries) {
    if (type === vscode.FileType.File && name.toLowerCase().endsWith('.csproj')) {
      found.push(vscode.Uri.joinPath(dir, name));
    } else if (type === vscode.FileType.Directory && !SKIP.has(name)) {
      subdirs.push(name);
    }
  }
  if (found.length > 0 || depth === 0) return found;

  for (const name of subdirs) {
    const deeper = await findProjects(vscode.Uri.joinPath(dir, name), depth - 1);
    found.push(...deeper);
  }
  return found;
}

/**
 * Every runnable project in the workspace — the panel lists these regardless of
 * what is running, so a project can be started from the UI alone.
 */
async function discoverWorkspaceProjects() {
  const uris = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**');
  return uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/**
 * Launch profiles declared in Properties/launchSettings.json.
 *
 * Only commandName === 'Project' profiles are returned: IIS Express and friends
 * are not things `dotnet run --launch-profile` can drive. Returns [] when the
 * file is missing or unreadable — the caller falls back to http/https.
 */
async function readProfiles(csprojUri) {
  const settings = vscode.Uri.joinPath(csprojUri, '..', 'Properties', 'launchSettings.json');
  try {
    const bytes = await vscode.workspace.fs.readFile(settings);
    const json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!json.profiles) return [];
    return Object.entries(json.profiles)
      .filter(([, p]) => !p.commandName || p.commandName === 'Project')
      .map(([name, p]) => ({
        name,
        applicationUrl: p.applicationUrl || null,
      }));
  } catch (e) {
    return [];
  }
}

async function hasProfile(csprojUri, profile) {
  const profiles = await readProfiles(csprojUri);
  if (profiles.length === 0) return null; // unreadable — cannot tell
  return profiles.some((p) => p.name === profile);
}

/**
 * Project name as shown to the user. Every project here tends to be prefixed
 * with the product name, which is pure noise in a narrow list, so it is trimmed.
 */
function displayName(csprojUri) {
  const base = path.basename(csprojUri.fsPath, '.csproj');
  const prefix = vscode.workspace.getConfiguration('dotswitch').get('stripPrefix', '');
  if (prefix && base.startsWith(prefix) && base.length > prefix.length) {
    return base.slice(prefix.length);
  }
  return base;
}

function relativeLabel(uri) {
  return vscode.workspace.asRelativePath(uri, false) || path.basename(uri.fsPath);
}

module.exports = {
  findProjects,
  discoverWorkspaceProjects,
  readProfiles,
  hasProfile,
  displayName,
  relativeLabel,
};
