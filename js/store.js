/* One in-memory store shared by Triage, Lineup and New task.
   Principles it enforces:
   - assigned work runs in the background, five at a time (6, 1)
   - a handback is a normal state and goes to the end of the queue (2)
   - every change writes a line to the task's "done so far" log (3)
   - nothing is sent until the human approves the draft, and then Fuzz sends it with its own tools (6)
   - every change undoes on its own, the way the core's Undo works: not a stack. A change can't be
     undone once something else has changed the same task since (Fuzz started, it was sent, you moved
     it again), and you're told why (6, 11)
   - projects are made by Fuzz and are only ever a label on their tasks */
(function () {
  var MAX_RUNNING = 5;
  var STEP_MS = 6500;
  var SEND_MS = 3500;
  var state, subs = [], timer = 0, captureN = 0, sentN = 0;
  /* Not part of any project count: cleared cards and dropped tasks */
  var GONE = ['dropped', 'resolved'];
  /* Projects Fuzz has already celebrated, so a wrap-up is only cheered once */
  var celebrated = {};

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clock() { return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function emit(evt) { subs.slice().forEach(function (fn) { fn(evt || { type: 'change' }); }); }

  var S = {
    MAX_RUNNING: MAX_RUNNING,
    clock: clock,

    reset: function () {
      state = Demo.build();
      state.moment = 'any';
      state.maxOrder = state.items.length;
      state.minOrder = 0;
      captureN = 0; sentN = 0; celebrated = {}; state.checkins = [];
      /* drafts already waiting for your OK start out in the queue too */
      S.inState('review').forEach(function (it) { S.queueUp(it, 'back'); });
      S.sortQueue();
      emit({ type: 'reset' });
    },
    get: function () { return state; },
    /* What Fuzz has sent for you this session, for the recap */
    sentCount: function () { return sentN; },
    on: function (fn) { subs.push(fn); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; },
    emit: emit,

    item: function (id) { return state.items.filter(function (i) { return i.id === id; })[0]; },
    /* Steps Fuzz has done out of those planned, for the progress dots in Lineup */
    progress: function (it) { var sc = it.script || generic(it); return { done: Math.min(it.workStep || 0, sc.steps.length), total: sc.steps.length }; },
    inState: function () {
      var want = Array.prototype.slice.call(arguments);
      return state.items.filter(function (i) { return want.indexOf(i.state) > -1; });
    },
    queue: function () { return state.queue.map(S.item).filter(Boolean); },
    front: function () { return S.item(state.queue[0]); },
    running: function () { return S.inState('ai').length; },

    stats: function () {
      return {
        waiting: state.queue.length,
        withFuzz: S.inState('ai', 'ai-queued').length,
        inClaude: S.inState('session').length,
        later: S.inState('scheduled').length,
        done: S.inState('done').length
      };
    },

    /* Run fn as one undoable change to these items. Returns { undo(), blocked() }: undo puts back what
       fn changed and returns null, or returns why it can't (something changed the same items since).
       Like the core: the log only grows, so undoing adds a line rather than removing fn's. */
    track: function (ids, fn) {
      ids = ids.filter(function (id, i) { return S.item(id) && ids.indexOf(id) === i; });
      var before = ids.map(function (id) { return { item: clone(S.item(id)), queued: S.inQueue(id), logAt: S.item(id).log.length }; });
      var m0 = state.moment, n0 = state.items.length, p0 = projectsById();
      fn();
      var after, logAt, m1 = state.moment;
      /* Tasks the change made (a duplicate that became its own task) and projects it touched undo with it */
      var made = state.items.slice(n0).map(function (i) { return i.id; }), madeAt, p1 = projectsById();
      var pids = Object.keys(Object.assign({}, p0, p1)).filter(function (k) { return p0[k] !== p1[k]; });
      function settle() {
        after = ids.map(function (id) { return fingerprint(S.item(id)); });
        logAt = ids.map(function (id) { return S.item(id).log.length; });
        madeAt = made.map(function (id) { return fingerprint(S.item(id)); });
        p1 = projectsById();
      }
      settle();
      var ch = {
        blocked: function () {
          for (var i = 0; i < ids.length; i++) {
            var it = S.item(ids[i]);
            if (fingerprint(it) === after[i]) continue;
            var newer = it.log.slice(0, it.log.length - logAt[i]);
            if (newer.some(function (l) { return l.kind === 'sent'; })) return 'It’s already been sent, so it can’t be undone.';
            if (['ai', 'sending'].indexOf(it.state) > -1 || newer.some(function (l) { return ['research', 'action', 'blocked'].indexOf(l.kind) > -1; }))
              return 'Fuzz has already worked on this since, so it can’t be undone. Bring it back from Lineup instead.';
            return 'You changed this since. Undo that first.';
          }
          for (var j = 0; j < made.length; j++) if (S.item(made[j]) && fingerprint(S.item(made[j])) !== madeAt[j]) return 'You changed “' + S.item(made[j]).title + '” since. Undo that first.';
          var pn = projectsById();
          if (pids.some(function (k) { return pn[k] !== p1[k]; })) return 'You changed that project since. Undo that first.';
          if (m1 !== m0 && state.moment !== m1) return 'You answered another check-in since. Undo that first.';
          return null;
        },
        undo: function () {
          var why = ch.blocked(); if (why) return why;
          before.forEach(function (b, i) {
            var cur = S.item(b.item.id), log = cur.log, back = clone(b.item);
            /* the lines this change wrote stay, marked undone (newest first, so they sit above what came before) */
            log.slice(log.length - logAt[i], log.length - b.logAt).forEach(function (l) { l.undone = true; });
            back.log = log; Object.keys(cur).forEach(function (k) { delete cur[k]; }); Object.assign(cur, back);
            if (b.queued && !S.inQueue(cur.id)) state.queue.push(cur.id);
            if (!b.queued && S.inQueue(cur.id)) { S.leave(cur.id); state.totalEver--; }
            S.log(cur, 'status', 'You undid that.'); cur.log[0].undo = true;
          });
          made.forEach(function (id) { if (S.inQueue(id)) { S.leave(id); state.totalEver--; } state.items = state.items.filter(function (i) { return i.id !== id; }); });
          made = [];
          pids.forEach(function (k) {
            state.projects = state.projects.filter(function (p) { return p.id !== k; });
            if (p0[k]) state.projects.push(JSON.parse(p0[k]));
          });
          if (m1 !== m0) state.moment = m0;
          settle();
          S.sortQueue(); emit({ type: 'restore' });
          return null;
        }
      };
      return ch;
    },

    log: function (item, kind, text) { item.log.unshift({ kind: kind, time: clock(), text: text }); },

    /* ---- queue ---- */
    sortQueue: function () {
      var m = state.moment;
      function fits(it) {
        if (m === 'quick') return (it.mins || 1) <= 5; /* entity, duplicate and review cards take seconds */
        if (m === 'low') return it.energy === 'low';
        return true;
      }
      state.queue.sort(function (a, b) {
        var x = S.item(a), y = S.item(b);
        var kx = [x.dueAt ? 0 : 1, x.handedBack ? 1 : 0, fits(x) ? 0 : 1, x.order];
        var ky = [y.dueAt ? 0 : 1, y.handedBack ? 1 : 0, fits(y) ? 0 : 1, y.order];
        for (var i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] - ky[i];
        return 0;
      });
    },
    setMoment: function (m) { state.moment = m; S.sortQueue(); emit({ type: 'moment' }); },
    toBack: function (id) { var it = S.item(id); it.order = ++state.maxOrder; S.sortQueue(); },
    enqueue: function (it, where) { it.state = 'triage'; S.queueUp(it, where); },
    /* Into the triage queue without changing state: a draft waiting for your OK stays "review". */
    queueUp: function (it, where) {
      it.order = where === 'front' ? --state.minOrder : ++state.maxOrder;
      if (state.queue.indexOf(it.id) < 0) { state.queue.push(it.id); state.totalEver++; }
      S.sortQueue();
    },
    inQueue: function (id) { return state.queue.indexOf(id) > -1; },
    leave: function (id) { state.queue = state.queue.filter(function (q) { return q !== id; }); },

    /* ---- decisions from triage ---- */
    assign: function (id, instructions) {
      var it = S.item(id);
      S.leave(id);
      if (instructions && instructions.trim() && instructions.trim() !== (it.hint || '').trim()) {
        S.log(it, 'guidance', 'You said: ' + instructions.trim());
      }
      it.instr = instructions;
      it.handedBack = false; it.askBack = null;
      it.workStep = 0; it.nextAt = Date.now() + 4500;
      it.stage = 'fresh';
      var wait = S.running() >= MAX_RUNNING;
      it.state = wait ? 'ai-queued' : 'ai';
      it.queuedAt = Date.now();
      S.log(it, 'status', wait ? 'You assigned this to Fuzz. Five tasks are already running, so it is next up.' : 'You assigned this to Fuzz.');
      return wait;
    },
    /* You take it yourself (a handback answered "I'll find it"): it leaves triage and waits with you, under Yours in Lineup. */
    mine: function (id, note) {
      var it = S.item(id); S.leave(id);
      it.handedBack = false; it.askBack = null; it.state = 'mine'; it.now = 'Sources kept ready for you';
      S.log(it, 'guidance', 'You said: ' + note);
      S.log(it, 'status', 'You took this one yourself. Fuzz keeps the sources ready.');
    },
    done: function (id) { var it = S.item(id); S.leave(id); it.state = 'done'; it.doneAgo = 'Just now'; it.now = 'Marked done by you'; S.log(it, 'status', 'You marked this done.'); wrapCheck(it); },
    session: function (id) { var it = S.item(id); S.leave(id); it.state = 'session'; it.now = 'Open in Claude'; S.log(it, 'status', 'You opened this in a working session with Claude. Fuzz keeps the sources ready.'); },
    /* opt is one of S.scheduleOptions(it), or an exact time: the core's Schedule options, as the API sends them */
    schedule: function (id, opt) {
      var it = S.item(id), when = lowerFirst(opt.label); S.leave(id);
      it.state = 'scheduled'; it.scheduleAnchor = opt.anchor; it.scheduledFor = when; it.now = 'Back ' + when;
      S.log(it, 'status', 'You scheduled this: ' + when + '.');
    },
    scheduleOptions: function (it) { return Sched.options(it); },
    /* The UI decides when to ask how you're doing; the answer is kept (POST /checkin in the core) and sets
       the moment. hold_rest schedules what isn't time-sensitive for tomorrow morning, as one change. */
    checkin: function (answer, followUp) {
      var moment = followUp === 'quick_first' ? 'quick' : { good: 'any', okay: 'any', tired: 'low', overloaded: 'quick' }[answer];
      var held = followUp === 'hold_rest' ? S.queue().filter(function (i) { return i.kind === 'task' && !i.dueAt; }) : [];
      var ch = S.track(held.map(function (i) { return i.id; }), function () {
        state.checkins.unshift({ answer: answer, followUp: followUp || null, moment: moment, at: Date.now() });
        state.moment = moment;
        held.forEach(function (i) { S.schedule(i.id, Sched.tomorrowMorning()); });
        S.sortQueue();
      });
      emit({ type: 'moment' });
      return { change: ch, held: held.length };
    },
    park: function (id) { var it = S.item(id); S.leave(id); it.state = 'parked'; it.woke = false; it.parkedAgo = 'Today'; it.now = ''; S.log(it, 'status', 'You parked this from triage.'); },
    wait: function (id) { var it = S.item(id); S.leave(id); it.state = 'waiting'; it.waitingOn = it.who || 'Someone'; it.waitedFor = 'Today'; it.nextCheck = 'Tomorrow morning'; S.log(it, 'status', 'You moved this to Waiting on others. Fuzz watches for the reply.'); },
    letGo: function (id) { var it = S.item(id); S.leave(id); it.state = 'letgo'; it.doneAgo = 'Today'; it.now = 'Let go from triage'; S.log(it, 'status', 'You let this go.'); wrapCheck(it); },
    drop: function (id) { var it = S.item(id); S.leave(id); it.state = 'dropped'; S.log(it, 'status', 'You dropped this.'); wrapCheck(it); },
    /* A duplicate card's answers: primary, Same goal, separate tasks; secondary, Merge; third, Keep separate */
    resolve: function (id, which) {
      var it = S.item(id); S.leave(id); it.state = 'resolved'; it.resolution = which;
      var t = it.kind === 'dup' && S.item(it.dupOf);
      if (t && which === 'secondary') { S.log(t, 'status', 'Merged with a Slack message from ' + it.who + '. It is now a source on this task. Reason: same person and the same Q4 results doc.'); t.sources.push({ type: 'Slack', title: 'Priya: Q4 summary deck request' }); t.updated = true; }
      if (t && which === 'primary') S.group(it, t);
    },

    /* ---- projects ----
       Fuzz groups tasks that share a goal. A project has no queue, no card and no progress bar of its own:
       it shows up as a "Part of …" line on its tasks, and closes on its own when they are all finished. */
    project: function (id) { return (state.projects || []).filter(function (p) { return p.id === id; })[0] || null; },
    projectOf: function (it) { return it && it.project ? S.project(it.project) : null; },
    projectTasks: function (p) { return state.items.filter(function (i) { return i.project === p.id && GONE.indexOf(i.state) < 0; }); },
    /* Counts what's done, never what's left. Let-go tasks leave the count. */
    projectCount: function (p) {
      var all = S.projectTasks(p).filter(function (i) { return i.state !== 'letgo'; });
      return { done: all.filter(function (i) { return i.state === 'done'; }).length, total: all.length };
    },
    projectFinished: function (p) { var c = S.projectCount(p); return p.closed || (c.total > 0 && c.done === c.total); },
    /* The line a card or row shows: "Part of Q4 readout for Priya · 1 of 2 done" */
    partOf: function (it, withCount) {
      var p = S.projectOf(it); if (!p) return '';
      if (!withCount) return 'Part of ' + p.title;
      var c = S.projectCount(p);
      return 'Part of ' + p.title + ' · ' + (S.projectFinished(p) ? 'wrapped up' : c.done ? c.done + ' of ' + c.total + ' done' : c.total + ' tasks');
    },
    /* "Same goal, separate tasks": the new ask becomes its own task, and both share one project
       that takes the sooner deadline. */
    group: function (dup, t) {
      var p = S.projectOf(t);
      if (!p) {
        p = { id: 'p' + (++captureN), title: dup.goal.title, doneWhen: dup.goal.doneWhen, due: t.due ? t.due.label : '' };
        state.projects.push(p); t.project = p.id;
      }
      var it = Object.assign({ id: dup.id + '-task', kind: 'task', state: 'triage', title: dup.title, source: dup.source, who: dup.who, age: dup.age, stage: 'fresh',
        project: p.id, due: t.due, isNew: false, log: [], context: [], conversation: [], code: [] }, clone(dup.asTask));
      state.items.push(it);
      S.log(it, 'status', 'Fuzz made this its own task, part of ' + p.title + '.');
      S.log(t, 'status', 'Fuzz put this together with “' + it.title + '” under ' + p.title + '.');
      S.enqueue(it, 'back');
      return p;
    },
    renameProject: function (id, title) { var p = S.project(id); if (p && title && title.trim()) p.title = title.trim(); },
    /* Take a task out. A project of one isn't a project, so the last task left stands on its own. */
    takeOut: function (id) {
      var it = S.item(id), p = S.projectOf(it); if (!p) return;
      it.project = null; S.log(it, 'status', 'You took this out of ' + p.title + '.');
      var left = S.projectTasks(p);
      if (left.length === 1) { left[0].project = null; S.log(left[0], 'status', p.title + ' had only this task left, so it stands on its own now.'); p.closed = true; return 'dissolved'; }
    },
    wrapUp: function (id) {
      var p = S.project(id); if (!p) return;
      p.closed = true;
      S.projectTasks(p).forEach(function (i) { S.log(i, 'status', 'You said ' + p.title + ' is wrapped up.'); });
    },

    /* ---- movement between lists ---- */
    bringBack: function (id, where) { var it = S.item(id); S.log(it, 'status', where === 'front' ? 'Pulled back into triage.' : 'Moved back into triage, at the end of the queue.'); it.handedBack = false; S.enqueue(it, where); },
    handToFuzz: function (id) {
      var it = S.item(id);
      it.workStep = 0; it.nextAt = Date.now() + 4500; it.instr = it.instr || it.hint || '';
      it.state = S.running() >= MAX_RUNNING ? 'ai-queued' : 'ai'; it.queuedAt = Date.now();
      S.log(it, 'status', 'You handed this to Fuzz.');
    },
    /* Who a draft goes to and how. A draft for you alone (a finding, a parked thought) has no recipient. */
    recipient: function (it) {
      if (it.sendTo) return it.sendTo;
      if (!it.who || it.who === 'You' || ['Email', 'Slack'].indexOf(it.source) < 0) return null;
      return { to: it.who, via: it.source };
    },
    editDraft: function (it, text) {
      if (text == null || text === it.draft) return;
      it.draft = text; S.log(it, 'guidance', 'You edited the draft.');
    },
    /* Approved: Fuzz's sender sends it with its own connector tools, in a moment. Until then it can be undone. */
    approve: function (id, text) {
      var it = S.item(id), r = S.recipient(it);
      S.leave(id); S.editDraft(it, text);
      it.state = 'sending'; it.sendKind = 'draft'; it.sendAt = Date.now() + SEND_MS; it.now = 'Sending to ' + (r ? r.to : 'its recipient');
      S.log(it, 'status', 'You approved the draft. Fuzz will send it' + (r ? ' to ' + r.to + ' (' + r.via + ')' : '') + '.');
    },
    /* A draft that goes nowhere: approving it just files it, so it can be undone. */
    accept: function (id, text) {
      var it = S.item(id);
      S.leave(id); S.editDraft(it, text);
      /* Prep for a step still ahead files the note and waits for that step; the core says when */
      if (it.prep) { it.state = 'scheduled'; it.now = it.afterApprove || 'Waiting for the next step'; S.log(it, 'status', 'You approved the prep. ' + (it.afterApprove || '')); return; }
      it.state = 'done'; it.doneAgo = 'Just now'; it.now = 'Approved by you';
      S.log(it, 'status', 'You approved this.');
      wrapCheck(it);
    },
    revise: function (id, note, text) {
      var it = S.item(id);
      S.leave(id); S.editDraft(it, text);
      S.log(it, 'guidance', 'You asked for changes: ' + note); it.revisedNote = note;
      it.script = { steps: [['action', 'Reworked the draft: ' + note.replace(/[.!\s]*$/, '') + '.']], ending: { type: 'review' } };
      it.workStep = 0; it.nextAt = Date.now() + 4500; it.now = 'Changing the draft';
      it.state = S.running() >= MAX_RUNNING ? 'ai-queued' : 'ai'; it.queuedAt = Date.now();
    },
    markDone: function (id) { var it = S.item(id); it.state = 'done'; it.doneAgo = 'Just now'; it.now = 'Marked done by you'; S.log(it, 'status', 'You marked this done.'); wrapCheck(it); },
    replied: function (id) { var it = S.item(id); S.log(it, 'status', 'A reply came in. Back in triage with the reply attached.'); it.updated = true; S.enqueue(it, 'front'); },
    nudgeSent: function (id, text) {
      var it = S.item(id); S.editDraft(it, text);
      it.state = 'sending'; it.sendKind = 'nudge'; it.sendAt = Date.now() + SEND_MS; it.nudge = false; it.now = 'Sending the nudge';
      S.log(it, 'status', 'You approved the nudge. Fuzz will send it.');
    },
    reopen: function (id) { var it = S.item(id); S.log(it, 'status', 'You brought this back.'); S.enqueue(it, 'front'); },

    /* ---- capture ---- */
    capture: function (text, docs) {
      docs = docs || [];
      var t = (text || '').trim();
      var title = t || docs[0];
      var id = 'cap' + (++captureN);
      var it = {
        id: id, kind: 'task', state: 'triage', title: title, source: 'Captured by you', who: 'You',
        age: 'Just now', stage: 'fresh', mins: 5, energy: 'normal', capturedAt: Date.now(), isNew: true,
        incoming: docs.length ? 'You captured this with ' + docs.length + (docs.length === 1 ? ' document' : ' documents') + ' attached. Fuzz is reading ' + (docs.length === 1 ? 'it' : 'them') + ' with your note.' : 'You captured this a moment ago. Nothing else is known yet.',
        ask: 'Want Fuzz to start on this?',
        hint: 'Look into: ' + title + '. Gather what you need and show me what you found before doing anything.',
        aiHeading: 'What Fuzz did', aiNote: 'I tidied your note and suggested instructions. Edit anything.',
        firstStep: 'Write one sentence about what “done” looks like.',
        log: [], sources: docs.map(function (d) { return { type: 'Doc', title: d }; }), context: [], conversation: []
      };
      state.items.push(it);
      S.log(it, 'status', 'You captured this task.');
      S.enqueue(it, 'back');
      state.captured.unshift({ text: title, ref: id, doc: !t && docs.length > 0, time: 'Just now' });
      emit({ type: 'capture', item: it });
      return it;
    },
    parkThought: function (text) {
      var id = 'thought' + (++captureN);
      var it = {
        id: id, kind: 'task', state: 'parked', title: text.trim(), source: 'Parked thought', who: 'You', age: 'Just now', stage: 'fresh', parkedAgo: 'Just now', now: '', mins: 5, energy: 'normal', order: ++state.maxOrder,
        incoming: 'A stray thought you parked without leaving what you were doing.', aiNote: 'Parked with no date. Fuzz will only speak up if something new comes in about it.',
        log: [], sources: [], context: [], conversation: []
      };
      S.log(it, 'status', 'You parked this thought.');
      state.items.push(it);
      emit({ type: 'park', item: it });
      return it;
    },

    /* ---- Fuzz working in the background ---- */
    startWork: function () { if (!timer) timer = setInterval(tick, 1000); },
    nowText: function (it) {
      if (it.state === 'ai-queued') return 'Next up, waiting for a free slot';
      if (it.state === 'sending') return it.now || 'Sending';
      if (it.state === 'ai') { var l = it.log[0]; return l && l.kind !== 'status' ? l.text : (it.now || 'Getting started'); }
      return it.now || '';
    }
  };

  /* When the last open task in a project finishes, the project closes on its own and Fuzz celebrates.
     The event waits a moment so it lands after the card has left. */
  function wrapCheck(it) {
    var p = S.projectOf(it);
    if (!p || p.closed || celebrated[p.id] || !S.projectFinished(p)) return;
    celebrated[p.id] = true;
    setTimeout(function () { if (S.project(p.id) && S.projectFinished(S.project(p.id))) emit({ type: 'wrapped', project: S.project(p.id) }); }, 1800);
  }
  /* Each project as JSON, by id, so a change can tell which projects it touched */
  function projectsById() { var o = {}; (state.projects || []).forEach(function (p) { o[p.id] = JSON.stringify(p); }); return o; }

  function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  /* What decides whether a change still undoes: everything about the item but its log, plus whether it's in the queue. */
  function fingerprint(it) { var c = clone(it); delete c.log; c.queued = S.inQueue(it.id); return JSON.stringify(c); }

  /* Fuzz's sender: sends what you approved, with its own connector, then says so. Sent can't be undone. */
  function send(it) {
    var r = it.sendKind === 'nudge' ? { to: it.waitingOn || 'them', via: it.source } : S.recipient(it);
    if (it.sendKind === 'nudge') { it.state = 'waiting'; it.nextCheck = 'Nudge sent, checking tomorrow'; it.now = ''; }
    else { it.state = 'done'; it.doneAgo = 'Just now'; it.now = 'Sent with your OK'; }
    it.sendAt = 0; sentN++;
    S.log(it, 'sent', (it.sendKind === 'nudge' ? 'Sent the follow-up nudge' : 'Sent') + (r ? ' to ' + r.to + ' (' + r.via + ')' : '') + ' after you approved it.');
    if (it.state === 'done') wrapCheck(it);
    emit({ type: 'sent', item: it });
  }

  function generic(it) {
    return {
      steps: [
        ['research', ['Email', 'Slack', 'Meeting'].indexOf(it.source) > -1 ? 'Read the original ' + (it.source === 'Meeting' ? 'meeting notes' : it.source === 'Email' ? 'email' : 'Slack thread') + ' and your instructions.' : 'Read your note and your instructions.'],
        ['research', 'Looked for related tasks, people and documents.' + (it.sources[0] ? ' Opened “' + it.sources[0].title + '”.' : '')],
        ['action', 'Drafted the next step from your instructions.']
      ],
      ending: { type: 'review' }
    };
  }

  function finish(it, end) {
    end = end || { type: 'review' };
    if (end.type === 'handback') {
      it.askBack = end.ask; it.quick = end.quick || null; it.handedBack = true;
      /* the earlier instructions may have guessed the answer; show the neutral version while you decide */
      if (end.hint) it.instr = end.hint;
      it.meta = (it.source || 'Task') + ' · handed back just now';
      S.log(it, 'blocked', end.log || 'Could not go further without you.');
      S.log(it, 'status', 'Handed back to you. It joined the end of your queue.');
      S.enqueue(it, 'back');
      emit({ type: 'handback', item: it });
    } else {
      it.state = 'review'; it.now = 'Draft ready to review';
      /* the in-progress note would freeze here; say what was done instead */
      it.aiHeading = 'What Fuzz did'; it.aiNote = it.doneNote || 'Worked through it from your instructions. Every step is under Done so far.';
      if (!it.draft) it.draft = 'Draft for “' + it.title + '”, based on your instructions: ' + (it.instr || it.hint || '') ;
      S.log(it, 'action', 'The draft is ready. Nothing is sent until you approve it.');
      /* It joins the triage queue as its own card, at the back, like a handback. */
      S.queueUp(it, 'back');
      emit({ type: 'review', item: it });
    }
  }

  function tick() {
    if (!state) return;
    var t = Date.now(), moved = false;
    state.items.forEach(function (it) { if (it.state === 'sending' && it.sendAt && t >= it.sendAt) { send(it); moved = true; } });
    state.items.forEach(function (it) {
      if (it.state !== 'ai' || t < (it.nextAt || 0)) return;
      var sc = it.script || generic(it);
      var step = sc.steps[it.workStep || 0];
      if (step) {
        S.log(it, step[0], step[1]);
        it.workStep = (it.workStep || 0) + 1;
        it.nextAt = t + STEP_MS + Math.random() * 2500;
        moved = true;
      } else {
        finish(it, sc.ending);
        moved = true;
      }
    });
    state.items.filter(function (i) { return i.state === 'ai-queued'; })
      .sort(function (a, b) { return a.queuedAt - b.queuedAt; })
      .forEach(function (it) {
        if (S.running() < MAX_RUNNING) { it.state = 'ai'; it.nextAt = t + 4000; S.log(it, 'status', 'A slot opened up, so Fuzz started on this.'); moved = true; }
      });
    if (moved) emit({ type: 'work' });
  }

  window.Store = S;
})();
