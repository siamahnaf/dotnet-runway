// Dotswitch — window UI.
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

  // A 24-unit grid with round caps and joins throughout, so every glyph shares
  // the same weight and corner softness rather than each being drawn ad hoc.
  const S = (body) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';

  /** Solid glyphs still get rounded corners via stroke-linejoin on a filled path. */
  const F = (body) =>
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + body + '</svg>';

  const ICON = {
    // Rounded triangle and squircle — softer than the hard-edged originals.
    play: F('<path d="M9 6.4 17.2 12 9 17.6z"/>'),
    // Larger than a stroked glyph would be drawn: a solid shape reads smaller
    // than an outline of the same box, and this one sits in a row of outlines.
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3.6"/></svg>',
    restart: S('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20.4 3.4v4.4h-4.4"/>'),
    bolt: F('<path d="M13.3 2.6 6.2 13.1h4.6l-.7 8.3 7.4-11.1h-4.9z"/>'),
    logs: S('<rect x="2.8" y="4.4" width="18.4" height="15.2" rx="3.4"/><path d="M7 9.6 9.8 12 7 14.4M12.6 15h4.2"/>'),
    open: S('<path d="M14 3.6h6.4V10"/><path d="M20.4 3.6 11.8 12.2"/><path d="M18.6 14.4v4.8a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2V7.4a2 2 0 0 1 2-2h4.8"/>'),
    // Drawn as a full track plus a quarter arc, both explicitly centred on
    // (12,12). The previous single elliptical-arc command had two mathematically
    // valid centres for its endpoints and flags, and the one the renderer chose
    // was not the middle of the viewBox — so it wobbled instead of spinning.
    spinner:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="8.5" opacity="0.2"/>' +
      '<path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/></svg>',
    trash: S('<path d="M4 6.6h16"/><path d="M9.4 6.6V4.9a1.6 1.6 0 0 1 1.6-1.6h2a1.6 1.6 0 0 1 1.6 1.6v1.7"/><path d="M6.4 6.6 7.3 19a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.9-12.4"/>'),
    chevron: S('<path d="M6.5 9.5 12 15l5.5-5.5"/>'),
    check: S('<path d="M5 12.6 9.6 17 19 6.8"/>'),
    grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9.5" cy="6" r="1.6"/><circle cx="14.5" cy="6" r="1.6"/><circle cx="9.5" cy="12" r="1.6"/><circle cx="14.5" cy="12" r="1.6"/><circle cx="9.5" cy="18" r="1.6"/><circle cx="14.5" cy="18" r="1.6"/></svg>',
    pin: S('<path d="M14.6 2.8 21.2 9.4l-3 .8-4.4 4.4-.6 4.8-7.4-7.4 4.8-.6 4.4-4.4z"/><path d="M7.4 16.6 3 21"/>'),
    min: S('<path d="M5 12h14"/>'),
    close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
    plus: S('<path d="M12 5v14M5 12h14"/>'),
    copy: S('<rect x="8.4" y="8.4" width="12.2" height="12.2" rx="3"/><path d="M16.4 8.4V6a2.6 2.6 0 0 0-2.6-2.6H6a2.6 2.6 0 0 0-2.6 2.6v7.8A2.6 2.6 0 0 0 6 16.4h2.4"/>'),
    search: S('<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.6 15.6 20.4 20.4"/>'),
    sun: S('<circle cx="12" cy="12" r="4.4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.3 6.3 4.7 4.7M19.3 19.3l-1.6-1.6M17.7 6.3l1.6-1.6M4.7 19.3l1.6-1.6"/>'),
    moon: S('<path d="M20.4 14.6A8.8 8.8 0 0 1 9.4 3.6a8.8 8.8 0 1 0 11 11z"/>'),
    // Half-filled disc: the window takes its side from Windows.
    auto: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 3.4a8.6 8.6 0 0 0 0 17.2z" fill="currentColor" stroke="none"/>'),
    // Ghost: processes still lurking that Dotswitch did not start.
    ghost: S('<path d="M4.4 20.2V10a7.6 7.6 0 0 1 15.2 0v10.2l-2.6-1.8-2.4 1.8-2.6-1.8-2.6 1.8-2.4-1.8z"/><path d="M9.4 9.8h.01M14.6 9.8h.01"/>'),
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

  // ── Appearance ──────────────────────────────────────────
  //
  // The window wears Dotswitch's own two brand colours on either a white or a
  // black ground. Which ground is the host's call — it reconciles the saved
  // preference with the Windows setting and pushes the answer here.

  /** 'system' | 'light' | 'dark' — what the user chose, not what it resolved to. */
  let themeMode = 'system';

  const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' };

  const THEME_LABEL = {
    system: 'Theme: following Windows',
    light: 'Theme: light',
    dark: 'Theme: dark',
  };

  const THEME_ICON = { system: 'auto', light: 'sun', dark: 'moon' };

  function applyAppearance(msg) {
    themeMode = THEME_CYCLE[msg.mode] ? msg.mode : 'system';
    document.documentElement.dataset.theme = msg.dark ? 'dark' : 'light';

    const btn = document.getElementById('btnTheme');
    btn.innerHTML = ICON[THEME_ICON[themeMode]];
    btn.dataset.tip = THEME_LABEL[themeMode];
    btn.setAttribute('aria-label', THEME_LABEL[themeMode]);
    // Only an explicit choice lights up; following Windows is the resting state.
    btn.classList.toggle('active', themeMode !== 'system');
  }

  /**
   * Take the log drawer's ANSI colours from whatever palette the VS Code
   * extension exported, so output looks the way it does in the integrated
   * terminal. Everything else in the window is Dotswitch's own palette now and
   * deliberately does not follow the editor.
   */
  function applyTheme(t) {
    if (!t || !Array.isArray(t.ansi)) return;
    const root = document.documentElement.style;
    t.ansi.forEach((c, i) => { if (c) root.setProperty('--a' + i, c); });
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
    // data-tip rather than title: the native tooltip is unstyled, unanimated,
    // and appears on its own slow schedule.
    b.dataset.tip = title;
    b.setAttribute('aria-label', title);
    b.disabled = !!disabled;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ── Tooltips ────────────────────────────────────────────
  // One shared element, positioned per target. Disabled buttons still get one,
  // which the native tooltip refuses to do — and "why is this greyed out" is
  // exactly when an explanation is wanted.

  const tipEl = document.getElementById('tip');
  let tipTimer = null;

  function showTip(target) {
    const text = target.dataset.tip;
    if (!text) return;
    // A tooltip outranks the menu in paint order, so one drifting open over a
    // list of profiles hides the thing being chosen.
    if (openDd !== null) return;

    tipEl.textContent = text;
    tipEl.classList.add('measuring');
    tipEl.setAttribute('aria-hidden', 'false');

    const t = target.getBoundingClientRect();
    const box = tipEl.getBoundingClientRect();

    // Prefer below; flip above when there is no room.
    let top = t.bottom + 8;
    if (top + box.height > window.innerHeight - 6) top = t.top - box.height - 8;

    let left = t.left + t.width / 2 - box.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - box.width - 6));

    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    tipEl.classList.remove('measuring');
    tipEl.classList.add('on');
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipEl.classList.remove('on');
    tipEl.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!target) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target), 380);
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
  });

  // A tooltip left hanging over a button that was just clicked away is noise.
  document.addEventListener('mousedown', hideTip, true);
  window.addEventListener('blur', hideTip);

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

  /**
   * What is already on screen. The list is rebuilt on every status push, so
   * without this the entry animation would replay on each one and the window
   * would twitch while anything was running.
   */
  const painted = new Set();
  const paintedLogs = new Set();
  const isWorking = (p) => isBusy(p.status) || pending.has(p.id);

  function act(type, id) {
    pending.add(id);
    post(type, { id: id });
    render();
  }

  // ── Rendering ───────────────────────────────────────────

  function render() {
    // Rebuilding the list mid-drag would destroy the element being dragged.
    if (drag) { renderQueued = true; return; }

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
    // One stop glyph everywhere, so "stop" is a shape you learn once.
    stopAllBtn.innerHTML = shuttingDown ? ICON.spinner : ICON.stop;
    stopAllBtn.classList.toggle('spinning', shuttingDown);
    stopAllBtn.classList.toggle('halt', !shuttingDown);
    stopAllBtn.disabled = shuttingDown;

    emptyEl.hidden = pool.length > 0;

    // Forget rows that have gone, so one re-added later animates in again.
    const alive = new Set(projects.map((p) => p.id));
    for (const id of painted) if (!alive.has(id)) painted.delete(id);
    for (const id of paintedLogs) if (!expanded.has(id)) paintedLogs.delete(id);

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

    const current = p.profile || names[0];

    const btn = el('button', 'dd-btn');
    btn.disabled = disabled;
    btn.dataset.tip = 'Launch profile';
    // The dot says encrypted or not without the label having to spell it twice.
    if (/^https/i.test(current)) btn.classList.add('secure');
    btn.appendChild(el('span', 'dd-dot'));
    btn.appendChild(el('span', 'dd-val', current));
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
        // Always present, hidden by opacity when unselected: a tick that only
        // exists on one row would shunt every other label sideways.
        const tick = el('span', 'dd-tick');
        tick.innerHTML = ICON.check;
        item.appendChild(tick);
        item.appendChild(el('span', null, name));
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
    if (openDd === p.id) c.classList.add('menu-open');
    if (!painted.has(p.id)) {
      c.classList.add('fresh');
      painted.add(p.id);
    }

    // Drag handle. Only the grip starts a drag, so pressing anywhere else on
    // the card still behaves like a normal click target.
    const grip = el('div', 'grip');
    grip.innerHTML = ICON.grip;
    grip.dataset.tip = 'Drag to reorder';
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      beginDrag(p.id, c, e);
    });
    c.appendChild(grip);

    c.appendChild(el('span', 'dot ' + p.status));

    const info = el('div', 'info');
    const nm = el('div', 'name', p.name);
    nm.dataset.tip = p.relPath || p.name;
    info.appendChild(nm);

    const meta = el('div', 'meta');
    if (p.url) {
      const a = el('a', null, p.url.replace(/^https?:\/\//, ''));
      a.href = '#';
      a.dataset.tip = 'Open ' + p.url;
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
      t.dataset.tip = p.autoRestarts + ' automatic restart(s) after a change hot reload could not apply';
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
      if (!paintedLogs.has(p.id)) {
        logs.classList.add('fresh');
        paintedLogs.add(p.id);
      }

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
  //
  // Pointer-driven rather than HTML5 drag-and-drop. The list re-renders on
  // every status push, which tore the dragged element out from under the
  // browser's drag session — the drag died and cards appeared to pile up.
  // Here the drag owns the DOM and renders are held until it finishes.

  /** @type {{ id, el, overlay, dx, dy, w } | null} */
  let drag = null;
  let renderQueued = false;

  /** The section head a card sits under, so cards cannot jump between groups. */
  function sectionOf(card) {
    let node = card.previousElementSibling;
    while (node && !node.classList.contains('section-head')) node = node.previousElementSibling;
    return node;
  }

  const logsOf = (card) =>
    card.nextElementSibling && card.nextElementSibling.classList.contains('logs')
      ? card.nextElementSibling
      : null;

  /** Move a card and, if its log drawer is open, the drawer with it. */
  function moveCard(card, reference, before) {
    const logs = logsOf(card);
    const refLogs = logsOf(reference);
    const anchor = before ? reference : (refLogs || reference).nextSibling;
    scrollEl.insertBefore(card, anchor);
    if (logs) scrollEl.insertBefore(logs, card.nextSibling);
  }

  /**
   * FLIP: measure before, reorder, then animate each card from where it was to
   * where it now is. This is what makes the other cards glide aside instead of
   * teleporting when the dragged one passes them.
   */
  function animateReorder(mutate) {
    const cards = [...scrollEl.querySelectorAll('.card')];
    const before = new Map(cards.map((c) => [c, c.getBoundingClientRect().top]));

    mutate();

    for (const card of cards) {
      if (card === (drag && drag.el)) continue;
      const delta = before.get(card) - card.getBoundingClientRect().top;
      if (!delta) continue;
      card.style.transition = 'none';
      card.style.transform = `translateY(${delta}px)`;
      // Next frame, release to the real position and let CSS ease it.
      requestAnimationFrame(() => {
        card.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)';
        card.style.transform = '';
      });
    }
  }

  function beginDrag(id, card, event) {
    const rect = card.getBoundingClientRect();

    // A clone lifted out of the flow follows the pointer, while the original
    // stays as a hollow slot showing where it will land.
    const overlay = card.cloneNode(true);
    overlay.classList.add('drag-overlay');
    overlay.style.width = rect.width + 'px';
    overlay.style.left = '0px';
    overlay.style.top = '0px';
    document.body.appendChild(overlay);

    drag = {
      id,
      el: card,
      overlay,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };

    positionOverlay(event.clientX, event.clientY);
    card.classList.add('drag-source');
    document.body.classList.add('is-dragging');

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', endDrag, { once: true });
  }

  function positionOverlay(x, y) {
    if (!drag) return;
    drag.overlay.style.transform = `translate3d(${x - drag.dx}px, ${y - drag.dy}px, 0)`;
  }

  function onDragMove(e) {
    if (!drag) return;
    positionOverlay(e.clientX, e.clientY);

    // The overlay sits under the cursor, so ask what is beneath it instead.
    drag.overlay.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const over = under && under.closest ? under.closest('.card') : null;
    if (!over || over === drag.el || over.classList.contains('drag-overlay')) return;

    // Grouping is derived from status on every render, so a card dragged into
    // the other group would snap straight back. Keep it in its own section.
    if (sectionOf(over) !== sectionOf(drag.el)) return;

    const box = over.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;
    animateReorder(() => moveCard(drag.el, over, before));
  }

  function endDrag() {
    if (!drag) return;
    document.removeEventListener('mousemove', onDragMove);

    const { el, overlay } = drag;
    const target = el.getBoundingClientRect();

    // Settle the lifted card into its slot rather than having it vanish.
    overlay.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1), opacity 180ms ease';
    overlay.style.transform = `translate3d(${target.left}px, ${target.top}px, 0)`;
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 200);

    el.classList.remove('drag-source');
    document.body.classList.remove('is-dragging');
    drag = null;

    // Read the order straight off the DOM. The saved order is one flat
    // sequence across both groups, which is what keeps positions stable when a
    // project later starts or stops.
    const ids = [...scrollEl.querySelectorAll('.card[data-id]')].map((c) => c.dataset.id);
    if (ids.length) post('reorder', { ids: ids });

    if (renderQueued) {
      renderQueued = false;
      // Let the settle animation finish before the list is rebuilt.
      setTimeout(render, 200);
    }
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
        pinBtn.dataset.tip = pinned ? 'Stop keeping on top' : 'Keep on top';
      } else if (msg.type === 'appearance') {
        applyAppearance(msg);
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
  document.getElementById('btnTheme').innerHTML = ICON.auto;

  document.getElementById('btnAdd').innerHTML = ICON.plus;
  document.getElementById('btnStrays').innerHTML = ICON.ghost;
  document.getElementById('searchIcon').innerHTML = ICON.search;
  document.getElementById('emptyMark').innerHTML = ICON.plus;
  document.getElementById('btnStrays').addEventListener('click', () => post('killStrays'));

  // Following Windows, then explicitly light, then explicitly dark, then back.
  // The host owns the preference — it has to survive a restart, and it also
  // repaints the native frame around this page.
  document.getElementById('btnTheme').addEventListener('click', () => {
    post('setTheme', { mode: THEME_CYCLE[themeMode] || 'system' });
  });

  // Opened through the host so it lands in the real browser rather than
  // navigating this window away from the app.
  document.getElementById('author').addEventListener('click', (e) => {
    e.preventDefault();
    post('openLink', { url: 'https://siamahnaf.com' });
  });

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
