/* Triage: one card at a time, Fuzz on the perch.
   Layout and information architecture come from the Triage Queue mockup; Fuzz's reactions come from
   the Fuzz Triage motion prototype. */
(function () {
  var V = {};
  var ABORT = {};
  /* Check-ins come often at first, then back off. The first comes after 2 cleared cards; each later one
     waits for at least 2 more cleared cards and a stretch of time that doubles: 5, 10, 20 minutes… */
  var CI_FIRST = 2, CI_GAP_MIN = 5;
  /* The Fuzz mood lab is a design tool, not part of the product: open the app with ?lab to get it. */
  var LAB = /[?&]lab(=|&|$)/.test(location.search);
  var esc = UI.esc;

  var root, card, stack, stage, alive = false, busy = false, epoch = 0, unsub = null;
  var ciOpen = false, ciBusy = false, ciTimer = 0, ciSecs = 300, ciDemo = false;
  /* Your answer and follow-up, kept by the core (Store.checkin; POST /checkin) once the check-in closes */
  var ciAnswer = null, ciFollow = null;
  var CI_ANSWER = { good: 'good', okay: 'okay', tired: 'tired', over: 'overloaded' };
  var ciCount = 0, ciNextAt = CI_FIRST, ciLastAt = 0, sessionAt = Date.now();
  var lastTask = null, streak = 0, rushTimer = 0, ambientTimer = 0;
  var scheduling = false, schedMore = false, tab = null, keptStale = {}, edits = {}, greeted = false, awayOpen = false;
  var docClick = null, docKey = null, booting = false, offSay = null, onScroll = null, echoTimer = 0, scrollHold = 0;

  function $(s) { return root.querySelector(s); }
  function cur() { return Store.front(); }

  /* ---------- Time helpers (principle 10: time is human) ---------- */
  function mins(t) { return (t.dueAt - Date.now()) / 60000; }
  function tierOf(m) { return m < 30 ? 3 : (m < 120 ? 2 : 1); }
  /* Rough, human amounts of time. Nothing ticks down in seconds at you (principle 11). */
  function fmtDue(m) {
    if (m >= 180) return 'about ' + Math.round(m / 60) + ' hours';
    if (m >= 120) return 'under 3 hours';
    if (m >= 60) return 'under 2 hours';
    if (m >= 30) return 'under an hour';
    if (m >= 10) return 'about ' + Math.round(m / 5) * 5 + ' minutes';
    return 'a few minutes';
  }
  /* Fuzz's screen shows whole minutes: it changes once a minute, not every second. */
  function fmtOsd(m) {
    if (m <= 0) return '0m';
    if (m >= 60) return Math.floor(m / 60) + 'h' + ('0' + Math.floor(m % 60)).slice(-2);
    return Math.ceil(m) + 'm';
  }

  /* ---------- Lifecycle ---------- */
  function sleep(ms) {
    var e = epoch;
    return new Promise(function (res, rej) {
      setTimeout(function () { (alive && e === epoch) ? res() : rej(ABORT); }, Fuzz.isCalm() ? ms * 0.6 : ms);
    });
  }
  function lock(on) {
    busy = on;
    if (!root) return;
    root.querySelectorAll('[data-act],[data-demo],[data-quick]').forEach(function (b) { b.disabled = on || (ciOpen && !!b.dataset.act); });
  }
  /* A moment holds the buttons only until the next card is on screen (release, from bringNext). Fuzz's
     reaction to the last card plays on, and stops the moment you act on the new one: starting a moment
     bumps the epoch, so the old moment's next sleep aborts. */
  var momentTok = 0;
  async function moment(fn) {
    if (busy || !alive) return;
    var mine = ++momentTok; epoch++;
    lock(true);
    try { await fn(); } catch (err) { if (err !== ABORT) console.error(err); }
    finally { if (alive && mine === momentTok) lock(false); }
  }
  function release() { if (busy) lock(false); }

  V.mount = function (container) {
    alive = true; busy = false; epoch++; ciOpen = false; ciBusy = false; awayOpen = false; scheduling = false; tab = null; streak = 0;
    root = container;
    root.innerHTML = layout();
    card = $('#card'); stack = $('#stack'); stage = $('#stage');
    Fuzz.mount(root, { isBusy: function () { return busy; } });
    wire();
    unsub = Store.on(onStore);
    Say.setBusyCheck(function () { return busy || ciOpen; });
    ambientTimer = setInterval(ambient, 45000);
    V.tickTimer = setInterval(function () { var t = cur(); if (t && t.dueAt && card.style.display !== 'none' && !ciOpen) paintDue(t); }, 1000);
    stats();
    if (!greeted) { greeted = true; greet(); showAway(); return; }
    Fuzz.say('Back to the queue.', { type: false });
    booting = true; showNext(); booting = false;
    /* The router focuses the heading on arrival unless something on the page already has focus */
    var l = landing(); if (l && l.tagName === 'TEXTAREA') { l.focus({ preventScroll: true }); l.selectionStart = l.selectionEnd = l.value.length; }
  };
  V.unmount = function () {
    alive = false; epoch++;
    clearTimeout(rushTimer); clearInterval(ciTimer); clearInterval(ambientTimer); clearInterval(V.tickTimer);
    if (unsub) unsub(); unsub = null;
    Say.setBusyCheck(null);
    if (docClick) document.removeEventListener('click', docClick); docClick = null;
    if (docKey) document.removeEventListener('keydown', docKey); docKey = null;
    if (offSay) offSay(); offSay = null; clearTimeout(echoTimer);
    if (onScroll) window.removeEventListener('scroll', onScroll); onScroll = null;
    Fuzz.unmount(); root = null;
  };
  V.hardReset = function () { keptStale = {}; edits = {}; ciCount = 0; ciNextAt = CI_FIRST; ciLastAt = 0; sessionAt = Date.now(); lastTask = null; greeted = false; };
  V.refresh = function () {
    if (!alive) return;
    epoch++; busy = false; ciOpen = false; ciBusy = false; scheduling = false; clearInterval(ciTimer); clearTimeout(rushTimer);
    if (awayOpen) { awayOpen = false; $('#away').hidden = true; }
    lock(false); stats(); showNext();
  };

  function greet() {
    var h = new Date().getHours(), g;
    if (h < 5 || h >= 21) g = 'Still up? Late-night programming it is.';
    else if (h < 12) g = 'Morning! Warming up the tubes…';
    else if (h < 17) g = 'Afternoon. Let’s clear a few.';
    else g = 'Evening. Quick pass?';
    Fuzz.say(g);
  }

  /* A light, rare note while Fuzz works in the background. Presence, not nagging (principle 14). */
  function ambient() {
    if (!alive || busy || ciOpen) return;
    var w = Store.inState('ai');
    if (!w.length || ['idle'].indexOf(Fuzz.mood()) < 0) return;
    Fuzz.say('Working on “' + w[Math.floor(Math.random() * w.length)].title + '” in the background.', { type: false });
  }

  function onStore(e) {
    if (!alive) return;
    if (e.type === 'handback') {
      stats(); updateStack(true);
      /* No announcement: the handback waits as its own card at the back of the queue. */
      if (card.style.display === 'none' && !ciOpen && !awayOpen) showNext();
    } else if (e.type === 'review') {
      /* A finished draft arrives as its own card at the back of the queue, with no announcement. */
      stats(); updateStack(true);
      if (card.style.display === 'none' && !ciOpen && !awayOpen) showNext();
    } else if (e.type === 'capture') {
      stats(); updateStack(true);
      if (card.style.display === 'none' && !ciOpen && !awayOpen) showNext();
    } else if (e.type === 'work') {
      stats();
      if (card.style.display === 'none' && !ciOpen && !awayOpen) renderEmpty();
    } else if (e.type === 'wrapped') {
      /* The last task in a group finished, so the group is finished too. Worth a small party. */
      Fuzz.setMood('proud'); Fuzz.pAnim('hop'); Fuzz.confetti(card.style.display === 'none' ? stack : card);
      Say.tell('That wraps up ' + e.group.title + '. Every task in it is done.');
      setTimeout(function () { if (alive && Fuzz.mood() === 'proud') Fuzz.setMood('idle'); }, 2600);
    } else if (e.type === 'reset' || e.type === 'restore' || e.type === 'moment') {
      /* the caller refreshes */
    }
  }

  /* The key guide (press ? on Triage). Letters act on a task card; numbers pick from whatever choice is showing. */
  function keysHTML() {
    var g = [
      ['On a task card', [['A', 'Assign to Fuzz'], ['C', 'Work in Claude'], ['S', 'Schedule (M for more times)'], ['D', 'Done'], ['P', 'Park it'], ['W', 'Waiting on someone']]],
      ['On a draft', [['R', 'Ask Fuzz to change it'], ['L', 'Not now'], ['D', 'Mark done (you send it yourself)']]],
      ['Choices on screen', [['1 – 9', 'Pick an answer, a time or a mood'], ['K', 'Keep a stale card'], ['L', 'Let a stale card go'], ['Esc', 'Leave the text box, back out, close a menu, or skip a check-in']]],
      ['Anywhere', [['N', 'New task (Esc goes back)'], ['T', 'Park a stray thought (Esc closes it)'], ['?', 'This list']]]
    ];
    return g.map(function (s) { return '<section><h3>' + s[0] + '</h3><dl class="keylist">' + s[1].map(function (k) { return '<div><dt><kbd>' + k[0] + '</kbd></dt><dd>' + k[1] + '</dd></div>'; }).join('') + '</dl></section>'; }).join('') +
      '<p class="meta">A card without a draft starts with the cursor in its text box. Press Esc first to use the letter and number keys.</p>' +
      '<p class="meta">Send is never on a single key, so nothing goes out by accident.</p>';
  }

  /* ---------- Layout ---------- */
  function layout() {
    var moods = [['good', 'Good'], ['okay', 'Okay'], ['tired', 'Tired'], ['over', 'Overloaded']];
    var moodBtns = moods.map(function (m, i) { return '<button class="mood" data-pick="' + (m[0] === 'over' ? 'over' : m[0]) + '" aria-pressed="false" aria-keyshortcuts="' + (i + 1) + '">' + Fuzz.mini(m[0], { cls: 'fz' }) + '<span>' + m[1] + kbd(i + 1) + '</span></button>'; }).join('');
    return '' +
    '<section class="triage" aria-labelledby="triage-h">' +
      '<div class="triage-top">' +
        '<h1 id="triage-h" class="sr">Triage</h1>' +
      '</div>' +
      '<section class="stage" id="stage">' +
        '<div class="fx" id="fx"></div>' +
        /* Fuzz and his bubble are for looking at. Screen readers hear outcomes from Say.announce instead of every quip. */
        '<div class="perch" id="perch"><div class="pwrap" id="pwrap" aria-hidden="true">' + window.FUZZ_SVG + '</div><div class="bubble" id="bubble"></div></div>' +
        '<div class="echo" id="echo" aria-hidden="true" hidden>' + Fuzz.mini('good', { cls: 'echo-av' }) + '<span id="echo-t"></span></div>' +
        '<div class="stack" id="stack">' +
          '<article class="card" id="card"></article>' +
          /* Coming back: what moved while you were gone, before the first card (principle 12) */
          '<article class="card away" id="away" hidden><div class="tagrow"><span class="src">While you were away</span></div>' +
            '<h2 id="away-h" tabindex="-1">Here’s where things stand</h2><ul class="away-list" id="away-list"></ul>' +
            '<button type="button" class="btn primary" id="away-go" aria-keyshortcuts="Enter">Start with the first card' + kbd('Enter') + '</button></article>' +
          '<article class="card checkin" id="checkin" hidden>' +
            '<div class="tagrow"><span class="src">Quick pause</span></div>' +
            '<h2 id="ci-h" tabindex="-1">How are you doing?</h2><p class="meta">Totally optional. It takes about five seconds.</p>' +
            '<div class="moods" id="ci-moods" role="group" aria-label="How are you doing?">' + moodBtns + '</div>' +
            '<div class="ci-follow" id="ci-follow"></div>' +
            '<div class="ci-break" id="ci-break" hidden><div class="breath" aria-hidden="true"></div><p class="ci-time" id="ci-time">5:00</p><p class="meta">Fuzz has the queue. Step away for a bit.</p><button class="btn primary" data-ci="back">I’m back</button></div>' +
            '<div class="ci-foot"><button type="button" class="linkbtn" data-ci="skip" id="ci-skip" aria-keyshortcuts="Escape">Skip' + kbd('Esc') + '</button></div>' +
          '</article>' +
        '</div>' +
      '</section>' +
      '<div class="triage-foot"><button type="button" class="linkbtn" id="dropbtn"></button><span aria-hidden="true">·</span><button type="button" class="linkbtn" id="parkbtn" aria-expanded="false" aria-controls="parkform" aria-keyshortcuts="T">Park a stray thought' + kbd('T') + '</button><span class="keys-sep" aria-hidden="true">·</span><button type="button" class="linkbtn keys-link" id="keysbtn" aria-keyshortcuts="?">Keys</button></div>' +
      '<dialog class="dlg keys-dlg" id="keysdlg" aria-labelledby="keys-h"><div class="dlg-in"><div class="dlg-top"><h2 id="keys-h">Keys</h2><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' + keysHTML() + '</div></dialog>' +
      '<form class="parkform" id="parkform" hidden><label for="parktext">Park it without leaving this card</label><div class="parkrow"><input id="parktext" type="text" autocomplete="off" placeholder="A stray thought, in a few words"><button class="btn" type="submit">Park</button></div></form>' +
      (LAB ? '<details class="playground"><summary>Fuzz mood lab <span>for refining the character</span></summary><div class="lab">' +
        '<div class="lab-row" role="group" aria-label="Moods">' + [['Idle', 'idle'], ['Eager', 'eager'], ['Thinking', 'thinking'], ['Working', 'working'], ['Happy', 'happy'], ['Proud', 'proud'], ['Grateful', 'grateful'], ['Sheepish', 'sheepish'], ['Puzzled', 'puzzled'], ['Worried', 'worried'], ['Bored', 'bored'], ['Sleepy', 'sleepy'], ['Caring', 'caring'], ['Stare', 'stare'], ['Screen off', 'chill']].map(function (m) { return '<button type="button" class="btn small" data-demo="mood" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<div class="lab-row" role="group" aria-label="Deadline levels">' + [['Due today', 1], ['Under 2 hours', 2], ['Under 30 min', 3]].map(function (m) { return '<button type="button" class="btn small" data-demo="rush" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<div class="lab-row" role="group" aria-label="Reactions">' + [['Hop', 'p:hop'], ['Spin', 'p:spin'], ['Bow', 'p:bow'], ['Wiggle', 'p:wiggle'], ['Wink', 'f:wink'], ['Stars', 'f:star'], ['Tip hat', 'f:tip'], ['Scan', 'f:scan'], ['Rev up', 'f:rev'], ['Dance', 'f:dance'], ['Confetti', 'confetti'], ['Hearts', 'hearts'], ['Check-in', 'checkin']].map(function (m) { return '<button type="button" class="btn small" data-demo="fx" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<div class="lab-row" role="group" aria-label="Speech">' + [['Short quip', 'short']].map(function (m) { return '<button type="button" class="btn small" data-demo="say" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<p class="note">Tap Fuzz for a boop, tug an antenna, or twist a knob. Calm mode (in Settings) removes flashes and gags.</p>' +
      '</div></details>' : '') +
    '</section>';
  }

  /* ---------- Stats, stack ---------- */
  function stats() {
    if (!root) return;
    var st = Store.get(), left = st.queue.length, cleared = Math.max(st.totalEver - left, 0);
    Progress.render(cleared, cleared + left);
    /* count what's cleared, never what's left */
    document.getElementById('left').textContent = left === 0 ? 'All clear' : cleared ? '✓ ' + cleared : 'Ready';
  }
  function updateStack(arriveLast) {
    stack.querySelectorAll('.ghost, .stacktags').forEach(function (g) { g.remove(); });
    var q = Store.queue(), n = Math.min(Math.max(q.length - 1, 0), 3);
    /* labels for the cards underneath sit above the whole stack, so the front card never covers them */
    var tags = document.createElement('div'); tags.className = 'stacktags'; tags.setAttribute('aria-hidden', 'true');
    for (var i = n; i >= 1; i--) {
      var g = document.createElement('div'); g.className = 'ghost';
      g.style.transform = 'translateY(-' + (i * 9) + 'px) scale(' + (1 - i * 0.035) + ')';
      var item = q[i];
      if (item && item.handedBack) { var t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Handed back'; tags.appendChild(t); }
      else if (item && item.dueAt) { var t2 = document.createElement('span'); t2.className = 'tag due t2'; t2.textContent = 'Due soon'; tags.appendChild(t2); }
      if (arriveLast && i === n && q.length - 1 <= 3) g.classList.add('arrive');
      stack.insertBefore(g, card);
    }
    if (tags.children.length) stack.insertBefore(tags, card);
    /* The tags are visual; screen readers get one sentence about what is behind this card */
    var behind = q.slice(1), back = behind.filter(function (i) { return i.handedBack; }).length, due = behind.filter(function (i) { return i.dueAt; }).length;
    var sr = stack.querySelector('#stack-sr') || stack.insertBefore(Object.assign(document.createElement('p'), { id: 'stack-sr', className: 'sr' }), stack.firstChild);
    sr.textContent = behind.length ? behind.length + ' more after this' + (due ? ', ' + due + ' with a deadline' : '') + (back ? ', ' + back + ' handed back' : '') + '.' : '';
  }

  /* ---------- The card ---------- */
  function ageChip(it) {
    var m = { fresh: ['Fresh', 1, 'ok'], settling: ['Aging', 2, 'warn'], stale: ['Sitting', 3, 'muted'] }[it.stage || 'fresh'];
    return '<span class="agechip agechip--' + m[2] + '"><span class="segs" aria-hidden="true">' + [1, 2, 3].map(function (n) { return '<i class="' + (n <= m[1] ? 'on' : '') + '"></i>'; }).join('') + '</span>' + m[0] + ' · ' + esc(it.age || 'today') + '</span>';
  }
  function duePanel(it) {
    if (!it.due) return '';
    var d = it.due, tone = d.frac < 0.25 ? 'tight' : d.frac < 0.5 ? 'mid' : 'ok';
    return '<div class="duebox"><div class="duebox-top"><strong>' + esc(d.label) + '</strong><span class="due-' + tone + '">' + esc(d.left) + '</span></div><div class="dbar" aria-hidden="true"><div class="dbar-fill due-' + tone + '" style="width:' + Math.round(d.frac * 100) + '%"></div></div></div>';
  }
  /* The Schedule options are the core's (card.schedule_options; Store.scheduleOptions in this demo):
     moments the AI found come first, then times that fit how long is left. The panel only draws them. */
  function schedOpts(it) { return Store.scheduleOptions(it).filter(function (o) { return o.anchor.type !== 'exact'; }); }
  /* The visible key hint. Screen readers get aria-keyshortcuts on the button instead. */
  function kbd(k) { return '<kbd aria-hidden="true">' + k + '</kbd>'; }
  function actionsHTML(it) {
    if (scheduling) {
      /* Three likely times first. The rest, and an exact time, wait behind More times. */
      var all = schedOpts(it), opts = schedMore ? all : all.slice(0, 3);
      var tiles = opts.map(function (o, n) { return '<button type="button" class="when" data-when="' + n + '" aria-keyshortcuts="' + (n + 1) + '"><span>' + esc(o.label) + kbd(n + 1) + '</span><small>' + esc(Sched.hint(o)) + '</small></button>'; });
      if (!schedMore) tiles.push('<button type="button" class="when when-more" data-sched="more" aria-keyshortcuts="M"><span>More times' + kbd('M') + '</span><small>' + (all.length > 3 ? 'Later options, or an exact time' : 'Or an exact time') + '</small></button>');
      var meta = it.state === 'review' ? 'Pick a rough time. The draft waits, unsent, and comes back then for your OK.'
        : 'Pick a rough time. Fuzz finds the right moment around your day. Anything you wrote in the instructions, Fuzz looks into before it comes back.';
      return '<div class="sched-panel"><h3 id="sched-h" tabindex="-1">When should this come back?</h3><p class="meta">' + meta + '</p>' +
        '<div class="when-grid">' + tiles.join('') + '</div>' +
        (schedMore ? '<div class="exact" id="exact" hidden><label for="exact-dt">Exact time</label><input type="datetime-local" id="exact-dt"><button type="button" class="btn small primary" data-sched="exact-go">Schedule for this time</button></div>' : '') +
        '<div class="sched-links">' + (schedMore ? '<button type="button" class="linkbtn" data-sched="exact">Pick an exact time instead</button>' : '') + '<button type="button" class="linkbtn" data-sched="cancel" aria-keyshortcuts="Escape">Back to the card</button></div></div>';
    }
    if (it.state === 'review') return reviewActionsHTML(it);
    /* A result: what Fuzz found is the thing you asked for, so Done leads and Assign is the way to send him further */
    var res = !!it.result;
    var assignBtn = '<button type="button" class="btn' + (res ? '' : ' primary') + '" data-act="assign" aria-keyshortcuts="A"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' + (res ? 'Send Fuzz further' : 'Assign to Fuzz') + kbd('A') + '</button>';
    return '<div class="actions' + (res ? ' result' : '') + '">' + (res ? '' : assignBtn) +
      (res ? '' : '<button type="button" class="btn" data-act="claude" aria-keyshortcuts="C">Work in Claude' + kbd('C') + '</button>') +
      (res ? '' : '<button type="button" class="btn" data-act="schedule" aria-keyshortcuts="S"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Schedule' + kbd('S') + '</button>') +
      '<div class="split"><button type="button" class="btn done-btn' + (res ? ' primary' : '') + '" data-act="done" aria-keyshortcuts="D"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Done' + kbd('D') + '</button>' +
        '<button type="button" class="btn more-btn" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="Clear it another way" title="Clear it another way"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="menu" role="menu" id="moremenu" hidden aria-label="Clear it another way"><p class="menu-h" aria-hidden="true">Clear it another way</p>' +
          '<button type="button" role="menuitem" data-act="park" aria-keyshortcuts="P"><b>Park it' + kbd('P') + '</b><span>Out of triage with no date. It waits in Parked until you bring it back.</span></button>' +
          '<button type="button" role="menuitem" data-act="waiting" aria-keyshortcuts="W"><b>Waiting on someone' + kbd('W') + '</b><span>Moves to Waiting on others. Fuzz watches for the reply.</span></button>' +
        '</div></div>' + (res ? assignBtn : '') + '</div>';
  }

  function richAvail(it) {
    var a = [];
    if (it.conversation.length) a.push(['conversation', 'Conversation', it.conversation.length]);
    if (it.contextMd) a.push(['context', 'Context', null]);
    else if (it.context.length) a.push(['context', 'Context', it.context.length]);
    if (it.code && it.code.length) a.push(['code', 'Code', it.code.length]);
    if (it.log.length) a.push(['done', 'Done so far', it.log.length]);
    if (it.sources.length) a.push(['sources', 'Sources', it.sources.length]);
    return a;
  }
  function richHTML(it) {
    var avail = richAvail(it);
    if (!avail.length) return '';
    var t = avail.some(function (a) { return a[0] === tab; }) ? tab : avail[0][0];
    var tabs = avail.map(function (a) { var on = a[0] === t; return '<button type="button" role="tab" class="tabbtn" id="tab-' + a[0] + '" data-tab="' + a[0] + '" aria-selected="' + on + '" aria-controls="tabpanel" tabindex="' + (on ? 0 : -1) + '">' + a[1] + (a[2] == null ? '' : '<span>' + a[2] + '</span>') + '</button>'; }).join('');
    var body = '';
    if (t === 'conversation') body = '<ol class="convo">' + it.conversation.map(function (m) { var you = m.who === 'You'; return '<li class="' + (you ? 'you' : 'fuzz') + '"><span class="who">' + (you ? '' : Fuzz.mini('good', { cls: 'who-av' })) + esc(m.who) + ' · <span>' + esc(m.time) + '</span></span><span class="bub">' + esc(m.text) + '</span></li>'; }).join('') + '</ol>';
    else if (t === 'context' && it.contextMd) body = '<div class="md">' + UI.md(it.contextMd) + '</div>';
    else if (t === 'context') body = '<ul class="ctx">' + it.context.map(function (c) { return '<li><i aria-hidden="true"></i><span>' + esc(c) + '</span></li>'; }).join('') + '</ul>';
    else if (t === 'code') body = CodeView.section(it.code, 'card:' + it.id);
    else if (t === 'done') body = UI.logHTML(it.log);
    else body = UI.sourcesHTML(it.sources);
    return '<div class="tabs" role="tablist" aria-label="More about this task">' + tabs + '</div><div class="tabbody" id="tabpanel" role="tabpanel" aria-labelledby="tab-' + t + '" tabindex="0">' + body + '</div>';
  }

  function showTab(name) {
    tab = name; $('#rich').innerHTML = richHTML(cur());
    var tb = $('#tab-' + name); if (tb) tb.focus();
  }

  function tagrow(it, extra) {
    var tags = extra || '';
    if (it.handedBack) tags += '<span class="tag">Handed back</span>';
    if (it.updated) tags += '<span class="tag">Updated</span>';
    if (it.kind === 'dup') tags += '<span class="tag tag--info">Possible duplicate</span>';
    if (it.isNew) tags += '<span class="tag tag--ok">Just captured</span>';
    tags += '<span class="tag due" id="duetag" hidden></span>';
    return '<div class="tagrow"><span class="src">' + esc(it.source + (it.who ? ' · ' + it.who : '')) + '</span>' + tags + '</div>';
  }
  /* The question leads the card. "The one thing to decide" stays for screen readers only. */
  function askHTML(text) {
    return '<h2 class="ask" id="ask" tabindex="-1"><span class="sr">The one thing to decide: </span>' + esc(text) + '</h2>';
  }
  function titleHTML(it) {
    return '<div class="title-block"><h3 class="task-title">' + esc(it.title) + '</h3><div class="chips">' + ageChip(it) + '<span class="meta">' + esc(it.meta || '') + '</span></div>' + partOfHTML(it) + '</div>';
  }
  /* A group is context on the card, never a card of its own: one line, which opens the group sheet */
  function partOfHTML(it) {
    var line = Store.partOf(it, true); if (!line) return '';
    return '<button type="button" class="partof" data-act="group"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/></svg>' + esc(line) + '</button>';
  }
  function findingHTML(it) {
    return '<div class="finding"><span class="finding-tag">' + esc(it.aiHeading || 'What Fuzz did') + '</span>' + Fuzz.mini('good', { cls: 'finding-av' }) + '<p>' + UI.text(it.aiNote) + '</p></div>';
  }
  /* shownAbove: the finding already sits above the instructions, so it isn't repeated here */
  function contextHTML(it, isTask, shownAbove, rich) {
    var h = '';
    var last = it.log.filter(function (l) { return !l.undone && !l.undo; })[0];
    if (isTask && (it.handedBack || it.updated || it.log.length >= 3) && last) {
      h += '<p class="leftoff"><strong>Where you left off.</strong> ' + esc(last.text) + '</p>';
    }
    if (it.aiNote && !shownAbove) h += '<section class="ainote"><h3>' + esc(it.aiHeading || 'What Fuzz did') + '</h3><p>' + UI.text(it.aiNote) + '</p></section>';
    if (isTask && it.firstStep) h += '<section class="firststep"><h3>Smallest first step · two minutes</h3><p>' + esc(it.firstStep) + '</p></section>';
    if (it.effect) h += '<section class="effect"><h3>What this changes</h3><p>' + esc(it.effect) + '</p></section>';
    if (isTask || rich) h += '<section id="rich" class="rich">' + richHTML(it) + '</section>';
    return h;
  }
  function evidenceHTML(it) {
    var h = '';
    if (it.kind === 'entity' && it.entity === 'person') {
      h += '<div class="profiles">' + it.profiles.map(function (p) { return '<div class="profile"><span class="plabel">' + esc(p.where) + '</span><span class="pname">' + esc(p.name) + '</span><span class="pdetail">' + esc(p.detail) + '</span><span class="pseen">' + esc(p.seen) + '</span></div>'; }).join('') + '</div>';
    }
    if (it.kind === 'entity' && it.entity === 'term') {
      h += '<ul class="mentions">' + it.mentions.map(function (m) { return '<li><span class="pill pill--muted">' + esc(m.where) + '</span><span>' + esc(m.text) + '</span></li>'; }).join('') + '</ul>';
    }
    /* Is it yours? shows what was actually said, and by whom, before you answer */
    if (it.kind === 'entity' && it.entity === 'is_task') {
      var said = it.sources.filter(function (s) { return s.quote; });
      if (said.length) h += '<ul class="mentions">' + said.map(function (s) { return '<li><span class="pill pill--muted">' + esc(s.title || s.type) + '</span><span>' + esc(s.quote) + '</span></li>'; }).join('') + '</ul>';
    }
    if (it.kind === 'dup') {
      var o = Store.item(it.dupOf);
      h += '<div class="profiles"><div class="profile"><span class="plabel">Already in your queue</span><span class="pname">' + esc(o ? o.title : '') + '</span><span class="pdetail">' + esc(o ? o.source + ' · ' + o.who : '') + '</span><span class="pseen">' + esc(o ? o.age + ' old' : '') + '</span></div>' +
        '<div class="profile"><span class="plabel">New just now</span><span class="pname">' + esc(it.title) + '</span><span class="pdetail">' + esc(it.source + ' · ' + it.who) + '</span><span class="pseen">' + esc(it.age) + ' old</span></div></div>';
    }
    return h;
  }

  /* Reading order: the question, what it's about, then how to act on it, then the background.
     Entity and duplicate cards put their evidence before the answers, so you see it before choosing. */
  function cardHTML(it) {
    if (it.state === 'review') return reviewHTML(it);
    var isTask = it.kind === 'task';
    var stale = isTask && it.stage === 'stale' && !keptStale[it.id] && !scheduling;
    var h = tagrow(it) + askHTML(it.ask) + titleHTML(it) + duePanel(it);
    /* What Fuzz found comes before what you tell him to do, so you edit with the answer in view */
    if (isTask && !stale && it.aiNote) h += findingHTML(it);
    if (it.handedBack && it.quick && it.quick.length) {
      h += '<div class="quick" role="group" aria-label="Quick answers">' + it.quick.map(function (q, i) { return '<button type="button" class="chip" data-quick="' + i + '" aria-keyshortcuts="' + (i + 1) + '">' + esc(q.label || q) + kbd(i + 1) + '</button>'; }).join('') + '</div>';
    }

    if (stale) {
      /* One decision at a time: the usual actions wait until you say you still care. */
      h += '<section class="stale"><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg><div><h3>Quiet for ' + esc(it.age) + '</h3><p>Nothing new has come up. Letting it go is fine. It moves to Let go, where you can bring it back anytime.</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn" data-act="keep" aria-keyshortcuts="K">Yes, keep it' + kbd('K') + '</button><button type="button" class="btn dark" data-act="letgo" aria-keyshortcuts="L">Let it go' + kbd('L') + '</button></div></section>';
    } else if (isTask) {
      var val = edits[it.id + ':instr'] !== undefined ? edits[it.id + ':instr'] : (it.instr || it.hint || '');
      h += '<div class="instr"><div class="instr-top"><label for="instr">Instructions for Fuzz</label><span>Suggested by Fuzz. Edit anything.</span></div><textarea id="instr" rows="3">' + esc(val) + '</textarea></div>';
      h += '<div id="actions">' + actionsHTML(it) + '</div>';
    } else {
      h += '<p class="incoming">' + UI.text(it.incoming) + '</p>' + evidenceHTML(it);
      h += '<div class="instr"><div class="instr-top"><label for="note">' + esc(it.boxLabel) + '</label><span>Optional. Edit anything.</span></div><textarea id="note" rows="2" placeholder="' + esc(it.placeholder || '') + '">' + esc(edits[it.id + ':note'] !== undefined ? edits[it.id + ':note'] : (it.hint || '')) + '</textarea></div>' +
        '<div class="actions ent"><button type="button" class="btn primary" data-act="ent-primary" aria-keyshortcuts="1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' + esc(it.primary) + kbd(1) + '</button>' +
        '<button type="button" class="btn" data-act="ent-secondary" aria-keyshortcuts="2">' + esc(it.secondary) + kbd(2) + '</button>' +
        (it.third ? '<button type="button" class="btn" data-act="ent-third" aria-keyshortcuts="3">' + esc(it.third) + kbd(3) + '</button>' : '') +
        '<button type="button" class="btn" data-act="ent-later" aria-keyshortcuts="' + (it.third ? 4 : 3) + '">Not sure yet' + kbd(it.third ? 4 : 3) + '</button></div>';
    }

    if (isTask) h += '<p class="incoming">' + UI.text(it.incoming) + '</p>';
    h += contextHTML(it, isTask, isTask && !stale, it.entity === 'is_task') + UI.idTag(it);
    h += '<div class="stamp" aria-hidden="true">DONE</div>';
    return h;
  }

  /* A draft Fuzz finished, waiting for your OK. Once you approve it, Fuzz sends exactly these words with
     its connected tools, so the card says what goes to whom, lets you change it first, and keeps Send off
     the single-letter keys. */
  function reviewHTML(it) {
    var r = Store.recipient(it), val = edits[it.id + ':draft'] !== undefined ? edits[it.id + ':draft'] : (it.draft || '');
    var h = tagrow(it, '<span class="tag tag--ok">Needs your OK</span>');
    h += askHTML(r ? 'Send this to ' + r.to + '?' : 'Does this look right?') + titleHTML(it);
    /* After "Ask Fuzz to change it", the draft says it was reworked and what you asked for */
    if (it.revisedNote) h += '<div class="finding"><span class="finding-tag">Updated from your note</span>' + Fuzz.mini('good', { cls: 'finding-av' }) + '<p>“' + esc(it.revisedNote) + '”</p></div>';
    h += '<section class="draft"><div class="draft-to">' + (r ? '<span>To</span> <strong>' + esc(r.to) + '</strong><span class="via">' + esc(r.via) + '</span>' : '<strong>Just for you</strong><span class="via">Nothing is sent anywhere</span>') + '</div>' +
      '<label class="sr" for="draft">' + (r ? 'Message to ' + esc(r.to) : 'Fuzz’s write-up') + '</label><textarea id="draft" rows="4">' + esc(val) + '</textarea></section>';
    h += '<div id="actions">' + actionsHTML(it) + '</div>';
    h += '<p class="incoming">' + UI.text(it.incoming) + '</p>' + contextHTML(it, true) + UI.idTag(it);
    h += '<div class="stamp" aria-hidden="true">OK</div>';
    return h;
  }
  /* Not now opens the Schedule picker in their place: the draft waits and asks again then */
  function reviewActionsHTML(it) {
    var r = Store.recipient(it);
    return '<div class="actions review">' +
      (r ? '<div class="split">' : '') +
      '<button type="button" class="btn primary' + (r ? ' done-btn' : '') + '" data-act="send"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (r ? '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>' : '<path d="M5 12.5l4.5 4.5L19 7.5"/>') + '</svg>' + (r ? 'Approve and send' : 'Looks good') + '</button>' +
      /* You'd rather send it yourself: the task is done and Fuzz never sends the draft */
      (r ? '<button type="button" class="btn primary more-btn" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="Finish it another way" title="Finish it another way"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="menu" role="menu" id="moremenu" hidden aria-label="Finish it another way">' +
          '<button type="button" role="menuitem" data-act="sentself" aria-keyshortcuts="D"><b>Mark done' + kbd('D') + '</b><span>You send it yourself. Fuzz won’t send this draft.</span></button>' +
        '</div></div>' : '') +
      '<button type="button" class="btn" data-act="revise" aria-expanded="false" aria-controls="revise" aria-keyshortcuts="R">Ask Fuzz to change it' + kbd('R') + '</button>' +
      '<button type="button" class="btn" data-act="notnow" aria-keyshortcuts="L">Not now' + kbd('L') + '</button></div>' +
      (r ? '<p class="sendnote">Fuzz sends exactly this once you approve. You can undo until it has gone out.</p>' : it.afterApprove ? '<p class="sendnote">' + esc(it.afterApprove) + '</p>' : '') +
      '<form class="revise" id="revise" hidden><label for="revise-text">Tell Fuzz what to change</label><div class="parkrow"><input id="revise-text" type="text" autocomplete="off" placeholder="For example: shorter, and mention the two maybes"><button class="btn" type="submit">Send back to Fuzz</button></div></form>';
  }

  /* Text boxes grow to show all their text, so nothing is cut off on a narrow screen */
  function fit(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px'; }
  function renderCard(it) {
    lastTask = it; $('#checkin').hidden = true;
    clearTimeout(rushTimer); card.getAnimations().forEach(function (a) { a.cancel(); });
    scheduling = false; if (tab && !richAvail(it).some(function (a) { return a[0] === tab; })) tab = null;
    card.className = 'card'; card.style.display = ''; card.style.visibility = '';
    card.innerHTML = cardHTML(it);
    var ex = stack.querySelector('.empty'); if (ex) ex.remove();
    var dt = $('#drop-label');
    $('#dropbtn').textContent = it.state === 'review' ? 'Discard this draft' : it.kind === 'task' ? 'Drop this task' : 'Dismiss this question';
    $('#dropbtn').hidden = false;
    paintDue(it);
    card.querySelectorAll('#instr, #draft').forEach(fit);
    if (busy) card.querySelectorAll('[data-act],[data-quick]').forEach(function (b) { b.disabled = true; });
  }

  function paintDue(t) {
    var dt = $('#duetag');
    if (!dt) return;
    if (!t || !t.dueAt) { dt.hidden = true; card.classList.remove('urgent'); return; }
    var m = mins(t), tr = tierOf(m);
    dt.hidden = false; dt.className = 'tag due t' + tr;
    dt.textContent = m <= 0 ? 'Past its time' : 'Due in ' + fmtDue(m);
    Fuzz.setOsd(fmtOsd(m));
    card.classList.toggle('urgent', tr >= 2);
    if (Fuzz.mood() === 'rushed') Fuzz.setUrgency(tr);
  }
  function rushLine(t) {
    var m = mins(t), tr = tierOf(m);
    if (m <= 0) return 'This one’s past its time. Assign me and I’ll start right now.';
    if (tr === 3) return 'Only ' + Math.max(1, Math.round(m)) + ' minutes! Assign me and I’ll start right now.';
    if (tr === 2) return 'Due in under 2 hours. Let’s move.';
    return 'Due later today. I’ll keep an eye on the clock.';
  }
  /* A rush lasts about five seconds, then Fuzz settles. He says it once: the due tag keeps the time,
     so nothing counts down at you (principle 11). */
  function rushBurst(t) {
    clearTimeout(rushTimer);
    if (!alive || cur() !== t || card.style.display === 'none' || ciOpen) return;
    /* You said you're tired or overloaded: the clock still matters, but Fuzz says so gently, with no flash. */
    var m = Store.get().moment;
    if (m === 'low' || m === 'quick') {
      Fuzz.setMood('caring');
      Fuzz.say('One with a deadline first, then ' + (m === 'low' ? 'gentle' : 'quick') + ' ones. I can take it if you like.', { type: false });
      return;
    }
    Fuzz.setMood('rushed'); Fuzz.setUrgency(tierOf(mins(t))); Fuzz.flash();
    Fuzz.say(rushLine(t), { type: false });
    rushTimer = setTimeout(function () {
      if (!alive || cur() !== t || card.style.display === 'none') return;
      if (Fuzz.mood() === 'rushed') { Fuzz.setMood('idle'); Fuzz.say('Ready when you are.', { type: false }); }
    }, 5000);
  }
  function settleSheepish() { setTimeout(function () { if (alive && Fuzz.mood() === 'sheepish') { Fuzz.setMood('idle'); Fuzz.setArm('none'); } }, 3500); }

  /* ---------- Showing the next card ---------- */
  function cleared() { var st = Store.get(); return Math.max(st.totalEver - st.queue.length, 0); }
  /* Never mid-rush: wait until the time-sensitive cards are handled. */
  function shouldCheckin(next) {
    var waited = !ciCount || Date.now() - ciLastAt >= CI_GAP_MIN * Math.pow(2, ciCount - 1) * 60000;
    return waited && cleared() >= ciNextAt && !Store.queue().some(function (i) { return i.dueAt; }) && !next.dueAt && !next.handedBack;
  }
  function ciDone() {
    if (ciAnswer && !ciDemo && ciFollow !== 'hold_rest') Store.checkin(ciAnswer, ciFollow);
    ciAnswer = null; ciFollow = null;
    if (ciDemo) { ciDemo = false; return; }
    ciCount++; ciNextAt = cleared() + 2; ciLastAt = Date.now();
  }
  /* When what had focus is gone (the card was replaced) or sits in the stack, carry focus to the new
     heading, so keyboard and screen reader users land on what to decide next. */
  /* A card with no draft starts with the cursor in its box, so you can type straight away. Touch
     screens keep the heading, or the keyboard would cover the card. */
  function landing() {
    var box = !$('#draft') && window.matchMedia && matchMedia('(pointer: fine)').matches && ($('#instr') || $('#note'));
    return box || $('#ask');
  }
  function forgetEdits(id) { ['instr', 'note', 'draft'].forEach(function (b) { delete edits[id + ':' + b]; }); }
  function refocus(el) {
    var a = document.activeElement;
    if (booting || !el || (a && a !== document.body && document.contains(a) && !stack.contains(a))) return;
    el.focus({ preventScroll: true });
    if (el.tagName === 'TEXTAREA') el.selectionStart = el.selectionEnd = el.value.length;
  }
  /* The bottom edge of the header: anything above it is out of view. */
  function topEdge() { var a = document.getElementById('appbar'); return a ? a.getBoundingClientRect().bottom : 0; }
  /* A new card starts at its question. If you had scrolled down the last one, bring the perch and the
     new card back into view (smoothly, unless Calm mode). */
  function toTop() {
    var y = stage.getBoundingClientRect().top - topEdge() - 8;
    if (booting || y >= 0) return;
    scrollHold = Date.now() + 700; hideEcho();
    window.scrollTo({ top: Math.max(0, window.scrollY + y), behavior: Fuzz.isCalm() ? 'auto' : 'smooth' });
  }
  /* When the perch is scrolled out of view, Fuzz's line also shows in a small bubble under the header,
     so you never miss "Sent to Marcus." Screen readers already hear outcomes from the announcer. */
  function perchHidden() { var p = $('#perch'); return p && p.getBoundingClientRect().bottom < topEdge() + 4; }
  function hideEcho() { clearTimeout(echoTimer); var e = $('#echo'); if (e) e.hidden = true; }
  function echo(text, o) {
    /* Stamp captions ("with time to spare.") belong to the stamp on the card, which is already in view */
    if (o && o.cls === 'sign') return;
    if (!alive || Date.now() < scrollHold || !perchHidden()) return hideEcho();
    var e = $('#echo'); $('#echo-t').textContent = text;
    e.style.top = topEdge() + 8 + 'px'; e.hidden = false;
    clearTimeout(echoTimer); echoTimer = setTimeout(hideEcho, 4500);
  }
  function enterCard(t) {
    toTop();
    renderCard(t); updateStack(false); stats();
    card.classList.add(t.handedBack ? 'enter-tilt' : 'enter');
    if (Fuzz.isCalm()) card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    refocus(landing());
  }
  /* Bring the next card in as soon as the last one is gone, and hand back the buttons. Fuzz holds his
     reaction to it until he has finished with the last one (showNext(shown)). */
  function bringNext() {
    var t = Store.queue()[0];
    if (!t || shouldCheckin(t)) return null;
    enterCard(t);
    release();
    return t.id;
  }
  async function showNext(shown) {
    var e = epoch;
    try {
      var q = Store.queue();
      if (!q.length) return zeroState();
      var t = q[0];
      if (t.id !== shown) {
        if (shouldCheckin(t)) return showCheckin();
        enterCard(t);
      }
      if (t.handedBack) {
        Fuzz.glitch(600); Fuzz.setMood('sheepish'); Fuzz.setArm('scratch'); Fuzz.pAnim('shrug');
        /* don't hold the busy lock while the line types out */
        Fuzz.say(t.askBack || 'I lost the signal on this one. Can you help me with it?').then(function () { if (alive) { Fuzz.setArm('none'); settleSheepish(); } });
      } else if (t.dueAt) {
        rushBurst(t);
      } else if (t.kind === 'entity' || t.kind === 'dup') {
        puzzledFor(t);
      } else if (t.isNew) {
        Fuzz.setMood('eager'); Fuzz.say('Fresh from your head. Want me on it?', { type: false });
        setTimeout(function () { if (alive && Fuzz.mood() === 'eager') Fuzz.setMood('idle'); }, 2500);
      } else if (Fuzz.mood() !== 'idle' && !busy) {
        Fuzz.setMood('idle');
      }
    } catch (err) { if (err !== ABORT) console.error(err); }
  }
  function puzzledFor(t) {
    Fuzz.setMood('puzzled'); Fuzz.setArm('none');
    var tok = Fuzz.newTok();
    (function qloop() {
      if (!alive || tok !== Fuzz.tok() || Fuzz.mood() !== 'puzzled') return;
      Fuzz.hearts('?', 'var(--wait)', 3); setTimeout(qloop, 2300);
    })();
    if (!Fuzz.isCalm()) Fuzz.glitch(220);
    Fuzz.say(t.kind === 'dup' ? 'Hm. These two look alike. Same thing, or not?' : 'Hm. One thing I can’t work out on my own.', { type: false });
    setTimeout(function () { if (alive && Fuzz.mood() === 'puzzled' && tok === Fuzz.tok()) { Fuzz.setMood('idle'); } }, 9000);
  }

  var VERBS = ['Reading the thread for', 'Drafting', 'Checking my calendar for', 'Pulling files for'];
  function renderEmpty() {
    var old = stack.querySelector('.empty'); if (old) old.remove();
    var working = Store.inState('ai', 'ai-queued'), review = Store.inState('review'), s = Store.stats();
    var e = document.createElement('div'); e.className = 'empty';
    var h = '', n = cleared(), sentN = Store.sentCount();
    /* End on what you did (peak-end): a short recap of the session */
    var recap = n ? '<p class="recap">You cleared ' + n + (n === 1 ? ' card' : ' cards') + (sentN ? ' and sent ' + sentN : '') + '.' + (working.length ? ' Fuzz has ' + working.length + ' going.' : '') + '</p>' : '';
    if (working.length || review.length) {
      h += '<h2>Nothing waiting for you</h2>' + recap;
      if (working.length) h += '<p class="meta">Fuzz is working on ' + working.length + (working.length === 1 ? ' task' : ' tasks') + '. Anything that gets stuck comes back to the end of this queue.</p>' +
        '<ul class="work">' + working.map(function (t, i) { return '<li style="--i:' + i + '"><span>' + esc(t.title) + (t.dueAt ? ' <span class="tag due t2">Rush</span>' : '') + (t.state === 'ai-queued' ? ' <span class="pill pill--muted">Next up</span>' : '') + '</span><span class="dots" role="img" aria-label="In progress"><i></i><i></i><i></i></span></li>'; }).join('') + '</ul>';
      if (review.length) h += '<p class="meta ready">' + review.length + (review.length === 1 ? ' draft waits' : ' drafts wait') + ' in <a href="#/tasks">Lineup</a> whenever you want ' + (review.length === 1 ? 'it' : 'them') + '.</p>';
    } else {
      h += '<h2>All clear</h2>' + recap + '<p class="meta">Fuzz is on standby. Capture something new to put it to work.</p><a class="btn primary linklike" href="#/capture">New task</a>';
    }
    if (s.later) h += '<p class="later">' + s.later + ' scheduled for later</p>';
    e.innerHTML = h;
    stack.appendChild(e);
    e.querySelector('h2').tabIndex = -1;
  }
  function zeroState(quiet) {
    stats(); updateStack(false);
    card.style.display = 'none'; $('#checkin').hidden = true; $('#dropbtn').hidden = true;
    renderEmpty();
    refocus(stack.querySelector('.empty h2'));
    if (!quiet) settleWork();
  }
  function settleWork() {
    if (!alive) return;
    var working = Store.inState('ai', 'ai-queued');
    if (working.length) {
      Fuzz.setMood('working');
      var tok = Fuzz.newTok(), i = 0;
      (function tick() {
        if (!alive || tok !== Fuzz.tok() || ['working', 'boop'].indexOf(Fuzz.mood()) < 0) return;
        var w = Store.inState('ai', 'ai-queued'); if (!w.length) return;
        Fuzz.say(VERBS[i % VERBS.length] + ' “' + w[i % w.length].title + '”…', { type: false });
        i++; setTimeout(tick, 4200);
      })();
    } else {
      Fuzz.setMood('idle'); Fuzz.say('All clear. Send me something!');
      var btok = Fuzz.newTok();
      setTimeout(function () { if (alive && btok === Fuzz.tok() && Fuzz.mood() === 'idle' && !Store.get().queue.length && !Store.inState('ai', 'ai-queued').length) Fuzz.startBored(); }, 7000);
    }
  }

  /* ---------- Check-in (repeats through the session; the answer reorders the queue, principle 16) ---------- */
  var CI_REPLY = {
    good: { mood: 'happy', moment: 'any', line: 'Love that. Let’s keep the momentum.', auto: true },
    okay: { mood: 'idle', moment: 'any', line: 'Okay works. I’ll keep things light.', auto: true },
    tired: { mood: 'caring', moment: 'low', line: 'Okay. I’ll bring the gentle ones first. Want to take five? I’ll watch the queue.', longLine: 'Long stretch. I’ll bring the gentle ones first. Want to take five? I’ll watch the queue.', said: 'tired', ask: 'Gentle ones come first. Take a break?', opts: [['break', 'Take 5'], ['go', 'Keep going']] },
    over: { mood: 'caring', moment: 'quick', line: 'That’s a lot at once. I’ll put the quick ones first. Want me to hold the rest until tomorrow?', said: 'overloaded', ask: 'Quick ones come first. Hold the rest?', opts: [['slow', 'Quick ones first'], ['hold', 'Hold the rest until tomorrow']] }
  };
  var CI_ASK = [
    ['Quick pause. How are you doing?', 'Got a second? Just checking in.'],
    ['Checking in again. How’s it going?', 'Me again. Quick check-in.'],
    ['Been a while. How are you holding up?', 'We’ve been at this a while.']
  ];
  /* "A while" is time on the clock, not cards cleared: half an hour in. */
  function longSession() { return Date.now() - sessionAt >= 30 * 60000; }
  /* ---------- Coming back (principle 12: easy re-entry) ---------- */
  function awayLines() {
    var q = Store.queue(), rush = q.filter(function (i) { return i.dueAt; }).length, back = q.filter(function (i) { return i.handedBack; }).length;
    var review = Store.inState('review').length, run = Store.inState('ai', 'ai-queued').length, wait = Store.inState('waiting').length;
    var L = [];
    if (q.length) L.push(['queue', q.length + (q.length === 1 ? ' card waits' : ' cards wait') + ' for you' + (rush ? ', ' + rush + ' with a deadline today' : '') + '.']);
    if (review) L.push(['draft', 'Fuzz finished ' + review + (review === 1 ? ' draft' : ' drafts') + ' for your OK.']);
    if (back) L.push(['back', back + (back === 1 ? ' came' : ' came') + ' back to you with a question.']);
    if (run) L.push(['run', 'Fuzz is still working on ' + run + '.']);
    if (wait) L.push(['wait', wait + (wait === 1 ? ' is' : ' are') + ' waiting on someone else. Fuzz is watching for replies.']);
    return L;
  }
  function showAway() {
    awayOpen = true;
    card.style.display = 'none'; $('#dropbtn').hidden = true;
    $('#away-list').innerHTML = awayLines().map(function (l) { return '<li class="away-' + l[0] + '">' + esc(l[1]) + '</li>'; }).join('');
    var a = $('#away'); a.hidden = false; a.className = 'card away enter';
    updateStack(false);
    $('#away-go').focus({ preventScroll: true });
  }
  async function startFromAway() {
    if (!awayOpen) return;
    awayOpen = false;
    var a = $('#away');
    if (!Fuzz.isCalm()) await a.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scale(.98)' }], { duration: 200, easing: 'ease-in' }).finished.catch(function () {});
    if (!alive) return;
    a.hidden = true;
    await showNext();
    refocus(landing());
  }
  function openKeys() { var d = $('#keysdlg'); if (d && !d.open) d.showModal(); }

  function showCheckin(demo) {
    ciDemo = !!demo;
    ciOpen = true; lock(busy); clearInterval(ciTimer); ciBusy = false;
    card.style.display = 'none';
    var oldE = stack.querySelector('.empty'); if (oldE) oldE.remove();
    var ci = $('#checkin');
    ci.getAnimations().forEach(function (a) { a.cancel(); });
    ci.hidden = false; ci.className = 'card checkin enter'; /* drops .picked, so the mood keys show again */
    $('#ci-follow').innerHTML = ''; $('#ci-break').hidden = true; $('#ci-moods').hidden = false; $('#ci-skip').hidden = false; ci.querySelector('.meta').hidden = false;
    ci.querySelectorAll('.mood').forEach(function (b, i) { b.setAttribute('aria-pressed', 'false'); b.style.setProperty('--i', i); });
    updateStack(false); stats();
    $('#dropbtn').hidden = true;
    Fuzz.setMood('caring'); Fuzz.setArm('none');
    /* Only call the urgent stuff handled if it was: done, or with Fuzz. Scheduled or parked isn't handled. */
    var handled = lastTask && lastTask.dueAt && ['done', 'ai', 'ai-queued', 'session', 'review'].indexOf(lastTask.state) > -1;
    var ask = handled ? ['The urgent stuff is handled. How are you doing?', 'Urgent stuff, handled. Nice.'] : CI_ASK[longSession() ? 2 : Math.min(ciCount, 1)];
    $('#ci-h').textContent = ask[0];
    refocus($('#ci-h'));
    Fuzz.say(ask[1], { type: false });
  }
  async function ciPick(kind) {
    if (ciBusy) return;
    var r = CI_REPLY[kind], ci = $('#checkin');
    ci.querySelectorAll('.mood').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.pick === kind)); });
    Store.setMoment(r.moment); ciAnswer = CI_ANSWER[kind];
    Fuzz.setMood(r.mood); if (r.mood === 'happy') Fuzz.pAnim('hop');
    var line = r.longLine && longSession() ? r.longLine : r.line;
    Fuzz.say(line, { type: false }); Say.announce(line);
    var f = $('#ci-follow'); f.innerHTML = '';
    if (r.auto) { ciBusy = true; $('#ci-skip').hidden = true; try { await sleep(1700); } catch (e) { return; } ciBusy = false; return ciClose(); }
    /* Once you've answered, the moods and Skip step aside: your answer and Fuzz's reply, then one or two ways on. */
    ci.classList.add('picked'); $('#ci-moods').hidden = true; $('#ci-skip').hidden = true; ci.querySelector('.meta').hidden = true;
    var said = document.createElement('p'); said.className = 'ci-said';
    said.innerHTML = Fuzz.mini(kind, { cls: 'fz' }) + '<span>You said <b>' + esc(r.said) + '</b>. ' + esc(r.ask) + '</span>'; f.appendChild(said);
    r.opts.forEach(function (o, i) {
      var b = document.createElement('button'); b.className = 'btn' + (i === 0 ? ' primary' : ''); b.dataset.ci = o[0];
      b.setAttribute('aria-keyshortcuts', String(i + 1)); b.innerHTML = esc(o[1]) + kbd(i + 1); f.appendChild(b);
    });
    f.querySelector('.btn').focus({ preventScroll: true });
  }
  function paintBreak() { $('#ci-time').textContent = Math.floor(ciSecs / 60) + ':' + ('0' + (ciSecs % 60)).slice(-2); }
  async function ciAction(a) {
    if (ciBusy) return;
    try {
      if (a === 'skip') return ciClose('Okay, no pause. Back to it.');
      if (a === 'go') return ciClose('Okay. Gentle ones first.');
      if (a === 'slow') { ciFollow = 'quick_first'; return ciClose('Okay. Quick ones first, one at a time.'); }
      if (a === 'hold') {
        /* Everything without a deadline goes to tomorrow morning, in one change you can undo */
        ciBusy = true; ciFollow = 'hold_rest';
        var held = ciDemo ? null : Store.checkin(ciAnswer || 'overloaded', 'hold_rest');
        ciDone();
        stats(); Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Done. They’ll be waiting for you tomorrow morning.', { type: false });
        var tm = Sched.tomorrowMorning(); Fuzz.schedGlyph(Sched.glyph(tm), 'TOMORROW ' + new Date(tm.fire_at).toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '').toUpperCase());
        if (held) offer('Held the rest until tomorrow.', held.change);
        await sleep(1500);
        Fuzz.clearSched();
        $('#checkin').hidden = true; ciOpen = false; ciBusy = false; lock(busy);
        return Store.queue().length ? showNext() : zeroState();   /* questions and anything due stay */
      }
      if (a === 'break') {
        ciFollow = 'take_5';
        $('#ci-moods').hidden = true; $('#ci-follow').innerHTML = ''; $('#ci-skip').hidden = true; $('#ci-break').hidden = false;
        ciSecs = 300; paintBreak(); $('#ci-break [data-ci="back"]').focus({ preventScroll: true });
        Fuzz.setMood(Store.inState('ai').length ? 'working' : 'idle');
        Fuzz.say('I’ve got the queue. Go stretch.', { type: false });
        clearInterval(ciTimer);
        ciTimer = setInterval(function () { ciSecs--; paintBreak(); if (ciSecs <= 0) { clearInterval(ciTimer); ciAction('back'); } }, 1000);
        return;
      }
      if (a === 'back') {
        clearInterval(ciTimer); ciBusy = true;
        Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Welcome back!', { type: false });
        await sleep(1200);
        ciBusy = false; return ciClose();
      }
    } catch (e) { if (e !== ABORT) throw e; }
  }
  async function ciClose(line) {
    ciBusy = true; clearInterval(ciTimer); ciDone();
    var ci = $('#checkin');
    if (line) Fuzz.say(line, { type: false });
    if (!Fuzz.isCalm()) await ci.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.97)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).finished.catch(function () {});
    if (!alive) return;
    ci.getAnimations().forEach(function (a) { a.cancel(); });
    ci.hidden = true; ciOpen = false; ciBusy = false; lock(busy);
    Fuzz.setMood('idle');
    await showNext();
  }

  /* ---------- Moments ---------- */
  async function fly(node, target, o) { await Fuzz.flyTo(node, target, o); await sleep(0); }
  /* Play an exit animation, then drop its fill and hide the card until the next one renders.
     (A forwards-filling animation left on the persistent card element can bleed into the next card.) */
  async function exitCard(keyframes, opts) {
    var a = card.animate(keyframes, Object.assign({ fill: 'both' }, opts));
    await a.finished.catch(function () {});
    card.style.visibility = 'hidden';
    a.cancel();
    await sleep(0);
  }
  function fadeOut() { return exitCard([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }); }
  function pickV(n, last) { var i; do { i = Math.floor(Math.random() * n); } while (n > 1 && i === last); return i; }
  var lastAssign = -1, lastDone = -1, lastStamp = -1;

  /* Five ways Fuzz reacts when he takes a task. Card travel stays the same. */
  var ASSIGNS = [
    { inL: ['On it.', 'Rush job. On it.'], fx: null, ms: 0, midL: ['Tuning in…', 'Priority lane…'], outL: ['Got it. I’ll ping you if I lose the signal.', 'On it. I’ll flag you before the deadline.'] },
    { inL: ['Consider it handled.', 'Handled. Fast.'], fx: 'wink', ms: 900, midL: ['Tuning in…', 'Priority lane…'], outL: ['Easy. I’ll ping you if I lose the signal.', 'Easy. I’ll flag you before the deadline.'] },
    { inL: ['Right away.', 'Right away. Double time.'], fx: 'tip', ms: 1100, midL: ['Reading it over…', 'Reading fast…'], outL: ['Understood. I’ll ping you if I lose the signal.', 'Understood. I’ll flag you before the deadline.'] },
    { inL: ['Locking on.', 'Locking on. Fast.'], fx: 'scan', ms: 1000, midL: ['Target acquired…', 'Target acquired, moving…'], outL: ['Locked in. I’ll ping you if I lose the signal.', 'Locked in. I’ll flag you before the deadline.'] },
    { inL: ['Revving up.', 'Flooring it.'], fx: 'rev', ms: 1000, midL: ['Warming the tubes…', 'Tubes hot…'], outL: ['Up to speed. I’ll ping you if I lose the signal.', 'Up to speed. I’ll flag you before the deadline.'] }
  ];
  /* set: fields an answer changes on the task (its draft, its recipient), applied with the assignment so Undo reverts them too */
  async function assign(line, set) {
    var it = cur(); if (!it || it.kind !== 'task') return;
    var instr = $('#instr') ? $('#instr').value : (it.hint || '');
    streak = 0;
    var rush = !!it.dueAt, r = rush ? 1 : 0;
    var vi = pickV(ASSIGNS.length, lastAssign); lastAssign = vi; var V_ = ASSIGNS[vi];
    var b = card.querySelector('[data-act="assign"]'); if (b) { b.classList.add('squish'); setTimeout(function () { b.classList.remove('squish'); }, 180); }
    Fuzz.setMood('eager'); Fuzz.setArm('salute'); if (V_.fx) Fuzz.fxOn(V_.fx, V_.ms); else Fuzz.pAnim('lean');
    Fuzz.say(line || V_.inL[r]);
    /* The card heads for Fuzz while his reaction is still playing. */
    await sleep(rush ? 150 : 250);
    var waited, title = it.title;
    var ch = Store.track([it.id], function () { if (set) Object.assign(it, set); waited = Store.assign(it.id, instr); });
    forgetEdits(it.id);
    /* Undo is offered as soon as the change is made, since you may move on before Fuzz finishes reacting.
       Once Fuzz starts on it, it can't be undone any more; you'd pull it back from Lineup instead. */
    offer('Assigned “' + title + '” to Fuzz.', ch, waited ? 'Assigned “' + title + '” to Fuzz. It’s next up; five are running.' : null);
    var shown = null, flown = fly(card, root.querySelector('#bot'), { scale: 0.08, rot: -18, dur: rush ? 340 : 600 }).then(function () { shown = bringNext(); });
    await Promise.all([flown, sleep(Math.max(rush ? 300 : 650, V_.ms * (rush ? 0.55 : 0.8)) * 0.7)]);
    Fuzz.setArm('none');
    Fuzz.flash(); Fuzz.glitch(180); Fuzz.pAnim('gulp'); Fuzz.setMood('thinking'); stats();
    Fuzz.say(V_.midL[r]);
    await sleep(rush ? 560 : 900);
    Fuzz.setMood('happy');
    Fuzz.say(waited ? 'That’s my fifth. This one is next up the moment I’ve got a free hand.' : V_.outL[r]); Fuzz.pAnim('hop');
    await sleep(700);
    Fuzz.setMood('idle');
    await showNext(shown);
  }

  var STAMP_V = [['DONE', 's1'], ['✓', 's2'], ['NAILED IT', 's3'], ['DONE', 's4'], ['Nice!', 's5']];
  var STAMPS = ['signal: strong.', 'loud and clear.', 'one down.', 'tidy.', 'crisp.'];
  var DONES = [
    { mood: 'proud', say: null, hold: 1000, fx: function (c) { Fuzz.pAnim('hop'); Fuzz.confetti(c); } },
    { mood: 'happy', say: 'nailed it.', hold: 1400, fx: function () { Fuzz.pAnim('lift'); Fuzz.fxOn('star', 1350); Fuzz.hearts('★', 'var(--wait)', 6); } },
    { mood: 'happy', say: 'ta-da.', hold: 1100, fx: function () { Fuzz.pAnim('spin'); } },
    { mood: 'happy', say: 'little victory dance.', hold: 1300, fx: function () { Fuzz.fxOn('dance', 1250); Fuzz.hearts('♪', 'var(--accent)', 5); } },
    { mood: 'happy', say: 'thank you, thank you.', hold: 1400, fx: function () { Fuzz.pAnim('bow'); Fuzz.checkGlyph(1300); } }
  ];
  async function done() {
    var it = cur(); if (!it || it.kind !== 'task') return;
    var rushT = !!it.dueAt, vi = pickV(DONES.length, lastDone); lastDone = vi; var V_ = DONES[vi];
    var st = card.querySelector('.stamp'), si = rushT ? 0 : pickV(STAMP_V.length, lastStamp); lastStamp = si;
    st.className = 'stamp ' + STAMP_V[si][1]; st.textContent = rushT ? 'ON TIME' : STAMP_V[si][0];
    card.classList.add('stamped');
    await sleep(220);
    if (!Fuzz.isCalm()) card.classList.add('shake');
    offer('Marked “' + it.title + '” done.', Store.track([it.id], function () { Store.done(it.id); }));
    Fuzz.flash(); Fuzz.setMood(V_.mood); Fuzz.setArm('cheer'); V_.fx(card);
    streak++; stats();
    Fuzz.say(rushT ? 'with time to spare.' : (V_.say || STAMPS[Store.stats().done % STAMPS.length]), { cls: 'sign', type: false });
    if (streak >= 3) Fuzz.setCool(true);
    /* The card drops away while Fuzz celebrates, after a short beat so the stamp reads. */
    var shown = null, exit = sleep(200).then(function () {
      if (Fuzz.isCalm()) return fadeOut();
      return exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateY(8px) scale(.97)', offset: 0.2 }, { transform: 'translateY(320px) scale(.55) rotate(6deg)', opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.5,0,.9,.6)' });
    }).then(function () { st.className = 'stamp'; st.textContent = 'DONE'; shown = bringNext(); });
    await Promise.all([exit, sleep(V_.hold * 0.7)]);
    Fuzz.setArm('none');
    Fuzz.setMood('idle');
    if (streak >= 3) Fuzz.say('Three in a row. Sunglasses are earned.');
    await showNext(shown);
  }

  async function inClaude() {
    var it = cur(); if (!it || it.kind !== 'task') return;
    streak = 0;
    var b = card.querySelector('[data-act="claude"]'); if (b) { b.classList.add('squish'); setTimeout(function () { b.classList.remove('squish'); }, 180); }
    Fuzz.setMood('stare'); Fuzz.say('Oh. Claude.', { type: false });
    offer('Opened “' + it.title + '” in Claude.', Store.track([it.id], function () { Store.session(it.id); }), 'Opened “' + it.title + '” in Claude. In this demo it just moves to Current.');
    var shown = null, exit = sleep(350).then(function () {
      if (Fuzz.isCalm()) return fadeOut();
      return exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translate(40%,-30px) scale(.9) rotate(3deg)', opacity: 0.9, offset: 0.3 }, { transform: 'translate(130%,-60px) scale(.7) rotate(8deg)', opacity: 0 }], { duration: 460, easing: 'cubic-bezier(.5,0,.8,.4)' });
    }).then(function () { shown = bringNext(); });
    await Promise.all([exit, sleep(1000)]);
    stats();
    Fuzz.say('It’s fine. I’m not jealous. I’ll watch the queue.', { type: false });
    await sleep(1600);
    Fuzz.setMood('idle');
    await showNext(shown);
  }

  function renderActionsArea() { var it = cur(); var a = $('#actions'); if (a && it) { a.innerHTML = actionsHTML(it); } }
  async function schedule() {
    var it = cur(); if (!it || it.kind !== 'task') return;
    streak = 0;
    if ($('#instr')) edits[it.id + ':instr'] = $('#instr').value;
    var review = it.state === 'review';
    if (review && $('#draft')) edits[it.id + ':draft'] = $('#draft').value;
    scheduling = true; schedMore = false; renderCardKeep();
    refocus($('#sched-h'));
    Fuzz.setMood('eager'); Fuzz.say(review ? 'No rush. When should I ask you about it again?' : 'Happy to! When should I bring it back?'); Fuzz.pAnim('hop');
    var pickedIdx = await new Promise(function (resolve) { schedResolve = resolve; });
    schedResolve = null;
    if (pickedIdx === -1) {
      scheduling = false; renderCardKeep(); Fuzz.setMood('idle'); Fuzz.say('Okay, it stays here.', { type: false });
      var sb = card.querySelector(review ? '[data-act="notnow"]' : '[data-act="schedule"]'); if (sb) { sb.disabled = false; sb.focus(); }
      return;
    }
    var w = pickedIdx === 99 ? exactOpt : schedOpts(it)[pickedIdx], when = w.label.charAt(0).toLowerCase() + w.label.slice(1);
    var btn = card.querySelector('[data-when="' + pickedIdx + '"]'); if (btn) btn.classList.add('picked');
    card.querySelectorAll('[data-when],[data-sched]').forEach(function (b) { b.disabled = true; });
    if (it.dueAt && w.fire_at && new Date(w.fire_at).getTime() > it.dueAt) {
      Fuzz.setMood('worried'); Fuzz.say('Heads up, that lands after the deadline. Scheduling it anyway.');
      Say.announce('Heads up, that lands after the deadline. Scheduling it anyway.');
      await sleep(2000);
    }
    /* Instructions you wrote (not Fuzz's suggestion) are what to look into before it comes back */
    var typed = (edits[it.id + ':instr'] || '').trim(), look = typed && typed !== (it.instr || it.hint || '').trim() ? typed : '';
    Fuzz.setMood('happy'); Fuzz.setArm('none'); Fuzz.pAnim('hop');
    var text = review ? edits[it.id + ':draft'] : undefined;
    Fuzz.say(review ? 'Okay. Nothing goes out. I’ll ask you again ' + when + '.' : look ? 'On it. I’ll dig in and bring it back ' + when + '.' : 'Done! I’ll bring it back ' + when + '.');
    Fuzz.schedGlyph(Sched.glyph(w), Sched.osd(w));
    offer((review ? 'Not now: “' + it.title + '” asks for your OK again ' : 'Scheduled “' + it.title + '”: ') + when + (look ? '. Fuzz looks into it first.' : '.'), Store.track([it.id], function () { Store.schedule(it.id, w, look, text); }));
    forgetEdits(it.id);
    /* The card flies off while the schedule shows on Fuzz's screen. */
    var shown = null, exit = sleep(400).then(function () { return fly(card, Progress.target(), { scale: 0.06, rot: 8, dur: 520 }); }).then(function () { shown = bringNext(); });
    await Promise.all([exit, sleep(1050)]);
    Fuzz.clearSched();
    stats(); Fuzz.pAnim('hop');
    await sleep(500);
    Fuzz.setMood('idle');
    await showNext(shown);
  }
  var schedResolve = null, exactOpt = null;
  function renderCardKeep() { var it = cur(); if (!it) return; $('#actions').innerHTML = actionsHTML(it); var st = card.querySelector('.stale'); if (st && scheduling) st.hidden = true; else if (st) st.hidden = false; }

  /* Approve a draft. Fuzz then sends it with its own connected tools; Undo takes the approval back
     until it has gone out, and not after. A draft just for you is only filed. */
  async function sendDraft() {
    var it = cur(); if (!it || it.state !== 'review') return;
    var r = Store.recipient(it), text = $('#draft') ? $('#draft').value : it.draft, title = it.title;
    var st = card.querySelector('.stamp'); st.className = 'stamp s4'; st.textContent = 'OK';
    card.classList.add('stamped');
    await sleep(220);
    if (r) offer('Approved “' + title + '” to send.', Store.track([it.id], function () { Store.approve(it.id, text); }), 'Approved. Fuzz is sending it to ' + r.to + '.');
    else offer('Approved “' + title + '”.', Store.track([it.id], function () { Store.accept(it.id, text); }));
    forgetEdits(it.id);
    Fuzz.flash(); Fuzz.setMood('proud'); Fuzz.setArm('salute'); Fuzz.pAnim('bow');
    Fuzz.say(r ? 'On its way to ' + r.to + '.' : it.prep && it.afterApprove ? it.afterApprove : 'Filed. Thanks for checking.', { cls: 'sign', type: false });
    stats();
    var shown = null, exit = sleep(260).then(function () {
      if (Fuzz.isCalm()) return fadeOut();
      return exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translate(-2%,10px) rotate(-1deg)', offset: 0.25 }, { transform: 'translate(60%,-120px) scale(.6) rotate(-10deg)', opacity: 0 }], { duration: 480, easing: 'cubic-bezier(.5,0,.75,.4)' });
    }).then(function () { st.className = 'stamp'; shown = bringNext(); });
    await Promise.all([exit, sleep(1100)]);
    Fuzz.setArm('none'); Fuzz.setMood('idle');
    await showNext(shown);
  }
  async function reviseDraft() {
    var it = cur(); if (!it || it.state !== 'review') return;
    var note = $('#revise-text').value.trim(), title = it.title;
    var draft = $('#draft') ? $('#draft').value : null;
    var ch = Store.track([it.id], function () { Store.revise(it.id, note, draft); });
    forgetEdits(it.id);
    offer('Sent “' + title + '” back to Fuzz to change.', ch);
    Fuzz.setMood('eager'); Fuzz.setArm('salute'); Fuzz.say('Got it. I’ll bring it back changed.', { type: false });
    var shown = null, flown = fly(card, root.querySelector('#bot'), { scale: 0.08, rot: -18, dur: 600 }).then(function () { shown = bringNext(); });
    await Promise.all([flown, sleep(700)]);
    Fuzz.setArm('none'); Fuzz.setMood('thinking'); stats();
    await sleep(900);
    Fuzz.setMood('idle');
    await showNext(shown);
  }

  /* Each change undoes on its own (the core's model, not a stack). Undo refuses, with Fuzz saying why,
     once something else has changed the same task since. */
  function offer(label, ch, spoken) {
    Say.offerUndo(label, function () { var why = ch.undo(); if (!why) V.refresh(); return why; }, spoken, ch.blocked);
  }

  /* Clear a card quickly without a full ceremony: park, wait, let go, drop. */
  async function quickClear(label, message, change, line, mood) {
    var it = cur(); if (!it) return;
    streak = 0;
    offer(label + ' “' + it.title + '”.', Store.track([it.id], function () { change(it); }), message);
    Fuzz.setMood(mood || 'happy'); Fuzz.say(line, { type: false }); if (mood !== 'sheepish') Fuzz.pAnim('hop');
    if (Fuzz.isCalm()) await fadeOut();
    else await exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateX(-110%) rotate(-8deg)', opacity: 0 }], { duration: 260, easing: 'ease-in' });
    var shown = bringNext();
    stats();
    await sleep(350);
    Fuzz.setMood('idle');
    await showNext(shown);
  }

  async function thank(ms) {
    Fuzz.setMood('grateful'); Fuzz.pAnim('lift'); Fuzz.hearts();
    Fuzz.say('Thank you! That’s exactly what I needed.');
    await sleep(ms || 1900);
  }
  async function answerEntity(which) {
    var it = cur(); if (!it || it.kind === 'task') return;
    var ch = Store.track([it.id, it.dupOf], function () { Store.resolve(it.id, which); });
    var msg = it.answers[which];
    offer('Answered “' + it[which] + '”: ' + it.title + '.', ch, msg);
    var shown = null, exit = sleep(250).then(function () {
      if (Fuzz.isCalm()) return fadeOut();
      return exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-20px) scale(.96)', opacity: 0 }], { duration: 300, easing: 'ease-in' });
    }).then(function () { shown = bringNext(); });
    await Promise.all([exit, thank(1300)]);
    Fuzz.setMood('happy'); Fuzz.say(msg, { type: false });
    stats();
    await sleep(400);
    Fuzz.setMood('idle');
    await showNext(shown);
  }
  function openGroup(trigger) {
    var g = Store.groupOf(cur()); if (!g) return;
    GroupSheet.open(g.id, { trigger: trigger,
      onChange: function () { var it = cur(); if (it && !busy) { renderCard(it); stats(); } },
      onUndo: function () { V.refresh(); } });
  }
  async function entityLater() {
    var it = cur(); if (!it) return;
    Store.toBack(it.id);
    Fuzz.setMood('idle'); Fuzz.pAnim('shrug'); Fuzz.say('Okay, I’ll ask again later.', { type: false });
    await sleep(280);
    await showNext();
  }
  /* Each quick answer carries its own instruction. It replaces Fuzz's suggested text, so the two can't
     disagree; anything you typed yourself stays, after the answer. "I'll find it" keeps the task with you. */
  async function answerHandback(i) {
    var it = cur(); if (!it || !it.quick) return;
    var q = typeof it.quick[i] === 'string' ? { label: it.quick[i], instr: it.quick[i] + '.' } : it.quick[i];
    var ta = $('#instr'), typed = ta ? ta.value.trim() : '';
    var text = !typed || typed === (it.instr || it.hint || '').trim() ? q.instr : q.instr + '\n' + typed;
    if (q.mine) {
      forgetEdits(it.id);
      return quickClear('Took on', 'You took “' + it.title + '” yourself. It waits in Lineup, under Yours.', function (x) { Store.mine(x.id, text); }, 'Got it, it’s with you. I kept the sources handy.');
    }
    if (ta) ta.value = text;
    await thank(1100);
    Fuzz.setMood('idle');
    await assign('Got it. Back on air.', q.set);
  }

  /* ---------- Wiring ---------- */
  function wire() {
    offSay = Fuzz.onSay(echo);
    $('#away-go').addEventListener('click', startFromAway);
    $('#keysbtn').addEventListener('click', openKeys);
    $('#keysdlg').addEventListener('click', function (e) { if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.close(); });
    $('#keysdlg').addEventListener('close', function () { var b = $('#keysbtn'); if (b && b.offsetParent) b.focus(); });
    onScroll = function () { var e = $('#echo'); if (e && !e.hidden && !perchHidden()) hideEcho(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    card.addEventListener('input', function (e) {
      var it = cur(); if (!it) return;
      /* Each box keeps its own text, so what you told Fuzz never turns up in the draft he brings back */
      if (e.target.id === 'instr' || e.target.id === 'note' || e.target.id === 'draft') edits[it.id + ':' + e.target.id] = e.target.value;
      if (e.target.id === 'instr' || e.target.id === 'draft') fit(e.target);
    });
    card.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act],[data-when],[data-tab],[data-quick],[data-sched]');
      if (!t || !card.contains(t)) return;
      if (t.dataset.tab) { showTab(t.dataset.tab); return; }
      if (t.dataset.when !== undefined) { if (schedResolve) schedResolve(parseInt(t.dataset.when, 10)); return; }
      if (t.dataset.sched) {
        if (t.dataset.sched === 'cancel') { if (schedResolve) schedResolve(-1); }
        else if (t.dataset.sched === 'more') { schedMore = true; renderCardKeep(); var nx = card.querySelectorAll('[data-when]')[3]; if (nx) nx.focus(); }
        else if (t.dataset.sched === 'exact') { var ex = $('#exact'); ex.hidden = !ex.hidden; var dt = $('#exact-dt'); if (!dt.value) { var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); dt.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); } }
        else if (t.dataset.sched === 'exact-go') {
          var v = $('#exact-dt').value; if (!v) return;
          var when = new Date(v);
          if (when.getTime() <= Date.now()) { Fuzz.say('That time has already gone by. Pick a later one?', { type: false }); return; }
          exactOpt = Sched.exact(when);
          if (schedResolve) schedResolve(99);
        }
        return;
      }
      if (t.dataset.quick !== undefined) { moment(function () { return answerHandback(parseInt(t.dataset.quick, 10)); }); return; }
      var a = t.dataset.act;
      if (a === 'more') {
        var m = $('#moremenu'); m.hidden = !m.hidden; t.setAttribute('aria-expanded', String(!m.hidden));
        if (!m.hidden) { var first = m.querySelector('button'); if (first) first.focus(); }
        return;
      }
      var mm = $('#moremenu'); if (mm) mm.hidden = true;
      if (a === 'assign') moment(function () { return assign(); });
      else if (a === 'done') moment(done);
      else if (a === 'claude') moment(inClaude);
      else if (a === 'schedule') moment(schedule);
      else if (a === 'park') moment(function () { return quickClear('Parked', 'Parked “' + cur().title + '”. Find it in Lineup, under Parked.', function (i) { Store.park(i.id); }, 'Parked. No date, no pressure.'); });
      else if (a === 'waiting') moment(function () { return quickClear('Waiting on someone:', 'Moved to Waiting on others. Fuzz will watch for a reply.', function (i) { Store.wait(i.id); }, 'I’ll watch for the reply.'); });
      else if (a === 'letgo') moment(function () { return quickClear('Let go of', 'Let go. You can bring it back from Let go.', function (i) { Store.letGo(i.id); }, 'Let go. That one’s off your plate.', 'sleepy'); });
      else if (a === 'keep') { keptStale[cur().id] = true; renderCard(cur()); refocus(landing()); Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Kept. It stays on your list.', { type: false }); setTimeout(function () { if (alive && Fuzz.mood() === 'happy') Fuzz.setMood('idle'); }, 1500); }
      else if (a === 'send') moment(sendDraft);
      else if (a === 'sentself') moment(done);
      else if (a === 'notnow') moment(schedule);
      else if (a === 'revise') {
        var rf = $('#revise'); rf.hidden = !rf.hidden; t.setAttribute('aria-expanded', String(!rf.hidden));
        if (!rf.hidden) $('#revise-text').focus();
      }
      else if (a === 'ent-primary') moment(function () { return answerEntity('primary'); });
      else if (a === 'ent-secondary') moment(function () { return answerEntity('secondary'); });
      else if (a === 'ent-third') moment(function () { return answerEntity('third'); });
      else if (a === 'ent-later') moment(entityLater);
      else if (a === 'group') openGroup(t);
    });
    docClick = function (e) {
      var mm = root && root.querySelector('#moremenu');
      if (mm && !mm.hidden && !e.target.closest('.split')) { mm.hidden = true; var mb = root.querySelector('.more-btn'); if (mb) mb.setAttribute('aria-expanded', 'false'); }
    };
    document.addEventListener('click', docClick);
    card.addEventListener('keydown', function (e) {
      /* Tabs: arrow keys move between them, as a tablist should */
      var tb = e.target.closest('[role="tab"]');
      if (tb && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) > -1) {
        var all = [].slice.call(card.querySelectorAll('[role="tab"]')), i = all.indexOf(tb), n = all.length;
        i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
        e.preventDefault(); showTab(all[i].dataset.tab);
      }
    });

    /* Keys, from anywhere on Triage that isn't a text field. Letters are the moves on a task card
       (A assign, D done, S schedule, P park; K keep and L let go on a stale card). Numbers pick
       from whatever choice is on screen: a time while scheduling, an answer on an entity or duplicate
       card, a quick answer on a handback, a mood (then a follow-up) on a check-in. Escape backs out. */
    var KEYS = { a: 'assign', d: 'done', s: 'schedule', p: 'park', c: 'claude', w: 'waiting' }, STALE = { k: 'keep', l: 'letgo' }, REVIEW = { r: 'revise', l: 'notnow', d: 'sentself' };
    docKey = function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !alive) return;
      var t = e.target;
      /* Escape leaves the card's box, so the number keys work again */
      if (e.key === 'Escape' && t && (t.id === 'instr' || t.id === 'note') && card.contains(t)) { e.preventDefault(); $('#ask').focus({ preventScroll: true }); return; }
      /* Escape folds the stray-thought box away, keeping what you typed */
      if (e.key === 'Escape' && t && t.id === 'parktext') { e.preventDefault(); $('#parkbtn').click(); return; }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (t && t.closest && t.closest('dialog, [role="dialog"]')) return;
      if (e.key === '?') { e.preventDefault(); openKeys(); return; }
      /* T parks a stray thought from any card, the welcome-back one too, without leaving it */
      if (e.key.toLowerCase() === 't' && !ciOpen) { e.preventDefault(); if ($('#parkform').hidden) $('#parkbtn').click(); else $('#parktext').focus(); return; }
      if (awayOpen) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#away-go').click(); } return; }
      var mm = $('#moremenu');
      if (e.key === 'Escape' && mm && !mm.hidden) { e.preventDefault(); mm.hidden = true; var mb = $('.more-btn'); if (mb) { mb.setAttribute('aria-expanded', 'false'); mb.focus(); } return; }
      var k = e.key.toLowerCase(), n = /^[1-9]$/.test(e.key) ? parseInt(e.key, 10) - 1 : -1, b = null;
      if (ciOpen) {
        var follow = $('#ci-follow').querySelectorAll('.btn');
        if (!$('#ci-break').hidden) return; /* "I'm back" has focus; Enter presses it */
        if (n > -1) b = follow.length ? follow[n] : $('#ci-moods').querySelectorAll('.mood')[n];
        else if (k === 'escape' && !$('#ci-skip').hidden) b = $('#ci-skip');
      } else if (card.style.display === 'none') {
        return;
      } else if (scheduling) {
        if (n > -1) b = card.querySelectorAll('[data-when]')[n];
        else if (k === 'm') b = card.querySelector('[data-sched="more"]');
        else if (k === 'escape') b = card.querySelector('[data-sched="cancel"]');
      } else if (REVIEW[k] && card.querySelector('.actions.review')) {
        b = card.querySelector('[data-act="' + REVIEW[k] + '"]');
      } else if (STALE[k] && card.querySelector('.stale:not([hidden])')) {
        b = card.querySelector('[data-act="' + STALE[k] + '"]');
      } else if (KEYS[k]) {
        b = card.querySelector('[data-act="' + KEYS[k] + '"]');
      } else if (n > -1) {
        b = card.querySelectorAll('.actions.ent .btn, [data-quick]')[n];
      }
      if (!b || b.disabled) return;
      e.preventDefault(); b.click();
    };
    document.addEventListener('keydown', docKey);

    card.addEventListener('submit', function (e) {
      if (e.target.id !== 'revise') return;
      e.preventDefault();
      if ($('#revise-text').value.trim()) moment(reviseDraft);
    });

    $('#dropbtn').addEventListener('click', function () {
      moment(function () { return quickClear(cur().kind === 'task' ? 'Dropped' : 'Dismissed', 'Dropped. Undo if that was a slip.', function (i) { if (i.kind === 'task') Store.drop(i.id); else Store.resolve(i.id, 'dismissed'); }, 'Dropped. One less thing.', 'idle'); });
    });
    $('#parkbtn').addEventListener('click', function (e) {
      var f = $('#parkform'); f.hidden = !f.hidden; e.currentTarget.setAttribute('aria-expanded', String(!f.hidden));
      if (!f.hidden) $('#parktext').focus(); else e.currentTarget.focus();
    });
    $('#parkform').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('#parktext'), v = inp.value.trim(); if (!v) return;
      Store.parkThought(v); inp.value = ''; $('#parkform').hidden = true; $('#parkbtn').setAttribute('aria-expanded', 'false');
      if (!busy) { Fuzz.pAnim('hop'); Fuzz.say('Parked. Back to what you were doing.', { type: false }); }
      $('#parkbtn').focus();
    });
    $('#checkin').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pick) ciPick(b.dataset.pick); else if (b.dataset.ci) ciAction(b.dataset.ci);
    });

    /* Mood lab */
    root.querySelectorAll('[data-demo]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (busy) return;
        var k = b.dataset.demo, v = b.dataset.v;
        if (k === 'mood') {
          clearTimeout(rushTimer);
          if (v === 'bored') { Fuzz.startBored(); return; }
          Fuzz.newTok(); Fuzz.setMood(v); Fuzz.say('Mood: ' + b.textContent.toLowerCase() + '.', { type: false });
          if (v === 'puzzled') Fuzz.hearts('?', 'var(--wait)', 3);
          if (v === 'grateful') Fuzz.hearts();
          if (['chill', 'bored', 'sleepy', 'stare', 'caring'].indexOf(v) < 0) setTimeout(function () { if (alive && Fuzz.mood() === v) Fuzz.setMood('idle'); }, 6000);
        } else if (k === 'rush') {
          Fuzz.newTok(); Fuzz.setMood('rushed'); Fuzz.setUrgency(v); Fuzz.setOsd(['', '3h 10m', '1:42', '0:12'][v]); Fuzz.flash();
          Fuzz.say(['', 'Due later today. I’ll keep an eye on the clock.', 'Due in under 2 hours. Let’s move.', 'Only 12 seconds! Assign me and I’ll start right now.'][v], { type: false });
          setTimeout(function () { if (alive && Fuzz.mood() === 'rushed') Fuzz.setMood('idle'); }, 6000);
        } else if (k === 'fx') {
          if (v.indexOf('p:') === 0) Fuzz.pAnim(v.slice(2));
          else if (v.indexOf('f:') === 0) Fuzz.fxOn(v.slice(2), 1300);
          else if (v === 'confetti') Fuzz.confetti(card.style.display === 'none' ? stack : card);
          else if (v === 'hearts') Fuzz.hearts();
          else if (v === 'checkin') showCheckin(true);
        } else if (k === 'say') {
          Fuzz.newTok(); Fuzz.say('Short and sweet.', { type: false });
        }
      });
    });
  }

  window.TriageView = V;
})();
