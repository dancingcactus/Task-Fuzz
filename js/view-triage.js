/* Triage: one card at a time, Fuzz on the perch.
   Layout and information architecture come from the Triage Queue mockup; Fuzz's reactions come from
   the Fuzz Triage motion prototype. */
(function () {
  var V = {};
  var ABORT = {};
  /* Check-ins come often at first, then back off: after 2 cleared cards, then 4 more, 8 more, 16 more… */
  var CI_FIRST = 2;
  var esc = UI.esc;

  var root, card, stack, stage, alive = false, busy = false, epoch = 0, unsub = null;
  var ciOpen = false, ciBusy = false, ciTimer = 0, ciSecs = 300, ciDemo = false;
  var ciCount = 0, ciNextAt = CI_FIRST;
  var lastTask = null, streak = 0, rushTimer = 0, ambientTimer = 0;
  var scheduling = false, tab = null, keptStale = {}, edits = {}, greeted = false;
  var docClick = null;

  function $(s) { return root.querySelector(s); }
  function cur() { return Store.front(); }

  /* ---------- Time helpers (principle 10: time is human) ---------- */
  function mins(t) { return (t.dueAt - Date.now()) / 60000; }
  function tierOf(m) { return m < 30 ? 3 : (m < 120 ? 2 : 1); }
  function fmtDue(m) {
    if (m >= 60) return Math.floor(m / 60) + 'h ' + Math.floor(m % 60) + 'm';
    var sec = Math.max(0, Math.floor(m * 60)); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function fmtOsd(m) {
    if (m <= 0) return '0:00';
    if (m >= 60) return Math.floor(m / 60) + 'h' + ('0' + Math.floor(m % 60)).slice(-2);
    var sec = Math.floor(m * 60); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
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
  async function moment(fn) {
    if (busy || !alive) return;
    lock(true);
    try { await fn(); } catch (err) { if (err !== ABORT) console.error(err); }
    finally { if (alive) lock(false); }
  }

  V.mount = function (container) {
    alive = true; busy = false; epoch++; ciOpen = false; ciBusy = false; scheduling = false; tab = null; streak = 0;
    root = container;
    root.innerHTML = layout();
    card = $('#card'); stack = $('#stack'); stage = $('#stage');
    Fuzz.mount(root, { isBusy: function () { return busy; } });
    wire();
    unsub = Store.on(onStore);
    Say.setBusyCheck(function () { return busy || ciOpen; });
    ambientTimer = setInterval(ambient, 45000);
    V.tickTimer = setInterval(function () { var t = cur(); if (t && t.dueAt && card.style.display !== 'none' && !ciOpen) paintDue(t); }, 1000);
    if (!greeted) { greeted = true; greet(); } else { Fuzz.say('Back to the queue.', { type: false }); }
    stats();
    showNext();
  };
  V.unmount = function () {
    alive = false; epoch++;
    clearTimeout(rushTimer); clearInterval(ciTimer); clearInterval(ambientTimer); clearInterval(V.tickTimer);
    if (unsub) unsub(); unsub = null;
    Say.setBusyCheck(null);
    if (docClick) document.removeEventListener('click', docClick); docClick = null;
    Fuzz.unmount(); root = null;
  };
  V.hardReset = function () { keptStale = {}; edits = {}; ciCount = 0; ciNextAt = CI_FIRST; lastTask = null; greeted = false; };
  V.refresh = function () {
    if (!alive) return;
    epoch++; busy = false; ciOpen = false; ciBusy = false; scheduling = false; clearInterval(ciTimer); clearTimeout(rushTimer);
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
      if (card.style.display === 'none' && !ciOpen) { showNext(); return; }
      if (!busy) {
        Fuzz.glitch(500); Fuzz.setMood('sheepish'); Fuzz.setArm('scratch'); Fuzz.pAnim('shrug');
        Fuzz.say('Lost the signal on “' + e.item.title + '”. I sent it to the back of the line.', { type: false });
        settleSheepish();
      }
    } else if (e.type === 'capture') {
      stats(); updateStack(true);
      if (card.style.display === 'none' && !ciOpen) showNext();
    } else if (e.type === 'work' || e.type === 'review') {
      stats();
      if (card.style.display === 'none' && !ciOpen) renderEmpty();
    } else if (e.type === 'reset' || e.type === 'restore' || e.type === 'moment') {
      /* the caller refreshes */
    }
  }

  /* ---------- Layout ---------- */
  function layout() {
    var moods = [['good', 'Good'], ['okay', 'Okay'], ['tired', 'Tired'], ['over', 'Overloaded']];
    var moodBtns = moods.map(function (m) { return '<button class="mood" data-pick="' + (m[0] === 'over' ? 'over' : m[0]) + '" aria-pressed="false">' + Fuzz.mini(m[0], { cls: 'fz' }) + m[1] + '</button>'; }).join('');
    return '' +
    '<section class="triage" aria-labelledby="triage-h">' +
      '<div class="triage-top">' +
        '<h1 id="triage-h" class="sr">Triage</h1>' +
      '</div>' +
      '<section class="stage" id="stage">' +
        '<div class="fx" id="fx"></div>' +
        '<div class="perch" id="perch"><div class="pwrap" id="pwrap" role="button" tabindex="0" aria-label="Boop Fuzz">' + window.FUZZ_SVG + '</div><div class="bubble" id="bubble" aria-live="polite"></div></div>' +
        '<div class="stack" id="stack">' +
          '<article class="card" id="card"></article>' +
          '<article class="card checkin" id="checkin" hidden>' +
            '<div class="tagrow"><span class="src">Quick pause</span></div>' +
            '<h2 id="ci-h">How are you doing?</h2><p class="meta">Totally optional. It takes about five seconds.</p>' +
            '<div class="moods" id="ci-moods" role="group" aria-label="How are you doing?">' + moodBtns + '</div>' +
            '<div class="ci-follow" id="ci-follow"></div>' +
            '<div class="ci-break" id="ci-break" hidden><div class="breath" aria-hidden="true"></div><p class="ci-time" id="ci-time">5:00</p><p class="meta">Fuzz has the queue. Step away for a bit.</p><button class="btn primary" data-ci="back">I’m back</button></div>' +
            '<div class="ci-foot"><button class="btn" data-ci="skip" id="ci-skip">Skip</button></div>' +
          '</article>' +
        '</div>' +
      '</section>' +
      '<div class="triage-foot"><button type="button" class="linkbtn" id="dropbtn"></button><span aria-hidden="true">·</span><button type="button" class="linkbtn" id="parkbtn" aria-expanded="false" aria-controls="parkform">Park a stray thought</button></div>' +
      '<form class="parkform" id="parkform" hidden><label for="parktext">Park it without leaving this card</label><div class="parkrow"><input id="parktext" type="text" autocomplete="off" placeholder="A stray thought, in a few words"><button class="btn" type="submit">Park</button></div></form>' +
      '<details class="playground"><summary>Fuzz mood lab <span>for refining the character</span></summary><div class="lab">' +
        '<div class="lab-row" role="group" aria-label="Moods">' + [['Idle', 'idle'], ['Eager', 'eager'], ['Thinking', 'thinking'], ['Working', 'working'], ['Happy', 'happy'], ['Proud', 'proud'], ['Grateful', 'grateful'], ['Sheepish', 'sheepish'], ['Puzzled', 'puzzled'], ['Worried', 'worried'], ['Bored', 'bored'], ['Sleepy', 'sleepy'], ['Caring', 'caring'], ['Stare', 'stare'], ['Screen off', 'chill']].map(function (m) { return '<button type="button" class="btn small" data-demo="mood" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<div class="lab-row" role="group" aria-label="Deadline levels">' + [['Due today', 1], ['Under 2 hours', 2], ['Under 30 min', 3]].map(function (m) { return '<button type="button" class="btn small" data-demo="rush" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<div class="lab-row" role="group" aria-label="Reactions">' + [['Hop', 'p:hop'], ['Spin', 'p:spin'], ['Bow', 'p:bow'], ['Wiggle', 'p:wiggle'], ['Wink', 'f:wink'], ['Stars', 'f:star'], ['Tip hat', 'f:tip'], ['Scan', 'f:scan'], ['Rev up', 'f:rev'], ['Dance', 'f:dance'], ['Confetti', 'confetti'], ['Hearts', 'hearts'], ['Check-in', 'checkin']].map(function (m) { return '<button type="button" class="btn small" data-demo="fx" data-v="' + m[1] + '">' + m[0] + '</button>'; }).join('') + '</div>' +
        '<p class="note">Tap Fuzz for a boop, tug an antenna, or twist a knob. Calm mode (in Settings) removes flashes and gags.</p>' +
      '</div></details>' +
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
    stack.querySelectorAll('.ghost').forEach(function (g) { g.remove(); });
    var q = Store.queue(), n = Math.min(Math.max(q.length - 1, 0), 3);
    for (var i = n; i >= 1; i--) {
      var g = document.createElement('div'); g.className = 'ghost';
      g.style.transform = 'translateY(-' + (i * 9) + 'px) scale(' + (1 - i * 0.035) + ')';
      var item = q[i];
      if (item && item.handedBack) { var t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Handed back'; g.appendChild(t); }
      else if (item && item.dueAt) { var t2 = document.createElement('span'); t2.className = 'tag due t2'; t2.textContent = 'Due soon'; g.appendChild(t2); }
      if (arriveLast && i === n && q.length - 1 <= 3) g.classList.add('arrive');
      stack.insertBefore(g, card);
    }
  }

  /* ---------- The card ---------- */
  function ageChip(it) {
    var m = { fresh: ['Fresh', 1, 'ok'], settling: ['Waiting', 2, 'warn'], stale: ['Sitting', 3, 'muted'] }[it.stage || 'fresh'];
    return '<span class="agechip agechip--' + m[2] + '"><span class="segs" aria-hidden="true">' + [1, 2, 3].map(function (n) { return '<i class="' + (n <= m[1] ? 'on' : '') + '"></i>'; }).join('') + '</span>' + m[0] + ' · ' + esc(it.age || 'today') + '</span>';
  }
  function duePanel(it) {
    if (!it.due) return '';
    var d = it.due, tone = d.frac < 0.25 ? 'tight' : d.frac < 0.5 ? 'mid' : 'ok';
    return '<div class="duebox"><div class="duebox-top"><strong>' + esc(d.label) + '</strong><span class="due-' + tone + '">' + esc(d.left) + '</span></div><div class="dbar" aria-hidden="true"><div class="dbar-fill due-' + tone + '" style="width:' + Math.round(d.frac * 100) + '%"></div></div></div>';
  }
  var WHEN = [
    { label: 'Later today', when: 'After your last meeting', text: 'later today, after your last meeting', glyph: 'moon', osd: 'LATER TODAY', after: 300 },
    { label: 'When I’m back at my desk', when: 'Next time your Mac wakes', text: 'when you’re back at your desk', glyph: 'sun', osd: 'AT YOUR DESK', after: 90 },
    { label: 'Monday morning', when: 'First thing in triage', text: 'Monday morning', glyph: 'sun', osd: 'MON 8AM', after: 3600 },
    { label: 'Before it’s due', when: 'With a day to spare', text: 'before it’s due', glyph: 'cal', osd: 'BEFORE DUE', after: 0, needsDue: true },
    { label: 'Before the planning review', when: 'Ties it to that meeting', text: 'before the planning review', glyph: 'cal', osd: 'BEFORE REVIEW', after: 0 },
    { label: 'Sometime next week', when: 'On a lighter day', text: 'sometime next week, on a lighter day', glyph: 'cal', osd: 'NEXT WEEK', after: 8640 }
  ];
  function actionsHTML(it) {
    if (scheduling) {
      var opts = WHEN.map(function (w, i) { return { w: w, i: i }; }).filter(function (o) { return !o.w.needsDue || it.due || it.dueAt; });
      return '<div class="sched-panel"><h3>When should this come back?</h3><p class="meta">Pick a rough time. Fuzz finds the right moment around your day.</p>' +
        '<div class="when-grid">' + opts.map(function (o) { return '<button type="button" class="when" data-when="' + o.i + '"><span>' + esc(o.w.label) + '</span><small>' + esc(o.w.when) + '</small></button>'; }).join('') + '</div>' +
        '<div class="exact" id="exact" hidden><label for="exact-dt">Exact time</label><input type="datetime-local" id="exact-dt"><button type="button" class="btn small primary-s" data-sched="exact-go">Schedule for this time</button></div>' +
        '<div class="sched-links"><button type="button" class="linkbtn" data-sched="exact">Pick an exact time instead</button><button type="button" class="linkbtn" data-sched="cancel">Back to the card</button></div></div>';
    }
    return '<div class="actions">' +
      '<button type="button" class="btn primary" data-act="assign"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>Assign to Fuzz</button>' +
      '<button type="button" class="btn" data-act="claude">Work in Claude</button>' +
      '<button type="button" class="btn" data-act="schedule"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Schedule</button>' +
      '<div class="split"><button type="button" class="btn done-btn" data-act="done"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Done</button>' +
        '<button type="button" class="btn more-btn" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-label="More ways to clear this card"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="menu" role="menu" id="moremenu" hidden aria-label="More ways to clear this card">' +
          '<button type="button" role="menuitem" data-act="park"><b>Park it</b><span>Out of triage with no date. It waits in Parked until you bring it back.</span></button>' +
          '<button type="button" role="menuitem" data-act="waiting"><b>Waiting on someone</b><span>Moves to Waiting on others. Fuzz watches for the reply.</span></button>' +
        '</div></div></div>';
  }

  function richAvail(it) {
    var a = [];
    if (it.conversation.length) a.push(['conversation', 'Conversation', it.conversation.length]);
    if (it.context.length) a.push(['context', 'Context', it.context.length]);
    if (it.code && it.code.length) a.push(['code', 'Code', it.code.length]);
    if (it.log.length) a.push(['done', 'Done so far', it.log.length]);
    if (it.sources.length) a.push(['sources', 'Sources', it.sources.length]);
    return a;
  }
  function richHTML(it) {
    var avail = richAvail(it);
    if (!avail.length) return '';
    var t = avail.some(function (a) { return a[0] === tab; }) ? tab : avail[0][0];
    var tabs = avail.map(function (a) { var on = a[0] === t; return '<button type="button" class="tabbtn" data-tab="' + a[0] + '" aria-pressed="' + on + '">' + a[1] + '<span>' + a[2] + '</span></button>'; }).join('');
    var body = '';
    if (t === 'conversation') body = '<ol class="convo">' + it.conversation.map(function (m) { var you = m.who === 'You'; return '<li class="' + (you ? 'you' : 'fuzz') + '"><span class="who">' + (you ? '' : Fuzz.mini('good', { cls: 'who-av' })) + esc(m.who) + ' · <span>' + esc(m.time) + '</span></span><span class="bub">' + esc(m.text) + '</span></li>'; }).join('') + '</ol>';
    else if (t === 'context') body = '<ul class="ctx">' + it.context.map(function (c) { return '<li><i aria-hidden="true"></i><span>' + esc(c) + '</span></li>'; }).join('') + '</ul>';
    else if (t === 'code') body = CodeView.section(it.code, 'card:' + it.id);
    else if (t === 'done') body = UI.logHTML(it.log);
    else body = UI.sourcesHTML(it.sources);
    return '<div class="tabs" role="group" aria-label="More about this task">' + tabs + '</div><div class="tabbody">' + body + '</div>';
  }

  function cardHTML(it) {
    var isTask = it.kind === 'task', tags = '';
    if (it.handedBack) tags += '<span class="tag">Handed back</span>';
    if (it.updated) tags += '<span class="tag">Updated</span>';
    if (it.kind === 'entity') tags += '<span class="tag tag--info">Entity check</span>';
    if (it.kind === 'dup') tags += '<span class="tag tag--info">Possible duplicate</span>';
    if (it.isNew) tags += '<span class="tag tag--ok">Just captured</span>';
    tags += '<span class="tag due" id="duetag" hidden></span>';
    var h = '<div class="tagrow"><span class="src">' + esc(it.source + (it.who ? ' · ' + it.who : '')) + '</span>' + tags + '</div>';

    if (it.stage === 'stale' && !keptStale[it.id] && !scheduling && isTask) {
      h += '<section class="stale"><div class="stale-top"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/></svg><div><h2>Still care about this?</h2><p>It has waited ' + esc(it.age) + ' and nothing new has come up. Letting it go is fine. It moves to Let go, where you can bring it back anytime.</p></div></div>' +
        '<div class="stale-btns"><button type="button" class="btn" data-act="keep">Yes, keep it</button><button type="button" class="btn dark" data-act="letgo">Let it go</button></div></section>';
    }

    if (isTask) {
      var val = edits[it.id] !== undefined ? edits[it.id] : (it.instr || it.hint || '');
      h += '<div class="instr"><div class="instr-top"><label for="instr">Instructions for Fuzz</label><span>Suggested by Fuzz. Edit anything.</span></div><textarea id="instr" rows="3">' + esc(val) + '</textarea></div>';
      h += '<div id="actions">' + actionsHTML(it) + '</div>';
    } else {
      h += '<div class="instr"><div class="instr-top"><label for="note">' + esc(it.boxLabel) + '</label><span>Optional. Edit anything.</span></div><textarea id="note" rows="2" placeholder="' + esc(it.placeholder || '') + '">' + esc(edits[it.id] !== undefined ? edits[it.id] : (it.hint || '')) + '</textarea></div>' +
        '<div class="actions ent"><button type="button" class="btn primary" data-act="ent-primary"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' + esc(it.primary) + '</button>' +
        '<button type="button" class="btn" data-act="ent-secondary">' + esc(it.secondary) + '</button><button type="button" class="btn" data-act="ent-later">Not sure yet</button></div>';
    }

    h += '<hr><p class="decide">The one thing to decide</p><h2 class="ask">' + esc(it.ask) + '</h2><hr>';
    h += '<div class="title-block"><div class="chips">' + ageChip(it) + (it.meta || it.handedBack === false ? '' : '') + '<span class="meta">' + esc(it.meta || '') + '</span></div><h1 class="task-title">' + esc(it.title) + '</h1></div>';
    h += duePanel(it);
    if (it.handedBack && it.quick && it.quick.length) {
      h += '<div class="quick" role="group" aria-label="Quick answers">' + it.quick.map(function (q, i) { return '<button type="button" class="chip" data-quick="' + i + '">' + esc(q) + '</button>'; }).join('') + '</div>';
    }
    h += '<p class="incoming">' + UI.text(it.incoming) + '</p>';

    if (it.kind === 'entity' && it.entity === 'person') {
      h += '<div class="profiles">' + it.profiles.map(function (p) { return '<div class="profile"><span class="plabel">' + esc(p.where) + '</span><span class="pname">' + esc(p.name) + '</span><span class="pdetail">' + esc(p.detail) + '</span><span class="pseen">' + esc(p.seen) + '</span></div>'; }).join('') + '</div>';
    }
    if (it.kind === 'entity' && it.entity === 'term') {
      h += '<ul class="mentions">' + it.mentions.map(function (m) { return '<li><span class="pill pill--muted">' + esc(m.where) + '</span><span>' + esc(m.text) + '</span></li>'; }).join('') + '</ul>';
    }
    if (it.kind === 'dup') {
      var o = Store.item(it.dupOf);
      h += '<div class="profiles"><div class="profile"><span class="plabel">Already in your queue</span><span class="pname">' + esc(o ? o.title : '') + '</span><span class="pdetail">' + esc(o ? o.source + ' · ' + o.who : '') + '</span><span class="pseen">' + esc(o ? o.age + ' old' : '') + '</span></div>' +
        '<div class="profile"><span class="plabel">New just now</span><span class="pname">' + esc(it.title) + '</span><span class="pdetail">' + esc(it.source + ' · ' + it.who) + '</span><span class="pseen">' + esc(it.age) + ' old</span></div></div>';
    }

    if (isTask && (it.handedBack || it.updated || it.log.length >= 3) && it.log.length) {
      h += '<p class="leftoff"><strong>Where you left off.</strong> ' + esc(it.log[0].text) + '</p>';
    }
    if (it.aiNote) h += '<section class="ainote"><h2>' + esc(it.aiHeading || 'What Fuzz did') + '</h2><p>' + UI.text(it.aiNote) + '</p></section>';
    if (isTask && it.firstStep) h += '<section class="firststep"><h2>Smallest first step · two minutes</h2><p>' + esc(it.firstStep) + '</p></section>';
    if (it.effect) h += '<section class="effect"><h2>What this changes</h2><p>' + esc(it.effect) + '</p></section>';
    if (isTask) h += '<section id="rich" class="rich">' + richHTML(it) + '</section>';
    h += '<div class="stamp" aria-hidden="true">DONE</div>';
    return h;
  }

  function renderCard(it) {
    lastTask = it; $('#checkin').hidden = true;
    clearTimeout(rushTimer); card.getAnimations().forEach(function (a) { a.cancel(); });
    scheduling = false; if (tab && !richAvail(it).some(function (a) { return a[0] === tab; })) tab = null;
    card.className = 'card'; card.style.display = ''; card.style.visibility = '';
    card.innerHTML = cardHTML(it);
    var ex = stack.querySelector('.empty'); if (ex) ex.remove();
    var dt = $('#drop-label');
    $('#dropbtn').textContent = it.kind === 'task' ? 'Drop this task' : 'Dismiss this question';
    $('#dropbtn').hidden = false;
    paintDue(it);
    if (busy) card.querySelectorAll('[data-act],[data-quick]').forEach(function (b) { b.disabled = true; });
  }

  function paintDue(t) {
    var dt = $('#duetag');
    if (!dt) return;
    if (!t || !t.dueAt) { dt.hidden = true; card.classList.remove('urgent'); return; }
    var m = mins(t), tr = tierOf(m);
    dt.hidden = false; dt.className = 'tag due t' + tr;
    dt.textContent = m <= 0 ? 'Past due' : 'Due in ' + fmtDue(m);
    Fuzz.setOsd(fmtOsd(m));
    card.classList.toggle('urgent', tr >= 2);
    if (Fuzz.mood() === 'rushed') Fuzz.setUrgency(tr);
  }
  function rushLine(t, again) {
    var m = mins(t), tr = tierOf(m);
    if (m <= 0) return 'This one’s past its time. Assign me and I’ll start right now.';
    if (again) return tr === 3 ? 'Still only ' + Math.max(1, Math.round(m)) + ' minutes left!' : 'Quick reminder: due in ' + fmtDue(m) + '.';
    if (tr === 3) return 'Only ' + Math.max(1, Math.round(m)) + ' minutes! Assign me and I’ll start right now.';
    if (tr === 2) return 'Due in under 2 hours. Let’s move.';
    return 'Due later today. I’ll keep an eye on the clock.';
  }
  /* A rush lasts about five seconds, then Fuzz settles and repeats every 30 seconds while the card is open. */
  function rushBurst(t, again, force) {
    clearTimeout(rushTimer);
    if (!alive || cur() !== t || card.style.display === 'none' || ciOpen) return;
    if (!busy || force) {
      Fuzz.setMood('rushed'); Fuzz.setUrgency(tierOf(mins(t))); Fuzz.flash();
      Fuzz.say(rushLine(t, again), { type: false });
    }
    rushTimer = setTimeout(function () {
      if (!alive || cur() !== t || card.style.display === 'none') return;
      if (Fuzz.mood() === 'rushed') { Fuzz.setMood('idle'); Fuzz.say('Ready when you are.', { type: false }); }
      rushTimer = setTimeout(function () { rushBurst(t, true, false); }, 25000);
    }, 5000);
  }
  function settleSheepish() { setTimeout(function () { if (alive && Fuzz.mood() === 'sheepish') { Fuzz.setMood('idle'); Fuzz.setArm('none'); } }, 3500); }

  /* ---------- Showing the next card ---------- */
  function cleared() { var st = Store.get(); return Math.max(st.totalEver - st.queue.length, 0); }
  /* Never mid-rush: wait until the time-sensitive cards are handled. */
  function shouldCheckin(next) {
    return cleared() >= ciNextAt && !Store.queue().some(function (i) { return i.dueAt; }) && !next.dueAt && !next.handedBack;
  }
  function ciDone() {
    if (ciDemo) { ciDemo = false; return; }
    ciCount++; ciNextAt = cleared() + CI_FIRST * Math.pow(2, ciCount);
  }
  async function showNext() {
    var e = epoch;
    try {
      var q = Store.queue();
      if (!q.length) return zeroState();
      var t = q[0];
      if (shouldCheckin(t)) return showCheckin();
      renderCard(t); updateStack(false); stats();
      card.classList.add(t.handedBack ? 'enter-tilt' : 'enter');
      if (Fuzz.isCalm()) card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      if (t.handedBack) {
        Fuzz.glitch(600); Fuzz.setMood('sheepish'); Fuzz.setArm('scratch'); Fuzz.pAnim('shrug');
        /* don't hold the busy lock while the line types out */
        Fuzz.say(t.askBack || 'I lost the signal on this one. Can you help me with it?').then(function () { if (alive) { Fuzz.setArm('none'); settleSheepish(); } });
      } else if (t.dueAt) {
        rushBurst(t, false, true);
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
    var h = '';
    if (working.length || review.length) {
      h += '<h2>Nothing waiting for you</h2>';
      if (working.length) h += '<p class="meta">Fuzz is working on ' + working.length + (working.length === 1 ? ' task' : ' tasks') + '. Anything that gets stuck comes back to the end of this queue.</p>' +
        '<ul class="work">' + working.map(function (t, i) { return '<li style="--i:' + i + '"><span>' + esc(t.title) + (t.dueAt ? ' <span class="tag due t2">Rush</span>' : '') + (t.state === 'ai-queued' ? ' <span class="pill pill--muted">Next up</span>' : '') + '</span><span class="dots" role="img" aria-label="In progress"><i></i><i></i><i></i></span></li>'; }).join('') + '</ul>';
      if (review.length) h += '<p class="meta ready">' + review.length + (review.length === 1 ? ' draft is' : ' drafts are') + ' ready for your OK. <a href="#/tasks">Review in All tasks</a></p>';
    } else {
      h += '<h2>All clear</h2><p class="meta">Fuzz is on standby. Capture something new to put it to work.</p><a class="btn primary linklike" href="#/capture">New task</a>';
    }
    if (s.later) h += '<p class="later">' + s.later + ' scheduled for later</p>';
    e.innerHTML = h;
    stack.appendChild(e);
  }
  function zeroState(quiet) {
    stats(); updateStack(false);
    card.style.display = 'none'; $('#checkin').hidden = true; $('#dropbtn').hidden = true;
    renderEmpty();
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
    tired: { mood: 'caring', moment: 'low', line: 'Long stretch. I’ll bring the gentle ones first. Want to take five? I’ll watch the queue.', opts: [['break', 'Take 5'], ['go', 'Keep going']] },
    over: { mood: 'caring', moment: 'quick', line: 'That’s a lot at once. I’ll put the quick ones first. Want me to hold the rest until tomorrow?', opts: [['hold', 'Hold the rest until tomorrow'], ['slow', 'Quick ones first'], ['break', 'Take 5']] }
  };
  var CI_ASK = [
    ['Quick pause. How are you doing?', 'Quick pause. How are you doing?'],
    ['Checking in again. How’s it going?', 'Checking in again. How’s it going?'],
    ['Been a while. How are you holding up?', 'We’ve been at this a while. How are you holding up?']
  ];
  function showCheckin(demo) {
    ciDemo = !!demo;
    ciOpen = true; lock(busy); clearInterval(ciTimer); ciBusy = false;
    card.style.display = 'none';
    var oldE = stack.querySelector('.empty'); if (oldE) oldE.remove();
    var ci = $('#checkin');
    ci.getAnimations().forEach(function (a) { a.cancel(); });
    ci.hidden = false; ci.className = 'card checkin enter';
    $('#ci-follow').innerHTML = ''; $('#ci-break').hidden = true; $('#ci-moods').hidden = false; $('#ci-skip').hidden = false;
    ci.querySelectorAll('.mood').forEach(function (b, i) { b.setAttribute('aria-pressed', 'false'); b.style.setProperty('--i', i); });
    updateStack(false); stats();
    $('#dropbtn').hidden = true;
    Fuzz.setMood('caring'); Fuzz.setArm('none');
    var ask = lastTask && lastTask.dueAt && lastTask.state !== 'triage' ? ['The urgent stuff is handled. How are you doing?', 'Urgent stuff is handled. Before we keep going, how are you doing?'] : CI_ASK[Math.min(ciCount, CI_ASK.length - 1)];
    $('#ci-h').textContent = ask[0];
    Fuzz.say(ask[1], { type: false });
  }
  async function ciPick(kind) {
    if (ciBusy) return;
    var r = CI_REPLY[kind], ci = $('#checkin');
    ci.querySelectorAll('.mood').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.pick === kind)); });
    Store.setMoment(r.moment);
    Fuzz.setMood(r.mood); if (r.mood === 'happy') Fuzz.pAnim('hop');
    Fuzz.say(r.line, { type: false });
    var f = $('#ci-follow'); f.innerHTML = '';
    if (r.auto) { ciBusy = true; $('#ci-skip').hidden = true; try { await sleep(1700); } catch (e) { return; } ciBusy = false; return ciClose(); }
    r.opts.forEach(function (o, i) {
      var b = document.createElement('button'); b.className = 'btn' + (i === 0 ? ' primary' : ''); b.dataset.ci = o[0]; b.textContent = o[1]; f.appendChild(b);
    });
  }
  function paintBreak() { $('#ci-time').textContent = Math.floor(ciSecs / 60) + ':' + ('0' + (ciSecs % 60)).slice(-2); }
  async function ciAction(a) {
    if (ciBusy) return;
    try {
      if (a === 'skip') return ciClose('Okay, no pause. Back to it.');
      if (a === 'go') return ciClose('Okay. Gentle ones first.');
      if (a === 'slow') return ciClose('Okay. Quick ones first, one at a time.');
      if (a === 'hold') {
        ciBusy = true; ciDone();
        var snap = Store.snapshot();
        Store.queue().forEach(function (it) { Store.schedule(it.id, '', 'tomorrow morning'); });
        stats(); Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Done. They’ll be waiting for you tomorrow morning.', { type: false });
        Fuzz.schedGlyph('sun', 'TOMORROW 8AM');
        Say.offerUndo('Held the rest until tomorrow.', function () { Store.restore(snap); V.refresh(); });
        await sleep(1500);
        Fuzz.clearSched();
        $('#checkin').hidden = true; ciOpen = false; ciBusy = false; lock(busy);
        return zeroState();
      }
      if (a === 'break') {
        $('#ci-moods').hidden = true; $('#ci-follow').innerHTML = ''; $('#ci-skip').hidden = true; $('#ci-break').hidden = false;
        ciSecs = 300; paintBreak();
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
  async function assign(line) {
    var it = cur(); if (!it || it.kind !== 'task') return;
    var instr = $('#instr') ? $('#instr').value : (it.hint || '');
    streak = 0;
    var rush = !!it.dueAt, r = rush ? 1 : 0;
    var vi = pickV(ASSIGNS.length, lastAssign); lastAssign = vi; var V_ = ASSIGNS[vi];
    var b = card.querySelector('[data-act="assign"]'); if (b) { b.classList.add('squish'); setTimeout(function () { b.classList.remove('squish'); }, 180); }
    Fuzz.setMood('eager'); Fuzz.setArm('salute'); if (V_.fx) Fuzz.fxOn(V_.fx, V_.ms); else Fuzz.pAnim('lean');
    Fuzz.say(line || V_.inL[r]);
    await sleep(Math.max(rush ? 300 : 650, V_.ms * (rush ? 0.55 : 0.8)));
    Fuzz.setArm('none');
    var snap = Store.snapshot(), waited = Store.assign(it.id, instr), title = it.title;
    await fly(card, root.querySelector('#bot'), { scale: 0.08, rot: -18, dur: rush ? 420 : 760 });
    Fuzz.flash(); Fuzz.glitch(180); Fuzz.pAnim('gulp'); Fuzz.setMood('thinking'); stats();
    Fuzz.say(V_.midL[r]);
    await sleep(rush ? 800 : 1300);
    Fuzz.setMood('happy');
    Fuzz.say(waited ? 'That’s my fifth. This one is next up the moment I’ve got a free hand.' : V_.outL[r]); Fuzz.pAnim('hop');
    Say.offerUndo(waited ? '“' + title + '” is next up. Five are running.' : 'Assigned “' + title + '” to Fuzz.', function () { Store.restore(snap); V.refresh(); });
    await sleep(1000);
    Fuzz.setMood('idle');
    await showNext();
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
    var snap = Store.snapshot(); Store.done(it.id);
    Fuzz.flash(); Fuzz.setMood(V_.mood); Fuzz.setArm('cheer'); V_.fx(card);
    streak++; stats();
    Fuzz.say(rushT ? 'with time to spare.' : (V_.say || STAMPS[Store.stats().done % STAMPS.length]), { cls: 'sign', type: false });
    if (streak >= 3) Fuzz.setCool(true);
    await sleep(V_.hold);
    Fuzz.setArm('none');
    if (Fuzz.isCalm()) await fadeOut();
    else await exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateY(8px) scale(.97)', offset: 0.2 }, { transform: 'translateY(320px) scale(.55) rotate(6deg)', opacity: 0 }], { duration: 560, easing: 'cubic-bezier(.5,0,.9,.6)' });
    st.className = 'stamp'; st.textContent = 'DONE';
    Fuzz.setMood('idle');
    Say.offerUndo('Marked “' + it.title + '” done.', function () { Store.restore(snap); V.refresh(); });
    if (streak >= 3) Fuzz.say('Three in a row. Sunglasses are earned.');
    await showNext();
  }

  async function inClaude() {
    var it = cur(); if (!it || it.kind !== 'task') return;
    streak = 0;
    var b = card.querySelector('[data-act="claude"]'); if (b) { b.classList.add('squish'); setTimeout(function () { b.classList.remove('squish'); }, 180); }
    Fuzz.setMood('stare'); Fuzz.say('Oh. Claude.', { type: false });
    await sleep(1400);
    var snap = Store.snapshot(); Store.session(it.id);
    if (Fuzz.isCalm()) await fadeOut();
    else await exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translate(40%,-30px) scale(.9) rotate(3deg)', opacity: 0.9, offset: 0.3 }, { transform: 'translate(130%,-60px) scale(.7) rotate(8deg)', opacity: 0 }], { duration: 620, easing: 'cubic-bezier(.5,0,.8,.4)' });
    stats();
    Say.offerUndo('Opened “' + it.title + '” in Claude. In this demo it just moves to Current.', function () { Store.restore(snap); V.refresh(); });
    Fuzz.say('It’s fine. I’m not jealous. I’ll watch the queue.', { type: false });
    await sleep(2300);
    Fuzz.setMood('idle');
    await showNext();
  }

  function renderActionsArea() { var it = cur(); var a = $('#actions'); if (a && it) { a.innerHTML = actionsHTML(it); } }
  async function schedule() {
    var it = cur(); if (!it || it.kind !== 'task') return;
    streak = 0;
    if ($('#instr')) edits[it.id] = $('#instr').value;
    scheduling = true; renderCardKeep();
    Fuzz.setMood('eager'); Fuzz.say('Happy to! When should I bring it back?'); Fuzz.pAnim('hop');
    var pickedIdx = await new Promise(function (resolve) { schedResolve = resolve; });
    schedResolve = null;
    if (pickedIdx === -1) { scheduling = false; renderCardKeep(); Fuzz.setMood('idle'); Fuzz.say('Okay, it stays here.', { type: false }); return; }
    var w = pickedIdx === 99 ? exactOpt : WHEN[pickedIdx];
    var btn = card.querySelector('[data-when="' + pickedIdx + '"]'); if (btn) btn.classList.add('picked');
    card.querySelectorAll('[data-when],[data-sched]').forEach(function (b) { b.disabled = true; });
    if (it.dueAt && w.after > mins(it)) {
      Fuzz.setMood('worried'); Fuzz.say('Heads up, that lands after the deadline. Scheduling it anyway.');
      await sleep(2000);
    }
    Fuzz.setMood('happy'); Fuzz.setArm('none'); Fuzz.pAnim('hop');
    Fuzz.say('Done! I’ll bring it back ' + w.text + '.');
    Fuzz.schedGlyph(w.glyph, w.osd);
    var snap = Store.snapshot(); Store.schedule(it.id, w.label, w.text);
    await sleep(1500);
    Fuzz.clearSched();
    await sleep(500);
    await fly(card, Progress.target(), { scale: 0.06, rot: 8, dur: 680 });
    stats(); Fuzz.pAnim('hop');
    Say.offerUndo('Scheduled “' + it.title + '” for ' + w.text + '.', function () { Store.restore(snap); V.refresh(); });
    await sleep(700);
    Fuzz.setMood('idle');
    await showNext();
  }
  var schedResolve = null, exactOpt = null;
  function renderCardKeep() { var it = cur(); if (!it) return; $('#actions').innerHTML = actionsHTML(it); var st = card.querySelector('.stale'); if (st && scheduling) st.hidden = true; else if (st) st.hidden = false; }

  /* Clear a card quickly without a full ceremony: park, wait, let go, drop. */
  async function quickClear(message, change, line, mood) {
    var it = cur(); if (!it) return;
    streak = 0;
    var snap = Store.snapshot(); change(it);
    Fuzz.setMood(mood || 'happy'); Fuzz.say(line, { type: false }); if (mood !== 'sheepish') Fuzz.pAnim('hop');
    if (Fuzz.isCalm()) await fadeOut();
    else await exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateX(-110%) rotate(-8deg)', opacity: 0 }], { duration: 320, easing: 'ease-in' });
    stats();
    Say.offerUndo(message, function () { Store.restore(snap); V.refresh(); });
    await sleep(500);
    Fuzz.setMood('idle');
    await showNext();
  }

  async function thank() {
    Fuzz.setMood('grateful'); Fuzz.pAnim('lift'); Fuzz.hearts();
    Fuzz.say('Thank you! That’s exactly what I needed.');
    await sleep(1900);
  }
  async function answerEntity(which) {
    var it = cur(); if (!it || it.kind === 'task') return;
    var snap = Store.snapshot(); Store.resolve(it.id, which);
    var msg = it.answers[which];
    await thank();
    Fuzz.setMood('happy'); Fuzz.say(msg, { type: false });
    if (Fuzz.isCalm()) await fadeOut();
    else await exitCard([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-20px) scale(.96)', opacity: 0 }], { duration: 300, easing: 'ease-in' });
    stats();
    Say.offerUndo(msg, function () { Store.restore(snap); V.refresh(); });
    await sleep(600);
    Fuzz.setMood('idle');
    await showNext();
  }
  async function entityLater() {
    var it = cur(); if (!it) return;
    Store.toBack(it.id);
    Fuzz.setMood('idle'); Fuzz.pAnim('shrug'); Fuzz.say('Okay, I’ll ask again later.', { type: false });
    await sleep(400);
    await showNext();
  }
  async function answerHandback(i) {
    var it = cur(); if (!it || !it.quick) return;
    var label = it.quick[i];
    var ta = $('#instr'); if (ta) ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + 'Answer: ' + label + '.';
    await thank();
    Fuzz.setMood('idle');
    await assign('Got it, ' + label + '. Back on air.');
  }

  /* ---------- Wiring ---------- */
  function wire() {
    card.addEventListener('input', function (e) {
      var it = cur(); if (!it) return;
      if (e.target.id === 'instr' || e.target.id === 'note') edits[it.id] = e.target.value;
    });
    card.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act],[data-when],[data-tab],[data-quick],[data-sched]');
      if (!t || !card.contains(t)) return;
      if (t.dataset.tab) { tab = t.dataset.tab; var it = cur(); $('#rich').innerHTML = richHTML(it); return; }
      if (t.dataset.when !== undefined) { if (schedResolve) schedResolve(parseInt(t.dataset.when, 10)); return; }
      if (t.dataset.sched) {
        if (t.dataset.sched === 'cancel') { if (schedResolve) schedResolve(-1); }
        else if (t.dataset.sched === 'exact') { var ex = $('#exact'); ex.hidden = !ex.hidden; var dt = $('#exact-dt'); if (!dt.value) { var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); dt.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); } }
        else if (t.dataset.sched === 'exact-go') {
          var v = $('#exact-dt').value; if (!v) return;
          var when = new Date(v), txt = when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
          exactOpt = { label: txt, text: 'on ' + txt, glyph: 'cal', osd: txt.toUpperCase().slice(0, 14), after: (when.getTime() - Date.now()) / 60000 };
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
      else if (a === 'park') moment(function () { return quickClear('Parked “' + cur().title + '”. Find it under All tasks, Parked.', function (i) { Store.park(i.id); }, 'Parked. No date, no pressure.'); });
      else if (a === 'waiting') moment(function () { return quickClear('Moved to Waiting on others. Fuzz will watch for a reply.', function (i) { Store.wait(i.id); }, 'I’ll watch for the reply.'); });
      else if (a === 'letgo') moment(function () { return quickClear('Let go. You can bring it back from Let go.', function (i) { Store.letGo(i.id); }, 'Let go. That one’s off your plate.', 'sleepy'); });
      else if (a === 'keep') { keptStale[cur().id] = true; renderCard(cur()); Fuzz.setMood('happy'); Fuzz.pAnim('hop'); Fuzz.say('Kept. It stays on your list.', { type: false }); setTimeout(function () { if (alive && Fuzz.mood() === 'happy') Fuzz.setMood('idle'); }, 1500); }
      else if (a === 'ent-primary') moment(function () { return answerEntity('primary'); });
      else if (a === 'ent-secondary') moment(function () { return answerEntity('secondary'); });
      else if (a === 'ent-later') moment(entityLater);
    });
    docClick = function (e) {
      var mm = root && root.querySelector('#moremenu');
      if (mm && !mm.hidden && !e.target.closest('.split')) { mm.hidden = true; var mb = root.querySelector('.more-btn'); if (mb) mb.setAttribute('aria-expanded', 'false'); }
    };
    document.addEventListener('click', docClick);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { var mm = $('#moremenu'); if (mm && !mm.hidden) { mm.hidden = true; var mb = $('.more-btn'); if (mb) { mb.setAttribute('aria-expanded', 'false'); mb.focus(); } } }
    });

    $('#dropbtn').addEventListener('click', function () {
      moment(function () { return quickClear('Dropped. Undo if that was a slip.', function (i) { if (i.kind === 'task') Store.drop(i.id); else Store.resolve(i.id, 'dismissed'); }, 'Dropped. One less thing.', 'idle'); });
    });
    $('#parkbtn').addEventListener('click', function (e) {
      var f = $('#parkform'); f.hidden = !f.hidden; e.currentTarget.setAttribute('aria-expanded', String(!f.hidden));
      if (!f.hidden) $('#parktext').focus();
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
        }
      });
    });
  }

  window.TriageView = V;
})();
