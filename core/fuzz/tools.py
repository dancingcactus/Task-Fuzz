"""The AI roles' tools as plain functions. mcp_server.py exposes them; tests and scripted runs call them too.

Kept small on purpose (past about fifteen tools a model starts choosing the wrong one), and kept
quiet: writes return counts and ids, never an echo; reads return short pages.
There is no send, post or delete tool.
"""

import json
from contextlib import contextmanager

from . import drafts, events, matching, scheduler, signals, tasks
from .db import FuzzError

LOG_ON_GET = 8


@contextmanager
def _lease(core, task_id):
    """Check the caller holds the task, and renew the lease with whatever the tool writes."""
    t = scheduler.require_lease(core, task_id)
    core.renew = (t["id"], scheduler.lease_until(core))
    try:
        with core.tx("fuzz:executor"):
            yield t
    finally:
        core.renew = None


def whoami(core, role, prompt_version=None, client=None):
    from . import runs
    cfg = core.config
    if prompt_version and core.run is None:
        rid = runs.start(core, role, client or "chat", prompt_version=prompt_version, trigger="chat")
        runs.attach(core, rid)
    me = cfg["me"]
    return {"user_id": core.user_id, "names": me.get("names", []), "emails": me.get("emails", []),
            "slack_ids": me.get("slack_ids", []), "folders": me.get("folders", {}), "role": role,
            "now": core.now_iso(), "tz": cfg.get("tz"), "run_id": (core.run or {}).get("id")}


# ---------------------------------------------------------------- executor

def claim_next_task(core, task_id=None):
    t, why = scheduler.claim_next(core, task_id)
    if t is None:
        return {"task": None, "why": why}
    return {"task": _task_brief(core, t), "lease_until": t["lease_until"]}


def _task_brief(core, t):
    srcs = core.all("SELECT id, role, title, withdrawn FROM sources WHERE task_id=? AND user_id=? AND role!='ignored'",
                    (t["id"], core.user_id))
    b = core.config["budget"]
    return {"id": t["id"], "title": t["title"], "ask": t["ask"], "state": t["state"], "due": t["due"],
            "notes": t["notes"], "context_md": t["context_md"], "question": t["question"],
            "steps_used": t["steps_used"], "max_steps": b["max_steps"],
            "sources": [{"id": s["id"], "role": s["role"], "title": s["title"]} for s in srcs if not s["withdrawn"]],
            "schedule_hints": t.get("schedule_hints") or [],
            "log": [{"kind": x["kind"], "text": x["text"]} for x in events.task_log(core, t["id"], LOG_ON_GET)]}


def get_task(core, task_id):
    t = scheduler.require_lease(core, task_id)
    return _task_brief(core, t)


def read_source(core, source_id):
    s = core.one("SELECT * FROM sources WHERE id=? AND user_id=?", (source_id, core.user_id))
    if s is None:
        raise FuzzError(f"No source {source_id}", "source_id", 404)
    with _lease(core, s["task_id"]):
        events.emit(core, "source.read", task_id=s["task_id"], data={"source_id": s["id"]})
    if not s["signal_key"]:
        return {"id": s["id"], "role": s["role"], "title": s["title"],
                "content": None, "note": "An attachment you added. Only its name is stored."}
    sig = core.one("SELECT payload FROM signals WHERE user_id=? AND key=?", (core.user_id, s["signal_key"]))
    p = json.loads(sig["payload"]) if isinstance(sig["payload"], str) else sig["payload"]
    keep = ("source", "link", "ts", "from", "people", "links", "quote", "anchor")
    return dict({k: p.get(k) for k in keep if p.get(k) is not None}, id=s["id"], role=s["role"])


def log_step(core, task_id, kind, text):
    with _lease(core, task_id):
        return scheduler.log_step(core, task_id, kind, text)


def save_notes(core, task_id, text):
    with _lease(core, task_id):
        tasks.save_notes(core, task_id, text)
    return {"ok": True}


def save_draft(core, task_id, kind, target, body):
    with _lease(core, task_id):
        did = drafts.save_draft(core, task_id, kind, target, body)
    return {"draft_id": did, "state": "review"}


def hand_back(core, task_id, question, options=None):
    with _lease(core, task_id):
        scheduler.hand_back(core, task_id, question, options)
    return {"state": "triage"}


def create_task(core, ask, parent_task_id=None, due=None, links=None):
    if not (ask or "").strip():
        raise FuzzError("ask is a short imperative, like “Book the room for Thursday”", "ask")
    if parent_task_id is not None:
        scheduler.require_lease(core, parent_task_id)
    with core.tx("fuzz:executor"):
        return matching.create_from_ask(matching.Context(core), ask.strip(), parent_id=parent_task_id, due=due,
                                        links=links)


def request_permission(core, task_id, scope, resource, why):
    with _lease(core, task_id):
        return drafts.request_permission(core, task_id, scope, resource, why)


def suggest_schedule(core, task_id, anchor, reason):
    with _lease(core, task_id):
        return {"label": scheduler.suggest_schedule(core, task_id, anchor, reason)}


def update_brief(core, task_id, context_md=None, question=None, effort_mins=None, energy=None):
    with _lease(core, task_id):
        return {"updated": tasks.update_brief(core, task_id, context_md, question, effort_mins, energy)}


def release(core, task_id):
    scheduler.require_lease(core, task_id)
    scheduler.release(core, task_id)
    return {"state": "queued"}


# ---------------------------------------------------------------- extractor

def get_cursors(core):
    return {"since": matching.cursors(core), "overlap_hours": 6}


def submit_signals(core, signals_):
    signals.check_signals(signals_)
    ctx = matching.Context(core)
    with core.tx("fuzz:extractor"):
        counts = matching.ingest(ctx, signals_)
        outcomes = matching.propose(ctx)
    pending = core.one("SELECT COUNT(*) n FROM candidates WHERE user_id=? AND status='pending'", (core.user_id,))["n"]
    out = dict(counts, outcomes=outcomes, pending_judgments=pending)
    if ctx.notes:
        out["notes"] = ctx.notes
    return out


def get_pending_judgments(core, page=1):
    return matching.pending_judgments(core, page)


def submit_verdicts(core, verdicts):
    signals.check_verdicts(verdicts)
    ctx = matching.Context(core)
    with core.tx("fuzz:extractor"):
        stats = matching.apply_verdicts(ctx, verdicts)
    pending = core.one("SELECT COUNT(*) n FROM candidates WHERE user_id=? AND status='pending'", (core.user_id,))["n"]
    return dict(outcomes=stats, pending_judgments=pending)


EXECUTOR = ("whoami", "claim_next_task", "get_task", "read_source", "log_step", "save_notes", "save_draft",
            "hand_back", "create_task", "request_permission", "suggest_schedule", "update_brief", "release")
EXTRACTOR = ("whoami", "get_cursors", "submit_signals", "get_pending_judgments", "submit_verdicts")
ROLES = {"executor": EXECUTOR, "extractor": EXTRACTOR}
