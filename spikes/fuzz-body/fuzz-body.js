/* Spike: Fuzz with a body and rubber-hose (Bender-style) arms and legs.
   The head is the real Fuzz SVG (js/fuzz-svg.js) driven by the real moods in css/fuzz.css.
   Everything below the neck is new and lives only in this spike.

   How the limbs work: each arm or leg is one quadratic curve from the shoulder (or hip) to the hand
   (or ankle). The curve keeps roughly the same length, so when the hand comes closer to the shoulder
   the "elbow" bows out, and when it reaches further the hose goes straight (and stretches a little).
   There are no elbow or knee joints: that is what makes it read as a noodle limb like Bender's.

   A reaction is a pose function of time. Every frame the rig eases its current pose toward the
   reaction's pose, so switching reactions blends instead of snapping. */
(function () {
  'use strict';

  /* ---------- Rig geometry (outer viewBox 0 0 200 222; the head sits at x 30..170, y 0..126) ---------- */
  var SH_L = [77, 131], SH_R = [123, 131];   // shoulders (body space)
  var HIP_L = [90, 166], HIP_R = [110, 166]; // hips (body space)
  var PIVOT = [100, 166];                    // body leans around the hips
  var NECK = [100, 114];                     // head tilts around the neck
  var GROUND = 214;
  var ARM = 50, LEG = 40;                    // resting hose lengths

  var HANDS = {
    open:  [[-38, 6.5], [0, 7], [38, 6.5]],
    fist:  [[-40, 2], [0, 2.4], [40, 2]],
    point: [[-58, 2], [0, 10.5], [55, 2]],
    thumb: [[-90, 8], [8, 2.4], [44, 2]],
    gun:   [[-80, 6.5], [0, 11], [52, 2]]
  };

  function S(t, f, p) { return Math.sin(t * f + (p || 0)); }
  function pos(x) { return x > 0 ? x : 0; }

  function base() {
    return {
      lh: [62, 175], rh: [138, 175],   // hands, body space
      lf: [88, 204], rf: [112, 204],   // ankles, world space
      lb: 1, rb: 1, llb: 1, rlb: 1,    // bend direction: +1 bows outward, -1 inward
      lhand: 'open', rhand: 'open', lrot: null, rrot: null, // hand angle in degrees, null = follow the arm
      lfr: 0, rfr: 0,                  // foot tilt
      y: 0, rot: 0, head: 0,           // body bob, body lean, head tilt
      lL: ARM, rL: ARM,                // arm hose length (stretch it to reach around the head)
      lback: false, rback: false,      // draw that arm behind the head
      mood: 'idle', urgency: 0, cool: false
    };
  }
  function P(o) { var b = base(); for (var k in o) b[k] = o[k]; return b; }

  /* ---------- Reactions ---------- */
  var R = {};
  R.idle = { label: 'Idle', say: 'Hi! I’m keeping an eye on your list.', pose: function (t) {
    return P({ lh: [62 + S(t, 1.3), 175 + S(t, 2) * .8], rh: [138 + S(t, 1.3, 1), 175 + S(t, 2, 1) * .8], y: S(t, 2) * .7, head: S(t, .7) * 2 });
  } };
  R.wave = { label: 'Wave hello', say: 'Oh hey, you’re back!', pose: function (t) {
    return P({ mood: 'happy', rback: true, rh: [156 + S(t, 9) * 7, 96], rrot: -90 + S(t, 9) * 24, head: -5 + S(t, 9) * 1.5, rot: -2, rb: 1 });
  } };
  R.cheer = { label: 'Cheer', say: 'Inbox zero! Look at you go!', pose: function (t) {
    var h = Math.abs(S(t, 6)), air = pos(S(t, 6));
    return P({ mood: 'happy', lh: [42, 84 + h * 4], rh: [158, 84 + h * 4], lhand: 'fist', rhand: 'fist', lback: true, rback: true,
      y: -h * 12, lf: [86, 204 - h * 12 + h * 3], rf: [114, 204 - h * 12 + h * 3], llb: 1 + air, rlb: 1 + air, head: S(t, 3) * 3 });
  } };
  R.dance = { label: 'Dance', say: 'Done, done, and done.', pose: function (t) {
    var a = S(t, 5), b = S(t, 10);
    return P({ mood: 'happy', lh: [56 - a * 6, 140 + a * 26], rh: [144 - a * 6, 140 - a * 26], lb: a > 0 ? -1 : 1, rb: a > 0 ? 1 : -1,
      rot: a * 5, y: -Math.abs(b) * 4, lf: [86 + a * 3, 204 - pos(b) * 5], rf: [114 + a * 3, 204 - pos(-b) * 5], head: -a * 6 });
  } };
  R.proud = { label: 'Hands on hips', say: 'Three tasks before lunch. Not bad.', pose: function (t) {
    return P({ mood: 'proud', lh: [80, 160], rh: [120, 160], lhand: 'fist', rhand: 'fist', y: -1.5 + S(t, 1.5) * .6, head: -4, lf: [84, 204], rf: [116, 204] });
  } };
  R.thumb = { label: 'Thumbs up', say: 'Nice one. Marked it done.', pose: function (t) {
    return P({ mood: 'happy', rh: [146, 128 + S(t, 2) * 1.5], rhand: 'thumb', rrot: 0, head: -6, rot: -2 });
  } };
  R.point = { label: 'Point at a task', say: 'This one’s due tomorrow — want to start it?', pose: function (t) {
    return P({ mood: 'eager', rh: [176 + S(t, 3) * 2, 128], rhand: 'point', lh: [64, 172], rot: -4, head: -6, lf: [86, 204], rf: [116, 204] });
  } };
  R.cool = { label: 'Finger guns', say: 'Calendar’s clear. Very smooth.', pose: function (t) {
    var k = pos(S(t, 3)) * 6;
    return P({ mood: 'idle', cool: true, rh: [152 + k * .4, 140 - k], rhand: 'gun', lh: [80, 160], lhand: 'fist', rot: -5, head: -8, rf: [118, 204] });
  } };
  R.thinking = { label: 'Thinking', say: 'Hmm, which of these is really urgent…', pose: function (t) {
    return P({ mood: 'thinking', rh: [106, 117], rhand: 'fist', rb: 1, lh: [114, 150], lhand: 'fist', lb: -1, head: 7 + S(t, 1) * 1.5,
      rf: [113, 204 - pos(S(t, 9)) * 4], rfr: -pos(S(t, 9)) * 14 });
  } };
  R.working = { label: 'Working', say: 'Sorting your inbox…', pose: function (t) {
    return P({ mood: 'working', lh: [90, 152 - pos(S(t, 16)) * 4], rh: [110, 152 - pos(S(t, 16, 2)) * 4], lhand: 'fist', rhand: 'fist', head: 4, y: S(t, 4) * .4 });
  } };
  R.rushed = { label: 'Rushing', say: 'Due in 20 minutes! Go go go!', pose: function (t) {
    var ph = t * 13, a = Math.sin(ph), c = Math.cos(ph);
    return P({ mood: 'rushed', urgency: 3, lhand: 'fist', rhand: 'fist', lh: [64, 150 + a * 14], rh: [136, 150 - a * 14],
      lf: [88 + a * 6, 204 - pos(c) * 11], rf: [112 - a * 6, 204 - pos(-c) * 11], y: -Math.abs(c) * 4, rot: 3, lfr: a * 10, rfr: -a * 10 });
  } };
  R.worried = { label: 'Worried', say: 'Uh oh. That deadline slipped past.', pose: function (t) {
    var j = S(t, 60) * .8;
    return P({ mood: 'worried', lh: [95, 136 + j], rh: [105, 136 - j], lhand: 'fist', rhand: 'fist', llb: -1, rlb: -1,
      lf: [84 + j, 204], rf: [116 - j, 204], head: -3 });
  } };
  R.sheepish = { label: 'Sheepish', say: 'I may have filed that in the wrong place…', pose: function (t) {
    return P({ mood: 'sheepish', lh: [33, 78 + S(t, 14) * 3], lrot: -100 + S(t, 14) * 12, lb: 1, head: -9, rot: 2, llb: -1, rlb: -1,
      lf: [92, 204], rf: [108, 204], lfr: 8, rfr: -8 });
  } };
  R.shrug = { label: 'Shrug', say: 'No idea where that one goes. You pick?', pose: function (t) {
    var u = pos(S(t, 2.4)) * 3;
    return P({ mood: 'bored', lh: [50, 122 - u], rh: [150, 122 - u], lrot: 200, rrot: -20, y: -u * .6, head: 8 });
  } };
  R.grateful = { label: 'Grateful', say: 'Aw, thanks for checking in with me.', pose: function (t) {
    return P({ mood: 'grateful', lh: [103, 140], rh: [109, 146], lb: -1, rb: 1, rot: S(t, 1.6) * 3, head: S(t, 1.6) * 4 });
  } };
  R.sulk = { label: 'Arms crossed', say: 'You snoozed it again. Fine.', pose: function (t) {
    return P({ mood: 'stare', lh: [114, 147], rh: [86, 149], lhand: 'fist', rhand: 'fist', lb: -1, rb: -1, head: -7, rot: 2, lf: [86, 204], rf: [114, 204] });
  } };
  R.sleepy = { label: 'Sit & doze', say: 'Nothing due today… zzz', pose: function (t) {
    return P({ mood: 'sleepy', y: 14, lh: [66, 184], rh: [134, 184], lf: [80, 204], rf: [120, 204], lfr: -6, rfr: 6,
      head: 9 + S(t, 1.1) * 3, rot: 0 });
  } };
  R.chill = { label: 'Power off', say: 'Off for the night. See you tomorrow.', pose: function (t) {
    return P({ mood: 'chill', y: 16, lh: [68, 186], rh: [132, 186], lf: [80, 204], rf: [120, 204], lfr: -6, rfr: 6, head: 12 });
  } };
  R.boop = { label: 'Boop!', once: 1.3, say: 'Hey! That tickles.', pose: function (t) {
    var k = t < .35 ? 1 : Math.max(0, 1 - (t - .35) * 1.6);
    return P({ mood: 'boop', lh: [62 - 22 * k, 175 - 62 * k], rh: [138 + 22 * k, 175 - 62 * k], y: -10 * k,
      lf: [88 - 4 * k, 204 - 8 * k], rf: [112 + 4 * k, 204 - 8 * k], head: S(t, 30) * 4 * k });
  } };
  R.twang = { label: 'Flick antenna', once: 2.2, say: 'Boing.', pose: function (t) {
    var up = t < .7, k = up ? Math.min(1, t / .45) : Math.max(0, 1 - (t - .9) * 1.5);
    return P({ mood: up ? 'idle' : 'happy', lh: [62 - 2 * k, 175 - 160 * k], lL: ARM + 100 * k, lb: 1, lback: true,
      lhand: t > .55 && t < .75 ? 'point' : 'open', head: 6 * k, rot: 2 * k });
  }, fx: function (rig, t) {
    if (t < .62 || rig.fired) return;
    rig.fired = true;
    var a = rig.bot.querySelector('.ant-l');
    a.classList.remove('twang'); void a.getBBox(); a.classList.add('twang');
    a.addEventListener('animationend', function () { a.classList.remove('twang'); }, { once: true });
  } };

  /* ---------- Rig ---------- */
  function limb(a, b, L, bend) {
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || .001;
    var c = d < L ? Math.sqrt(3 * (L * L - d * d) / 4) : 0;
    var cx = (a[0] + b[0]) / 2 - dy / d * c * bend, cy = (a[1] + b[1]) / 2 + dx / d * c * bend;
    return { d: 'M' + f(a[0]) + ' ' + f(a[1]) + 'Q' + f(cx) + ' ' + f(cy) + ' ' + f(b[0]) + ' ' + f(b[1]),
      ang: Math.atan2(b[1] - cy, b[0] - cx) * 180 / Math.PI };
  }
  function f(n) { return Math.round(n * 100) / 100; }
  function handSvg(shape) {
    var fs = HANDS[shape] || HANDS.open, o = '', i = '';
    fs.forEach(function (p) {
      var r = p[0] * Math.PI / 180, x = 3 + Math.cos(r) * (p[1] + 3), y = Math.sin(r) * (p[1] + 3);
      o += '<path d="M3 0L' + f(x) + ' ' + f(y) + '"/>';
    });
    return '<g class="ho">' + o + '<circle cx="3" cy="0" r="6.6"/></g><g class="hi">' + o + '<circle cx="3" cy="0" r="5.2"/></g>';
  }
  var FOOT = '<path class="fo" d="M-5.5 -3H5.5L9.5 7.5Q10 10 7.5 10H-7.5Q-10 10 -9.5 7.5Z"/><path class="fs" d="M-9.6 7H9.6L9.5 7.5Q10 10 7.5 10H-7.5Q-10 10 -9.5 7.5Z"/>';

  function Rig(host, opts) {
    this.host = host; this.opts = opts || {};
    this.body = this.opts.body !== false;
    host.innerHTML =
      '<svg class="rig" viewBox="0 0 200 222" role="img" aria-label="Fuzz with a body">' +
        '<ellipse class="bshadow" cx="100" cy="' + (GROUND + .5) + '" rx="34" ry="3.6"/>' +
        '<g class="legs"><path class="limb-o ll"/><path class="limb-i ll"/><path class="limb-o rl"/><path class="limb-i rl"/>' +
          '<g class="foot lfoot">' + FOOT + '</g><g class="foot rfoot">' + FOOT + '</g></g>' +
        '<g class="bodyg">' +
          '<g class="neck"><rect x="91" y="108" width="18" height="14" rx="3"/><path d="M91 116H109M91 119.5H109"/></g>' +
          '<g class="torso">' +
            '<rect x="76" y="118" width="48" height="52" rx="14" fill="var(--cab)"/>' +
            '<path d="M76 157H124Q124 170 111 170H89Q76 170 76 157Z" fill="var(--cab-d)" opacity=".5"/>' +
            '<rect x="76.8" y="118.8" width="46.4" height="50.4" rx="13.4" fill="none" stroke="var(--trim)" stroke-opacity=".4" stroke-width="1.5"/>' +
            '<rect x="84" y="129" width="32" height="7" rx="3.5" fill="var(--bezel)"/><rect x="87" y="131.8" width="26" height="1.6" rx=".8" fill="#000" opacity=".55"/>' +
            '<circle cx="88" cy="147" r="3" fill="var(--trim)"/><circle cx="97" cy="147" r="3" fill="var(--trim)"/><circle class="tled" cx="112" cy="147" r="2.1"/>' +
            '<circle cx="' + SH_L[0] + '" cy="' + SH_L[1] + '" r="4" fill="var(--cab-d)"/><circle cx="' + SH_R[0] + '" cy="' + SH_R[1] + '" r="4" fill="var(--cab-d)"/>' +
          '</g>' +
          '<g class="arms aback"></g>' +
          '<g class="headg">' + window.FUZZ_SVG + '</g>' +
          '<g class="arms afront"><g class="arm larm"><path class="limb-o la"/><path class="limb-i la"/><g class="hand lhand"></g></g>' +
            '<g class="arm rarm"><path class="limb-o ra"/><path class="limb-i ra"/><g class="hand rhand"></g></g></g>' +
        '</g>' +
      '</svg>';
    var q = function (s) { return host.querySelector(s); }, qa = function (s) { return host.querySelectorAll(s); };
    this.svg = q('svg.rig'); this.bot = q('#bot');
    this.bot.setAttribute('x', 30); this.bot.setAttribute('y', 0); this.bot.setAttribute('width', 140); this.bot.setAttribute('height', 126);
    this.el = { ll: qa('.ll'), rl: qa('.rl'), la: qa('.la'), ra: qa('.ra'), lhand: q('.lhand'), rhand: q('.rhand'),
      lfoot: q('.lfoot'), rfoot: q('.rfoot'), bodyg: q('.bodyg'), headg: q('.headg'), shadow: q('.bshadow'),
      larm: q('.larm'), rarm: q('.rarm'), aback: q('.aback'), afront: q('.afront') };
    this.back = { l: false, r: false };
    this.shapes = { l: '', r: '' };
    this.cur = null; this.ang = { l: 90, r: 90 };
    this.setBody(this.body);
    this.play('idle');
    var self = this;
    (function blink() {
      setTimeout(function () { self.bot.classList.add('blink'); setTimeout(function () { self.bot.classList.remove('blink'); }, 130); blink(); }, 2200 + Math.random() * 3200);
    })();
  }
  Rig.prototype.setBody = function (on) {
    this.body = on;
    this.svg.classList.toggle('nobody', !on);
    this.svg.setAttribute('viewBox', on ? '0 0 200 222' : '30 0 140 126');
  };
  Rig.prototype.play = function (name) {
    if (!R[name]) return;
    this.name = name; this.t0 = performance.now(); this.r = R[name]; this.fired = false;
    if (this.opts.onPlay) this.opts.onPlay(name, R[name]);
  };
  Rig.prototype.frame = function (now, dt, speed) {
    var t = (now - this.t0) / 1000 * speed;
    if (this.r.once && t > this.r.once) { this.play(this.prev || 'idle'); t = 0; }
    if (!this.r.once) this.prev = this.name;
    if (this.r.fx) this.r.fx(this, t);
    var tg = this.r.pose(t), b = this.bot;
    if (b.dataset.mood !== tg.mood) b.dataset.mood = tg.mood;
    var u = String(tg.urgency || 0); if (b.dataset.urgency !== u) b.dataset.urgency = u;
    if (tg.mood === 'bored') b.dataset.ch = '0';
    b.classList.toggle('cool', !!tg.cool);

    // ease the current pose toward the target
    var k = 1 - Math.exp(-dt * 14 * speed);
    if (!this.cur) this.cur = JSON.parse(JSON.stringify(tg));
    var c = this.cur;
    ['lh', 'rh', 'lf', 'rf'].forEach(function (n) { c[n][0] += (tg[n][0] - c[n][0]) * k; c[n][1] += (tg[n][1] - c[n][1]) * k; });
    ['lb', 'rb', 'llb', 'rlb', 'y', 'rot', 'head', 'lfr', 'rfr', 'lL', 'rL'].forEach(function (n) { c[n] += (tg[n] - c[n]) * k; });

    if (!this.body) {
      this.el.bodyg.removeAttribute('transform'); this.el.headg.removeAttribute('transform');
      return;
    }
    var e = this.el;
    var bodyT = 'translate(0 ' + f(c.y) + ') rotate(' + f(c.rot) + ' ' + PIVOT[0] + ' ' + PIVOT[1] + ')';
    e.bodyg.setAttribute('transform', bodyT);
    e.headg.setAttribute('transform', 'rotate(' + f(c.head) + ' ' + NECK[0] + ' ' + NECK[1] + ')');

    // hips move with the body; ankles stay in world space so feet stay planted
    var r = c.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    function world(p) { var x = p[0] - PIVOT[0], y = p[1] - PIVOT[1]; return [PIVOT[0] + x * cs - y * sn, PIVOT[1] + x * sn + y * cs + c.y]; }
    var lleg = limb(world(HIP_L), c.lf, LEG, c.llb), rleg = limb(world(HIP_R), c.rf, LEG, -c.rlb);
    setD(e.ll, lleg.d); setD(e.rl, rleg.d);
    e.lfoot.setAttribute('transform', 'translate(' + f(c.lf[0]) + ' ' + f(c.lf[1]) + ') rotate(' + f(c.lfr) + ')');
    e.rfoot.setAttribute('transform', 'translate(' + f(c.rf[0]) + ' ' + f(c.rf[1]) + ') rotate(' + f(c.rfr) + ')');
    var air = Math.max(0, Math.min(1, (GROUND - 10 - Math.max(c.lf[1], c.rf[1]) + 8) / 30));
    e.shadow.setAttribute('rx', f(34 - air * 10));

    // arms are in body space, so a hand on the hip stays on the hip when Fuzz leans
    var la = limb(SH_L, c.lh, c.lL, c.lb), ra = limb(SH_R, c.rh, c.rL, -c.rb);
    this.layer('l', tg.lback); this.layer('r', tg.rback);
    setD(e.la, la.d); setD(e.ra, ra.d);
    this.hand('l', e.lhand, c.lh, tg.lrot == null ? la.ang : tg.lrot, tg.lhand, k);
    this.hand('r', e.rhand, c.rh, tg.rrot == null ? ra.ang : tg.rrot, tg.rhand, k);
  };
  Rig.prototype.layer = function (side, back) {
    back = !!back;
    if (this.back[side] === back) return;
    this.back[side] = back;
    var arm = this.el[side + 'arm'], to = back ? this.el.aback : this.el.afront;
    if (side === 'l') to.insertBefore(arm, to.firstChild); else to.appendChild(arm);
  };
  Rig.prototype.hand = function (side, g, p, target, shape, k) {
    if (this.shapes[side] !== shape) { g.innerHTML = handSvg(shape); this.shapes[side] = shape; }
    var a = this.ang[side], d = ((target - a + 540) % 360) - 180;
    a += d * k; this.ang[side] = a;
    g.setAttribute('transform', 'translate(' + f(p[0]) + ' ' + f(p[1]) + ') rotate(' + f(a) + ')' + (side === 'l' ? ' scale(1 -1)' : ''));
  };
  function setD(list, d) { for (var i = 0; i < list.length; i++) list[i].setAttribute('d', d); }

  /* ---------- Driver ---------- */
  var rigs = [], last = performance.now(), speed = 1;
  function tick(now) {
    var dt = Math.min(.05, (now - last) / 1000); last = now;
    rigs.forEach(function (r) { r.frame(now, dt, speed); });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.FuzzBody = {
    reactions: R,
    rig: function (host, opts) { var r = new Rig(host, opts); rigs.push(r); return r; },
    all: function () { return rigs; },
    setSpeed: function (s) { speed = s; }
  };
})();
