#!/usr/bin/env node
//
// Bump the version and package a .vsix into the parent "VS Code Extensions"
// folder, so every revision leaves a numbered artifact next to its source.
//
//   node build.js            -> patch bump (1.1.0 -> 1.1.1)
//   node build.js minor      -> 1.1.0 -> 1.2.0
//   node build.js major      -> 1.1.0 -> 2.0.0
//   node build.js 2.4.1      -> exactly that
//   node build.js --no-bump  -> package the current version as-is

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = __dirname;
const pkgPath = path.join(root, 'package.json');
const outDir = path.resolve(root, '..');

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function bump(current, mode) {
  if (/^\d+\.\d+\.\d+$/.test(mode)) return mode;

  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Cannot parse current version "${current}"`);
  }
  let [major, minor, patch] = parts;

  if (mode === 'major') return `${major + 1}.0.0`;
  if (mode === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const arg = process.argv[2];
  const pkg = readPkg();

  if (arg !== '--no-bump') {
    const next = bump(pkg.version, arg || 'patch');
    pkg.version = next;
    // Two-space indent + trailing newline keeps the diff to the version line only.
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`version -> ${next}`);
  } else {
    console.log(`version stays ${pkg.version}`);
  }

  const fresh = readPkg();
  const out = path.join(outDir, `${fresh.name}-${fresh.version}.vsix`);

  console.log(`packaging -> ${out}`);

  // Run vsce's entry script with the current node binary rather than going
  // through npx. Node 18.20+ refuses to spawn a .cmd shim without `shell: true`
  // (EINVAL), and enabling a shell would mean quoting a path that contains a
  // space — "VS Code Extensions" does.
  let vsceEntry;
  try {
    vsceEntry = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  } catch (e) {
    console.error('@vscode/vsce is not installed. Run: npm install');
    process.exit(1);
  }

  const result = cp.spawnSync(
    process.execPath,
    [vsceEntry, 'package', '--no-dependencies', '--out', out],
    { cwd: root, stdio: 'inherit' }
  );

  if (result.error) {
    console.error(`Failed to run vsce: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

main();
