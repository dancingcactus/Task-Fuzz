/* Fuzz: the character engine (ported from the Fuzz Triage motion prototype) and the small
   static Fuzz faces used as the logo and in chat. */
(function () {
  var F = {};
  var el = null, calm = false, sayTok = 0, workTok = 0, knobAng = 0, blinkTok = 0, ptrFn = null, opts = {};

  /* ---------- Small Fuzz (logo, chat avatar, buttons) ---------- */
  var FACES = {
    good: '<path d="M20 34Q23.5 27.5 27 34M31 34Q34.5 27.5 38 34" stroke="var(--glow)" stroke-width="2.6" stroke-linecap="round" fill="none"/><path d="M24 40Q28.5 45.5 33 40" stroke="var(--glow)" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="17" cy="40" r="2.6" fill="#FF8A5C" opacity=".35"/><circle cx="40" cy="40" r="2.6" fill="#FF8A5C" opacity=".35"/>',
    okay: '<rect x="21" y="27" width="5.2" height="9" rx="2.6" fill="var(--glow)"/><rect x="32" y="27" width="5.2" height="9" rx="2.6" fill="var(--glow)"/><path d="M24.5 42.5H33.5" stroke="var(--glow)" stroke-width="2.4" stroke-linecap="round"/>',
    tired: '<path d="M20 32.5H27.4V35a3.7 3.7 0 0 1-7.4 0Z M31 32.5H38.4V35a3.7 3.7 0 0 1-7.4 0Z" fill="var(--glow)"/><path d="M25 43Q28.7 41 32.5 43" stroke="var(--glow)" stroke-width="2.2" stroke-linecap="round" fill="none"/><text x="40" y="27" font-size="7" font-weight="800" fill="var(--glow)" font-family="Figtree,sans-serif">z</text>',
    over: '<rect x="20" y="25.5" width="7" height="11.5" rx="3.5" fill="var(--glow)"/><rect x="31" y="25.5" width="7" height="11.5" rx="3.5" fill="var(--glow)"/><circle cx="23.5" cy="31" r="1.6" fill="var(--screen)"/><circle cx="34.5" cy="31" r="1.6" fill="var(--screen)"/><path d="M23.5 43Q26 40 28.5 43T33.5 43" stroke="var(--glow)" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M42 24Q44.5 28 42 30Q39.5 28 42 24Z" fill="#8FC4E8"/>',
    think: '<rect x="21" y="25" width="5.2" height="8.5" rx="2.6" fill="var(--glow)"/><rect x="32" y="25" width="5.2" height="8.5" rx="2.6" fill="var(--glow)"/><g fill="var(--glow)"><circle class="fz-dot" cx="25" cy="42.5" r="1.7"/><circle class="fz-dot" style="animation-delay:.2s" cx="29.5" cy="42.5" r="1.7"/><circle class="fz-dot" style="animation-delay:.4s" cx="34" cy="42.5" r="1.7"/></g>'
  };

  /* face: good | okay | tired | over | think. o.cls adds classes, o.label makes it an image, otherwise decorative. */
  F.mini = function (face, o) {
    o = o || {};
    var a11y = o.label ? 'role="img" aria-label="' + o.label + '"' : 'aria-hidden="true"';
    return '<svg class="fzmini' + (o.cls ? ' ' + o.cls : '') + '" viewBox="0 0 64 56" ' + a11y + '>' +
      '<g class="fz-a1"><path d="M32 15Q26 7 17 3" stroke="var(--ant)" stroke-width="2.4" stroke-linecap="round" fill="none"/><circle cx="16.5" cy="3.2" r="2.6" fill="var(--glow)"/></g>' +
      '<g class="fz-a2"><path d="M32 15Q37 10 44 8" stroke="var(--ant)" stroke-width="2.4" stroke-linecap="round" fill="none"/><rect x="42" y="5.6" width="4.6" height="4.6" rx="1" transform="rotate(45 44.3 7.9)" fill="var(--glow)"/></g>' +
      '<rect x="3" y="14" width="58" height="40" rx="9" fill="var(--cab)"/><rect x="7" y="17" width="42" height="34" rx="12" fill="var(--bezel)"/><rect x="9" y="19" width="38" height="30" rx="10" fill="var(--screen)"/>' +
      '<circle cx="55" cy="25" r="2.7" fill="var(--trim)"/><circle cx="55" cy="34" r="2.7" fill="var(--trim)"/><circle cx="55" cy="43" r="1.7" fill="var(--ok)"/>' +
      (FACES[face] || FACES.good) + '</svg>';
  };

  /* ---------- Settings ---------- */
  F.setCalm = function (v) { calm = !!v; document.documentElement.classList.toggle('calm', calm); };
  F.isCalm = function () { return calm; };
  F.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, calm ? ms * 0.6 : ms); }); };
  F.newTok = function () { return ++workTok; };
  F.tok = function () { return workTok; };

  /* ---------- Mounting the animated Fuzz on the triage stage ---------- */
  F.mount = function (root, o) {
    opts = o || {};
    el = { bot: root.querySelector('#bot'), wrap: root.querySelector('#pwrap'), bubble: root.querySelector('#bubble'), fx: root.querySelector('#fx'), stage: root.querySelector('#stage') };
    sayTok++; workTok++;
    var bt = ++blinkTok;
    (function blinker() {
      setTimeout(function () {
        if (bt !== blinkTok || !el) return;
        el.bot.classList.add('blink'); setTimeout(function () { el && el.bot.classList.remove('blink'); }, 130);
        blinker();
      }, 2200 + Math.random() * 3200);
    })();
    ptrFn = function (e) {
      if (!el || el.bot.dataset.mood === 'chill') return;
      var r = el.bot.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height * 0.5;
      var dx = e.clientX - cx, dy = e.clientY - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 160);
      var eyes = el.bot.querySelector('#eyes');
      if (eyes) eyes.style.transform = 'translate(' + (dx / d * 5 * k) + 'px,' + (dy / d * 3.6 * k) + 'px)';
    };
    window.addEventListener('pointermove', ptrFn);
    el.wrap.addEventListener('click', onBoop);
    el.wrap.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.wrap.click(); } });
  };
  F.unmount = function () {
    blinkTok++; sayTok++; workTok++;
    if (ptrFn) window.removeEventListener('pointermove', ptrFn);
    ptrFn = null; el = null;
  };
  F.mounted = function () { return !!el; };

  var BOOPS = ['Boop received.', 'Reception: excellent.', 'Hey, watch the screen.', 'That tickles my tubes.', 'Ready when you are.'];
  function onBoop(e) {
    if (opts.isBusy && opts.isBusy()) return;
    var ant = e.target.closest && e.target.closest('.ant');
    var knob = e.target.closest && e.target.closest('.knob');
    if (ant) {
      ant.classList.remove('twang'); void ant.getBoundingClientRect(); ant.classList.add('twang');
      ant.addEventListener('animationend', function () { ant.classList.remove('twang'); }, { once: true });
      F.say(ant.classList.contains('ant-l') ? 'Easy on the long one. It picks up everything.' : 'Hey! The short one is the touchy one.', { type: false });
      return;
    }
    if (knob) {
      F.glitch(350); F.flash();
      knob.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(120deg)' }], { duration: 180, fill: 'forwards' });
      F.say(['Channel 4. Nothing on.', 'Channel 9. Just static.', 'Channel 2. Test pattern.'][Math.floor(Math.random() * 3)], { type: false });
      return;
    }
    var prev = el.bot.dataset.mood; F.pAnim('squash'); F.setMood('boop');
    F.say(prev === 'bored' ? 'Oh! Hi. I was just surfing channels.' : BOOPS[Math.floor(Math.random() * BOOPS.length)], { type: false });
    setTimeout(function () { if (el) F.setMood(prev === 'boop' ? 'idle' : prev); }, 450);
  }

  /* ---------- Primitives ---------- */
  F.mood = function () { return el ? el.bot.dataset.mood : 'idle'; };
  F.setMood = function (m) { if (!el) return; el.bot.dataset.mood = m; if (m !== 'rushed') el.bot.dataset.urgency = '0'; };
  F.setUrgency = function (n) { if (el) el.bot.dataset.urgency = String(n); };
  F.setArm = function (a) { if (el) el.bot.dataset.arm = a; };
  F.setCool = function (on) { if (el) el.bot.classList.toggle('cool', on); };
  F.setOsd = function (t) { var o = el && el.bot.querySelector('#osd'); if (o) o.textContent = t; };
  F.glitch = function (ms) {
    if (calm || !el) return;
    var b = el.bot; b.setAttribute('data-glitch', '');
    setTimeout(function () { b.removeAttribute('data-glitch'); }, ms);
  };
  F.flash = function () {
    if (calm || !el) return;
    var b = el.bot; b.classList.remove('flash'); void b.getBoundingClientRect(); b.classList.add('flash');
    setTimeout(function () { b.classList.remove('flash'); }, 400);
  };
  F.pAnim = function (n) {
    if (calm || !el) return;
    var w = el.bot.querySelector('.body-wrap');
    ['hop', 'squash', 'wiggle', 'lean', 'gulp', 'tiptoe', 'shrug', 'lift', 'spin', 'bow'].forEach(function (c) { w.classList.remove(c); });
    void w.getBoundingClientRect(); w.classList.add(n);
    w.addEventListener('animationend', function () { w.classList.remove(n); }, { once: true });
  };
  F.fxOn = function (name, ms) {
    if (!el) return; var b = el.bot;
    b.setAttribute('data-fx', name);
    setTimeout(function () { if (b.getAttribute('data-fx') === name) b.removeAttribute('data-fx'); }, ms);
  };
  F.schedGlyph = function (kind, label) {
    if (!el) return;
    var s = el.bot.querySelector('#schosd'); if (s) s.textContent = label || '';
    if (!calm) { el.bot.setAttribute('data-snow', ''); setTimeout(function () { el && el.bot.removeAttribute('data-snow'); }, 200); }
    el.bot.setAttribute('data-sch', kind);
  };
  F.clearSched = function () { if (el) el.bot.removeAttribute('data-sch'); };
  F.checkGlyph = function (ms) {
    if (!el) return; var b = el.bot;
    b.setAttribute('data-sch', 'check');
    setTimeout(function () { if (b.getAttribute('data-sch') === 'check') b.removeAttribute('data-sch'); }, ms);
  };

  F.say = async function (text, o) {
    if (!el) return;
    o = o || {};
    var tok = ++sayTok, b = el.bubble;
    b.className = 'bubble ' + (o.cls || ''); void b.offsetWidth; b.classList.add('pop');
    if (calm || o.type === false) { b.textContent = text; return; }
    b.textContent = '';
    var words = text.split(' ');
    for (var i = 0; i < words.length; i++) {
      if (tok !== sayTok || !el) return;
      b.textContent += (i ? ' ' : '') + words[i];
      await new Promise(function (r) { setTimeout(r, 42); });
    }
  };
  F.bubbleEl = function () { return el && el.bubble; };

  function rel(node) {
    var a = node.getBoundingClientRect(), s = el.stage.getBoundingClientRect();
    return { x: a.left - s.left + a.width / 2, y: a.top - s.top + a.height / 2 };
  }

  F.flyTo = function (node, target, o) {
    o = o || {};
    function settle(a) { return a.finished.catch(function () {}).then(function () { node.style.visibility = 'hidden'; a.cancel(); }); }
    if (calm) return settle(node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'both' }));
    var a = node.getBoundingClientRect(), b = target.getBoundingClientRect();
    var dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    var sc = o.scale || 0.1, rot = o.rot || -16;
    return settle(node.animate([
      { transform: 'none', opacity: 1 },
      { transform: 'translate(' + (dx * 0.08) + 'px,' + (dy * 0.08 + 12) + 'px) scale(.93,.9) rotate(' + (rot * 0.15) + 'deg)', offset: .22, opacity: 1 },
      { transform: 'translate(' + dx * 0.6 + 'px,' + (dy * 0.6 - 26) + 'px) scale(' + (sc * 2.4) + ') rotate(' + rot + 'deg)', offset: .7, opacity: 1 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ') rotate(' + (rot * 1.3) + 'deg)', opacity: .1 }
    ], { duration: o.dur || 720, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'both' }));
  };

  F.confetti = function (anchor) {
    if (calm || !el) return;
    var c = rel(anchor), fx = el.fx, cols = ['var(--accent)', 'var(--sec)', 'var(--ok)'];
    for (var i = 0; i < 18; i++) {
      var s = document.createElement('i');
      s.style.left = (c.x + 60) + 'px'; s.style.top = c.y + 'px'; s.style.background = cols[i % 3];
      fx.appendChild(s);
      var ang = Math.random() * Math.PI * 2, d = 60 + Math.random() * 90;
      (function (s, ang, d) {
        s.animate([
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
          { transform: 'translate(' + Math.cos(ang) * d + 'px,' + (Math.sin(ang) * d - 40) + 'px) rotate(200deg)', opacity: 1, offset: .55 },
          { transform: 'translate(' + Math.cos(ang) * d * 1.1 + 'px,' + (Math.sin(ang) * d + 80) + 'px) rotate(520deg) scale(.5)', opacity: 0 }
        ], { duration: 950 + Math.random() * 350, easing: 'cubic-bezier(.2,.7,.4,1)' }).finished.then(function () { s.remove(); }, function () { s.remove(); });
      })(s, ang, d);
    }
  };

  F.hearts = function (glyph, color, n) {
    if (calm || !el) return;
    glyph = glyph || '♥'; color = color || 'var(--accent)'; n = n || 6;
    var c = rel(el.bot), fx = el.fx;
    for (var i = 0; i < n; i++) {
      (function (i) {
        var h = document.createElement('i'); h.textContent = glyph;
        h.style.cssText = 'width:auto;height:auto;background:none;border-radius:0;color:' + color + ';font-weight:800;font-family:var(--font-display);line-height:1;font-size:' + (14 + Math.random() * 10) + 'px;left:' + (c.x - 10 + (Math.random() * 44 - 22)) + 'px;top:' + (c.y - 34) + 'px';
        fx.appendChild(h);
        var dx = Math.random() * 70 - 35;
        h.animate([
          { transform: 'translate(0,0) scale(.4)', opacity: 0 },
          { transform: 'translate(' + (dx * 0.4) + 'px,-40px) scale(1)', opacity: 1, offset: .25 },
          { transform: 'translate(' + dx + 'px,-120px) scale(1)', opacity: 0 }
        ], { duration: 1500 + Math.random() * 700, delay: i * 130, easing: 'ease-out', fill: 'both' }).finished.then(function () { h.remove(); }, function () { h.remove(); });
      })(i);
    }
  };

  /* Bored: surfs channels, with a face pop between each */
  var BORED_LINES = ['Surfing channels. Nothing on.', 'Anyone out there?', 'I could alphabetize your task sources.', 'Channel 4 is still just static.'];
  F.startBored = function () {
    if (!el) return;
    var tok = ++workTok, i = 0, b = el.bot;
    F.setMood('bored'); b.setAttribute('data-ch', '0');
    var pos = 0, last = 0, knob = b.querySelector('.knob-b');
    function alive() { return el && tok === workTok && ['bored', 'boop'].indexOf(b.dataset.mood) > -1; }
    (function step() {
      if (!alive()) return;
      var next;
      if (pos % 2 === 0) next = 0; else { do { next = 1 + Math.floor(Math.random() * 5); } while (next === last); }
      pos++; if (next) last = next;
      if (!calm) { b.setAttribute('data-snow', ''); setTimeout(function () { b.removeAttribute('data-snow'); }, 200); }
      if (knob) { knobAng += 60; knob.style.transform = 'rotate(' + knobAng + 'deg)'; }
      var osd = b.querySelector('#chosd'); if (osd) osd.textContent = 'CH ' + ('0' + (2 + Math.floor(Math.random() * 34))).slice(-2);
      b.setAttribute('data-ch', String(next)); b.setAttribute('data-chosd', '');
      setTimeout(function () { b.removeAttribute('data-chosd'); }, 1300);
      setTimeout(step, next === 0 ? 1700 : 1300 + Math.random() * 900);
    })();
    (function tick() {
      if (!alive()) return;
      F.say(BORED_LINES[i % BORED_LINES.length], { type: false });
      i++; setTimeout(tick, 4800);
    })();
  };

  window.Fuzz = F;
})();
