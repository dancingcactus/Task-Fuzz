/* Schedule options, in the shape the core's API puts on a task card (card.schedule_options):
   { anchor, label, fire_at, source: 'ai' | 'core', reason? }. The core builds them in
   core/fuzz/timeres.py; this is the demo's stand-in, following the same rules, so the Schedule panel
   draws whatever it's given and never keeps a list of its own.
   - up to two moments the AI found first (it.moments): "Before the planning review"
   - then the core's times for how long is left before it's due
   - never one that's already past or lands after the due time; "Pick an exact time" always last
   The rest here (the hint under a button, the glyph and the words on Fuzz's screen) is the UI's. */
(function () {
  var LATER_TODAY_HOUR = 16, PARTS = { morning: 9, afternoon: 13, evening: 17 }, MAX_OPTIONS = 6, MAX_AI = 2;
  var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  var H = 3600000;

  function at(d, hour) { var x = new Date(d); x.setHours(hour, 0, 0, 0); return x; }
  function weekday(d) { return (d.getDay() + 6) % 7; } /* Monday 0, like Python */
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }

  function lead(s) { var m = /^(\d+)([mhdw])$/.exec(s || '1d'); return +m[1] * { m: 60000, h: H, d: 24 * H, w: 168 * H }[m[2]]; }

  /* What an anchor works out to, as a Date; null for at_desk, which comes back when you do. */
  function resolve(a, it, now) {
    var loc = new Date(now);
    if (a.type === 'moment' || a.type === 'exact') return new Date(a.at);
    if (a.type === 'in') return new Date(now + a.minutes * 60000);
    if (a.type === 'at_desk') return null;
    if (a.type === 'later_today') {
      if (loc.getHours() < LATER_TODAY_HOUR - 1) return at(loc, LATER_TODAY_HOUR);
      var t = new Date(now + H);
      return t.getDate() === loc.getDate() && t.getHours() < 22 ? t : undefined;
    }
    if (a.type === 'day_part') {
      var d = loc, day = a.day || 'tomorrow';
      if (day === 'tomorrow') d = addDays(loc, 1);
      else if (day === 'next_week') d = addDays(loc, 7 - weekday(loc) + 1);
      else if (DAYS.indexOf(day) > -1) d = addDays(loc, (DAYS.indexOf(day) - weekday(loc) + 7) % 7 || 7);
      return at(d, PARTS[a.part || 'morning']);
    }
    if (a.type === 'before_due') return it.dueAt ? new Date(it.dueAt - lead(a.lead)) : undefined;
  }

  function label(a) {
    if (a.type === 'in') return a.minutes < 60 ? 'In ' + a.minutes + ' minutes' : 'In an hour';
    if (a.type === 'later_today') return 'Later today';
    if (a.type === 'at_desk') return 'When I’m back at my desk';
    if (a.type === 'day_part') {
      var day = a.day || 'tomorrow', part = a.part || 'morning';
      if (day === 'tomorrow' && part === 'morning') return 'First thing tomorrow';
      if (day === 'next_week') return 'Sometime next week';
      return day.charAt(0).toUpperCase() + day.slice(1) + ' ' + part;
    }
    if (a.type === 'before_due') return { '1h': 'An hour before it’s due', '3h': 'A few hours before it’s due', '1d': 'The day before it’s due', '1w': 'A week before it’s due' }[a.lead || '1d'];
    if (a.type === 'moment') return a.label.charAt(0).toUpperCase() + a.label.slice(1);
    if (a.type === 'exact') return a.at ? fmt(new Date(a.at)) : 'Pick an exact time';
  }

  /* The core's times, from how long is left (the design's table). */
  function timeline(it, now) {
    if (!it.dueAt) return [{ type: 'later_today' }, { type: 'at_desk' }, { type: 'day_part', day: 'monday', part: 'morning' }, { type: 'day_part', day: 'next_week', part: 'morning' }];
    var left = it.dueAt - now;
    if (left < 6 * H) return [{ type: 'in', minutes: 30 }, { type: 'before_due', lead: '1h' }];
    if (left < 48 * H) return [{ type: 'later_today' }, { type: 'at_desk' }, { type: 'day_part', day: 'tomorrow', part: 'morning' }, { type: 'before_due', lead: '3h' }];
    if (left < 168 * H) return [{ type: 'day_part', day: 'tomorrow', part: 'morning' }, { type: 'before_due', lead: '1d' }];
    return [{ type: 'day_part', day: 'next_week', part: 'morning' }, { type: 'before_due', lead: '1w' }];
  }

  function options(it) {
    var now = Date.now(), out = [], seen = {};
    function add(a, source, reason) {
      var t = resolve(a, it, now);
      if (t === undefined || (a.type !== 'at_desk' && !t)) return;
      if (t && (t.getTime() <= now || (it.dueAt && t.getTime() > it.dueAt))) return;
      var lab = label(a); if (seen[lab]) return; seen[lab] = true;
      var o = { anchor: a, label: lab, fire_at: t ? t.toISOString() : null, source: source };
      if (reason) o.reason = reason;
      out.push(o);
    }
    (it.moments || []).filter(function (m) { return !m.cancelled; }).slice(0, MAX_AI).forEach(function (m) {
      add({ type: 'moment', key: m.key, label: m.label, at: m.at }, 'ai', m.reason);
    });
    timeline(it, now).forEach(function (a) { add(a, 'core'); });
    out = out.slice(0, MAX_OPTIONS);
    out.push({ anchor: { type: 'exact' }, label: 'Pick an exact time', fire_at: null, source: 'core' });
    return out;
  }

  function exact(date) { var a = { type: 'exact', at: date.toISOString() }; return { anchor: a, label: label(a), fire_at: a.at, source: 'exact' }; }
  function tomorrowMorning() { var a = { type: 'day_part', day: 'tomorrow', part: 'morning' }; return { anchor: a, label: label(a), fire_at: resolve(a, {}, Date.now()).toISOString(), source: 'core' }; }

  function fmt(d) {
    var today = new Date(), tom = addDays(today, 1), time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return 'Today, ' + time;
    if (d.toDateString() === tom.toDateString()) return 'Tomorrow, ' + time;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + time;
  }

  /* The small line under a button: the AI's reason for a moment, otherwise when it works out to. */
  function hint(o) {
    if (o.reason) return o.reason;
    if (o.anchor.type === 'at_desk') return 'Next time you’re back at your Mac';
    return o.fire_at ? fmt(new Date(o.fire_at)) : '';
  }
  function glyph(o) {
    var a = o.anchor;
    if (a.type === 'at_desk' || (a.type === 'day_part' && (a.part || 'morning') === 'morning')) return 'sun';
    if (a.type === 'later_today' || a.type === 'in') return 'moon';
    return 'cal';
  }
  function osd(o) {
    var a = o.anchor;
    if (a.type === 'at_desk') return 'AT YOUR DESK';
    if (a.type === 'later_today') return 'LATER TODAY';
    if (a.type === 'before_due') return 'BEFORE DUE';
    if (a.type === 'day_part' && a.day === 'next_week') return 'NEXT WEEK';
    if (a.type === 'in') return 'IN ' + a.minutes + ' MIN';
    var d = o.fire_at ? new Date(o.fire_at) : null;
    return d ? (d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '')).toUpperCase() : o.label.toUpperCase().slice(0, 14);
  }

  window.Sched = { options: options, exact: exact, tomorrowMorning: tomorrowMorning, hint: hint, glyph: glyph, osd: osd };
})();
