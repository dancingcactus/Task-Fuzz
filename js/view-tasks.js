/* Lineup: one page, by who has the ball. To decide (the Triage count), Yours, With Fuzz (his lane, live),
   With others, Later, then Parked and Finished (both collapsed). Everything here reads and writes the shared Store. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root, openId = null, dlg = null, unsub = null, timer = 0;

  var TABS = {
    current: { label: 'Current', cols: ['Status', 'Age', 'Now'], states: ['review', 'ai', 'ai-queued', 'mine', 'session', 'scheduled'], blurb: 'In motion: running with Fuzz, waiting for your OK, with you, open in Claude, or coming back later. Fuzz runs up to five at once.' },
    parked: { label: 'Parked', cols: ['Status', 'Parked', 'Note'], states: ['parked'], blurb: 'Out of triage with no date. Parked tasks never nag. Fuzz only speaks up when something new comes in about one.' },
    waiting: { label: 'Waiting on others', cols: ['Waiting on', 'Waiting', 'Next check'], states: ['waiting'], blurb: 'With someone else. Fuzz watches for replies and drafts nudges for your OK. Replies go straight back to triage.' },
    done: { label: 'Done', cols: ['Result', 'Finished', 'Summary'], states: ['done'], blurb: 'Finished work. Open any task to see exactly what was done, sent and decided.' },
    letgo: { label: 'Let go', cols: ['Status', 'Let go', 'Note'], states: ['letgo'], blurb: 'Things you decided not to carry. Bring any of them back, no questions asked.' }
  };
  function cells(it, key) {
    if (key === 'current') {
      var m = { review: ['Needs your OK', 'warn'], ai: ['Fuzz working', 'accent'], 'ai-queued': ['Next up', 'muted'], mine: ['With you', 'muted'], session: ['In Claude', 'muted'], scheduled: ['Scheduled', 'muted'] }[it.state];
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
  var LANE_MAX = 5;

  function rowHTML(it, status, tone, sub, cls) {
    return '<li><button type="button" class="lrow' + (cls ? ' ' + cls : '') + '" data-open="' + it.id + '">' +
      '<span class="lrow-main"><span class="rt">' + esc(it.title) + '</span><span class="rs">' + esc(it.source) + (it.updated ? ' · Updated' : '') + '</span></span>' +
      '<span class="lrow-side">' + UI.pill(status, tone) + (sub ? '<span class="lrow-sub">' + esc(sub) + '</span>' : '') + '</span></button></li>';
  }
  function sectionHTML(id, title, rows, empty, extra) {
    if (!rows.length && !empty) return '';
    return '<section class="lsec" aria-labelledby="sec-' + id + '"><h2 id="sec-' + id + '">' + title + (rows.length ? ' <span class="lcount">' + rows.length + '</span>' : '') + '</h2>' + (extra || '') +
      (rows.length ? '<ul class="lrows">' + rows.join('') + '</ul>' : '<p class="lempty">' + empty + '</p>') + '</section>';
  }

  /* A section that starts closed (Parked, Finished) and stays as you left it while the page updates */
  function foldHTML(id, title, rows) {
    if (!rows.length) return '';
    return '<details class="lsec fold" id="' + id + '"' + (openSecs[id] ? ' open' : '') + '><summary><h2 id="sec-' + id + '">' + title + ' <span class="lcount">' + rows.length + '</span></h2></summary><ul class="lrows">' + rows.join('') + '</ul></details>';
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
    var run = Store.inState('ai'), next = Store.inState('ai-queued'), now = Date.now();
    var ids = run.concat(next).map(function (it) { return it.id; });
    /* Work that left the lane since the last look says where it went, for a few seconds */
    if (prevLane) prevLane.forEach(function (id) {
      if (ids.indexOf(id) > -1 || departed[id]) return;
      var it = Store.item(id); if (!it) return;
      var note = it.state === 'review' ? 'Draft ready. It’s waiting in Triage.' : it.handedBack ? 'Came back to you in Triage with a question.' : it.state === 'triage' ? 'Back in Triage.' : null;
      if (!note) return;
      departed[id] = { title: it.title, note: note, until: now + 8000 };
      Say.announce('“' + it.title + '”: ' + note);
    });
    prevLane = ids;
    var out = Object.keys(departed).filter(function (id) { if (departed[id].until < now) { delete departed[id]; return false; } return true; });

    var busy = run.length, pips = '';
    for (var i = 0; i < LANE_MAX; i++) pips += '<i class="' + (i < busy ? 'on' : '') + '"></i>';
    var h = '<section class="lane" aria-labelledby="sec-fuzz"><div class="lane-head">' + Fuzz.mini(busy ? 'think' : 'good', { cls: 'lane-av' + (busy ? ' working' : '') }) +
      '<div class="lane-titles"><h2 id="sec-fuzz">With Fuzz' + (ids.length ? ' <span class="lcount">' + ids.length + '</span>' : '') + '</h2>' +
      '<p class="lane-slots"><span class="pips" aria-hidden="true">' + pips + '</span>' + busy + ' of ' + LANE_MAX + ' slots busy' + (next.length ? ', ' + next.length + ' next up' : '') + '</p></div></div>';
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
    out.forEach(function (id) { var d = departed[id]; h += '<li class="lane-out"><span class="lrow-main"><span class="rt">' + esc(d.title) + '</span><span class="rs">' + esc(d.note) + '</span></span><a href="#/triage">Go to Triage</a></li>'; });
    return h + '</ul></section>';
  }

  V.mount = function (container) {
    root = container; prevLane = null; departed = {};
    root.innerHTML = '<section class="lineup" aria-labelledby="tasks-h"><div class="tasks-head"><h1 id="tasks-h">Lineup</h1></div><div class="board" id="board"></div></section>';
    root.querySelector('#board').addEventListener('click', function (e) {
      var b = e.target.closest('[data-open]'); if (!b) return;
      open(b.dataset.open, b);
    });
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
    h += sectionHTML('others', 'With others', Store.inState('waiting').map(function (it) { return rowHTML(it, it.waitingOn || 'Someone', 'warn', !it.nextCheck ? '' : /,/.test(it.nextCheck) ? it.nextCheck : 'Next check: ' + it.nextCheck.charAt(0).toLowerCase() + it.nextCheck.slice(1)); }));
    var later = Store.inState('scheduled').map(function (it) { return rowHTML(it, 'Scheduled', 'muted', it.scheduledFor ? 'Back ' + it.scheduledFor : it.now); });
    var parked = Store.inState('parked').sort(function (a, b) { return (b.woke ? 1 : 0) - (a.woke ? 1 : 0); });
    /* A parked task that woke up (something new came in) stays in view; the rest wait in Parked, closed */
    later = parked.filter(function (it) { return it.woke; }).map(function (it) { return rowHTML(it, 'Woke up', 'accent', it.now, 'woke'); }).concat(later);
    h += sectionHTML('later', 'Later', later);
    h += foldHTML('parked', 'Parked', parked.filter(function (it) { return !it.woke; }).map(function (it) { return rowHTML(it, 'Parked', 'muted', 'No date'); }));
    var fin = Store.inState('done').map(function (it) { return rowHTML(it, 'Done', 'ok', it.doneAgo); })
      .concat(Store.inState('letgo').map(function (it) { return rowHTML(it, 'Let go', 'muted', it.doneAgo); }));
    h += foldHTML('fin', 'Finished', fin);
    board.innerHTML = h;
    if (keep) { var el = board.querySelector('[data-open="' + keep + '"]') || document.getElementById(keep); if (el) el.focus({ preventScroll: true }); }
  }

  function actionsFor(it) {
    var A = [];
    /* o.final: it can't be taken back (sending), so it gets no Undo */
    function act(label, kind, fn, msg, o) { A.push({ label: label, kind: kind, fn: fn, msg: msg, final: !!(o && o.final) }); }
    var id = it.id, r = Store.recipient(it);
    if (it.state === 'review') {
      if (r) act('Approve and send', 'primary', function (text) { Store.approve(id, text); }, 'Sent to ' + r.to + '.', { final: true });
      else act('Looks good', 'primary', function (text) { Store.accept(id, text); }, 'Approved and filed in Done.');
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
      if (it.nudge) act('Approve and send nudge', 'primary', function (text) { Store.nudgeSent(id, text); }, 'Nudge sent to ' + (it.waitingOn || 'them') + '. Fuzz checks again tomorrow.', { final: true });
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
  var DID = { 'Looks good': 'Approved %', 'Put it in triage': 'Moved % to triage', 'Pull back into triage': 'Pulled % back into triage', 'Mark done': 'Marked % done',
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
    if (r) h += '<p class="sendnote">Sending can’t be undone. Change anything above first.</p>';
    if (it.state === 'review') h += '<form class="revise" id="dlg-revise" hidden><label for="dlg-revise-text">Tell Fuzz what to change</label><div class="parkrow"><input id="dlg-revise-text" type="text" autocomplete="off" placeholder="For example: shorter, and mention the two maybes"><button class="btn" type="submit">Send back to Fuzz</button></div></form>';
    return h;
  }
  function actionsRow(acts, revise) {
    return '<div class="dlg-actions">' + acts.map(function (a, i) { return '<button type="button" class="btn ' + (a.kind === 'primary' ? 'primary' : '') + '" data-do="' + i + '">' + esc(a.label) + '</button>'; }).join('') +
      (revise ? '<button type="button" class="btn" data-revise aria-expanded="false" aria-controls="dlg-revise">Ask Fuzz to change it</button>' : '') + '</div>';
  }
  function detailHTML(it) {
    var tab = keyFor(it) || 'current', c = cells(it, tab), acts = actionsFor(it);
    var draft = (it.state === 'review' || (it.state === 'waiting' && it.nudge)) && it.draft;
    var h = '<div class="dlg-top"><div class="dlg-titles"><div class="dlg-chips">' + UI.pill(c.c2, c.tone) + '<span class="meta">' + esc(it.source) + ' · ' + esc(TABS[tab].cols[1]) + ': ' + esc(c.c3) + '</span></div>' +
      '<h2 id="dlg-title">' + esc(it.title) + '</h2></div><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      (draft ? draftHTML(it, acts) : '') +
      '<p class="dlg-what">' + esc(it.incoming) + '</p>';
    if (it.aiNote) h += '<section class="ainote"><h3>' + (it.state === 'review' ? 'What Fuzz did' : HEAD[tab]) + '</h3><p>' + UI.text(Store.nowText(it) && tab === 'current' && it.state === 'ai' ? Store.nowText(it).replace(/[.!]+$/, '') + '. ' + it.aiNote : it.aiNote) + '</p></section>';
    if (it.code && it.code.length) h += '<section><h3>Code</h3>' + CodeView.section(it.code, 'dlg:' + it.id) + '</section>';
    if (it.log.length) h += '<section><h3>Done so far</h3>' + UI.logHTML(it.log) + '</section>';
    if (it.sources.length) h += '<section><h3>Sources</h3>' + UI.sourcesHTML(it.sources) + '</section>';
    if (!draft) h += actionsRow(acts, false);
    return h;
  }
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
      var rv = e.target.closest('[data-revise]');
      if (rv) { var f = d.querySelector('#dlg-revise'); f.hidden = !f.hidden; rv.setAttribute('aria-expanded', String(!f.hidden)); if (!f.hidden) d.querySelector('#dlg-revise-text').focus(); return; }
      var b = e.target.closest('[data-do]'); if (!b) return;
      var cur = Store.item(openId); var a = actionsFor(cur)[parseInt(b.dataset.do, 10)];
      if (!a) return;
      var ta = d.querySelector('#dlg-draft'), snap = Store.snapshot(); a.fn(ta ? ta.value : null);
      d.close();
      /* Sending can't be undone, so it's reported without an Undo */
      if (a.final) Say.tell(a.msg); else Say.tell(a.msg, { label: didLabel(a, cur), undo: function () { Store.restore(snap); if (root) render(); } });
      render();
    });
    d.addEventListener('submit', function (e) {
      if (e.target.id !== 'dlg-revise') return;
      e.preventDefault();
      var note = d.querySelector('#dlg-revise-text').value.trim(); if (!note) return;
      var ta = d.querySelector('#dlg-draft'), cur = Store.item(openId), snap = Store.snapshot();
      Store.revise(cur.id, note, ta ? ta.value : null);
      d.close();
      Say.tell('Sent back to Fuzz to change.', { label: 'Sent “' + cur.title + '” back to Fuzz.', undo: function () { Store.restore(snap); if (root) render(); } });
      render(); Store.emit({ type: 'work' });
    });
    renderDialog();
    d.showModal();
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
