const fs = require('fs');
const path = require('path');

/**
 * Strip comments and trailing commas from JSONC.
 *
 * Theme files are JSONC, and a naive /\/\/.*$/ regex also destroys the "//" in
 * every URL inside them — so this walks the text and skips comments only when
 * genuinely outside a string.
 */
function stripJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (lineComment) {
      if (c === '\n') { lineComment = false; out += c; }
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    out += c;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJsonc(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(stripJsonc(raw));
}

/**
 * Load a theme's colour map, following any `include` chain (themes commonly
 * layer a variant on top of a base file).
 */
function loadThemeColors(themeFile, depth = 0) {
  if (depth > 8) return {};
  let json;
  try {
    json = readJsonc(themeFile);
  } catch (e) {
    return {};
  }

  let colors = {};
  if (json.include) {
    colors = loadThemeColors(path.resolve(path.dirname(themeFile), json.include), depth + 1);
  }
  return Object.assign(colors, json.colors || {});
}

/**
 * Find the theme file whose contributed label matches `label`.
 * `extensionDirs` are folders each containing a package.json.
 */
function findThemeFile(label, extensionDirs) {
  for (const dir of extensionDirs) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;

    let pkg;
    try { pkg = readJsonc(manifest); } catch (e) { continue; }

    const themes = (pkg.contributes && pkg.contributes.themes) || [];
    for (const theme of themes) {
      const name = theme.label || theme.id;
      if (name === label && theme.path) {
        return path.resolve(dir, theme.path);
      }
    }
  }
  return null;
}

/**
 * Blend a #rrggbbaa colour onto an opaque background, since the app's palette
 * has no compositing context to resolve alpha against.
 */
function flatten(hex, backdrop) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return hex;
  if (hex.length !== 9) return hex;

  const a = parseInt(hex.slice(7, 9), 16) / 255;
  const fg = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const bgHex = (backdrop || '#1e1e1e').slice(1, 7);
  const bg = [0, 2, 4].map((i) => parseInt(bgHex.slice(i, i + 2), 16));

  const mix = fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the palette the standalone window needs.
 *
 * Themes only define the keys they care about, so anything missing falls back
 * to a value derived from the ones that are present rather than to a hardcoded
 * colour that might clash.
 */
function buildPalette({ label, extensionDirs, customizations }) {
  const themeFile = findThemeFile(label, extensionDirs);
  const colors = Object.assign(
    themeFile ? loadThemeColors(themeFile) : {},
    customizations || {}
  );

  const bg = colors['editor.background'] || '#1e1e1e';
  const pick = (...keys) => {
    for (const k of keys) {
      if (colors[k]) return flatten(colors[k], bg);
    }
    return null;
  };

  return {
    themeLabel: label,
    resolved: !!themeFile,
    bg: flatten(bg, '#1e1e1e'),
    bgBar: pick('titleBar.activeBackground', 'sideBar.background', 'editor.background') || bg,
    panel: pick('editorWidget.background', 'sideBar.background') || bg,
    ink: pick('editor.foreground', 'foreground') || '#e6e8ec',
    accent: pick('textLink.foreground', 'button.background', 'focusBorder') || '#58a6ff',
    badgeBg: pick('badge.background', 'button.background') || null,
    badgeInk: pick('badge.foreground', 'button.foreground') || null,
    inputBg: pick('input.background', 'dropdown.background') || null,
    dropdownBg: pick('dropdown.background', 'editorWidget.background') || null,
    termBg: pick('terminal.background', 'editor.background') || bg,
    green: pick('charts.green', 'terminal.ansiGreen', 'gitDecoration.addedResourceForeground') || '#3fb950',
    red: pick('charts.red', 'errorForeground', 'terminal.ansiRed') || '#f85149',
    yellow: pick('charts.yellow', 'terminal.ansiYellow', 'editorWarning.foreground') || '#d29922',

    // The 16 ANSI colours, so log output is coloured the same way this theme's
    // integrated terminal would colour it.
    ansi: [
      pick('terminal.ansiBlack') || '#3b4048',
      pick('terminal.ansiRed') || '#e06c75',
      pick('terminal.ansiGreen') || '#98c379',
      pick('terminal.ansiYellow') || '#d19a66',
      pick('terminal.ansiBlue') || '#61afef',
      pick('terminal.ansiMagenta') || '#c678dd',
      pick('terminal.ansiCyan') || '#56b6c2',
      pick('terminal.ansiWhite') || '#abb2bf',
      pick('terminal.ansiBrightBlack') || '#5c6370',
      pick('terminal.ansiBrightRed') || '#ff7b86',
      pick('terminal.ansiBrightGreen') || '#b5e890',
      pick('terminal.ansiBrightYellow') || '#ffd479',
      pick('terminal.ansiBrightBlue') || '#7cc7ff',
      pick('terminal.ansiBrightMagenta') || '#e39ef7',
      pick('terminal.ansiBrightCyan') || '#7fdbe8',
      pick('terminal.ansiBrightWhite') || '#ffffff',
    ],
  };
}

module.exports = { stripJsonc, readJsonc, loadThemeColors, findThemeFile, buildPalette, flatten };
