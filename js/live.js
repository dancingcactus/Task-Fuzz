/* Live mode: the same screens, driven by the Fuzz core (`fuzz serve`) instead of the demo data.
   Open the link `fuzz serve` prints (http://127.0.0.1:8765/?token=…) once; the token is kept in this
   browser. Without a token, or when the page isn't served by the core, the demo runs as before.

   How it fits on the demo's Store:
   - Store keeps its in-memory model, so the views stay synchronous. Each decision still changes it at
     once (the card leaves, Fuzz reacts) and is also sent to the core, one write at a time, in order.
   - The core is the truth. After every write, and whenever its event stream says something changed
     (Fuzz worked, a draft is ready, the CLI did something), Store is brought in line with GET /tasks
     and GET /cards. A refresh never jumps the card you are looking at.
   - Undo is the core's: each change remembers its undo group and POST /undo reverses just that one.
   - Assigning a task starts the executor for it (POST /engine/run), so Fuzz starts right away. */
(function () {
  var KEY = 'fuzz.token';
  var token = null, on = false, quiet = 0, gen = 0, pending = 0, chain = Promise.resolve(), recording = null;
  var unpin = false, extra = null, syncing = false, again = false, syncTimer = 0, detail = {}, sig = '', undoBlocked = {}, lastId = 0, said = {};
  var base = {}, listeners = [];

  var STATE = { queued: 'ai-queued', working: 'ai', merged: 'resolved' };
  var VIA = { email: 'Email', slack: 'Slack', calendar: 'Calendar invite', nudge: 'The same thread' };
  var ROLE = { origin: 'Source', update: 'Update', context: 'Context', attachment: 'File', output: 'Saved file', link: 'Link' };

  /* ---------- Talking to the core ---------- */
  function readToken() {
    var m = /[?&]token=([^&#]+)/.exec(location.search);
    if (m) {
      token = decodeURIComponent(m[1]);
      try { localStorage.setItem(KEY, token); } catch (e) {}
      var q = location.search.replace(/([?&])token=[^&#]*&?/, '$1').replace(/[?&]$/, '');
      history.replaceState(null, '', location.pathname + q + location.hash);
      return token;
    }
    try { token = localStorage.getItem(KEY); } catch (e) { token = null; }
    return token;
  }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) {} token = null; }

  /* A file opens in the viewer, in a new tab (artifact.html), which reads it with this browser's token */
  function fileUrl(sid) { return 'artifact.html?id=' + sid; }
  /* A source's link opens where it lives (the email, the Slack thread), but only a web address */
  function webUrl(link) { return /^https?:\/\//i.test(link || '') ? link : null; }
  function api(method, path, body) {
    var o = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.field = j.field; throw e; }
        return j;
      });
    });
  }

  /* Writes go one at a time, in the order you made them. A failed write says why, about which task, and
     puts the screen back the way the core has it. It stays on screen until you dismiss it, since the
     card coming back on its own is otherwise all you'd see. */
  function failed(e, title) {
    var what = title ? 'Your change to “' + title + '” didn’t go through' : 'That didn’t go through';
    if (e instanceof TypeError) return what + ': Fuzz’s server isn’t answering. Check that fuzz serve is running, then try again.';
    if (e.status === 404 && /^No route /.test(e.message)) return what + ': Fuzz’s server is running older code than this page. Restart fuzz serve, then try again.';
    return what + ': ' + e.message.replace(/\.?$/, '.') + ' It’s back the way Fuzz has it.';
  }
  function write(fn, title) {
    pending++;
    var p = chain.then(fn);
    chain = p.catch(function (e) {
      Say.tell(failed(e, title), { stay: true });
      console.error('[fuzz live]', e);
    }).then(function () { pending--; soon(0); });
    if (recording) recording.push(p);
    return p;
  }
  /* A task waiting on a permission card can't be claimed, so starting a run for it only spends credits */
  function kick(it) { return it.needsPermission ? null : run(it.coreId); }
  function run(tid) {
    return api('POST', '/engine/run', { role: 'executor', task_id: tid }).catch(function (e) {
      if (!said.engine) { said.engine = true; Say.tell('Fuzz can’t start work yet: ' + e.message + ' Run `fuzz doctor` to check.'); }
    });
  }

  /* Answer the task's open card when it offers this option; otherwise act on the task directly
     (from Lineup there is often no card). */
  function decide(it, option, value, action, body) {
    var cardId = it.cardId, opts = it.cardOptions || [], tid = it.coreId;
    return function () {
      if (cardId && opts.indexOf(option) > -1) return api('POST', '/cards/' + cardId + '/answer', value === undefined ? { option: option } : { option: option, value: value });
      if (!action) throw new Error('This card can’t do that any more. Refresh the page.');
      return api('POST', '/tasks/' + tid + '/' + action, body || {});
    };
  }
  /* A draft you changed is saved as an edit first, so what you approve is what goes out. */
  function editFirst(it, text) {
    var cardId = it.cardId, changed = text != null && text !== it.draft;
    return function () { return changed && cardId ? api('POST', '/cards/' + cardId + '/answer', { option: 'edit', value: text }) : null; };
  }
  function then() { var fns = arguments; return function () { var p = Promise.resolve(); Array.prototype.forEach.call(fns, function (f) { p = p.then(f); }); return p; }; }

  /* ---------- From the core's shapes to the demo's ---------- */
  function ts(s) { var t = s ? Date.parse(s) : NaN; return isNaN(t) ? null : t; }
  function ago(s) {
    var t = ts(s); if (!t) return '';
    var m = (Date.now() - t) / 60000;
    if (m < 2) return 'Just now';
    if (m < 60) return Math.round(m) + ' minutes';
    if (m < 120) return '1 hour';
    if (m < 1440) return Math.round(m / 60) + ' hours';
    if (m < 2880) return '1 day';
    return Math.round(m / 1440) + ' days';
  }
  function agoText(s) { var a = ago(s); return !a ? '' : a === 'Just now' ? a : a + ' ago'; }
  function clockOf(s) {
    var t = ts(s); if (!t) return '';
    var d = new Date(t), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  /* A source's own time, to the minute: "Today, 9:14 AM", "Oct 27, 4:12 PM" */
  function stampOf(s) {
    var t = ts(s); if (!t) return '';
    var d = new Date(t), now = new Date(), y = new Date(); y.setDate(now.getDate() - 1);
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'Today, ' + time;
    if (d.toDateString() === y.toDateString()) return 'Yesterday, ' + time;
    return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + time;
  }
  function whenText(fire) {
    var t = ts(fire); if (!t) return 'when you’re back at your desk';
    return Sched.hint({ anchor: {}, fire_at: new Date(t).toISOString() }).replace(/^Today, /, 'today at ').replace(/^Tomorrow, /, 'tomorrow at ');
  }
  /* The brief is Markdown; the finding on the card shows it as plain lines, the Context tab as Markdown */
  function lines(md) {
    return (md || '').split('\n').map(function (l) { return l.replace(/^\s*(#+|>|[-*]\s*(\[[ xX]\])?|\d+\.)\s*/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').trim(); }).filter(function (l) { return l && !/^(```|~~~|[-*_]{3,})/.test(l); });
  }
  function brief(md) { var l = lines(md), s = l.join(' '); return s.length > 320 ? s.slice(0, 317) + '…' : s; }
  /* A brief too long for the finding gets the Context tab, and the finding says what Fuzz did or found
     instead: the summary it wrote, or for an older task its latest research or action step */
  function fullBrief(md) { return lines(md).length > 1 || brief(md).length > 316; }
  function finding(t) {
    if (t.summary) return t.summary;
    if (!fullBrief(t.context_md)) return brief(t.context_md) || null;
    var step = (t.log || []).filter(function (l) { return l.type === 'task.step' && l.kind !== 'guidance'; })[0];
    return step ? step.text : null;
  }

  /* Question and approval cards that aren't about routing a task: the views draw them as an "entity"
     card with up to three answers. which -> the core's option. */
  var QUESTION = {
    is_task: { primary: ['mine', 'Yes, it’s mine'], secondary: ['not_task', 'Not a task'], third: ['someone_else', 'Someone else’s'], dismissed: 'not_task' },
    entity_person: { primary: ['same', 'Same person'], secondary: ['different', 'Different people'], dismissed: 'not_sure' },
    entity_term: { primary: ['define', 'Save definition'], dismissed: 'not_sure', note: true },
    duplicate: { primary: ['merge', 'Merge'], secondary: ['keep_separate', 'Keep separate'], dismissed: 'not_sure' },
    permission: { primary: ['allow_once', 'Allow once'], secondary: ['always_allow', 'Always allow'], third: ['deny', 'Don’t allow'], dismissed: 'deny' }
  };

  /* How a draft goes out: "Email", or "Email reply in “Eurobet - Go fwd Strategy”" when it answers a source */
  function via(d, t) {
    var how = VIA[(d.kind || '').split('.')[0]] || 'Its own app';
    var src = d.reply_to && (t.sources || []).filter(function (s) { return s.id === d.reply_to; })[0];
    if (!src) return how;
    return (d.kind === 'email.reply' ? 'Email reply' : how) + (src.title ? ' in “' + src.title + '”' : '');
  }

  function toItem(t, c, it) {
    it = it || {};
    var tags = t.variant_tags || [], src = (t.sources || []).filter(function (s) { return !s.withdrawn && s.role !== 'ignored'; });
    var origin = src.filter(function (s) { return s.role === 'origin'; })[0];
    var draft = (c && c.draft) || (t.drafts || []).filter(function (d) { return d.status === 'pending' || d.status === 'approved'; })[0] || null;
    var state = STATE[t.state] || t.state;
    var f = {
      id: 't' + t.id, coreId: t.id, kind: 'task', state: state, title: t.title || t.ask || 'Untitled',
      source: origin ? (origin.title || 'Found by Fuzz') : 'Captured by you', who: '',
      age: ago(t.created_at) || 'Just now', stage: tags.indexOf('stale') > -1 ? 'stale' : 'fresh',
      mins: t.effort_mins || 5, energy: t.energy || 'normal',
      incoming: t.reason || (t.ask && t.ask !== t.title ? t.ask : origin ? '' : 'You captured this.'),
      ask: ((tags.indexOf('review') > -1 || tags.indexOf('check_back') > -1) && t.reason) || (c && c.prompt) || t.question || 'What should happen to this?',
      hint: '', instr: it.instr && it.coreId === t.id ? it.instr : '',
      aiHeading: 'What Fuzz found', aiNote: finding(t),
      context: [], contextMd: fullBrief(t.context_md) ? t.context_md : '',
      log: (t.log || []).map(function (l) { return { kind: l.kind, time: clockOf(l.ts), text: l.text }; }),
      sources: src.map(function (s) { return { type: ROLE[s.role] || 'Source', title: s.title || '', quote: s.quote || '', when: stampOf(s.ts), at: s.ts || '', url: (s.role === 'output' || s.role === 'attachment') && s.has_file ? fileUrl(s.id) : webUrl(s.link) }; }),
      conversation: [], code: [],
      handedBack: tags.indexOf('handed_back') > -1 && state === 'triage',
      result: tags.indexOf('result') > -1 && state === 'triage',
      askBack: tags.indexOf('handed_back') > -1 ? t.question : null,
      quick: tags.indexOf('handed_back') > -1 && t.quick_answers && t.quick_answers.length ? t.quick_answers : null,
      updated: tags.indexOf('returning') > -1 || tags.indexOf('reopened') > -1 || tags.indexOf('woke') > -1,
      woke: tags.indexOf('woke') > -1, gathering: tags.indexOf('gather') > -1,
      /* A parked task back to ask if you still want it; after a few keeps the card leans toward letting go */
      review: tags.indexOf('review') > -1 && state === 'triage', leansGo: !!(c && c.suggested === 'drop'),
      /* A waiting task back to ask if they got back to you; and one you said was someone else's */
      checkBack: tags.indexOf('check_back') > -1 && state === 'triage', theirs: tags.indexOf('theirs') > -1,
      isNew: state === 'triage' && !origin && (Date.now() - (ts(t.created_at) || 0)) < 10 * 60000 && !(t.log || []).some(function (l) { return l.actor && l.actor.indexOf('fuzz') === 0; }),
      dueAt: null, due: null,
      waitingOn: t.waiting_on || 'Someone', waitedFor: ago(t.state_changed_at),
      nextCheck: t.state === 'waiting' && t.schedule_fire_at ? whenText(t.schedule_fire_at) : '',
      doneAgo: agoText(t.state_changed_at), parkedAgo: agoText(t.state_changed_at), changedAt: ts(t.state_changed_at) || 0,
      draft: draft ? draft.body : null, draftId: draft ? draft.id : null,
      afterApprove: (c && c.after_approve) || null, prep: !!(draft && draft.kind === 'note' && draft.final === 0),
      sendTo: draft && draft.kind !== 'note' ? { to: draft.target || 'its recipient', via: via(draft, t) } : null,
      steps: t.steps_used || 0, needsPermission: tags.indexOf('needs_permission') > -1,
      cardId: c ? c.id : null, cardKind: c ? c.kind : null, cardOptions: c ? c.options : [],
      scheduleOptions: c && c.schedule_options && c.schedule_options.length ? c.schedule_options : null,
      group: t.group_id ? 'g' + t.group_id : null
    };
    /* Waiting on someone while Fuzz works out when to check back: it's already with them, not with Fuzz */
    if (tags.indexOf('plan_wait') > -1) { f.state = 'waiting'; f.gathering = false; f.nextCheck = 'Fuzz is picking a time'; }
    /* Time-sensitive tasks get the rush treatment; others with a date get the due bar */
    var due = ts(t.due);
    if (due && (t.deadline_level || 0) >= 1) f.dueAt = due;
    else if (due) {
      var left = due - Date.now(), span = Math.max(due - (ts(t.created_at) || Date.now()), 1);
      f.due = { label: 'Due ' + whenText(t.due), left: left <= 0 ? 'Past its time' : ago(new Date(Date.now() - left).toISOString()) + ' left', frac: Math.max(0, Math.min(1, left / span)) };
    }
    if (state === 'scheduled' || (f.gathering && t.schedule_anchor)) { f.scheduledFor = whenText(t.schedule_fire_at); f.now = 'Back ' + f.scheduledFor; }
    else if (state === 'review') f.now = 'Draft ready to review';
    else if (state === 'sending') f.now = 'Sending' + (f.sendTo ? ' to ' + f.sendTo.to : '');
    else if (state === 'session') f.now = 'Open in Claude';
    else if (state === 'done') f.now = 'Done';
    else if (state === 'letgo') f.now = f.theirs ? 'Someone else’s' : 'Let go';
    else f.now = '';
    var q = c && QUESTION[c.kind];
    /* A permission card's task stays queued for Fuzz in the core, but it is waiting on you */
    if (q && (state === 'triage' || c.kind === 'permission')) {
      f.state = 'triage';
      f.kind = c.kind === 'duplicate' ? 'dup' : 'entity';
      f.entity = c.kind === 'entity_person' ? 'person' : c.kind === 'entity_term' ? 'term' : c.kind;
      f.dupOf = c.other ? 't' + c.other.id : null;
      f.primary = q.primary[1]; f.secondary = q.secondary ? q.secondary[1] : 'Not sure yet'; f.third = q.third ? q.third[1] : null;
      f.answers = { primary: 'Got it. Next one.', secondary: 'Got it. Next one.', third: 'Got it. Next one.' };
      f.incoming = c.reason || f.incoming; f.boxLabel = q.note ? 'What is it?' : c.kind === 'permission' ? 'Anything else Fuzz needs?' : 'Anything that helps?'; f.placeholder = '';
      f.profiles = []; f.mentions = []; f.meta = '';
      /* Is it yours? needs what Fuzz found about the task itself; the reason already reads above the answers */
      if (c.kind !== 'is_task') { f.aiHeading = 'Why Fuzz asked'; f.aiNote = c.reason || f.aiNote; }
    } else {
      ['entity', 'dupOf', 'primary', 'secondary', 'third', 'answers', 'boxLabel', 'placeholder', 'profiles', 'mentions'].forEach(function (k) { delete it[k]; });
    }
    /* What you typed but haven't sent stays; everything else is the core's */
    return Object.assign(it, f);
  }

  /* ---------- Bringing Store in line with the core ---------- */
  function soon(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms == null ? 250 : ms); }

  function sync() {
    if (!on) return Promise.resolve();
    if (syncing || pending) { again = true; return Promise.resolve(); }
    syncing = true; var g = gen;
    return Promise.all([api('GET', '/tasks'), api('GET', '/cards'), api('GET', '/undo'),
      /* A core from before groups has no /groups: the queue still loads, just without "From …" lines */
      api('GET', '/groups').catch(function () { return { groups: [] }; })]).then(function (r) {
      var list = r[0].tasks, cards = r[1].cards, groups = r[3].groups;
      if (r[0].max_working) Store.setSlots(r[0].max_working);
      undoBlocked = {}; (r[2].recent || []).forEach(function (u) { undoBlocked[u.group] = u.blocked; });
      offerFuzzUndo(r[2].recent || []);
      /* The full task (log, sources, drafts) only when something about it changed */
      var need = list.filter(function (t) { var k = JSON.stringify(t); if (detail[t.id] && detail[t.id].key === k) return false; detail[t.id] = { key: k }; return true; });
      return Promise.all(need.map(function (t) {
        return api('GET', '/tasks/' + t.id).then(function (full) { detail[t.id].full = full; }, function (e) { delete detail[t.id]; throw e; });
      })).then(function () {
        if (g !== gen || pending) { again = true; return; }
        /* A task that left the list (finished more than two weeks ago) leaves the cache too */
        var listed = {}; list.forEach(function (t) { listed[t.id] = true; });
        Object.keys(detail).forEach(function (id) { if (!listed[id]) delete detail[id]; });
        Store.get().finishedOlder = r[0].finished_older || 0;
        apply(list, cards, r[1].moment, groups);
      });
    }).catch(function (e) {
      if (e.status === 401) { forget(); Say.tell('Fuzz doesn’t know this browser any more. Open the link `fuzz serve` printed.'); on = false; return; }
      console.error('[fuzz live] sync', e);
    }).then(function () {
      syncing = false;
      if (again) { again = false; soon(150); }
    });
  }

  /* Some of Fuzz's own changes can be taken back, like renaming a task after your instructions changed it.
     Each new one is offered once, like your own; the ones there when the page opened are not. */
  var offered = null;
  function offerFuzzUndo(recent) {
    var first = offered === null; offered = offered || {};
    recent.forEach(function (u) {
      if (u.by === 'human' || offered[u.group]) return;
      offered[u.group] = true;
      if (first) return;
      Say.offerUndo(u.text, function () {
        if (undoBlocked[u.group]) return undoBlocked[u.group];
        gen++;
        write(function () { return api('POST', '/undo', { group: u.group }); }).then(syncThenRefresh, syncThenRefresh);
        return null;
      }, null, function () { return undoBlocked[u.group] || null; });
    });
  }

  /* The tasks that came from the same place. A meeting's notes are a file, which a browser page can't open. */
  function toGroup(g) {
    return { id: 'g' + g.id, coreId: g.id, title: g.title, source: g.source, link: webUrl(g.link), closed: g.wrapped,
      members: (g.tasks || []).map(function (t) { return { id: 't' + t.id, state: STATE[t.state] || t.state }; }) };
  }

  function apply(list, cards, moment, groups) {
    var st = Store.get(), byTask = {};
    cards.forEach(function (c) { if (c.task && !byTask[c.task.id]) byTask[c.task.id] = c; });
    var keep = {}, items = [];
    list.forEach(function (t) {
      var full = detail[t.id] && detail[t.id].full; if (!full) return;
      var id = 't' + t.id, old = Store.item(id);
      items.push(toItem(full, byTask[t.id], old));
      keep[id] = true;
    });
    /* Captures still on their way to the core stay */
    st.items.forEach(function (i) { if (!i.coreId && !keep[i.id]) items.push(i); });
    var order = [], seen = {};
    cards.forEach(function (c) { var id = c.task && 't' + c.task.id; if (id && !seen[id] && keep[id]) { seen[id] = true; order.push(id); } });
    /* The card on screen stays first, so nothing jumps while you read it */
    var restart = unpin, front = unpin ? null : st.queue[0];
    unpin = false;
    if (front && seen[front] && order[0] !== front) order = [front].concat(order.filter(function (id) { return id !== front; }));
    var added = order.filter(function (id) { return st.queue.indexOf(id) < 0; });
    groups = (groups || []).map(toGroup);
    var next = JSON.stringify([items, order, moment, groups]);
    if (next === sig) return;
    sig = next;
    st.items = items;
    st.groups = groups;
    st.queue = order;
    st.queue.forEach(function (id, n) { Store.item(id).order = n; });
    st.maxOrder = order.length; st.minOrder = 0;
    st.totalEver = Math.max(st.totalEver + added.length, order.length);
    st.moment = moment || 'any';
    Store.emit({ type: added.length ? 'review' : 'work' });
    if (restart && window.App) App.refresh();
  }

  /* After an undo the card comes back, so the screen starts over from the core's queue */
  function syncThenRefresh() { unpin = true; sig = ''; return sync(); }

  /* The event stream: any event means something changed. Reconnects on its own.
     One tab per browser holds it and passes each new event id to the others. A stream keeps its connection
     open, and the browser allows only six to the core, so a stream per tab left nothing for the requests
     themselves once a few tabs were open. Whichever tab holds the lock streams; when it closes, another
     takes over from the last id it heard. */
  function moved() { soon(); listeners.slice().forEach(function (fn) { fn(); }); }
  function listen() {
    if (!on || !window.fetch || !window.ReadableStream) return setInterval(function () { soon(0); }, 5000);
    if (!navigator.locks || !window.BroadcastChannel) return stream(null);
    var ch = new BroadcastChannel('fuzz.events');
    ch.onmessage = function (e) { if (e.data > lastId) { lastId = e.data; moved(); } };
    navigator.locks.request('fuzz.events', function () {
      return new Promise(function () { stream(ch); });   /* held until this tab closes */
    });
  }
  function stream(ch) {
    var dec = new TextDecoder(), buf = '';
    fetch('/events/stream?after=' + lastId, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) {
      if (!r.ok) throw new Error('stream ' + r.status);
      var rd = r.body.getReader();
      (function pump() {
        rd.read().then(function (x) {
          if (x.done) throw new Error('stream ended');
          buf += dec.decode(x.value, { stream: true });
          var frames = buf.split('\n\n'); buf = frames.pop();
          var was = lastId;
          frames.forEach(function (f) { var m = /^id: (\d+)/m.exec(f); if (m) lastId = Math.max(lastId, +m[1]); });
          if (lastId > was) { moved(); if (ch) ch.postMessage(lastId); }
          pump();
        }).catch(retry);
      })();
    }).catch(retry);
    function retry() { if (on) setTimeout(function () { stream(ch); }, 3000); }
  }

  /* ---------- Store, wired to the core ---------- */
  function wrap(name, ops) {
    base[name] = Store[name];
    Store[name] = function () {
      var f = !quiet && ops.apply(null, arguments), it = f && Store.item(arguments[0]);
      var res = base[name].apply(Store, arguments);
      if (f) { gen++; write(f, it && it.title); }
      return res;
    };
  }

  function install() {
    var S = Store;
    /* An empty start: the core fills it */
    Demo.build = function () { return { items: [], queue: [], totalEver: 0, groups: [], captured: [] }; };
    S.startWork = function () {};
    S.scheduleOptions = function (it) { return it.scheduleOptions || Sched.options(it); };
    S.progress = function (it) { return { done: it.steps || 0, total: Math.max((it.steps || 0) + 1, 3) }; };
    S.live = true;

    wrap('assign', function (id, instr) {
      var it = S.item(id), text = (instr || '').trim();
      return then(decide(it, 'assign', { instructions: text }, 'assign', { instructions: text }), function () { return kick(it); });
    });
    wrap('handToFuzz', function (id) { var it = S.item(id); return then(decide(it, 'assign', {}, 'assign'), function () { return kick(it); }); });
    wrap('attach', function (id, files) { var it = S.item(id); return function () { return upload(it.coreId, files); }; });
    wrap('mine', function (id) { return decide(S.item(id), 'session', undefined, 'session'); });
    wrap('session', function (id) { return decide(S.item(id), 'session', undefined, 'session'); });
    wrap('done', function (id) { return decide(S.item(id), 'done', undefined, 'done'); });
    wrap('markDone', function (id) { return decide(S.item(id), 'done', undefined, 'done'); });
    wrap('park', function (id) { return decide(S.item(id), 'park', undefined, 'park'); });
    wrap('keepParked', function (id) { return decide(S.item(id), 'keep_parked'); });
    wrap('clarify', function (id) { return decide(S.item(id), 'now'); });
    wrap('wait', function (id, who) { return decide(S.item(id), 'wait', who, 'wait', { on: who }); });
    wrap('gotIt', function (id) { return decide(S.item(id), 'got_it'); });
    wrap('keepWaiting', function (id) { return decide(S.item(id), 'keep_waiting'); });
    wrap('nudgeThem', function (id) { var it = S.item(id); return then(decide(it, 'nudge'), function () { return kick(it); }); });
    wrap('theirs', function (id) { return decide(S.item(id), 'someone_else', undefined, 'theirs'); });
    wrap('letGo', function (id) { return decide(S.item(id), 'drop', undefined, 'letgo'); });
    wrap('drop', function (id) { return decide(S.item(id), 'drop', undefined, 'letgo'); });
    /* instr: what Fuzz should look into before it comes back */
    /* text: a draft you edited before Not now, saved first so it comes back as you left it */
    wrap('schedule', function (id, opt, instr, text) {
      var it = S.item(id), a = opt.anchor.type === 'exact' ? { type: 'exact', at: opt.fire_at || opt.anchor.at } : opt.anchor;
      var v = instr ? { anchor: a, instructions: instr } : { anchor: a };
      return then(editFirst(it, text), decide(it, 'schedule', v, 'schedule', v));
    });
    wrap('reopen', function (id) { return decide(S.item(id), null, undefined, 'reopen', { where: 'front' }); });
    wrap('bringBack', function (id, where) { return decide(S.item(id), null, undefined, 'reopen', { where: where === 'front' ? 'front' : 'back' }); });
    wrap('replied', function (id) { return decide(S.item(id), null, undefined, 'reopen', { where: 'front' }); });
    wrap('approve', function (id, text) { var it = S.item(id); return then(editFirst(it, text), decide(it, 'approve')); });
    wrap('accept', function (id, text) { var it = S.item(id); return then(editFirst(it, text), decide(it, 'approve')); });
    wrap('nudgeSent', function (id, text) { var it = S.item(id); return then(editFirst(it, text), decide(it, 'approve')); });
    wrap('revise', function (id, note, text) {
      var it = S.item(id);
      return then(editFirst(it, text), decide(it, 'send_back', note), function () { return kick(it); });
    });
    /* Not now on a question: postpone it in the core too. A task (End of the list) goes to the back of the
       core's queue, a draft you edited saved first. */
    wrap('toBack', function (id, text) {
      var it = S.item(id);
      if (it && QUESTION[it.cardKind] && (it.cardOptions || []).indexOf('not_sure') > -1) return decide(it, 'not_sure');
      return it && it.kind === 'task' && it.coreId ? then(editFirst(it, text), decide(it, null, undefined, 'back')) : null;
    });
    /* The group sheet: the core makes groups; renaming one, taking a task out and wrapping it up are yours */
    function groupCall(g, what, body) { var gid = g && g.coreId; return gid ? function () { return api('POST', '/groups/' + gid + '/' + what, body || {}); } : null; }
    wrap('renameGroup', function (id, title) { return groupCall(S.group(id), 'rename', { title: (title || '').trim() }); });
    wrap('takeOut', function (id) { var it = S.item(id); return groupCall(S.groupOf(it), 'take_out', { task_id: it && it.coreId }); });
    wrap('wrapUp', function (id) { return groupCall(S.group(id), 'wrap'); });
    /* The demo's resolve acts out its own duplicates; here the card just leaves and the core decides */
    S.resolve = function (id, which) {
      var it = S.item(id), q = QUESTION[it.cardKind];
      var opt = q && (which === 'dismissed' ? q.dismissed : (q[which] || [])[0]), note = document.getElementById('note');
      var text = (note && note.value.trim()) || '', value = opt === 'define' ? text || undefined : undefined;
      S.leave(id); it.state = 'resolved'; it.resolution = which;
      if (opt && !quiet) { gen++; write(then(decide(it, opt, value), it.cardKind === 'permission' ? resume(it, text) : null)); }
    };
    /* After a permission answer the task is Fuzz's again: what you typed goes with it, then Fuzz starts */
    function resume(it, text) {
      var tid = it.coreId;
      return then(text ? function () { return api('POST', '/tasks/' + tid + '/assign', { instructions: text }); } : null, function () { return run(tid); });
    }
    /* The core keeps the answer and, for hold_rest, schedules the rest itself */
    var checkin = S.checkin;
    S.checkin = function (answer, followUp) {
      extra = function () { return api('POST', '/checkin', followUp ? { answer: answer, follow_up: followUp } : { answer: answer }); };
      quiet++; try { return checkin.apply(S, arguments); } finally { quiet--; extra = null; }
    };

    /* Capture: in the queue at once, then given its core id */
    var capture = S.capture;
    S.capture = function (text, docs, picked) {
      var it = capture.apply(S, arguments);
      gen++;
      write(function () { return api('POST', '/tasks', { text: (text || '').trim() || undefined, docs: docs || [], uploading: !!(picked && picked.length) }).then(function (r) { rename(it, r.task_id); if (r.gathering) gathering(it); return upload(r.task_id, picked || []); }); });
      return it;
    };
    var parkThought = S.parkThought;
    S.parkThought = function (text) {
      var it = parkThought.apply(S, arguments);
      gen++;
      write(function () { return api('POST', '/tasks', { text: text.trim() }).then(function (r) { rename(it, r.task_id); return api('POST', '/tasks/' + r.task_id + '/park', {}); }); });
      return it;
    };

    /* Undo is the core's. A change remembers its undo group once its writes are in. */
    var track = S.track;
    S.track = function (ids, fn) {
      var mine = [], outer = recording;
      recording = mine;
      try {
        track.call(S, ids, fn);
        /* a check-in's one write joins the change that holds the rest, so Undo reverses both */
        if (extra) { var e = extra; extra = null; gen++; write(e); }
      } finally { recording = outer; }
      if (outer) Array.prototype.push.apply(outer, mine);
      var group = null, failed = false, ready = Promise.all(mine).then(function () {
        return mine.length ? api('GET', '/undo').then(function (r) { var u = (r.recent || []).filter(function (x) { return x.by === 'human'; })[0]; group = u ? u.group : null; if (u) undoBlocked[u.group] = u.blocked; }) : null;
      }, function () { failed = true; });
      return {
        blocked: function () {
          if (failed) return 'That didn’t reach Fuzz, so there’s nothing to undo.';
          return group == null ? null : undoBlocked[group] || null;
        },
        undo: function () {
          if (failed) return 'That didn’t reach Fuzz, so there’s nothing to undo.';
          if (group == null && mine.length) return 'Still saving that. Try again in a moment.';
          if (group != null && undoBlocked[group]) return undoBlocked[group];
          gen++;
          write(function () {
            return ready.then(function () { return group != null ? api('POST', '/undo', { group: group }) : null; });
          }).then(syncThenRefresh, syncThenRefresh);
          return null;
        }
      };
    };
  }

  /* Fuzz looks it up before it reaches triage, so the card waits until the brief is in */
  function gathering(it) {
    var st = Store.get();
    it.state = 'ai-queued'; it.gathering = true;
    st.queue = st.queue.filter(function (q) { return q !== it.id; });
  }
  /* The files you captured it with, one at a time, each filling the name the task was captured with.
     One that fails doesn't stop the rest; the first failure is the one you hear about. */
  function upload(tid, picked) {
    var first = null;
    return picked.reduce(function (p, f) {
      return p.then(function () {
        return fetch('/tasks/' + tid + '/files?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: f }).then(function (r) {
          if (r.ok) return;
          return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error(f.name + ' didn’t upload: ' + (j.error || 'HTTP ' + r.status)); e.status = r.status; throw e; });
        });
      }).catch(function (e) { first = first || e; });
    }, Promise.resolve()).then(function () { if (first) throw first; });
  }
  function rename(it, coreId) {
    var st = Store.get(), old = it.id, id = 't' + coreId;
    if (Store.item(id) && Store.item(id) !== it) { st.items = st.items.filter(function (i) { return i !== it; }); st.queue = st.queue.filter(function (q) { return q !== old; }); return; }
    it.id = id; it.coreId = coreId;
    st.queue = st.queue.map(function (q) { return q === old ? id : q; });
    (st.captured || []).forEach(function (c) { if (c.ref === old) c.ref = id; });
  }

  /* ---------- Start ---------- */
  var Live = {
    on: function () { return on; },
    sync: syncThenRefresh,
    disconnect: function () { forget(); location.reload(); },
    /* Who you are: every email, name and Slack ID that is yours, so Fuzz uses either account without asking */
    saveMe: function (body) { return api('PUT', '/me', body); },
    /* Guided setup (js/setup.js): who you are, the tools Fuzz may use, the folder it may write to */
    setup: function (quick) { return api('GET', '/setup' + (quick ? '?check=0' : '')); },
    discover: function (client) { return api('POST', '/setup/discover', { client: client }); },
    saveTools: function (client, read, send) { return api('PUT', '/setup/tools', { client: client, read: read, send: send }); },
    chooseFolder: function (start) { return api('POST', '/setup/folder/choose', { start: start || null }); },
    saveFolder: function (folder) { return api('PUT', '/setup/folder', { folder: folder || null }); },
    setupDone: function () { return api('POST', '/setup/done', {}); },
    /* The Artifacts tab: what Fuzz wrote in your output folder, and a call whenever the core's events move */
    artifacts: function () { return api('GET', '/artifacts'); },
    /* Finished work older than Lineup shows, by words in its title or summary, newest first */
    searchFinished: function (q) {
      return api('GET', '/tasks/search?q=' + encodeURIComponent(q)).then(function (r) { return r.tasks.map(function (t) { return toItem(t, null, null); }); });
    },
    /* One of those, whole, so its dialog shows the log and sources */
    loadFinished: function (coreId) { return api('GET', '/tasks/' + coreId).then(function (t) { return Store.keepAside(toItem(t, null, null)); }); },
    onEvent: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    /* start runs the app. Live mode waits for the first load so the queue isn't empty for a moment. */
    boot: function (start) {
      if (location.protocol === 'file:' || !readToken()) return start();
      fetch('/health').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (h) {
        if (!h || !h.ok) return start();
        on = true; install(); Store.reset();
        return sync().then(function () {
          if (!on) { location.reload(); return; }
          start(); listen();
        });
      });
    }
  };
  window.Live = Live;
})();
