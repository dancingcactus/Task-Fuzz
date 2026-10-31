"""People on a task: who is involved, and what each of them has added to it.

Worked out when it is read, from what the task already holds: the messages behind its sources (who sent
each, who else was on it, who the ask named), who you're waiting on, whose it is, and the drafts Fuzz sent
them. Nothing is stored. The same person in Slack and email is one row when the entity service already
knows them as one (an email or Slack ID it has seen, or you said they're the same). You aren't listed;
what you and Fuzz did is the task's log.
"""

import json

from .matching import entities

VIA = {"email": "Email", "slack": "Slack", "meeting": "Meeting", "calendar": "Calendar"}
SENT = {"origin": "Asked for this", "update": "Followed up", "context": "Wrote a related message"}
ON = {"email": "On the email", "slack": "In the conversation", "meeting": "In the meeting", "calendar": "Invited"}
NOT_A_NAME = ("me", "unclear", "someone", "")
RANK = {"on": 1, "named": 2, "sent": 3}


def for_task(core, t):
    """[{name, email, contributions: [{kind, text, via, quote, ts, source_id}]}], the person the task came
    from first, then whoever added the most. Each person's contributions are newest first."""
    me = core.config.get("me", {})
    book = _Book(core)
    rows = core.all(
        "SELECT s.id, s.role, g.source, g.source_id, g.ts, g.quote, g.payload, c.payload cand FROM sources s "
        "JOIN signals g ON g.key=s.signal_key AND g.user_id=s.user_id "
        "LEFT JOIN candidates c ON c.id=s.candidate_id "
        "WHERE s.task_id=? AND s.user_id=? AND s.withdrawn=0 AND s.role IN ('origin','update','context') "
        "ORDER BY s.id", (t["id"], core.user_id))
    for r in rows:
        sig, cand = r["payload"] or {}, json.loads(r["cand"] or "{}")   # payload is decoded by name; cand isn't
        msg, via = f"{r['source']}:{r['source_id']}", VIA.get(r["source"], r["source"].title())
        here = dict(via=via, ts=r["ts"], source_id=r["id"], msg=msg, role=r["role"])
        sender = sig.get("from")
        if sender and not entities.sent_by_me(sender, me):
            book.add(sender, kind="sent", text=SENT[r["role"]], quote=r["quote"], **here)
        for p in sig.get("people") or []:
            if not entities._is_me(p, me):
                book.add(p, kind="on", text=ON.get(r["source"], "Included"), **here)
        for p in cand.get("people") or []:
            if not entities._is_me(p, me):
                book.add(p, kind="named", text="Named in the ask", **here)
    if t.get("waiting_on") and t["state"] in ("waiting", "queued"):
        book.add_name(t["waiting_on"], kind="waiting", text="You’re waiting on them", ts=t["state_changed_at"])
    if (t.get("owner") or "").strip() not in NOT_A_NAME:
        book.add_name(t["owner"], kind="owner", text="It’s theirs, not yours", ts=t["state_changed_at"])
    for d in core.all("SELECT kind, target, approved_at FROM drafts WHERE task_id=? AND user_id=? AND status='sent'",
                      (t["id"], core.user_id)):
        # a draft goes to a person, a channel or a thread; only one to someone already here is theirs
        book.add_name(d["target"], kind="sent_to", text=_sent_text(d["kind"]), ts=d["approved_at"], known_only=True)
    return book.people()


def _sent_text(kind):
    if kind.startswith("nudge"):
        return "Fuzz nudged them"
    if kind == "calendar.invite":
        return "Fuzz sent them an invite"
    return "Fuzz sent them a reply"


class _Book:
    """People by who they are: an entity when one matches, else their email, else their name."""

    def __init__(self, core):
        self.core = core
        self.by_key = {}
        self.order = []

    def _key(self, p):
        eid = entities.lookup_person(self.core, p)
        if eid:
            return f"e{eid}"
        email = (p.get("email") or "").lower()
        return f"m:{email}" if email else f"n:{(p.get('name') or '').strip().lower()}"

    def _row(self, key, p):
        if key not in self.by_key:
            self.by_key[key] = {"name": "", "email": "", "contributions": [], "by_msg": {}}
            self.order.append(key)
        row = self.by_key[key]
        name, email = (p.get("name") or "").strip(), (p.get("email") or "").strip()
        if len(name) > len(row["name"]):   # "Dana Reyes" over "Dana"
            row["name"] = name
        row["email"] = row["email"] or email
        return row

    def add(self, p, kind, text, msg, role=None, **c):
        """One contribution per person per message: sending it outranks being named in it, which
        outranks being on it. A message read twice keeps the copy the task came from."""
        key = self._key(p)
        if key in ("m:", "n:"):
            return
        row = self._row(key, p)
        old = row["by_msg"].get(msg)
        if old and (RANK[old["kind"]], old["_origin"]) >= (RANK[kind], role == "origin"):
            return
        new = dict(c, kind=kind, text=text, quote=c.get("quote") if kind == "sent" else None, _origin=role == "origin")
        if old:
            row["contributions"].remove(old)
        row["by_msg"][msg] = new
        row["contributions"].append(new)

    def add_name(self, who, kind, text, ts=None, known_only=False):
        who = (who or "").strip()
        if not who:
            return
        p = {"email": who} if "@" in who else {"name": who}
        key = self._key(p)
        if key not in self.by_key:
            # a free-text name ("Dana") that the entity service can't place may still be someone listed here
            low = who.lower()
            key = next((k for k, r in self.by_key.items()
                        if low in (r["name"].lower(), r["email"].lower(), r["name"].lower().split(" ")[0])), key)
        if known_only and key not in self.by_key:
            return
        self._row(key, p)["contributions"].append(
            {"kind": kind, "text": text, "via": None, "ts": ts, "source_id": None, "quote": None, "_origin": False})

    def people(self):
        out = []
        for i, key in enumerate(self.order):
            r = self.by_key[key]
            # Slack may give only an ID: use the name the entity service knows, or leave out someone we can't name
            name = r["name"] or r["email"] or self._entity_name(key)
            if not name:
                continue
            cs = sorted(r["contributions"], key=lambda c: c["ts"] or "", reverse=True)
            started = any(c["_origin"] and c["kind"] == "sent" for c in cs)
            out.append(((not started, -len(cs), i), {
                "name": name, "email": r["email"],
                "contributions": [{k: v for k, v in c.items() if not k.startswith("_")} for c in cs]}))
        return [p for _, p in sorted(out, key=lambda x: x[0])]

    def _entity_name(self, key):
        if not key.startswith("e"):
            return ""
        row = self.core.one("SELECT name FROM entities WHERE id=?", (int(key[1:]),))
        return (row and row["name"]) or ""
