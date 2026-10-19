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
  function short(t) { t = String(t).replace(/[.!]+$/, ''); return t.length > 60 ? t.slice(0, 57) + '…' : t; }

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
  /* Fuzz has already said something about the change; just keep Undo within reach. */
  S.offerUndo = function (label, fn) { setUndo(label, fn); };

  /* Triage tells us when it is mid-animation so background news waits for a calm moment. */
  S.setBusyCheck = function (fn) { busyFn = fn; };

  /* ---------- Speaking ---------- */
  S.hideDock = function () { clearTimeout(dockTimer); var d = dock(); if (d) { d.hidden = true; d.innerHTML = ''; } };

  function onPerch(text, o, tries) {
    if (busyFn && busyFn() && tries < 20) { setTimeout(function () { if (Fuzz.mounted()) onPerch(text, o, tries + 1); else onDock(text, o); }, 800); return; }
    Fuzz.say(text, { type: false });
    var b = Fuzz.bubbleEl(); if (!b) return;
    if (o.action) b.appendChild(button(o.action.label, o.action.run));
    if (o.undo && history[0]) b.appendChild(button('Undo', history[0].run));
  }
  function onDock(text, o) {
    var d = dock(); if (!d) return;
    clearTimeout(dockTimer);
    d.innerHTML = '';
    var bub = document.createElement('div'); bub.className = 'bubble pop';
    var span = document.createElement('span'); span.textContent = text; bub.appendChild(span);
    if (o.action) bub.appendChild(button(o.action.label, function () { S.hideDock(); o.action.run(); }));
    if (o.undo && history[0]) bub.appendChild(button('Undo', history[0].run));
    var close = button('Dismiss', S.hideDock); close.className = 'dock-x'; close.setAttribute('aria-label', 'Dismiss'); close.innerHTML = '&times;'; bub.appendChild(close);
    var av = document.createElement('div'); av.className = 'dock-av'; av.innerHTML = Fuzz.mini('good', { cls: 'dock-fz' });
    d.appendChild(bub); d.appendChild(av); d.hidden = false;
    dockTimer = setTimeout(S.hideDock, o.ms || ((o.undo || o.action) ? 12000 : 7000));
  }

  /* o: { undo: fn, action: { label, run }, ms } */
  S.tell = function (text, o) {
    o = o || {};
    if (o.undo) setUndo(text, o.undo);
    if (window.Fuzz && Fuzz.mounted()) onPerch(text, o, 0); else onDock(text, o);
  };

  window.Say = S;
})();
