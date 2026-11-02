/* Settings (#/settings, the gear in the header): what Fuzz knows and may do, how he looks, one section
   each, saved on its own. Replaces the old four-step guided setup and the header's quick settings.

   About you        your other names, emails and Slack IDs (PUT /me)
   App              the app Fuzz works through: status, install, repair, switch (/engine)
   Working hours    when Fuzz reads for new asks (PUT /hours), the same choices as Fuzz's first question
   What Fuzz can …  one row per source, in plain words, with Reading and Sending switches; the tool-by-tool
                    list folds away under Details (PUT /setup/tools; List again runs discovery)
   Files            the one folder Fuzz may write to (PUT /setup/folder)
   Look and feel    theme, appearance, contrast, code font, Calm mode (this browser's)
   Your queue       refresh (or reset the demo), switch account; then the tour */
(function () {
  var esc = UI.esc;
  var V = {}, root = null, data = null, poll = 0, busy = {}, hoursEdit = null, open = {}, picks = null;
  var LINKS = { 'claude-code': 'https://claude.com/product/claude-code', copilot: 'https://github.com/features/copilot/cli' };

  function plain(server) { return /^claude\.ai /i.test(server || '') ? server.slice(10) : (server || 'Other'); }
  function list(v) { return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function clock(h) { return Onboard.clock(h); }

  V.mount = function (container) {
    root = container;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('toggle', function (e) { if (e.target.dataset && e.target.dataset.open) open[e.target.dataset.open] = e.target.open; }, true);
    if (!Live.on()) {
      root.innerHTML = '<section class="settings"><h1>Settings</h1><p class="meta">You’re using the demo, so only the look is yours to change. The rest is for your real queue, from the Fuzz core on your Mac.</p>' +
        lookHTML() + queueHTML() + againHTML() + '</section>';
      return;
    }
    root.innerHTML = '<section class="settings"><h1>Settings</h1><p class="meta" role="status">One moment…</p></section>';
    load().then(paint, function (e) { if (root) root.querySelector('.meta').textContent = 'I couldn’t load your settings: ' + e.message; });
  };
  V.unmount = function () { clearTimeout(poll); root = null; picks = null; };

  function load() {
    return Promise.all([Live.me(), Live.engine(), Live.hours(), Live.setup(true)]).then(function (r) {
      data = { me: r[0], engine: r[1], hours: r[2], setup: r[3] };
      return data;
    });
  }
  function engineClient() { return data.engine.engine.client; }
  function toolsView() {
    var c = engineClient();
    return data.setup.tools.filter(function (v) { return v.client === c; })[0] || data.setup.tools[0];
  }

  function paint() {
    if (!root) return;
    var y = window.scrollY;
    root.innerHTML = '<section class="settings" aria-labelledby="set-h"><h1 id="set-h">Settings</h1>' +
      '<p class="meta">What Fuzz knows about you, what he may do, and how he looks. Each part saves on its own.</p>' +
      meHTML() + appHTML() + hoursHTML() + sourcesHTML() + folderHTML() + lookHTML() + queueHTML() + againHTML() + '</section>';
    window.scrollTo(0, y);
  }
  /* Redraw one section, so what you're typing in another stays put; focus comes back to the same control */
  var FN = null;
  function repaint(id) {
    FN = FN || { me: meHTML, app: appHTML, hours: hoursHTML, sources: sourcesHTML, folder: folderHTML, look: lookHTML };
    var el = root && root.querySelector('#sec-' + id); if (!el) return;
    var a = document.activeElement, key = a && el.contains(a) ? ['id', 'data-src', 'data-tool', 'data-hmode', 'data-app', 'data-list', 'data-choose', 'data-look-theme', 'data-look-mode', 'data-look-contrast'].map(function (k) { return a.getAttribute(k) ? '[' + k + '="' + a.getAttribute(k) + '"]' : ''; }).join('') : '';
    var grp = a && a.getAttribute && a.getAttribute('data-group');
    el.outerHTML = FN[id]();
    if (key) { var back = root.querySelector('#sec-' + id + ' ' + (key.indexOf('[id=') === 0 ? '#' + a.id : key) + (grp ? '[data-group="' + grp + '"]' : '')); if (back) back.focus({ preventScroll: true }); }
  }
  function section(id, title, intro, body) {
    return '<section class="set-sec" id="sec-' + id + '" aria-labelledby="sec-' + id + '-h"><h2 id="sec-' + id + '-h">' + title + '</h2>' +
      (intro ? '<p class="meta">' + intro + '</p>' : '') + body + '</section>';
  }
  function saveBtn(id, label) { return '<div class="set-actions"><button type="submit" class="btn primary small"' + (busy[id] ? ' disabled' : '') + '>' + (busy[id] ? 'Saving…' : label || 'Save') + '</button><span class="meta set-said" id="said-' + id + '" role="status"></span></div>'; }
  function said(id, text) { var el = root && root.querySelector('#said-' + id); if (el) el.textContent = text; }

  /* ---------- About you ---------- */
  var ME = [['names', 'Names', 'Sam, Sam K.'], ['emails', 'Email addresses', 'you@work.example, you@home.example'], ['slack_ids', 'Slack member IDs', 'W123ABC']];
  function meHTML() {
    return section('me', 'About you', 'An account signed in as any of these is yours, so I never stop to ask whether you meant work or personal. Separate them with commas.',
      '<form data-form="me">' + ME.map(function (f) {
        return '<div class="field"><label for="me-' + f[0] + '">' + f[1] + '</label><input id="me-' + f[0] + '" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(f[2]) + '" value="' + esc((data.me[f[0]] || []).join(', ')) + '"></div>';
      }).join('') + saveBtn('me') + '</form>');
  }
  function saveMe() {
    var body = {};
    ME.forEach(function (f) { body[f[0]] = list(root.querySelector('#me-' + f[0]).value); });
    if (!body.emails.length) delete body.emails;   /* the core keeps at least one */
    return Live.saveMe(body).then(function (r) { data.me = r; return 'Saved.'; });
  }

  /* ---------- App ---------- */
  function appHTML() {
    var cur = engineClient();
    var rows = data.engine.clients.map(function (c) {
      var on = c.client === cur, b = busy['app-' + c.client];
      var tag = b ? [b, 'accent'] : c.summary === 'ready' ? ['Ready', 'ok'] : c.installed ? ['Needs a fix', 'warn'] : c.found ? ['Not set up', 'muted'] : ['Not on this Mac', 'muted'];
      var acts = b ? '' : !c.found ? '<a class="btn small linklike" href="' + esc(LINKS[c.client] || '#') + '" target="_blank" rel="noopener">Get ' + esc(c.label) + '</a>'
        : !c.installed ? '<button type="button" class="btn small" data-app="install" data-client="' + c.client + '">Set me up in it</button>'
        : (c.summary !== 'ready' ? '<button type="button" class="btn small" data-app="repair" data-client="' + c.client + '">Repair</button>' : '') +
          (!on && c.summary === 'ready' ? '<button type="button" class="btn small" data-app="use" data-client="' + c.client + '">Work through this one</button>' : '');
      return '<li class="set-app' + (on ? ' on' : '') + '"><div><b>' + esc(c.label) + '</b>' + (on ? ' <span class="meta">· I work through this one</span>' : '') +
        ' ' + UI.pill(tag[0], tag[1]) + (c.first_fix && c.installed && c.summary !== 'ready' && !b ? '<small>' + esc(c.first_fix) + '</small>' : '') + '</div><div class="segrow">' + acts + '</div></li>';
    }).join('');
    return section('app', 'App', 'The app I do my work inside, with what you’ve connected there.', '<ul class="set-apps">' + rows + '</ul>' +
      '<div class="set-actions"><button type="button" class="btn small" data-app="check"' + (busy.check ? ' disabled' : '') + '>' + (busy.check ? 'Checking…' : 'Check again') + '</button><span class="meta set-said" id="said-app" role="status"></span></div>');
  }
  /* Installing reloads launchd's jobs, `fuzz serve` among them: wait for a new server, or a quiet few seconds */
  function restarted(before) {
    var start = Date.now(), down = false;
    return new Promise(function (done) {
      (function tick() {
        Live.serverId().then(function (b) {
          if (!b) down = true;
          if (b && (b !== before || (!down && Date.now() - start > 4000)) || Date.now() - start > 45000) return done();
          setTimeout(tick, 600);
        });
      })();
    });
  }
  function appAction(what, client) {
    if (what === 'check') {
      busy.check = true; repaint('app');
      return Live.checkEngine().then(function (r) { data.engine = r; busy.check = false; repaint('app'); said('app', 'Checked.'); },
        function (e) { busy.check = false; repaint('app'); said('app', 'That didn’t work: ' + e.message); });
    }
    if (what === 'use') {
      busy['app-' + client] = 'Switching…'; repaint('app');
      return Live.chooseEngine(client).then(function () { return Live.engine(); }).then(function (r) {
        data.engine = r; delete busy['app-' + client]; return Live.setup(true);
      }).then(function (s) { data.setup = s; repaint('app'); repaint('sources'); said('app', 'I’ll work through it from my next run.'); },
        function (e) { delete busy['app-' + client]; repaint('app'); said('app', 'I couldn’t switch: ' + e.message); });
    }
    busy['app-' + client] = what === 'install' ? 'Setting up…' : 'Repairing…'; repaint('app');
    var before;
    return Live.serverId().then(function (b) {
      before = b;
      return Live.clientAction(client, what).catch(function (e) { if (!(e instanceof TypeError)) throw e; });
    }).then(function () { return restarted(before); }).then(function () { return Live.checkEngine(); }).then(function (r) {
      data.engine = r; delete busy['app-' + client]; repaint('app');
      var c = r.clients.filter(function (x) { return x.client === client; })[0];
      said('app', c && c.summary === 'ready' ? 'Done. It’s ready.' : 'It still needs a fix: ' + ((c && c.first_fix) || 'it didn’t pass its check') + '.');
    }, function (e) { delete busy['app-' + client]; repaint('app'); said('app', 'That didn’t work: ' + e.message); });
  }

  /* ---------- Working hours ---------- */
  function hoursHTML() {
    var h = data.hours, e = hoursEdit || { mode: h.hours === null ? 'none' : h.weekends ? 'everyday' : 'weekdays', from: (h.hours || [8, 18.5])[0], until: (h.hours || [8, 18.5])[1] };
    hoursEdit = e;
    var steps = Onboard.hourSteps;
    function sel(id, v, from) { return '<select id="' + id + '">' + steps.filter(function (x) { return from ? x < 24 : x > 0; }).map(function (x) { return '<option value="' + x + '"' + (x === v ? ' selected' : '') + '>' + esc(clock(x)) + '</option>'; }).join('') + '</select>'; }
    return section('hours', 'Working hours', 'I read for new asks during these hours, and stay quiet outside them. Run now, from a task or the first read, always runs.',
      '<form data-form="hours"><div class="segrow" role="radiogroup" aria-label="Which days">' + [['weekdays', 'Weekdays'], ['everyday', 'Every day'], ['none', 'No fixed hours']].map(function (m) {
        return '<button type="button" class="seg" role="radio" data-hmode="' + m[0] + '" aria-checked="' + (e.mode === m[0]) + '" aria-pressed="' + (e.mode === m[0]) + '">' + m[1] + '</button>';
      }).join('') + '</div>' +
      (e.mode === 'none' ? '<p class="meta">Then I read around the clock.</p>' : '<div class="onb-times"><label for="h-from">From</label>' + sel('h-from', e.from, true) + '<label for="h-until">until</label>' + sel('h-until', e.until, false) + '</div>') +
      saveBtn('hours') + '</form>');
  }
  function saveHours() {
    var e = hoursEdit;
    if (e.mode !== 'none' && e.until <= e.from) return Promise.reject(new Error('That ends before it starts. Pick an end time after the start.'));
    var body = e.mode === 'none' ? { hours: null, weekends: true } : { hours: [e.from, e.until], weekends: e.mode === 'everyday' };
    return Live.saveHours(body).then(function (h) { data.hours = h; hoursEdit = null; return 'Saved.'; });
  }

  /* ---------- What Fuzz can read and send ---------- */
  /* One row per source. A source is on for reading when Fuzz may use any of its ways to look things up;
     switching it on allows them all, off removes them all. The same for sending. Details has each tool. */
  function sources(v) {
    var by = {}, order = [];
    v.tools.forEach(function (t) {
      if (t.kind === 'change') return;   /* creates, changes or deletes: never Fuzz's */
      var s = t.server || 'Other';
      if (!by[s]) { by[s] = { name: s, look: [], send: [] }; order.push(s); }
      by[s][t.kind === 'send' ? 'send' : 'look'].push(t);
    });
    return order.map(function (s) { return by[s]; });
  }
  function startPicks(v) {
    if (picks && picks.client === v.client) return picks;
    var read = {}, send = {};
    v.tools.forEach(function (t) { if (t.read) read[t.allow] = true; if (t.send) send[t.allow] = true; });
    picks = { client: v.client, read: read, send: send, dirty: false };
    return picks;
  }
  function sourcesHTML() {
    var v = toolsView();
    if (!v) return '';
    var d = v.discovery || {}, running = d.state === 'running';
    var again = '<button type="button" class="btn small" data-list="1"' + (running ? ' disabled' : '') + '>' + (running ? 'Asking ' + esc(v.label) + '…' : v.discovered_at ? 'List again' : 'Find what ' + esc(v.label) + ' can reach') + '</button>';
    var intro = 'What I may use through ' + esc(v.label) + '. I read with these without asking, and I only send drafts you’ve approved.';
    if (!v.tools.length) {
      return section('sources', 'What Fuzz can read and send', intro,
        (d.state === 'error' ? '<p class="setup-hint" role="alert">That didn’t work: ' + esc(d.error) + '</p>' : '') +
        '<p class="meta">' + (running ? 'Usually about a minute. Nothing is read or changed while I ask.' : 'I haven’t asked ' + esc(v.label) + ' what it can reach yet. That’s one run; nothing is read.') + '</p>' +
        '<div class="set-actions">' + again + '</div>');
    }
    var p = startPicks(v), rows = sources(v);
    function on(group, tools) { return tools.length && tools.some(function (t) { return p[group][t.allow]; }); }
    function can(tools) { return tools.slice(0, 3).map(function (t) { return (t.does || t.allow).replace(/\.$/, ''); }).join(', ') + (tools.length > 3 ? ', and ' + (tools.length - 3) + ' more' : ''); }
    var table = '<ul class="set-sources">' + rows.map(function (r, i) {
      return '<li><div class="set-src"><b>' + esc(plain(r.name)) + '</b><small>' + esc(can(r.look.length ? r.look : r.send)) + '</small></div>' +
        '<div class="set-switches">' +
          (r.look.length ? '<label class="check"><input type="checkbox" data-src="' + i + '" data-group="read"' + (on('read', r.look) ? ' checked' : '') + '> <span>Reading</span></label>' : '') +
          (r.send.length ? '<label class="check"><input type="checkbox" data-src="' + i + '" data-group="send"' + (on('send', r.send) ? ' checked' : '') + '> <span>Sending</span></label>' : '') +
        '</div></li>';
    }).join('') + '</ul>';
    var n = Object.keys(p.read).length;
    var details = '<details class="set-details" data-open="tools"' + (open.tools ? ' open' : '') + '><summary>Details: each tool, by name</summary>' +
      '<p class="meta">Each tool I may read with adds about 180 tokens to every run' + (n ? ' (' + (n * 180).toLocaleString() + ' now)' : '') + '. Tools that create, change or delete things are never mine.</p>' +
      rows.map(function (r) {
        return '<h3>' + esc(plain(r.name)) + '</h3><ul class="setup-tools">' + r.look.concat(r.send).map(function (t) {
          var g = t.kind === 'send' ? 'send' : 'read';
          return '<li><label class="check"><input type="checkbox" data-tool="' + esc(t.allow) + '" data-group="' + g + '"' + (p[g][t.allow] ? ' checked' : '') + '> <span><code>' + esc(t.allow) + '</code><small>' + (g === 'send' ? 'Sends: ' : 'Reads: ') + esc(t.does || '') + '</small></span></label></li>';
        }).join('') + '</ul>';
      }).join('') + '</details>';
    return section('sources', 'What Fuzz can read and send', intro, '<form data-form="sources">' + table + details +
      '<div class="set-actions"><button type="submit" class="btn primary small"' + (busy.sources ? ' disabled' : '') + '>' + (busy.sources ? 'Saving…' : 'Save') + '</button>' + again +
      '<span class="meta set-said" id="said-sources" role="status">' + (running ? 'Asking ' + esc(v.label) + ' what it can reach. Usually about a minute.' : p.dirty ? 'Not saved yet.' : '') + '</span></div></form>');
  }
  function setSource(i, group, onOff) {
    var v = toolsView(), r = sources(v)[i], p = startPicks(v);
    (group === 'send' ? r.send : r.look).forEach(function (t) { if (onOff) p[group][t.allow] = true; else delete p[group][t.allow]; });
    p.dirty = true; repaint('sources');
  }
  function saveSources() {
    var v = toolsView(), p = startPicks(v);
    /* A whole server allowed by hand stays allowed, even though the list shows its tools one by one */
    var listed = function (x) { return v.tools.some(function (t) { return t.allow === x || t.allow.indexOf(x + '(') === 0; }); };
    var keepRead = v.read.filter(function (x) { return !listed(x); }), keepSend = v.send.filter(function (x) { return !listed(x); });
    return Live.saveTools(v.client, Object.keys(p.read).concat(keepRead), Object.keys(p.send).concat(keepSend)).then(function () {
      return Live.setup(true);
    }).then(function (s) { data.setup = s; picks = null; return 'Saved. I’ll use them from my next run.'; });
  }
  function listAgain() {
    var v = toolsView();
    v.discovery = { state: 'running' }; repaint('sources');
    Live.discover(v.client).then(function wait() {
      return Live.setup(true).then(function (s) {
        data.setup = s; repaint('sources');
        var nv = toolsView();
        if (nv.discovery && nv.discovery.state === 'running') return new Promise(function (res) { poll = setTimeout(res, 3000); }).then(wait);
      });
    }).then(function () { picks = null; repaint('sources'); }, function (e) { said('sources', 'That didn’t work: ' + e.message); });
  }

  /* ---------- Where Fuzz saves files ---------- */
  function folderHTML() {
    var f = data.setup.folder, none = !f.path;
    return section('folder', 'Where Fuzz saves files', 'The one place I create and change files without asking: documents, spreadsheets, checklists. Each task gets its own folder. Nothing in it is sent anywhere.',
      '<form data-form="folder"><div class="field"><label for="set-folder">Folder</label><div class="setup-folderrow"><input id="set-folder" type="text" autocomplete="off" spellcheck="false" value="' + esc(f.path || f.suggested) + '">' +
      '<button type="button" class="btn" data-choose="1"' + (busy.choose ? ' disabled' : '') + '>' + (busy.choose ? 'Waiting…' : 'Choose…') + '</button></div></div>' +
      '<label class="check"><input type="checkbox" id="set-nofolder"' + (none ? ' checked' : '') + '> <span>Don’t let Fuzz write files<small>Results stay in the brief and notes.</small></span></label>' +
      saveBtn('folder') + '</form>');
  }
  function saveFolder() {
    var off = root.querySelector('#set-nofolder').checked, path = root.querySelector('#set-folder').value.trim();
    return Live.saveFolder(off ? null : path).then(function (r) { data.setup.folder.path = r.path; return r.path ? 'Saved. Files go in ' + r.path + '.' : 'Saved. I won’t write files.'; });
  }
  function chooseFolder() {
    var input = root.querySelector('#set-folder'), typed = input.value;
    busy.choose = true; repaint('folder');
    Live.chooseFolder(typed).then(function (r) {
      busy.choose = false; repaint('folder');
      if (r.path) { root.querySelector('#set-folder').value = r.path; root.querySelector('#set-nofolder').checked = false; }
      else root.querySelector('#set-folder').value = typed;
    }, function (e) { busy.choose = false; repaint('folder'); root.querySelector('#set-folder').value = typed; said('folder', 'The folder chooser didn’t open: ' + e.message); });
  }

  /* ---------- Look and feel: this browser's, applied at once ---------- */
  function lookHTML() {
    var pr = App.prefs();
    var seg = function (attr, label, opts, cur) {
      return '<div class="segrow" role="group" aria-label="' + label + '">' + opts.map(function (o) {
        return '<button type="button" class="seg" ' + attr + '="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + o[1] + '</button>';
      }).join('') + '</div>';
    };
    return section('look', 'Look and feel', 'Changes show straight away and are kept in this browser.',
      '<h3>Theme</h3><div class="palettes set-pals" role="group" aria-label="Theme">' + App.themePicks('data-look-theme') + '</div>' +
      '<h3>Appearance</h3>' + seg('data-look-mode', 'Appearance', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match system']], pr.mode) +
      '<h3>Contrast</h3>' + seg('data-look-contrast', 'Contrast', [['standard', 'Standard'], ['high', 'High contrast']], pr.contrast) +
      '<h3><label for="look-font">Code font</label></h3><div class="selectrow"><select id="look-font">' + Themes.codeFonts.map(function (f) {
        return '<option value="' + f.id + '"' + (f.id === pr.codeFont ? ' selected' : '') + '>' + esc(f.name) + ' · ' + esc(f.note) + '</option>';
      }).join('') + '</select></div>' +
      '<h3>Motion</h3><label class="check"><input type="checkbox" id="look-calm"' + (pr.calm ? ' checked' : '') + '> <span>Calm mode<small>Fades only. No flashes, confetti or gags.</small></span></label>');
  }

  /* Your queue: bring it up to date with the core, or in the demo start it over; and switch who's using Fuzz */
  function queueHTML() {
    var live = Live.on();
    return section('queue', live ? 'Your queue' : 'Demo', live ? 'Connected to the Fuzz core on this Mac. This is your real queue.' : 'Invented tasks to try things out. Nothing reaches your accounts.',
      '<div class="set-actions"><button type="button" class="btn small" data-queue="reset">' + (live ? 'Refresh now' : 'Reset demo data') + '</button>' +
      (live || Live.canSwitch() ? '<button type="button" class="btn small" data-queue="switch">Switch account</button>' : '') + '</div>');
  }

  function againHTML() {
    return section('tour', 'The tour', null, '<p class="meta">Fuzz’s introduction and tips, from the start. Your settings stay as they are.</p><div class="set-actions"><button type="button" class="btn small" data-again="1">Show me around again</button></div>');
  }

  /* ---------- Events ---------- */
  var SAVE = { me: saveMe, hours: saveHours, sources: saveSources, folder: saveFolder };
  function onSubmit(e) {
    var f = e.target.dataset.form; if (!f) return;
    e.preventDefault();
    var saving = SAVE[f]();   /* reads what you typed before the section redraws as Saving… */
    busy[f] = true; repaint(f);
    saving.then(function (line) { busy[f] = false; repaint(f); said(f, line); },
      function (err) { busy[f] = false; repaint(f); said(f, 'I couldn’t save that: ' + err.message); });
  }
  function onClick(e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.app) return appAction(b.dataset.app, b.dataset.client);
    if (b.dataset.hmode) { hoursEdit.mode = b.dataset.hmode; repaint('hours'); return; }
    if (b.dataset.list) return listAgain();
    if (b.dataset.choose) return chooseFolder();
    if (b.dataset.again) return Onboard.again();
    if (b.dataset.queue === 'reset') return App.resetDemo();
    if (b.dataset.queue === 'switch') return Live.switchAccount();
    if (b.dataset.lookTheme) { App.setTheme(b.dataset.lookTheme); return repaint('look'); }
    if (b.dataset.lookMode) { App.setMode(b.dataset.lookMode); return repaint('look'); }
    if (b.dataset.lookContrast) { App.setContrast(b.dataset.lookContrast); return repaint('look'); }
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'look-font') return App.setCodeFont(t.value);
    if (t.id === 'look-calm') return App.setCalm(t.checked);
    if (t.id === 'h-from') hoursEdit.from = parseFloat(t.value);
    else if (t.id === 'h-until') hoursEdit.until = parseFloat(t.value);
    else if (t.dataset.src !== undefined) setSource(parseInt(t.dataset.src, 10), t.dataset.group, t.checked);
    else if (t.dataset.tool) {
      var p = startPicks(toolsView());
      if (t.checked) p[t.dataset.group][t.dataset.tool] = true; else delete p[t.dataset.group][t.dataset.tool];
      p.dirty = true; repaint('sources');
    }
  }

  window.SettingsView = V;
})();
