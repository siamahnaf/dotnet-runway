// Runway — window UI.
//
// Rendering only. Every action posts a message to the host (the WinForms
// shell), which does the work and pushes fresh state back, so the UI never
// holds an opinion about process state the host has not confirmed.

(function () {
  'use strict';

  const host = window.chrome && window.chrome.webview;

  /** @type {Array<any>} */
  let projects = [];
  const expanded = new Set();
  const stuckToBottom = new Map();
  let filterText = '';
  let openDd = null;
  let pinned = false;

  const scrollEl = document.getElementById('scroll');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const filterEl = document.getElementById('filter');

  // ── Icons ───────────────────────────────────────────────

  const S = (body) =>
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';

  const ICON = {
    play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.8 3.2 12.4 8l-7.6 4.8z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>',
    restart: S('<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9"/><path d="M13.6 1.9v3.4h-3.4"/>'),
    bolt: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.1 1 3.8 9h3.4l-.5 6 5.4-8.3H8.6z"/></svg>',
    logs: S('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="M4.6 6.4 6.6 8l-2 1.6M8.4 10h3"/>'),
    open: S('<path d="M9.4 2.4h4.2v4.2"/><path d="M13.6 2.4 7.8 8.2"/><path d="M12.2 9.6v3.2a.9.9 0 0 1-.9.9H3.5a.9.9 0 0 1-.9-.9V5a.9.9 0 0 1 .9-.9h3.2"/>'),
    stopAll: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/><rect x="6.5" y="6.5" width="7" height="7" rx="1"/></svg>',
    spinner: S('<path d="M8 1.9a6.1 6.1 0 1 1-4.3 1.8" opacity="0.9"/>'),
    trash: S('<path d="M2.8 4.4h10.4"/><path d="M6.3 4.4V3.1a.9.9 0 0 1 .9-.9h1.6a.9.9 0 0 1 .9.9v1.3"/><path d="M4.3 4.4l.6 8.1a.9.9 0 0 0 .9.8h4.4a.9.9 0 0 0 .9-.8l.6-8.1"/>'),
    chevron: S('<path d="M4 6.2 8 10l4-3.8"/>'),
    check: S('<path d="M3.2 8.4l3.1 3.1 6.5-6.9"/>'),
    grip: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.15"/><circle cx="10" cy="4" r="1.15"/><circle cx="6" cy="8" r="1.15"/><circle cx="10" cy="8" r="1.15"/><circle cx="6" cy="12" r="1.15"/><circle cx="10" cy="12" r="1.15"/></svg>',
    pin: S('<path d="M9.6 1.8 14.2 6.4l-2 .5-3 3-.4 3.2-4.9-4.9 3.2-.4 3-3z"/><path d="M4.9 11.1 1.8 14.2"/>'),
    min: S('<path d="M3 8h10"/>'),
    close: S('<path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>'),
    plus: S('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
    copy: S('<rect x="5.6" y="5.6" width="8.2" height="8.2" rx="1.3"/><path d="M10.9 5.6V3.5a1.3 1.3 0 0 0-1.3-1.3H3.5a1.3 1.3 0 0 0-1.3 1.3v6.1a1.3 1.3 0 0 0 1.3 1.3h2.1"/>'),
  };

  /** Briefly swap a button's icon to confirm the action landed. */
  function flash(button, icon) {
    if (!button) return;
    const original = button.innerHTML;
    button.innerHTML = ICON[icon];
    button.classList.add('ok');
    setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('ok');
    }, 1100);
  }

  // ── Theme ───────────────────────────────────────────────

  /** '#abc' / '#aabbcc' / '#aabbccdd' -> [r,g,b], or null. */
  function toRgb(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  const rgba = (rgb, a) => 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';

  /** Perceived brightness, 0..255 — decides whether overlays go light or dark. */
  const luma = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];

  /**
   * Paint the window in the VS Code theme the extension exported.
   *
   * Only a handful of real colours arrive; the surface shades and muted text
   * are derived here, so the design keeps its depth on any theme instead of
   * needing a hand-built palette per theme.
   */
  function applyTheme(t) {
    if (!t) return;
    const root = document.documentElement.style;
    const set = (name, value) => { if (value) root.setProperty(name, value); };

    const bg = toRgb(t.bg);
    const ink = toRgb(t.ink);

    set('--bg', t.bg);
    set('--bg-bar', t.bgBar || t.bg);
    set('--ink', t.ink);
    set('--live', t.accent);
    set('--go', t.green);
    set('--stop', t.red);
    set('--warn', t.yellow);

    if (ink) {
      set('--ink-dim', rgba(ink, 0.62));
      set('--ink-faint', rgba(ink, 0.38));
    }

    // Overlays must contrast with the background, not with a fixed assumption:
    // a light theme needs black veils where a dark one needs white.
    if (bg) {
      const light = luma(bg) > 140;
      const tint = light ? [0, 0, 0] : [255, 255, 255];
      set('--surface-1', rgba(tint, light ? 0.05 : 0.05));
      set('--surface-2', rgba(tint, light ? 0.09 : 0.09));
      set('--surface-3', rgba(tint, light ? 0.14 : 0.14));
      // The veil sits over the whole window, so it has to be the real colour.
      set('--veil', rgba(bg, 0.92));
    }

    if (t.dropdownBg) set('--menu-bg', t.dropdownBg);
    if (t.termBg) set('--log-bg', t.termBg);

    // ANSI palette, so log colour matches this theme's integrated terminal.
    if (Array.isArray(t.ansi)) {
      t.ansi.forEach((c, i) => set('--a' + i, c));
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  function post(type, payload) {
    if (!host) return;
    host.postMessage(JSON.stringify(Object.assign({ type: type }, payload || {})));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function iconButton(icon, title, extraClass, disabled, onClick) {
    const b = el('button', 'ib' + (extraClass ? ' ' + extraClass : ''));
    b.innerHTML = ICON[icon];
    b.title = title;
    b.setAttribute('aria-label', title);
    b.disabled = !!disabled;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function uptime(startedAt) {
    if (!startedAt) return '';
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs < 60) return secs + 's';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm';
    return Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
  }

  const isBusy = (s) => s === 'starting' || s === 'building' || s === 'stopping';
  const isLive = (p) => !!p.pid;

  /** Ids commanded but not yet confirmed, so a click feels instant. */
  const pending = new Set();
  const isWorking = (p) => isBusy(p.status) || pending.has(p.id);

  function act(type, id) {
    pending.add(id);
    post(type, { id: id });
    render();
  }

  // ── Rendering ───────────────────────────────────────────

  function render() {
    const term = filterText.trim().toLowerCase();
    let pool = projects;
    if (term) {
      pool = pool.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.relPath || '').toLowerCase().includes(term)
      );
    }

    const live = pool.filter(isLive);
    const idle = pool.filter((p) => !isLive(p));

    const runningTotal = projects.filter(isLive).length;
    countEl.textContent = runningTotal ? runningTotal + ' running' : 'idle';
    countEl.classList.toggle('on', runningTotal > 0);

    const shuttingDown = projects.some((p) => p.status === 'stopping');
    const stopAllBtn = document.getElementById('btnStopAll');
    stopAllBtn.innerHTML = shuttingDown ? ICON.spinner : ICON.stopAll;
    stopAllBtn.classList.toggle('spinning', shuttingDown);
    stopAllBtn.classList.toggle('halt', !shuttingDown);
    stopAllBtn.disabled = shuttingDown;

    emptyEl.hidden = pool.length > 0;

    const scrollMemory = new Map();
    for (const id of expanded) {
      const body = document.querySelector('[data-log="' + CSS.escape(id) + '"]');
      if (body) scrollMemory.set(id, body.scrollTop);
    }
    const outerScroll = scrollEl.scrollTop;

    scrollEl.textContent = '';
    if (live.length) {
      scrollEl.appendChild(el('div', 'section-head', 'Running · ' + live.length));
      for (const p of live) scrollEl.appendChild(card(p));
    }
    if (idle.length) {
      scrollEl.appendChild(el('div', 'section-head', 'Stopped · ' + idle.length));
      for (const p of idle) scrollEl.appendChild(card(p));
    }

    scrollEl.scrollTop = outerScroll;
    for (const [id, top] of scrollMemory) {
      const body = document.querySelector('[data-log="' + CSS.escape(id) + '"]');
      if (!body) continue;
      body.scrollTop = stuckToBottom.get(id) === false ? top : body.scrollHeight;
    }
  }

  function profileDropdown(p, disabled) {
    const names = p.profiles && p.profiles.length ? p.profiles : ['http', 'https'];
    const wrap = el('div', 'dd');

    const btn = el('button', 'dd-btn');
    btn.disabled = disabled;
    btn.title = 'Launch profile';
    btn.appendChild(el('span', 'dd-val', p.profile || names[0]));
    const chev = el('span', 'dd-chev');
    chev.innerHTML = ICON.chevron;
    btn.appendChild(chev);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDd = openDd === p.id ? null : p.id;
      render();
    });
    wrap.appendChild(btn);

    if (openDd === p.id && !disabled) {
      wrap.classList.add('open');
      const menu = el('div', 'dd-menu');
      menu.addEventListener('click', (e) => e.stopPropagation());
      for (const name of names) {
        const item = el('button', 'dd-item' + (name === p.profile ? ' sel' : ''));
        item.appendChild(el('span', null, name));
        if (name === p.profile) {
          const tick = el('span', 'dd-tick');
          tick.innerHTML = ICON.check;
          item.appendChild(tick);
        }
        item.addEventListener('click', () => {
          openDd = null;
          if (name !== p.profile) post('setProfile', { id: p.id, profile: name });
          else render();
        });
        menu.appendChild(item);
      }
      wrap.appendChild(menu);
    }
    return wrap;
  }

  function card(p) {
    const frag = document.createDocumentFragment();
    const busy = isWorking(p);

    const c = el('div', 'card');
    c.dataset.id = p.id;
    if (p.status === 'running') c.classList.add('running');
    if (p.status === 'crashed') c.classList.add('crashed');
    if (busy) c.classList.add('busy');

    // Drag handle. Only the grip starts a drag, so pressing anywhere else on
    // the card still behaves like a normal click target.
    const grip = el('div', 'grip');
    grip.innerHTML = ICON.grip;
    grip.title = 'Drag to reorder';
    grip.addEventListener('mousedown', () => { c.draggable = true; });
    grip.addEventListener('mouseup', () => { c.draggable = false; });
    c.appendChild(grip);

    c.addEventListener('dragstart', (e) => {
      dragId = p.id;
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox-style requirement; harmless in Chromium and keeps the drag alive.
      try { e.dataTransfer.setData('text/plain', p.id); } catch (err) {}
    });
    c.addEventListener('dragend', () => {
      c.draggable = false;
      c.classList.remove('dragging');
      clearDropMarks();
      commitOrder();
    });

    c.appendChild(el('span', 'dot ' + p.status));

    const info = el('div', 'info');
    const nm = el('div', 'name', p.name);
    nm.title = p.relPath || p.name;
    info.appendChild(nm);

    const meta = el('div', 'meta');
    if (p.url) {
      const a = el('a', null, p.url.replace(/^https?:\/\//, ''));
      a.href = '#';
      a.title = 'Open ' + p.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        post('openUrl', { id: p.id });
      });
      meta.appendChild(a);
      if (p.startedAt) {
        meta.appendChild(el('span', 'sep', '·'));
        meta.appendChild(document.createTextNode('up ' + uptime(p.startedAt)));
      }
    } else if (busy) {
      meta.textContent = p.lastEvent || 'Working...';
    } else if (p.status === 'crashed') {
      meta.textContent = p.lastEvent || 'Crashed';
    } else {
      meta.textContent = 'Stopped';
    }

    if (p.autoRestarts > 0) {
      const t = el('span', 'tag', '↻ ' + p.autoRestarts);
      t.title = p.autoRestarts + ' automatic restart(s) after a change hot reload could not apply';
      meta.appendChild(t);
    }

    info.appendChild(meta);
    c.appendChild(info);

    const ctrls = el('div', 'ctrls');
    ctrls.appendChild(profileDropdown(p, busy));

    const openBtn = () =>
      iconButton(
        'open',
        p.url ? 'Open ' + p.url + ' in your browser' : 'No URL yet — start the project first',
        null,
        !p.url,
        p.url ? () => post('openUrl', { id: p.id }) : null
      );

    if (busy) {
      // The spinner reports what is happening, but Stop stays live beside it:
      // a start that hangs on a restore or a slow build must be cancellable.
      ctrls.appendChild(iconButton('spinner', p.lastEvent || 'Working...', 'spinning', true, null));
      if (p.status !== 'stopping') {
        ctrls.appendChild(iconButton('stop', 'Cancel', 'halt', false, () => act('stop', p.id)));
      }
      ctrls.appendChild(openBtn());
      ctrls.appendChild(iconButton('bolt', 'Hard restart', 'bolt', true, null));
    } else if (isLive(p)) {
      ctrls.appendChild(iconButton('stop', 'Stop', 'halt', false, () => act('stop', p.id)));
      ctrls.appendChild(iconButton('restart', 'Restart', null, false, () => act('restart', p.id)));
      ctrls.appendChild(openBtn());
      ctrls.appendChild(
        iconButton('bolt', 'Hard restart — stop, full rebuild, start', 'bolt', false, () =>
          act('hardRestart', p.id))
      );
    } else {
      ctrls.appendChild(iconButton('play', 'Start', 'go', false, () => act('start', p.id)));
      ctrls.appendChild(openBtn());
      ctrls.appendChild(
        iconButton('bolt', 'Hard restart — stop, full rebuild, start', 'bolt', false, () =>
          act('hardRestart', p.id))
      );
      ctrls.appendChild(
        iconButton('trash', 'Remove from list', null, false, () => post('forget', { id: p.id }))
      );
    }

    const open = expanded.has(p.id);
    ctrls.appendChild(
      iconButton('logs', open ? 'Hide output' : 'Show output', open ? 'on' : null, false, () => {
        if (open) {
          expanded.delete(p.id);
        } else {
          expanded.add(p.id);
          stuckToBottom.set(p.id, true);
          post('requestLogs', { id: p.id });
        }
        render();
      })
    );

    c.appendChild(ctrls);
    frag.appendChild(c);

    if (open) {
      const logs = el('div', 'logs');

      const bar = el('div', 'log-bar');
      bar.appendChild(el('span', 'log-title', 'Output'));
      bar.appendChild(el('span', 'grow'));
      bar.appendChild(
        iconButton('copy', 'Copy all output', 'sm', false, (e) => {
          e.stopPropagation();
          post('copyLogs', { id: p.id });
          flash(e.currentTarget, 'check');
        })
      );
      bar.appendChild(
        iconButton('trash', 'Clear output', 'sm', false, (e) => {
          e.stopPropagation();
          post('clearLogs', { id: p.id });
        })
      );
      logs.appendChild(bar);

      const body = el('pre', 'log-body');
      body.setAttribute('data-log', p.id);
      body.addEventListener('scroll', () => {
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        stuckToBottom.set(p.id, atBottom);
      });
      logs.appendChild(body);
      frag.appendChild(logs);

      // Repaint from the buffer on the next tick, once this fragment is in the
      // document — otherwise the drawer would be blank until more output lands.
      queueMicrotask(() => paintLog(p.id));
    }

    return frag;
  }

  // ── Drag to reorder ─────────────────────────────────────

  let dragId = null;

  function clearDropMarks() {
    for (const c of scrollEl.querySelectorAll('.card')) {
      c.classList.remove('drop-before', 'drop-after');
    }
  }

  scrollEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const over = e.target.closest ? e.target.closest('.card') : null;
    clearDropMarks();
    if (!over || over.dataset.id === dragId) return;

    // Above the midpoint drops before, below drops after.
    const box = over.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;
    over.classList.add(before ? 'drop-before' : 'drop-after');
  });

  scrollEl.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();

    const over = e.target.closest ? e.target.closest('.card') : null;
    if (over && over.dataset.id !== dragId) {
      const box = over.getBoundingClientRect();
      const before = e.clientY < box.top + box.height / 2;
      const moving = scrollEl.querySelector('.card[data-id="' + CSS.escape(dragId) + '"]');
      if (moving) {
        over.parentNode.insertBefore(moving, before ? over : over.nextSibling);
      }
    }
    clearDropMarks();
    commitOrder();
  });

  /**
   * Read the order straight off the DOM and hand it to the host.
   *
   * The list is grouped into Running and Stopped, so a card can only move
   * within its own group visually — but the saved order is one flat sequence,
   * which is what keeps positions stable when a project later starts or stops.
   */
  function commitOrder() {
    if (!dragId) return;
    dragId = null;
    const ids = [...scrollEl.querySelectorAll('.card[data-id]')].map((c) => c.dataset.id);
    if (ids.length) post('reorder', { ids: ids });
  }

  // ── Log streaming ───────────────────────────────────────

  /**
   * Output kept per project, ANSI codes and all.
   *
   * Held here rather than only in the DOM because every state push re-renders
   * the list — which used to leave the log drawer blank until the next line of
   * output arrived. The buffer is what makes the view survive a re-render.
   */
  const logBuf = new Map();
  const LOG_CAP = 200000;

  /** Trailing SGR state per project, so colour carries across chunks. */
  const ansiState = new Map();

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }

  /**
   * Turn SGR escape sequences into spans. Supports the 16 standard colours plus
   * bold, dim, italic and underline — which is everything the .NET toolchain
   * and ASP.NET's console logger actually emit. Extended 256/true-colour codes
   * are consumed rather than printed, so they never leak as literal text.
   */
  function applySgr(classes, params) {
    const codes = params.split(';').filter((s) => s !== '').map(Number);
    if (codes.length === 0) return [];

    let out = classes.slice();
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) out = [];
      else if (c === 1) out.push('a-b');
      else if (c === 2) out.push('a-dim');
      else if (c === 3) out.push('a-i');
      else if (c === 4) out.push('a-u');
      else if (c === 22) out = out.filter((x) => x !== 'a-b' && x !== 'a-dim');
      else if (c === 24) out = out.filter((x) => x !== 'a-u');
      else if (c === 39) out = out.filter((x) => !x.startsWith('a-f'));
      else if (c === 49) out = out.filter((x) => !x.startsWith('a-bg'));
      else if (c >= 30 && c <= 37) { out = out.filter((x) => !x.startsWith('a-f')); out.push('a-f' + (c - 30)); }
      else if (c >= 90 && c <= 97) { out = out.filter((x) => !x.startsWith('a-f')); out.push('a-f' + (c - 90 + 8)); }
      else if (c >= 40 && c <= 47) { out = out.filter((x) => !x.startsWith('a-bg')); out.push('a-bg' + (c - 40)); }
      else if (c >= 100 && c <= 107) { out = out.filter((x) => !x.startsWith('a-bg')); out.push('a-bg' + (c - 100 + 8)); }
      else if (c === 38 || c === 48) {
        // Extended colour: skip its parameters so they are not rendered.
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      }
    }
    // De-duplicate, keeping the last of each kind.
    return out.filter((v, i2) => out.indexOf(v) === i2);
  }

  function ansiToHtml(text, id) {
    let classes = ansiState.get(id) || [];
    let html = '';
    let last = 0;

    const emit = (chunk) => {
      if (!chunk) return;
      html += classes.length
        ? '<span class="' + classes.join(' ') + '">' + escapeHtml(chunk) + '</span>'
        : escapeHtml(chunk);
    };

    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      emit(text.slice(last, m.index));
      classes = applySgr(classes, m[1]);
      last = re.lastIndex;
    }
    emit(text.slice(last));

    ansiState.set(id, classes);
    return html;
  }

  function logBody(id) {
    return document.querySelector('[data-log="' + CSS.escape(id) + '"]');
  }

  function appendLog(id, text) {
    const next = (logBuf.get(id) || '') + text;
    logBuf.set(id, next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next);

    if (!expanded.has(id)) return;
    const body = logBody(id);
    if (!body) return;
    body.insertAdjacentHTML('beforeend', ansiToHtml(text, id));
    if (stuckToBottom.get(id) !== false) body.scrollTop = body.scrollHeight;
  }

  function replaceLog(id, text) {
    logBuf.set(id, text || '');
    paintLog(id);
  }

  /** Repaint a drawer from the buffer — used on open and after every render. */
  function paintLog(id) {
    const body = logBody(id);
    if (!body) return;
    ansiState.set(id, []);   // full repaint starts from a clean SGR state
    body.innerHTML = ansiToHtml(logBuf.get(id) || '', id);
    body.scrollTop = body.scrollHeight;
  }

  // ── Host messages ───────────────────────────────────────

  if (host) {
    host.addEventListener('message', (event) => {
      let msg = event.data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (e) { return; }
      }
      if (!msg) return;

      if (msg.type === 'state') {
        projects = msg.projects || [];
        pending.clear();
        render();
      } else if (msg.type === 'log') {
        appendLog(msg.id, msg.text);
      } else if (msg.type === 'logs') {
        replaceLog(msg.id, msg.text);
      } else if (msg.type === 'chrome') {
        pinned = !!msg.pinned;
        const pinBtn = document.getElementById('btnPin');
        pinBtn.classList.toggle('active', pinned);
        pinBtn.title = pinned ? 'Stop keeping on top' : 'Keep on top';
      } else if (msg.type === 'theme') {
        applyTheme(msg.palette);
      } else if (msg.type === 'closing') {
        const n = msg.count || 0;
        document.getElementById('veilText').textContent =
          'Stopping ' + n + ' running project' + (n === 1 ? '' : 's') + '…';
        document.getElementById('veil').hidden = false;
      }
    });
  }

  // ── Window chrome ───────────────────────────────────────

  const titlebar = document.getElementById('titlebar');
  titlebar.addEventListener('mousedown', (e) => {
    // Buttons in the bar must stay clickable rather than starting a drag.
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
    post('drag');
  });

  document.getElementById('btnPin').innerHTML = ICON.pin;
  document.getElementById('btnMin').innerHTML = ICON.min;
  document.getElementById('btnClose').innerHTML = ICON.close;

  document.getElementById('btnAdd').innerHTML = ICON.plus;

  document.getElementById('btnPin').addEventListener('click', () => post('pin'));
  document.getElementById('btnMin').addEventListener('click', () => post('minimise'));
  document.getElementById('btnClose').addEventListener('click', () => post('close'));
  document.getElementById('btnStopAll').addEventListener('click', () => post('stopAll'));
  document.getElementById('btnAdd').addEventListener('click', () => post('addProject'));

  // Edge strips hand the grabbed border back to Windows, which then runs the
  // resize itself — so snapping and the live outline behave normally.
  for (const grip of document.querySelectorAll('.rz')) {
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      post('resize', { edge: grip.dataset.edge });
    });
  }

  filterEl.addEventListener('input', () => {
    filterText = filterEl.value;
    render();
  });

  document.addEventListener('click', () => {
    if (openDd !== null) { openDd = null; render(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openDd !== null) { openDd = null; render(); }
  });

  setInterval(() => {
    if (projects.some((p) => p.status === 'running')) render();
  }, 10000);

  post('ready');
})();
