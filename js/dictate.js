/* Dictation: the browser's speech recognition, typed into a field as you talk. What you say lands after
   what was already there, and each change fires an input event so the view keeps the text as if typed.
   One field at a time. Holding Alt (Option) + Space listens only while held; Dictate.hold wires that up. */
(function () {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, field = null, base = '', heard = '', failed = '', hooks = {};
  var D = { supported: !!SR, key: (/Mac|iPhone|iPad/.test(navigator.platform) ? 'Option' : 'Alt') + ' + Space' };

  function join(a, b) { b = b.trim(); return a && b ? a + ' ' + b : a + b; }
  function put(text) {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    if (field.scrollHeight > field.clientHeight) field.scrollTop = field.scrollHeight;
  }

  D.active = function () { return !!rec; };
  D.field = function () { return field; };

  /* o.done: Fuzz's line when he heard something. o.onChange(listening) runs as it starts and stops. */
  D.start = function (el, o) {
    if (rec || !el) return false;
    if (!SR) { Fuzz.setMood('sheepish'); Fuzz.say('My ears don’t work in this browser. Try Chrome or Safari, or type it.', { type: false }); return false; }
    hooks = o || {}; field = el; base = el.value.replace(/\s+$/, ''); heard = ''; failed = '';
    var r = rec = new SR(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || 'en-US';
    r.onresult = function (e) {
      /* The card moved on while you talked: stop rather than type into a field that's gone */
      if (!document.contains(field)) { D.abort(); return; }
      var fin = '', mid = '';
      for (var i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript; else mid += e.results[i][0].transcript; }
      heard = fin + mid; put(join(base, heard));
    };
    r.onerror = function (e) { failed = e.error; };
    r.onend = function () {
      if (rec !== r) return;
      var el = field, h = hooks; rec = null; field = null; hooks = {};
      if (h.onChange) h.onChange(false);
      if (document.contains(el)) { el.focus({ preventScroll: true }); el.selectionStart = el.selectionEnd = el.value.length; }
      if (failed === 'not-allowed' || failed === 'service-not-allowed') { Fuzz.setMood('sheepish'); Fuzz.say('I need the microphone for that. Allow it in the browser, then try again.', { type: false }); }
      else if (failed && failed !== 'aborted' && failed !== 'no-speech') { Fuzz.setMood('sheepish'); Fuzz.say('I lost the signal. Try again, or type it.', { type: false }); }
      else if (heard.trim()) { Fuzz.setMood('idle'); Fuzz.say(h.done || 'Got all of that.', { type: false }); }
      else { Fuzz.setMood('idle'); Fuzz.say('I didn’t catch anything. Try again?', { type: false }); }
    };
    try { r.start(); } catch (err) { rec = null; field = null; return false; }
    if (hooks.onChange) hooks.onChange(true);
    Fuzz.setMood('eager'); Fuzz.pAnim('lean'); Fuzz.say('I’m all antennas. Go ahead.', { type: false });
    return true;
  };
  /* Stop and keep what was heard */
  D.stop = function () { if (rec) rec.stop(); };
  /* Stop quietly: leaving the page, or the field went away */
  D.abort = function () {
    if (!rec) return;
    var r = rec, h = hooks; rec = null; field = null; hooks = {};
    r.onend = null; r.abort();
    if (h.onChange) h.onChange(false);
  };

  /* Hold Alt (Option) + Space: target() picks the field when the keys go down (null to ignore them).
     Returns a function that unhooks the keys. */
  D.hold = function (target, o) {
    var held = false;
    function down(e) {
      if (e.code !== 'Space' || !e.altKey || e.metaKey || e.ctrlKey) return;
      var el = rec ? null : target();
      if (!el && !held) return;
      e.preventDefault();
      if (!e.repeat && el && D.start(el, o && o())) held = true;
    }
    function up(e) { if (held && (e.code === 'Space' || e.key === 'Alt')) { held = false; D.stop(); } }
    function blur() { if (held) { held = false; D.stop(); } }
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return function () {
      document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); window.removeEventListener('blur', blur);
      if (held) { held = false; D.abort(); }
    };
  };

  /* The small mic button for a field. data-dictate names the field's id; cls is its button style. It
     comes out pressed if that field is listening, so a view can redraw it mid-sentence. */
  D.button = function (id, label, cls) {
    return '<button type="button" class="' + (cls || 'iconbtn') + ' mic" data-dictate="' + id + '" aria-pressed="' + !!(rec && field && field.id === id) + '" aria-label="' + (label || 'Dictate') + '" title="' + (label || 'Dictate') + ' (hold ' + D.key + ')" aria-keyshortcuts="Alt+Space">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>';
  };

  window.Dictate = D;
})();
