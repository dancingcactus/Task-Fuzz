/* All tasks: Current, Parked, Waiting on others, Done, Let go.
   Layout comes from the Triage Queue mockup. Everything here reads and writes the shared Store. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root, tab = 'current', openId = null, dlg = null, unsub = null, timer = 0;

  var TABS = {
    current: { label: 'Current', cols: ['Status', 'Age', 'Now'], states: ['review', 'ai', 'ai-queued', 'session', 'scheduled'], blurb: 'In motion: running with Fuzz, waiting for your OK, open with you in Claude, or coming back later. Fuzz runs up to five at once.' },
    parked: { label: 'Parked', cols: ['Status', 'Parked', 'Note'], states: ['parked'], blurb: 'Out of triage with no date. Parked tasks never nag. Fuzz only speaks up when something new comes in about one.' },
    waiting: { label: 'Waiting on others', cols: ['Waiting on', 'Waiting', 'Next check'], states: ['waiting'], blurb: 'With someone else. Fuzz watches for replies and drafts nudges for your OK. Replies go straight back to triage.' },
    done: { label: 'Done', cols: ['Result', 'Finished', 'Summary'], states: ['done'], blurb: 'Finished work. Open any task to see exactly what was done, sent and decided.' },
    letgo: { label: 'Let go', cols: ['Status', 'Let go', 'Note'], states: ['letgo'], blurb: 'Things you decided not to carry. Bring any of them back, no questions asked.' }
  };
  var ORDER = ['current', 'parked', 'waiting', 'done', 'letgo'];
  var STATE_ORDER = { review: 0, ai: 1, 'ai-queued': 2, session: 3, scheduled: 4 };

  function rowsFor(key) {
    var T = TABS[key];
    var list = Store.inState.apply(Store, T.states);
    if (key === 'current') list.sort(function (a, b) { return STATE_ORDER[a.state] - STATE_ORDER[b.state]; });
    return list;
  }
  function cells(it, key) {
    if (key === 'current') {
      var m = { review: ['Needs your OK', 'warn'], ai: ['Fuzz working', 'accent'], 'ai-queued': ['Next up', 'muted'], session: ['In Claude', 'muted'], scheduled: ['Scheduled', 'muted'] }[it.state];
      return { tone: m[1], c2: m[0], c3: it.age, c4: Store.nowText(it) || '—' };
    }
    if (key === 'parked') return { tone: it.woke ? 'accent' : 'muted', c2: it.woke ? 'Woke up' : 'Parked', c3: it.parkedAgo || it.age, c4: it.now || '—' };
    if (key === 'waiting') return { tone: 'warn', c2: it.waitingOn || 'Someone', c3: it.waitedFor || it.age, c4: it.nextCheck || '—' };
    if (key === 'done') return { tone: 'ok', c2: 'Done', c3: it.doneAgo || '—', c4: it.now || '—' };
    return { tone: 'muted', c2: 'Let go', c3: it.doneAgo || '—', c4: it.now || '—' };
  }

  function fuzzLine() {
    var s = Store.stats(), rev = Store.inState('review').length;
    var working = s.withFuzz ? 'working on ' + s.withFuzz + (s.withFuzz === 1 ? ' task' : ' tasks') : '';
    var drafts = rev ? rev + (rev === 1 ? ' draft' : ' drafts') + ' ready for your OK' : '';
    if (working && drafts) return 'Fuzz is ' + working + ' and has ' + drafts + '.';
    if (working) return 'Fuzz is ' + working + '.';
    if (drafts) return 'Fuzz has ' + drafts + '.';
    return 'Fuzz is on standby. Nothing is running right now.';
  }

  V.mount = function (container) {
    root = container; if (!TABS[tab]) tab = 'current';
    root.innerHTML = '<section class="tasks" aria-labelledby="tasks-h">' +
      '<div class="tasks-head"><h1 id="tasks-h">All tasks</h1>' +
        '<div class="fuzz-strip" id="strip"></div></div>' +
      '<div role="tablist" aria-label="Task lists" class="tablist" id="tablist"></div>' +
      '<div class="tab-blurb"><p id="blurb"></p></div>' +
      '<div class="tablewrap" id="panel" role="tabpanel" tabindex="-1"></div></section>';
    root.querySelector('#tablist').addEventListener('click', function (e) {
      var b = e.target.closest('[role="tab"]'); if (!b) return;
      tab = b.dataset.tab; render();
    });
    root.querySelector('#tablist').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = ORDER.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
      tab = ORDER[(i + ORDER.length) % ORDER.length]; render();
      root.querySelector('[data-tab="' + tab + '"]').focus();
    });
    root.querySelector('#panel').addEventListener('click', function (e) {
      var b = e.target.closest('[data-open]'); if (!b) return;
      open(b.dataset.open, b);
    });
    unsub = Store.on(function (e) { if (e.type !== 'change') { render(); if (openId) renderDialog(); } });
    render();
  };
  V.unmount = function () {
    if (unsub) unsub(); unsub = null;
    if (dlg) { var d = dlg; dlg = null; openId = null; d.close(); }
    root = null;
  };

  function render() {
    if (!root) return;
    root.querySelector('#strip').innerHTML = Fuzz.mini(Store.stats().withFuzz ? 'think' : 'good', { cls: 'strip-av' }) + '<span>' + esc(fuzzLine()) + '</span>';
    root.querySelector('#tablist').innerHTML = ORDER.map(function (k) {
      var on = k === tab;
      return '<button type="button" role="tab" id="tab-' + k + '" data-tab="' + k + '" aria-selected="' + on + '" aria-controls="panel" tabindex="' + (on ? 0 : -1) + '">' + TABS[k].label + '<span class="count">' + rowsFor(k).length + '</span></button>';
    }).join('');
    var T = TABS[tab], rows = rowsFor(tab);
    root.querySelector('#blurb').textContent = T.blurb;
    root.querySelector('#panel').setAttribute('aria-labelledby', 'tab-' + tab);
    var html = '<table class="tasktable"><thead><tr><th scope="col">Task</th><th scope="col">' + T.cols[0] + '</th><th scope="col">' + T.cols[1] + '</th><th scope="col">' + T.cols[2] + '</th><th scope="col" class="sr">Open</th></tr></thead><tbody>';
    rows.forEach(function (it) {
      var c = cells(it, tab);
      html += '<tr><td data-label="Task"><button type="button" class="rowbtn" data-open="' + it.id + '"><span class="rt">' + esc(it.title) + '</span><span class="rs">' + esc(it.source) + (it.updated ? ' · Updated' : '') + '</span></button></td>' +
        '<td data-label="' + T.cols[0] + '">' + UI.pill(c.c2, c.tone) + '</td><td data-label="' + T.cols[1] + '" class="nowrap">' + esc(c.c3) + '</td><td data-label="' + T.cols[2] + '">' + esc(c.c4) + '</td>' +
        '<td class="chev" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></td></tr>';
    });
    html += '</tbody></table>' + (rows.length ? '' : '<p class="nothing">Nothing here right now.</p>');
    root.querySelector('#panel').innerHTML = html;
  }

  function actionsFor(it) {
    var A = [];
    function act(label, kind, fn, msg) { A.push({ label: label, kind: kind, fn: fn, msg: msg }); }
    var id = it.id;
    if (it.state === 'review') {
      act('Approve and send', 'primary', function () { Store.approve(id); }, 'Sent. It’s logged in Done so far.');
      act('Pull back into triage', 'secondary', function () { Store.bringBack(id, 'front'); }, 'Pulled back into triage.');
    } else if (it.state === 'ai' || it.state === 'ai-queued') {
      act('Pull back into triage', 'secondary', function () { Store.bringBack(id, 'front'); }, 'Pulled back into triage.');
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
      if (it.nudge) act('Approve and send nudge', 'primary', function () { Store.nudgeSent(id); }, 'Nudge sent. Fuzz checks again tomorrow.');
      else act('Draft a nudge', 'secondary', function () { it.nudge = true; it.draft = it.draft || 'Hi ' + (it.waitingOn || 'there') + ', a quick nudge on “' + it.title + '”. Let me know if you need anything from me. Thanks!'; it.nextCheck = 'Nudge drafted, needs your OK'; Store.log(it, 'action', 'Drafted a nudge for your review.'); }, 'Drafted a nudge for your review.');
      act('Replied', 'secondary', function () { Store.replied(id); }, 'Back in triage with the reply attached.');
    } else if (it.state === 'done') {
      act('Reopen', 'primary', function () { Store.reopen(id); }, 'Reopened. It’s first in triage.');
    } else if (it.state === 'letgo') {
      act('Bring back', 'primary', function () { Store.reopen(id); }, 'Brought back. It’s first in triage.');
    }
    return A;
  }

  var HEAD = { current: 'What’s happening now', parked: 'What Fuzz noticed', waiting: 'What Fuzz is doing', done: 'How it ended', letgo: 'What Fuzz noticed' };
  function detailHTML(it) {
    var c = cells(it, tab), acts = actionsFor(it);
    var draft = (it.state === 'review' || (it.state === 'waiting' && it.nudge)) && it.draft;
    var h = '<div class="dlg-top"><div class="dlg-titles"><div class="dlg-chips">' + UI.pill(c.c2, c.tone) + '<span class="meta">' + esc(it.source) + ' · ' + esc(TABS[tab].cols[1]) + ': ' + esc(c.c3) + '</span></div>' +
      '<h2 id="dlg-title">' + esc(it.title) + '</h2></div><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
      '<p class="dlg-what">' + esc(it.incoming) + '</p>';
    if (it.aiNote) h += '<section class="ainote"><h3>' + HEAD[tab] + '</h3><p>' + UI.text(Store.nowText(it) && tab === 'current' && it.state === 'ai' ? Store.nowText(it).replace(/[.!]+$/, '') + '. ' + it.aiNote : it.aiNote) + '</p></section>';
    if (draft) h += '<section class="draftbox"><h3>' + (it.state === 'review' ? 'Draft, ready for your OK' : 'Nudge, ready for your OK') + '</h3><blockquote>' + esc(it.draft) + '</blockquote><p class="meta">Nothing is sent until you approve it.</p></section>';
    if (it.code && it.code.length) h += '<section><h3>Code</h3>' + CodeView.section(it.code, 'dlg:' + it.id) + '</section>';
    if (it.log.length) h += '<section><h3>Done so far</h3>' + UI.logHTML(it.log) + '</section>';
    if (it.sources.length) h += '<section><h3>Sources</h3>' + UI.sourcesHTML(it.sources) + '</section>';
    h += '<div class="dlg-actions">' + acts.map(function (a, i) { return '<button type="button" class="btn ' + (a.kind === 'primary' ? 'primary-d' : '') + '" data-do="' + i + '">' + esc(a.label) + '</button>'; }).join('') + '</div>';
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
      var b = e.target.closest('[data-do]'); if (!b) return;
      var cur = Store.item(openId); var a = actionsFor(cur)[parseInt(b.dataset.do, 10)];
      if (!a) return;
      var snap = Store.snapshot(); a.fn();
      d.close();
      Say.tell(a.msg, { undo: function () { Store.restore(snap); if (root) render(); } });
      render();
    });
    renderDialog();
    d.showModal();
  }
  function renderDialog() {
    if (!dlg) return;
    var it = Store.item(openId), inner = dlg.querySelector('#dlg-in');
    if (!it || TABS[tab].states.indexOf(it.state) < 0) { dlg.close(); return; }
    var st = inner.scrollTop; inner.innerHTML = detailHTML(it);
  }

  window.TasksView = V;
})();
