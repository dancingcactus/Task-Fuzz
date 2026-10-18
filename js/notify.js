/* Everything the app has to tell you comes from Fuzz, not from a toast.
   - On Triage, Fuzz says it from the perch, in his own speech bubble.
   - On other pages, a small Fuzz appears bottom right with a speech bubble, then tucks away.
   Undo: the last undoable change stays available as a quiet "Undo" link on Triage (Fuzz's next line would
   otherwise replace the bubble within a second or two), and as a button in the bubble. */
(function () {
  var S = {};
  var dockTimer = 0, undoTimer = 0, lastUndo = null, busyFn = null, listeners = [];

  function dock() { return document.getElementById('fuzz-dock'); }
  function button(label, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', fn); return b;
  }
  function short(t) { t = String(t).replace(/[.!]+$/, ''); return t.length > 60 ? t.slice(0, 57) + '…' : t; }

  /* ---------- Undo ---------- */
  function emitUndo() { listeners.forEach(function (l) { l(); }); }
  function clearUndo() { lastUndo = null; clearTimeout(undoTimer); emitUndo(); }
  function setUndo(label, fn) {
    clearTimeout(undoTimer);
    lastUndo = { label: short(label), run: function () { var f = fn; clearUndo(); S.hideDock(); f(); } };
    undoTimer = setTimeout(clearUndo, 90000);
    emitUndo();
  }
  S.lastUndo = function () { return lastUndo; };
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
    if (o.undo && lastUndo) b.appendChild(button('Undo', lastUndo.run));
  }
  function onDock(text, o) {
    var d = dock(); if (!d) return;
    clearTimeout(dockTimer);
    d.innerHTML = '';
    var bub = document.createElement('div'); bub.className = 'bubble pop';
    var span = document.createElement('span'); span.textContent = text; bub.appendChild(span);
    if (o.action) bub.appendChild(button(o.action.label, function () { S.hideDock(); o.action.run(); }));
    if (o.undo && lastUndo) bub.appendChild(button('Undo', lastUndo.run));
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
