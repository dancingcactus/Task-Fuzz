/* Chat with Fuzz. A scripted demo, not a model: it answers from the store so the UI and tone can be refined.
   Fuzz's small logo is the avatar. Anything you type that isn't a question becomes a captured task (principle 8). */
(function () {
  var C = {};
  var esc = UI.esc;
  var panel, fab, list, form, input, status, msgs = [], openNow = false, typing = false, started = false;

  function now() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function push(from, text, chips) { msgs.push({ from: from, text: text, chips: chips || null, time: now() }); }

  function render() {
    list.innerHTML = msgs.map(function (m, i) {
      var last = i === msgs.length - 1;
      var av = m.from === 'fuzz' ? Fuzz.mini('good', { cls: 'chat-av' }) : '';
      var chips = (m.chips && last && !typing) ? '<div class="chat-chips" role="group" aria-label="Quick replies">' + m.chips.map(function (c, j) { return '<button type="button" class="chip" data-chip="' + j + '">' + esc(c.label) + '</button>'; }).join('') + '</div>' : '';
      return '<li class="msg msg--' + m.from + '">' + av + '<div class="msg-body"><span class="msg-who">' + (m.from === 'fuzz' ? 'Fuzz' : 'You') + ' · ' + esc(m.time) + '</span><span class="bub">' + esc(m.text) + '</span>' + chips + '</div></li>';
    }).join('') + (typing ? '<li class="msg msg--fuzz"><span class="chat-av-wrap">' + Fuzz.mini('think', { cls: 'chat-av' }) + '</span><div class="msg-body"><span class="bub typing" aria-label="Fuzz is typing">…</span></div></li>' : '');
    list.scrollTop = list.scrollHeight;
    var w = Store.stats().withFuzz;
    status.textContent = w ? 'Working on ' + w + (w === 1 ? ' task' : ' tasks') : 'On standby';
  }

  function say(text, chips) {
    typing = true; render();
    return new Promise(function (res) {
      setTimeout(function () { typing = false; push('fuzz', text, chips); render(); res(); }, Fuzz.isCalm() ? 150 : 650);
    });
  }

  /* ---------- The brain ---------- */
  function brief() {
    var s = Store.stats(), rev = Store.inState('review').length, due = Store.queue().filter(function (i) { return i.dueAt; });
    var t = s.waiting + ' ' + (s.waiting === 1 ? 'card is' : 'cards are') + ' waiting for you in triage. ';
    t += s.withFuzz ? 'I’m working on ' + s.withFuzz + '. ' : 'I’m not running anything right now. ';
    if (rev) t += rev + (rev === 1 ? ' draft is' : ' drafts are') + ' ready for your OK. ';
    if (due.length) t += 'Nearest time-sensitive one: “' + due[0].title + '”. ';
    return t.trim();
  }
  function reply(text) {
    var q = text.toLowerCase().trim();
    var raw = text.trim();
    var m;
    if (/^(hi|hello|hey|yo)\b/.test(q)) return { t: 'Hey. Ready when you are. Ask what I’m up to, or just tell me something to remember.', chips: [{ label: 'What are you working on?', say: 'What are you working on?' }, { label: 'Give me a brief', say: 'Give me a brief' }] };
    if (/\b(brief|morning|catch me up|overview|where are we|status)\b/.test(q)) return { t: brief(), chips: [{ label: 'Go to triage', go: '#/triage' }, { label: 'See all tasks', go: '#/tasks' }] };
    if (/\b(working on|doing|busy|progress|up to)\b/.test(q)) {
      var w = Store.inState('ai', 'ai-queued');
      if (!w.length) return { t: 'Nothing right now. Assign me something from triage and I’ll get going. I’m bored, honestly.', chips: [{ label: 'Go to triage', go: '#/triage' }] };
      return { t: 'I’m on ' + w.length + ': ' + w.map(function (x) { return '“' + x.title + '”' + (x.state === 'ai-queued' ? ' (next up)' : ''); }).join(', ') + '. I’ll come find you if I get stuck.', chips: [{ label: 'Open Current', go: '#/tasks' }] };
    }
    if (/\b(stuck|handed back|handback|lost the signal)\b/.test(q)) {
      var hb = Store.queue().filter(function (i) { return i.handedBack; });
      if (!hb.length) return { t: 'Nothing is stuck right now. If I get stuck, it comes back to the end of your triage queue. That’s normal, not a failure.' };
      return { t: hb.length + (hb.length === 1 ? ' task is' : ' tasks are') + ' handed back: ' + hb.map(function (x) { return '“' + x.title + '”'; }).join(', ') + '. They’re at the back of your queue.', chips: [{ label: 'Go to triage', go: '#/triage' }] };
    }
    if (/\b(draft|approve|review|ready)\b/.test(q)) {
      var r = Store.inState('review');
      if (!r.length) return { t: 'No drafts are waiting. Nothing gets sent without your OK, so when one’s ready I’ll tell you.' };
      return { t: r.length + (r.length === 1 ? ' draft is' : ' drafts are') + ' ready: ' + r.map(function (x) { return '“' + x.title + '”'; }).join(', ') + '. Nothing sends until you approve it.', chips: [{ label: 'Review in All tasks', go: '#/tasks' }] };
    }
    if (/\b(theme|colou?r|palette|look)\b/.test(q)) return { t: 'You can change my whole look from the Theme button at the top. Want a taste?', chips: [{ label: 'Try Honey', theme: 'honey' }, { label: 'Try Lagoon', theme: 'lagoon' }, { label: 'Try Rosewood', theme: 'rosewood' }, { label: 'Back to Terracotta', theme: 'terracotta' }] };
    if (/\b(calm|quiet|less motion|stop moving|reduce)\b/.test(q)) return { t: 'Happy to hold still. Calm mode keeps the fades and drops the flashes and gags.', chips: [{ label: 'Turn on calm mode', calm: true }, { label: 'Turn it off', calm: false }] };
    if (/(overwhelm|too much|tired|stressed|exhausted|can't cope|cannot cope)/.test(q)) return { t: 'That sounds like a lot. We can slow right down. Want me to hold everything in your queue until tomorrow morning? It’ll all be there, and you can undo it.', chips: [{ label: 'Hold the rest until tomorrow', hold: true }, { label: 'Just show me one thing', go: '#/triage' }] };
    if (/\b(thanks|thank you|thx)\b/.test(q)) { if (window.Fuzz && Fuzz.mounted()) Fuzz.hearts(); return { t: 'Anytime. That’s the job.' }; }
    if (/\b(who are you|what are you|what can you do|help)\b/.test(q)) return { t: 'I’m Fuzz. Old TV, two antennas, strong opinions about your inbox. I work through the tasks you hand me, ask when I’m unsure, and never send anything without your OK.', chips: [{ label: 'What are you working on?', say: 'What are you working on?' }, { label: 'Give me a brief', say: 'Give me a brief' }] };
    if ((m = raw.match(/^(?:add|capture|remind me(?: to)?|task:?|todo:?)\s+(.+)/i))) return { t: '', capture: m[1].trim() };
    return { t: 'Want me to capture “' + (raw.length > 80 ? raw.slice(0, 77) + '…' : raw) + '” as a task? It goes to the end of your triage queue.', chips: [{ label: 'Capture it', capture: raw }, { label: 'Not now' }] };
  }

  async function handle(r) {
    if (r.capture) {
      var it = Store.capture(r.capture, []);
      await say('Captured “' + it.title + '”. It’s at the end of your triage queue. Nothing else to do.', [{ label: 'Go to triage', go: '#/triage' }, { label: 'Capture another', say: 'Add ' }]);
      return;
    }
    await say(r.t, r.chips);
  }
  function chipAction(c) {
    if (c.go) { push('you', c.label); render(); window.App.navigate(c.go); return; }
    if (c.theme) { push('you', c.label); window.App.setTheme(c.theme); return say('Better? I look good in all of them.', [{ label: 'Try Plum', theme: 'plum' }, { label: 'Try Denim', theme: 'denim' }]); }
    if (c.calm !== undefined) { push('you', c.label); window.App.setCalm(c.calm); return say(c.calm ? 'Calm mode on. Fades only.' : 'Back to the full show.'); }
    if (c.hold) {
      push('you', c.label);
      var snap = Store.snapshot();
      Store.queue().forEach(function (i) { Store.schedule(i.id, '', 'tomorrow morning'); });
      window.App.refresh();
      UI.toast('Held the rest until tomorrow morning.', { undo: function () { Store.restore(snap); window.App.refresh(); } });
      return say('Done. Everything’s waiting for tomorrow morning. Take a breath.');
    }
    if (c.capture) { push('you', c.label); return handle({ capture: c.capture }); }
    if (c.say) {
      if (c.say === 'Add ') { input.value = 'Add '; input.focus(); return; }
      return send(c.say);
    }
    push('you', c.label); return say('No problem.');
  }

  function send(text) {
    if (!text.trim() || typing) return;
    push('you', text.trim()); render();
    return handle(reply(text));
  }

  /* ---------- Panel ---------- */
  C.mount = function (host) {
    host.innerHTML =
      '<button type="button" class="chat-fab" id="chat-fab" aria-expanded="false" aria-controls="chat">' + Fuzz.mini('good', { cls: 'fab-av' }) + '<span>Chat with Fuzz</span></button>' +
      '<aside class="chat" id="chat" role="dialog" aria-label="Chat with Fuzz" hidden>' +
        '<header class="chat-head">' + Fuzz.mini('good', { cls: 'head-av', label: 'Fuzz' }) + '<div><b>Fuzz</b><span id="chat-status">On standby</span></div><button type="button" class="iconbtn" id="chat-close" aria-label="Close chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>' +
        '<ol class="chat-list" id="chat-list" role="log" aria-live="polite" aria-label="Conversation with Fuzz"></ol>' +
        '<form class="chat-form" id="chat-form"><label for="chat-input" class="sr">Message Fuzz</label><input id="chat-input" type="text" autocomplete="off" placeholder="Ask, or tell me something to remember"><button type="submit" class="btn primary-b send" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>' +
      '</aside>';
    panel = host.querySelector('#chat'); fab = host.querySelector('#chat-fab'); list = host.querySelector('#chat-list');
    form = host.querySelector('#chat-form'); input = host.querySelector('#chat-input'); status = host.querySelector('#chat-status');
    fab.addEventListener('click', function () { C.toggle(); });
    host.querySelector('#chat-close').addEventListener('click', function () { C.toggle(false); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { C.toggle(false); } });
    form.addEventListener('submit', function (e) { e.preventDefault(); var v = input.value; input.value = ''; send(v); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-chip]'); if (!b) return;
      var last = msgs[msgs.length - 1]; if (!last || !last.chips) return;
      var c = last.chips[parseInt(b.dataset.chip, 10)]; last.chips = null; chipAction(c);
    });
    Store.on(function () { if (openNow) { var w = Store.stats().withFuzz; status.textContent = w ? 'Working on ' + w + (w === 1 ? ' task' : ' tasks') : 'On standby'; } });
  };
  C.toggle = function (force) {
    openNow = force === undefined ? !openNow : force;
    panel.hidden = !openNow; fab.setAttribute('aria-expanded', String(openNow)); fab.classList.toggle('is-open', openNow);
    if (openNow) {
      if (!started) {
        started = true;
        push('fuzz', 'Hi, I’m Fuzz. I work through your tasks while you decide. Ask what I’m up to, or just tell me something to remember.', [{ label: 'What are you working on?', say: 'What are you working on?' }, { label: 'Give me a brief', say: 'Give me a brief' }]);
      }
      render(); input.focus();
    } else { fab.focus(); }
  };

  window.Chat = C;
})();
