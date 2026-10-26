"""A minimal in-process entity service: resolve() and the lookups the matcher needs.

Moved from the matching spike. Every function takes the Core and scopes by its user.

Resolution order (doc, "How resolution works"): an exact identifier decides
first, then a unique alias, else a provisional entity. The AI-judge step for
ambiguous aliases is left out of the spike: an ambiguous name stays provisional.
"""

import re
from urllib.parse import urlparse

TICKET_RE = re.compile(r"\b([A-Z][A-Z0-9]{1,9}-\d+)\b")
GDOC_RE = re.compile(r"/d/([A-Za-z0-9_-]{10,})")


def normalize_url(url):
    """Stable identifier for a shared doc or ticket link."""
    p = urlparse(url.strip())
    host = (p.hostname or "").lower()
    m = GDOC_RE.search(p.path)
    if m:
        return "gdoc:" + m.group(1)
    m = re.search(r"/browse/([A-Z][A-Z0-9]+-\d+)", p.path)
    if m:
        return "ticket:" + m.group(1)
    return host + p.path.rstrip("/")


def tickets_in(*texts):
    found = []
    for t in texts:
        for k in TICKET_RE.findall(t or ""):
            if k not in found:
                found.append(k)
    return found


def _by_identifier(core, typ, value):
    row = core.conn.execute("SELECT entity_id FROM identifiers WHERE user_id=? AND type=? AND value=?",
                            (core.user_id, typ, value)).fetchone()
    return _follow(core, row["entity_id"]) if row else None


def _follow(core, eid):
    while True:
        row = core.conn.execute("SELECT redirect_to FROM entities WHERE id=?", (eid,)).fetchone()
        if row is None or row["redirect_to"] is None:
            return eid
        eid = row["redirect_to"]


def _new_entity(core, typ, name, provisional):
    cur = core.conn.execute("INSERT INTO entities (user_id, type, name, provisional) VALUES (?,?,?,?)",
                            (core.user_id, typ, name, 1 if provisional else 0))
    eid = cur.lastrowid
    if name:
        core.conn.execute("INSERT OR IGNORE INTO aliases VALUES (?,?)", (eid, name.lower()))
    return eid


def _add_identifier(core, typ, value, eid):
    core.conn.execute("INSERT OR IGNORE INTO identifiers VALUES (?,?,?,?)", (core.user_id, typ, value, eid))


def _is_me(person, me):
    if (person.get("email") or "").lower() in [e.lower() for e in me.get("emails", [])]:
        return True
    if person.get("slack_id") and person["slack_id"] in me.get("slack_ids", []):
        return True
    if not person.get("email") and not person.get("slack_id"):
        return (person.get("name") or "").lower() in [n.lower() for n in me.get("names", [])]
    return False


def resolve_person(core, person, me):
    """Return (entity_id, strength) or None for the user themself."""
    if _is_me(person, me):
        return None
    email = (person.get("email") or "").lower() or None
    slack = person.get("slack_id") or None
    name = (person.get("name") or "").strip() or None
    eid = None
    if email:
        eid = _by_identifier(core, "email", email)
    if eid is None and slack:
        eid = _by_identifier(core, "slack", slack)
    if eid is not None or email or slack:
        if eid is None:
            # A strong identifier we have not seen. Join an existing person when the full name
            # (two or more words) is unique, e.g. Priya Shah by email, then by Slack ID. A first
            # name alone only joins a provisional, name-only entity.
            full = name if name and len(name.split()) > 1 else None
            eid = (_unique_alias(core, "person", full) or _unique_alias(core, "person", name, provisional_only=True)
                   or _new_entity(core, "person", name, False))
            core.conn.execute("UPDATE entities SET provisional=0 WHERE id=?", (eid,))
        if email:
            _add_identifier(core, "email", email, eid)
            domain = email.split("@")[-1]
            org = _by_identifier(core, "domain", domain) or _new_entity(core, "org", domain, False)
            _add_identifier(core, "domain", domain, org)
        if slack:
            _add_identifier(core, "slack", slack, eid)
        if name:
            core.conn.execute("INSERT OR IGNORE INTO aliases VALUES (?,?)", (eid, name.lower()))
            first = name.split()[0].lower()
            core.conn.execute("INSERT OR IGNORE INTO aliases VALUES (?,?)", (eid, first))
        return eid, "id"
    if not name:
        return None
    eid = _unique_alias(core, "person", name)
    if eid is not None:
        prov = core.conn.execute("SELECT provisional FROM entities WHERE id=?", (eid,)).fetchone()["provisional"]
        return eid, "provisional" if prov else "alias"
    return _new_entity(core, "person", name, True), "provisional"


def _unique_alias(core, typ, name, provisional_only=False):
    if not name:
        return None
    q = ("SELECT DISTINCT e.id FROM aliases a JOIN entities e ON e.id=a.entity_id "
         "WHERE a.alias=? AND e.type=? AND e.redirect_to IS NULL AND e.user_id=?")
    if provisional_only:
        q += " AND e.provisional=1"
    rows = core.conn.execute(q, (name.lower(), typ, core.user_id)).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def resolve_link(core, url):
    ident = normalize_url(url)
    if ident.startswith("ticket:"):
        return resolve_ticket(core, ident[7:])
    eid = _by_identifier(core, "url", ident)
    if eid is None:
        eid = _new_entity(core, "document", ident, False)
        _add_identifier(core, "url", ident, eid)
    return eid, "id"


def resolve_ticket(core, key):
    eid = _by_identifier(core, "ticket", key)
    if eid is None:
        eid = _new_entity(core, "ticket", key, False)
        _add_identifier(core, "ticket", key, eid)
    return eid, "id"


def resolve_term(core, term):
    eid = _unique_alias(core, "term", term) or _new_entity(core, "term", term, False)
    return eid, "id"


def resolve_candidate(core, cand_id, signal, cand, me):
    """resolve(mentions, context) for one candidate; writes mentions. Safe to repeat."""
    people = list(cand.get("people") or []) + list(signal.get("people") or [])
    if signal.get("from"):
        people.append(signal["from"])
    found = {}
    for p in people:
        r = resolve_person(core, p, me)
        if r:
            found[r[0]] = _stronger(found.get(r[0]), r[1])
    for url in list(cand.get("links") or []) + list(signal.get("links") or []):
        eid, s = resolve_link(core, url)
        found[eid] = _stronger(found.get(eid), s)
    for key in tickets_in(cand.get("ask"), signal.get("quote")):
        eid, s = resolve_ticket(core, key)
        found[eid] = _stronger(found.get(eid), s)
    for t in cand.get("topics") or []:
        eid, s = resolve_term(core, t)
        found[eid] = _stronger(found.get(eid), s)
    for eid, s in found.items():
        core.conn.execute("INSERT OR REPLACE INTO mentions VALUES (?,?,?)", (cand_id, eid, s))
    return found


def _stronger(a, b):
    order = {"id": 3, "alias": 2, "provisional": 1, None: 0}
    return a if order[a] >= order[b] else b
