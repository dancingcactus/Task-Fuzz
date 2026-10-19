/* Triage progress: a segmented bar that only ever grows (ported from the segmented progress bar prototype).
   Left to right: [bank] [ticks...] [open segments...] [ghost, ghost]. Each cleared card is a tick; when the ticks
   overflow they fly into the bank block, which pops and counts up, then the open segments slide left in a wave.
   New cards only append to the open side, so adding work never takes anything away. Fixed width, any number of tasks. */
(function () {
  /* Sizing for the header (the prototype used 34 / 9 / 6 at 16px tall). */
  var GAP = 5, SEGW = 26, TICKW = 8, DONE_SHARE = 0.35, PAD = 4;
  var FLY_MS = 420, STAGGER = 30, SLIDE_MS = 520, SLIDE_STAGGER = 25, SLIDE_GAP = 140;
  var bar = null, row = null, fx = null;
  var lastDone = 0, lastBanked = 0, lastTotal = 0, lastW = 0, token = 0, cur = null;

  function isOpen(el) { return !el.classList.contains('is-tick') && !el.classList.contains('is-bank'); }
  function ensure(n) {
    while (row.children.length < n) { var d = document.createElement('div'); d.className = 'pg-seg'; row.appendChild(d); }
    while (row.children.length > n) row.removeChild(row.lastChild);
  }
  function calm() { return !window.Fuzz || Fuzz.isCalm(); }

  /* Phase 1: the old ticks and the newly cleared task fly into the bank, which pops and counts up. */
  function animateCollapse(rects, oldB, newB, tok) {
    var bank = row.children[0]; if (!bank || !bank.classList.contains('is-bank')) return 0;
    var br = bank.getBoundingClientRect(), orr = fx.getBoundingClientRect();
    var bx = br.left + br.width / 2, by = br.top + br.height / 2;
    rects.forEach(function (r, i) {
      var c = document.createElement('div'); c.className = 'pg-fly';
      c.style.left = (r.left - orr.left) + 'px'; c.style.top = (r.top - orr.top) + 'px'; c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
      fx.appendChild(c);
      var dx = bx - (r.left + r.width / 2), dy = by - (r.top + r.height / 2);
      var a = c.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.35)', opacity: .4 }], { duration: FLY_MS, delay: i * STAGGER, easing: 'cubic-bezier(.5,0,.9,.5)', fill: 'both' });
      a.onfinish = function () { c.remove(); };
    });
    var arrival = FLY_MS + Math.max(rects.length - 1, 0) * STAGGER;
    var isNew = oldB === 0;
    bank.textContent = String(oldB);
    bank.animate([{ transform: isNew ? 'scale(.6)' : 'scale(1)', opacity: isNew ? 0 : 1 }, { transform: 'scale(1.35)', opacity: 1, offset: .45 }, { transform: 'scale(1)', opacity: 1 }], { duration: 460, delay: Math.max(arrival - 80, 0), easing: 'ease-out', fill: 'backwards' });
    setTimeout(function () {
      var t0 = null;
      function step(ts) {
        if (tok !== token) return;
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / 350);
        bank.textContent = String(Math.round(oldB + (newB - oldB) * p));
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, Math.max(arrival - 60, 0));
    var fl = document.createElement('div'); fl.className = 'pg-plus'; fl.textContent = '+' + (newB - oldB);
    fl.style.left = (br.left - orr.left) + 'px'; fl.style.width = br.width + 'px';
    fx.appendChild(fl);
    var fa = fl.animate([{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(2px)', opacity: 1, offset: .3 }, { transform: 'translateY(-4px)', opacity: 0 }], { duration: 850, delay: Math.max(arrival - 60, 0), easing: 'ease-out', fill: 'both' });
    fa.onfinish = function () { fl.remove(); };
    return arrival;
  }

  /* Phase 2: open segments hold still, then slide left into the freed space; ones revealed from behind the ghosts slide in. */
  function slideOpen(newOpen, newRects, oldRects, startAt) {
    newOpen.forEach(function (el, j) {
      var nr = newRects[j], or = oldRects[j], d = startAt + j * SLIDE_STAGGER;
      var opts = { duration: SLIDE_MS, delay: d, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' };
      if (or) {
        var dx = or.left - nr.left;
        if (Math.abs(dx) < 0.5) return;
        el.animate([{ transform: 'translateX(' + dx + 'px)' }, { transform: 'translateX(0)' }], opts);
      } else {
        el.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }], opts);
      }
    });
  }

  function render(done, total, force) {
    if (!row) return;
    var W = Math.max(row.clientWidth - PAD * 2, 0);
    if (!W) { cur = [done, total]; return; } /* hidden: draw when it shows */
    if (!force && done === lastDone && total === lastTotal && W === lastW) return; /* don't cut a running collapse short */
    cur = [done, total];
    var open = Math.max(total - done, 0);
    var T0 = Math.max(4, Math.floor((W * DONE_SHARE) / (TICKW + GAP)));
    var T1 = Math.max(1, T0 - 3);
    var ticks = done, banked = 0;
    if (done > T0) { var r = done - (T0 + 1), cyc = T1 + 1; banked = (T0 + 1) + Math.floor(r / cyc) * cyc; ticks = r % cyc; }
    var usedW = (banked > 0 ? SEGW + GAP : 0) + ticks * (TICKW + GAP);
    var k = Math.max(0, Math.floor((W - usedW + GAP) / (SEGW + GAP)));
    var real = open, ghosts = 0;
    if (open > k) { real = Math.max(k - 2, 0); ghosts = open - real >= 2 ? 2 : open - real; }
    var doAnim = !calm() && done > lastDone && banked > lastBanked && W === lastW;
    var grew = !calm() && total > lastTotal && done === lastDone && W === lastW;
    var kids = [].slice.call(row.children), before = kids.length;
    var oldTickRects = [], oldOpenRects = [];
    if (doAnim) {
      kids.forEach(function (el) { var rc = el.getBoundingClientRect(); if (el.classList.contains('is-tick')) oldTickRects.push(rc); else if (isOpen(el)) oldOpenRects.push(rc); });
    }
    kids.forEach(function (el) { el.getAnimations().forEach(function (a) { a.cancel(); }); });
    if (doAnim) row.classList.add('notrans');
    var items = [];
    if (banked > 0) items.push({ c: ' is-bank', t: String(banked) });
    for (var i = 0; i < ticks; i++) items.push({ c: ' is-tick', t: '' });
    for (var j = 0; j < real; j++) items.push({ c: '', t: '' });
    for (var g = 0; g < ghosts; g++) items.push({ c: ' is-ghost', t: '' });
    ensure(items.length);
    for (var m = 0; m < items.length; m++) { row.children[m].className = 'pg-seg' + items[m].c; row.children[m].textContent = items[m].t; }
    token++;
    if (doAnim) {
      var delta = done - lastDone;
      var fly = oldTickRects.concat(oldOpenRects.slice(0, delta));
      var newOpen = [].slice.call(row.children).filter(isOpen);
      var newRects = newOpen.map(function (el) { return el.getBoundingClientRect(); });
      row.classList.remove('notrans');
      var arrival = animateCollapse(fly, lastBanked, banked, token);
      slideOpen(newOpen, newRects, oldOpenRects.slice(delta), arrival + SLIDE_GAP);
    } else if (grew) {
      /* new cards arrive on the open side only */
      [].slice.call(row.children, before).forEach(function (el, n) {
        el.animate([{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 320, delay: n * SLIDE_STAGGER, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      });
    }
    bar.setAttribute('aria-valuemax', String(Math.max(total, 1)));
    bar.setAttribute('aria-valuenow', String(done));
    bar.setAttribute('aria-valuetext', done + ' cleared' + (open ? ', ' + open + ' waiting' : ', all clear'));
    lastDone = done; lastBanked = banked; lastTotal = total; lastW = W;
  }

  window.Progress = {
    /* HTML for the header slot. */
    html: function (id) {
      return '<div class="pgbar" id="' + id + '" role="progressbar" aria-label="Triage progress" aria-valuemin="0"><div class="pg-row" aria-hidden="true"></div><div class="pg-fx" aria-hidden="true"></div></div>';
    },
    mount: function (el) {
      bar = el; row = el.querySelector('.pg-row'); fx = el.querySelector('.pg-fx');
      if (window.ResizeObserver) new ResizeObserver(function () { if (cur && row.clientWidth - PAD * 2 !== lastW) { lastDone = cur[0]; render(cur[0], cur[1], true); } }).observe(row);
    },
    render: function (done, total) { render(done, total, false); },
    /* Where a cleared card should fly: the next open segment, or the bar itself. */
    target: function () {
      var next = row && [].slice.call(row.children).filter(function (el) { return isOpen(el) && !el.classList.contains('is-ghost'); })[0];
      return next || bar;
    }
  };
})();
