"""Scripted roles: canned output, no model. They go through the real MCP server in-process, so a
scripted run checks the same tools, rules and events a model would use. If the system runs end to
end on these, the models really are swappable.
"""

import asyncio
import json

from mcp import Client

from .. import mcp_server

PROMPT_VERSION = "scripted-1"


class ToolFailed(Exception):
    pass


async def _call(client, name, args=None):
    r = await client.call_tool(name, args or {})
    text = r.content[0].text if r.content else "{}"
    if r.is_error:
        raise ToolFailed(text)
    return json.loads(text)


async def _executor(core, task_id, say):
    done = []
    async with Client(mcp_server.build(core, "executor")) as c:
        await _call(c, "whoami", {"prompt_version": PROMPT_VERSION, "client": "scripted"})
        while True:
            r = await _call(c, "claim_next_task", {"task_id": task_id} if task_id else {})
            t = r.get("task")
            if not t:
                say(f"Nothing to claim: {r.get('why')}")
                break
            tid = t["id"]
            say(f"Claimed #{tid}: {t['title']}")
            if t["sources"]:
                await _call(c, "read_source", {"source_id": t["sources"][0]["id"]})
            await _call(c, "log_step", {"task_id": tid, "kind": "research",
                                        "text": "Read the task" + (" and its first source." if t["sources"] else ".")})
            await _call(c, "log_step", {"task_id": tid, "kind": "action", "text": "Drafted the next step."})
            if not t.get("context_md"):
                await _call(c, "update_brief", {"task_id": tid, "context_md":
                            f"**{t['title']}**\n\nA scripted run wrote this. Nothing real was read."})
            body = f"Draft for “{t['title']}”, based on: {(t.get('notes') or t.get('ask') or t['title']).strip()}"
            await _call(c, "save_draft", {"task_id": tid, "kind": "note", "target": "", "body": body})
            say(f"Draft ready on #{tid}")
            done.append(tid)
            if task_id:
                break
    return {"tasks": done}


def _scripted_verdict(item):
    """Deterministic stand-in for the judge: anchors and strong shared entities mean the same task."""
    for s in item["shortlist"]:
        if s.get("anchor_hit"):
            return {"candidate_id": item["candidate_id"], "task_id": s["task_id"], "verdict": "same",
                    "confidence": 0.9, "new_ask": False, "reason": "scripted: same thread"}
    best = max(item["shortlist"], key=lambda s: s.get("entity_score") or 0)
    if (best.get("entity_score") or 0) >= 2:
        return {"candidate_id": item["candidate_id"], "task_id": best["task_id"], "verdict": "same",
                "confidence": 0.7, "new_ask": False, "reason": "scripted: shares a document or ticket"}
    return {"candidate_id": item["candidate_id"], "task_id": None, "verdict": "new", "confidence": 0.8,
            "reason": "scripted: nothing close enough"}


async def _extractor(core, signals, say):
    async with Client(mcp_server.build(core, "extractor")) as c:
        await _call(c, "whoami", {"prompt_version": PROMPT_VERSION, "client": "scripted"})
        await _call(c, "get_cursors")
        out = {"submitted": None, "verdicts": 0}
        if signals:
            out["submitted"] = await _call(c, "submit_signals", {"signals": signals})
            say(f"Submitted {len(signals)} signals: {out['submitted']['outcomes']}")
        while True:
            page = await _call(c, "get_pending_judgments", {"page": 1})
            if not page["items"]:
                break
            verdicts = [_scripted_verdict(i) for i in page["items"]]
            r = await _call(c, "submit_verdicts", {"verdicts": verdicts})
            out["verdicts"] += len(verdicts)
            say(f"Judged {len(verdicts)}: {r['outcomes']}")
    return out


def run_executor(core, task_id=None, say=lambda s: None):
    return asyncio.run(_executor(core, task_id, say))


def run_extractor(core, signals=None, say=lambda s: None):
    return asyncio.run(_extractor(core, signals or [], say))
