"""Every vector read and write goes through this file, so the backend can be swapped.

Vectors are float32 blobs in the `vectors` table. When sqlite-vec loads, cosine
similarity runs in SQL (vec_distance_cosine); otherwise it runs in Python. Each
vector records the embedder that made it, and only same-model vectors are compared.

Embedders:
  ollama  local model over HTTP (default nomic-embed-text): work text stays on the machine
  hash    deterministic bag-of-words hashing, for tests and offline runs
"""

import hashlib
import json
import math
import re
import struct
import urllib.request

SQLITE_VEC_PIN = "0.1.6"  # keep in step with requirements.txt

STOP = set("a an and are as at be by for from has have i in is it of on or our please re that the this to we will with you your can could should would need needs".split())


class EmbedderUnavailable(Exception):
    pass


def load_sqlite_vec(conn):
    """Return the sqlite-vec version string, or None if it can't load (stage 3 then uses Python cosine)."""
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return conn.execute("SELECT vec_version()").fetchone()[0]
    except Exception:
        return None


class HashEmbedder:
    dim = 256

    @property
    def model(self):
        return "hash-v1"

    def embed(self, texts):
        out = []
        for t in texts:
            v = [0.0] * self.dim
            toks = [w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if w not in STOP and len(w) > 1]
            for w in toks:
                stem = w[:5]  # crude stemming so "review"/"reviewing" collide
                h = int(hashlib.md5(stem.encode()).hexdigest(), 16)
                v[h % self.dim] += 1.0 if (h >> 8) % 2 else -1.0
            out.append(_normalize(v))
        return out


class OllamaEmbedder:
    def __init__(self, url, model):
        self.url = url.rstrip("/")
        self.name = model
        self.dim = None

    @property
    def model(self):
        return "ollama:" + self.name

    def embed(self, texts):
        body = json.dumps({"model": self.name, "input": ["clustering: " + (t or "") for t in texts]}).encode()
        req = urllib.request.Request(self.url + "/api/embed", data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                vecs = json.load(r)["embeddings"]
        except Exception as e:
            raise EmbedderUnavailable(f"Ollama at {self.url} with model {self.name}: {e}")
        self.dim = len(vecs[0]) if vecs else self.dim
        return [_normalize(v) for v in vecs]


def make_embedder(cfg, override=None):
    kind = override or cfg.get("embedder", "ollama")
    if kind == "hash":
        return HashEmbedder()
    if kind == "off":
        return None
    return OllamaEmbedder(cfg.get("ollama_url", "http://localhost:11434"), cfg.get("ollama_model", "nomic-embed-text"))


def _normalize(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _pack(v):
    return struct.pack(f"{len(v)}f", *v)


def _unpack(b):
    return list(struct.unpack(f"{len(b) // 4}f", b))


def put(conn, owner_type, owner_id, model, vec):
    conn.execute("INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)",
                 (owner_type, owner_id, model, len(vec), _pack(vec)))


def get(conn, owner_type, owner_id, model):
    row = conn.execute("SELECT vec FROM vectors WHERE owner_type=? AND owner_id=? AND model=?",
                       (owner_type, owner_id, model)).fetchone()
    return _unpack(row["vec"]) if row else None


def similarities(conn, query_vec, owner_type, owner_ids, model, use_sql):
    """Cosine similarity from query_vec to each owner's vector. Returns {owner_id: sim}."""
    if not owner_ids:
        return {}
    ids = list(owner_ids)
    marks = ",".join("?" * len(ids))
    if use_sql:
        rows = conn.execute(
            f"SELECT owner_id, 1 - vec_distance_cosine(vec, ?) AS sim FROM vectors "
            f"WHERE owner_type=? AND model=? AND owner_id IN ({marks})",
            [_pack(query_vec), owner_type, model] + ids).fetchall()
        return {r["owner_id"]: r["sim"] for r in rows}
    rows = conn.execute(
        f"SELECT owner_id, vec FROM vectors WHERE owner_type=? AND model=? AND owner_id IN ({marks})",
        [owner_type, model] + ids).fetchall()
    out = {}
    for r in rows:
        v = _unpack(r["vec"])
        out[r["owner_id"]] = sum(a * b for a, b in zip(query_vec, v))
    return out
