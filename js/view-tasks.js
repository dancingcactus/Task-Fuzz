/* Lineup: one page, by who has the ball. To decide (the Triage count), Yours, With Fuzz (his lane, live),
   Waiting on others, Later, then Parked and Finished (both collapsed). Everything here reads and writes the shared Store. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root, openId = null, dlg = null, unsub = null, timer = 0;
  var finQ = '', finHits = null, finAsk = 0, finTimer = 0;

  var TABS = {
    current: { label: 'Current', cols: ['Status', 'Age', 'Now'], states: ['review', 'ai', 'ai-queued', 'sending', 'mine', 'session', 'scheduled'], blurb: 'In motion: running with Fuzz, waiting for your OK, being sent, with you, open in Claude, or coming back later. Fuzz works on a few at once.' },
    parked: { label: 'Parked', cols: ['Status', 'Parked', 'Note'], states: ['parked'], blurb: 'Out of triage with no date. Parked tasks never nag. Fuzz only speaks up when something new comes in about one.' },
    waiting: { label: 'Waiting on others', cols: ['Waiting on', 'Waiting', 'Next check'], states: ['waiting'], blurb: 'You’re blocked until someone gets back to you. Fuzz checks back on each one, and a reply brings it straight back to triage.' },
    done: { label: 'Done', cols: ['Result', 'Finished', 'Summary'], states: ['done'], blurb: 'Finished work. Open any task to see exactly what was done, sent and decided.' },
    letgo: { label: 'Let go', cols: ['Status', 'Let go', 'Note'], states: ['letgo'], blurb: 'Things you decided not to carry. Bring any of them back, no questions asked.' }
  };
  function cells(it, key) {
    if (key === 'current') {
      var m = { review: ['Needs your OK', 'warn'], ai: ['Fuzz working', 'accent'], 'ai-queued': ['Next up', 'muted'], sending: ['Sending', 'accent'], mine: ['With you', 'muted'], session: ['In Claude', 'muted'], scheduled: ['Scheduled', 'muted'] }[it.state];
      if (it.gathering) m = ['Gathering context', 'accent'];
      return { tone: m[1], c2: m[0], c3: it.age, c4: Store.nowText(it) || '—' };
    }
    if (key === 'parked') return { tone: it.woke ? 'accent' : 'muted', c2: it.woke ? 'Woke up' : 'Parked', c3: it.parkedAgo || it.age, c4: it.now || '—' };
    if (key === 'waiting') return { tone: 'warn', c2: it.waitingOn || 'Someone', c3: it.waitedFor || it.age, c4: it.nextCheck || '—' };
    if (key === 'done') return { tone: 'ok', c2: 'Done', c3: it.doneAgo || '—', c4: it.now || '—' };
    return { tone: 'muted', c2: 'Let go', c3: it.doneAgo || '—', c4: it.now || '—' };
  }

  /* Which of the old lists an item belongs to; the task dialog still words its details by list */
  function keyFor(it) {
    for (var k in TABS) if (TABS[k].states.indexOf(it.state) > -1) return k;
    return null;
  }

  /* ---------- One page, by who has the ball ---------- */
  var departed = {}, prevLane = null, openSecs = {};

  function rowHTML(it, status, tone, sub, cls) {
    return '<li><button type="button" class="lrow' + (cls ? ' ' + cls : '') + '" data-open="' + it.id + '">' +
      '<span class="lrow-main"><span class="rt">' + esc(it.title) + '</span><span class="rs">' + esc(it.source) + (it.updated ? ' · Updated' : '') + (Store.partOf(it) ? ' · ' + esc(Store.partOf(it)) : '') + '</span></span>' +
      '<span class="lrow-side">' + UI.pill(status, tone) + (sub ? '<span class="lrow-sub">' + esc(sub) + '</span>' : '') + '</span></button></li>';
  }
  function sectionHTML(id, title, rows, empty, extra) {
    if (!rows.length && !empty) return '';
    return '<section class="lsec" aria-labelledby="sec-' + id + '"><h2 id="sec-' + id + '">' + title + (rows.length ? ' <span class="lcount">' + rows.length + '</span>' : '') + '</h2>' + (extra || '') +
      (rows.length ? '<ul class="lrows">' + rows.join('') + '</ul>' : '<p class="lempty">' + empty + '</p>') + '</section>';
  }

  /* A section that starts closed (Parked, Finished) and stays as you left it while the page updates */
  function foldHTML(id, title, rows, extra) {
    if (!rows.length && !extra) return '';
    return '<details class="lsec fold" id="' + id + '"' + (openSecs[id] ? ' open' : '') + '><summary><h2 id="sec-' + id + '">' + title + (rows.length ? ' <span class="lcount">' + rows.length + '</span>' : '') + '</h2></summary>' +
      (rows.length ? '<ul class="lrows">' + rows.join('') + '</ul>' : '') + (extra || '') + '</details>';
  }

  /* Finished shows the last two weeks. Anything older is a search away, so the page stays quick as the years pile up. */
  function finRow(it) { return it.state === 'done' ? rowHTML(it, 'Done', 'ok', it.doneAgo) : rowHTML(it, it.theirs ? 'Someone else’s' : 'Let go', 'muted', it.doneAgo); }
  function olderHTML() {
    var n = Store.finishedOlder();
    if (!n && !finQ) return '';
    var h = '<div class="fin-older"><label for="fin-q">Search older finished work <span class="lcount">' + n + '</span></label>' +
      '<input id="fin-q" type="search" autocomplete="off" placeholder="Words from the title" value="' + esc(finQ) + '">';
    if (finHits) h += finHits.length ? '<ul class="lrows" aria-label="Older finished work">' + finHits.map(function (it) {
      return finRow(it).replace('data-open="' + it.id + '"', 'data-older="' + it.coreId + '"');
    }).join('') + '</ul>' : '<p class="lempty">Nothing older matches “' + esc(finQ) + '”.</p>';
    return h + '</div>';
  }
  function searchOlder(q) {
    finQ = q; clearTimeout(finTimer);
    var ask = ++finAsk;
    if (!q.trim()) { finHits = null; render(); return; }
    finTimer = setTimeout(function () {
      Live.searchFinished(q.trim()).then(function (hits) { if (ask === finAsk) { finHits = hits; render(); } },
        function (e) { console.error('[fuzz] search', e); });
    }, 250);
  }
  function yoursRows() {
    var mine = Store.inState('review').filter(function (it) { return !Store.inQueue(it.id); });
    var r = mine.map(function (it) { return rowHTML(it, 'Needs your OK', 'warn', 'You set it aside'); });
    Store.inState('mine').forEach(function (it) { r.push(rowHTML(it, 'With you', 'accent', it.now)); });
    Store.inState('session').forEach(function (it) { r.push(rowHTML(it, 'In Claude', 'muted', 'Fuzz keeps the sources open')); });
    return r;
  }

  /* Fuzz's lane: what he is doing right now, step by step */
  function laneHTML() {
    var run = Store.inState('ai'), next = Store.inState('ai-queued'), sending = Store.inState('sending'), now = Date.now();
    var ids = run.concat(next, sending).map(function (it) { return it.id; });
    /* Work that left the lane since the last look says where it went, for a few seconds */
    if (prevLane) prevLane.forEach(function (id) {
      if (ids.indexOf(id) > -1 || departed[id]) return;
      var it = Store.item(id); if (!it) return;
      var sent = it.log[0] && it.log[0].kind === 'sent';
      var note = sent ? (it.state === 'waiting' ? 'Nudge sent. Fuzz watches for the reply.' : 'Sent.') : it.state === 'review' ? 'Draft ready. It’s waiting in Triage.' : it.handedBack ? 'Came back to you in Triage with a question.' : it.state === 'triage' ? 'Back in Triage.' : null;
      if (!note) return;
      departed[id] = { title: it.title, note: note, until: now + 8000 };
      Say.announce('“' + it.title + '”: ' + note);
    });
    prevLane = ids;
    var out = Object.keys(departed).filter(function (id) { if (departed[id].until < now) { delete departed[id]; return false; } return true; });

    var busy = run.length, slots = Store.slots(), pips = '';
    for (var i = 0; i < slots; i++) pips += '<i class="' + (i < busy ? 'on' : '') + '"></i>';
    var h = '<section class="lane" aria-labelledby="sec-fuzz"><div class="lane-head">' + Fuzz.mini(busy ? 'think' : 'good', { cls: 'lane-av' + (busy ? ' working' : '') }) +
      '<div class="lane-titles"><h2 id="sec-fuzz">With Fuzz' + (ids.length ? ' <span class="lcount">' + ids.length + '</span>' : '') + '</h2>' +
      '<p class="lane-slots"><span class="pips" aria-hidden="true">' + pips + '</span>' + busy + ' of ' + slots + ' slots busy' + (next.length ? ', ' + next.length + ' next up' : '') + '</p></div></div>';
    if (!ids.length && !out.length) return h + '<p class="lempty lane-idle">Nothing on my desk. Assign me something from Triage.</p></section>';
    h += '<ul class="lrows lane-rows">';
    run.forEach(function (it) {
      var p = Store.progress(it), dots = '';
      for (var j = 0; j < p.total; j++) dots += '<i class="' + (j < p.done ? 'on' : '') + '"></i>';
      h += '<li><button type="button" class="lrow lane-row" data-open="' + it.id + '"><span class="lrow-main"><span class="rt">' + esc(it.title) + '</span>' +
        '<span class="lane-step">' + UI.text(Store.nowText(it)) + '</span></span>' +
        '<span class="lrow-side"><span class="steps" role="img" aria-label="Step ' + Math.min(p.done + 1, p.total) + ' of ' + p.total + '">' + dots + '</span>' + (it.dueAt ? UI.pill('Rush', 'accent') : '') + '</span></button></li>';
    });
    next.forEach(function (it) { h += rowHTML(it, 'Next up', 'muted', 'Starts when a slot opens', 'lane-row'); });
    sending.forEach(function (it) { h += rowHTML(it, 'Sending', 'accent', Store.nowText(it), 'lane-row'); });
    out.forEach(function (id) { var d = departed[id]; h += '<li class="lane-out"><span class="lrow-main"><span class="rt">' + esc(d.title) + '</span><span class="rs">' + esc(d.note) + '</span></span><a href="#/triage">Go to Triage</a></li>'; });
    return h + '</ul></section>';
  }

  V.mount = function (container) {
    root = container; prevLane = null; departed = {};
    root.innerHTML = '<section class="lineup" aria-labelledby="tasks-h"><div class="tasks-head"><h1 id="tasks-h">Lineup</h1></div><div class="board" id="board"></div></section>';
    root.querySelector('#board').addEventListener('click', function (e) {
      var o = e.target.closest('[data-older]');
      if (o) { Live.loadFinished(o.dataset.older).then(function (it) { open(it.id, o); }, function () { Say.tell('That task wouldn’t open. Try again.'); }); return; }
      var b = e.target.closest('[data-open]'); if (!b) return;
      open(b.dataset.open, b);
    });
    root.querySelector('#board').addEventListener('input', function (e) { if (e.target.id === 'fin-q') searchOlder(e.target.value); });
    root.querySelector('#board').addEventListener('toggle', function (e) { if (e.target.tagName === 'DETAILS') openSecs[e.target.id] = e.target.open; }, true);
    unsub = Store.on(function (e) { if (e.type !== 'change') { render(); if (openId) renderDialog(); } });
    timer = setInterval(function () { if (Object.keys(departed).length) render(); }, 2000);
    render();
  };
  V.unmount = function () {
    if (unsub) unsub(); unsub = null; clearInterval(timer);
    if (dlg) { var d = dlg; dlg = null; openId = null; d.close(); }
    root = null;
  };

  function render() {
    if (!root) return;
    var board = root.querySelector('#board');
    /* Live updates keep your place: focus returns to the same row */
    var ae = document.activeElement, keep = ae && board.contains(ae) ? (ae.dataset.open || ae.id || null) : null;
    var q = Store.queue().length;
    var h = q ? '<a class="decide" href="#/triage"><span class="decide-n">' + q + '</span><span class="decide-t"><strong>To decide</strong>' + (q === 1 ? '1 card' : q + ' cards') + ' in Triage</span><span class="decide-go" aria-hidden="true">→</span></a>'
      : '<p class="decide decide--clear">Nothing to decide. Triage is clear.</p>';
    h += sectionHTML('yours', 'Yours', yoursRows(), 'Nothing is waiting on you right now.');
    h += laneHTML();
    h += sectionHTML('others', 'Waiting on others', Store.inState('waiting').map(function (it) { return rowHTML(it, it.waitingOn || 'Someone', 'warn', !it.nextCheck ? '' : /^Fuzz /.test(it.nextCheck) ? it.nextCheck : 'Checks back ' + it.nextCheck.charAt(0).toLowerCase() + it.nextCheck.slice(1)); }));
    var later = Store.inState('scheduled').map(function (it) { return rowHTML(it, 'Scheduled', 'muted', it.scheduledFor ? 'Back ' + it.scheduledFor : it.now); });
    var parked = Store.inState('parked').sort(function (a, b) { return (b.woke ? 1 : 0) - (a.woke ? 1 : 0); });
    /* A parked task that woke up (something new came in) stays in view; the rest wait in Parked, closed */
    later = parked.filter(function (it) { return it.woke; }).map(function (it) { return rowHTML(it, 'Woke up', 'accent', it.now, 'woke'); }).concat(later);
    h += sectionHTML('later', 'Later', later);
    h += foldHTML('parked', 'Parked', parked.filter(function (it) { return !it.woke; }).map(function (it) { return rowHTML(it, 'Parked', 'muted', 'No date'); }));
    var fin = Store.inState('done', 'letgo').sort(function (a, b) { return (b.changedAt || 0) - (a.changedAt || 0); }).map(finRow);
    h += foldHTML('fin', Store.finishedOlder() ? 'Finished · last 2 weeks' : 'Finished', fin, olderHTML());
    board.innerHTML = h;
    if (keep) {
      var el = board.querySelector('[data-open="' + keep + '"]') || document.getElementById(keep); if (el) el.focus({ preventScroll: true });
      if (el && el.id === 'fin-q') el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function actionsFor(it) {
    var A = [];
    function act(label, kind, fn, msg) { A.push({ label: label, kind: kind, fn: fn, msg: msg }); }
    var id = it.id, r = Store.recipient(it);
    if (it.state === 'review') {
      if (r) {
        act('Approve and send', 'primary', function (text) { Store.approve(id, text); }, 'Approved. Fuzz is sending it to ' + r.to + '.');
        act('Mark done', 'menu', function () { Store.done(id); }, 'Marked done. Fuzz won’t send the draft.');
      } else act('Looks good', 'primary', function (text) { Store.accept(id, text); }, 'Approved and filed in Done.');
      if (!Store.inQueue(id)) act('Put it in triage', 'secondary', function () { Store.queueUp(Store.item(id), 'front'); }, 'It’s first in triage.');
    } else if (it.state === 'ai' || it.state === 'ai-queued') {
      act('Pull back into triage', 'secondary', function () { Store.bringBack(id, 'front'); }, 'Pulled back into triage.');
    } else if (it.state === 'mine') {
      act('Mark done', 'primary', function () { Store.markDone(id); }, 'Marked done.');
      act('Hand to Fuzz', 'secondary', function () { Store.handToFuzz(id); }, 'Handed to Fuzz.');
    } else if (it.state === 'session') {
      act('Mark done', 'primary', function () { Store.markDone(id); }, 'Marked done.');
      act('Pull back into triage', 'secondary', function () { Store.bringBack(id, 'front'); }, 'Pulled back into triage.');
    } else if (it.state === 'scheduled') {
      act('Bring back now', 'primary', function () { Store.bringBack(id, 'front'); }, 'Moved back into triage.');
      act('Hand to Fuzz', 'secondary', function () { Store.handToFuzz(id); }, 'Handed to Fuzz.');
    } else if (it.state === 'parked') {
      act('To triage', 'primary', function () { Store.bringBack(id, 'back'); }, 'Back in triage, at the end of the queue.');
      act('Hand to Fuzz', 'secondary', function () { Store.handToFuzz(id); }, 'Handed to Fuzz.');
      act('Let go', 'secondary', function () { Store.letGo(id); }, 'Let go. You can bring it back from Let go.');
    } else if (it.state === 'waiting') {
      if (it.nudge) act('Approve and send nudge', 'primary', function (text) { Store.nudgeSent(id, text); }, 'Approved. Fuzz is sending the nudge to ' + (it.waitingOn || 'them') + '.');
      else act('Draft a nudge', 'secondary', function () { it.nudge = true; it.draft = it.draft || 'Hi ' + (it.waitingOn || 'there') + ', a quick nudge on “' + it.title + '”. Let me know if you need anything from me. Thanks!'; it.nextCheck = 'Nudge drafted, needs your OK'; Store.log(it, 'action', 'Drafted a nudge for your review.'); }, 'Drafted a nudge for your review.');
      act('Replied', 'secondary', function () { Store.replied(id); }, 'Back in triage with the reply attached.');
    } else if (it.state === 'done') {
      act('Reopen', 'primary', function () { Store.reopen(id); }, 'Reopened. It’s first in triage.');
    } else if (it.state === 'letgo') {
      act('Bring back', 'primary', function () { Store.reopen(id); }, 'Brought back. It’s first in triage.');
    }
    return A;
  }

  /* How each action is named in the Undo list; % is the task title */
  var DID = { 'Approve and send': 'Approved % to send', 'Approve and send nudge': 'Approved the nudge for %', 'Looks good': 'Approved %', 'Put it in triage': 'Moved % to triage', 'Pull back into triage': 'Pulled % back into triage', 'Mark done': 'Marked % done',
    'Bring back now': 'Brought % back to triage', 'Hand to Fuzz': 'Handed % to Fuzz', 'To triage': 'Moved % to triage', 'Let go': 'Let go of %',
    'Draft a nudge': 'Drafted a nudge for %', 'Replied': 'Marked % replied', 'Reopen': 'Reopened %', 'Bring back': 'Brought back %' };
  function didLabel(a, it) { return (DID[a.label] || a.label + ': %').replace('%', '“' + it.title + '”') + '.'; }
  var HEAD = { current: 'What’s happening now', parked: 'What Fuzz noticed', waiting: 'What Fuzz is doing', done: 'How it ended', letgo: 'What Fuzz noticed' };
  /* For a draft waiting for your OK, the draft and the decision come first: who it goes to, the text you
     can change, then the buttons. The background follows. */
  function draftHTML(it, acts) {
    var r = it.state === 'waiting' ? { to: it.waitingOn || 'them', via: it.source } : Store.recipient(it);
    var h = '<section class="draftbox draft"><h3>' + (it.state === 'review' ? 'Draft, ready for your OK' : 'Nudge, ready for your OK') + '</h3>' +
      '<div class="draft-to">' + (r ? '<span>To</span> <strong>' + esc(r.to) + '</strong><span class="via">' + esc(r.via) + '</span>' : '<strong>Just for you</strong><span class="via">Nothing is sent anywhere</span>') + '</div>' +
      '<label class="sr" for="dlg-draft">' + (r ? 'Message to ' + esc(r.to) : 'Fuzz’s write-up') + '</label><textarea id="dlg-draft" rows="5">' + esc(it.draft) + '</textarea></section>';
    h += actionsRow(acts, it.state === 'review');
    if (r) h += '<p class="sendnote">Fuzz sends exactly this once you approve. You can undo until it has gone out.</p>';
    if (it.state === 'review') h += '<form class="revise" id="dlg-revise" hidden><label for="dlg-revise-text">Tell Fuzz what to change</label><div class="parkrow"><input id="dlg-revise-text" type="text" autocomplete="off" placeholder="For example: shorter, and mention the two maybes"><button class="btn" type="submit">Send back to Fuzz</button></div></form>';
    return h;
  }
  function actionsRow(acts, revise) {
    /* A 'menu' action sits in a dropdown beside the primary one: on a draft, Mark done is for when you send it yourself */
    var menu = acts.map(function (a, i) { return a.kind === 'menu' ? '<button type="button" role="menuitem" data-do="' + i + '"><b>' + esc(a.label) + '</b><span>You send it yourself. Fuzz won’t send this draft.</span></button>' : ''; }).join('');
    return '<div class="dlg-actions">' + acts.map(function (a, i) {
      if (a.kind === 'menu') return '';
      var b = '<button type="button" class="btn ' + (a.kind === 'primary' ? 'primary' : '') + (a.kind === 'primary' && menu ? ' done-btn' : '') + '" data-do="' + i + '">' + esc(a.label) + '</button>';
      if (a.kind !== 'primary' || !menu) return b;
      return '<div class="split">' + b + '<button type="button" class="btn primary more-btn" data-dmore aria-haspopup="menu" aria-expanded="false" aria-label="Finish it another way" title="Finish it another way"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="menu" role="menu" id="dlg-menu" hidden aria-label="Finish it another way">' + menu + '</div></div>';
    }).join('') +
      (revise ? '<button type="button" class="btn" data-revise aria-expanded="false" aria-controls="dlg-revise">Ask Fuzz to change it</button>' : '') + '</div>';
  }
  function detailHTML(it) {
    var tab = keyFor(it) || 'current', c = cells(it, tab), acts = actionsFor(it);
    var draft = (it.state === 'review' || (it.state === 'waiting' && it.nudge)) && it.draft;
    var h = '<div class="dlg-top"><div class="dlg-titles"><div class="dlg-chips">' + UI.pill(c.c2, c.tone) + '<span class="meta">' + esc(it.source) + ' · ' + esc(TABS[tab].cols[1]) + ': ' + esc(c.c3) + '</span></div>' +
      '<h2 id="dlg-title">' + esc(it.title) + '</h2>' + (Store.partOf(it) ? '<button type="button" class="partof" data-group="' + it.group + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/></svg>' + esc(Store.partOf(it, true)) + '</button>' : '') + '</div><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      (draft ? draftHTML(it, acts) : '') +
      '<p class="dlg-what">' + esc(it.incoming) + '</p>';
    if (it.doneWhen) h += '<section class="donewhen"><h3>Done when</h3><p>' + esc(it.doneWhen.charAt(0).toUpperCase() + it.doneWhen.slice(1)) + '</p></section>';
    if (it.aiNote) h += '<section class="ainote"><h3>' + (it.state === 'review' ? 'What Fuzz did' : HEAD[tab]) + '</h3><p>' + UI.text(Store.nowText(it) && tab === 'current' && it.state === 'ai' ? Store.nowText(it).replace(/[.!]+$/, '') + '. ' + it.aiNote : it.aiNote) + '</p></section>';
    if (it.code && it.code.length) h += '<section><h3>Code</h3>' + CodeView.section(it.code, 'dlg:' + it.id) + '</section>';
    if (it.log.length) h += '<section><h3>Done so far</h3>' + UI.logHTML(it.log) + '</section>';
    if (it.sources.length) h += '<section><h3>Sources</h3>' + UI.sourcesHTML(it.sources) + '</section>';
    if (!draft) h += actionsRow(acts, false);
    return h + UI.idTag(it);
  }
  /* Each change undoes on its own, or says why it can't (the core's model) */
  function undoer(ch) { return function () { var why = ch.undo(); if (!why && root) render(); return why; }; }
  function open(id, trigger) {
    var it = Store.item(id); if (!it) return;
    openId = id;
    var d = document.createElement('dialog');
    d.className = 'dlg'; d.setAttribute('aria-labelledby', 'dlg-title');
    d.innerHTML = '<div class="dlg-in" id="dlg-in"></div>';
    document.body.appendChild(d); dlg = d;
    d.addEventListener('close', function () { d.remove(); if (dlg === d) { dlg = null; openId = null; } if (trigger && document.body.contains(trigger)) trigger.focus(); });
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('[data-close]')) { d.close(); return; }
      var gp = e.target.closest('[data-group]');
      if (gp) { openGroup(gp.dataset.group, gp); return; }
      var dm = d.querySelector('#dlg-menu'), mb = e.target.closest('[data-dmore]');
      if (mb) { dm.hidden = !dm.hidden; mb.setAttribute('aria-expanded', String(!dm.hidden)); if (!dm.hidden) dm.querySelector('button').focus(); return; }
      if (dm && !dm.hidden && !e.target.closest('#dlg-menu')) { dm.hidden = true; d.querySelector('[data-dmore]').setAttribute('aria-expanded', 'false'); }
      var rv = e.target.closest('[data-revise]');
      if (rv) { var f = d.querySelector('#dlg-revise'); f.hidden = !f.hidden; rv.setAttribute('aria-expanded', String(!f.hidden)); if (!f.hidden) d.querySelector('#dlg-revise-text').focus(); return; }
      var b = e.target.closest('[data-do]'); if (!b) return;
      var cur = Store.item(openId); var a = actionsFor(cur)[parseInt(b.dataset.do, 10)];
      if (!a) return;
      var ta = d.querySelector('#dlg-draft'), text = ta ? ta.value : null;
      var ch = Store.track([cur.id], function () { a.fn(text); });
      d.close();
      Say.tell(a.msg, { label: didLabel(a, cur), undo: undoer(ch), blocked: ch.blocked });
      render();
    });
    d.addEventListener('submit', function (e) {
      if (e.target.id !== 'dlg-revise') return;
      e.preventDefault();
      var note = d.querySelector('#dlg-revise-text').value.trim(); if (!note) return;
      var ta = d.querySelector('#dlg-draft'), cur = Store.item(openId), text = ta ? ta.value : null;
      var ch = Store.track([cur.id], function () { Store.revise(cur.id, note, text); });
      d.close();
      Say.tell('Sent back to Fuzz to change.', { label: 'Sent “' + cur.title + '” back to Fuzz.', undo: undoer(ch), blocked: ch.blocked });
      render(); Store.emit({ type: 'work' });
    });
    renderDialog();
    d.showModal();
  }
  /* From the group sheet, opening a task swaps the sheet for that task's detail */
  function openGroup(groupId, trigger) {
    GroupSheet.open(groupId, { trigger: trigger,
      onOpenTask: function (id) { if (dlg) dlg.close(); open(id); },
      canOpen: function (it) { return !!keyFor(it); },
      onChange: function () { render(); renderDialog(); }, onUndo: function () { render(); renderDialog(); } });
  }
  function renderDialog() {
    if (!dlg) return;
    var it = Store.item(openId), inner = dlg.querySelector('#dlg-in');
    if (!it || !keyFor(it)) { dlg.close(); return; }
    /* Fuzz's background work re-renders this often; don't wipe what you're typing */
    if (inner.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
    var st = inner.scrollTop; inner.innerHTML = detailHTML(it); inner.scrollTop = st;
  }

  window.TasksView = V;
})();
