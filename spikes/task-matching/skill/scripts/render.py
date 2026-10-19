"""Write "Matched Tasks.md" and read your checkbox decisions back out of it.

Each task line ends with <!-- tm:<id> --> (hidden in Obsidian's reading view),
which is how sync() finds it again. Checkbox meanings:
  [ ] open    [x] done    [-] let go    ⏰ YYYY-MM-DD on the line = scheduled
"""

import json
import re
from datetime import datetime

import store
import tasks as tasklib

LINE_RE = re.compile(r"^\s*- \[(.)\] (.*?)<!-- tm:(\d+) -->")
SCHED_RE = re.compile(r"⏰\s*(\d{4}-\d{2}-\d{2})")
LABEL = tasklib.SOURCE_LABEL


def _sources(conn, tid, include_ignored=False):
    rows = conn.execute(
        "SELECT ts.role, ts.withdrawn, g.source, g.link, g.payload FROM task_sources ts "
        "JOIN candidates c ON c.id=ts.candidate_id JOIN signals g ON g.key=c.signal_key "
        "WHERE ts.task_id=? ORDER BY g.ts", (tid,)).fetchall()
    out, seen = [], set()
    for r in rows:
        if r["role"] == "ignored" and not include_ignored:
            continue
        if r["link"] in seen:
            continue
        seen.add(r["link"])
        who = (json.loads(r["payload"]).get("from") or {}).get("name")
        label = LABEL.get(r["source"], r["source"]) + (f" · {who}" if who else "")
        if r["withdrawn"]:
            label += " (deleted)"
        out.append(f"[{label}]({r['link']})" if r["link"] else label)
    return out


def _line(conn, t, note=None, hint=None):
    box = {"done": "x", "dropped": "-"}.get(t["state"], " ")
    parts = [f"- [{box}] **{t['title']}**"]
    if note:
        parts.append(f"— {note}")
    extras = []
    if t["owner"] == "unclear":
        extras.append("owner unclear")
    elif t["owner"] not in ("me", None):
        extras.append(f"owner: {t['owner']}")
    if t["due"]:
        extras.append(f"due {t['due']}")
    if extras:
        parts.append(f"*({', '.join(extras)})*")
    if t["state"] == "scheduled" and t["scheduled_for"]:
        parts.append(f"⏰ {t['scheduled_for']}")
    parts.append(f"`#{t['id']}` <!-- tm:{t['id']} -->")
    src = _sources(conn, t["id"])
    out = " ".join(parts)
    if src:
        out += "\n  " + " · ".join(src)
    if hint:
        out += "\n  " + hint
    return out


def render(conn, run_id, embed_note):
    run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    live = conn.execute("SELECT * FROM tasks WHERE state IN ('open','scheduled') ORDER BY id").fetchall()
    dups = {r["a"]: r for r in conn.execute("SELECT * FROM task_links WHERE kind='possible_duplicate'")}
    sections = {k: [] for k in ("dup", "reopened", "new", "updated", "scheduled", "open")}
    for t in live:
        n_src = len(_sources(conn, t["id"]))
        if t["id"] in dups:
            d = dups[t["id"]]
            other = store.live_task(conn, d["b"])
            if other is None:
                sections["open"].append(_line(conn, t))
                continue
            note = f"looks like **#{other['id']} {other['title']}** ({d['confidence']:.2f}): {d['reason']}"
            hint = (f"→ Tell Copilot “merge {t['id']} into {other['id']}” "
                    f"or “keep {t['id']} and {other['id']} separate”.")
            sections["dup"].append(_line(conn, t, note, hint))
        elif t["reopened_run"] == run_id:
            sections["reopened"].append(_line(conn, t, t["reopened_reason"]))
        elif t["created_run"] == run_id:
            sections["new"].append(_line(conn, t))
        elif t["updated_run"] == run_id:
            latest = conn.execute("SELECT text FROM history WHERE task_id=? AND kind='outside_update' "
                                  "ORDER BY id DESC LIMIT 1", (t["id"],)).fetchone()
            note = f"Merged from {n_src} sources" if n_src > 1 else "Updated"
            if latest:
                note += f" · latest: {latest['text']}"
            sections["updated"].append(_line(conn, t, note))
        elif t["state"] == "scheduled":
            sections["scheduled"].append(_line(conn, t))
        else:
            note = f"{n_src} sources" if n_src > 1 else None
            sections["open"].append(_line(conn, t, note))

    ignored = conn.execute(
        "SELECT d.*, t.title, t.state, g.link, g.source FROM decisions d JOIN candidates c ON c.id=d.candidate_id "
        "JOIN signals g ON g.key=c.signal_key LEFT JOIN tasks t ON t.id=d.task_id "
        "WHERE d.run_id=? AND d.outcome IN ('ignored','discarded','context') ORDER BY d.id", (run_id,)).fetchall()
    stats = conn.execute("SELECT stage, outcome, COUNT(*) n FROM decisions WHERE run_id=? GROUP BY stage, outcome "
                         "ORDER BY stage, outcome", (run_id,)).fetchall()
    pending = conn.execute("SELECT COUNT(*) n FROM candidates WHERE status='pending'").fetchone()["n"]

    out = [f"# Matched Tasks — {datetime.now().strftime('%Y-%m-%d')}", "",
           f"Generated: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z')} · run {run_id} · "
           f"matcher {run['matcher_version']} · {embed_note}", ""]
    for note in json.loads(run["notes"]):
        out.append(f"> ⚠️ {note}")
    if pending:
        out.append(f"> ⏳ {pending} candidate(s) still waiting for the judge (run `tm.py propose` and `apply`).")
    out.append("")
    out.append("Check `[x]` when done, `[-]` to let it go, or add `⏰ YYYY-MM-DD` to schedule. "
               "The next run reads these marks before matching.")
    out.append("")

    def section(title, key, empty):
        out.append(f"## {title}")
        out.append("")
        out.extend(sections[key] or [empty])
        out.append("")

    section("\U0001f500 Possible duplicates", "dup", "None this run.")
    section("\U0001f501 Reopened", "reopened", "Nothing came back.")
    section("\U0001f195 New", "new", "No new tasks.")
    section("✏️ Updated (new information on a task you already had)", "updated", "No updates.")
    section("\U0001f4cb Still open", "open", "Nothing else open.")
    if sections["scheduled"]:
        section("⏰ Scheduled", "scheduled", "")

    out.append("## \U0001f648 Ignored repeats and discarded signals")
    out.append("")
    if not ignored:
        out.append("Nothing was ignored this run.")
    for d in ignored:
        lbl = LABEL.get(d["source"], d["source"])
        target = f" on #{d['task_id']} *{d['title']}*" if d["task_id"] else ""
        link = f" [{lbl}]({d['link']})" if d["link"] else f" {lbl}"
        out.append(f"- **{d['outcome']}**{target}: {d['reason'] or ''}.{link}")
    out.append("")
    out.append("## \U0001f9ee How this run decided")
    out.append("")
    out.append("| Stage | Outcome | Count |")
    out.append("| --- | --- | --- |")
    for s in stats:
        out.append(f"| {s['stage']} | {s['outcome']} | {s['n']} |")
    out.append("")
    return "\n".join(out)


def sync(conn, text):
    """Apply your checkbox marks from the last report. Returns the list of changes made."""
    changes = []
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        box, body, tid = m.group(1).lower(), m.group(2), int(m.group(3))
        t = store.live_task(conn, tid)
        if t is None:
            continue
        sched = SCHED_RE.search(body)
        if box == "x":
            want = ("done", None)
        elif box == "-":
            want = ("dropped", None)
        elif sched:
            want = ("scheduled", sched.group(1))
        else:
            want = ("open", None)
        if (t["state"], t["scheduled_for"] if t["state"] == "scheduled" else None) != want:
            if tasklib.set_state(conn, t["id"], want[0], want[1]):
                changes.append(f"#{t['id']} → {want[0]}" + (f" {want[1]}" if want[1] else ""))
    conn.commit()
    return changes
