/* Spike: the anime.js Fuzz from spikes/fuzz-anime, with elbows and knees instead of bendy hoses.
   The reactions and their timing come from that spike. The limbs are new.

   How the limbs work: each arm or leg is two equal segments and a hinge, solved with two-bone IK from
   the shoulder (or hip) to the hand (or ankle). An arm's elbow is pulled toward a pole, a point down and
   out from the shoulder, which is where a real elbow wants to go. That gives the right bend in every
   pose without saying so per pose: elbows drop when the hands go up, and stick out on the hips. When
   the hand crosses the pole line the elbow swings past the viewer, so the arm looks briefly shorter
   instead of snapping from one side to the other.

   By default the hinge is invisible: the limb pivots there, but it is drawn as one ringed tube that
   rounds the corner. Rig option hinges (or setHinges) shows it as a pinned joint instead.

   This is the rig the studio (spikes/fuzz-anime/studio.html) runs on. */
(function () {
  'use strict';
  var A = window.anime;

  /* ---------- Rig geometry (same as spikes/fuzz-body; outer viewBox 0 0 200 222) ---------- */
  var SH_L = [77, 131], SH_R = [123, 131];
  var HIP_L = [90, 166], HIP_R = [110, 166];
  var PIVOT = [100, 166];
  var NECK = [100, 114];
  var GROUND = 214;
  var ARM = 50, LEG = 40;
  var RINGS = 6, LEG_RINGS = 5;   // bands per limb; shown hinges split them between the two segments
  var POLE_L = [-.85, .5], POLE_R = [.85, .5];   // where each elbow wants to point
  var GRIP = 20;                                 // hand to tape centre, so the claw holds its bottom edge
  var FILLET = 10;                               // how far the tube's bend starts before the hinge
  var GAP = { open: 36, fist: 12, point: 26, shut: 7 };

  var IO = 'inOut(2)', OUT = 'out(3)', SINE = 'inOutSine';

  /* Settings that shape every reaction rather than one of them. The studio page tunes these. */
  var FEEL = { arriveMin: 260, arriveEase: IO, swing: 5 };

  /* Fuzz stands on the top edge of the card below, which is GROUND in the rig. Sitting drops the torso
     (bottom at body y 170) onto that edge, so the legs hang down in front of the card. dg is how hard
     they swing: the swing keeps its own clock, like the breath, and a pose only sets its size. */
  var SIT_Y = GROUND - 170;
  var SEAT = { y: SIT_Y, sit: 1, dg: 1, lh: [62, 170], rh: [138, 170], lf: [86, 248], rf: [114, 248], lfr: -6, rfr: 6 };
  function mix(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  /* A hand as an angle and a reach from its shoulder. Angles run from just past straight up, round
     through the outside, down and across the chest, so neither arm tweens the long way over the head. */
  function polar(sh, p) {
    var dx = p[0] - sh[0], dy = p[1] - sh[1], a = Math.atan2(dy, dx) * 180 / Math.PI;
    return { a: a <= -90 ? a + 360 : a, r: Math.hypot(dx, dy) };
  }

  /* One pose: every channel the timeline can tween, plus the switches that flip instead of tween. */
  var STAND = { lh: [62, 175], rh: [138, 175], lf: [88, 204], rf: [112, 204] };
  function expand(s, b) {
    var o = {}, k;
    for (k in STAND) o[k] = STAND[k];
    for (k in s) o[k] = s[k];
    for (k in b) o[k] = b[k];
    var la = polar(SH_L, o.lh), ra = polar(SH_R, o.rh);
    return {
      lA: la.a, lR: la.r, rA: ra.a, rR: ra.r, lL: num(o.lL, ARM), rL: num(o.rL, ARM),
      lX: o.lh[0], lY: o.lh[1], rX: o.rh[0], rY: o.rh[1], lst: num(o.lst, 0), rst: num(o.rst, 0),
      llb: num(o.llb, .75), rlb: num(o.rlb, .75),
      lfx: o.lf[0], lfy: o.lf[1], rfx: o.rf[0], rfy: o.rf[1], lfr: num(o.lfr, 0), rfr: num(o.rfr, 0),
      x: num(o.x, 0), y: num(o.y, 0), rot: num(o.rot, 0), head: num(o.head, 0),
      lgap: num(o.lgap, GAP[o.lhand || 'open']), rgap: num(o.rgap, GAP[o.rhand || 'open']),
      lrot: num(o.lrot, 0), rrot: num(o.rrot, 0), lw: o.lrot == null ? 0 : 1, rw: o.rrot == null ? 0 : 1,
      br: num(o.br, 1), sit: num(o.sit, 0), dg: num(o.dg, 0),
      tp: num(o.tp, 0), th: num(o.th, 0), tr: num(o.tr, 0), tf: num(o.tf, 1), ex: num(o.ex, 0), ey: num(o.ey, 0),
      pp: num(o.pp, 0), pg: num(o.pg, 0), pm: num(o.pm, 0)
    };
  }
  function num(v, d) { return v == null ? d : v; }

  /* The order things move in, as a fraction of the beat: hips and feet first, the claws last. */
  var GROUPS = [
    { keys: ['x', 'y', 'rot', 'lfx', 'lfy', 'rfx', 'rfy', 'lfr', 'rfr', 'llb', 'rlb', 'br', 'sit', 'dg', 'tp', 'ex', 'ey'], start: 0 },
    { keys: ['lA', 'lR', 'rA', 'rR', 'lL', 'rL', 'lX', 'lY', 'rX', 'rY', 'lst', 'rst', 'th', 'pp', 'pg', 'pm'], start: .08, arm: true },
    { keys: ['head'], start: .18 },
    { keys: ['lgap', 'rgap', 'lrot', 'rrot', 'lw', 'rw', 'tr', 'tf'], start: .26 }
  ];

  /* ---------- Reactions ----------
     s: the stance shared by every beat. enter: beats played once. loop: the cycle (Fuzz always moves to
     its first beat, then keeps going round). Each beat is a whole pose, stance plus its own fields. */
  var R = {};
  R.idle = { label: 'Idle', say: 'Hi! I’m keeping an eye on your list.', loop: [
    { d: 500, hold: 1500, ease: IO },
    { d: 800, hold: 1900, ease: IO, x: 1.2, rot: .7, head: -3, lh: [61, 175.5], rh: [137, 174.5] },
    { d: 900, hold: 1200, ease: IO, x: -1, rot: -.5, head: 2.5, lh: [63, 174.5], rh: [139, 175.5] }
  ] };
  /* A wave pivots at the elbow: the upper arm stays where it is and only the forearm swings. A hand one
     segment from the elbow puts the hinge right on it, and the pole already sends the elbow low and out. */
  var WAVE_ARM = 68, WAVE_DROP = 8 * Math.PI / 180;   // arm length, and how far the upper arm sits below level
  var WAVE_ELBOW = [SH_R[0] + Math.cos(WAVE_DROP) * WAVE_ARM / 2, SH_R[1] + Math.sin(WAVE_DROP) * WAVE_ARM / 2];
  function wave(deg, rrot, fields) {
    var a = deg * Math.PI / 180, x = WAVE_ELBOW[0] + Math.cos(a) * WAVE_ARM / 2, y = WAVE_ELBOW[1] + Math.sin(a) * WAVE_ARM / 2;
    var o = { rh: [+x.toFixed(1), +y.toFixed(1)], rrot: rrot }, k;
    for (k in fields) o[k] = fields[k];
    return o;
  }
  R.wave = { label: 'Wave hello', say: 'Oh hey, you’re back!', s: { mood: 'happy', rlay: 'aback', rL: WAVE_ARM, rot: -2, x: -1.5, head: -5 },
    enter: [{ d: 170, ease: IO, rh: [142, 168], y: 1.5, rot: 1 }, wave(-78, -74, { d: 300, hold: 60, ease: OUT, aease: 'outBack(1.4)' })],
    loop: [
      wave(-56, -42, { d: 190, ease: SINE }),
      wave(-90, -98, { d: 230, ease: SINE, head: -7 }),
      wave(-56, -42, { d: 230, ease: SINE }),
      wave(-90, -98, { d: 230, ease: SINE, head: -7 }),
      wave(-78, -74, { d: 170, hold: 650, ease: SINE })
    ] };
  R.cheer = { label: 'Cheer', say: 'Inbox zero! Look at you go!', s: { mood: 'happy', llay: 'aback', rlay: 'aback', lL: 58, rL: 58, br: 0 }, loop: [
    { d: 210, ease: 'out(2.2)', aease: 'inOut(1.6)', y: 9, head: 3, lh: [62, 158], rh: [138, 158], lf: [86, 204], rf: [114, 204], lgap: 14, rgap: 14 },
    { d: 280, ease: 'out(2.4)', aease: OUT, y: -24, lh: [40, 84], rh: [160, 84], lf: [85, 183], rf: [115, 183], lfr: -8, rfr: 8, head: -2 },
    { d: 260, ease: 'in(2.4)', aease: SINE, y: 0, lh: [36, 92], rh: [164, 92], lf: [86, 204], rf: [114, 204], head: 2, lgap: 14, rgap: 14 },
    { d: 110, ease: OUT, y: 7, lh: [40, 96], rh: [160, 96], lf: [86, 204], rf: [114, 204], head: 4 },
    { d: 210, hold: 420, ease: 'outBack(1.5)', y: -1, lh: [42, 84], rh: [158, 84], lf: [86, 204], rf: [114, 204], head: -2 }
  ] };
  R.dance = { label: 'Dance', say: 'Done, done, and done.', s: { mood: 'happy', rlay: 'aback', llay: 'aback', br: 0 }, loop: [
    { d: 190, ease: OUT, x: 6, y: 5, rot: 4, head: -6, lh: [56, 164], rh: [150, 108], lf: [84, 204], rf: [118, 204] },
    { d: 170, ease: IO, x: 2, y: -2, rot: 1, head: 2, lh: [58, 150], rh: [146, 118], lf: [84, 204], rf: [116, 197], rfr: 10 },
    { d: 190, ease: OUT, x: -6, y: 5, rot: -4, head: 6, lh: [50, 108], rh: [144, 164], lf: [82, 204], rf: [116, 204] },
    { d: 170, ease: IO, x: -2, y: -2, rot: -1, head: -2, lh: [54, 118], rh: [142, 150], lf: [84, 197], rf: [116, 204], lfr: -10 }
  ] };
  /* The arms swing as a pair while the hips go the other way. Each arm changes layer at the far end
     of its own side, clear of the torso: the beat that leaves that end is the one that flips it. */
  function flossHands(s) {
    var a = 90 - s * 58, c = Math.cos(a * Math.PI / 180) * ARM, n = Math.sin(a * Math.PI / 180) * ARM;
    return { lh: [SH_L[0] + c, SH_L[1] + n], rh: [SH_R[0] + c, SH_R[1] + n] };
  }
  function floss(s, fields) {
    var o = flossHands(s), k;
    for (k in fields) o[k] = fields[k];
    o.d = 420; o.ease = SINE; o.x = -s * 8; o.rot = s * 6; o.y = -1.5; o.head = -s * 5;
    return o;
  }
  R.floss = { label: 'Floss', say: 'List’s clean. Time to floss.', s: { mood: 'happy', lhand: 'fist', rhand: 'fist', lL: ARM - 2, rL: ARM - 2, lf: [84, 204], rf: [116, 204], br: 0 }, loop: [
    floss(1, { llay: 'afront', rlay: 'aunder' }),
    floss(-1, { llay: 'afront', rlay: 'afront' }),
    floss(1, { llay: 'aunder', rlay: 'afront' }),
    floss(-1, { llay: 'aunder', rlay: 'aunder' })
  ] };
  /* One arm points up and out, then sweeps down across the body, and the other hand stays on the hip. On
     the up the whole body makes one line with the arm, so the hips go the other way from the hand. */
  function disco(s, up) {
    var arm = s > 0 ? 'r' : 'l', hip = s > 0 ? 'l' : 'r', o = { d: 240, hold: 220, ease: OUT, aease: 'outBack(1.4)' };
    o[arm + 'h'] = up ? [100 + s * 72, 78] : [100 - s * 16, 168];
    o[arm + 'L'] = up ? 72 : 56;
    o[arm + 'hand'] = 'point'; o[hip + 'hand'] = 'fist'; o[hip + 'h'] = [100 - s * 20, 160];
    o.x = s * (up ? -6 : 4); o.y = up ? -2 : 3; o.rot = s * (up ? 5 : -3); o.head = s * (up ? -5 : 4);
    o[arm + 'f'] = up ? [100 + s * 18, 204] : [100 + s * 12, 199];
    o[arm + 'fr'] = up ? 0 : s * 10;
    return o;
  }
  R.disco = { label: 'Disco', say: 'All clear. Stayin’ alive.', s: { mood: 'happy', cool: true, llay: 'aback', rlay: 'aback', lst: 1, rst: 1, lf: [84, 204], rf: [116, 204], br: 0 }, loop: [
    disco(1, true), disco(1, false), disco(1, true), disco(1, false),
    disco(-1, true), disco(-1, false), disco(-1, true), disco(-1, false)
  ] };
  R.proud = { label: 'Hands on hips', say: 'Three tasks before lunch. Not bad.', s: { mood: 'proud', lhand: 'fist', rhand: 'fist', lh: [80, 160], rh: [120, 160], lf: [84, 204], rf: [116, 204] },
    enter: [{ d: 150, ease: IO, y: 3, lh: [70, 170], rh: [130, 170], head: 3 }],
    loop: [
      { d: 300, hold: 1700, ease: 'outBack(1.6)', y: -2, head: -5 },
      { d: 520, hold: 1500, ease: IO, y: -1, head: -1, rot: .8 }
    ] };
  R.thumb = { label: 'Claw clack', say: 'Nice one. Marked it done.', s: { mood: 'happy', rh: [150, 112], rL: 56, rrot: -70, head: -6, rot: -2 },
    enter: [{ d: 170, ease: IO, rh: [140, 164], rrot: null, head: 0, rot: 1 }],
    loop: [
      { d: 300, hold: 240, ease: OUT, aease: 'outBack(1.5)', rgap: 34 },
      { d: 90, ease: OUT, rgap: 7, head: -8 },
      { d: 110, ease: OUT, rgap: 34, head: -6 },
      { d: 90, ease: OUT, rgap: 7, head: -8 },
      { d: 240, hold: 1300, ease: 'outBack(1.8)', rgap: 34 }
    ] };
  R.point = { label: 'Point at a task', say: 'This one’s due tomorrow — want to start it?', s: { mood: 'eager', lf: [86, 204], rf: [116, 204], lh: [64, 172], rhand: 'point' },
    enter: [{ d: 190, ease: IO, rh: [136, 150], rot: 3, head: 3 }],
    loop: [
      { d: 260, hold: 1300, ease: OUT, aease: 'outBack(1.6)', rh: [176, 128], rot: -4, head: -6 },
      { d: 70, tight: 1, ease: OUT, rh: [167, 123], rot: -3, head: -6 },
      { d: 110, hold: 50, tight: 1, ease: 'outBack(1.8)', rh: [176, 128], rot: -4, head: -6 },
      { d: 70, tight: 1, ease: OUT, rh: [167, 123], rot: -3, head: -6 },
      { d: 110, tight: 1, ease: 'outBack(1.8)', rh: [176, 128], rot: -4, head: -6 }
    ] };
  R.thinking = { label: 'Thinking', say: 'Hmm, which of these is really urgent…', s: { mood: 'thinking', rh: [92, 122], rL: 60, rhand: 'fist', lh: [100, 152], lhand: 'fist', head: 7 }, loop: [
    { d: 420, hold: 1100, ease: IO },
    { d: 110, ease: OUT, rf: [113, 200], rfr: -14 },
    { d: 120, ease: 'in(2)', rf: [113, 204] },
    { d: 110, ease: OUT, rf: [113, 200], rfr: -14 },
    { d: 120, hold: 300, ease: 'in(2)', rf: [113, 204] },
    { d: 600, hold: 1300, ease: IO, head: 10, rot: 1 }
  ] };
  /* The papers live behind Fuzz. pp says they're out, pg hands them from the left claw to the right one,
     and pl says which side of the torso they're on. They appear and vanish behind the torso, and only
     change sides out past its edge, the same as an arm. The wrist stays in line with the forearm on the
     way, so the stack hangs from the claw. A stance with pp set needs them in hand, and
     play takes them out or puts them away as a transition, like sitting down.
     Working lifts the front sheet off with the right claw (pm) and slides it in behind the rest. pz counts
     half steps of that: even while the sheet is at the front, odd once it has gone to the back. */
  var BEHIND = { rh: [112, 140], rlay: 'aunder', pl: 'back', pg: 1, rot: 3, head: 2 };
  var BESIDE = { rh: [150, 158], rgap: 9, pp: 1, pg: 1, head: 2 };
  var TAKE_OUT = [
    mix(BEHIND, { d: 380, ease: IO, pp: 0, rgap: 34 }),
    mix(BEHIND, { d: 130, hold: 110, ease: OUT, pp: 1, rgap: 9 }),
    mix(BESIDE, { d: 300, ease: IO, rlay: 'aunder', pl: 'back' }),
    mix(BESIDE, { d: 280, ease: IO, rh: [130, 146], lh: [82, 148], lrot: 0, lgap: 9, head: 5 })
  ];
  var PUT_AWAY = [
    mix(BESIDE, { d: 300, ease: IO }),
    mix(BEHIND, { d: 300, ease: IO, pp: 1, rgap: 9 }),
    mix(BEHIND, { d: 130, hold: 90, ease: OUT, pp: 0, rgap: 34 }),
    { d: 320, ease: IO, rlay: 'aunder', pl: 'back' }
  ];
  function toBack(n) {
    return [
      { d: 240, ease: IO, pz: n * 2, pm: 1, rh: [146, 156], rot: 1, head: 5 },
      { d: 130, ease: IO, pz: n * 2 + 1, pm: 1, rh: [144, 150], rot: 1, head: 5 },
      { d: 240, hold: 200, ease: IO, pz: n * 2 + 1 }
    ];
  }
  R.working = { label: 'Working', say: 'Sorting your inbox…', s: { mood: 'working', pp: 1, rh: [118, 148], lh: [82, 148], rrot: 180, lrot: 0, rgap: 9, lgap: 9, rst: 1, head: 6 },
    loop: [{ d: 200, hold: 320, ease: IO }].concat(toBack(0), toBack(1), toBack(2), [
      { d: 70, tight: 1, ease: OUT, rh: [118, 153], lh: [82, 153], y: 1.5 },
      { d: 90, tight: 1, ease: OUT },
      { d: 70, tight: 1, ease: OUT, rh: [118, 153], lh: [82, 153], y: 1.5 },
      { d: 90, hold: 260, tight: 1, ease: OUT }
    ]) };
  /* A run cycle: down on the planted foot, up through the push-off, then the same with the feet swapped.
     The fists pump opposite the feet, chest to hip, staying on the side of the shoulder that keeps the
     elbows low and out. Past it they'd flip over at every swing. */
  R.rushed = { label: 'Rushing', say: 'Due in 20 minutes! Go go go!', s: { mood: 'rushed', urgency: 3, lhand: 'fist', rhand: 'fist', rot: 4, br: 0 }, loop: [
    { d: 90, tight: 1, ease: SINE, y: 3, lf: [94, 204], rf: [108, 192], lfr: -6, rfr: 10, lh: [92, 146], rh: [136, 166], head: 1 },
    { d: 90, tight: 1, ease: SINE, y: -5, lf: [88, 203], rf: [112, 198], lfr: 12, rfr: -8, lh: [76, 158], rh: [124, 158], head: -1 },
    { d: 90, tight: 1, ease: SINE, y: 3, lf: [92, 192], rf: [106, 204], lfr: 10, rfr: -6, lh: [64, 166], rh: [108, 146], head: 1 },
    { d: 90, tight: 1, ease: SINE, y: -5, lf: [88, 198], rf: [112, 203], lfr: -8, rfr: 12, lh: [76, 158], rh: [124, 158], head: -1 }
  ] };
  R.worried = { label: 'Worried', say: 'Uh oh. That deadline slipped past.', s: { mood: 'worried', lh: [95, 136], rh: [105, 136], lhand: 'fist', rhand: 'fist', llb: -1, rlb: -1, lf: [84, 204], rf: [116, 204], head: -3 }, loop: [
    { d: 340, hold: 520, ease: IO, y: 2 },
    { d: 45, tight: 1, ease: SINE, y: 2, x: 1, head: -2 },
    { d: 45, tight: 1, ease: SINE, y: 2, x: -1, head: -4 },
    { d: 45, tight: 1, ease: SINE, y: 2, x: 1, head: -2 },
    { d: 45, tight: 1, ease: SINE, y: 2, x: -1, head: -4 },
    { d: 45, tight: 1, hold: 700, ease: SINE, y: 2 },
    { d: 380, hold: 800, ease: IO, y: 3, head: 5, rot: 1 }
  ] };
  R.sheepish = { label: 'Sheepish', say: 'I may have filed that in the wrong place…', s: { mood: 'sheepish', head: -9, rot: 2, llb: -1, rlb: -1, lf: [92, 204], rf: [108, 204], lfr: 8, rfr: -8, lh: [36, 80], lrot: -100, lL: 74 }, loop: [
    { d: 420, hold: 240, ease: IO, aease: OUT },
    { d: 120, ease: SINE, lh: [34, 73], lrot: -112 },
    { d: 120, ease: SINE },
    { d: 120, ease: SINE, lh: [34, 73], lrot: -112 },
    { d: 120, hold: 900, ease: SINE },
    { d: 380, hold: 700, ease: IO, head: -11, rot: 3, rf: [106, 202], rfr: -14 }
  ] };
  R.shrug = { label: 'Shrug', say: 'No idea where that one goes. You pick?', s: { mood: 'bored' },
    enter: [{ d: 180, ease: IO, y: 2.5, head: 2, lh: [58, 170], rh: [142, 170] }],
    loop: [
      { d: 300, hold: 800, ease: OUT, aease: 'outBack(1.5)', y: -3, head: 9, lh: [44, 122], rh: [156, 122], lrot: 235, rrot: -55 },
      { d: 640, hold: 900, ease: 'in(2)', aease: IO, y: 0, head: 3, lh: [48, 150], rh: [152, 150], lrot: 200, rrot: -20 },
      { d: 170, ease: IO, y: 2.5, head: 2, lh: [50, 156], rh: [150, 156], lrot: 200, rrot: -20 }
    ] };
  /* The tape lives in the chest slot. tp is how far it sticks out, th hands it from the slot to the claw,
     tr tilts it, and tf turns it over (1 is the label, -1 the back). ex and ey aim the eyes at it. */
  function atSlot(o) { return mix({ rh: [113, 135], rrot: 180, rgap: 9, tp: .6, head: 5, ex: -1, ey: 3 }, o); }
  function inHand(o) { return mix({ rh: [162, 113], rrot: -64, rgap: 9, tp: .6, th: 1, tr: -6, head: 7, ex: 4, ey: 0 }, o); }
  R.tape = { label: 'Bored: old tape', once: true, say: 'Huh. Forgot I had this one.', s: { mood: 'bored' }, enter: [
    { d: 600, hold: 500, ease: IO, y: 1.5, head: 3, lh: [64, 176], rh: [136, 176] },
    { d: 420, hold: 160, ease: IO, rh: [116, 142], rrot: 180, rgap: 34, head: 5, ex: -1, ey: 3 },
    atSlot({ d: 170, hold: 240, ease: 'outBack(2.2)', rh: [116, 142], rgap: 34, y: -1 }),
    atSlot({ d: 150, hold: 90, ease: OUT }),
    inHand({ d: 520, ease: IO }),
    inHand({ d: 280, hold: 800, ease: IO, tr: -11, ey: -1 }),
    inHand({ d: 380, hold: 900, ease: IO, tf: -1, tr: 4, ey: 1 }),
    inHand({ d: 340, hold: 380, ease: IO, tr: -6, head: 4 }),
    atSlot({ d: 520, hold: 80, ease: IO }),
    atSlot({ d: 150, ease: 'in(2)', rh: [110, 135], tp: 0 }),
    atSlot({ d: 150, hold: 180, ease: OUT, rh: [116, 142], rgap: 34, tp: 0, y: 1.5, head: 6 }),
    { d: 560, ease: IO }
  ] };
  /* One claw over the heart, the other at Fuzz's side, and a small bow. */
  R.grateful = { label: 'Grateful', say: 'Aw, thanks for checking in with me.', s: { mood: 'grateful', rh: [112, 146], rrot: 180, rhand: 'fist' }, loop: [
    { d: 460, hold: 300, ease: IO },
    { d: 620, hold: 420, ease: IO, rot: 2, y: 4, head: 10 },
    { d: 720, hold: 700, ease: IO, rot: -1, y: 0, head: -3 }
  ] };
  R.sulk = { label: 'Arms crossed', say: 'You snoozed it again. Fine.', s: { mood: 'stare', lh: [106, 147], rh: [91, 149], lhand: 'fist', rhand: 'fist', head: -7, rot: 2, lf: [86, 204], rf: [114, 204] }, loop: [
    { d: 340, hold: 2200, ease: IO, aease: OUT },
    { d: 150, ease: OUT, y: -2.5, head: -10 },
    { d: 620, hold: 1700, ease: 'inOut(3)', y: .5, head: -8 }
  ] };
  /* Fuzz sits down awake, legs swinging, and only then gets drowsy. Sinking into a doze and catching itself
     is one slow move and one fast one, and a single z floats off on the way down. */
  R.sleepy = { label: 'Sit & doze', say: 'Nothing due today… zzz', s: mix(SEAT, { mood: 'sleepy', br: 1.5, dg: 0 }),
    enter: [{ d: 400, hold: 900, ease: IO, mood: 'idle', head: -1, br: 1, dg: .7 }, { d: 900, ease: 'inOut(2.4)', head: 6 }],
    loop: [
      { d: 400, hold: 500, ease: IO, head: 7 },
      { d: 2300, hold: 240, ease: 'in(2.2)', head: 19, fx: snooze },
      { d: 180, ease: OUT, head: 3 },
      { d: 700, ease: 'outBack(1.2)', head: 7 }
    ] };
  /* Fuzz sits down awake and swings its legs a moment. Then the set goes off, the head drops first, and
     the legs sway to a stop on their own. */
  R.chill = { label: 'Power off', say: 'Off for the night. See you tomorrow.', s: mix(SEAT, { mood: 'chill', head: 12, br: 0, dg: 0 }),
    enter: [{ d: 400, hold: 900, ease: IO, mood: 'idle', head: -1, br: 1, dg: .8 }, { d: 520, ease: 'inOut(2.4)', head: 2, dg: .8 }, { d: 620, ease: 'outBack(1.15)', dg: .5 }, { d: 1900, ease: 'out(2)' }] };
  function snooze(rig) {
    var b = rig.bot;
    b.classList.remove('snooze'); void b.getBBox(); b.classList.add('snooze');
    b.querySelector('.zzz').addEventListener('animationend', function () { b.classList.remove('snooze'); }, { once: true });
  }
  /* Boop and flick play once, then go back to what Fuzz was doing. */
  R.boop = { label: 'Boop!', once: true, say: 'Hey! That tickles.', s: { mood: 'boop' }, enter: [
    { d: 120, tight: 1, ease: 'out(2)', y: -11, lh: [40, 113], rh: [160, 113], lf: [84, 197], rf: [116, 197], head: 6 },
    { d: 180, ease: 'in(2)', y: 3, lh: [42, 122], rh: [158, 122], lf: [84, 204], rf: [116, 204], head: -5 },
    { d: 520, ease: 'outElastic(1,.45)', aease: 'outBack(1.4)', mood: 'idle' }
  ] };
  R.twang = { label: 'Flick antenna', once: true, say: 'Boing.', s: { llay: 'aback' }, enter: [
    { d: 170, ease: IO, head: -2, y: 1.5, lh: [58, 168] },
    { d: 460, ease: IO, aease: 'inOut(2.4)', lh: [60, 15], lL: ARM + 72, head: 6, rot: 2, y: -1 },
    { d: 90, ease: 'in(2)', lh: [60, 15], lL: ARM + 72, lhand: 'fist', head: 6, rot: 2, y: -1 },
    { d: 90, hold: 280, ease: OUT, lh: [52, 19], lL: ARM + 72, head: 5, rot: 2, fx: twang, mood: 'happy' },
    { d: 620, ease: IO, mood: 'happy' }
  ] };
  function twang(rig) {
    var a = rig.bot.querySelector('.ant-l');
    a.classList.remove('twang'); void a.getBBox(); a.classList.add('twang');
    a.addEventListener('animationend', function () { a.classList.remove('twang'); }, { once: true });
  }

  /* Getting onto the edge and off it. Both are small hops, so the feet clear the lip of the card instead
     of sliding through it. These run before a reaction's own beats, when it needs Fuzz to change places. */
  var SIT_DOWN = [
    { d: 220, ease: IO, y: 7, head: 3, lh: [62, 166], rh: [138, 166], lf: [86, 204], rf: [114, 204] },
    { d: 230, ease: 'out(2.4)', y: -10, head: -3, lh: [50, 150], rh: [150, 150], lf: [82, 197], rf: [118, 197], lfr: -8, rfr: 8 },
    mix(SEAT, { d: 250, ease: 'in(2.2)', dg: 0, head: 5, lf: [86, 251], rf: [114, 251] }),
    mix(SEAT, { d: 130, ease: OUT, dg: .4, y: SIT_Y - 3, head: -2, lf: [86, 240], rf: [114, 240] }),
    mix(SEAT, { d: 170, ease: 'in(2)', dg: .7, head: 3 })
  ];
  var GET_UP = [
    mix(SEAT, { d: 200, ease: IO, dg: 0, head: 4, lh: [60, 176], rh: [140, 176], lf: [86, 244], rf: [114, 244] }),
    { d: 280, ease: 'out(2.4)', y: -12, head: -3, lh: [52, 156], rh: [148, 156], lf: [84, 196], rf: [116, 196], lfr: -8, rfr: 8 },
    { d: 190, ease: 'in(2.2)', y: 5, head: 3, lf: [88, 204], rf: [112, 204] }
  ];
  /* A boop or a flick while seated stays seated: the same beats, but it can't drop through the card. */
  function onSeat(b) {
    var o = mix(b, { y: SIT_Y + Math.min(b.y || 0, 0), src: b });
    delete o.lf; delete o.rf;
    return o;
  }

  /* ---------- Rig drawing ---------- */
  /* Two-bone IK with equal segments: the hinge sits on the line that splits shoulder-to-hand in half, as
     far out as the segments allow. bend (-1..1) says which side, and how far toward the viewer it has
     swung. Past full reach the segments stretch rather than letting the hand fall short. */
  function limb(a, b, L, bend, tube) {
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || .001, u = L / 2;
    var h = d < L ? Math.sqrt(u * u - d * d / 4) : 0;
    var j = [(a[0] + b[0]) / 2 - dy / d * h * bend, (a[1] + b[1]) / 2 + dx / d * h * bend];
    var l = { d: 'M' + f(a[0]) + ' ' + f(a[1]) + 'L' + f(j[0]) + ' ' + f(j[1]) + 'L' + f(b[0]) + ' ' + f(b[1]),
      ang: Math.atan2(b[1] - j[1], b[0] - j[0]) * 180 / Math.PI, a: a, j: j, b: b };
    if (tube) round(l, Math.min(FILLET, u * .6));
    return l;
  }
  /* Swaps the hard corner for a curve: the tube leaves each segment r short of the hinge. */
  function round(l, r) {
    function back(p) { var dx = p[0] - l.j[0], dy = p[1] - l.j[1], d = Math.hypot(dx, dy) || 1, k = Math.min(r, d / 2) / d; return [l.j[0] + dx * k, l.j[1] + dy * k]; }
    var p = back(l.a), q = back(l.b), N = 8, i;
    l.d = 'M' + f(l.a[0]) + ' ' + f(l.a[1]) + 'L' + f(p[0]) + ' ' + f(p[1]) + 'Q' + f(l.j[0]) + ' ' + f(l.j[1]) + ' ' + f(q[0]) + ' ' + f(q[1]) + 'L' + f(l.b[0]) + ' ' + f(l.b[1]);
    l.pts = [l.a];
    for (i = 0; i <= N; i++) {
      var t = i / N, u = 1 - t;
      l.pts.push([u * u * p[0] + 2 * u * t * l.j[0] + t * t * q[0], u * u * p[1] + 2 * u * t * l.j[1] + t * t * q[1]]);
    }
    l.pts.push(l.b);
  }
  function pole(a, b, p) {
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || .001;
    return Math.max(-1, Math.min(1, (-dy / d * p[0] + dx / d * p[1]) * 3));
  }
  function band(out, x, y, nx, ny) {
    out.bump += 'M' + f(x - nx * 4.9) + ' ' + f(y - ny * 4.9) + 'L' + f(x + nx * 4.9) + ' ' + f(y + ny * 4.9);
    out.line += 'M' + f(x - nx * 3) + ' ' + f(y - ny * 3) + 'L' + f(x + nx * 3) + ' ' + f(y + ny * 3);
  }
  /* A tube's bands are spaced evenly along its whole length, round the corner too. */
  function rings(l, n) {
    var out = { bump: '', line: '' };
    if (l.pts) {
      var pts = l.pts, len = [0], i, j = 1;
      for (i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      var total = len[len.length - 1];
      for (var c = 0; c < n; c++) {
        var want = total * (.14 + .74 * c / (n - 1));
        while (j < pts.length - 1 && len[j] < want) j++;
        var k = (want - len[j - 1]) / ((len[j] - len[j - 1]) || 1), ax = pts[j][0] - pts[j - 1][0], ay = pts[j][1] - pts[j - 1][1], al = Math.hypot(ax, ay) || 1;
        band(out, pts[j - 1][0] + ax * k, pts[j - 1][1] + ay * k, -ay / al, ax / al);
      }
      return out;
    }
    /* With a hinge showing, bands sit across each segment, clear of both ends so the hinge stays bare. */
    var each = n >> 1;
    [[l.a, l.j], [l.j, l.b]].forEach(function (s) {
      var dx = s[1][0] - s[0][0], dy = s[1][1] - s[0][1], dl = Math.hypot(dx, dy) || 1;
      for (var r = 0; r < each; r++) {
        var t = .3 + .4 * (each > 1 ? r / (each - 1) : .5);
        band(out, s[0][0] + dx * t, s[0][1] + dy * t, -dy / dl, dx / dl);
      }
    });
    return out;
  }
  function f(n) { return Math.round(n * 100) / 100; }
  function clawPath(gap) {
    var cx = 8.5, R = 6.4, r = 3.1, g = Math.max(4, gap) * Math.PI / 180;
    function pt(rad, a) { return f(cx + rad * Math.cos(a)) + ' ' + f(rad * Math.sin(a)); }
    return 'M' + pt(R, g) + 'A' + R + ' ' + R + ' 0 1 1 ' + pt(R, -g) +
      'L' + pt(r, -g) + 'A' + r + ' ' + r + ' 0 1 0 ' + pt(r, g) + 'Z';
  }
  var HAND = '<rect class="wrist" x="-1.5" y="-2.6" width="5" height="5.2" rx="1.2"/><path class="claw"/>';
  var FOOT = '<path class="fo" d="M-5.5 -3H5.5L9.5 7.5Q10 10 7.5 10H-7.5Q-10 10 -9.5 7.5Z"/><path class="fs" d="M-9.6 7H9.6L9.5 7.5Q10 10 7.5 10H-7.5Q-10 10 -9.5 7.5Z"/>';

  var SHEETHOLD = 18, SHEETGRIP = 14;   // left hand to stack centre (right hand is the same, across it), and hand to stack when the right claw has it all
  var SPINE = 7;   // how thick the tape is, seen from the side
  var JOINT = '<g class="joint %"><circle r="4.5"/><circle class="pin" r="1.5"/></g>';

  var TAPE = '<g class="vhs"><g class="vface"><rect class="vb" x="-17" y="-10" width="34" height="20" rx="1.8"/>' +
    '<g class="vfront"><rect class="vl" x="-14.5" y="-8.5" width="29" height="6.6" rx=".8"/><text class="vt" y="-3.7" text-anchor="middle" font-size="4.2">INBOX ’94</text>' +
      '<rect class="vw" x="-11" y="-.4" width="22" height="7.6" rx="1.2"/><circle class="vs" cx="-5.5" cy="3.4" r="2.5"/><circle class="vs" cx="5.5" cy="3.4" r="2.5"/></g>' +
    '<g class="vback"><rect class="vl" x="-13" y="-6.5" width="26" height="13" rx=".8"/><text class="vt" y="-1.2" text-anchor="middle" font-size="3.9">BE KIND,</text><text class="vt" y="3.6" text-anchor="middle" font-size="3.9">REWIND</text></g></g>' +
    '<g class="vside"><rect class="vb" x="-3.5" y="-10" width="7" height="20" rx="1"/><rect class="vl" x="-2" y="-7.5" width="4" height="15" rx=".6"/></g></g>';

  function sheet(ink) { return '<g class="sheet"><rect class="sh" x="-11" y="-14" width="22" height="28" rx="1"/>' + ink + '</g>'; }
  var PAPER = '<g class="paper">' +
    sheet('<path class="ln" d="M-7 -8.5H7M-7 -4H7M-7 .5H7M-7 5H2"/>') +
    sheet('<rect class="mk" x="-7" y="-10" width="14" height="5"/><path class="ln" d="M-7 -1H7M-7 3.5H7M-7 8H0"/>') +
    sheet('<circle class="ok" cx="-5" cy="-7" r="2.6"/><path class="ln" d="M-.5 -8H7M-.5 -5.5H5M-7 -.5H7M-7 4H7"/>') +
    '</g>';

  function armSvg(s) {
    return '<g class="arm ' + s + 'arm"><path class="limb-o ' + s + 'a"/><path class="ring-b ' + s + 'ab"/><path class="limb-i ' + s + 'a"/>' +
      '<path class="ring-l ' + s + 'al"/>' + JOINT.replace('%', s + 'elbow') + '<g class="hand ' + s + 'hand">' + HAND + '</g></g>';
  }
  function legSvg(s) {
    return '<g class="leg"><path class="limb-o ' + s + 'l"/><path class="ring-b ' + s + 'lb"/><path class="limb-i ' + s + 'l"/><path class="ring-l ' + s + 'll"/>' + JOINT.replace('%', s + 'knee') + '</g>';
  }
  function at(g, p) { g.setAttribute('transform', 'translate(' + f(p[0]) + ' ' + f(p[1]) + ')'); }
  function setD(list, d) { for (var i = 0; i < list.length; i++) list[i].setAttribute('d', d); }
  /* Hands swing round the shoulder unless a pose asks otherwise: lst and rst blend toward a straight line
     between poses, 0 for the full arc and 1 for dead straight. */
  function hand(p, side) {
    var sh = side === 'l' ? SH_L : SH_R, a = p[side + 'A'] * Math.PI / 180, r = p[side + 'R'], s = p[side + 'st'];
    var x = sh[0] + Math.cos(a) * r, y = sh[1] + Math.sin(a) * r;
    return [x + (p[side + 'X'] - x) * s, y + (p[side + 'Y'] - y) * s];
  }

  function Rig(host, opts) {
    this.host = host; this.opts = opts || {};
    this.body = this.opts.body !== false;
    host.innerHTML =
      '<svg class="rig" viewBox="0 0 200 222" role="img" aria-label="Fuzz with a body">' +
        '<ellipse class="bshadow" cx="100" cy="' + (GROUND + .5) + '" rx="34" ry="3.6"/>' +
        '<g class="legs">' + legSvg('l') + legSvg('r') +
          '<g class="foot lfoot">' + FOOT + '</g><g class="foot rfoot">' + FOOT + '</g></g>' +
        '<g class="bodyg">' +
          '<g class="neck"><rect x="91" y="108" width="18" height="14" rx="3"/><path d="M91 116H109M91 119.5H109"/></g>' +
          '<g class="pback"></g>' +
          '<g class="arms aunder"></g>' +
          '<g class="torso">' +
            '<rect x="76" y="118" width="48" height="52" rx="14" fill="var(--cab)"/>' +
            '<path d="M76 157H124Q124 170 111 170H89Q76 170 76 157Z" fill="var(--cab-d)" opacity=".5"/>' +
            '<rect x="76.8" y="118.8" width="46.4" height="50.4" rx="13.4" fill="none" stroke="var(--trim)" stroke-opacity=".4" stroke-width="1.5"/>' +
            '<rect x="84" y="129" width="32" height="7" rx="3.5" fill="var(--bezel)"/><rect x="87" y="131.8" width="26" height="1.6" rx=".8" fill="#000" opacity=".55"/>' +
            '<circle cx="88" cy="147" r="3" fill="var(--trim)"/><circle cx="97" cy="147" r="3" fill="var(--trim)"/><circle class="tled" cx="112" cy="147" r="2.1"/>' +
            '<circle cx="' + SH_L[0] + '" cy="' + SH_L[1] + '" r="4" fill="var(--cab-d)"/><circle cx="' + SH_R[0] + '" cy="' + SH_R[1] + '" r="4" fill="var(--cab-d)"/>' +
            '<circle class="shcap lshcap" cx="' + SH_L[0] + '" cy="' + SH_L[1] + '" r="3.6"/><circle class="shcap rshcap" cx="' + SH_R[0] + '" cy="' + SH_R[1] + '" r="3.6"/>' +
          '</g>' +
          '<g class="arms aback"></g>' +
          '<g class="headg">' + window.FUZZ_SVG + '</g>' +
          TAPE +
          '<g class="pfront">' + PAPER + '</g>' +
          '<g class="arms afront">' + armSvg('l') + armSvg('r') + '</g>' +
        '</g>' +
      '</svg>';
    var q = function (s) { return host.querySelector(s); }, qa = function (s) { return host.querySelectorAll(s); };
    this.svg = q('svg.rig'); this.bot = q('#bot');
    this.bot.setAttribute('x', 30); this.bot.setAttribute('y', 0); this.bot.setAttribute('width', 140); this.bot.setAttribute('height', 126);
    this.el = { ll: qa('.ll'), rl: qa('.rl'), llb: q('.llb'), rlb: q('.rlb'), lll: q('.lll'), rll: q('.rll'), la: qa('.la'), ra: qa('.ra'), lab: q('.lab'), rab: q('.rab'), lal: q('.lal'), ral: q('.ral'), lhand: q('.lhand'), rhand: q('.rhand'),
      vhs: q('.vhs'), vface: q('.vface'), vside: q('.vside'), vfront: q('.vfront'), vback: q('.vback'), paper: q('.paper'), sheets: qa('.sheet'), pfront: q('.pfront'), pback: q('.pback'), eyes: q('#eyes'), lelbow: q('.lelbow'), relbow: q('.relbow'), lknee: q('.lknee'), rknee: q('.rknee'), lfoot: q('.lfoot'), rfoot: q('.rfoot'), bodyg: q('.bodyg'), headg: q('.headg'), shadow: q('.bshadow'),
      larm: q('.larm'), rarm: q('.rarm'), lshcap: q('.lshcap'), rshcap: q('.rshcap'), aunder: q('.aunder'), aback: q('.aback'), afront: q('.afront') };
    this.layerOf = { l: 'afront', r: 'afront' };
    this.p = expand({}, {});
    this.breath = { v: -1 }; this.swing = { v: -1 }; this.pz = 0;
    this.setBody(this.body);
    this.setHinges(!!this.opts.hinges);
    var self = this;
    /* Breathing runs under everything on its own clock, so Fuzz is never fully frozen during a hold. */
    A.animate(this.breath, { v: 1, duration: 1700, ease: SINE, alternate: true, loop: true });
    A.animate(this.swing, { v: 1, duration: 620, ease: SINE, alternate: true, loop: true });
    this.timer = A.createTimer({ onUpdate: function () { self.draw(); } });
    this.play('idle');
    (function blink() {
      setTimeout(function () { self.bot.classList.add('blink'); setTimeout(function () { self.bot.classList.remove('blink'); }, 130); blink(); }, 2200 + Math.random() * 3200);
    })();
  }
  Rig.prototype.setBody = function (on) {
    this.body = on;
    this.svg.classList.toggle('nobody', !on);
    this.svg.setAttribute('viewBox', on ? '0 0 200 222' : '30 0 140 126');
  };

  Rig.prototype.setHinges = function (on) {
    this.tube = !on;
    this.svg.classList.toggle('hinges', on);
  };

  /* Flat switches a pose can flip: these change at the start of a beat, they do not tween. */
  Rig.prototype.flip = function (s, b) {
    function v(k, d) { return b[k] !== undefined ? b[k] : s[k] !== undefined ? s[k] : d; }
    var bot = this.bot, mood = v('mood', 'idle'), u = String(v('urgency', 0));
    if (bot.dataset.mood !== mood) bot.dataset.mood = mood;
    if (bot.dataset.urgency !== u) bot.dataset.urgency = u;
    if (mood === 'bored') bot.dataset.ch = '0';
    bot.classList.toggle('cool', !!v('cool', false));
    this.layer('l', v('llay', 'afront')); this.layer('r', v('rlay', 'afront'));
    var pz = this.el[v('pl', 'front') === 'back' ? 'pback' : 'pfront'];
    if (this.el.paper.parentNode !== pz) pz.appendChild(this.el.paper);
    this.pz = v('pz', 0);
    this.stack().forEach(function (k) { this.el.paper.appendChild(this.el.sheets[k]); }, this);
    if (b.fx) b.fx(this);
  };

  /* Adds one beat to a timeline at time t and returns the time the next beat starts. Only channels that
     actually change get a tween, so a beat that moves one foot leaves the rest of Fuzz on its hold. */
  Rig.prototype.beat = function (tl, s, b, from, t) {
    var self = this, to = expand(s, b), d = b.d;
    tl.call(function () { self.flip(s, b); if (self.opts.onBeat) self.opts.onBeat(b.src || b); }, Math.max(t, 1));
    GROUPS.forEach(function (g) {
      var params = {}, any = false, lead = b.tight ? 0 : g.start;
      g.keys.forEach(function (k) { if (Math.abs(to[k] - from[k]) > .001) { params[k] = to[k]; any = true; } });
      if (!any) return;
      params.duration = d * (1 - lead);
      params.ease = (g.arm && b.aease) || b.ease || IO;
      tl.add(self.p, params, t + d * lead);
    });
    for (var k in to) from[k] = to[k];
    return t + d + (b.hold || 0);
  };

  /* The first beat of a reaction starts from wherever Fuzz happens to be, maybe across the screen, so it
     eases in. An out() ease here would cover most of that distance in a single frame. */
  function arrive(b) {
    var o = {}, k;
    for (k in b) o[k] = b[k];
    o.d = Math.max(b.d, FEEL.arriveMin); o.ease = FEEL.arriveEase; o.aease = FEEL.arriveEase; o.src = b.src || b;
    return o;
  }

  Rig.prototype.stop = function () { if (this.tl) { this.tl.cancel(); this.tl = null; } };

  /* Freeze on one pose, for tuning it. Nothing tweens, so a change shows on the next frame. */
  Rig.prototype.pose = function (s, b) {
    var to = expand(s, b), k;
    this.stop();
    for (k in to) this.p[k] = to[k];
    this.flip(s, b.fx ? mix(b, { fx: null }) : b);
  };
  /* Jump straight to where a reaction comes to rest, so a transition can start from the same place every time. */
  Rig.prototype.snap = function (name) {
    var r = R[name], rest = r.loop ? r.loop[0] : r.enter[r.enter.length - 1];
    this.pose(r.s || {}, rest);
    this.name = name; this.prev = name;
  };

  Rig.prototype.play = function (name) {
    var r = R[name], self = this;
    if (!r) return;
    this.stop();
    this.name = name;
    if (!r.once) this.prev = name;
    if (this.opts.onPlay) this.opts.onPlay(name, r);
    var seated = this.p.sit > .5, stay = r.once && seated;
    var s = stay ? mix(SEAT, r.s) : r.s || {}, from = {}, k, t = 0;
    var sitting = !r.once && !seated && s.sit;
    var holding = this.p.pp > .5, needs = s.pp > .5;
    var lead = (holding && !needs ? PUT_AWAY : []).concat(r.once ? [] : seated && !s.sit ? GET_UP : sitting ? SIT_DOWN : [], !holding && needs ? TAKE_OUT : []), leadS = { mood: sitting ? 'idle' : s.mood };
    for (k in this.p) from[k] = this.p[k];
    var tl = A.createTimeline({ onComplete: function () {
      if (self.tl !== tl) return;
      if (r.once) self.play(self.prev || 'idle'); else if (r.loop) self.cycle(r);
    } });
    this.tl = tl;
    this.flip(lead.length ? leadS : s, {});
    var beats = (r.enter || []).concat(r.loop ? [r.loop[0]] : []);
    if (stay) beats = beats.map(onSeat);
    lead.forEach(function (b, i) { t = self.beat(tl, leadS, i ? b : arrive(b), from, t); });
    beats.forEach(function (b, i) { t = self.beat(tl, s, i || r.once || lead.length ? b : arrive(b), from, t); });
    tl.call(function () {}, t);
  };

  /* The loop runs from its first beat round to its first beat again, so the seam is invisible. In the
     Calm setting Fuzz does the gesture once and then stays put. */
  Rig.prototype.cycle = function (r) {
    if (document.documentElement.classList.contains('calm')) return;
    var self = this, s = r.s || {}, from = expand(s, r.loop[0]), t = 0;
    var tl = A.createTimeline({ loop: true });
    this.tl = tl;
    r.loop.slice(1).concat(r.loop[0]).forEach(function (b) { t = self.beat(tl, s, b, from, t); });
    tl.call(function () {}, t);
  };

  Rig.prototype.layer = function (side, name) {
    if (this.layerOf[side] === name) return;
    this.layerOf[side] = name;
    this.el[side + 'shcap'].classList.toggle('on', name === 'aunder');
    var arm = this.el[side + 'arm'], to = this.el[name];
    if (side === 'l') to.insertBefore(arm, to.firstChild); else to.appendChild(arm);
  };

  Rig.prototype.draw = function () {
    if (!this.body) {
      this.el.bodyg.removeAttribute('transform'); this.el.headg.removeAttribute('transform');
      return;
    }
    var c = this.p, e = this.el, still = document.documentElement.classList.contains('calm') ? 0 : 1;
    var br = this.breath.v * c.br * still, sw = this.swing.v * c.dg * still;
    var y = c.y + br * .7 * (1 - c.sit), headRot = c.head + br * .7;  // seated, the card holds the body still and only the head breathes
    e.bodyg.setAttribute('transform', 'translate(' + f(c.x) + ' ' + f(y) + ') rotate(' + f(c.rot) + ' ' + PIVOT[0] + ' ' + PIVOT[1] + ')');
    e.headg.setAttribute('transform', 'rotate(' + f(headRot) + ' ' + NECK[0] + ' ' + NECK[1] + ')');

    // hips move with the body; ankles stay in world space so feet stay planted
    var r = c.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    function world(p) { var x = p[0] - PIVOT[0], z = p[1] - PIVOT[1]; return [PIVOT[0] + x * cs - z * sn + c.x, PIVOT[1] + x * sn + z * cs + y]; }
    // the feet take turns coming forward: up, a little out, and a little bigger
    var lf = [c.lfx - sw * 1.5, c.lfy - sw * FEEL.swing], rf = [c.rfx - sw * 1.5, c.rfy + sw * FEEL.swing];
    var lleg = limb(world(HIP_L), lf, LEG, c.llb, this.tube), rleg = limb(world(HIP_R), rf, LEG, -c.rlb, this.tube);
    setD(e.ll, lleg.d); setD(e.rl, rleg.d);
    var lg = rings(lleg, LEG_RINGS), rg = rings(rleg, LEG_RINGS);
    at(e.lknee, lleg.j); at(e.rknee, rleg.j);
    e.llb.setAttribute('d', lg.bump); e.lll.setAttribute('d', lg.line);
    e.rlb.setAttribute('d', rg.bump); e.rll.setAttribute('d', rg.line);
    e.lfoot.setAttribute('transform', 'translate(' + f(lf[0]) + ' ' + f(lf[1]) + ') rotate(' + f(c.lfr - sw * 7) + ') scale(' + f(1 + sw * .1) + ')');
    e.rfoot.setAttribute('transform', 'translate(' + f(rf[0]) + ' ' + f(rf[1]) + ') rotate(' + f(c.rfr - sw * 7) + ') scale(' + f(1 - sw * .1) + ')');
    var air = Math.max(0, Math.min(1, (204 - (c.lfy + c.rfy) / 2) / 16));
    e.shadow.setAttribute('rx', f(34 - air * 10));
    e.shadow.style.opacity = f(.12 * (1 - c.sit));

    // arms are in body space, so a hand on the hip stays on the hip when Fuzz leans
    var lh = hand(c, 'l'), rh = hand(c, 'r');
    var la = limb(SH_L, lh, c.lL, pole(SH_L, lh, POLE_L), this.tube), ra = limb(SH_R, rh, c.rL, pole(SH_R, rh, POLE_R), this.tube);
    setD(e.la, la.d); setD(e.ra, ra.d);
    var lr = rings(la, RINGS), rrg = rings(ra, RINGS);
    at(e.lelbow, la.j); at(e.relbow, ra.j);
    e.lab.setAttribute('d', lr.bump); e.lal.setAttribute('d', lr.line);
    e.rab.setAttribute('d', rrg.bump); e.ral.setAttribute('d', rrg.line);
    this.hand('l', e.lhand, lh, la.ang, c.lrot, c.lw, c.lgap);
    var rang = this.hand('r', e.rhand, rh, ra.ang, c.rrot, c.rw, c.rgap, c.tf);
    this.tape(rh, rang);
    this.paper(lh, rh, rang);
    this.look();
  };
  /* The wrist follows the arm until a pose gives it its own angle; lw and rw blend between the two. */
  Rig.prototype.hand = function (side, g, p, armAng, rot, w, gap, twist) {
    var a = armAng + (((rot - armAng + 540) % 360) - 180) * w;
    g.lastChild.setAttribute('d', clawPath(gap));
    if (twist != null) g.lastChild.setAttribute('transform', 'scale(1 ' + f((twist < 0 ? -1 : 1) * Math.max(.22, Math.abs(twist))) + ')');  // a claw seen edge-on still has some width
    g.setAttribute('transform', 'translate(' + f(p[0]) + ' ' + f(p[1]) + ') rotate(' + f(a) + ')' + (side === 'l' ? ' scale(1 -1)' : ''));
    return a;
  };
  /* In the slot the tape is seen end-on, so it starts squashed and opens out as it comes to the claw. */
  Rig.prototype.tape = function (p, a) {
    var c = this.p, g = this.el.vhs, on = c.tp > .005, r = a * Math.PI / 180;
    g.style.display = on ? 'inline' : 'none';
    if (!on) return;
    var x = 100 + (p[0] + Math.cos(r) * GRIP - 100) * c.th, y = 132.5 + (p[1] + Math.sin(r) * GRIP - 132.5) * c.th;
    var size = .86 + .14 * c.th, sy = c.tp + (1 - c.tp) * c.th, side = Math.sqrt(Math.max(0, 1 - c.tf * c.tf));
    this.el.vfront.style.display = c.tf < 0 ? 'none' : 'inline';
    this.el.vback.style.display = c.tf < 0 ? 'inline' : 'none';
    // turning a box: the face narrows and slides one way while the spine widens across the middle
    this.el.vface.style.display = Math.abs(c.tf) < .02 ? 'none' : 'inline';
    this.el.vside.style.display = side < .02 ? 'none' : 'inline';
    this.el.vface.setAttribute('transform', 'translate(' + f((c.tf < 0 ? 1 : -1) * SPINE / 2 * side) + ' 0) scale(' + f(Math.abs(c.tf)) + ' 1)');
    this.el.vside.setAttribute('transform', 'translate(' + f(c.tf * 17) + ' 0) scale(' + f(side) + ' 1)');
    g.setAttribute('transform', 'translate(' + f(x) + ' ' + f(y) + ') rotate(' + f(c.tr * c.th) + ') scale(' + f(size) + ' ' + f(size * sy) + ')');
  };
  /* The sheets from back to front, after however many have gone from the front to the back. */
  Rig.prototype.stack = function () {
    var n = Math.ceil(this.pz / 2) % 3;
    return [0, 1, 2].map(function (i) { return (i - n + 3) % 3; });
  };
  /* The stack sits on the left claw, or out past the right one once it has them all to itself. */
  Rig.prototype.paper = function (l, p, a) {
    var c = this.p, g = this.el.paper, on = c.pp > .5, r = a * Math.PI / 180, i;
    g.style.display = on ? 'inline' : 'none';
    if (!on) return;
    var cx = l[0] + SHEETHOLD, cy = l[1], order = this.stack(), lifted = order[this.pz % 2 ? 0 : 2];
    g.setAttribute('transform', 'translate(' + f(cx + (p[0] + Math.cos(r) * SHEETGRIP - cx) * c.pg) + ' ' + f(cy + (p[1] + Math.sin(r) * SHEETGRIP - cy) * c.pg) + ') rotate(' + f(c.pg * 10) + ')');
    for (i = 0; i < 3; i++) {
      var side = i - 1, x = side * 1.3, y = Math.abs(side) * .8, t = side * 2;
      if (order[i] === lifted) { x += (p[0] - SHEETHOLD - cx - x) * c.pm; y += (p[1] - cy - y) * c.pm; t += c.pm * 8; }
      this.el.sheets[order[i]].setAttribute('transform', 'translate(' + f(x) + ' ' + f(y) + ') rotate(' + f(t) + ')');
    }
  };
  /* The bored mood's eyes wander on a CSS animation, so aiming them means switching that off. */
  Rig.prototype.look = function () {
    var c = this.p, s = this.el.eyes.style;
    if (Math.abs(c.ex) + Math.abs(c.ey) < .02) { if (s.animation) { s.animation = ''; s.transform = ''; } return; }
    s.animation = 'none';
    s.transform = 'translate(' + f(c.ex) + 'px,' + f(c.ey) + 'px)';
  };

  var rigs = [];
  window.FuzzJoints = {
    reactions: R,
    transitions: { sitDown: SIT_DOWN, getUp: GET_UP, takeOut: TAKE_OUT, putAway: PUT_AWAY },
    feel: FEEL, groups: GROUPS, stand: STAND, gaps: GAP,
    rig: function (host, opts) { var r = new Rig(host, opts); rigs.push(r); return r; },
    all: function () { return rigs; },
    setSpeed: function (s) { A.engine.speed = s; }
  };
})();
