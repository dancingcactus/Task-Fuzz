"""Shared test setup: a temporary store, a fixed clock, and the spike's fixtures."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from fuzz import config  # noqa: E402
from fuzz.db import Core  # noqa: E402

FIXTURES = os.path.join(HERE, "..", "..", "spikes", "task-matching", "skill", "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


class Clock:
    """A clock tests move by hand. Starts on a Tuesday morning, UTC."""

    def __init__(self, start=datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, **kw):
        self.t += timedelta(**kw)


class CoreCase(unittest.TestCase):
    """A fresh store per test, with Justin as the user, the hash embedder and UTC."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, True)
        cfg = config.load(self.home)
        cfg["me"] = {"names": ["Justin"], "emails": ["jgrover@adobe.com"], "slack_ids": ["W4R5SVCU9"],
                     "folders": {"meetings": "~/Context/meetings/summaries"}}
        cfg["embedder"] = "hash"
        cfg["tz"] = "UTC"
        config.save(self.home, cfg)
        self.clock = Clock()
        self.core = self.make_core()

    def make_core(self, user_id=1):
        c = Core(self.home, user_id, clock=self.clock)
        self.addCleanup(c.close)
        return c

    # ---- small readers
    def task(self, tid, core=None):
        from fuzz import tasks
        return tasks.get(core or self.core, tid)

    def open_cards(self, core=None):
        from fuzz import cards
        return [c for c, _ in cards.queue(core or self.core)]

    def card_for(self, tid, kind=None, core=None):
        from fuzz import cards
        cs = [c for c in cards.open_cards(core or self.core, tid) if kind is None or c["kind"] == kind]
        self.assertEqual(len(cs), 1, f"expected one open {kind or ''} card for task {tid}, got {cs}")
        return cs[0]

    def types_since(self, after, core=None):
        c = core or self.core
        return [r["type"] for r in c.conn.execute(
            "SELECT type FROM events WHERE user_id=? AND id>? ORDER BY id", (c.user_id, after))]

    def last_event_id(self, core=None):
        c = core or self.core
        return c.conn.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]
