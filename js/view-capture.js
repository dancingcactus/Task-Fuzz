/* New task. Capture costs nothing (principle 8): type or dictate, no categories, triage happens later.
   Layout comes from the Triage Queue mockup's Capture board. */
(function () {
  var V = {};
  var esc = UI.esc;
  var root, unsub = null, timer = 0, listenTimer = 0, listening = false, attached = [], confirm = '';

  function statusFor(c) {
    var it = c.ref ? Store.item(c.ref) : null;
    if (!it) return { text: c.status || 'Waiting in triage', tone: c.tone || 'muted' };
    var map = {
      triage: it.capturedAt && Date.now() - it.capturedAt < 6000 ? ['Fuzz is gathering context', 'sec'] : ['Waiting in triage', 'muted'],
      ai: ['Fuzz is working on it', 'sec'], 'ai-queued': ['Next up with Fuzz', 'muted'], review: ['Draft ready for your OK', 'accent'], session: ['Open in Claude', 'info'],
      scheduled: ['Scheduled', 'muted'], parked: ['Parked', 'muted'], waiting: ['Waiting on others', 'info'], done: ['Done', 'ok'], letgo: ['Let go', 'muted'], dropped: ['Dropped', 'muted'], resolved: ['Done', 'ok']
    };
    var m = map[it.state] || ['Waiting in triage', 'muted'];
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
    return attached.map(function (n, i) {
      return '<li class="file"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg><span>' + esc(n) + '</span>' +
        '<button type="button" class="iconbtn" data-rm="' + i + '" aria-label="Remove ' + esc(n) + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>';
    }).join('');
  }

  V.mount = function (container) {
    root = container; listening = false; confirm = '';
    root.innerHTML = '<section class="capture" aria-labelledby="cap-h">' +
      '<div class="cap-card">' +
        '<div class="cap-head">' + Fuzz.mini('good', { cls: 'cap-fuzz', label: 'Fuzz' }) + '<div><h1 id="cap-h">What is on your mind?</h1><p>Get it out of your head. Fuzz will sort it later.</p></div></div>' +
        '<div class="drop" id="drop"><button type="button" class="dropbtn" id="dropbtn"><span class="dropicon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg></span>' +
          '<span class="droptxt"><b>Drop a document to add context</b><small>Optional. Fuzz reads it along with your task. Files stay in your browser in this demo.</small></span><span class="droplink">Choose files</span></button>' +
          '<input type="file" id="file" multiple hidden></div>' +
        '<ul class="files" id="files" aria-label="Attached documents"></ul>' +
        '<div class="field"><label for="cap-text">New task</label><textarea id="cap-text" rows="4" placeholder="Reply to Dana about the offsite budget"></textarea></div>' +
        '<div class="cap-actions"><button type="button" class="btn primary-b" id="cap-go" disabled><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Capture</button>' +
          '<button type="button" class="btn dictate" id="cap-mic" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span id="mic-l">Dictate</span></button>' +
          '<span class="hint">Ctrl or Cmd + Enter to capture</span></div>' +
      '</div>' +
      '<div class="fuzz-say" id="say" role="status" aria-live="polite"></div>' +
      '<section class="recent"><h2>Captured recently</h2><ul class="cap-list" id="cap-list"></ul>' +
        '<p class="fine">Tasks from email, Slack and meetings arrive in triage on their own, so you only need to capture the ones that start in your head.</p></section></section>';
    var $ = function (s) { return root.querySelector(s); };
    var ta = $('#cap-text'), go = $('#cap-go');
    function sync() { go.disabled = ta.value.trim() === '' && attached.length === 0; }
    function paintFiles() { $('#files').innerHTML = attachedHTML(); sync(); }
    function paintList() { $('#cap-list').innerHTML = listHTML(); }
    ta.addEventListener('input', function () { sync(); if (confirm) { confirm = ''; paintSay(); } });
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    function paintSay() {
      $('#say').innerHTML = confirm ? Fuzz.mini('good', { cls: 'say-av' }) + '<span>' + esc(confirm) + '</span>' : '';
    }
    function addFiles(list) { Array.prototype.forEach.call(list, function (f) { attached.push(f.name); }); paintFiles(); }
    $('#dropbtn').addEventListener('click', function () { $('#file').click(); });
    $('#file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    $('#files').addEventListener('click', function (e) { var b = e.target.closest('[data-rm]'); if (!b) return; attached.splice(parseInt(b.dataset.rm, 10), 1); paintFiles(); });

    /* Dictation is simulated in this demo. */
    var mic = $('#cap-mic');
    mic.addEventListener('click', function () {
      listening = !listening; clearTimeout(listenTimer);
      mic.setAttribute('aria-pressed', String(listening)); $('#mic-l').textContent = listening ? 'Listening…' : 'Dictate';
      if (listening) listenTimer = setTimeout(function () {
        var said = 'Check in with Dana about the offsite budget';
        ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + said; listening = false;
        mic.setAttribute('aria-pressed', 'false'); $('#mic-l').textContent = 'Dictate'; sync(); ta.focus();
      }, 2200);
    });

    function submit() {
      var text = ta.value.trim();
      if (!text && !attached.length) return;
      var docs = attached.slice();
      Store.capture(text, docs);
      ta.value = ''; attached = []; paintFiles(); listening = false; clearTimeout(listenTimer);
      mic.setAttribute('aria-pressed', 'false'); $('#mic-l').textContent = 'Dictate';
      confirm = docs.length ? 'Captured. I’m reading your ' + (docs.length === 1 ? 'document' : 'documents') + ' now.' : 'Captured. It’s waiting in your triage queue.';
      paintSay(); paintList(); ta.focus();
    }
    go.addEventListener('click', submit);
    paintFiles(); paintList(); paintSay();
    unsub = Store.on(function () { paintList(); });
    timer = setInterval(paintList, 2000);
    ta.focus();
  };
  V.unmount = function () {
    if (unsub) unsub(); unsub = null; clearInterval(timer); clearTimeout(listenTimer); root = null;
  };

  window.CaptureView = V;
})();
