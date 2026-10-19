"""Task records: create, attach, the state rules for repeat signals, and merge / split / keep.

Every change goes through record() so it is logged in `decisions` with the stage,
the scores, the reason and MATCHER_VERSION.
"""

import json

import store

MERGE_CONF = 0.85   # judge says same with at least this: merge
DUP_CONF = 0.60     # judge says same with at least this (but under MERGE_CONF): possible duplicate

SOURCE_LABEL = {"email": "Email", "slack": "Slack", "meeting": "Meeting", "calendar": "Calendar"}


def _signal(conn, cand):
    row = conn.execute("SELECT payload FROM signals WHERE key=?", (cand["signal_key"],)).fetchone()
    return json.loads(row["payload"])


def _is_other(cand):
    return cand["owner"] not in ("me", "unclear", None)


def record(ctx, cand, stage, outcome, task_id=None, other_task_id=None, verdict=None,
           confidence=None, reason=None, scores=None, new_title=None):
    """Log a decision for one candidate and apply its effect. Returns {"outcome": ...}."""
    import matcher  # MATCHER_VERSION lives there
    conn = ctx.conn
    if outcome == "merged" and _is_other(cand):
        outcome = "context"
    if outcome == "update" and task_id is not None:
        t = store.live_task(conn, task_id)
        if t["state"] in ("done", "dropped"):
            outcome = "ignored"
            reason = (reason or "") + f" (task is {t['state']}, no new ask)"
    cur = conn.execute(
        "INSERT INTO decisions (run_id, candidate_id, stage, outcome, task_id, other_task_id, verdict, "
        "confidence, reason, scores, matcher_version, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ctx.run_id, cand["id"], stage, outcome, task_id, other_task_id, verdict, confidence, reason,
         json.dumps(scores or {}), matcher.MATCHER_VERSION, store.now()))
    did = cur.lastrowid
    run = ctx.run_id
    if outcome in ("new", "possible_duplicate", "related"):
        tid = create_task(conn, cand, run, did)
        conn.execute("UPDATE decisions SET task_id=?, other_task_id=? WHERE id=?",
                     (tid, task_id if outcome != "new" else None, did))
        if outcome != "new" and task_id is not None:
            conn.execute("INSERT OR REPLACE INTO task_links VALUES (?,?,?,?,?)",
                         (tid, task_id, outcome, confidence, reason))
            store.add_history(conn, tid, "link",
                              ("Possible duplicate of" if outcome == "possible_duplicate" else "Related to")
                              + f" #{task_id}: {reason}", did)
    elif outcome in ("merged", "update"):
        attach(conn, task_id, cand, "update", run, did)
        if new_title:
            retitle(conn, task_id, new_title)
    elif outcome == "context":
        attach(conn, task_id, cand, "context", run, did)
    elif outcome == "ignored":
        attach(conn, task_id, cand, "ignored", run, did)
    elif outcome in ("reopened", "resurfaced"):
        attach(conn, task_id, cand, "update", run, did)
        s = _signal(conn, cand)
        who = (s.get("from") or {}).get("name") or "Someone"
        why = (f"Reopened: {who} asked something new after you marked this done"
               if outcome == "reopened" else f"Back: {who} asked again after you dropped this")
        reopen(conn, task_id, why, run, did)
    conn.execute("UPDATE candidates SET status='decided' WHERE id=?", (cand["id"],))
    return {"outcome": outcome, "decision_id": did}


def create_task(conn, cand, run_id, decision_id):
    s = _signal(conn, cand)
    title = (cand["ask"] or s.get("quote") or "Untitled").strip()
    if len(title) > 140:
        title = title[:137] + "..."
    owner = cand["owner"] or "me"
    cur = conn.execute(
        "INSERT INTO tasks (state, title, owner, due, state_changed_at, created_run, created_at, updated_at) "
        "VALUES ('open',?,?,?,?,?,?,?)", (title, owner, cand["due"], store.now(), run_id, store.now(), store.now()))
    tid = cur.lastrowid
    conn.execute("INSERT INTO task_sources (task_id, candidate_id, role, added_run) VALUES (?,?,?,?)",
                 (tid, cand["id"], "origin", run_id))
    _add_anchors(conn, tid, cand)
    note = f"Created from {SOURCE_LABEL.get(s['source'], s['source'])}"
    if (s.get("from") or {}).get("name"):
        note += f" ({s['from']['name']})"
    if owner == "unclear":
        note += ". Owner unclear, left unassigned"
    store.add_history(conn, tid, "created", note, decision_id)
    return tid


def _add_anchors(conn, tid, cand):
    import matcher
    for _, a in matcher.candidate_anchors(conn, cand):
        conn.execute("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (a, tid))


def attach(conn, task_id, cand, role, run_id, decision_id):
    t = store.live_task(conn, task_id)
    tid = t["id"]
    conn.execute("INSERT OR IGNORE INTO task_sources (task_id, candidate_id, role, added_run) VALUES (?,?,?,?)",
                 (tid, cand["id"], role, run_id))
    _add_anchors(conn, tid, cand)
    s = _signal(conn, cand)
    who = (s.get("from") or {}).get("name") or "Someone"
    where = SOURCE_LABEL.get(s["source"], s["source"])
    text = f"{who} in {where}: “{(s.get('quote') or cand['ask'] or '').strip()[:160]}”"
    kind = {"update": "outside_update", "context": "context", "ignored": "ignored_repeat"}[role]
    store.add_history(conn, tid, kind, text, decision_id)
    if role != "update":
        return
    if t["state"] in ("open", "scheduled"):
        conn.execute("UPDATE tasks SET updated_run=?, updated_at=? WHERE id=?", (run_id, store.now(), tid))
    due = cand["due"]
    if due and (not t["due"] or due < t["due"]):
        conn.execute("UPDATE tasks SET due=? WHERE id=?", (due, tid))
    if t["state"] == "scheduled" and due and t["scheduled_for"] and due < t["scheduled_for"]:
        conn.execute("UPDATE tasks SET state='open', state_changed_at=? WHERE id=?", (store.now(), tid))
        store.add_history(conn, tid, "state", f"Pulled forward: new deadline {due} is before {t['scheduled_for']}",
                          decision_id)


def reopen(conn, task_id, reason, run_id, decision_id=None):
    conn.execute("UPDATE tasks SET state='open', state_changed_at=?, reopened_run=?, reopened_reason=?, "
                 "updated_at=? WHERE id=?", (store.now(), run_id, reason, store.now(), task_id))
    store.add_history(conn, task_id, "state", reason, decision_id)


def retitle(conn, task_id, title):
    t = store.live_task(conn, task_id)
    if title.strip() == t["title"]:
        return
    hist = json.loads(t["title_history"]) + [t["title"]]
    conn.execute("UPDATE tasks SET title=?, title_history=? WHERE id=?", (title.strip(), json.dumps(hist), t["id"]))
    store.add_history(conn, t["id"], "retitle", f"Title was: {t['title']}")


def apply_verdicts(ctx, verdicts):
    """Stage 4: turn the judge's verdicts into outcomes, honouring task state (doc, "Task states and suppression")."""
    conn = ctx.conn
    stats = {}
    for v in verdicts:
        cand = conn.execute("SELECT * FROM candidates WHERE id=?", (v["candidate_id"],)).fetchone()
        if cand is None or cand["status"] != "pending":
            stats["skipped"] = stats.get("skipped", 0) + 1
            continue
        verdict = v.get("verdict", "new")
        conf = float(v.get("confidence", 0))
        target = store.live_task(conn, v["task_id"]) if v.get("task_id") is not None else None
        other = _is_other(cand)
        tid = target["id"] if target else None
        if verdict == "same" and target and conf >= DUP_CONF:
            st = target["state"]
            if st == "done":
                outcome = "reopened" if v.get("new_ask") else "ignored"
            elif st == "dropped":
                ts = _signal(conn, cand).get("ts") or ""
                outcome = "resurfaced" if v.get("new_ask") and ts > (target["state_changed_at"] or "") else "ignored"
            elif conf >= MERGE_CONF:
                outcome = "merged"
            else:
                outcome = "discarded" if other else "possible_duplicate"
        elif verdict == "related" and target:
            outcome = "context" if other else "related"
        else:
            outcome, tid = ("discarded", None) if other else ("new", None)
        res = record(ctx, cand, "judge", outcome, tid, verdict=verdict, confidence=conf,
                     reason=v.get("reason"), scores={"judge": conf}, new_title=v.get("new_title"))
        stats[res["outcome"]] = stats.get(res["outcome"], 0) + 1
    conn.commit()
    return stats


# ---------------------------------------------------------------- your decisions

def set_state(conn, task_id, state, scheduled_for=None):
    t = store.live_task(conn, task_id)
    if t is None:
        raise SystemExit(f"No task #{task_id}")
    if t["state"] == state and t["scheduled_for"] == scheduled_for:
        return False
    conn.execute("UPDATE tasks SET state=?, scheduled_for=?, state_changed_at=?, updated_at=? WHERE id=?",
                 (state, scheduled_for, store.now(), store.now(), t["id"]))
    label = {"done": "Marked done", "dropped": "Let go", "open": "Back in the list",
             "scheduled": f"Scheduled for {scheduled_for}"}[state]
    store.add_history(conn, t["id"], "state", label)
    return True


def _creation_decision(conn, task_id):
    row = conn.execute("SELECT decision_id FROM history WHERE task_id=? AND kind='created' ORDER BY id LIMIT 1",
                       (task_id,)).fetchone()
    return row["decision_id"] if row else None


def merge(conn, a, b):
    """Merge task a into task b. Records exactly what moved, so split() can undo it."""
    ta, tb = store.live_task(conn, a), store.live_task(conn, b)
    if not ta or not tb or ta["id"] == tb["id"]:
        raise SystemExit("Both tasks must exist and differ")
    a, b = ta["id"], tb["id"]
    sources = [dict(r) for r in conn.execute("SELECT * FROM task_sources WHERE task_id=?", (a,))]
    anchors = [r["anchor"] for r in conn.execute("SELECT anchor FROM task_anchors WHERE task_id=?", (a,))]
    for s in sources:
        conn.execute("INSERT OR IGNORE INTO task_sources (task_id, candidate_id, role, added_run, withdrawn) "
                     "VALUES (?,?,?,?,?)", (b, s["candidate_id"], "update" if s["role"] == "origin" else s["role"],
                                             s["added_run"], s["withdrawn"]))
    conn.execute("DELETE FROM task_sources WHERE task_id=?", (a,))
    for an in anchors:
        conn.execute("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (an, b))
    moved = {"sources": sources, "anchors": anchors, "prior_state": ta["state"],
             "anchors_b_had": [r["anchor"] for r in conn.execute("SELECT anchor FROM task_anchors WHERE task_id=?", (b,))
                               if r["anchor"] not in anchors]}
    conn.execute("UPDATE tasks SET state='merged', merged_into=?, state_changed_at=? WHERE id=?", (b, store.now(), a))
    cur = conn.execute("INSERT INTO merges (into_task, from_task, moved, ts) VALUES (?,?,?,?)",
                       (b, a, json.dumps(moved), store.now()))
    store.add_history(conn, b, "merge", f"Merged #{a} into this task (“{ta['title']}”). Undo: split {cur.lastrowid}")
    store.add_history(conn, a, "merge", f"Merged into #{b}")
    link = conn.execute("SELECT kind FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a)).fetchone()
    conn.execute("DELETE FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a))
    conn.execute("INSERT INTO feedback (ts, kind, a, b, decision_id, note) VALUES (?,?,?,?,?,?)",
                 (store.now(), "merge", a, b, _creation_decision(conn, a), link["kind"] if link else "unlinked"))
    conn.commit()
    return cur.lastrowid


def split(conn, merge_id):
    m = conn.execute("SELECT * FROM merges WHERE id=? AND undone=0", (merge_id,)).fetchone()
    if m is None:
        raise SystemExit(f"No open merge {merge_id}")
    moved = json.loads(m["moved"])
    a, b = m["from_task"], m["into_task"]
    for s in moved["sources"]:
        conn.execute("DELETE FROM task_sources WHERE task_id=? AND candidate_id=?", (b, s["candidate_id"]))
        conn.execute("INSERT OR IGNORE INTO task_sources (task_id, candidate_id, role, added_run, withdrawn) "
                     "VALUES (?,?,?,?,?)", (a, s["candidate_id"], s["role"], s["added_run"], s["withdrawn"]))
    for an in moved["anchors"]:
        if an not in moved.get("anchors_b_had", []):
            conn.execute("DELETE FROM task_anchors WHERE anchor=? AND task_id=?", (an, b))
        conn.execute("INSERT OR IGNORE INTO task_anchors VALUES (?,?)", (an, a))
    conn.execute("UPDATE tasks SET state=?, merged_into=NULL, state_changed_at=? WHERE id=?",
                 (moved["prior_state"], store.now(), a))
    conn.execute("UPDATE merges SET undone=1 WHERE id=?", (merge_id,))
    store.add_history(conn, b, "split", f"Split #{a} back out (undid merge {merge_id})")
    store.add_history(conn, a, "split", f"Split back out of #{b}")
    conn.execute("INSERT INTO feedback (ts, kind, a, b, note) VALUES (?,?,?,?,?)",
                 (store.now(), "split", a, b, f"merge {merge_id}"))
    conn.commit()


def detach(conn, ctx, candidate_id):
    """Undo an automatic attach: pull one source off its task into a task of its own."""
    row = conn.execute("SELECT * FROM task_sources WHERE candidate_id=? AND role!='origin'", (candidate_id,)).fetchone()
    if row is None:
        raise SystemExit(f"Candidate {candidate_id} is not attached as an update")
    cand = conn.execute("SELECT * FROM candidates WHERE id=?", (candidate_id,)).fetchone()
    conn.execute("DELETE FROM task_sources WHERE task_id=? AND candidate_id=?", (row["task_id"], candidate_id))
    tid = create_task(conn, cand, ctx.run_id, None)
    store.add_history(conn, row["task_id"], "split", f"Source moved out to #{tid}")
    conn.execute("INSERT INTO feedback (ts, kind, a, b, note) VALUES (?,?,?,?,?)",
                 (store.now(), "detach", tid, row["task_id"], f"candidate {candidate_id}"))
    conn.commit()
    return tid


def keep_separate(conn, a, b):
    conn.execute("DELETE FROM task_links WHERE (a=? AND b=?) OR (a=? AND b=?)", (a, b, b, a))
    conn.execute("INSERT INTO task_links VALUES (?,?,?,?,?)", (a, b, "kept_separate", None, "You said these differ"))
    store.add_history(conn, a, "link", f"Kept separate from #{b}")
    conn.execute("INSERT INTO feedback (ts, kind, a, b, decision_id) VALUES (?,?,?,?,?)",
                 (store.now(), "keep", a, b, _creation_decision(conn, a)))
    conn.commit()


def mark_withdrawn(conn, s):
    rows = conn.execute(
        "SELECT ts.task_id, ts.candidate_id FROM task_sources ts JOIN candidates c ON c.id=ts.candidate_id "
        "JOIN signals g ON g.key=c.signal_key WHERE g.source=? AND g.source_id=?",
        (s["source"], s["source_id"])).fetchall()
    for r in rows:
        conn.execute("UPDATE task_sources SET withdrawn=1 WHERE task_id=? AND candidate_id=?",
                     (r["task_id"], r["candidate_id"]))
        store.add_history(conn, r["task_id"], "withdrawn",
                          f"A {SOURCE_LABEL.get(s['source'], s['source'])} source was deleted. The task stays open.")
