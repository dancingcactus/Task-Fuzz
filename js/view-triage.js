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
  var ciOpen = false, ciBusy = false, ciTimer = 0, ciSecs = 300, ciDemo = false, scOpen = false;
  /* Your answer and follow-up, kept by the core (Store.checkin; POST /checkin) once the check-in closes */
  var ciAnswer = null, ciFollow = null;
  var CI_ANSWER = { good: 'good', okay: 'okay', tired: 'tired', over: 'overloaded' };
  var ciCount = 0, ciNextAt = CI_FIRST, ciLastAt = 0, sessionAt = Date.now();
  var shownCard = null, lastTask = null, streak = 0, rushTimer = 0, ambientTimer = 0;
  var scheduling = false, askingWho = false, askingFind = false, booking = false, pausing = false, wayOpen = false, schedMore = false, tab = null, keptStale = {}, edits = {}, greeted = false, refs = {}, refPick = {};
  var docClick = null, docKey = null, unhold = null, docDrag = null, booting = false, offSay = null, onScroll = null, echoTimer = 0, scrollHold = 0;

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
    alive = true; busy = false; epoch++; ciOpen = false; ciBusy = false; scOpen = false; scState = null; scheduling = false; askingWho = false; askingFind = false; booking = false; pausing = false; wayOpen = false; tab = null; streak = 0;
    root = container;
    root.innerHTML = layout();
    card = $('#card'); stack = $('#stack'); stage = $('#stage');
    Fuzz.mount(root, { isBusy: function () { return busy; } });
    wire();
    unsub = Store.on(onStore);
    Say.setBusyCheck(function () { return busy || ciOpen; });
    ambientTimer = setInterval(ambient, 45000);
    V.stuckTimer = setInterval(stuckCheck, 15000);
    V.tickTimer = setInterval(function () { var t = cur(); if (t && t.dueAt && card.style.display !== 'none' && !ciOpen) paintDue(t); }, 1000);
    stats();
    if (!greeted) { greeted = true; greet(); }
    else Fuzz.say('Back to the queue.', { type: false });
    booting = true; showNext(); booting = false;
    /* The router focuses the heading on arrival unless something on the page already has focus */
    var l = landing(); if (l && l.tagName === 'TEXTAREA') { l.focus({ preventScroll: true }); l.selectionStart = l.selectionEnd = l.value.length; }
  };
  V.unmount = function () {
    alive = false; epoch++;
    clearTimeout(rushTimer); clearInterval(ciTimer); clearInterval(ambientTimer); clearInterval(V.tickTimer); clearInterval(V.stuckTimer);
    if (unsub) unsub(); unsub = null;
    Say.setBusyCheck(null);
    if (docClick) document.removeEventListener('click', docClick); docClick = null;
    if (unhold) unhold(); unhold = null; Dictate.abort();
    if (docKey) document.removeEventListener('keydown', docKey); docKey = null;
    if (docDrag) Object.keys(docDrag).forEach(function (n) { window.removeEventListener(n, docDrag[n]); }); docDrag = null;
    if (offSay) offSay(); offSay = null; clearTimeout(echoTimer);
    if (onScroll) window.removeEventListener('scroll', onScroll); onScroll = null;
    Fuzz.unmount(); root = null;
  };
  V.hardReset = function () { keptStale = {}; edits = {}; refs = {}; refPick = {}; ciCount = 0; ciNextAt = CI_FIRST; ciLastAt = 0; sessionAt = Date.now(); lastTask = null; greeted = false; grun = null; Store.setRun(null); };
  V.refresh = function () {
    if (!alive) return;
    epoch++; busy = false; ciOpen = false; ciBusy = false; scheduling = false; askingWho = false; askingFind = false; booking = false; pausing = false; wayOpen = false; clearInterval(ciTimer); clearTimeout(rushTimer);
    lock(false); stats();
    if (!scOpen) showNext();   /* a setup card stays until you answer it */
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
    /* The task in front now asks something else (Fuzz's task moving on to a permission card, say): the card
       on screen is out of date, so the new one comes in. Same card, new details: left alone, as ever. */
    var f = cur();
    if (f && shownCard && f.id === shownCard.id && (f.cardId !== shownCard.cardId || f.kind !== shownCard.kind) &&
        card.style.display !== 'none' && !busy && !ciOpen && !scOpen) { showNext(); return; }
    if (e.type === 'handback') {
      stats(); updateStack(true);
      /* No announcement: the handback waits as its own card at the back of the queue. */
      if (card.style.display === 'none' && !ciOpen && !scOpen) showNext();
    } else if (e.type === 'review') {
      /* A finished draft arrives as its own card at the back of the queue, with no announcement. */
      stats(); updateStack(true);
      if (card.style.display === 'none' && !ciOpen && !scOpen) showNext();
    } else if (e.type === 'attach') {
      var it = cur(); if (it && it.id === e.id && $('#rich')) { tab = 'sources'; $('#rich').innerHTML = richHTML(it); }
      if (it && it.id === e.id) paintRefs();
    } else if (e.type === 'capture') {
      stats(); updateStack(true);
      if (card.style.display === 'none' && !ciOpen && !scOpen) showNext();
    } else if (e.type === 'work') {
      stats();
      if (card.style.display === 'none' && !ciOpen && !scOpen) renderEmpty();
    } else if (e.type === 'wrapped') {
      /* The last task in a group finished, so the thread is closed: a bigger moment than one task, and a line
         on what happened (the core's, in live mode). Calm mode keeps the line and drops the motion. */
      var line = e.group.closedLine || (e.group.title + ': every ask in it is done. That thread’s closed.');
      Fuzz.setMood('proud'); Fuzz.pAnim('spin'); Fuzz.confetti(card.style.display === 'none' ? stack : card);
      if (!Fuzz.isCalm()) { Fuzz.fxOn('star', 1350); Fuzz.hearts('★', 'var(--done)', 6); }
      if (!busy && !ciOpen) Fuzz.say(line, { type: false });
      Say.tell(line);
      setTimeout(function () { if (alive && Fuzz.mood() === 'proud') Fuzz.setMood('idle'); }, 3200);
    } else if (e.type === 'reset' || e.type === 'restore' || e.type === 'moment') {
      /* the caller refreshes */
    }
  }

  /* The key guide (press ? on Triage). Letters act on a task card; numbers pick from whatever choice is showing. */
  function keysHTML() {
    var g = [
      ['On a task card', [['A', 'Assign to Fuzz'], ['C', 'Work in ' + Store.workIn], ['S', 'Later (M for more times)'], ['D', 'Done'], ['P', 'Park it'], ['W', 'Waiting on someone'], ['X', 'Not mine'], ['Q', 'Find out… (Fuzz looks something up; the card comes back next)'], ['B', 'Book time (hold the time; it opens first then)'], ['Z', 'On the working card: Pause']]],
      ['On a draft', [['R', 'Ask Fuzz to change it'], ['L', 'Not now'], ['D', 'Mark done (you send it yourself)']]],
      ['Choices on screen', [['1 – 9', 'Pick an answer, a time or a mood'], ['K', 'Keep a stale card, or keep a parked one parked'], ['R', 'Bring a parked card back'], ['G / U', 'On a check-back: they got back to you, or nudge them'], ['H', 'On a task that keeps coming back: Fuzz works out the first step'], ['E', 'When picking a time: move it to the end of the list instead'], ['L', 'Let a stale or parked card go'], ['Esc', 'Leave the text box, back out, close a menu, or skip a check-in']]],
      ['Anywhere', [['N', 'New task (Esc goes back)'], [Dictate.key, 'Hold to dictate into the box for Fuzz'], ['T', 'Park a stray thought (Esc closes it)'], ['?', 'This list']]]
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
        /* Working through a group: its name and how far along you are, above the card */
        '<div class="gband" id="gband" hidden></div>' +
        '<div class="stack" id="stack">' +
          '<article class="card" id="card"></article>' +
          '<article class="card checkin" id="checkin" hidden>' +
            '<div class="tagrow"><span class="src">Quick pause</span></div>' +
            '<h2 id="ci-h" tabindex="-1">How are you doing?</h2><p class="meta">Totally optional. It takes about five seconds.</p>' +
            '<div class="moods" id="ci-moods" role="group" aria-label="How are you doing?">' + moodBtns + '</div>' +
            '<div class="ci-follow" id="ci-follow"></div>' +
            '<div class="ci-break" id="ci-break" hidden><div class="breath" aria-hidden="true"></div><p class="ci-time" id="ci-time">5:00</p><p class="meta">Fuzz has the queue. Step away for a bit.</p><button class="btn primary" data-ci="back">I’m back</button></div>' +
            '<div class="ci-foot"><button type="button" class="linkbtn" data-ci="skip" id="ci-skip" aria-keyshortcuts="Escape">Skip' + kbd('Esc') + '</button></div>' +
          '</article>' +
          '<article class="card setupcard" id="setupcard" hidden aria-labelledby="sc-h"></article>' +
        '</div>' +
        /* …and what you've answered so far, which Fuzz is collecting */
        '<div class="gtray" id="gtray" hidden></div>' +
      '</section>' +
      '<div class="triage-foot"><button type="button" class="linkbtn" id="dropbtn"></button><span aria-hidden="true">·</span><button type="button" class="linkbtn" id="parkbtn" aria-expanded="false" aria-controls="parkform" aria-keyshortcuts="T">Park a stray thought' + kbd('T') + '</button><span class="keys-sep" aria-hidden="true">·</span><button type="button" class="linkbtn keys-link" id="keysbtn" aria-keyshortcuts="?">Keys</button></div>' +
      '<dialog class="dlg keys-dlg" id="keysdlg" aria-labelledby="keys-h"><div class="dlg-in"><div class="dlg-top"><h2 id="keys-h">Keys</h2><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' + keysHTML() + '</div></dialog>' +
      '<form class="parkform" id="parkform" hidden><label for="parktext">Park it without leaving this card</label><div class="parkrow"><input id="parktext" type="text" aria-describedby="parkhint" autocomplete="off" placeholder="A stray thought, in a few words"><button class="btn" type="submit">Park</button></div><p class="parkhint" id="parkhint">It goes to Parked and this card stays put. Fuzz brings a few parked things back each week, on days you have room, to ask if you still want them.</p></form>' +
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
  /* The cards underneath are only a stack: what's on them, or how many, stays out of view until each is the one
     in front. Except a group's: while you work through one, the rest of it shows bound together under the card. */
  function updateStack(arriveLast) {
    stack.querySelectorAll('.ghost').forEach(function (g) { g.remove(); });
    var q = Store.queue(), n = q[0] && q[0].doing ? 0 : Math.min(Math.max(q.length - 1, 0), 3), r = q[0] && runFor(q[0]);
    for (var i = n; i >= 1; i--) {
      var g = document.createElement('div'); g.className = 'ghost' + (r && q[i] && r.ids.indexOf(q[i].id) > -1 ? ' bound' : '');
      g.style.transform = 'translateY(-' + (i * 9) + 'px) scale(' + (1 - i * 0.035) + ')';
      if (arriveLast && i === n && q.length - 1 <= 3) g.classList.add('arrive');
      stack.insertBefore(g, card);
    }
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
      /* No time at all: it stays in triage and comes up after everything else */
      tiles.push('<button type="button" class="when" data-sched="back" aria-keyshortcuts="E"><span>End of the list' + kbd('E') + '</span><small>After everything else waiting here</small></button>');
      if (!schedMore) tiles.push('<button type="button" class="when when-more" data-sched="more" aria-keyshortcuts="M"><span>More times' + kbd('M') + '</span><small>' + (all.length > 3 ? 'Later options, or an exact time' : 'Or an exact time') + '</small></button>');
      var meta = it.state === 'review' ? 'Pick a rough time. The draft waits, unsent, and comes back then for your OK.'
        : it.result ? 'Pick a rough time. What Fuzz found waits, and comes back then to ask if it’s done.'
        : 'Pick a rough time. Fuzz finds the right moment around your day. Anything you wrote in the instructions, Fuzz looks into before it comes back.';
      return '<div class="sched-panel"><h3 id="sched-h" tabindex="-1">When should this come back?</h3><p class="meta">' + meta + '</p>' +
        '<div class="when-grid">' + tiles.join('') + '</div>' +
        (schedMore ? '<div class="exact" id="exact" hidden><label for="exact-dt">Exact time</label><input type="datetime-local" id="exact-dt"><button type="button" class="btn small primary" data-sched="exact-go">Schedule for this time</button></div>' : '') +
        '<div class="sched-links">' + (schedMore ? '<button type="button" class="linkbtn" data-sched="exact">Pick an exact time instead</button>' : '') + '<button type="button" class="linkbtn" data-sched="cancel" aria-keyshortcuts="Escape">Back to the card</button></div></div>';
    }
    if (askingWho) {
      /* Waiting is for when you're blocked until someone gets back to you, so it names who. Their own work isn't yours to track. */
      var names = Store.waitNames(it);
      return '<form class="sched-panel" id="wait-form"><h3 id="wait-h"><label for="wait-who">Who are you waiting on?</label></h3>' +
        '<p class="meta">Only when you’re blocked until they get back to you. Fuzz checks back in a few days, sooner if they reply. If it’s their task, not yours, let it go instead.</p>' +
        (names.length ? '<div class="quick" role="group" aria-label="People on this task">' + names.map(function (nm, i) { return '<button type="button" class="chip" data-who="' + esc(nm) + '" aria-keyshortcuts="' + (i + 1) + '">' + esc(nm) + kbd(i + 1) + '</button>'; }).join('') + '</div>' : '') +
        '<div class="parkrow"><input id="wait-who" type="text" autocomplete="off" placeholder="A name" value="' + esc(edits[it.id + ':who'] || '') + '"><button class="btn primary" type="submit">Wait on them</button></div>' +
        '<div class="sched-links"><button type="button" class="linkbtn" data-act="wait-cancel" aria-keyshortcuts="Escape">Back to the card</button></div></form>';
    }
    if (askingFind) {
      /* Find out…: a question for Fuzz. The task stays yours; the card comes back right after the one in front. */
      var pre = edits[it.id + ':find'] != null ? edits[it.id + ':find'] : (it.gaps && it.gaps.length ? 'Find ' + it.gaps.join(' and ') : '');
      return '<form class="sched-panel" id="find-form"><h3 id="find-h"><label for="find-q">What do you need to know?</label></h3>' +
        '<p class="meta">Fuzz looks it up and adds the answer to this card. It stays yours, and comes back right after the one you’re on.</p>' +
        '<div class="parkrow"><input id="find-q" type="text" autocomplete="off" placeholder="What did Marcus say about the setup?" value="' + esc(pre) + '"><button class="btn primary" type="submit">Find out</button></div>' +
        '<div class="sched-links"><button type="button" class="linkbtn" data-act="find-cancel" aria-keyshortcuts="Escape">Back to the card</button></div></form>';
    }
    if (booking) {
      /* Book time: you'll do it then, so the time is held. It comes back first in the list, in work mode. */
      var bo = Store.bookOptions(it);
      return '<div class="sched-panel"><h3 id="book-h" tabindex="-1">When will you do it?</h3><p class="meta">' + esc(it.sizeLabel ? it.sizeLabel + '. ' : '') + 'Fuzz holds the time, and the task opens first in the list when it starts.</p>' +
        '<div class="when-grid">' + (bo.length ? bo.map(function (o, n) { return '<button type="button" class="when" data-book="' + n + '" aria-keyshortcuts="' + (n + 1) + '"><span>' + esc(o.label) + kbd(n + 1) + '</span><small>' + esc(o.focus ? 'In a Focus time slot' : o.note || 'Not a focus slot') + '</small></button>'; }).join('') : '<p class="meta">No free time before it’s due. Try Later instead.</p>') + '</div>' +
        '<div class="sched-links"><button type="button" class="linkbtn" data-act="book-cancel" aria-keyshortcuts="Escape">Back to the card</button></div></div>';
    }
    if (pausing) {
      /* Pause the working card: a line on where you left off, for when you pick it up */
      return '<form class="sched-panel" id="pause-form"><h3><label for="pause-q">Where did you leave off?</label></h3><p class="meta">Optional. It goes in the notes, so picking it up again is quick.</p>' +
        '<div class="parkrow"><input id="pause-q" type="text" autocomplete="off" placeholder="Drafted the intro; numbers next"><button class="btn primary" type="submit">Pause</button></div>' +
        '<div class="sched-links"><button type="button" class="linkbtn" data-act="pause-cancel" aria-keyshortcuts="Escape">Back to it</button></div></form>';
    }
    if (wayOpen || it.inTheWay) {
      /* What's in the way? Asked once when a card sits in front a while, or after two trips to the end of the list */
      return '<div class="sched-panel way"><h3 id="way-h" tabindex="-1">What’s in the way?</h3><p class="meta">No wrong answer. Pick the closest.</p>' +
        '<div class="when-grid">' +
        '<button type="button" class="when" data-act="way-find" aria-keyshortcuts="1"><span>I need to know something' + kbd(1) + '</span><small>Fuzz finds out, and the card comes back next</small></button>' +
        '<button type="button" class="when" data-act="way-big" aria-keyshortcuts="2"><span>This is a big one' + kbd(2) + '</span><small>Do it now, book time, after the others, or just the first step</small></button>' +
        '<button type="button" class="when" data-act="way-decide" aria-keyshortcuts="3"><span>I can’t decide' + kbd(3) + '</span><small>Fuzz lays out the options with one it suggests</small></button>' +
        '<button type="button" class="when" data-act="way-draft" aria-keyshortcuts="4"><span>I don’t want to write it' + kbd(4) + '</span><small>Fuzz drafts it for your OK</small></button>' +
        '<button type="button" class="when" data-act="way-notnow" aria-keyshortcuts="5"><span>Not now' + kbd(5) + '</span><small>After the others, no penalty</small></button>' +
        '</div>' + (it.inTheWay ? '' : '<div class="sched-links"><button type="button" class="linkbtn" data-act="way-dismiss" aria-keyshortcuts="Escape">Never mind</button></div>') + '</div>';
    }
    if (it.doing) {
      /* The working card: the rest of the queue is out of view. Its ways out. */
      return '<div class="actions working-actions">' +
        '<button type="button" class="btn primary done-btn" data-act="done" aria-keyshortcuts="D"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Done' + kbd('D') + '</button>' +
        (it.blockEnd ? '<button type="button" class="btn" data-act="keepgoing" aria-keyshortcuts="K">Keep going' + kbd('K') + '</button>' : '') +
        '<button type="button" class="btn" data-act="pause" aria-keyshortcuts="Z">Pause' + kbd('Z') + '</button>' +
        '<button type="button" class="btn" data-act="assign" aria-keyshortcuts="A">Hand to Fuzz' + kbd('A') + '</button>' +
        '<button type="button" class="btn" data-act="claude" aria-keyshortcuts="C">Work in ' + esc(Store.workIn) + kbd('C') + '</button>' +
        '<button type="button" class="btn" data-act="book" aria-keyshortcuts="B">' + (it.firstStepMode ? 'Book the rest' : 'Book time') + kbd('B') + '</button>' +
        '<button type="button" class="btn" data-act="findout" aria-keyshortcuts="Q">Find out…' + kbd('Q') + '</button></div>';
    }
    if (it.state === 'review') return reviewActionsHTML(it);
    /* A result: what Fuzz found is the thing you asked for, so Done leads and Assign is the way to send him further.
       Not sure yet? Ask me later opens the Schedule picker, and the result comes back to ask again. */
    var res = !!it.result, join = !!it.joinReply && !res;
    /* A late ask from a thread whose reply waits for your OK: joining that reply leads */
    /* A big task leads with four choices, so it gets booked or pushed instead of ground through */
    var big = !join && !res && Store.isBig(it);
    var bigRow = big ? '<div class="lead-choice big-choice"><p class="meta">' + esc((it.sizeLabel ? it.sizeLabel + '. ' : '') + 'A big one. How do you want to take it?') + '</p><div class="lead-btns">' +
      '<button type="button" class="btn' + (it.suggested === 'do_now' ? ' primary' : '') + '" data-act="donow">Do it now</button>' +
      '<button type="button" class="btn' + (it.suggested !== 'do_now' ? ' primary' : '') + '" data-act="book" aria-keyshortcuts="B">Book time' + kbd('B') + '</button>' +
      '<button type="button" class="btn" data-act="afterothers">After the others</button>' +
      '<button type="button" class="btn" data-act="firststep">Just the first step</button></div></div>' : '';
    var joinRow = join ? '<div class="lead-choice"><p class="meta">' + esc(it.joinReason || 'A reply to this thread is waiting for your OK.') + '</p>' +
      '<button type="button" class="btn primary" data-act="joinreply">Add to the reply</button></div>' : '';
    var assignBtn = '<button type="button" class="btn' + (res || join || big || it.suggestFindOut ? '' : ' primary') + '" data-act="assign" aria-keyshortcuts="A"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' + (res ? 'Send Fuzz further' : 'Assign to Fuzz') + kbd('A') + '</button>';
    return joinRow + bigRow + '<div class="actions' + (res ? ' result' : '') + '">' + (res ? '' : assignBtn) +
      (res ? '' : '<button type="button" class="btn" data-act="claude" aria-keyshortcuts="C">Work in ' + esc(Store.workIn) + kbd('C') + '</button>') +
      (res ? '' : '<button type="button" class="btn' + (it.suggestFindOut && !join ? ' primary' : '') + '" data-act="findout" aria-keyshortcuts="Q">Find out…' + kbd('Q') + '</button>') +
      (res ? '' : '<button type="button" class="btn" data-act="schedule" aria-keyshortcuts="S"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Later' + kbd('S') + '</button>') +
      (res || big ? '' : '<button type="button" class="btn" data-act="book" aria-keyshortcuts="B">Book time' + kbd('B') + '</button>') +
      '<div class="split"><button type="button" class="btn done-btn' + (res ? ' primary' : '') + '" data-act="done" aria-keyshortcuts="D"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Done' + kbd('D') + '</button>' +
        '<button type="button" class="btn more-btn" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="Clear it another way" title="Clear it another way"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="menu" role="menu" id="moremenu" hidden aria-label="Clear it another way"><p class="menu-h" aria-hidden="true">Clear it another way</p>' +
          (big ? '' : '<button type="button" role="menuitem" data-act="donow"><b>Do it now</b><span>Open it as your working card, with the rest of the list out of view.</span></button>' +
          '<button type="button" role="menuitem" data-act="afterothers"><b>After the others</b><span>To the end of this session. No penalty.</span></button>') +
          '<button type="button" role="menuitem" data-act="park" aria-keyshortcuts="P"><b>Park it' + kbd('P') + '</b><span>Out of triage with no date. It waits in Parked until someone follows up, or you bring it back.</span></button>' +
          '<button type="button" role="menuitem" data-act="waiting" aria-keyshortcuts="W"><b>Waiting on someone' + kbd('W') + '</b><span>You’re blocked until they get back to you. Fuzz checks back.</span></button>' +
          '<button type="button" role="menuitem" data-act="theirs" aria-keyshortcuts="X"><b>Not mine' + kbd('X') + '</b><span>It’s someone else’s to do. Fuzz lets it go, and brings it back if a new ask needs you.</span></button>' +
        '</div></div>' + (res ? '<button type="button" class="btn" data-act="schedule" aria-keyshortcuts="S">Ask me later' + kbd('S') + '</button>' + assignBtn : '') + '</div>';
  }

  /* The drop zone shows only while a file is dragged onto the screen; + is the way in otherwise */
  function dropHTML() {
    return '<div class="drop" id="adrop" hidden><button type="button" class="dropbtn" id="adropbtn" tabindex="-1"><span class="dropicon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></span>' +
      '<span class="droptxt"><b>Drop files anywhere</b><small>Fuzz reads them with your instructions. They show up under Sources.</small></span></button>' +
      '<input type="file" id="afile" multiple hidden></div>';
  }
  function addFiles(list) {
    var it = cur(), picked = Array.prototype.slice.call(list || []);
    if (!it || !picked.length) return;
    /* A file you just added is part of what you're asking: it's picked to read with the instructions */
    picked.forEach(function (f) { setRef(it, { title: f.name }, true); });
    Store.attach(it.id, picked);
    var line = picked.length === 1 ? 'Got ' + picked[0].name + '. I’ll read it with the task.' : 'Got ' + picked.length + ' files. I’ll read them with the task.';
    Fuzz.say(line, { type: false }); Say.announce(line);
  }

  /* Sources you point Fuzz to with this ask. A source is known by its core id, or by its name until it has one
     (a file still uploading), so a pick made by name still holds once the core's copy arrives. */
  function srcKey(s) { return s.id != null ? 'id:' + s.id : 'name:' + s.title; }
  function isPicked(it, s) { var r = refs[it.id] || []; return r.indexOf(srcKey(s)) > -1 || r.indexOf('name:' + s.title) > -1; }
  function pickedRefs(it) { return it.sources.filter(function (s) { return isPicked(it, s); }); }
  function setRef(it, s, on) {
    var r = (refs[it.id] || []).filter(function (k) { return k !== srcKey(s) && k !== 'name:' + s.title; });
    if (on) r.push(srcKey(s));
    refs[it.id] = r;
  }
  function refChipsHTML(it) {
    var on = pickedRefs(it);
    if (!on.length) return '';
    return '<ul class="refchips" aria-label="Fuzz reads these first">' + on.map(function (s) {
      return '<li class="refchip"><span class="pill pill--muted">' + esc(s.type) + '</span><span class="refchip-t">' + esc(s.title) + '</span>' +
        '<button type="button" class="refx" data-unref="' + esc(srcKey(s)) + '" aria-label="Don’t point Fuzz to ' + esc(s.title) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>';
    }).join('') + '</ul>';
  }
  /* + adds a source to this ask, as in a chat box: upload a file, or pick one the task already has */
  function refsHTML(it) {
    var n = it.sources.length, open = !!refPick[it.id] && n > 0;
    return '<div class="composer-bar"><div class="plus"><button type="button" class="plusbtn" data-act="plus" aria-haspopup="menu" aria-expanded="false" aria-controls="plusmenu" aria-label="Add a source for Fuzz" title="Add a source"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
      '<div class="menu plusmenu" role="menu" id="plusmenu" hidden aria-label="Add a source">' +
        '<button type="button" role="menuitem" data-act="upload"><b>Upload files</b><span>Or drag them anywhere onto the screen.</span></button>' +
        (n ? '<button type="button" role="menuitem" data-act="refpick"><b>Pick from Sources</b><span>' + n + (n === 1 ? ' source' : ' sources') + ' on this task to point Fuzz to.</span></button>' : '') +
      '</div></div>' + Dictate.button('instr', 'Dictate instructions', 'plusbtn') + '<div class="refchips-wrap" id="refchips">' + refChipsHTML(it) + '</div></div>' +
      '<fieldset class="refpick" id="refpick"' + (open ? '' : ' hidden') + '><legend>Point Fuzz to these sources</legend>' + it.sources.map(function (s) {
        return '<label class="refopt"><input type="checkbox" data-ref="' + esc(srcKey(s)) + '"' + (isPicked(it, s) ? ' checked' : '') + '><span class="pill pill--muted">' + esc(s.type) + '</span><span class="refopt-t">' + esc(s.title) + '</span></label>';
      }).join('') + '<button type="button" class="linkbtn refpick-done" data-act="refpick">Done</button></fieldset>';
  }
  function plusMenu(open, keepFocus) {
    var m = $('#plusmenu'), b = card.querySelector('[data-act="plus"]'); if (!m || !b) return;
    m.hidden = !open; b.setAttribute('aria-expanded', String(open));
    if (open) m.querySelector('button').focus(); else if (!keepFocus) b.focus();
  }
  function paintRefs() { var it = cur(), el = $('#refs'); if (it && el) el.innerHTML = refsHTML(it); }
  function paintRefChips() { var it = cur(), el = $('#refchips'); if (it && el) el.innerHTML = refChipsHTML(it); }

  function richAvail(it) {
    var a = [];
    if (it.conversation.length) a.push(['conversation', 'Conversation', it.conversation.length]);
    if (it.contextMd) a.push(['context', 'Context', null]);
    else if (it.context.length) a.push(['context', 'Context', it.context.length]);
    if (it.people && it.people.length) a.push(['people', 'People', it.people.length]);
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
    else if (t === 'people') body = UI.peopleHTML(it.people);
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
    return '<div class="title-block"><h3 class="task-title">' + esc(it.title) + '</h3><div class="chips">' + ageChip(it) + '<span class="meta">' + esc(it.meta || '') + '</span>' + (it.sizeLabel ? '<span class="sizechip' + (Store.isBig(it) ? ' big' : '') + '">' + esc(it.sizeLabel) + '</span>' : '') + '</div>' + partOfHTML(it) + '</div>';
  }
  /* A group is context on the card, never a card of its own: one line, which opens the group sheet */
  function partOfHTML(it) {
    var line = Store.partOf(it, true); if (!line) return '';
    return '<button type="button" class="partof" data-act="group"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/></svg>' + esc(line) + '</button>';
  }
  /* ---------- Working through a group ----------
     A group's cards come one at a time, back to back. While you go through them a band above the card names
     the group with a dot per ask, and a tray under it shows what you've answered, which Fuzz is collecting:
     tap a chip to bring that card back and answer it again. After the last one the tray folds into Fuzz and
     he says what he'll do. The core holds what you hand Fuzz until then, and works it as one claim. */
  var grun = null;   /* {gid, title, source, ids, entered} */
  var GROUP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/></svg>';
  function inGroupQueue(gid) { return Store.queue().filter(function (i) { return i.group === gid && !i.atEnd; }); }
  /* The run this card belongs to: the one under way, or a new one when its group has two or more cards waiting */
  function runFor(it) {
    var g = it && Store.groupOf(it); if (!g) return null;
    var q = inGroupQueue(g.id);
    if (grun && grun.gid === g.id) { q.forEach(function (i) { if (grun.ids.indexOf(i.id) < 0) grun.ids.push(i.id); }); return grun; }
    if (q.length < 2 || q.indexOf(it) < 0) return null;
    return { gid: g.id, title: g.title, source: g.source, ids: q.map(function (i) { return i.id; }), entered: false };
  }
  function answeredIn(r) { return r.ids.filter(function (id) { return !Store.inQueue(id); }); }
  function runOver(r) { return r && r.ids.length && answeredIn(r).length === r.ids.length; }
  /* What you answered, as the chip says it */
  function saidOn(it) {
    if (!it) return 'Answered';
    return ({ ai: 'Fuzz', 'ai-queued': 'Fuzz', done: 'Done', scheduled: 'Later', parked: 'Parked', session: 'In ' + Store.workIn,
      review: 'Needs your OK', sending: 'Sending', mine: 'Yours', dropped: 'Dropped', resolved: 'Answered' })[it.state] ||
      (it.state === 'waiting' ? 'Waiting on ' + (it.waitingOn || 'someone') : it.state === 'letgo' ? (it.theirs ? 'Not mine' : 'Let go') : 'Answered');
  }
  function whereFrom(r) { return r.source === 'email' ? 'This email' : r.source === 'meeting' ? 'That meeting' : r.source === 'slack' ? 'Those messages' : '“' + r.title + '”'; }
  function paintRun(it) {
    var band = $('#gband'), tray = $('#gtray'); if (!band) return;
    var r = it ? runFor(it) : grun;
    if (r && r !== grun) { grun = r; Store.setRun(r.gid); }
    if (!grun || (it && grun.ids.indexOf(it.id) < 0 && !runOver(grun))) { band.hidden = true; tray.hidden = true; return; }
    var done = answeredIn(grun), n = grun.ids.length, at = Math.min(done.length + 1, n);
    band.innerHTML = '<div class="gband-t">' + GROUP_SVG + '<span><span class="gband-k">Working through</span> ' + esc(grun.title) + '</span></div>' +
      '<ol class="gdots" aria-hidden="true">' + grun.ids.map(function (id) { var d = done.indexOf(id) > -1, now = it && it.id === id; return '<li class="' + (d ? 'on' : now ? 'now' : '') + '"></li>'; }).join('') + '</ol>' +
      '<span class="sr" aria-live="polite">' + esc(grun.title) + ', ask ' + at + ' of ' + n + '</span>' +
      '<button type="button" class="linkbtn" data-run="later">Finish later</button>';
    band.hidden = false;
    tray.innerHTML = done.length ? '<p class="gtray-h">' + Fuzz.mini('good', { cls: 'gtray-av' }) + 'Collecting your answers</p><ul class="gchips">' + done.map(function (id) {
      var x = Store.item(id), lab = saidOn(x), fixed = !x || x.state === 'resolved' || x.state === 'dropped';
      return '<li><button type="button" class="gchip" data-run-chip="' + esc(id) + '"' + (fixed ? ' disabled' : '') + ' aria-label="' + esc((x ? x.title : 'This ask') + ': ' + lab + (fixed ? '' : '. Bring it back to answer again')) + '"><span class="gchip-t">' + esc(x ? x.title : '') + '</span><span class="gchip-a">' + esc(lab) + '</span></button></li>';
    }).join('') + '</ul>' : '';
    tray.hidden = !done.length;
  }
  /* Fuzz's line once he has every answer: the core's plan in live mode, else worked out from the tray */
  function planLine(r) {
    var line = Live.on() && Live.takeCollected(); if (line) return line;
    var mine = r.ids.map(Store.item).filter(Boolean), k = mine.filter(function (x) { return x.state === 'ai' || x.state === 'ai-queued'; }).length;
    var num = ['', 'it', 'the two', 'the three', 'the four', 'the five'][k] || 'the ' + k;
    return 'Got all ' + r.ids.length + '.' + (k > 1 ? ' I’ll look into ' + num + ' together' + (r.source === 'email' || r.source === 'slack' ? ' and draft one reply' : '') + '.' : k ? ' I’ll get on it.' : ' Nothing for me this time.');
  }
  /* Starting a group: Fuzz says so, and starts collecting */
  function enterRun() {
    if (!grun || grun.entered) return false;
    grun.entered = true;
    Fuzz.setMood('eager'); if (!Fuzz.isCalm()) Fuzz.fxOn('scan', 900);
    var line = whereFrom(grun) + ' has ' + grun.ids.length + ' asks. Let’s go through them, then I’ll pull it together.';
    Fuzz.say(line, { type: false }); Say.announce(line);
    setTimeout(function () { if (alive && Fuzz.mood() === 'eager') Fuzz.setMood('thinking'); }, 2200);
    return true;
  }
  /* The last answer is in: the tray folds into Fuzz, he says the plan, and the band goes */
  async function exitRun() {
    var r = grun; grun = null; Store.setRun(null);
    var tray = $('#gtray'), band = $('#gband'), bot = root.querySelector('#bot');
    var chips = tray ? [].slice.call(tray.querySelectorAll('.gchip')) : [];
    if (chips.length && bot) await Promise.all(chips.map(function (c, i) { return sleep(i * 70).then(function () { return Fuzz.flyTo(c, bot, { scale: 0.12, rot: -10, dur: 520 }); }); }));
    if (tray) tray.hidden = true;
    if (band) band.hidden = true;
    var line = planLine(r);
    Fuzz.setMood('happy'); if (!Fuzz.isCalm()) Fuzz.fxOn('rev', 1000); Fuzz.pAnim('hop');
    Fuzz.say(line, { type: false }); Say.announce(line);
    await sleep(1400);
    if (Fuzz.mood() === 'happy') Fuzz.setMood('idle');
  }
  /* Finish later: Fuzz goes ahead with what you've answered; the rest go to the end of the list */
  function finishLater() {
    if (!grun || busy) return;
    var r = grun, g = Store.group(r.gid), rest = r.ids.filter(function (id) { return Store.inQueue(id); });
    grun = null; Store.setRun(null); paintRun(null);
    var say = function (line) { Fuzz.setMood('caring'); line = line || 'Okay. I’ll go ahead with what you’ve told me; the rest come back later.'; Fuzz.say(line, { type: false }); Say.announce(line); };
    if (Live.on() && g && g.coreId) Live.finishLater(g.coreId).then(say, function (e) { Say.tell('That didn’t work: ' + e.message, { stay: true }); });
    else { rest.forEach(function (id) { Store.toBack(id); }); say(); V.refresh(); }
  }
  /* A chip in the tray: bring that card back to the front to answer it again */
  function reopenAsk(id) {
    var it = Store.item(id); if (!it || busy) return;
    offer('Brought “' + it.title + '” back to answer again.', Store.track([id], function () { Store.bringBack(id, 'front'); }));
    Fuzz.setMood('idle'); Fuzz.say('Sure, let’s look at that one again.', { type: false });
    V.refresh();
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
    if (it.kind === 'entity' && it.entity === 'is_task' && it.asks) {
      h += '<fieldset class="asks"><legend>Tick the ones that are yours</legend><ul class="mentions">' + it.asks.map(function (a) {
        return '<li><label class="check"><input type="checkbox" data-ask="' + a.id + '"' + (edits[it.id + ':ask' + a.id] ? ' checked' : '') + '> <span>' + esc(a.title) + '</span></label></li>';
      }).join('') + '</ul></fieldset>';
    }
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
  function holdHTML(it) {
    return tagrow(it) + askHTML(it.holdPrompt || 'Add a hold for this to your calendar?') +
      '<div class="title-block"><h3 class="task-title">' + esc(it.title) + '</h3><div class="chips"><span class="meta">' + esc(it.holdWhen || '') + '</span></div></div>' +
      '<p class="meta">' + esc(it.holdRemove ? 'It’s done before its block, so the time can go back to you.' : 'Fuzz adds an event of your own in that time, named after the task. Your other events are never changed.') + '</p>' +
      '<div id="actions"><div class="actions">' +
      '<button type="button" class="btn primary" data-act="hold-approve">' + (it.holdRemove ? 'Remove it' : 'Add the hold') + '</button>' +
      (it.holdRemove ? '' : '<button type="button" class="btn" data-act="hold-always">Always allow for my calendar</button>') +
      '<button type="button" class="btn" data-act="hold-skip">' + (it.holdRemove ? 'Keep it' : 'Skip') + '</button></div></div>';
  }
  function cardHTML(it) {
    if (it.cardKind === 'hold') return holdHTML(it);
    if (it.state === 'review') return reviewHTML(it);
    var isTask = it.kind === 'task';
    /* The onboarding's first card carries its one lesson (js/onboarding.js) */
    var g = isTask && Onboard.guide(it);
    var parkrev = isTask && it.review, checkback = isTask && it.checkBack, putoff = isTask && it.putOff && !parkrev && !checkback;
    var stale = isTask && !parkrev && !checkback && !putoff && it.stage === 'stale' && !keptStale[it.id] && !scheduling;
    var h = (g ? g.html : '') + tagrow(it) + askHTML(it.ask) + titleHTML(it) + duePanel(it);
    /* What Fuzz found comes before what you tell him to do, so you edit with the answer in view */
    if (isTask && !stale && it.aiNote) h += findingHTML(it);
    /* What Fuzz couldn't find: Find out… comes first */
    if (isTask && it.gaps && it.gaps.length && !it.foundOut) h += '<p class="gaps"><strong>Fuzz couldn’t find</strong> ' + esc(it.gaps.join(', ')) + '. Find out… asks for it.</p>';
    if (it.handedBack && it.quick && it.quick.length) {
      h += '<div class="quick" role="group" aria-label="Quick answers">' + it.quick.map(function (q, i) { return '<button type="button" class="chip" data-quick="' + i + '" aria-keyshortcuts="' + (i + 1) + '">' + esc(q.label || q) + kbd(i + 1) + '</button>'; }).join('') + '</div>';
    }

    if (checkback) {
      /* Fuzz can't know when someone else is done, so it asks you. A reply from them would have brought it back sooner. */
      h += '<section class="stale parkrev checkback"' + (scheduling || askingWho ? ' hidden' : '') + '><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><div><h3>Waiting on ' + esc(it.waitingOn || 'them') + ' since ' + esc(it.waitedFor || 'a while') + '</h3><p>Nothing from them yet that Fuzz could see. Fuzz can draft a nudge for your OK.</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn" data-act="gotit" aria-keyshortcuts="G">They got back to me' + kbd('G') + '</button>' +
        '<button type="button" class="btn primary" data-act="nudge" aria-keyshortcuts="U">Nudge them' + kbd('U') + '</button>' +
        '<button type="button" class="btn" data-act="keepwaiting" aria-keyshortcuts="K">Keep waiting' + kbd('K') + '</button>' +
        '<button type="button" class="btn dark" data-act="letgo" aria-keyshortcuts="L">Let it go' + kbd('L') + '</button></div></section>' +
        '<div id="actions"></div>';
    } else if (parkrev) {
      /* The parked review (GTD's look at Someday/Maybe): one question, four answers. What Fuzz found, if
         anything, reads above. Bring it back turns this into an ordinary card, first in line. */
      var go = it.leansGo;
      h += '<section class="stale parkrev"' + (scheduling ? ' hidden' : '') + '><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h18M5 7v12h14V7M9 11h6M4 3h16v4H4z"/></svg><div><h3>From Parked</h3><p>' +
        (go ? 'You’ve kept this a few times. Letting it go is fine, and you can bring it back from Let go anytime.' : 'Parked tasks never nag, so now and then Fuzz asks. Keep it, do it, give it a time or let it go.') + '</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn' + (go ? '' : ' primary') + '" data-act="keepparked" aria-keyshortcuts="K">Keep it parked' + kbd('K') + '</button>' +
        '<button type="button" class="btn" data-act="clarify" aria-keyshortcuts="R">Bring it back' + kbd('R') + '</button>' +
        '<button type="button" class="btn" data-act="schedule" aria-keyshortcuts="S">Give it a time' + kbd('S') + '</button>' +
        '<button type="button" class="btn' + (go ? ' primary' : ' dark') + '" data-act="letgo" aria-keyshortcuts="L">Let it go' + kbd('L') + '</button></div></section>' +
        '<div id="actions">' + (scheduling ? actionsHTML(it) : '') + '</div>';
    } else if (putoff) {
      /* It keeps getting a new time: usually the next step isn't clear, or it doesn't matter much anymore.
         Fuzz can work out the first step; or it still matters, or it can rest or go. Giving it a time starts over. */
      h += '<section class="stale parkrev putoff"' + (scheduling ? ' hidden' : '') + '><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg><div><h3>Back again</h3><p>When a task keeps getting a new time, often the next step isn’t clear, or it doesn’t matter much anymore. I can work out the first step for you.</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn primary" data-act="unclear" aria-keyshortcuts="H">Help me start' + kbd('H') + '</button>' +
        '<button type="button" class="btn" data-act="stillmatters" aria-keyshortcuts="K">It still matters' + kbd('K') + '</button>' +
        '<button type="button" class="btn" data-act="schedule" aria-keyshortcuts="S">Give it a time' + kbd('S') + '</button>' +
        '<button type="button" class="btn" data-act="park" aria-keyshortcuts="P">Park it' + kbd('P') + '</button>' +
        '<button type="button" class="btn dark" data-act="letgo" aria-keyshortcuts="L">Let it go' + kbd('L') + '</button></div></section>' +
        '<div id="actions">' + (scheduling ? actionsHTML(it) : '') + '</div>';
    } else if (stale) {
      /* One decision at a time: the usual actions wait until you say you still care. */
      h += '<section class="stale"><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg><div><h3>Quiet for ' + esc(it.age) + '</h3><p>Nothing new has come up. Letting it go is fine. It moves to Let go, where you can bring it back anytime.</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn" data-act="keep" aria-keyshortcuts="K">Yes, keep it' + kbd('K') + '</button><button type="button" class="btn dark" data-act="letgo" aria-keyshortcuts="L">Let it go' + kbd('L') + '</button></div></section>';
    } else if (isTask) {
      var val = edits[it.id + ':instr'] !== undefined ? edits[it.id + ':instr'] : (it.instr || it.hint || '');
      h += '<div class="instr"><div class="instr-top"><label for="instr">Instructions for Fuzz</label><span>Suggested by Fuzz. Edit anything.</span></div><div class="composer"><textarea id="instr" rows="3">' + esc(val) + '</textarea><div class="refs" id="refs">' + refsHTML(it) + '</div></div>' + dropHTML() + '</div>';
      h += '<div id="actions">' + actionsHTML(it) + '</div>';
    } else {
      h += '<p class="incoming">' + UI.text(it.incoming) + '</p>' + evidenceHTML(it);
      /* Fuzz asking what he may read (the onboarding's last task) is a plain yes or no: no notes, no Not sure */
      if (!it.kickoffAsk) h += '<div class="instr"><div class="instr-top"><label for="note">' + esc(it.boxLabel) + '</label><span class="instr-side"><span>Optional. Edit anything.</span>' + Dictate.button('note', 'Dictate a note') + '</span></div><textarea id="note" rows="2" placeholder="' + esc(it.placeholder || '') + '">' + esc(edits[it.id + ':note'] !== undefined ? edits[it.id + ':note'] : (it.hint || '')) + '</textarea></div>';
      h +=
        '<div class="actions ent"><button type="button" class="btn primary" data-act="ent-primary" aria-keyshortcuts="1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' + esc(it.primary) + kbd(1) + '</button>' +
        '<button type="button" class="btn" data-act="ent-secondary" aria-keyshortcuts="2">' + esc(it.secondary) + kbd(2) + '</button>' +
        (it.third ? '<button type="button" class="btn" data-act="ent-third" aria-keyshortcuts="3">' + esc(it.third) + kbd(3) + '</button>' : '') +
        (it.kickoffAsk ? '' : '<button type="button" class="btn" data-act="ent-later" aria-keyshortcuts="' + (it.third ? 4 : 3) + '">Not sure yet' + kbd(it.third ? 4 : 3) + '</button>') + '</div>';
    }

    if (isTask && !parkrev && !checkback && !putoff) h += '<p class="incoming">' + UI.text(it.incoming) + '</p>';
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
      '<form class="revise" id="revise" hidden><label for="revise-text">Tell Fuzz what to change</label><div class="parkrow"><input id="revise-text" type="text" autocomplete="off" placeholder="For example: shorter, and mention the two maybes">' + Dictate.button('revise-text', 'Dictate what to change') + '<button class="btn" type="submit">Send back to Fuzz</button></div></form>';
  }

  /* Text boxes grow to show all their text, so nothing is cut off on a narrow screen */
  function fit(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px'; }
  function renderCard(it) {
    lastTask = it; shownCard = { id: it.id, cardId: it.cardId, kind: it.kind }; $('#checkin').hidden = true;
    clearTimeout(rushTimer); card.getAnimations().forEach(function (a) { a.cancel(); });
    scheduling = false; askingWho = false; askingFind = false; booking = false; pausing = false; wayOpen = false; if (tab && !richAvail(it).some(function (a) { return a[0] === tab; })) tab = null;
    card.className = 'card' + (it.doing ? ' working' : ''); card.style.display = ''; card.style.visibility = '';
    seen(it);
    card.innerHTML = cardHTML(it);
    if (Dictate.active() && !document.contains(Dictate.field())) Dictate.abort();
    var ex = stack.querySelector('.empty'); if (ex) ex.remove();
    var dt = $('#drop-label');
    $('#dropbtn').textContent = it.state === 'review' ? 'Discard this draft' : it.kind === 'task' ? 'Drop this task' : 'Dismiss this question';
    $('#dropbtn').hidden = false;
    paintDue(it);
    card.querySelectorAll('#instr, #draft').forEach(fit);
    if (busy) card.querySelectorAll('[data-act],[data-quick]').forEach(function (b) { b.disabled = true; });
    paintRun(it);
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
    /* In work mode it runs on time, not on cleared cards: you may be on one card for a long while */
    if (next && next.doing) return ciCount ? waited : Date.now() - sessionAt >= CI_GAP_MIN * 2 * 60000;
    /* nor while Fuzz is asking what he may read (the onboarding's last task): it waits until he's done */
    /* …nor partway through a group: it waits until you've been through all of it */
    return waited && cleared() >= ciNextAt && !Store.queue().some(function (i) { return i.dueAt; }) && !next.dueAt && !next.handedBack && !next.kickoff &&
      !(grun && !runOver(grun)) && !runFor(next);
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
  function forgetEdits(id) { ['instr', 'note', 'draft'].forEach(function (b) { delete edits[id + ':' + b]; }); delete refs[id]; delete refPick[id]; }
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
    if (!t || shouldCheckin(t) || (!scOpen && Onboard.setupCard(cleared(), true))) return null;
    enterCard(t);
    release();
    return t.id;
  }
  async function showNext(shown) {
    var e = epoch;
    try {
      if (runOver(grun)) await exitRun();   /* the last answer of a group is in */
      var q = Store.queue();
      if (!q.length) return zeroState();
      var t = q[0];
      if (t.id !== shown) {
        if (shouldCheckin(t)) return showCheckin();
        if (showSetup()) return;
        enterCard(t);
      } else paintRun(t);
      var inRun = grun && grun.ids.indexOf(t.id) > -1, entered = inRun && enterRun();
      if (inRun && !entered && !Fuzz.isCalm()) Fuzz.fxOn('scan', 700);   /* still gathering */
      var g = t.kind === 'task' && Onboard.guide(t);
      var rushing = t.doing && t.block && !saidRush[t.id] && Store.queue().filter(function (x) { return x !== t && x.dueAt; }).length;
      if (entered) {
        /* what he says is that you're going through a group */
      } else if (rushing) {
        /* your booked block is first; a deadline waits second, and Fuzz says so once */
        saidRush[t.id] = true;
        Fuzz.setMood('caring'); Fuzz.say(rushing + ' time-sensitive waiting after this.', { type: false }); Say.announce(rushing + ' time-sensitive waiting after this.');
      } else if (g) {
        Fuzz.setMood('happy'); Fuzz.say(g.line, { type: false }); Say.announce(g.line);
      } else laterTip(t);
      if (g) {
        /* the lesson is what he says on this card */
      } else if (t.handedBack) {
        Fuzz.glitch(600); Fuzz.setMood('sheepish'); Fuzz.setArm('scratch'); Fuzz.pAnim('shrug');
        /* don't hold the busy lock while the line types out */
        Fuzz.say(t.askBack || 'I lost the signal on this one. Can you help me with it?').then(function () { if (alive) { Fuzz.setArm('none'); settleSheepish(); } });
      } else if (t.dueAt) {
        rushBurst(t);
      } else if (t.kickoffAsk) {
        Fuzz.setMood('caring'); Fuzz.say('Your call. I only read, and you can change it later.', { type: false });
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
  /* ---------- Setup cards (js/onboarding.js): one at a time, after real work, Not now always there ---------- */
  var scState = null;
  function showSetup() {
    if (ciOpen || scOpen || !alive) return false;
    var c = Onboard.setupCard(cleared()); if (!c) return false;
    scOpen = true; scState = { card: c, step: 'ask', theme: App.prefs().theme };
    card.style.display = 'none'; $('#checkin').hidden = true; $('#dropbtn').hidden = true;
    var oldE = stack.querySelector('.empty'); if (oldE) oldE.remove();
    updateStack(false); stats();
    var sc = $('#setupcard'); sc.hidden = false; sc.className = 'card setupcard enter';
    paintSetup();
    $('#sc-h').focus({ preventScroll: true });
    Fuzz.setMood('eager'); Fuzz.say({ hours: 'First, a quick question.', lookup: 'One thing that would help me help you.', folder: 'Quick one, while I think of it.', theme: 'Fancy a change of scenery?' }[c.name], { type: false });
    return true;
  }
  function appName() { var e = scState.card.engine; return e === 'copilot' ? 'Copilot' : 'Claude Code'; }
  function paintSetup() {
    var c = scState.card, sc = $('#setupcard'), h = '<div class="tagrow"><span class="src">From Fuzz</span></div>', not = '<button type="button" class="btn" data-sc="later" aria-keyshortcuts="Escape">Not now' + kbd('Esc') + '</button>';
    if (c.name === 'hours') h = hoursHTML(c);
    else if (c.name === 'folder') {
      h += '<h2 id="sc-h" tabindex="-1">Can I save files for you?</h2><p>Some tasks end in a document, a spreadsheet or a checklist. I’d keep them in <b>Documents › Fuzz</b>, one folder per task. Nothing in it is sent anywhere.</p>' +
        '<div class="sc-actions"><button type="button" class="btn primary" data-sc="yes">Yes, use Documents › Fuzz' + kbd('↵') + '</button>' + not + '</div>';
    } else if (c.name === 'theme') {
      h += '<h2 id="sc-h" tabindex="-1">Want a different colour?</h2><p>Pick one and it changes straight away. This is the only time I’ll ask; Settings has the rest.</p>' +
        '<div class="palettes sc-pals" role="group" aria-label="Theme">' + Themes.list.map(function (t) {
          var p = Themes.palette(t.id, Themes.resolveMode(App.prefs().mode), App.prefs().contrast), on = t.id === App.prefs().theme;
          return '<button type="button" class="pal" data-sc-theme="' + t.id + '" aria-pressed="' + on + '"><span class="pal-sw" style="background:' + p.bg + ';border-color:' + p.line + '"><i style="background:' + p.accent + '"></i><i style="background:' + p.link + '"></i><i style="background:' + p.ink + '"></i></span><span class="pal-n">' + esc(t.name) + '</span></button>';
        }).join('') + '</div><div class="sc-actions"><button type="button" class="btn primary" data-sc="yes">Keep this one' + kbd('↵') + '</button>' + not + '</div>';
    } else {
      var app = appName(), s = scState.step;
      h += '<h2 id="sc-h" tabindex="-1">Want me to find your asks myself?</h2>' +
        '<p>Right now I only know what you type. Connect your email, Slack or calendar in ' + esc(app) + ', and I can read for new asks and look things up while I work. I only read with them. Nothing goes out without your yes.</p>';
      if (s === 'ask' || s === 'none') {
        h += '<ol class="sc-steps"><li><b>In ' + esc(app) + ', connect what you use.</b> ' + (c.engine === 'copilot' ? 'In Copilot, type <code>/mcp</code> and add one.' : 'On claude.ai, open Settings, then Connectors. Or type <code>/mcp</code> in Claude Code.') + '</li>' +
          '<li><b>Come back here</b> and press “I’ve connected one”. This card waits for you.</li></ol>' +
          (s === 'none' ? '<p class="setup-hint" role="status">' + (scState.error ? 'I couldn’t ask ' + esc(app) + ': ' + esc(scState.error) + ' Try again in a moment.' : 'I didn’t find anything I can read with yet. Once one is connected, try again.') + '</p>' : '') +
          '<div class="sc-actions"><button type="button" class="btn primary" data-sc="look">I’ve connected one' + kbd('↵') + '</button>' + not + '</div>';
      } else if (s === 'looking') {
        h += '<div class="setup-wait"><span class="spin" aria-hidden="true"></span><p><span role="status">Asking ' + esc(app) + ' what it can reach…</span><small>Usually about a minute. Nothing is read or changed while I ask.</small></p></div><div class="sc-actions">' + not + '</div>';
      } else if (s === 'found') {
        h += '<p><b>With these, I’d be able to:</b></p><ul class="sc-can">' + scState.tools.slice(0, 6).map(function (t) { return '<li>' + esc(t.does || t.allow) + '</li>'; }).join('') + (scState.tools.length > 6 ? '<li>…and ' + (scState.tools.length - 6) + ' more ways to look things up</li>' : '') + '</ul>' +
          '<p class="meta">Only ways to read and look things up. Settings lists each one.</p>' +
          '<div class="sc-actions"><button type="button" class="btn primary" data-sc="allow">Allow these' + kbd('↵') + '</button>' + not + '</div>';
      }
    }
    sc.innerHTML = h;
  }
  /* Fuzz's first question during the onboarding: when you work. The usual hours are the first answer, so
     one key does it; Different hours opens a picker. Esc keeps the usual hours for now. */
  function span(h) { return Onboard.clock(h[0]) + ' to ' + Onboard.clock(h[1]); }
  function hoursHTML(c) {
    var cur = (c.hours && c.hours.hours) || [8, 18.5], usual = span(cur);
    var h = '<aside class="onb-guide" aria-label="How Triage works">' + Fuzz.mini('good', { cls: 'guide-fz' }) + '<div><h3>This is Triage</h3><p>I bring you one card at a time, each with one decision. Here’s an easy one to start.</p></div></aside>' +
      '<div class="tagrow"><span class="src">A question from Fuzz</span></div>' +
      '<h2 id="sc-h" tabindex="-1">When do you work?</h2><p>I read for new asks during these hours, and stay quiet outside them. Pick the closest; you can change it any time.</p>';
    if (scState.step === 'other') {
      var opts = function (v, from) { return Onboard.hourSteps.filter(function (x) { return from ? x < 24 : x > 0; }).map(function (x) { return '<option value="' + x + '"' + (x === v ? ' selected' : '') + '>' + esc(Onboard.clock(x)) + '</option>'; }).join(''); };
      h += '<div class="onb-times"><label for="sc-from">From</label><select id="sc-from">' + opts(cur[0], true) + '</select><label for="sc-until">until</label><select id="sc-until">' + opts(cur[1], false) + '</select></div>' +
        '<label class="check"><input type="checkbox" id="sc-wkd"' + (c.hours && c.hours.weekends ? ' checked' : '') + '> <span>Weekends too</span></label>' +
        '<div class="sc-actions"><button type="button" class="btn primary" data-sc="save">Save' + kbd('↵') + '</button><button type="button" class="btn" data-sc="back">Back</button></div>';
      return h;
    }
    var choices = [['weekdays', 'Weekdays, ' + usual], ['everyday', 'Every day, ' + usual], ['none', 'No fixed hours'], ['other', 'Different hours…']];
    return h + '<div class="sc-choices" role="group" aria-label="When do you work?">' + choices.map(function (o, i) {
      return '<button type="button" class="btn' + (i === 0 ? ' primary' : '') + '" data-sc="' + o[0] + '" data-hq aria-keyshortcuts="' + (i + 1) + '">' + esc(o[1]) + kbd(i + 1) + '</button>';
    }).join('') + '</div><div class="sc-actions"><button type="button" class="btn linkbtn" data-sc="later" aria-keyshortcuts="Escape">Skip for now' + kbd('Esc') + '</button></div>';
  }
  function hoursAnswer(what) {
    var cur = (scState.card.hours && scState.card.hours.hours) || [8, 18.5], body;
    if (what === 'later') { Onboard.skipHours(); closeSetup(null); return Onboard.questionDone(); }
    if (what === 'other' || what === 'back') { scState.step = what === 'other' ? 'other' : 'ask'; paintSetup(); var f = $(what === 'other' ? '#sc-from' : '#sc-h'); if (f) f.focus({ preventScroll: true }); return; }
    if (what === 'save') {
      var a = parseFloat($('#sc-from').value), b = parseFloat($('#sc-until').value);
      if (b <= a) { Fuzz.say('That ends before it starts. Pick an end time after the start.', { type: false }); return; }
      body = { hours: [a, b], weekends: $('#sc-wkd').checked };
    } else body = what === 'none' ? { hours: null, weekends: true } : { hours: cur, weekends: what === 'everyday' };
    Onboard.answerHours(body).then(function () {
      closeSetup(null); Onboard.questionDone();   /* next, Fuzz asks for one real task */
    }, function (e) { Say.tell('I couldn’t save that: ' + e.message, { stay: true }); });
  }

  /* Ask the app what it can reach (one run of it), then offer the ways to read, in plain words */
  function lookUp() {
    var cl = scState.card.engine;
    scState.step = 'looking'; paintSetup();
    Live.discover(cl).then(function wait() {
      return Live.setup(true).then(function (r) {
        var v = r.tools.filter(function (x) { return x.client === cl; })[0];
        if (v && v.discovery && v.discovery.state === 'running') return new Promise(function (res) { setTimeout(res, 3000); }).then(wait);
        if (v && v.discovery && v.discovery.state === 'error') throw new Error(v.discovery.error);
        return v;
      });
    }).then(function (v) {
      if (!scOpen || !scState || scState.card.name !== 'lookup') return;
      var look = (v ? v.tools : []).filter(function (x) { return x.kind === 'lookup' && x.suggested; });
      scState.view = v; scState.tools = look; scState.step = look.length ? 'found' : 'none';
      paintSetup(); $('#sc-h').focus({ preventScroll: true });
    }, function (e) {
      if (!scOpen) return;
      scState.step = 'none'; scState.error = e.message.replace(/\.?$/, '.'); paintSetup(); $('#sc-h').focus({ preventScroll: true });
    });
  }
  function closeSetup(line) {
    var sc = $('#setupcard'); sc.hidden = true; sc.innerHTML = '';
    scOpen = false; scState = null;
    Fuzz.setMood('idle');
    showNext();
    /* after the next card's arrival, so the answer is what he's saying */
    if (line) { Fuzz.say(line, { type: false }); Say.announce(line); }
  }
  function setupAnswer(what) {
    var c = scState.card;
    if (c.name === 'hours') return hoursAnswer(what);
    if (what === 'later') {
      if (c.name === 'theme' && App.prefs().theme !== scState.theme) App.setTheme(scState.theme);
      Onboard.answerSetup(c.name, 'not_now');
      return closeSetup('Okay.');
    }
    if (what === 'look') { scState.error = null; return lookUp(); }
    if (what === 'allow') {
      var v = scState.view, picks = scState.tools.map(function (t) { return t.allow; });
      Live.saveTools(v.client, v.read.concat(picks.filter(function (x) { return v.read.indexOf(x) < 0; })), v.send).then(function () {
        return Onboard.answerSetup('lookup', 'yes');
      }).then(function () { closeSetup('Done. I’ll use them from my next run.'); }, function (e) { Say.tell('I couldn’t save that: ' + e.message, { stay: true }); });
      return;
    }
    Onboard.answerSetup(c.name, 'yes').then(function () {
      closeSetup(c.name === 'folder' ? 'Done. Your files go in Documents › Fuzz.' : 'Lovely. It’s yours.');
    }, function (e) { Say.tell('I couldn’t save that: ' + e.message, { stay: true }); });
  }

  /* The later tips (docs/onboarding.md), each said once, when it first fits, after Fuzz's own line */
  function laterTip(t) {
    var key = t.state === 'review' ? 'draft' : t.kind !== 'task' ? null : t.handedBack ? 'handover' :
      t.stage === 'stale' && !t.review && !t.checkBack && !t.putOff && !keptStale[t.id] ? 'stale' : cleared() >= 5 ? 'keys' : 'park';
    if (!key || !Onboard.tip(key, true)) return;
    setTimeout(function () {
      if (!alive || cur() !== t || busy || ciOpen || scOpen) return;
      var line = Onboard.tip(key); if (line) { Fuzz.say(line, { type: false }); Say.announce(line); }
    }, t.handedBack ? 4200 : 2600);
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
    if (!quiet && showSetup()) return;
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
    var ct = !demo && Onboard.tip('checkin');
    Fuzz.say(ct || ask[1], { type: false });
    if (ct) Say.announce(ct);
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
    var read = pickedRefs(it);
    var ch = Store.track([it.id], function () { if (set) Object.assign(it, set); waited = Store.assign(it.id, instr, read); });
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
    var who = Store.workIn;
    Fuzz.setMood('stare'); Fuzz.say('Oh. ' + who + '.', { type: false });
    offer('Opened “' + it.title + '” in ' + who + '.', Store.track([it.id], function () { Store.session(it.id); }), 'Opened “' + it.title + '” in ' + who + '.' + (Live.on() ? ' It’s in a Terminal window.' : ' In this demo it just moves to Current.'));
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
    var review = it.state === 'review', res = !!it.result;
    if (review && $('#draft')) edits[it.id + ':draft'] = $('#draft').value;
    scheduling = true; schedMore = false; renderCardKeep();
    refocus($('#sched-h'));
    var st_ = Onboard.tip('schedule');
    Fuzz.setMood('eager'); Fuzz.say(st_ || (review || res ? 'No rush. When should I ask you about it again?' : 'Happy to! When should I bring it back?')); Fuzz.pAnim('hop');
    var pickedIdx = await new Promise(function (resolve) { schedResolve = resolve; });
    schedResolve = null;
    if (pickedIdx === -1) {
      scheduling = false; renderCardKeep(); Fuzz.setMood('idle'); Fuzz.say('Okay, it stays here.', { type: false });
      var sb = card.querySelector(review ? '[data-act="notnow"]' : '[data-act="schedule"]'); if (sb) { sb.disabled = false; sb.focus(); }
      return;
    }
    if (pickedIdx === -2) return toEnd(it, review ? edits[it.id + ':draft'] : undefined);
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
    Fuzz.say(review ? 'Okay. Nothing goes out. I’ll ask you again ' + when + '.' : res && !look ? 'Okay. I’ll ask you again ' + when + '.' : look ? 'On it. I’ll dig in and bring it back ' + when + '.' : 'Done! I’ll bring it back ' + when + '.');
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
  /* End of the list: no time, it stays as it is and waits behind the rest of the queue. A draft keeps your edits. */
  async function toEnd(it, text) {
    var b = card.querySelector('[data-sched="back"]'); if (b) b.classList.add('picked');
    card.querySelectorAll('[data-when],[data-sched]').forEach(function (x) { x.disabled = true; });
    /* It goes behind tasks with deadlines too, so say so when its own is close */
    if (it.dueAt && it.dueAt - Date.now() < 24 * 3600000) {
      Fuzz.setMood('worried'); Fuzz.say('Heads up, this is due soon. Moving it to the end anyway.');
      Say.announce('Heads up, this is due soon. Moving it to the end anyway.');
      await sleep(2000);
    }
    Fuzz.setMood('happy'); Fuzz.pAnim('hop');
    Fuzz.say(it.state === 'review' ? 'Okay. Nothing goes out. It’s at the end of the list.' : 'Sure. It’s at the end of the list, after everything else.');
    offer('Moved “' + it.title + '” to the end of the list.', Store.track([it.id], function () { Store.toBack(it.id, text); }));
    forgetEdits(it.id);
    var shown = null, exit = sleep(400).then(function () { return fly(card, Progress.target(), { scale: 0.06, rot: 8, dur: 520 }); }).then(function () { shown = bringNext(); });
    await Promise.all([exit, sleep(1050)]);
    stats();
    Fuzz.setMood('idle');
    await showNext(shown);
  }
  function renderCardKeep() { var it = cur(); if (!it) return; $('#actions').innerHTML = ((it.review || it.putOff) && !scheduling) || it.checkBack ? '' : actionsHTML(it); var st = card.querySelector('.stale'); if (st && scheduling) st.hidden = true; else if (st) st.hidden = false; }

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
  /* Do it now: the working card. The rest of the queue goes out of view; Fuzz stays beside it. */
  async function doNow() {
    var it = cur(); if (!it) return;
    var ch = Store.track([it.id], function () { Store.doNow(it.id); });
    offer('Started on “' + it.title + '”.', ch);
    Fuzz.setMood('eager'); Fuzz.setArm('salute'); Fuzz.say('Let’s do it. I’ll keep the rest out of the way.', { type: false });
    renderCard(cur()); updateStack(false); refocus(landing());
    await sleep(900);
    Fuzz.setArm('none'); Fuzz.setMood('idle');
  }
  /* When a card has sat in front a while (3 minutes sorting; 25 in work mode with no sign of progress) while
     you're here, Fuzz asks what's in the way, once per card. The times on screen are kept for tuning. */
  var shown = null, lastInput = 0, awayFrom = 0, awayS = 0, asked = {}, saidRush = {};
  /* Time away from the page doesn't count as time stuck, and is recorded with the card */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) awayFrom = Date.now();
    else if (awayFrom) { awayS += (Date.now() - awayFrom) / 1000; awayFrom = 0; }
  });
  function stuckAfter(it) { var w = Store.workConfig(); return (it && it.doing ? w.work : w.sort) * 60000; }
  function seen(it) {
    if (shown && shown.id === it.id) return;
    if (shown) Live.on() && Live.screen({ task_id: shown.coreId || null, card_id: shown.cardId || null, mode: shown.mode, shown_at: new Date(shown.at).toISOString(), left_at: new Date().toISOString(), away_s: Math.round(awayS) });
    shown = { id: it.id, coreId: it.coreId, cardId: it.cardId, mode: it.doing ? 'work' : 'sort', at: Date.now() };
    lastInput = Date.now(); awayS = 0; wayOpen = false;
  }
  function stuckCheck() {
    var it = cur();
    if (!alive || !it || !shown || shown.id !== it.id || busy || ciOpen || scOpen || document.hidden || card.style.display === 'none') return;
    if (wayOpen || asked[it.id] || it.inTheWay || scheduling || booking || askingWho || askingFind || pausing) return;
    var quiet = Date.now() - (it.doing ? lastInput : shown.at) - awayS * 1000;
    if (quiet < stuckAfter(it)) return;
    asked[it.id] = true; wayOpen = true; renderCardKeep();
    if (!Fuzz.isCalm()) Fuzz.setMood('caring');
    Fuzz.say('What’s in the way?', { type: false });
  }
  /* Find out…: Fuzz looks it up and the card steps aside, coming back right after the one in front */
  function findOut(q) {
    q = (q || '').trim();
    if (!q) { var fq = $('#find-q'); if (fq) fq.focus(); Fuzz.say('What should I find out? A question is enough.', { type: false }); return; }
    askingFind = false;
    moment(function () { return quickClear('Asked Fuzz to find out about', 'Fuzz is finding out. The card comes back right after the one you’re on, with the answer.', function (i) { Store.findOut(i.id, q); }, 'On it. I’ll bring it back right after this.'); });
  }
  /* Waiting on a named person: you're blocked until they get back to you */
  function waitOn(who) {
    who = (who || '').trim();
    if (!who) { var wi = $('#wait-who'); if (wi) wi.focus(); Fuzz.say('Who, though? A name is enough.', { type: false }); return; }
    askingWho = false;
    moment(function () { return quickClear('Waiting on ' + who + ':', 'Waiting on ' + who + '. Fuzz checks back in a few days, sooner if they reply.', function (i) { Store.wait(i.id, who); }, 'I’ll watch for ' + who + '.'); });
  }

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
    if (it.asks && which === 'primary' && !card.querySelector('[data-ask]:checked')) { Fuzz.say('Tick the ones that are yours first.', { type: false }); return; }
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
    UI.wireSources(card, cur);
    $('#gband').addEventListener('click', function (e) { if (e.target.closest('[data-run="later"]')) finishLater(); });
    $('#gtray').addEventListener('click', function (e) { var c = e.target.closest('[data-run-chip]'); if (c && !c.disabled) reopenAsk(c.dataset.runChip); });
    $('#keysbtn').addEventListener('click', openKeys);
    $('#keysdlg').addEventListener('click', function (e) { if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.close(); });
    $('#keysdlg').addEventListener('close', function () { var b = $('#keysbtn'); if (b && b.offsetParent) b.focus(); });
    onScroll = function () { var e = $('#echo'); if (e && !e.hidden && !perchHidden()) hideEcho(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    card.addEventListener('input', function (e) {
      var it = cur(); if (!it) return;
      /* Each box keeps its own text, so what you told Fuzz never turns up in the draft he brings back */
      if (e.target.id === 'instr' || e.target.id === 'note' || e.target.id === 'draft') edits[it.id + ':' + e.target.id] = e.target.value;
      if (e.target.id === 'wait-who') edits[it.id + ':who'] = e.target.value;
      if (e.target.id === 'find-q') edits[it.id + ':find'] = e.target.value;
      lastInput = Date.now();   /* a sign of progress, in work mode */
      if (e.target.id === 'instr' || e.target.id === 'draft') fit(e.target);
    });
    /* Add files: the button opens the picker, a drop lands on the task */
    card.addEventListener('change', function (e) {
      if (e.target.id === 'afile') { addFiles(e.target.files); e.target.value = ''; return; }
      var it = cur();
      if (it && e.target.dataset.ask !== undefined) edits[it.id + ':ask' + e.target.dataset.ask] = e.target.checked;
      if (it && e.target.dataset.ref !== undefined) { var rs = it.sources.filter(function (x) { return srcKey(x) === e.target.dataset.ref; })[0]; if (rs) { setRef(it, rs, e.target.checked); paintRefChips(); } }
    });
    /* A file dragged anywhere onto the screen opens the drop zone; letting go anywhere adds it to the task.
       The zone goes back to how it was once the drag is over. */
    var depth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
    function zone() { var it = cur(); return it && it.kind === 'task' && !busy && !ciOpen && card.style.display !== 'none' && $('#adrop'); }
    function endDrag() {
      depth = 0; document.documentElement.classList.remove('dragging-file');
      var d = $('#adrop'); if (d) { d.classList.remove('over'); d.hidden = true; }
    }
    docDrag = {
      dragenter: function (e) {
        if (!hasFiles(e)) return;
        var d = zone(); if (!d) return;
        e.preventDefault();
        if (depth++ > 0) return;
        d.hidden = false; d.classList.add('over');
        document.documentElement.classList.add('dragging-file');
        d.scrollIntoView({ block: 'nearest', behavior: Fuzz.isCalm() ? 'auto' : 'smooth' });
        Fuzz.setMood('eager'); Fuzz.say('Drop it anywhere. I’ll read it with this one.', { type: false });
      },
      dragover: function (e) { if (hasFiles(e) && zone()) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
      dragleave: function (e) { if (hasFiles(e) && depth > 0 && --depth === 0) { endDrag(); Fuzz.setMood('idle'); } },
      drop: function (e) {
        if (!hasFiles(e) || !zone()) return;
        e.preventDefault(); endDrag();
        addFiles(e.dataTransfer.files);
      }
    };
    Object.keys(docDrag).forEach(function (n) { window.addEventListener(n, docDrag[n]); });
    card.addEventListener('click', function (e) {
      if (e.target.closest('#adropbtn')) { $('#afile').click(); return; }
      if (e.target.closest('[data-guide="skip"]')) { var gd = card.querySelector('.onb-guide'); if (gd) gd.remove(); Onboard.skipGuide(); refocus($('#ask')); return; }
      var ux = e.target.closest('[data-unref]'), ci = cur();
      if (ux && ci) {
        refs[ci.id] = (refs[ci.id] || []).filter(function (k) { return k !== ux.dataset.unref; });
        var gone = ci.sources.filter(function (s) { return srcKey(s) === ux.dataset.unref; })[0];
        if (gone) setRef(ci, gone, false);
        paintRefs(); card.querySelector('[data-act="plus"]').focus();
        return;
      }
      if (e.target.closest('[data-act="plus"]')) { plusMenu(!$('#plusmenu').hidden ? false : true); return; }
      if (e.target.closest('[data-act="upload"]')) { plusMenu(false, true); $('#afile').click(); return; }
      if (e.target.closest('[data-act="refpick"]') && ci) {
        refPick[ci.id] = !refPick[ci.id]; paintRefs();
        var first = refPick[ci.id] && card.querySelector('#refpick input'); (first || card.querySelector('[data-act="plus"]')).focus();
        return;
      }
      var t = e.target.closest('[data-act],[data-when],[data-tab],[data-quick],[data-sched],[data-who],[data-book]');
      if (!t || !card.contains(t)) return;
      if (t.dataset.who) { waitOn(t.dataset.who); return; }
      if (t.dataset.tab) { showTab(t.dataset.tab); return; }
      if (t.dataset.book !== undefined) {
        var bit = cur(), bopt = Store.bookOptions(bit)[parseInt(t.dataset.book, 10)];
        if (bopt) moment(function () { booking = false; return quickClear('Booked time for', 'Booked ' + bopt.label + ' for “' + bit.title + '”. It opens first in the list then.', function (i) { Store.book(i.id, bopt); }, 'Booked. I’ll have it ready for you then.'); });
        return;
      }
      if (t.dataset.when !== undefined) { if (schedResolve) schedResolve(parseInt(t.dataset.when, 10)); return; }
      if (t.dataset.sched) {
        if (t.dataset.sched === 'cancel') { if (schedResolve) schedResolve(-1); }
        else if (t.dataset.sched === 'back') { if (schedResolve) schedResolve(-2); }
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
      else if (a === 'waiting') { askingWho = true; renderCardKeep(); var wi = $('#wait-who'); if (wi) wi.focus(); Fuzz.setMood('eager'); Fuzz.say('Who are you waiting on?', { type: false }); }
      else if (a === 'book') { booking = true; pausing = false; wayOpen = false; renderCardKeep(); var bh = $('#book-h'); if (bh) bh.focus(); Fuzz.setMood('eager'); Fuzz.say('When will you do it? I’ll hold the time.', { type: false }); }
      else if (a === 'book-cancel') { booking = false; renderCardKeep(); Fuzz.setMood('idle'); }
      else if (a === 'donow') moment(doNow);
      else if (a === 'keepgoing') moment(function () { return quickClear('Kept going on', 'Kept going: the block runs on a little, if your calendar is free.', function (i) { Store.keepGoing(i.id); }, 'Nice. I’ll stretch the block.'); });
      else if (a === 'hold-approve' || a === 'hold-always' || a === 'hold-skip') moment(function () {
        var opt = { 'hold-approve': 'approve', 'hold-always': 'always_allow', 'hold-skip': 'skip' }[a], hit = cur();
        return quickClear(opt === 'skip' ? 'No calendar change for' : 'Calendar hold for', opt === 'skip' ? 'No change to your calendar for “' + hit.title + '”.' : 'Fuzz will update your calendar for “' + hit.title + '”.', function (i) { Store.answerHold(i.id, opt); }, opt === 'skip' ? 'Okay, I’ll leave your calendar alone.' : 'On it. Your calendar, your events: I only touch the hold.');
      });
      else if (a === 'pause') { pausing = true; renderCardKeep(); var pq = $('#pause-q'); if (pq) pq.focus(); }
      else if (a === 'pause-cancel') { pausing = false; renderCardKeep(); }
      else if (a === 'afterothers' || a === 'way-notnow') moment(function () { wayOpen = false; return quickClear('After the others:', 'After the others: “' + cur().title + '” waits until the rest are sorted. No penalty.', function (i) { Store.afterOthers(i.id); }, 'Sure. After the others.'); });
      else if (a === 'firststep') moment(function () { return quickClear('Just the first step:', 'Fuzz is writing the checklist for “' + cur().title + '”. Step 1 comes back to you next.', function (i) { Store.firstStep(i.id); }, 'On it. Step 1 is coming right up.'); });
      else if (a === 'way-find') { wayOpen = false; askingFind = true; renderCardKeep(); var wq = $('#find-q'); if (wq) wq.focus(); }
      else if (a === 'way-big') { wayOpen = false; var wb = cur(); if (wb) wb.forceBig = true; renderCardKeep(); }
      else if (a === 'way-decide') moment(function () { wayOpen = false; return quickClear('Asked Fuzz to lay out the options for', 'Fuzz lays out the options with one it suggests. The card comes back right after this one.', function (i) { Store.decideFor(i.id); }, 'I’ll lay the options out, with my pick.'); });
      else if (a === 'way-draft') moment(function () { wayOpen = false; return quickClear('Fuzz is drafting', 'Fuzz drafts it. It comes to you for your OK before anything is sent.', function (i) { Store.draftIt(i.id); }, 'Leave it with me. I’ll draft it for your OK.'); });
      else if (a === 'way-dismiss') { wayOpen = false; renderCardKeep(); Fuzz.setMood('idle'); }
      else if (a === 'findout') { askingFind = true; renderCardKeep(); var fq = $('#find-q'); if (fq) { fq.focus(); fq.select(); } Fuzz.setMood('eager'); Fuzz.say('What do you need to know?', { type: false }); }
      else if (a === 'find-cancel') { askingFind = false; renderCardKeep(); Fuzz.setMood('idle'); }
      else if (a === 'wait-cancel') { askingWho = false; renderCardKeep(); Fuzz.setMood('idle'); var mb2 = $('.more-btn'); if (mb2) mb2.focus(); }
      else if (a === 'gotit') { var gi = cur(); Store.gotIt(gi.id); renderCard(cur()); refocus(landing()); Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Nice. What should happen to it now?', { type: false }); }
      else if (a === 'nudge') moment(function () { return quickClear('Nudging ' + (cur().waitingOn || 'them') + ' about', 'Fuzz is drafting a nudge. It comes to you for your OK before anything is sent.', function (i) { Store.nudgeThem(i.id); }, 'On it. I’ll draft something friendly.'); });
      else if (a === 'keepwaiting') moment(function () { return quickClear('Still waiting on ' + (cur().waitingOn || 'them') + ':', 'Still waiting. Fuzz checks back in a few days.', function (i) { Store.keepWaiting(i.id); }, 'Okay, I’ll check back later.'); });
      else if (a === 'theirs') moment(function () { return quickClear('Not yours:', 'Off your list as someone else’s. Find it in Lineup, under Finished.', function (i) { Store.theirs(i.id); }, 'Not yours. I’ll leave it with them.'); });
      else if (a === 'letgo') moment(function () { return quickClear('Let go of', 'Let go. You can bring it back from Let go.', function (i) { Store.letGo(i.id); }, 'Let go. That one’s off your plate.', 'sleepy'); });
      else if (a === 'keepparked') moment(function () { return quickClear('Kept parked', 'Kept “' + cur().title + '” parked. Fuzz won’t ask again for a few weeks.', function (i) { Store.keepParked(i.id); }, 'Kept. It stays parked, no pressure.'); });
      else if (a === 'clarify') { var ci = cur(); Store.clarify(ci.id); renderCard(cur()); refocus(landing()); Fuzz.setMood('eager'); Fuzz.pAnim('hop'); Fuzz.say('Back on your list. What should happen to it?', { type: false }); }
      else if (a === 'unclear') moment(function () { return quickClear('Working out the first step for', 'Fuzz is working out what this needs and the smallest first step. It comes back to you with one question if anything is still unclear.', function (i) { Store.unclear(i.id); }, 'On it. I’ll find the first step.'); });
      else if (a === 'stillmatters') { var si = cur(); Store.stillMatters(si.id); renderCard(cur()); refocus(landing()); Fuzz.setMood('eager'); Fuzz.pAnim('hop'); Fuzz.say('Okay. What should happen to it now?', { type: false }); }
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
      else if (a === 'joinreply') moment(function () { return quickClear('Added to the reply:', 'Added “' + cur().title + '” to the reply. Fuzz rewrites it to cover this too, and it comes back for your OK.', function (i) { Store.joinReply(i.id); }, 'Got it. I’ll fold it into the reply.'); });
    });
    docClick = function (e) {
      var mm = root && root.querySelector('#moremenu');
      if (mm && !mm.hidden && !e.target.closest('.split')) { mm.hidden = true; var mb = root.querySelector('.more-btn'); if (mb) mb.setAttribute('aria-expanded', 'false'); }
      var pm = root && root.querySelector('#plusmenu');
      if (pm && !pm.hidden && !e.target.closest('.plus')) { pm.hidden = true; root.querySelector('[data-act="plus"]').setAttribute('aria-expanded', 'false'); }
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
       (A assign, D done, S schedule, P park, W waiting, X not mine; K keep and L let go on a stale card). Numbers pick
       from whatever choice is on screen: a time while scheduling, an answer on an entity or duplicate
       card, a quick answer on a handback, a mood (then a follow-up) on a check-in. Escape backs out. */
    var KEYS = { a: 'assign', d: 'done', s: 'schedule', p: 'park', c: 'claude', w: 'waiting', x: 'theirs', q: 'findout', b: 'book', z: 'pause' }, STALE = { k: 'keep', l: 'letgo' }, PARKREV = { k: 'keepparked', r: 'clarify', l: 'letgo' }, CHECKBACK = { g: 'gotit', u: 'nudge', k: 'keepwaiting', l: 'letgo' }, PUTOFF = { h: 'unclear', k: 'stillmatters', l: 'letgo' }, REVIEW = { r: 'revise', l: 'notnow', d: 'sentself' };
    docKey = function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || !alive) return;
      var t = e.target;
      /* Escape stops dictating first, keeping what was heard */
      if (e.key === 'Escape' && Dictate.active()) { e.preventDefault(); Dictate.stop(); return; }
      /* Escape leaves the card's box, so the number keys work again */
      if (e.key === 'Escape' && t && (t.id === 'instr' || t.id === 'note') && card.contains(t)) { e.preventDefault(); $('#ask').focus({ preventScroll: true }); return; }
      /* Escape folds the stray-thought box away, keeping what you typed */
      if (e.key === 'Escape' && t && t.id === 'parktext') { e.preventDefault(); $('#parkbtn').click(); return; }
      /* Escape on a setup or question card, even from its time pickers: back out, or Not now */
      if (e.key === 'Escape' && scOpen && t && $('#setupcard').contains(t)) { e.preventDefault(); setupAnswer(scState && scState.step === 'other' ? 'back' : 'later'); return; }
      if (e.key === 'Escape' && t && t.id === 'pause-q') { e.preventDefault(); card.querySelector('[data-act="pause-cancel"]').click(); return; }
      if (e.key === 'Escape' && (booking || wayOpen) && card.style.display !== 'none') { var bx = card.querySelector('[data-act="book-cancel"], [data-act="way-dismiss"]'); if (bx) { e.preventDefault(); bx.click(); return; } }
      if (e.key === 'Escape' && t && t.id === 'find-q') { e.preventDefault(); card.querySelector('[data-act="find-cancel"]').click(); return; }
      if (e.key === 'Escape' && t && t.id === 'wait-who') { e.preventDefault(); card.querySelector('[data-act="wait-cancel"]').click(); return; }
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (t && t.closest && t.closest('dialog, [role="dialog"]')) return;
      if (e.key === '?') { e.preventDefault(); openKeys(); return; }
      /* T parks a stray thought from any card without leaving it */
      if (e.key.toLowerCase() === 't' && !ciOpen) { e.preventDefault(); if ($('#parkform').hidden) $('#parkbtn').click(); else $('#parktext').focus(); return; }
      var pm = $('#plusmenu');
      if (e.key === 'Escape' && pm && !pm.hidden) { e.preventDefault(); plusMenu(false); return; }
      var mm = $('#moremenu');
      if (e.key === 'Escape' && mm && !mm.hidden) { e.preventDefault(); mm.hidden = true; var mb = $('.more-btn'); if (mb) { mb.setAttribute('aria-expanded', 'false'); mb.focus(); } return; }
      var k = e.key.toLowerCase(), n = /^[1-9]$/.test(e.key) ? parseInt(e.key, 10) - 1 : -1, b = null;
      /* A setup card: its buttons take Enter, and Escape is Not now */
      if (scOpen) {
        if (k === 'escape') { e.preventDefault(); setupAnswer(scState && scState.step === 'other' ? 'back' : 'later'); }
        else if (n > -1 && !(t && t.tagName === 'SELECT')) { var hq = $('#setupcard').querySelectorAll('[data-hq]')[n]; if (hq) { e.preventDefault(); hq.click(); } }
        else if (k === 'enter' && !(t && t.closest && t.closest('button, a, summary'))) { var pb = $('#setupcard .primary'); if (pb) { e.preventDefault(); pb.click(); } }
        return;
      }
      if (ciOpen) {
        var follow = $('#ci-follow').querySelectorAll('.btn');
        if (!$('#ci-break').hidden) return; /* "I'm back" has focus; Enter presses it */
        if (n > -1) b = follow.length ? follow[n] : $('#ci-moods').querySelectorAll('.mood')[n];
        else if (k === 'escape' && !$('#ci-skip').hidden) b = $('#ci-skip');
      } else if (card.style.display === 'none') {
        return;
      } else if (booking) {
        if (n > -1) b = card.querySelectorAll('[data-book]')[n];
      } else if (wayOpen || (cur() && cur().inTheWay)) {
        if (n > -1) b = card.querySelectorAll('.way [data-act]')[n];
      } else if (scheduling) {
        if (n > -1) b = card.querySelectorAll('[data-when]')[n];
        else if (k === 'm') b = card.querySelector('[data-sched="more"]');
        else if (k === 'e') b = card.querySelector('[data-sched="back"]');
        else if (k === 'escape') b = card.querySelector('[data-sched="cancel"]');
      } else if (REVIEW[k] && card.querySelector('.actions.review')) {
        b = card.querySelector('[data-act="' + REVIEW[k] + '"]');
      } else if (askingWho) {
        if (n > -1) b = card.querySelectorAll('[data-who]')[n];
        else if (k === 'escape') b = card.querySelector('[data-act="wait-cancel"]');
      } else if (CHECKBACK[k] && card.querySelector('.checkback:not([hidden])')) {
        b = card.querySelector('[data-act="' + CHECKBACK[k] + '"]');
      } else if (PUTOFF[k] && card.querySelector('.putoff:not([hidden])')) {
        b = card.querySelector('[data-act="' + PUTOFF[k] + '"]');
      } else if (PARKREV[k] && card.querySelector('.parkrev:not([hidden])')) {
        b = card.querySelector('[data-act="' + PARKREV[k] + '"]');
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

    /* Dictation into the box for Fuzz (dictate.js): the mic by each box, or hold Alt (Option) + Space for
       the box you're in, else the one on the card (what to change, once you've asked for a change). */
    var DICT = ['instr', 'note', 'revise-text'];
    function dictOpts() {
      return { done: 'Got it. Change anything, then pick what to do.', onChange: function (on) {
        var f = Dictate.field(), b = f && root && root.querySelector('[data-dictate="' + f.id + '"]');
        root && root.querySelectorAll('[data-dictate]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        if (on && b) b.setAttribute('aria-pressed', 'true');
      } };
    }
    function dictTarget() {
      if (!alive || ciOpen || card.style.display === 'none' || scheduling) return null;
      var a = document.activeElement;
      if (a && DICT.indexOf(a.id) > -1 && root.contains(a)) return a;
      var rv = $('#revise'); if (rv && !rv.hidden) return $('#revise-text');
      return $('#instr') || $('#note');
    }
    card.addEventListener('click', function (e) {
      var b = e.target.closest('[data-dictate]'); if (!b) return;
      if (Dictate.active()) Dictate.stop(); else Dictate.start($('#' + b.dataset.dictate), dictOpts());
    });
    unhold = Dictate.hold(dictTarget, dictOpts);

    card.addEventListener('submit', function (e) {
      if (e.target.id === 'wait-form') { e.preventDefault(); waitOn($('#wait-who').value); return; }
      if (e.target.id === 'find-form') { e.preventDefault(); findOut($('#find-q').value); return; }
      if (e.target.id === 'pause-form') { e.preventDefault(); var note = $('#pause-q').value; pausing = false; moment(function () { return quickClear('Paused', 'Paused “' + cur().title + '”. It’s back in the list' + (note.trim() ? ', with where you left off.' : '.'), function (i) { Store.pause(i.id, note); }, 'Paused. It’ll be here when you’re back to it.'); }); return; }
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
    $('#setupcard').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !scOpen) return;
      if (b.dataset.scTheme) { App.setTheme(b.dataset.scTheme); $('#setupcard').querySelectorAll('[data-sc-theme]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); return; }
      if (b.dataset.sc) setupAnswer(b.dataset.sc);
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
