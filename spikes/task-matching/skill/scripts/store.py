"""SQLite store for the task matching spike.

One file, three zones (see the Task matching doc, "Datastore"):
  raw      signals: append-only references to source items, never edited
  derived  entities, candidates, tasks, anchors, history, vectors
  log      runs, cursors, decisions, feedback: append-only, answers "why"

Only tm.py writes. WAL mode so Datasette or sqlite3 can read alongside.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
-- raw
CREATE TABLE IF NOT EXISTS signals (
  key TEXT PRIMARY KEY,            -- source:source_id:version
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  anchor TEXT,
  link TEXT,
  ts TEXT,
  quote TEXT,
  payload TEXT NOT NULL,
  run_id INTEGER
);

-- derived
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,              -- person | org | document | ticket | term
  name TEXT,
  provisional INTEGER NOT NULL DEFAULT 1,
  redirect_to INTEGER
);
CREATE TABLE IF NOT EXISTS identifiers (
  type TEXT NOT NULL,              -- email | slack | domain | url | ticket
  value TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (type, value)
);
CREATE TABLE IF NOT EXISTS aliases (
  entity_id INTEGER NOT NULL,
  alias TEXT NOT NULL,             -- lowercased
  PRIMARY KEY (entity_id, alias)
);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY,
  signal_key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- ask | update (a signal with no new ask)
  ask TEXT,
  owner TEXT,                      -- me | unclear | <name>
  due TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',  -- new | pending | decided
  UNIQUE (signal_key, idx)
);
CREATE TABLE IF NOT EXISTS mentions (
  candidate_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  strength TEXT NOT NULL,          -- id | alias | provisional
  PRIMARY KEY (candidate_id, entity_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,             -- open | scheduled | done | dropped | merged
  title TEXT NOT NULL,
  title_history TEXT NOT NULL DEFAULT '[]',
  owner TEXT,
  due TEXT,
  scheduled_for TEXT,
  state_changed_at TEXT,
  merged_into INTEGER,
  created_run INTEGER,
  updated_run INTEGER,
  reopened_run INTEGER,
  reopened_reason TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS task_sources (
  task_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  role TEXT NOT NULL,              -- origin | update | context | ignored
  added_run INTEGER,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, candidate_id)
);
CREATE TABLE IF NOT EXISTS task_anchors (
  anchor TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  PRIMARY KEY (anchor, task_id)
);
CREATE TABLE IF NOT EXISTS task_links (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- possible_duplicate | related | kept_separate
  confidence REAL,
  reason TEXT,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  decision_id INTEGER
);
CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY,
  into_task INTEGER NOT NULL,
  from_task INTEGER NOT NULL,
  moved TEXT NOT NULL,             -- json: sources, anchors, prior state
  ts TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vectors (
  owner_type TEXT NOT NULL,        -- candidate
  owner_id INTEGER NOT NULL,
  model TEXT NOT NULL,             -- embedder name and version
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,               -- float32
  PRIMARY KEY (owner_type, owner_id, model)
);

-- log
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started TEXT NOT NULL,
  matcher_version TEXT,
  embedder TEXT,
  notes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  candidate_id INTEGER NOT NULL,
  stage TEXT NOT NULL,             -- anchor | entity | semantic | judge | rule
  outcome TEXT NOT NULL,
  task_id INTEGER,
  other_task_id INTEGER,
  verdict TEXT,
  confidence REAL,
  reason TEXT,
  scores TEXT,
  matcher_version TEXT,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,              -- merge | keep | split | detach
  a INTEGER,
  b INTEGER,
  decision_id INTEGER,
  note TEXT
);
"""


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def default_store_dir():
    return os.environ.get("TM_STORE") or os.path.expanduser("~/Context/dailyBriefs/matching")


def connect(store_dir):
    os.makedirs(store_dir, exist_ok=True)
    conn = sqlite3.connect(os.path.join(store_dir, "tasks.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn


def load_config(store_dir):
    path = os.path.join(store_dir, "config.json")
    if not os.path.exists(path):
        return {"me": {"emails": [], "slack_ids": [], "names": []}, "embedder": "ollama",
                "ollama_model": "nomic-embed-text", "ollama_url": "http://localhost:11434"}
    with open(path) as f:
        return json.load(f)


def save_config(store_dir, cfg):
    with open(os.path.join(store_dir, "config.json"), "w") as f:
        json.dump(cfg, f, indent=2)


def current_run(conn):
    row = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    return row


def add_run_note(conn, run_id, note):
    row = conn.execute("SELECT notes FROM runs WHERE id=?", (run_id,)).fetchone()
    notes = json.loads(row["notes"]) if row else []
    if note not in notes:
        notes.append(note)
        conn.execute("UPDATE runs SET notes=? WHERE id=?", (json.dumps(notes), run_id))


def live_task(conn, task_id):
    """Follow merge redirects so an old task ID still resolves."""
    seen = set()
    while task_id is not None and task_id not in seen:
        seen.add(task_id)
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return None
        if row["state"] != "merged":
            return row
        task_id = row["merged_into"]
    return None


def add_history(conn, task_id, kind, text, decision_id=None):
    conn.execute("INSERT INTO history (task_id, ts, kind, text, decision_id) VALUES (?,?,?,?,?)",
                 (task_id, now(), kind, text, decision_id))
