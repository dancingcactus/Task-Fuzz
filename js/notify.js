/* Everything the app has to tell you comes from Fuzz, not from a toast.
   - On Triage, Fuzz says it from the perch, in his own speech bubble.
   - On other pages, a small Fuzz appears bottom right with a speech bubble, then tucks away.
   Undo: recent undoable changes stay available from the Undo button in the header (Fuzz's next line would
   otherwise replace the bubble within a second or two), and the latest also as a button in the bubble. */
(function () {
  var S = {};
  var dockTimer = 0, undoTimer = 0, history = [], busyFn = null, listeners = [];

  function dock() { return document.getElementById('fuzz-dock'); }
  function button(label, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', fn); return b;
  }
  function short(t) { t = String(t).replace(/[.!]+$/, ''); return t.length > 100 ? t.slice(0, 97) + '…' : t; }

  /* ---------- Undo ---------- */
  /* A short history, newest first. Each entry restores a snapshot taken before its change, so undoing an
     older entry also rolls back everything after it; those newer entries leave the list with it. */
  var MAX_UNDO = 8, UNDO_TTL = 10 * 60 * 1000;
  function prune() { var now = Date.now(); history = history.filter(function (u) { return now - u.at < UNDO_TTL; }); }
  function emitUndo() { listeners.forEach(function (l) { l(); }); }
  function clearUndo() { history = []; clearTimeout(undoTimer); emitUndo(); }
  function setUndo(label, fn) {
    var u = { label: short(label), at: Date.now() };
    u.run = function () {
      var i = history.indexOf(u); if (i < 0) return;
      history = history.slice(i + 1); S.hideDock(); emitUndo(); fn();
    };
    prune(); history.unshift(u); history = history.slice(0, MAX_UNDO);
    clearTimeout(undoTimer); undoTimer = setTimeout(function () { prune(); emitUndo(); }, UNDO_TTL + 1000);
    emitUndo();
  }
  S.lastUndo = function () { prune(); return history[0] || null; };
  S.undoList = function () { prune(); return history.slice(); };
  S.onUndoChange = function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (l) { return l !== fn; }); }; };
  /* Fuzz has already said something about the change; keep Undo within reach and tell screen readers what changed. */
  /* label: the action as the Undo list names it (“Parked “X””). spoken: the fuller line for screen readers, if different. */
  S.offerUndo = function (label, fn, spoken) { setUndo(label, fn); S.announce((spoken || label) + ' Undo is in the header.'); };

  /* ---------- Screen readers ---------- */
  /* Fuzz's bubble on the perch is visual only, so his quips stay quiet. Outcomes, warnings and his
     answers to you are read out here instead. Clearing first lets the same line be read twice. */
  var srTimer = 0;
  S.announce = function (text) {
    var r = document.getElementById('announcer'); if (!r) return;
    clearTimeout(srTimer); r.textContent = '';
    srTimer = setTimeout(function () { r.textContent = text; }, 60);
  };

  /* Triage tells us when it is mid-animation so a line waits for a calm moment. */
  S.setBusyCheck = function (fn) { busyFn = fn; };

  /* ---------- Speaking ---------- */
  S.hideDock = function () { clearTimeout(dockTimer); var d = dock(); if (d) { d.hidden = true; d.innerHTML = ''; } };

  function onPerch(text, o, tries) {
    if (busyFn && busyFn() && tries < 20) { setTimeout(function () { if (Fuzz.mounted()) onPerch(text, o, tries + 1); else onDock(text, o); }, 800); return; }
    var actions = [];
    if (o.undo && history[0]) actions.push(button('Undo', history[0].run));
    Fuzz.say(text, { type: false, actions: actions });
  }
  function onDock(text, o) {
    var d = dock(); if (!d) return;
    clearTimeout(dockTimer);
    d.innerHTML = '';
    var bub = document.createElement('div'); bub.className = 'bubble pop';
    var span = document.createElement('span'); span.textContent = text; bub.appendChild(span);
    if (o.undo && history[0]) bub.appendChild(button('Undo', history[0].run));
    var close = button('Dismiss', S.hideDock); close.className = 'dock-x'; close.setAttribute('aria-label', 'Dismiss'); close.innerHTML = '&times;'; bub.appendChild(close);
    var av = document.createElement('div'); av.className = 'dock-av'; av.innerHTML = Fuzz.mini('good', { cls: 'dock-fz' });
    d.appendChild(bub); d.appendChild(av); d.hidden = false;
    dockTimer = setTimeout(S.hideDock, o.ms || (o.undo ? 12000 : 7000));
  }

  /* o: { undo: fn, label: name in the Undo list (defaults to text), ms } */
  S.tell = function (text, o) {
    o = o || {};
    if (o.undo) setUndo(o.label || text, o.undo);
    if (window.Fuzz && Fuzz.mounted()) { onPerch(text, o, 0); S.announce(text); } else onDock(text, o);
  };

  window.Say = S;
})();
