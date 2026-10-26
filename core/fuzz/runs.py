"""Runs: one row per AI run, so every event it writes knows its client, model and prompt_version."""

import json

from . import events
from .db import FuzzError


def start(core, role, client, model=None, prompt_version=None, trigger="manual", detail=None):
    with core.tx("system"):
        rid = core.q("INSERT INTO runs (user_id, role, client, model, prompt_version, trigger, started_at, detail) "
                     "VALUES (?,?,?,?,?,?,?,?)", (core.user_id, role, client, model, prompt_version, trigger,
                                                  core.now_iso(), json.dumps(detail or {}))).lastrowid
        events.emit(core, "run.started",
                    data={"run_id": rid, "role": role, "client": client, "model": model, "trigger": trigger})
    return rid


def get(core, run_id):
    r = core.one("SELECT * FROM runs WHERE id=? AND user_id=?", (int(run_id), core.user_id))
    if r is None:
        raise FuzzError(f"No run {run_id}", "run_id", 404)
    return r


def attach(core, run_id):
    """Stamp everything this Core writes with the run."""
    r = get(core, run_id)
    core.run = {"id": r["id"], "client": r["client"], "model": r["model"], "prompt_version": r["prompt_version"]}
    return core.run


def finish(core, run_id, outcome, detail=None):
    touched = sorted({r["task_id"] for r in core.all(
        "SELECT DISTINCT task_id FROM events WHERE run_id=? AND task_id IS NOT NULL", (run_id,))})
    d = dict(detail or {}, tasks=touched)
    with core.tx("system"):
        core.q("UPDATE runs SET finished_at=?, outcome=?, detail=? WHERE id=?",
               (core.now_iso(), outcome, json.dumps(d), run_id))
        events.emit(core, "run.finished", data={"run_id": run_id, "outcome": outcome, "tasks": touched})
    return d


def last(core, role=None, client=None):
    sql, args = "SELECT * FROM runs WHERE user_id=?", [core.user_id]
    if role:
        sql += " AND role=?"
        args.append(role)
    if client:
        sql += " AND client=?"
        args.append(client)
    return core.one(sql + " ORDER BY id DESC LIMIT 1", args)
