/* Guided setup, over GET/PUT /setup: who you are, which tools Fuzz can use, a folder it may write to,
   and a check. Opens the first time you connect, and from Settings any time after. Every step can be
   skipped; nothing is saved until you press Next or Done on it. */
(function () {
  var esc = UI.esc;
  var STEPS = [['me', 'You'], ['tools', 'Tools'], ['folder', 'Folder'], ['check', 'Check']];
  var ME = [['emails', 'Email addresses', 'you@work.example, you@home.example'], ['names', 'Names', 'Justin, Justin G.'], ['slack_ids', 'Slack member IDs', 'W123ABC']];
  var dlg = null, st = null, step = 0, client = null, picks = {}, poll = 0, busy = false, finished = false;
  var LATER = 'fuzz.setup.later', ticker = 0, otherOpen = false, choosing = false;

  function cur() { return st.tools.filter(function (t) { return t.client === client; })[0]; }
  function list(v) { return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }

  /* What is ticked: your saved choice, or the suggested lookups when nothing is saved. Sends never start ticked. */
  function startPicks(v) {
    if (picks[v.client]) return;
    var read = {}, send = {};
    v.tools.forEach(function (t) {
      if (t.read || (!v.read.length && t.suggested)) read[t.allow] = true;
      if (t.send) send[t.allow] = true;
    });
    picks[v.client] = { read: read, send: send };
  }

  function stepsHTML() {
    return '<ol class="setup-steps" aria-label="Steps">' + STEPS.map(function (s, i) {
      return '<li' + (i === step ? ' aria-current="step"' : '') + (i < step ? ' class="done"' : '') + '>' + (i + 1) + '. ' + s[1] + '</li>';
    }).join('') + '</ol>';
  }

  function meHTML() {
    var few = (st.me.emails || []).length < 2;
    return '<section><h3>Who you are</h3><p class="meta">Fuzz treats an account signed in as any of these as yours, so it never stops to ask whether you meant work or personal. Separate them with commas.</p>' +
      ME.map(function (f) { return '<div class="field"><label for="su-' + f[0] + '">' + f[1] + '</label><input id="su-' + f[0] + '" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(f[2]) + '" value="' + esc((st.me[f[0]] || []).join(', ')) + '"></div>'; }).join('') +
      (few ? '<p class="setup-hint">Add your work email too, if you have one. A connector signed in to an address that isn’t here makes Fuzz ask which one you meant.</p>' : '') + '</section>';
  }

  function toolRow(t, group, on) {
    return '<li><label class="check"><input type="checkbox" data-pick="' + group + '" value="' + esc(t.allow) + '"' + (on ? ' checked' : '') + '> <span>' + esc(t.allow) + (t.does ? '<small>' + esc(t.does) + '</small>' : '') + '</span></label></li>';
  }
  function toolsHTML() {
    var tabs = st.tools.length > 1 ? '<div class="segrow" role="group" aria-label="Client">' + st.tools.map(function (v) { return '<button type="button" class="seg" data-client="' + v.client + '" aria-pressed="' + (v.client === client) + '">' + esc(v.label) + '</button>'; }).join('') + '</div>' : '';
    var v = cur(), d = v.discovery || {};
    var h = '<section><h3>Which tools Fuzz can use</h3>' + tabs;
    if (d.state === 'running') {
      return h + '<div class="setup-wait"><span class="spin" aria-hidden="true"></span><p><span role="status">Asking ' + esc(v.label) + ' which tools it has…</span> <span class="setup-elapsed" id="su-elapsed" aria-hidden="true">' + elapsed(d) + '</span>' +
        '<small>Usually about a minute. You can go on to the next step; it keeps going.</small></p></div></section>';
    }
    var again = '<button type="button" class="btn small" data-discover="1">' + (v.discovered_at ? 'List them again' : 'List ' + esc(v.label) + '’s tools') + '</button>';
    if (d.state === 'error') h += '<p class="setup-hint" role="alert">That didn’t work: ' + esc(d.error) + '</p>';
    if (!v.tools.length) {
      return h + '<p class="meta">Fuzz asks ' + esc(v.label) + ' once which connectors and tools it has. That starts one ' + esc(v.label) + ' run; nothing is called and nothing changes.</p>' +
        (v.read.length ? '<p class="meta">Allowed now: ' + esc(v.read.join(', ')) + '</p>' : '') + again + '</section>';
    }
    startPicks(v);
    var p = picks[v.client];
    var look = v.tools.filter(function (t) { return t.kind === 'lookup'; }), send = v.tools.filter(function (t) { return t.kind === 'send'; });
    var other = v.tools.length - look.length - send.length;
    var n = Object.keys(p.read).length;
    return h + '<p class="meta">Listed ' + esc(new Date(v.discovered_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + '. ' + again + '</p>' +
      '<div class="setup-subrow"><h4 class="setup-sub">Look things up</h4>' + (look.length ? allBtn('read', look, p) : '') + '</div><p class="meta">The executor runs these without asking, so only tools that read are suggested.</p>' +
      (look.length ? '<ul class="setup-tools">' + look.map(function (t) { return toolRow(t, 'read', p.read[t.allow]); }).join('') + '</ul>' : '<p class="meta">None found.</p>') +
      '<div class="setup-subrow"><h4 class="setup-sub">Send</h4>' + (send.length ? allBtn('send', send, p) : '') + '</div><p class="meta">The sender uses these only for drafts you approved. None is ticked for you.</p>' +
      (send.length ? '<ul class="setup-tools">' + send.map(function (t) { return toolRow(t, 'send', p.send[t.allow]); }).join('') + '</ul>' : '<p class="meta">None found.</p>') +
      (other ? otherHTML(v.tools.filter(function (t) { return t.kind === 'change'; })) : '') +
      '<p class="setup-cost" id="su-cost">' + costText(n) + '</p></section>';
  }
  /* The tools Fuzz never gets, listed for reference: no checkboxes, folded away until you open it */
  function otherHTML(tools) {
    var n = tools.length;
    return '<details class="setup-other" data-other' + (otherOpen ? ' open' : '') + '><summary>' + n + ' more ' + (n === 1 ? 'tool creates, changes or deletes' : 'tools create, change or delete') + ' things. Fuzz never gets those.</summary>' +
      '<ul class="setup-tools">' + tools.map(function (t) { return '<li><span class="setup-tool">' + esc(t.allow) + (t.does ? '<small>' + esc(t.does) + '</small>' : '') + '</span></li>'; }).join('') + '</ul></details>';
  }
  function elapsed(d) {
    var s = Math.max(0, Math.round(Date.now() / 1000 - (d.started_at || Date.now() / 1000)));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  /* "Select all" until every tool in the section is ticked, then "Clear all" */
  function allBtn(group, tools, p) {
    var full = tools.length && tools.every(function (t) { return p[group][t.allow]; });
    return '<button type="button" class="linkbtn setup-all" data-all="' + group + '" aria-pressed="' + !!full + '">' + (full ? 'Clear all' : 'Select all') + '</button>';
  }
  function costText(n) { return n ? n + ' lookup ' + (n === 1 ? 'tool' : 'tools') + ': about ' + (n * 180).toLocaleString() + ' more tokens in every executor run.' : 'Only Fuzz’s own tools: the cheapest runs, but Fuzz can’t look anything up.'; }

  function folderHTML() {
    var f = st.folder;
    return '<section><h3>A folder Fuzz may write to</h3><p class="meta">The one place Fuzz creates and changes files without asking: documents, spreadsheets, checklists. Each task gets its own subfolder. Nothing in it is sent anywhere, and approved notes and results are saved there too.</p>' +
      '<div class="field"><label for="su-folder">Folder</label><div class="setup-folderrow"><input id="su-folder" type="text" autocomplete="off" spellcheck="false" value="' + esc(f.path || f.suggested) + '">' +
      '<button type="button" class="btn" data-choose="1"' + (choosing ? ' disabled' : '') + '>' + (choosing ? 'Waiting…' : 'Choose…') + '</button></div>' +
      (choosing ? '<p class="meta" role="status">Pick a folder in the window that opened. It may be behind your browser.</p>' : '') + '</div>' +
      '<label class="check"><input type="checkbox" id="su-nofolder"' + (st.folder.path === null && st.done ? ' checked' : '') + '> <span>Don’t let Fuzz write files<small>Results stay in the brief and notes.</small></span></label></section>';
  }

  function checkHTML() {
    var W = { ready: ['Ready', 'ok'], needs_attention: ['Needs attention', 'warn'], not_installed: ['Not installed', 'muted'] };
    return '<section><h3>Check</h3><ul class="setup-check">' + (st.check || []).map(function (c) {
      var w = W[c.summary] || W.needs_attention;
      return '<li>' + UI.pill(w[0], w[1]) + ' <b>' + esc(c.label) + '</b>' + (c.is_engine ? ' <span class="meta">· runs Fuzz</span>' : '') + (c.first_fix ? '<small>' + esc(c.first_fix) + '</small>' : '') + '</li>';
    }).join('') + '</ul><p class="meta">You can come back to any step from Settings.</p></section>';
  }

  function paint() {
    if (!dlg) return;
    var body = [meHTML, toolsHTML, folderHTML, checkHTML][step]();
    var last = step === STEPS.length - 1;
    dlg.querySelector('.dlg-in').innerHTML = '<div class="dlg-top"><div class="dlg-titles"><h2 id="su-h">Set up Fuzz</h2>' + stepsHTML() + '</div></div>' + body +
      '<div class="dlg-actions">' + (step ? '<button type="button" class="btn" data-go="back">Back</button>' : '') +
      (last ? '' : '<button type="button" class="btn" data-go="skip">Skip</button>') +
      '<button type="button" class="btn primary" data-go="next"' + (busy ? ' disabled' : '') + '>' + (last ? 'Done' : 'Next') + '</button></div>';
  }

  /* Polling skips the check (it starts each client), and keeps the last one */
  function refresh(quick) {
    return Live.setup(quick).then(function (r) {
      if (quick && st) r.check = st.check;
      st = r;
      if (!client || !cur()) client = st.tools[0] && st.tools[0].client;
      var running = st.tools.some(function (t) { return t.discovery && t.discovery.state === 'running'; });
      clearTimeout(poll);
      /* Repaint only on the Tools step: elsewhere it would wipe what you're typing */
      if (running) poll = setTimeout(function () { refresh(true).then(function () { if (STEPS[step][0] === 'tools') paint(); }); }, 3000);
      return st;
    });
  }

  /* Save what this step shows, then move on */
  function save() {
    var id = STEPS[step][0];
    if (id === 'me') {
      var body = {};
      ME.forEach(function (f) { body[f[0]] = list(dlg.querySelector('#su-' + f[0]).value); });
      if (!body.emails.length) delete body.emails;
      return Live.saveMe(body);
    }
    if (id === 'tools') {
      var v = cur(); if (!v.tools.length || !picks[v.client]) return Promise.resolve();
      var p = picks[v.client];
      /* A whole server allowed by hand stays allowed, even if the list shows its tools one by one */
      var keep = v.read.filter(function (x) { return !v.tools.some(function (t) { return t.allow === x; }) && !v.tools.some(function (t) { return t.allow.indexOf(x + '(') === 0; }); });
      return Live.saveTools(v.client, Object.keys(p.read).concat(keep), Object.keys(p.send));
    }
    if (id === 'folder') return Live.saveFolder(dlg.querySelector('#su-nofolder').checked ? null : dlg.querySelector('#su-folder').value.trim());
    return Live.setupDone();
  }

  function go(where) {
    if (where === 'back') { step--; return paint(); }
    var last = step === STEPS.length - 1;
    var p = where === 'skip' ? Promise.resolve() : save();
    busy = true; paint();
    p.then(function () { return refresh(); }).then(function () {
      busy = false;
      if (last) { finished = true; dlg.close(); Say.tell('Fuzz is set up. Change any of it from Settings.'); return; }
      step++; paint();
      var h = dlg.querySelector('#su-h'); if (h) h.focus();
    }, function (e) { busy = false; paint(); Say.tell('Couldn’t save that: ' + e.message); });
  }

  function onClick(e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go) return go(b.dataset.go);
    if (b.dataset.client) { client = b.dataset.client; return paint(); }
    if (b.dataset.all) return selectAll(b);
    if (b.dataset.choose) return chooseFolder();
    if (b.dataset.discover) {
      /* Show it working at once; the core's answer and the polling take over from here */
      cur().discovery = { state: 'running', started_at: Date.now() / 1000 };
      paint();
      Live.discover(client).then(function () { delete picks[client]; return refresh(true); }).then(paint, function (err) { Say.tell('Couldn’t list the tools: ' + err.message); });
    }
  }
  /* The Mac's own folder chooser, opened by the core: a browser never gives a page a folder's real path */
  function chooseFolder() {
    var input = dlg.querySelector('#su-folder'), typed = input.value;
    choosing = true; paint();
    Live.chooseFolder(typed).then(function (r) {
      choosing = false; paint();
      var el = dlg && dlg.querySelector('#su-folder'); if (!el) return;
      el.value = r.path || typed;
      if (r.path) { dlg.querySelector('#su-nofolder').checked = false; el.focus(); }
    }, function (e) {
      choosing = false; paint();
      var el = dlg && dlg.querySelector('#su-folder'); if (el) el.value = typed;
      Say.tell('Couldn’t open the folder chooser: ' + e.message);
    });
  }
  /* Tick or clear a whole section in place, so the list keeps its scroll */
  function selectAll(b) {
    var group = b.dataset.all, on = b.getAttribute('aria-pressed') !== 'true', p = picks[client][group];
    dlg.querySelectorAll('input[data-pick="' + group + '"]').forEach(function (c) {
      c.checked = on;
      if (on) p[c.value] = true; else delete p[c.value];
    });
    syncPicks();
  }
  function syncPicks() {
    var v = cur(), p = picks[client];
    ['read', 'send'].forEach(function (group) {
      var b = dlg.querySelector('[data-all="' + group + '"]'); if (!b) return;
      var boxes = dlg.querySelectorAll('input[data-pick="' + group + '"]');
      var full = boxes.length && Array.prototype.every.call(boxes, function (c) { return c.checked; });
      b.setAttribute('aria-pressed', String(!!full)); b.textContent = full ? 'Clear all' : 'Select all';
    });
    var n = document.getElementById('su-cost'); if (n) n.textContent = costText(Object.keys(p.read).length);
  }
  function onChange(e) {
    var c = e.target; if (!c.dataset || !c.dataset.pick) return;
    var p = picks[client][c.dataset.pick];
    if (c.checked) p[c.value] = true; else delete p[c.value];
    syncPicks();
  }

  var Setup = {
    open: function (at) {
      if (!Live.on() || dlg) return;
      step = at || 0; picks = {}; finished = false;
      refresh().then(function () {
        dlg = UI.dialog('<div class="dlg-in" aria-labelledby="su-h"></div>', { cls: 'setup-dlg', onClose: function () {
          dlg = null; clearTimeout(poll); clearInterval(ticker);
          /* Closed before Done: don't open by itself again in this browser. Settings still has it. */
          if (!finished) { try { localStorage.setItem(LATER, '1'); } catch (e) {} }
        } });
        dlg.setAttribute('aria-labelledby', 'su-h');
        dlg.addEventListener('click', onClick);
        dlg.addEventListener('change', onChange);
        /* Keep the list of other tools open across repaints once you've opened it */
        dlg.addEventListener('toggle', function (e) { if (e.target.hasAttribute && e.target.hasAttribute('data-other')) otherOpen = e.target.open; }, true);
        paint();
        /* The elapsed time on a tool listing, updated in place */
        ticker = setInterval(function () {
          var el = document.getElementById('su-elapsed'), v = st && client && cur();
          if (el && v && v.discovery) el.textContent = elapsed(v.discovery);
        }, 1000);
      }, function (e) { Say.tell('Couldn’t open setup: ' + e.message); });
    },
    /* The first time you connect: open once, unless setup was done (or skipped to the end) before */
    maybeOpen: function () {
      if (!Live.on()) return;
      try { if (localStorage.getItem(LATER)) return; } catch (e) {}
      Live.setup(true).then(function (r) { if (!r.done) Setup.open(); }, function () {});
    }
  };
  window.Setup = Setup;
})();
