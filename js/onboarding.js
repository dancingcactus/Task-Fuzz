/* The onboarding (docs/onboarding.md): from nothing to working a real card, in one short sitting.

   form     name, the app Fuzz works through (installed from here), working hours
   intro    Fuzz says who he is and what he promises, then asks for one real task (N)
   wait     the task goes to Fuzz first; meanwhile, the three first tips
   card     the first card, on Triage, with one lesson: Assign, or what Fuzz already did
   done     one line on what's next, a first read, and setup cards take over

   It's a page (#/welcome), not a locked dialog: the header and Settings stay reachable throughout.
   Where you are is kept by the core (GET/PUT /onboarding), so closing the page at any step comes back
   to it. In the demo, Settings > Show me around again runs the intro and tips on the demo data, and
   keeps its place in this browser instead.

   After it: the later tips (Onboard.tip), each said once at the moment it fits, and the setup cards
   (Onboard.setupCard), one at a time, after real work. Every line follows docs/fuzz-tone.md. */
(function () {
  var esc = UI.esc;
  var LOCAL = 'fuzz.onboarding.v1';
  var st = null, root = null, ticker = 0, unsub = null, finishing = false, pendingItem = null, guidedId = null;
  var apps = null, hours = null, appState = {}, chosen = null, formName = '';
  var setupShown = false, quietUntil = 0;

  var GET_APP = {
    'claude-code': 'https://claude.com/product/claude-code',
    copilot: 'https://github.com/features/copilot/cli'
  };

  /* ---------- Where you are ---------- */
  function blank() { return { step: 'intro', done: false, task_id: null, tips: [], setup: {}, needed: false, setup_card: null }; }
  function loadLocal() { try { return Object.assign(blank(), JSON.parse(localStorage.getItem(LOCAL) || 'null') || { done: true }); } catch (e) { return Object.assign(blank(), { done: true }); } }
  function saveLocal() { try { localStorage.setItem(LOCAL, JSON.stringify(st)); } catch (e) {} }
  function load() {
    if (!Live.on()) { st = loadLocal(); st.needed = !st.done; return Promise.resolve(st); }
    return Live.onboarding().then(function (r) { st = r; hours = r.hours || hours; return st; });
  }
  /* Saves a change; the screen goes on at once, whatever the core says */
  function save(patch) {
    if (!st) st = blank();
    if (!Live.on()) {
      Object.keys(patch).forEach(function (k) {
        if (k === 'tips') st.tips = uniq(st.tips.concat(patch.tips));
        else if (k === 'again') Object.assign(st, { step: 'intro', done: false, task_id: null, tips: [] });
        else if (k === 'skipped') { st.skipped = true; st.done = true; st.step = 'done'; }
        else st[k] = patch[k];
      });
      if (patch.done) st.step = 'done';
      st.needed = !st.done;
      saveLocal();
      return Promise.resolve(st);
    }
    if (patch.tips) st.tips = uniq(st.tips.concat(patch.tips));
    if (patch.step) st.step = patch.step;
    if (patch.done || patch.skipped) { st.done = true; st.step = 'done'; }
    return Live.saveOnboarding(patch).then(function (r) { st = r; hours = r.hours || hours; return r; }, function (e) { console.error('[onboarding]', e); return st; });
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function active() { return !!(st && !st.done && st.needed); }

  /* The intro is always calm; the lively default starts after it */
  function calm(on) { if (window.App && App.tempCalm) App.tempCalm(on); }

  /* ---------- The page ---------- */
  var V = {};
  V.mount = function (container) {
    root = container;
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onChange);
    unsub = Store.on(function () { if (st && st.step === 'wait') paintWait(); });
    if (!st) { root.innerHTML = '<p class="meta" role="status">One moment…</p>'; load().then(paint); return; }
    paint();
  };
  V.unmount = function () {
    clearInterval(ticker); ticker = 0; spotlight(false);
    var ptr = document.getElementById('onb-pointer'); if (ptr) ptr.remove();
    if (unsub) unsub(); unsub = null;
    root = null;
  };

  function paint() {
    if (!root) return;
    clearInterval(ticker); ticker = 0;
    if (!active()) { App.navigate('#/triage'); return; }
    calm(true);
    var s = st.step;
    chrome(s);
    if (s === 'intro') return paintIntro();
    if (s === 'form') return paintForm();
    if (s === 'question') { App.navigate('#/triage'); return; }
    if (s === 'capture') return paintAsk();
    if (s === 'how') return paintHow();
    if (s === 'wait') return paintWait(true);
    if (s === 'card') { App.navigate('#/triage'); return; }
    App.navigate('#/triage');
  }
  function heading(h) {
    var el = root.querySelector('h1');
    if (el) { el.setAttribute('tabindex', '-1'); if (!root.contains(document.activeElement) || h) el.focus({ preventScroll: true }); }
  }
  function skipLink() { return '<p class="onb-skip"><button type="button" class="linkbtn" data-onb="skip">Skip the tour</button><span class="meta">Settings has it if you change your mind.</span></p>'; }

  /* ---------- 2. The form ---------- */
  function paintForm() {
    var a = apps ? apps.clients : [];
    root.innerHTML = '<section class="onb" aria-labelledby="onb-h">' +
      '<div class="onb-top">' + Fuzz.mini('good', { cls: 'onb-fz' }) + '<div><h1 id="onb-h">Two things before I start</h1><p class="meta">That’s all I’ll ask for now. Everything else can wait until it’s useful.</p></div></div>' +
      '<form class="onb-form" id="onb-form" novalidate>' +
        '<div class="field"><label for="onb-name">What should I call you?</label><input id="onb-name" type="text" autocomplete="given-name" spellcheck="false" value="' + esc(formName) + '" placeholder="Your first name"></div>' +
        '<fieldset class="onb-apps"><legend>Which app should I work through?</legend><p class="meta">I do my work inside it, with what you’ve connected there.</p>' +
          (apps ? '<div class="onb-picks">' + a.map(appHTML).join('') + '</div><div id="onb-appnote">' + appNote() + '</div>' : '<p class="meta" role="status"><span class="spin" aria-hidden="true"></span> Looking for Claude Code and Copilot on this Mac…</p>') +
        '</fieldset>' +
        '<div class="onb-actions"><button type="submit" class="btn primary" id="onb-go"' + (canGo() ? '' : ' disabled') + '>' + goLabel() + '</button><span class="meta" id="onb-gonote" role="status">' + goNote() + '</span></div>' +
      '</form></section>';
    heading();
    if (!apps) loadApps();
  }
  function appHTML(c) {
    var s = appState[c.client] || {}, on = chosen === c.client;
    var tag = s.state === 'working' ? 'Setting up…' : s.state === 'ready' ? 'Ready' : s.state === 'problem' ? 'Needs a fix' :
      c.summary === 'ready' ? 'Ready' : c.installed ? 'Installed' : c.found ? 'On this Mac' : 'Not on this Mac';
    var tone = s.state === 'ready' || (!s.state && c.summary === 'ready') ? 'ok' : s.state === 'problem' ? 'warn' : c.found ? 'accent' : 'muted';
    return '<button type="button" class="acct-pick onb-app" data-app="' + c.client + '" aria-pressed="' + on + '"' + (c.found ? '' : ' data-missing="1"') + '>' +
      '<span class="acct-n">' + esc(c.label === 'GitHub Copilot' ? 'Copilot' : c.label.replace(' Code', '')) + '</span><span class="acct-d">' + esc(c.label) + '</span>' + UI.pill(tag, tone) + '</button>';
  }
  function appNote() {
    if (!chosen) return '<p class="meta">Pick one. You can switch later in Settings.</p>';
    var c = client(chosen), s = appState[chosen] || {}, label = c ? c.label : chosen;
    if (!s.state && c && c.found) return '<p class="meta">I found ' + esc(label) + ' on this Mac. I’ll set myself up in it when you go on. You can switch later in Settings.</p>';
    if (s.state === 'working') return '<p class="onb-note" role="status"><span class="spin" aria-hidden="true"></span> ' + esc(s.note || 'Setting myself up in ' + label + '…') + ' <span class="meta">Carry on below. This takes a moment.</span></p>';
    if (s.state === 'ready') return '<p class="onb-note ok" role="status">' + UI.pill('Ready', 'ok') + ' I’m set up in ' + esc(label) + '.</p>';
    if (s.state === 'problem') return '<div class="onb-note warn" role="alert"><p>I’m installed in ' + esc(label) + ', but something’s off: ' + esc(s.fix || 'it didn’t pass its check') + '.</p><div class="segrow"><button type="button" class="btn small" data-onb="retry">Try again</button>' + demoBtn() + '</div></div>';
    if (s.state === 'missing') return '<div class="onb-note" role="status"><p>I can’t find ' + esc(label) + ' on this Mac. Once it’s installed, come back and pick it again.</p><div class="segrow"><a class="btn small linklike" href="' + esc(GET_APP[chosen] || '#') + '" target="_blank" rel="noopener">Get ' + esc(label) + '</a><button type="button" class="btn small" data-onb="recheck">I’ve installed it</button>' + demoBtn() + '</div><p class="meta">Or try the demo first. It’s invented work, so nothing reaches your accounts.</p></div>';
    return '';
  }
  function demoBtn() { return '<button type="button" class="btn small" data-onb="demo">Try the demo</button>'; }
  function client(name) { return apps && apps.clients.filter(function (c) { return c.client === name; })[0]; }

  var HOURS = [];
  for (var h = 0; h <= 24; h += 0.5) HOURS.push(h);
  function clock(h) {
    var d = new Date(2000, 0, 1, Math.floor(h), (h % 1) * 60);
    return h === 24 ? 'Midnight' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  /* Accepting the defaults works: the highlighted app is set up when you go on */
  function canGo() { var s = (appState[chosen] || {}).state, c = chosen && client(chosen); return !!(c && c.found && s !== 'problem'); }
  function goLabel() { return (appState[chosen] || {}).state === 'working' && waitingToGo ? 'Finishing setup…' : 'That’s everything'; }
  function goNote() {
    if (!chosen) return 'Pick an app first.';
    var s = (appState[chosen] || {}).state;
    if (s === 'working') return waitingToGo ? 'I’ll go on as soon as I’m set up.' : '';
    if (s === 'problem' || s === 'missing') return 'I need a working app before I can take a task.';
    return '';
  }
  var waitingToGo = false;
  function repaintForm() {
    if (!root || st.step !== 'form') return;
    var had = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.app : null;
    root.querySelectorAll('.onb-app').forEach(function (b) { var c = client(b.dataset.app); if (c) b.outerHTML = appHTML(c); });
    if (had) { var back = root.querySelector('[data-app="' + had + '"]'); if (back) back.focus({ preventScroll: true }); }
    var n = root.querySelector('#onb-appnote'); if (n) n.innerHTML = appNote();
    var go = root.querySelector('#onb-go'); if (go) { go.disabled = !canGo() || waitingToGo; go.textContent = goLabel(); }
    var gn = root.querySelector('#onb-gonote'); if (gn) gn.textContent = goNote();
  }

  function loadApps() {
    Promise.all([Live.engine(), Live.hours(), Live.me().catch(function () { return { names: [] }; })]).then(function (r) {
      apps = r[0]; hours = r[1];
      if (!formName) formName = st.name || (r[2].names || [])[0] || '';
      apps.clients.forEach(function (c) { if (c.summary === 'ready' && c.is_engine) appState[c.client] = { state: 'ready' }; });
      /* The app Fuzz finds is highlighted: the one already working, else the one on this Mac */
      var best = st.app && client(st.app) ? client(st.app) : apps.clients.filter(function (c) { return c.summary === 'ready'; })[0] || apps.clients.filter(function (c) { return c.installed; })[0] || apps.clients.filter(function (c) { return c.found; })[0];
      if (best && !chosen) pickApp(best.client, true);
      paintForm();
    }, function (e) { if (root) root.querySelector('.onb-apps').insertAdjacentHTML('beforeend', '<p class="onb-note warn" role="alert">I couldn’t check: ' + esc(e.message) + '</p>'); });
  }

  /* Choosing an app sets Fuzz up in it, in the background: install (or repair), wait out the restart,
     check it, then make it the one Fuzz works through. Three outcomes: ready, a problem, or not here. */
  function pickApp(name, auto) {
    chosen = name;
    var c = client(name);
    if (!c) return;
    if (!c.found) { appState[name] = { state: 'missing' }; return repaintForm(); }
    if ((appState[name] || {}).state === 'ready' || (appState[name] || {}).state === 'working') return repaintForm();
    if (auto && !c.installed) return repaintForm();   /* installing waits for your pick */
    setUp(name, false);
  }
  function setUp(name, repairing) {
    var c = client(name);
    appState[name] = { state: 'working', note: c.installed ? 'Checking myself in ' + c.label + '…' : 'Installing myself in ' + c.label + '…' };
    repaintForm();
    var before;
    Live.serverId().then(function (b) {
      before = b;
      if (!c.installed || repairing) return Live.clientAction(name, c.installed ? 'repair' : 'install').catch(function (e) { if (!(e instanceof TypeError)) throw e; });
    }).then(function () { return c.installed && !repairing ? null : restarted(before); })
      .then(function () { return Live.checkEngine(); })
      .then(function (eng) {
        apps = { clients: eng.clients, engine: eng.engine };
        var now = client(name);
        if (now.summary === 'ready') {
          return (eng.engine.client === name ? Promise.resolve() : Live.chooseEngine(name)).then(function () { appState[name] = { state: 'ready' }; });
        }
        if (!repairing && now.installed) { c = now; return setUp(name, true); }
        appState[name] = { state: 'problem', fix: now.first_fix };
      })
      .catch(function (e) { appState[name] = { state: 'problem', fix: e.message }; })
      .then(function () { repaintForm(); if (waitingToGo && (appState[chosen] || {}).state !== 'working') { waitingToGo = false; if (appState[chosen].state === 'ready') submitForm(); } });
  }
  /* Installing reloads the launchd jobs, `fuzz serve` among them. Wait for a new server to answer, or
     for a few seconds of the same one (nothing restarted, e.g. not on a Mac). */
  function restarted(before) {
    var start = Date.now(), seenDown = false;
    return new Promise(function (done) {
      (function poll() {
        Live.serverId().then(function (b) {
          if (!b) seenDown = true;
          if (b && (b !== before || (!seenDown && Date.now() - start > 4000))) return done();
          if (Date.now() - start > 45000) return done();
          setTimeout(poll, 600);
        });
      })();
    });
  }

  function submitForm() {
    if (!chosen) return;
    var s = (appState[chosen] || {}).state;
    if (!s && client(chosen) && client(chosen).found) { waitingToGo = true; return setUp(chosen, false); }
    if (s === 'working') { waitingToGo = true; return repaintForm(); }
    if (s !== 'ready') return repaintForm();
    var name = formName.trim(), go = root && root.querySelector('#onb-go');
    if (go) go.disabled = true;
    var saveName = !name ? Promise.resolve() : Live.me().then(function (me) {
      var names = me.names || [];
      return names.indexOf(name) > -1 ? null : Live.saveMe({ names: [name].concat(names) });
    });
    Promise.all([saveName]).then(function () {
      return save({ step: 'how', name: name || null, app: chosen });
    }).then(paint, function (e) { if (go) go.disabled = false; Say.tell('I couldn’t save that: ' + e.message, { stay: true }); });
  }

  /* ---------- The app's own controls stay out of the way until Fuzz shows them ---------- */
  /* bare: the header is hidden (the intro and the questions); reveal: it fades in, New task pointed out */
  function chrome(step) {
    var bare = active() && (step === 'intro' || step === 'form' || step === 'how');
    var was = document.body.classList.contains('onb-bare');
    document.body.classList.remove('onb-wait');
    document.body.classList.toggle('onb-bare', bare);
    if (was && !bare) {
      var bar = document.getElementById('appbar');
      if (bar) bar.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'ease-out' });
    }
  }
  /* The questions come only when there's something to set: a live core, with no app or hours yet */
  function needsForm() { return Live.on() && !st.app; }
  /* Fuzz's first question comes next if it's still open; then he asks for a task */
  function afterForm() { return Live.on() && !st.hours_set ? 'question' : 'capture'; }

  /* ---------- 1. Fuzz introduces himself ---------- */
  function paintIntro() {
    root.innerHTML = '<section class="onb onb-intro" aria-labelledby="onb-h">' +
      '<div class="onb-top">' + Fuzz.mini('good', { cls: 'onb-fz big' }) + '<div><h1 id="onb-h">Hi. I’m Fuzz.</h1></div></div>' +
      '<div class="onb-says">' +
        '<p>I take things off your plate. You tell me what’s on your mind, and I look into it, draft it or do it, then bring you one decision at a time.</p>' +
        '<p>I work in the background, while you get on with your day.</p>' +
        '<p class="onb-promise"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg><span><b>Nothing goes out without your yes, and everything has Undo.</b></span></p>' +
      '</div>' +
      '<div class="onb-actions"><button type="button" class="btn primary" data-onb="hello">' + (needsForm() ? 'Nice to meet you' : 'Show me') + '<kbd aria-hidden="true">↵</kbd></button></div>' +
      skipLink() + '</section>';
    heading(true);
  }

  /* ---------- 4. One real task: the header appears, and Fuzz points at New task ---------- */
  function paintAsk() {
    var name = st.name ? ', ' + st.name : '';
    var app = st.app && client(st.app) ? client(st.app).label : { 'claude-code': 'Claude Code', copilot: 'GitHub Copilot' }[st.app];
    root.innerHTML = '<section class="onb onb-intro" aria-labelledby="onb-h">' +
      '<div class="onb-top">' + Fuzz.mini('good', { cls: 'onb-fz big' }) + '<div><h1 id="onb-h">' + (st.hours_set ? 'Thanks' : 'All set') + esc(name) + '.</h1>' +
        '<p class="meta">' + (st.hours_set ? 'That was a card: one question, one answer. ' : '') + (app ? 'I’m working through ' + esc(app) + '. ' : '') + 'Right now I only know what you type here.</p></div></div>' +
      '<div class="onb-ask"><h2>Let’s try it on something real</h2>' +
        '<p>Tell me one thing on your plate. Something I can write or think through works best for now, like a reply to draft or a plan to sketch, since I can’t look things up yet.</p>' +
        '<p>Press the <b>New task</b> button, or <kbd>N</kbd> from anywhere. It’s always there.</p></div>' +
      skipLink() + '</section>' +
      pointerHTML('New task');
    heading(true);
    spotlight('new');
  }
  /* Ring the header's New task button (the floating one on a phone) and hang the pointer under it */
  var placeTimer = 0, spotOn = null;
  function pointerHTML(label) { return '<div class="onb-pointer" id="onb-pointer" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg><span>' + esc(label) + '</span></div>'; }
  /* What the pointer is on: New task (the header's, or the floating one on a phone), or the Triage tab */
  function newTaskButton() {
    var cands = spotOn === 'triage' ? [document.querySelector('.mainnav [data-nav="triage"]')] : [document.querySelector('.nav-cta'), document.getElementById('fab')];
    return cands.filter(function (b) { if (!b || b.hidden) return false; var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[0] || null;
  }
  function spotlight(on) {
    document.querySelectorAll('.onb-spot').forEach(function (b) { b.classList.remove('onb-spot'); });
    window.removeEventListener('resize', place); clearTimeout(placeTimer);
    spotOn = on || null;
    if (!on) return;
    var fab = document.getElementById('fab');
    if (on === 'new' && fab && window.matchMedia && matchMedia('(max-width: 760px)').matches) fab.hidden = false;
    var b = newTaskButton(); if (b) b.classList.add('onb-spot');
    window.addEventListener('resize', place);
    place(); placeTimer = setTimeout(place, 450);   /* again once the header has faded in */
  }
  function place() {
    var ptr = document.getElementById('onb-pointer'), b = newTaskButton();
    if (!ptr) return window.removeEventListener('resize', place);
    if (!b) { ptr.hidden = true; return; }
    var r = b.getBoundingClientRect(), up = r.top < innerHeight / 2;
    ptr.hidden = false; ptr.classList.toggle('below', !up);
    var w = ptr.offsetWidth, left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    ptr.style.left = left + 'px';
    ptr.style.top = up ? (r.bottom + 10) + 'px' : (r.top - ptr.offsetHeight - 10) + 'px';
    ptr.style.setProperty('--ax', (r.left + r.width / 2 - left) + 'px');
  }

  /* ---------- 5. Tips during the wait ---------- */
  var TIPS = [
    { key: 'sessions', title: 'I keep everything in one queue, so a short session is enough.',
      line: 'Set aside 20 minutes, once or twice a day, and we’ll go through it together.',
      why: 'A short slot you’ve already decided on helps a lot of people get started, because the “when” is settled. Put it on your calendar so you don’t have to hold it in your head. I don’t send reminders of my own.' },
    { key: 'sendback', title: 'Nothing I do is final.',
      line: 'Ask me to change things, or send a task back to me, as often as you like.',
      why: 'Getting it right the first time isn’t the job. On a draft, press R and say what to change. On other cards, write it in the instructions box. Sending something back costs nothing.' },
    { key: 'nothinglost', title: 'I don’t keep score.',
      line: 'Miss a session and everything waits where you left it. Stopping with cards left is fine too.',
      why: 'Nothing piles up against you: no overdue counts, no streaks to break. The time is there to help you start, not to measure you.' }
  ];
  /* Its own step, right after the questions: how Fuzz helps you get things done, guilt-free */
  function paintHow() {
    root.innerHTML = '<section class="onb onb-how" aria-labelledby="onb-h">' +
      '<div class="onb-top">' + Fuzz.mini('good', { cls: 'onb-fz big' }) + '<div><h1 id="onb-h">Here’s how I help you get things done, guilt-free.</h1>' +
        '<p class="meta">Three things that help a lot of people. None of them is required.</p></div></div>' +
      '<ol class="onb-tips">' + TIPS.map(function (t, i) {
        return '<li class="onb-tip"><p class="tip-title">' + esc(t.title) + '</p><p class="tip-line">' + esc(t.line) + '</p>' + (i === 0 ? calendarHTML() : '') + '<details><summary>Why this helps</summary><p>' + esc(t.why) + '</p></details></li>';
      }).join('') + '</ol>' +
      '<div class="onb-actions"><button type="button" class="btn primary" data-onb="howdone">Got it<kbd aria-hidden="true">↵</kbd></button></div>' +
      skipLink() + '</section>';
    heading(true);
  }
  function taskItem() {
    var it = st.task_id ? Store.item('t' + st.task_id) : null;
    if (!it && pendingItem) it = pendingItem;
    if (it && it.coreId && st.task_id !== it.coreId && Live.on()) save({ task_id: it.coreId });
    return it;
  }
  function status(it) {
    if (!it) return 'lost';
    /* Not yet with the core: it may still go to Fuzz first, so it isn't ready however the page has it */
    if (!it.coreId && Live.on()) return 'gathering';
    if (Store.inQueue(it.id) && it.kind === 'task') return 'ready';
    if (it.gathering || it.state === 'ai-queued' || it.state === 'ai' || !it.coreId && Live.on()) return 'gathering';
    if (it.state === 'triage') return 'gathering';
    return 'moved';   /* you already did something with it, from Lineup say */
  }
  function paintWait(first) {
    if (!root || st.step !== 'wait') return;
    var it = taskItem(), s = status(it);
    if (s === 'moved' || s === 'lost') { if (first) return finish(it ? 'moved' : 'lost'); return; }
    var top = root.querySelector('#onb-status');
    /* The next habit: Triage is where Fuzz brings things to decide, this task and any question he has */
    var html = s === 'ready'
      ? '<div class="onb-status ready">' + Fuzz.mini('good', { cls: 'onb-fz' }) + '<div><h1 id="onb-h">' + (it.result ? 'Done. It’s in Triage.' : 'It’s in Triage.') + '</h1><p>“' + esc(it.title) + '” is waiting there for you' + (it.result ? ', already done' : '') + '. Take your time; it’ll keep.</p>' +
        '<button type="button" class="btn primary" data-onb="show" id="onb-show">Open Triage<kbd aria-hidden="true">↵</kbd></button></div></div>'
      : '<div class="onb-status">' + Fuzz.mini('think', { cls: 'onb-fz' }) + '<div><h1 id="onb-h">Next, keep an eye on Triage.</h1>' +
        '<p>That’s where I bring you things to decide: your tasks once I’ve looked into them, and any questions I have. “' + esc(it.title) + '” lands there when I’m done reading up on it.</p>' +
        '<p class="meta" role="status"><span class="spin" aria-hidden="true"></span> Usually a minute or two. <span id="onb-el"></span> The dot on Triage means something’s waiting.</p></div></div>';
    if (top && top.dataset.s === s && !first) return;
    if (!top || first) {
      root.innerHTML = '<section class="onb onb-wait" aria-labelledby="onb-h"><div id="onb-status" data-s="' + s + '">' + html + '</div>' + pointerHTML('Triage') +
        skipLink() + '</section>';
      heading(true);
      spotlight('triage');
    } else {
      top.dataset.s = s; top.innerHTML = html;
      var b = root.querySelector('#onb-show'); if (b) b.focus({ preventScroll: true });
      Say.announce('It’s in Triage.');
      place();
    }
    clearInterval(ticker);
    if (s === 'gathering') {
      var since = it.capturedAt || Date.now();
      ticker = setInterval(function () {
        var el = root && root.querySelector('#onb-el'); if (!el) return;
        var m = Math.floor((Date.now() - since) / 60000);
        el.textContent = m < 1 ? '' : (m === 1 ? 'It’s been a minute.' : 'It’s been ' + m + ' minutes.');
        paintWait();
      }, 5000);
    }
  }

  /* ---------- The calendar file: 20 minutes, inside your working hours, with a link back ---------- */
  function sessionTimes() {
    var hr = hours && hours.hours, out = [];
    var from = hr ? hr[0] : 9, until = hr ? hr[1] : 17.5;
    for (var t = Math.ceil(from * 2) / 2; t + 1 / 3 <= until; t += 0.5) out.push(t);
    return out.length ? out : [9];
  }
  function calendarHTML() {
    var times = sessionTimes(), def = times[Math.min(1, times.length - 1)];
    return '<div class="onb-cal"><label for="onb-caltime">Every ' + (hours && (hours.weekends || !hours.hours) ? 'day' : 'weekday') + ' at</label><select id="onb-caltime">' +
      times.map(function (t) { return '<option value="' + t + '"' + (t === def ? ' selected' : '') + '>' + esc(clock(t)) + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="btn small" data-onb="ics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>Add to my calendar</button></div>';
  }
  function icsText(at, everyDay, now) {
    now = now || new Date();
    function two(n) { return ('0' + n).slice(-2); }
    function local(d) { return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + 'T' + two(d.getHours()) + two(d.getMinutes()) + '00'; }
    function utc(d) { return d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) + 'T' + two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds()) + 'Z'; }
    function text(s) { return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
    /* The next time it comes round: today if it's still ahead, else the next day it runs */
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(at), (at % 1) * 60);
    while (d <= now || (!everyDay && (d.getDay() === 0 || d.getDay() === 6))) d.setDate(d.getDate() + 1);
    var link = location.origin + location.pathname + '#/triage';
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fuzz//Queue time//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      'UID:fuzz-queue-' + now.getTime() + '@fuzz.local', 'DTSTAMP:' + utc(now), 'DTSTART:' + local(d), 'DURATION:PT20M',
      'RRULE:' + (everyDay ? 'FREQ=DAILY' : 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'),
      'SUMMARY:' + text('20 minutes with Fuzz'),
      'DESCRIPTION:' + text('Go through your queue, one card at a time. Stopping with cards left is fine, and missing one loses nothing.\nOpen Fuzz: ' + link),
      'URL:' + link, 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  }
  function downloadIcs() {
    var sel = root.querySelector('#onb-caltime'), at = parseFloat(sel.value);
    var everyDay = !!(hours && (hours.weekends || !hours.hours));
    var blob = new Blob([icsText(at, everyDay)], { type: 'text/calendar' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Fuzz queue time.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    Say.tell('Open the file and your calendar adds it. It links back here.');
  }

  /* ---------- 6. The first card, on Triage ---------- */
  function showCard() {
    var it = taskItem(); if (!it) return finish('lost');
    guidedId = it.id;
    Store.pick(it.id);
    save({ step: 'card' });
    App.navigate('#/triage');
  }
  /* Triage asks for the lesson on the card in front: one action, the one that fits */
  function guide(it) {
    if (!st || st.done || ['wait', 'card'].indexOf(st.step) < 0 || !it) return null;
    var mine = taskItem();
    if (!mine || mine.id !== it.id) return null;
    guidedId = it.id;
    if (st.step !== 'card') save({ step: 'card' });   /* you went to Triage yourself, which is the habit */
    if (it.result) {
      return { line: 'This one’s already done. Have a look.',
        html: '<aside class="onb-guide" aria-labelledby="guide-h">' + Fuzz.mini('good', { cls: 'guide-fz' }) + '<div><h3 id="guide-h">I already did this one</h3>' +
          '<p>It’s in <b>What Fuzz found</b> below' + (it.contextMd ? ', with the whole thing on the <b>Context</b> tab' : '') + '. If it’s what you needed, press <kbd>D</kbd> for Done.</p>' +
          '<p class="meta">Not quite? Say what to change in the box and press <kbd>A</kbd> to send it back to me.</p>' +
          '<button type="button" class="linkbtn" data-guide="skip">Skip this</button></div></aside>' };
    }
    return { line: 'Your task is back. One decision.',
      html: '<aside class="onb-guide" aria-labelledby="guide-h">' + Fuzz.mini('good', { cls: 'guide-fz' }) + '<div><h3 id="guide-h">Hand it to me</h3>' +
        '<p>This one’s yours from earlier. Press <kbd>A</kbd>, or <b>Assign to Fuzz</b>, and I’ll start on it. I’ll come back with something for you to look at before anything goes anywhere.</p>' +
        '<p class="meta">The box has the instructions I’d follow. Change anything first, if you like.</p>' +
        '<button type="button" class="linkbtn" data-guide="skip">Skip this</button></div></aside>' };
  }
  /* The guided card left the queue: you made the decision */
  function watchCard() {
    if (!st || st.done || st.step !== 'card' || !guidedId || finishing) return;
    if (!Store.inQueue(guidedId) && Store.item(guidedId)) finish('acted');
  }

  /* ---------- 7. What's next ---------- */
  function finish(how) {
    if (finishing || !st || st.done) return;
    finishing = true;
    clearInterval(ticker); ticker = 0;
    var patch = { done: true }; if (how === 'skip') patch.skipped = true;
    if (Live.on()) {
      patch.first_read = true;
      /* Run now: scheduled reading stops outside working hours, and this is often a Saturday */
      Live.firstRead().catch(function () {});
    }
    save(patch).then(function () {
      finishing = false; calm(false); chrome('done');
      var next = 'For now I only know what you type. Connect a source and I’ll find asks myself.';
      setupShown = true;   /* the onboarding ends on that line; setup cards wait for another visit */
      quietUntil = Date.now() + 12000;   /* and no later tip talks over it */
      if (how === 'acted') {
        tip('undo');
        setTimeout(function () { Say.tell(tipLine('undo')); }, 2600);
        setTimeout(function () { Say.tell(next, { ms: 12000 }); }, 7000);
      } else if (how === 'skip') {
        Say.tell('Okay. Settings has the tour if you want it.');
        setTimeout(function () { Say.tell(next, { ms: 12000 }); }, 4000);
      } else {
        Say.tell(next, { ms: 12000 });
      }
      if (location.hash.indexOf('welcome') > -1 || how === 'skip') App.navigate('#/triage');
    });
  }

  /* ---------- The later tips, each said once, when it first fits ---------- */
  var LATER = {
    dictate: function () { return 'Hold ' + Dictate.key + ' to talk instead of type. Let go when you’re done.'; },
    park: 'Something else pop into your head? Press T to park it without leaving this card.',
    undo: 'Everything has Undo, up in the header, if that wasn’t what you meant.',
    checkin: 'Say how you’re doing, and I’ll change what comes next to match.',
    stale: 'Letting it go is a real outcome. You can always bring it back.',
    schedule: 'Pick a time in plain words, like “when I’m back at my desk”.',
    handover: function () { return 'When you’d rather do this one together, press C to work on it in ' + (Store.workIn || 'Claude') + '.'; },
    keys: 'Press ? any time for all the keys.',
    draft: 'Not quite right? Press R and tell me what to change. As often as you like.'
  };
  function tipLine(key) { var l = LATER[key]; return typeof l === 'function' ? l() : l; }
  /* The line for a tip if it hasn't been said, marking it said. During the onboarding only dictation
     is taught (on the New task screen); people who set up before it existed aren't taught at all. */
  function tip(key, peek) {
    if (!st || !LATER[key] || st.tips.indexOf(key) > -1 || (key !== 'undo' && Date.now() < quietUntil)) return null;
    if (!st.done && !(key === 'dictate' && active())) return null;
    if (peek) return tipLine(key);   /* said later, if the moment holds: tip(key) then marks it */
    st.tips.push(key);
    save({ tips: [key] });
    return tipLine(key);
  }

  /* ---------- Setup cards, after the onboarding, one at a time, after real work ---------- */
  /* Fuzz's first question, waiting in Triage while he reads up on your task: when you work. One key
     answers it, which makes it an easy first card. Skipping keeps the usual hours. */
  var hoursSkipped = false;
  function hoursQuestion() {
    return !!(st && Live.on() && active() && st.step === 'question' && !st.hours_set && !hoursSkipped);
  }
  function answerHours(body) {
    return Live.saveHours(body).then(function (h) { hours = h; st.hours = h; st.hours_set = true; return h; });
  }

  /* peek: whether one would show, without using up this visit's one */
  function setupCard(cleared, peek) {
    if (hoursQuestion()) return { name: 'hours', hours: hours || st.hours || { hours: [8, 18.5], weekends: false } };
    if (setupShown || !st || !st.done || cleared < 1) return null;
    var c = st.setup_card;
    if (!c) return null;
    /* The theme card has nothing to offer someone who already picked one */
    if (c.name === 'theme' && App.prefs().theme !== 'terracotta') { answerSetup('theme', 'yes'); return null; }
    if (c.name === 'lookup' && !Live.on()) return null;
    if (peek) return c;
    setupShown = true;
    return c;
  }
  function answerSetup(name, answer) {
    if (!Live.on()) { st.setup[name] = { status: answer === 'yes' ? 'answered' : 'later' }; st.setup_card = null; saveLocal(); return Promise.resolve(st); }
    return Live.answerSetup(name, answer).then(function (r) { st = r; return r; });
  }

  /* ---------- Events ---------- */
  function onClick(e) {
    var b = e.target.closest('button, a'); if (!b || !root) return;
    if (b.dataset.app) { pickApp(b.dataset.app); return; }
    var a = b.dataset.onb; if (!a) return;
    if (a === 'retry') return setUp(chosen, true);
    if (a === 'recheck') { apps = null; appState = {}; return loadApps(); }
    if (a === 'demo') { Live.useDemo(); location.hash = '#/welcome'; try { localStorage.setItem(LOCAL, JSON.stringify(Object.assign(blank(), { step: 'capture' }))); } catch (x) {} location.reload(); return; }
    if (a === 'skip') return finish('skip');
    if (a === 'hello') return save({ step: needsForm() ? 'form' : 'how' }).then(paint);
    if (a === 'show') return showCard();
    if (a === 'howdone') return save({ step: afterForm() }).then(paint);   /* Fuzz's question in Triage, or a task */
    if (a === 'ics') return downloadIcs();
  }
  function onSubmit(e) { if (e.target.id === 'onb-form') { e.preventDefault(); submitForm(); } }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'onb-name') formName = t.value;
  }
  /* Enter on the ready screen from anywhere on the page */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !root || e.defaultPrevented) return;
    var go = root.querySelector('#onb-show, [data-onb="hello"], [data-onb="howdone"]'); if (!go) return;   /* Open Triage, Got it, Nice to meet you */
    var t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(t.tagName)) return;
    e.preventDefault(); go.click();
  });

  /* ---------- Hooks for the rest of the app ---------- */
  window.Onboard = {
    view: V,
    /* At boot: resume where you left off. Returns the hash to open, or null to carry on as usual. */
    start: function () {
      return load().then(function () {
        Store.on(watchCard);
        if (!active()) { chrome('done'); return null; }
        calm(true); chrome(st.step);
        if (st.step === 'question') return '#/triage';
        if (st.step === 'card') { var it = taskItem(); if (it && Store.inQueue(it.id)) { Store.pick(it.id); return '#/triage'; } st.step = 'wait'; }
        return '#/welcome';
      }, function () { chrome('done'); return null; });
    },
    active: active,
    /* N is the way into New task, except on the form, where it would skip what Fuzz needs */
    blocksCapture: function () { return active() && ['intro', 'form', 'how', 'question'].indexOf(st.step) > -1; },
    /* On New task during the onboarding: the dictation tip, and Esc leads back here */
    onCapture: function () {
      var can = window.Dictate && Dictate.supported;   /* a tip for something this browser can't do isn't said */
      if (active() && st.step === 'capture') { return { tip: can ? tip('dictate') || tipLine('dictate') : null, back: '#/welcome' }; }
      var t = can && tip('dictate');
      return t ? { tip: t } : null;
    },
    /* The task you captured during the onboarding goes to the wait */
    captured: function (it) {
      if (!active() || st.step !== 'capture') return false;
      pendingItem = it;
      save({ step: 'wait', task_id: it.coreId || null });
      App.navigate('#/welcome');
      return true;
    },
    guide: guide,
    skipGuide: function () { finish('skip'); },
    tip: tip,
    setupCard: setupCard,
    /* The hours question: whether it's waiting (Triage shows its dot), answering and skipping it */
    hasQuestion: hoursQuestion,
    answerHours: answerHours,
    skipHours: function () { hoursSkipped = true; },
    /* Answered (or skipped): Fuzz asks for one real task */
    questionDone: function () { return save({ step: 'capture' }).then(function () { App.navigate('#/welcome'); }); },
    clock: clock,
    hourSteps: HOURS,
    answerSetup: answerSetup,
    /* Settings > Show me around again: the intro and the tips, from the start */
    again: function () {
      setupShown = true;
      return save({ again: true }).then(function () { st.needed = true; calm(true); chrome('intro'); App.navigate('#/welcome'); if (location.hash === '#/welcome' && root) paint(); });
    },
    /* For tests */
    _ics: icsText
  };
})();
