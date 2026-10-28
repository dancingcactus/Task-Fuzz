"""The signal and verdict formats the extractor must send (spikes/task-matching/skill/references/signal-schema.md).

Errors name the exact field ("signals[2].candidates[0].ask"), so a model fixes them in one try.
"""

import jsonschema

from .db import FuzzError

PERSON = {"type": "object", "properties": {
    "name": {"type": "string"}, "email": {"type": "string"}, "slack_id": {"type": "string"}},
    "additionalProperties": False}

MOMENT = {   # a described date from the calendar: "Before the leadership meeting", Thu 9:00
    "type": "object",
    "required": ["label", "at"],
    "properties": {
        "key": {"type": "string", "minLength": 1, "maxLength": 60},
        "label": {"type": "string", "minLength": 1, "maxLength": 60},
        "at": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$"},
        "cancelled": {"type": "boolean"},
        "reason": {"type": "string", "maxLength": 200},
    },
    "additionalProperties": False,
}

CANDIDATE = {
    "type": "object",
    "required": ["ask"],
    "properties": {
        "ask": {"type": "string", "minLength": 1, "maxLength": 300},
        "owner": {"type": "string"},
        "due": {"type": ["string", "null"], "pattern": r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$"},
        "people": {"type": "array", "items": PERSON},
        "links": {"type": "array", "items": {"type": "string"}},
        "topics": {"type": "array", "items": {"type": "string"}},
        "context_md": {"type": "string", "maxLength": 16384},
        "question": {"type": "string", "maxLength": 500},
        "effort_mins": {"type": "integer", "minimum": 1},
        "energy": {"enum": ["low", "normal", "high"]},
        "moments": {"type": "array", "maxItems": 2, "items": MOMENT},
    },
    "additionalProperties": False,
}

SIGNAL = {
    "type": "object",
    "required": ["source", "source_id"],
    "properties": {
        "source": {"enum": ["email", "slack", "meeting", "calendar"]},
        "source_id": {"type": "string", "minLength": 1},
        "version": {"type": ["string", "integer"]},
        "anchor": {"type": ["string", "null"]},
        "message_ids": {"type": "array", "items": {"type": "string"}},
        "link": {"type": ["string", "null"]},
        "title": {"type": "string", "maxLength": 200},
        "ts": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$"},
        "from": PERSON,
        "people": {"type": "array", "items": PERSON},
        "links": {"type": "array", "items": {"type": "string"}},
        "quote": {"type": "string", "maxLength": 600},
        "withdrawn": {"type": "boolean"},
        "candidates": {"type": "array", "items": CANDIDATE},
    },
    "additionalProperties": False,
}

VERDICT = {
    "type": "object",
    "required": ["candidate_id", "verdict", "confidence"],
    "properties": {
        "candidate_id": {"type": "integer"},
        "task_id": {"type": ["integer", "null"]},
        "verdict": {"enum": ["same", "related", "new"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "new_ask": {"type": "boolean"},
        "new_title": {"type": ["string", "null"]},
        "reason": {"type": "string"},
    },
    "additionalProperties": False,
}


def _path(prefix, err):
    out = prefix
    for p in err.absolute_path:
        out += f"[{p}]" if isinstance(p, int) else f".{p}"
    return out


def _check(items, schema, name, limit):
    if not isinstance(items, list):
        raise FuzzError(f"{name} must be a JSON array", name)
    if len(items) > limit:
        raise FuzzError(f"Send at most {limit} {name} per call", name)
    v = jsonschema.Draft202012Validator(schema)
    for i, item in enumerate(items):
        errs = sorted(v.iter_errors(item), key=lambda e: list(e.absolute_path))
        if errs:
            e = errs[0]
            field = _path(f"{name}[{i}]", e)
            msg = e.message
            if e.validator == "additionalProperties":
                msg = f"unknown field: {msg.split(chr(39))[1] if chr(39) in msg else msg}"
            raise FuzzError(f"{field}: {msg}", field)


def check_signals(signals):
    _check(signals, SIGNAL, "signals", 200)
    for i, s in enumerate(signals):
        if s.get("withdrawn") and s.get("candidates"):
            raise FuzzError(f"signals[{i}]: a withdrawn signal has no candidates", f"signals[{i}].candidates")


def check_verdicts(verdicts):
    _check(verdicts, VERDICT, "verdicts", 200)
    for i, v in enumerate(verdicts):
        if v["verdict"] != "new" and v.get("task_id") is None:
            raise FuzzError(f"verdicts[{i}].task_id is required when the verdict is {v['verdict']}",
                            f"verdicts[{i}].task_id")
