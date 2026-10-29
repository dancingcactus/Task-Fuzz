/* New task. Capture costs nothing (principle 8): type or dictate, no categories, triage happens later.
   Layout comes from the Triage Queue mockup's Capture board. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root, unsub = null, timer = 0, listenTimer = 0, moodTimer = 0, boredTimer = 0, listening = false, attached = [], confirm = '', draft = '', escKey = null;
  var IDLE_LINE = 'Get it out of your head. I’ll sort it later.';

  function statusFor(c) {
    var it = c.ref ? Store.item(c.ref) : null;
    if (!it) return { text: c.status || 'Waiting in triage', tone: c.tone || 'muted' };
    var map = {
      triage: it.capturedAt && Date.now() - it.capturedAt < 6000 ? ['Fuzz is gathering context', 'accent'] : ['Waiting in triage', 'muted'],
      ai: ['Fuzz is working on it', 'accent'], 'ai-queued': ['Next up with Fuzz', 'muted'], review: ['Draft ready for your OK', 'warn'], mine: ['With you', 'muted'], session: ['Open in Claude', 'muted'],
      scheduled: ['Scheduled', 'muted'], parked: ['Parked', 'muted'], waiting: ['Waiting on others', 'warn'], done: ['Done', 'ok'], letgo: ['Let go', 'muted'], dropped: ['Dropped', 'muted'], resolved: ['Done', 'ok']
    };
    var m = it.gathering ? ['Fuzz is gathering context', 'accent'] : map[it.state] || ['Waiting in triage', 'muted'];
    if (c.doc && it.state === 'triage') m = ['Added to triage with the document', 'ok'];
    return { text: m[0], tone: m[1] };
  }

  function listHTML() {
    return Store.get().captured.map(function (c) {
      var s = statusFor(c);
      return '<li class="cap-item"><span class="cap-text">' + (c.doc ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>' : '') + esc(c.text) + '</span>' +
        '<span class="cap-meta">' + UI.pill(s.text, s.tone) + '<span>' + esc(c.time) + '</span></span></li>';
    }).join('');
  }
  function attachedHTML() {
    return attached.map(function (f, i) {
      var n = f.name;
      return '<li class="file"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg><span>' + esc(n) + '</span>' +
        '<button type="button" class="iconbtn" data-rm="' + i + '" aria-label="Remove ' + esc(n) + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>';
    }).join('');
  }

  V.mount = function (container) {
    root = container; listening = false; confirm = '';
    /* Same shape as Triage: the full Fuzz on a perch with his speech bubble, then one card.
       He's for looking at; the capture confirmation reaches screen readers through Say.announce. */
    root.innerHTML = '<section class="capture" aria-labelledby="cap-h"><div class="stage cap-stage" id="stage">' +
      '<div class="fx" id="fx"></div>' +
      '<div class="perch" id="perch"><div class="pwrap" id="pwrap" aria-hidden="true">' + window.FUZZ_SVG + '</div><div class="bubble" id="bubble"></div></div>' +
      '<div class="card cap-card">' +
        '<h1 id="cap-h" class="cap-title">What is on your mind?</h1>' +
        '<div class="drop" id="drop"><button type="button" class="dropbtn" id="dropbtn"><span class="dropicon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></span>' +
          '<span class="droptxt"><b>Drop a document to add context</b><small>Optional. Fuzz reads it along with your task. With Fuzz running, it keeps a copy on this computer.</small></span><span class="droplink">Choose files</span></button>' +
          '<input type="file" id="file" multiple hidden></div>' +
        '<ul class="files" id="files" aria-label="Attached documents"></ul>' +
        '<div class="field"><label for="cap-text">New task</label><textarea id="cap-text" rows="4" placeholder="For example: send Sam the slides from Tuesday"></textarea></div>' +
        '<div class="actions cap-actions"><button type="button" class="btn primary" id="cap-go" disabled><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Capture</button>' +
          '<button type="button" class="btn dictate" id="cap-mic" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span id="mic-l">Dictate</span></button>' +
          '<span class="hint">Ctrl or Cmd + Enter to capture · Esc to go back</span></div>' +
      '</div></div>' +
      '<section class="recent"><h2>Captured recently</h2><ul class="cap-list" id="cap-list"></ul>' +
        '<p class="fine">Tasks from email, Slack and meetings arrive in triage on their own, so you only need to capture the ones that start in your head.</p></section></section>';
    var $ = function (s) { return root.querySelector(s); };
    var ta = $('#cap-text'), go = $('#cap-go');
    function sync() { go.disabled = ta.value.trim() === '' && attached.length === 0; }
    function paintFiles() { $('#files').innerHTML = attachedHTML(); sync(); }
    function paintList() { $('#cap-list').innerHTML = listHTML(); }
    /* What you've typed survives leaving the page, so Esc never costs you a half-written thought. */
    ta.value = draft;
    ta.addEventListener('input', function () { draft = ta.value; sync(); nudge(); if (confirm) { confirm = ''; paintSay(); } });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    function paintSay() { Fuzz.say(confirm || IDLE_LINE, { type: false }); }
    /* Mood for a moment, then back to idle (unless something else has changed it since). */
    function moodFor(m, ms) {
      clearTimeout(moodTimer); Fuzz.setMood(m);
      moodTimer = setTimeout(function () { if (Fuzz.mood() === m) Fuzz.setMood('idle'); }, ms);
    }
    /* Left alone with an empty field, he goes back to surfing channels. Any activity wakes him. */
    function nudge() {
      clearTimeout(boredTimer);
      if (Fuzz.mood() === 'bored') { Fuzz.setMood('idle'); paintSay(); }
      boredTimer = setTimeout(function () { if (Fuzz.mood() === 'idle' && !ta.value.trim() && !attached.length && !listening) Fuzz.startBored(); }, 30000);
    }
    function addFiles(list) {
      if (!list || !list.length) return;
      Array.prototype.forEach.call(list, function (f) { attached.push(f); }); paintFiles();
      nudge(); Fuzz.pAnim('gulp'); moodFor('eager', 1400);
      Fuzz.say(list.length === 1 ? 'Ooh, reading material. I’ll look at it with your task.' : 'A whole stack. I’ll read them with your task.', { type: false });
    }
    $('#dropbtn').addEventListener('click', function () { $('#file').click(); });
    $('#file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); if (!drop.classList.contains('over')) { nudge(); Fuzz.setMood('eager'); } drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    $('#files').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; attached.splice(parseInt(b.dataset.rm, 10), 1); paintFiles(); });

    /* Dictation is simulated in this demo. */
    var mic = $('#cap-mic');
    mic.addEventListener('click', function () {
      listening = !listening; clearTimeout(listenTimer); nudge();
      mic.setAttribute('aria-pressed', String(listening)); $('#mic-l').textContent = listening ? 'Listening…' : 'Dictate';
      if (listening) { clearTimeout(moodTimer); Fuzz.setMood('eager'); Fuzz.pAnim('lean'); Fuzz.say('I’m all antennas. Go ahead.', { type: false }); }
      else { Fuzz.setMood('idle'); paintSay(); }
      if (listening) listenTimer = setTimeout(function () {
        var said = 'Check in with Dana about the offsite budget';
        ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + said; draft = ta.value; listening = false;
        mic.setAttribute('aria-pressed', 'false'); $('#mic-l').textContent = 'Dictate'; sync(); ta.focus();
        Fuzz.setMood('idle'); Fuzz.say('Got all of that. Capture it when you’re ready.', { type: false });
      }, 2200);
    });

    function submit() {
      var text = ta.value.trim();
      if (!text && !attached.length) return;
      var picked = attached.slice(), docs = picked.map(function (f) { return f.name; });
      Store.capture(text, docs, picked);
      ta.value = ''; draft = ''; attached = []; paintFiles(); listening = false; clearTimeout(listenTimer);
      mic.setAttribute('aria-pressed', 'false'); $('#mic-l').textContent = 'Dictate';
      confirm = docs.length ? 'Captured. I’m reading your ' + (docs.length === 1 ? 'document' : 'documents') + ' now.' : 'Captured. It’s waiting in your triage queue.';
      paintSay(); paintList(); ta.focus(); nudge();
      Say.announce(confirm);
      /* Same little celebration as a triage win: a hop, a check on his screen, a bit of confetti. */
      Fuzz.pAnim('hop'); Fuzz.checkGlyph(1300); Fuzz.confetti(go);
      moodFor(docs.length ? 'thinking' : 'happy', docs.length ? 2600 : 1400);
    }
    go.addEventListener('click', submit);
    Fuzz.mount(root, {});
    paintFiles(); paintList(); paintSay(); nudge();
    unsub = Store.on(function () { paintList(); });
    timer = setInterval(paintList, 2000);
    /* Esc goes back to Triage (an open popover takes Escape first, in app.js). */
    escKey = function (e) { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) { e.preventDefault(); App.navigate('#/triage'); } };
    document.addEventListener('keydown', escKey);
    ta.focus();
  };
  V.unmount = function () {
    document.removeEventListener('keydown', escKey);
    if (unsub) unsub(); unsub = null; clearInterval(timer); clearTimeout(listenTimer); clearTimeout(moodTimer); clearTimeout(boredTimer);
    Fuzz.unmount(); root = null;
  };

  window.CaptureView = V;
})();
