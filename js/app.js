/* App shell: hash router, header, settings popover, global notifications. */
(function () {
  var esc = UI.esc;
  var ROUTES = {
    triage: { view: window.TriageView, title: 'Triage' },
    tasks: { view: window.TasksView, title: 'Lineup' },
    capture: { view: window.CaptureView, title: 'New task' }
  };
  var PREF_KEY = 'fuzz.prefs.v1';
  var prefs = { theme: 'terracotta', mode: 'auto', contrast: 'standard', codeFont: 'jetbrains', calm: false };
  var current = null, currentName = null;

  function load() {
    try { var p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); if (p) prefs = Object.assign(prefs, p); } catch (e) { /* storage can be blocked */ }
    if (!Themes.list.some(function (t) { return t.id === prefs.theme; })) prefs.theme = 'terracotta';
  }
  function save() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }

  function paint() { Themes.apply(prefs.theme, prefs.mode, prefs.contrast, prefs.codeFont); save(); paintPopover(); }

  var App = {
    setTheme: function (id) { prefs.theme = id; paint(); },
    setMode: function (m) { prefs.mode = m; paint(); },
    setContrast: function (c) { prefs.contrast = c; paint(); },
    setCodeFont: function (id) { prefs.codeFont = id; paint(); },
    setCalm: function (v) {
      prefs.calm = !!v; Fuzz.setCalm(prefs.calm); save(); paintPopover();
    },
    navigate: function (hash) { location.hash = hash; },
    refresh: function () { if (currentName === 'triage' && TriageView) TriageView.refresh(); else if (current && ROUTES[currentName]) route(true); },
    resetDemo: function () { Store.reset(); TriageView.hardReset(); route(true); Say.tell('Demo data is back to the start.'); }
  };
  window.App = App;

  /* ---------- Header ---------- */
  function buildHeader() {
    var h = document.getElementById('appbar');
    h.innerHTML =
      '<div class="appbar-left"><a class="brand" href="#/triage" aria-label="Fuzz, go to triage">' + Fuzz.mini('good', { cls: 'brand-av' }) + '<span class="brand-name">Fuzz</span></a>' +
      '<nav class="mainnav" aria-label="Main">' +
        '<a href="#/triage" data-nav="triage">Triage<span class="navcount" id="navcount" aria-label="waiting"></span></a>' +
        '<a href="#/tasks" data-nav="tasks">Lineup</a>' +
      '</nav></div>' +
      '<div class="hprog" id="hprog" hidden><span class="left" id="left" aria-hidden="true"></span>' + Progress.html('prog') + '</div>' +
      /* On narrow screens these collapse to icons (New task moves to the floating #fab); .lbl stays for screen readers. */
      '<div class="appbar-right"><a href="#/capture" data-nav="capture" class="themebtn nav-cta" title="New task (N)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="lbl">New task</span></a>' +
        '<div class="undowrap"><button type="button" class="themebtn undobtn" id="undobtn" aria-expanded="false" aria-controls="undopop" aria-haspopup="dialog" disabled>' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg><span class="lbl">Undo</span><span class="navcount" id="undocount"></span></button>' +
        '<div class="themepop undopop" id="undopop" role="dialog" aria-label="Recent actions" hidden></div></div>' +
        '<button type="button" class="themebtn iconbtn" id="setbtn" aria-label="Settings" title="Settings" aria-expanded="false" aria-controls="themepop" aria-haspopup="dialog"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>' +
        '<div class="themepop" id="themepop" role="dialog" aria-label="Settings" hidden></div></div>';
    document.getElementById('setbtn').addEventListener('click', function () { toggleUndo(false); togglePopover(); });
    document.getElementById('undobtn').addEventListener('click', function () { togglePopover(false); toggleUndo(); });
    document.getElementById('undopop').addEventListener('click', function (e) {
      e.stopPropagation();
      var b = e.target.closest('[data-undo]'); if (!b) return;
      var u = Say.undoList()[parseInt(b.dataset.undo, 10)]; toggleUndo(false);
      if (u) { u.run(); document.getElementById('undobtn').focus(); }
    });
    Say.onUndoChange(paintUndo); setInterval(paintUndo, 30000); paintUndo();
    document.addEventListener('click', function (e) {
      var pop = document.getElementById('themepop');
      if (!pop.hidden && !e.target.closest('#themepop') && !e.target.closest('#setbtn')) togglePopover(false);
      if (!document.getElementById('undopop').hidden && !e.target.closest('#undopop') && !e.target.closest('#undobtn')) toggleUndo(false);
    });
    /* Escape closes an open popover wherever focus is, before any view sees the key. */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = !document.getElementById('themepop').hidden ? ['setbtn', togglePopover] : !document.getElementById('undopop').hidden ? ['undobtn', toggleUndo] : null;
      if (!open) return;
      e.preventDefault(); e.stopPropagation(); open[1](false); document.getElementById(open[0]).focus();
    }, true);
    document.getElementById('themepop').addEventListener('click', function (e) {
      e.stopPropagation(); /* the popover re-renders itself, so don't let the outside-click handler see a detached target */
      var t = e.target.closest('[data-theme-id],[data-mode],[data-contrast],[data-reset],[data-calm]'); if (!t) return;
      if (t.dataset.themeId) App.setTheme(t.dataset.themeId);
      else if (t.dataset.mode) App.setMode(t.dataset.mode);
      else if (t.dataset.contrast) App.setContrast(t.dataset.contrast);
      else if (t.dataset.reset) { togglePopover(false); App.resetDemo(); }
    });
    document.getElementById('themepop').addEventListener('change', function (e) { if (e.target.id === 'calmbox') App.setCalm(e.target.checked); if (e.target.id === 'codefont') App.setCodeFont(e.target.value); });
    Progress.mount(document.getElementById('prog'));
    paintPopover();
  }
  function togglePopover(force) {
    var pop = document.getElementById('themepop'), btn = document.getElementById('setbtn');
    var show = force === undefined ? pop.hidden : force;
    pop.hidden = !show; btn.setAttribute('aria-expanded', String(show));
    if (show) { var first = pop.querySelector('[aria-pressed="true"]'); if (first) first.focus(); }
  }
  function toggleUndo(force) {
    var pop = document.getElementById('undopop'), btn = document.getElementById('undobtn');
    var show = force === undefined ? pop.hidden : force;
    if (show && btn.disabled) show = false;
    pop.hidden = !show; btn.setAttribute('aria-expanded', String(show));
    if (show) { var first = pop.querySelector('button'); if (first) first.focus(); }
  }
  function ago(t) {
    var m = Math.floor((Date.now() - t) / 60000);
    return m < 1 ? 'Just now' : m + ' min ago';
  }
  function paintUndo() {
    var btn = document.getElementById('undobtn'), pop = document.getElementById('undopop'), cnt = document.getElementById('undocount'); if (!btn) return;
    var list = Say.undoList();
    var n = list.filter(function (u) { return !u.blocked(); }).length;   /* blocked ones stay listed with the reason, uncounted */
    btn.disabled = !list.length; cnt.textContent = n ? String(n) : '';
    if (!list.length) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); pop.innerHTML = ''; return; }
    /* Each one undoes on its own. One that can't any more stays listed, dimmed, with the reason. */
    pop.innerHTML = '<h2>Recent actions</h2><ul class="undolist">' + list.map(function (u, i) {
      var why = u.blocked();
      return '<li><button type="button" data-undo="' + i + '"' + (why ? ' aria-disabled="true" class="u-blocked"' : '') + '><span class="u-l">' + esc(u.label) + '</span><span class="u-m">' + (why ? esc(why) : ago(u.at)) + '</span></button></li>';
    }).join('') + '</ul>';
  }
  function paintPopover() {
    var pop = document.getElementById('themepop'); if (!pop) return;
    var mode = Themes.resolveMode(prefs.mode);
    var ae = document.activeElement, focused = ae && pop.contains(ae) ? ae.getAttribute('data-theme-id') || ae.getAttribute('data-mode') || ae.getAttribute('data-contrast') : null;
    pop.innerHTML =
      '<h2 class="pop-title">Settings</h2><h2>Theme</h2><div class="palettes" role="group" aria-label="Theme">' + Themes.list.map(function (t) {
        var p = Themes.palette(t.id, mode, prefs.contrast), on = t.id === prefs.theme;
        return '<button type="button" class="pal" data-theme-id="' + t.id + '" aria-pressed="' + on + '"><span class="pal-sw" style="background:' + p.bg + ';border-color:' + p.line + '"><i style="background:' + p.accent + '"></i><i style="background:' + p.link + '"></i><i style="background:' + p.ink + '"></i></span><span class="pal-n">' + esc(t.name) + '</span><span class="pal-f">' + esc(t.note) + '</span></button>';
      }).join('') + '</div>' +
      '<h2>Appearance</h2><div class="segrow" role="group" aria-label="Appearance">' + [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match system']].map(function (m) { return '<button type="button" class="seg" data-mode="' + m[0] + '" aria-pressed="' + (prefs.mode === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div>' +
      '<h2>Contrast</h2><div class="segrow" role="group" aria-label="Contrast">' + [['standard', 'Standard'], ['high', 'High contrast']].map(function (m) { return '<button type="button" class="seg" data-contrast="' + m[0] + '" aria-pressed="' + (prefs.contrast === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div>' +
      '<h2>Code font</h2><div class="selectrow"><label for="codefont" class="sr">Code font</label><select id="codefont">' + Themes.codeFonts.map(function (f) { return '<option value="' + f.id + '"' + (f.id === prefs.codeFont ? ' selected' : '') + '>' + esc(f.name) + ' · ' + esc(f.note) + '</option>'; }).join('') + '</select></div>' +
      '<h2>Motion</h2><label class="check"><input type="checkbox" id="calmbox"' + (prefs.calm ? ' checked' : '') + '> <span>Calm mode<small>Fades only. No flashes, confetti or gags.</small></span></label>' +
      '<h2>Demo</h2><button type="button" class="btn small" data-reset="1">Reset demo data</button>';
    if (focused) { var el = pop.querySelector('[data-theme-id="' + focused + '"],[data-mode="' + focused + '"],[data-contrast="' + focused + '"]'); if (el) el.focus(); }
  }

  /* ---------- Router ---------- */
  function route(force) {
    var name = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'triage';
    if (!ROUTES[name]) name = 'triage';
    if (!force && name === currentName) return;
    if (current) current.unmount();
    togglePopover(false); toggleUndo(false);
    var main = document.getElementById('view');
    main.innerHTML = '';
    main.className = 'view view--' + name;
    if (name === 'triage' || name === 'capture') Say.hideDock(); /* Fuzz speaks from the perch there */
    currentName = name; current = ROUTES[name].view;
    document.getElementById('hprog').hidden = name !== 'triage';
    document.body.dataset.view = name;
    /* No floating New task button on capture (you're there) or triage (its actions sit at the bottom on phones) */
    document.getElementById('fab').hidden = name !== 'tasks';
    current.mount(main);
    document.title = ROUTES[name].title + ' · Fuzz';
    document.querySelectorAll('[data-nav]').forEach(function (a) { if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    /* Focus the page heading, unless the view already put focus somewhere useful (New task focuses its field, so N then type just works) */
    if (!force) { var h1 = main.querySelector('h1'); if (h1 && !main.contains(document.activeElement)) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); } window.scrollTo(0, 0); }
  }

  function updateCount() {
    var has = Store.get().queue.length > 0, el = document.getElementById('navcount');
    if (!el) return;
    var glyph = has ? '' : '✓';
    if (el.textContent !== glyph) el.textContent = glyph;
    el.classList.toggle('done', !has);
    el.classList.toggle('has', has);
    el.setAttribute('aria-label', has ? 'Tasks to triage' : 'All triaged');
  }

  /* Fuzz's background work never interrupts. Anything you need to know arrives as a card in the queue. */
  Store.on(updateCount);
  /* On Triage, Fuzz celebrates from the perch; anywhere else, the small Fuzz says it */
  Store.on(function (e) { if (e.type === 'wrapped' && currentName !== 'triage') Say.tell('That wraps up ' + e.project.title + '. Every task in it is done.'); });

  /* Capture costs nothing: one key, from anywhere that isn't a text field. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT')) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault(); App.navigate('#/capture');
  });

  /* ---------- Boot ---------- */
  load();
  Themes.apply(prefs.theme, prefs.mode, prefs.contrast, prefs.codeFont);
  Themes.onSystemChange(function () { if (prefs.mode === 'auto') { Themes.apply(prefs.theme, prefs.mode, prefs.contrast, prefs.codeFont); paintPopover(); } });
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  Fuzz.setCalm(prefs.calm || reduce);
  if (reduce && !prefs.calm) prefs.calm = true;
  Store.reset();
  Store.startWork();
  buildHeader();
  window.addEventListener('hashchange', function () { route(false); });
  setInterval(updateCount, 1000);
  updateCount();
  route(true);
})();
