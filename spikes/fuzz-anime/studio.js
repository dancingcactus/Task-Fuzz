/* The studio: edits the reaction data in spikes/fuzz-joints/fuzz-joints.js while it runs. A reaction is plain data, so an edit
   changes the object in place and the next play picks it up. Nothing here writes to the source file: edits
   live in localStorage, and Copy changes lists them for pasting into the code. */
(function () {
  'use strict';
  var FA = window.FuzzJoints, A = window.anime, R = FA.reactions, FEEL = FA.feel, GROUPS = FA.groups;
  var KEY = 'fuzz-studio-v1', FRAME = 1000 / 60;
  var T = {
    sitDown: { label: 'Sit down', list: FA.transitions.sitDown, code: 'SIT_DOWN', from: 'idle', target: 'sleepy', mood: 'idle', when: 'whenever Fuzz has to get onto the card.' },
    getUp: { label: 'Get up', list: FA.transitions.getUp, code: 'GET_UP', from: 'sleepy', target: 'idle', when: 'whenever Fuzz has to get off the edge of the card.' },
    takeOut: { label: 'Take out papers', list: FA.transitions.takeOut, code: 'TAKE_OUT', from: 'idle', target: 'working', when: 'whenever Fuzz needs the papers in hand.' },
    putAway: { label: 'Put papers away', list: FA.transitions.putAway, code: 'PUT_AWAY', from: 'working', target: 'idle', when: 'whenever Fuzz leaves the papers for anything else.' }
  };
  var MOODS = ['idle', 'happy', 'eager', 'proud', 'grateful', 'caring', 'thinking', 'puzzled', 'working', 'rushed', 'worried', 'sheepish', 'stare', 'bored', 'sleepy', 'chill', 'boop'];
  var EASES = ['linear', 'inOutSine', 'in(2)', 'in(2.4)', 'out(2)', 'out(3)', 'inOut(2)', 'inOut(3)', 'outBack(1.2)', 'outBack(1.6)', 'outBack(2)', 'outElastic(1,.45)'];
  var CHOICE = { mood: MOODS, lhand: ['open', 'fist', 'point', 'shut'], rhand: ['open', 'fist', 'point', 'shut'], llay: ['afront', 'aback', 'aunder'], rlay: ['afront', 'aback', 'aunder'], pl: ['front', 'back'] };
  var FIELDS = [
    ['Body', { y: 'Body y', x: 'Hips x', rot: 'Lean', head: 'Head tilt', br: 'Breath', sit: 'Seated' }],
    ['Arms', { lh: 'L hand', rh: 'R hand', lL: 'L arm length', rL: 'R arm length', lst: 'L straight path', rst: 'R straight path', lrot: 'L wrist', rrot: 'R wrist', lgap: 'L claw gap', rgap: 'R claw gap', lhand: 'L claw', rhand: 'R claw', llay: 'L arm layer', rlay: 'R arm layer' }],
    ['Legs', { lf: 'L foot', rf: 'R foot', llb: 'L knee', rlb: 'R knee', lfr: 'L foot tilt', rfr: 'R foot tilt', dg: 'Leg swing' }],
    ['Face', { mood: 'Mood', urgency: 'Urgency', cool: 'Shades', ex: 'Eyes x', ey: 'Eyes y' }],
    ['Tape', { tp: 'Tape out', th: 'Tape to claw', tr: 'Tape tilt', tf: 'Tape turn' }],
    ['Papers', { pp: 'Papers out', pg: 'Papers in R claw', pm: 'Sheet in R claw', pz: 'Sheet order', pl: 'Papers layer' }]
  ];
  var LABEL = {}; FIELDS.forEach(function (g) { for (var k in g[1]) LABEL[k] = g[1][k]; });
  var FALLBACK = { lL: 50, rL: 50, llb: .75, rlb: .75, br: 1, lgap: FA.gaps.open, rgap: FA.gaps.open, mood: 'idle', lhand: 'open', rhand: 'open', llay: 'afront', rlay: 'afront', cool: true, tf: 1, pl: 'front' };
  var FEEL0 = copy(FEEL), LEADS0 = GROUPS.map(function (g) { return g.start; });

  function $(id) { return document.getElementById(id); }
  function h(tag, props, kids) {
    var el = document.createElement(tag), k;
    for (k in props || {}) { if (k === 'class') el.className = props[k]; else if (k === 'text') el.textContent = props[k]; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]); else el.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function copy(o) { var c = {}, k; for (k in o) c[k] = o[k]; return c; }

  /* ---------- Edits: what the source says, what changed, and keeping that across reloads ---------- */
  var fns = {}, base = {}, notes = {};
  function ser(v) { return JSON.stringify(v, function (k, x) { if (typeof x === 'function') { fns[x.name] = x; return '@' + x.name; } return x; }); }
  function revive(list) { list.forEach(function (b) { if (typeof b.fx === 'string') b.fx = fns[b.fx.slice(1)]; }); return list; }
  function replace(arr, list) { arr.length = 0; list.forEach(function (b) { arr.push(b); }); }
  function shape(id) { if (T[id]) return ser(T[id].list); var r = R[id]; return ser({ say: r.say, s: r.s, enter: r.enter, loop: r.loop }); }
  function restore(id, json) {
    var v = JSON.parse(json);
    if (T[id]) return replace(T[id].list, revive(v));
    var r = R[id]; r.say = v.say; r.s = v.s;
    ['enter', 'loop'].forEach(function (k) { if (r[k]) replace(r[k], revive(v[k])); });
  }
  function ids() { return Object.keys(R).concat(Object.keys(T)); }
  function changed(id) { return shape(id) !== base[id]; }
  function feelChanged() { return JSON.stringify(FEEL) !== JSON.stringify(FEEL0) || GROUPS.some(function (g, i) { return g.start !== LEADS0[i]; }); }

  function save() {
    var o = { data: {}, notes: notes, feel: FEEL, leads: GROUPS.map(function (g) { return g.start; }) };
    ids().forEach(function (id) { if (changed(id)) o.data[id] = shape(id); });
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* edits just won't survive a reload */ }
  }
  function load() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* start clean */ }
    if (!o) return;
    for (var id in o.data) if (R[id] || T[id]) restore(id, o.data[id]);
    notes = o.notes || {};
    for (var k in o.feel) FEEL[k] = o.feel[k];
    (o.leads || []).forEach(function (v, i) { if (GROUPS[i]) GROUPS[i].start = v; });
  }

  function lit(v) {
    if (Array.isArray(v)) return '[' + v.map(lit).join(', ') + ']';
    if (typeof v === 'function') return v.name;
    if (v && typeof v === 'object') return '{ ' + Object.keys(v).map(function (k) { return k + ': ' + lit(v[k]); }).join(', ') + ' }';
    return typeof v === 'string' ? "'" + v.replace(/'/g, "\\'") + "'" : String(v);
  }
  function listDiff(out, path, now, was) {
    if (now.length !== was.length) { out.push(path + ' = ['); now.forEach(function (b) { out.push('  ' + lit(b) + ','); }); out.push('];'); return; }
    now.forEach(function (b, i) { if (ser(b) !== ser(was[i])) out.push(path + '[' + i + '] = ' + lit(b) + ';'); });
  }
  function report() {
    var out = [];
    ids().forEach(function (id) {
      var note = notes[id], is = changed(id);
      if (!is && !note) return;
      out.push('// ' + (T[id] ? T[id].label : R[id].label) + (note ? ': ' + note : ''));
      if (!is) return;
      if (T[id]) listDiff(out, T[id].code, T[id].list, revive(JSON.parse(base[id])));
      else {
        var was = JSON.parse(base[id]), r = R[id], p = 'R.' + id;
        if (r.say !== was.say) out.push(p + '.say = ' + lit(r.say) + ';');
        if (ser(r.s) !== ser(was.s)) out.push(p + '.s = ' + lit(r.s) + ';');
        ['enter', 'loop'].forEach(function (k) { if (r[k]) listDiff(out, p + '.' + k, r[k], revive(was[k])); });
      }
      out.push('');
    });
    if (feelChanged()) {
      out.push('// Feel');
      for (var k in FEEL) if (FEEL[k] !== FEEL0[k]) out.push('FEEL.' + k + ' = ' + lit(FEEL[k]) + ';');
      GROUPS.forEach(function (g, i) { if (g.start !== LEADS0[i]) out.push('GROUPS[' + i + '].start = ' + g.start + ';'); });
    }
    return out.join('\n').trim();
  }

  /* ---------- Playback ---------- */
  var edit = 'idle', target = 'idle', held = null, paused = false, speed = 1, timers = [], rows = new Map(), segs = new Map();
  var main = FA.rig($('main'), { onPlay: function (n, r) { $('say').textContent = r.say; }, onBeat: mark });
  var mini = FA.rig($('mini'));
  function both(fn) { fn(main); fn(mini); }
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function say(msg) { $('status').textContent = msg || ''; }

  function stanceOf() { return T[edit] ? { mood: T[edit].mood || (R[target].s || {}).mood } : R[edit].s; }
  function run() {
    var from = $('from').value;
    clearTimers(); held = null; paused = false; marks(); say('');
    if (!from) return start();
    both(function (r) { r.snap(from); });
    later(start, 450 / speed);
  }
  function start() {
    both(function (r) { r.play(target); });
    if (!$('repeat').checked) return;
    var loop = (R[target].loop || []).reduce(function (n, b) { return n + b.d + (b.hold || 0); }, 0);
    later(again, (main.tl.duration + (T[edit] ? 0 : Math.min(loop, 5000)) + 800) / speed);  // a transition repeats as soon as it lands
  }
  function again() { if (paused || held) later(again, 300); else run(); }
  function replaySoon() { clearTimers(); later(run, 500); }

  function holdBeat(b) {
    clearTimers(); held = b; paused = false;
    both(function (r) { r.pose(stanceOf(), b); });
    marks(); say('Frozen on this beat. Play or Replay lets go.');
  }
  function holdRest() {
    if (T[edit] || R[edit].once) return replaySoon();
    clearTimers(); held = 'rest'; paused = false;
    both(function (r) { r.snap(edit); });
    marks(); say('Frozen on the resting pose. Play or Replay lets go.');
  }
  function setPaused(on) {
    paused = on;
    both(function (r) { if (r.tl) { if (on) r.tl.pause(); else r.tl.resume(); } });
  }
  function seek(ms) { both(function (r) { if (r.tl) r.tl.seek(ms); }); }
  function pos(tl) { return tl.iterationCurrentTime; }
  function step(n) {
    if (held || !main.tl) return;
    setPaused(true);
    seek(Math.max(0, Math.min(main.tl.iterationDuration, pos(main.tl) + n * FRAME)));
  }
  function togglePlay() {
    if (held || !main.tl || main.tl.completed) run(); else setPaused(!paused);
  }

  function mark(b) {
    rows.forEach(function (el, k) { el.classList.toggle('now', k === b); });
    segs.forEach(function (el, k) { el.classList.toggle('now', k === b); });
  }
  function marks() {
    rows.forEach(function (el, k) { el.classList.toggle('held', k === held); });
    segs.forEach(function (el, k) { el.classList.toggle('held', k === held); });
  }
  (function tick() {
    var tl = main.tl, s = $('scrub');
    $('play').textContent = held || !tl || paused ? 'Play' : 'Pause';
    if (paused && tl && !tl.paused) setPaused(true);  // an entrance can finish under a seek and hand over to the loop
    if (tl && document.activeElement !== s) s.value = Math.round(pos(tl) / tl.iterationDuration * 1000) || 0;
    $('time').textContent = tl ? (tl.iterationCount === Infinity ? 'loop ' : 'in ') + Math.round(pos(tl)) + ' / ' + Math.round(tl.iterationDuration) + ' ms' : held ? 'frozen' : 'starting';
    requestAnimationFrame(tick);
  })();

  /* ---------- Editors ---------- */
  function touch() { save(); renderPicker(); $('out').value = report(); }
  function num(v) { return v === '' || v === null ? null : parseFloat(v); }
  function input(cls, value, oninput, extra) {
    var o = { class: cls, value: value == null ? '' : value, oninput: oninput };
    for (var k in extra || {}) o[k] = extra[k];
    return h('input', o);
  }
  /* The pose fields of a stance or a beat. focus runs when a field is entered, edit after each change. */
  function fields(obj, ctx) {
    var box = h('div', { class: 'fields', onfocusin: ctx.focus });
    function chip(k) {
      var v = obj[k], kids = [h('span', { text: LABEL[k] })];
      function set(x) { obj[k] = x; ctx.edit(); }
      if (Array.isArray(v)) v.forEach(function (n, i) {
        kids.push(input('n', n, function (e) { if (e.target.value !== '') { obj[k][i] = parseFloat(e.target.value); ctx.edit(); } }, { type: 'number', step: 1, 'aria-label': LABEL[k] + (i ? ' y' : ' x') }));
      });
      else if (CHOICE[k]) kids.push(h('select', { 'aria-label': LABEL[k], onchange: function (e) { set(e.target.value); } }, CHOICE[k].map(function (c) {
        var o = h('option', { text: c, value: c }); o.selected = c === v; return o;
      })));
      else if (k === 'cool') kids.push(input('', '', function (e) { set(e.target.checked); }, { type: 'checkbox', 'aria-label': LABEL[k] }));
      else kids.push(input('n', v, function (e) {
        var x = num(e.target.value);
        if (x !== null || k === 'lrot' || k === 'rrot') set(x);  // an empty wrist goes back to following the arm
      }, { type: 'number', step: Math.abs(v) < 3 ? .1 : 1, 'aria-label': LABEL[k] }));
      if (k === 'cool') kids[1].checked = !!v;
      kids.push(h('button', { class: 'x', type: 'button', text: '×', 'aria-label': 'Remove ' + LABEL[k], onclick: function () { delete obj[k]; ctx.edit(); draw(); } }));
      return h('span', { class: 'f', title: k }, kids);
    }
    function draw() {
      box.textContent = '';
      FIELDS.forEach(function (g) { for (var k in g[1]) if (k in obj) box.appendChild(chip(k)); });
      var add = h('select', { class: 'add', 'aria-label': 'Add a field', onchange: function (e) {
        var k = e.target.value; if (!k) return;
        var s = stanceOf() || {};
        obj[k] = s[k] != null ? (Array.isArray(s[k]) ? s[k].slice() : s[k]) : FA.stand[k] ? FA.stand[k].slice() : FALLBACK[k] != null ? FALLBACK[k] : 0;
        ctx.edit(); draw();
      } }, [h('option', { text: '+ field', value: '' })]);
      FIELDS.forEach(function (g) {
        var og = h('optgroup', { label: g[0] }), any = false;
        for (var k in g[1]) if (!(k in obj)) { og.appendChild(h('option', { text: g[1][k], value: k })); any = true; }
        if (any) add.appendChild(og);
      });
      box.appendChild(add);
    }
    draw();
    return box;
  }

  function timing() { touch(); held = null; marks(); replaySoon(); }
  function beatRow(list, i, b) {
    var ctx = { focus: function () { if (held !== b) holdBeat(b); }, edit: function () { touch(); holdBeat(b); } };
    function move(by) {
      var j = i + by; if (j < 0 || j >= list.length) return;
      list[i] = list[j]; list[j] = b; touch(); renderBeats(); replaySoon();
    }
    function t(k, cls, extra) {
      return input(cls, b[k], function (e) {
        if (e.target.value === '' && k !== 'd') delete b[k];
        else b[k] = cls === 'n' ? parseFloat(e.target.value) : e.target.value;
        timing();
      }, extra);
    }
    var tight = input('', '', function (e) { if (e.target.checked) b.tight = 1; else delete b.tight; timing(); }, { type: 'checkbox' });
    tight.checked = !!b.tight;
    var row = h('div', { class: 'beat' }, [
      h('div', { class: 'bhead' }, [
        h('b', { text: String(i + 1) }),
        h('label', { title: 'How long it takes to get here, in ms' }, [document.createTextNode('Move'), t('d', 'n', { type: 'number', step: 10, min: 1 })]),
        h('label', { title: 'How long to stay here, in ms' }, [document.createTextNode('Hold'), t('hold', 'n', { type: 'number', step: 10, min: 0 })]),
        h('label', { title: 'How the body gets here' }, [document.createTextNode('Ease'), t('ease', 'e', { list: 'eases' })]),
        h('label', { title: 'Arms only, if different from the body' }, [document.createTextNode('Arms'), t('aease', 'e', { list: 'eases' })]),
        h('label', { title: 'Everything moves at once, with no overlap' }, [tight, document.createTextNode('Tight')]),
        h('span', { class: 'acts' }, [
          h('button', { type: 'button', text: 'Freeze', onclick: function () { holdBeat(b); } }),
          h('button', { type: 'button', text: '↑', 'aria-label': 'Move beat up', onclick: function () { move(-1); } }),
          h('button', { type: 'button', text: '↓', 'aria-label': 'Move beat down', onclick: function () { move(1); } }),
          h('button', { type: 'button', text: 'Copy', onclick: function () { list.splice(i + 1, 0, JSON.parse(JSON.stringify(b))); touch(); renderBeats(); } }),
          h('button', { type: 'button', text: 'Delete', onclick: function () {
            if (list.length === 1) return say('A reaction needs at least one beat.');
            list.splice(i, 1); if (held === b) held = null; touch(); renderBeats(); replaySoon();
          } })
        ])
      ]),
      fields(b, ctx)
    ]);
    rows.set(b, row);
    return row;
  }
  function renderBeats() {
    var box = $('beats'), strip = $('strip'), lists;
    box.textContent = ''; strip.textContent = ''; rows.clear(); segs.clear();
    lists = T[edit] ? [['Beats', T[edit].list]] : [['Entrance', R[edit].enter], ['Loop', R[edit].loop]];
    lists.forEach(function (l) {
      if (!l[1]) return;
      var loop = l[0] === 'Loop', panel = h('div', { class: 'panel', style: 'margin-bottom:12px' }, [h('h2', { text: l[0] })]);
      if (loop) panel.appendChild(h('p', { class: 'hint', text: 'Fuzz moves to beat 1 after the entrance, then goes round.' }));
      l[1].forEach(function (b, i) {
        panel.appendChild(beatRow(l[1], i, b));
        var d = b.d || 1, hd = b.hold || 0, seg = h('button', { class: 'bseg' + (loop ? ' loop' : ''), type: 'button', title: l[0] + ' ' + (i + 1) + ': ' + d + ' ms' + (hd ? ', hold ' + hd : ''), style: 'flex:' + (d + hd) + ' 1 0', onclick: function () { holdBeat(b); } }, [
          h('i', { class: 'mv', style: 'flex:' + d }), hd ? h('i', { class: 'hd', style: 'flex:' + hd }) : null
        ]);
        strip.appendChild(seg); segs.set(b, seg);
      });
      box.appendChild(panel);
    });
    marks();
  }
  function renderStance() {
    var box = $('stance'); box.textContent = '';
    var note = input('text', notes[edit] || '', function (e) {
      if (e.target.value) notes[edit] = e.target.value; else delete notes[edit];
      touch();
    }, { placeholder: 'Notes for later, such as “the arm feels late”. These go out with Copy changes.', 'aria-label': 'Notes' });
    if (T[edit]) {
      box.appendChild(h('p', { class: 'hint', text: 'Plays before ' + R[T[edit].target].label + ' ' + T[edit].when }));
      box.appendChild(note);
      return;
    }
    var r = R[edit];
    box.appendChild(h('h2', { text: 'Stance' }));
    box.appendChild(h('p', { class: 'hint', text: 'Every beat starts from this pose. A beat only lists what it changes.' }));
    box.appendChild(input('text', r.say, function (e) { r.say = e.target.value; $('say').textContent = r.say; touch(); }, { 'aria-label': 'What Fuzz says' }));
    box.appendChild(note);
    box.appendChild(fields(r.s, { focus: holdRest, edit: function () { touch(); holdRest(); } }));
  }

  function renderPicker() {
    function item(id, label) {
      return h('button', { type: 'button', 'aria-pressed': String(id === edit), onclick: function () { select(id); } }, [h('span', { text: label }), changed(id) || notes[id] ? h('span', { class: 'dot', title: 'Changed' }) : null]);
    }
    var a = $('reactions'), b = $('transitions');
    a.textContent = ''; b.textContent = '';
    Object.keys(R).forEach(function (k) { a.appendChild(item(k, R[k].label)); });
    Object.keys(T).forEach(function (k) { b.appendChild(item(k, T[k].label)); });
  }
  function select(id) {
    var was = edit; edit = id;
    if (T[id]) { target = T[id].target; $('from').value = T[id].from; }
    else { target = id; if (T[was]) $('from').value = 'idle'; }
    $('title').textContent = T[id] ? T[id].label : R[id].label;
    $('say').textContent = R[target].say;
    renderPicker(); renderStance(); renderBeats(); renderMoods(); run();
  }

  /* ---------- Emotions ---------- */
  var thumbs = {};
  function buildMoods() {
    MOODS.forEach(function (m) {
      var host = h('div', { class: 'thumb' });
      var btn = h('button', { class: 'emo', type: 'button', onclick: function () { useMood(m); } }, [host, document.createTextNode(m)]);
      $('moods').appendChild(btn); thumbs[m] = btn;
      var rig = FA.rig(host, { body: false });
      rig.stop(); rig.flip({ mood: m, urgency: m === 'rushed' ? 2 : 0 }, {});
    });
  }
  function renderMoods() {
    var on = held && held !== 'rest' && held.mood ? held.mood : (stanceOf() || {}).mood || 'idle';
    MOODS.forEach(function (m) { thumbs[m].setAttribute('aria-pressed', String(m === on)); });
  }
  function useMood(m) {
    if (held && held !== 'rest') { held.mood = m; touch(); holdBeat(held); }
    else if (T[edit]) return say('Freeze a beat first. A transition has no mood of its own.');
    else { R[edit].s.mood = m; touch(); renderStance(); holdRest(); }
    renderBeats(); renderMoods();
  }

  /* ---------- Feel ---------- */
  function buildFeel() {
    var box = $('feel'), names = ['Hips and feet', 'Arms', 'Head', 'Claws'];
    function changeFeel() { touch(); replaySoon(); }
    GROUPS.forEach(function (g, i) {
      box.appendChild(h('label', {}, [document.createTextNode(names[i] + ' lead'), input('n', g.start, function (e) { var v = num(e.target.value); if (v !== null) { g.start = v; changeFeel(); } }, { type: 'number', step: .02, min: 0, max: .9 })]));
    });
    box.appendChild(h('label', { title: 'The shortest time Fuzz takes to leave one reaction for the next' }, [document.createTextNode('Arrive, ms'), input('n', FEEL.arriveMin, function (e) { var v = num(e.target.value); if (v !== null) { FEEL.arriveMin = v; changeFeel(); } }, { type: 'number', step: 10, min: 0 })]));
    box.appendChild(h('label', {}, [document.createTextNode('Arrive ease'), input('e', FEEL.arriveEase, function (e) { FEEL.arriveEase = e.target.value; changeFeel(); }, { list: 'eases' })]));
    box.appendChild(h('label', { title: 'How far the feet travel when Fuzz dangles its legs' }, [document.createTextNode('Leg swing'), input('n', FEEL.swing, function (e) { var v = num(e.target.value); if (v !== null) { FEEL.swing = v; touch(); } }, { type: 'number', step: .5, min: 0 })]));
  }

  /* ---------- Setup ---------- */
  ids().forEach(function (id) {
    if (R[id]) R[id].s = R[id].s || {};
    base[id] = shape(id);
  });
  load();

  [].concat.apply(EASES, ids().map(function (id) { return shape(id).match(/(?:in|out|inOut|outBack|outElastic)\([^)"]*\)/g) || []; }))
    .filter(function (e, i, a) { return a.indexOf(e) === i; })
    .forEach(function (e) { $('eases').appendChild(h('option', { value: e })); });

  var fromSel = $('from');
  fromSel.appendChild(h('option', { value: '', text: 'Wherever Fuzz is' }));
  Object.keys(R).forEach(function (k) { if (!R[k].once) fromSel.appendChild(h('option', { value: k, text: R[k].label })); });
  fromSel.value = 'idle';
  fromSel.addEventListener('change', run);

  [1, .5, .25, .1].forEach(function (s) {
    var b = h('button', { type: 'button', text: (s * 100) + '%', 'aria-pressed': String(s === 1), onclick: function () {
      speed = s; A.engine.speed = s;
      [].forEach.call($('speeds').children, function (c) { c.setAttribute('aria-pressed', String(c === b)); });
    } });
    $('speeds').appendChild(b);
  });

  $('play').addEventListener('click', togglePlay);
  $('replay').addEventListener('click', run);
  $('back').addEventListener('click', function () { step(-1); });
  $('fwd').addEventListener('click', function () { step(1); });
  $('scrub').addEventListener('input', function (e) {
    if (held || !main.tl) return;
    setPaused(true);
    seek(e.target.value / 1000 * main.tl.iterationDuration);
  });
  $('repeat').addEventListener('change', function (e) { if (e.target.checked) run(); else clearTimers(); });
  $('calm').addEventListener('change', function (e) { document.documentElement.classList.toggle('calm', e.target.checked); run(); });
  $('reset').addEventListener('click', function () {
    restore(edit, base[edit]); if (!T[edit]) R[edit].s = R[edit].s || {};
    delete notes[edit]; held = null; touch(); select(edit);
  });
  $('resetall').addEventListener('click', function () {
    ids().forEach(function (id) { restore(id, base[id]); });
    for (var k in FEEL0) FEEL[k] = FEEL0[k];
    GROUPS.forEach(function (g, i) { g.start = LEADS0[i]; });
    notes = {}; $('feel').textContent = ''; buildFeel();
    held = null; touch(); select(edit);
  });
  $('copy').addEventListener('click', function () {
    var text = $('out').value;
    if (!text) return say('Nothing has changed yet.');
    function done() { say('Copied.'); }
    function manual() { $('out').select(); say('Press Cmd+C to copy.'); }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, manual); else manual();
  });
  document.addEventListener('keydown', function (e) {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'r') run();
  });

  buildMoods(); buildFeel();
  select('idle');
  $('out').value = report();
  window.FuzzStudio = { report: report, get held() { return held; } };
})();
