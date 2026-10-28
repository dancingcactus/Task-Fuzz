/* The group sheet: one group in a dialog, opened from a "From …" line on a card or a task.
   A group is only a label on the tasks that came from the same place (the core makes them, you never
   have to), so this sheet is the one place it has room of its own. No progress bar: it counts what's
   done, never what's left. Each task keeps its own deadline and done-when, so the group has neither. */
(function () {
  var esc = UI.esc;
  var STATE = { triage: ['In Triage', 'accent'], ai: ['With Fuzz', 'accent'], 'ai-queued': ['Next up', 'muted'], review: ['Needs your OK', 'warn'],
    mine: ['With you', 'accent'], session: ['In Claude', 'muted'], scheduled: ['Later', 'muted'], waiting: ['Waiting on others', 'warn'],
    parked: ['Parked', 'muted'], done: ['Done', 'ok'], letgo: ['Let go', 'muted'] };
  var dlg = null, gid = null, opts = {}, renaming = false, unsub = null;

  function label(it) { return STATE[it.state] || ['', 'muted']; }
  /* "1 done · 2 with others · 1 in Triage", done first */
  function summary(g) {
    var n = {}, order = [];
    S().groupTasks(g).forEach(function (it) { var l = label(it)[0]; if (!n[l]) { n[l] = 0; order.push(l); } n[l]++; });
    order.sort(function (a, b) { return (b === 'Done') - (a === 'Done'); });
    return order.map(function (l) { return n[l] + ' ' + (l === 'Done' ? 'done' : l.charAt(0).toLowerCase() + l.slice(1)); }).join(' · ');
  }
  function S() { return window.Store; }

  /* Back to where the tasks came from, when that is a web address */
  var OPEN = { email: 'Open the email', meeting: 'Open the meeting notes', slack: 'Open in Slack' };
  function html(g) {
    var tasks = S().groupTasks(g), fin = S().groupFinished(g);
    var h = '<div class="dlg-top"><div class="dlg-titles"><div class="dlg-chips">' + (fin ? UI.pill('Wrapped up', 'ok') : '') + '<span class="meta">' + esc(summary(g)) + '</span></div>' +
      '<h2 id="ps-title" tabindex="-1">' + esc(g.title) + '</h2>' +
      (g.link ? '<a class="ps-origin" href="' + esc(g.link) + '" target="_blank" rel="noopener">' + esc(OPEN[g.source] || 'Open where it came from') + '</a>' : '') + '</div><button type="button" class="iconbtn" data-close aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
    if (renaming) h += '<form class="revise ps-rename" id="ps-rename"><label for="ps-name">A name you’ll recognize</label><div class="parkrow"><input id="ps-name" type="text" autocomplete="off" value="' + esc(g.title) + '"><button class="btn" type="submit">Save</button></div></form>';
    h += '<section><h3>Tasks</h3><ul class="ps-tasks">' + tasks.map(function (it) {
      var l = label(it), name = opts.onOpenTask && (!opts.canOpen || opts.canOpen(it)) ? '<button type="button" class="ps-open" data-ps-open="' + it.id + '">' + esc(it.title) + '</button>' : '<span class="ps-name">' + esc(it.title) + '</span>';
      return '<li><span class="ps-main">' + name + (it.doneWhen ? '<span class="ps-dw">Done when ' + esc(it.doneWhen) + '</span>' : '') + '</span>' +
        '<span class="ps-side">' + UI.pill(l[0], l[1]) + (fin ? '' : '<button type="button" class="btn small" data-ps-out="' + it.id + '" aria-label="Take “' + esc(it.title) + '” out of this group">Take out</button>') + '</span></li>';
    }).join('') + '</ul></section>';
    /* The latest steps from every task, in one log */
    var log = [];
    tasks.forEach(function (it) { it.log.slice(0, 2).forEach(function (e) { log.push({ kind: e.kind, time: e.time, text: it.title + ': ' + e.text }); }); });
    if (log.length) h += '<section><h3>Done so far</h3>' + UI.logHTML(log) + '</section>';
    h += '<div class="dlg-actions">' + (fin ? '' : '<button type="button" class="btn" data-ps="wrap">It’s wrapped up</button>') +
      '<button type="button" class="btn" data-ps="rename" aria-expanded="' + renaming + '" aria-controls="ps-rename">Rename</button></div>';
    return h;
  }

  function paint(focusTitle) {
    if (!dlg) return;
    var g = S().group(gid), inner = dlg.querySelector('.dlg-in');
    if (!g) { dlg.close(); return; }
    if (inner.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    var st = inner.scrollTop; inner.innerHTML = html(g); inner.scrollTop = st;
    if (focusTitle) inner.querySelector('#ps-title').focus();
  }

  /* Every change can be undone, like everything else */
  /* tasksToo: the change also writes to the group's tasks, so they undo with it */
  function change(label, msg, fn, tasksToo) {
    var r, g = S().group(gid);
    var ch = S().track(tasksToo ? S().groupTasks(g).map(function (i) { return i.id; }) : [], function () { r = fn(); });
    Say.tell(msg, { label: label, blocked: ch.blocked, undo: function () { var why = ch.undo(); if (!why && opts.onUndo) opts.onUndo(); return why; } });
    if (opts.onChange) opts.onChange();
    return r;
  }

  function open(groupId, o) {
    if (dlg) dlg.close();
    gid = groupId; opts = o || {}; renaming = false;
    var d = document.createElement('dialog');
    d.className = 'dlg ps'; d.setAttribute('aria-labelledby', 'ps-title');
    d.innerHTML = '<div class="dlg-in"></div>';
    document.body.appendChild(d); dlg = d;
    unsub = S().on(function (e) { if (e.type !== 'change') paint(); });
    d.addEventListener('close', function () {
      d.remove(); if (unsub) unsub(); unsub = null;
      if (dlg === d) dlg = null;
      if (opts.trigger && document.body.contains(opts.trigger)) opts.trigger.focus();
    });
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('[data-close]')) { d.close(); return; }
      var g = S().group(gid); if (!g) return;
      var t = e.target.closest('[data-ps],[data-ps-out],[data-ps-open]'); if (!t) return;
      if (t.dataset.psOpen) { var id = t.dataset.psOpen; opts.trigger = null; d.close(); opts.onOpenTask(id); return; }
      if (t.dataset.psOut) {
        var it = S().item(t.dataset.psOut);
        var gone = change('Took “' + it.title + '” out of ' + g.title + '.', 'Took it out of ' + g.title + '.', function () { return S().takeOut(it.id); }, true);
        if (gone) { Say.tell('That left one task, so it stands on its own now.'); d.close(); } else paint(true);
        return;
      }
      if (t.dataset.ps === 'wrap') {
        change('Wrapped up ' + g.title + '.', 'Wrapped up ' + g.title + '. Anything still open keeps going on its own.', function () { S().wrapUp(g.id); }, true);
        paint(true);
      } else if (t.dataset.ps === 'rename') {
        renaming = !renaming; paint();
        var inp = d.querySelector('#ps-name'); if (inp) { inp.focus(); inp.select(); }
      }
    });
    d.addEventListener('submit', function (e) {
      if (e.target.id !== 'ps-rename') return;
      e.preventDefault();
      var g = S().group(gid), v = d.querySelector('#ps-name').value.trim();
      renaming = false; document.activeElement.blur();
      if (v && v !== g.title) change('Renamed ' + g.title + ' to ' + v + '.', 'Renamed it to ' + v + '.', function () { S().renameGroup(g.id, v); });
      paint(true);
    });
    paint();
    d.showModal();
    d.querySelector('#ps-title').focus();
  }

  window.GroupSheet = { open: open };
})();
