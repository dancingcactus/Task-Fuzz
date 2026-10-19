#!/usr/bin/env python3
"""Task matching spike CLI. Run `tm.py -h` for commands.

Typical run (SKILL.md walks through it):
  tm.py sync                      read your [x] / [-] / ⏰ marks from the last report
  tm.py cursors                   where each source should be read from
  tm.py ingest signals.json       store signals, resolve entities, embed asks
  tm.py propose                   stages 1-3; writes pending_judgments.json
  tm.py apply verdicts.json       stage 4 verdicts from the judge
  tm.py report                    write Matched Tasks.md
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import matcher  # noqa: E402
import render  # noqa: E402
import store  # noqa: E402
import tasks  # noqa: E402
import vectors  # noqa: E402

REPORT_NAME = "Matched Tasks.md"


def _ctx(args, new_run=False):
    conn = store.connect(args.store)
    cfg = store.load_config(args.store)
    emb = vectors.make_embedder(cfg, getattr(args, "embedder", None))
    run = store.current_run(conn)
    if new_run or run is None:
        cur = conn.execute("INSERT INTO runs (started, matcher_version, embedder) VALUES (?,?,?)",
                           (store.now(), matcher.MATCHER_VERSION, emb.model if emb else "off"))
        conn.commit()
        run_id = cur.lastrowid
    else:
        run_id = run["id"]
    ctx = matcher.Context(conn, cfg, emb, run_id)
    if emb is None:
        ctx.note("Stage 3 (semantic) off by configuration")
    return ctx


def _embed_note(ctx):
    if not ctx.embed_ok:
        return "semantic stage: off"
    return f"embedder {ctx.embedder.model}, " + ("sqlite-vec" if ctx.vec_sql else "python cosine")


def _load_json(path):
    with open(path) as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("items") or data.get("signals") or data.get("verdicts") or []


def cmd_init(args):
    conn = store.connect(args.store)
    cfg = store.load_config(args.store)
    me = cfg.setdefault("me", {"emails": [], "slack_ids": [], "names": []})
    for key, vals in (("emails", args.me_email), ("slack_ids", args.me_slack), ("names", args.me_name)):
        for v in vals or []:
            if v not in me[key]:
                me[key].append(v)
    if args.embedder:
        cfg["embedder"] = args.embedder
    if args.ollama_model:
        cfg["ollama_model"] = args.ollama_model
    store.save_config(args.store, cfg)
    vec = vectors.load_sqlite_vec(conn)
    print(f"Store: {os.path.join(args.store, 'tasks.db')}")
    print(f"Embedder: {cfg.get('embedder')} ({cfg.get('ollama_model')})" if cfg.get("embedder") == "ollama"
          else f"Embedder: {cfg.get('embedder')}")
    print(f"sqlite-vec: {vec or 'not loaded (python cosine fallback)'}")
    emb = vectors.make_embedder(cfg)
    if emb:
        try:
            emb.embed(["ping"])
            print("Embedder check: ok")
        except vectors.EmbedderUnavailable as e:
            print(f"Embedder check: FAILED, stage 3 will be skipped until fixed. {e}")


def cmd_cursors(args):
    conn = store.connect(args.store)
    for src, since in matcher.cursors(conn).items():
        print(f"{src.upper()}_SINCE={since}")


def cmd_ingest(args):
    ctx = _ctx(args, new_run=True)
    counts = matcher.ingest(ctx, _load_json(args.file))
    print(f"run {ctx.run_id}: " + ", ".join(f"{k}={v}" for k, v in counts.items()))


def cmd_propose(args):
    ctx = _ctx(args)
    stats, pending = matcher.propose(ctx)
    path = os.path.join(args.store, "pending_judgments.json")
    with open(path, "w") as f:
        json.dump({"run_id": ctx.run_id, "items": pending}, f, indent=2)
    print(f"run {ctx.run_id} ({_embed_note(ctx)}): " + (", ".join(f"{k}={v}" for k, v in stats.items()) or "nothing to do"))
    print(f"{len(pending)} candidate(s) need the judge -> {path}")


def cmd_apply(args):
    ctx = _ctx(args)
    stats = tasks.apply_verdicts(ctx, _load_json(args.file))
    print(", ".join(f"{k}={v}" for k, v in stats.items()) or "no verdicts applied")


def cmd_sync(args):
    conn = store.connect(args.store)
    path = args.file or os.path.join(args.store, REPORT_NAME)
    if not os.path.exists(path):
        print("No previous report, nothing to sync.")
        return
    with open(path) as f:
        changes = render.sync(conn, f.read())
    print("\n".join(changes) if changes else "No changes in the report.")


def cmd_report(args):
    ctx = _ctx(args)
    text = render.render(ctx.conn, ctx.run_id, _embed_note(ctx))
    path = args.out or os.path.join(args.store, REPORT_NAME)
    with open(path, "w") as f:
        f.write(text)
    print(f"Wrote {path}")
    for r in ctx.conn.execute("SELECT stage, outcome, COUNT(*) n FROM decisions WHERE run_id=? "
                              "GROUP BY stage, outcome", (ctx.run_id,)):
        print(f"  {r['stage']:<9} {r['outcome']:<19} {r['n']}")


def cmd_show(args):
    conn = store.connect(args.store)
    t = store.live_task(conn, args.id)
    if t is None:
        sys.exit(f"No task #{args.id}")
    print(json.dumps(dict(t), indent=2))
    print("\nAnchors:", [r["anchor"] for r in conn.execute("SELECT anchor FROM task_anchors WHERE task_id=?", (t["id"],))])
    print("\nEntities:")
    for r in conn.execute("SELECT DISTINCT e.type, e.name, m.strength FROM task_sources ts JOIN mentions m "
                          "ON m.candidate_id=ts.candidate_id JOIN entities e ON e.id=m.entity_id WHERE ts.task_id=?",
                          (t["id"],)):
        print(f"  {r['type']}: {r['name']} ({r['strength']})")
    print("\nHistory:")
    for r in conn.execute("SELECT ts, kind, text FROM history WHERE task_id=? ORDER BY id", (t["id"],)):
        print(f"  {r['ts']} [{r['kind']}] {r['text']}")
    print("\nDecisions:")
    for r in conn.execute("SELECT d.* FROM decisions d WHERE d.task_id=? OR d.other_task_id=? ORDER BY d.id",
                          (t["id"], t["id"])):
        print(f"  #{r['id']} cand {r['candidate_id']} {r['stage']}/{r['outcome']} conf={r['confidence']} "
              f"{r['reason'] or ''} {r['scores']}")


def cmd_state(args, state):
    conn = store.connect(args.store)
    tasks.set_state(conn, args.id, state, getattr(args, "date", None))
    conn.commit()
    print(f"#{args.id} -> {state}")


def cmd_merge(args):
    conn = store.connect(args.store)
    mid = tasks.merge(conn, args.a, args.b)
    print(f"Merged #{args.a} into #{args.b} (undo: tm.py split {mid})")


def cmd_keep(args):
    conn = store.connect(args.store)
    tasks.keep_separate(conn, args.a, args.b)
    print(f"Kept #{args.a} and #{args.b} separate")


def cmd_split(args):
    conn = store.connect(args.store)
    tasks.split(conn, args.merge_id)
    print(f"Undid merge {args.merge_id}")


def cmd_detach(args):
    ctx = _ctx(args)
    tid = tasks.detach(ctx.conn, ctx, args.candidate_id)
    print(f"Candidate {args.candidate_id} is now task #{tid}")


def cmd_reembed(args):
    ctx = _ctx(args)
    rows = ctx.conn.execute("SELECT id, ask FROM candidates WHERE kind='ask'").fetchall()
    vecs = ctx.embed([r["ask"] for r in rows]) if rows else []
    if vecs is None:
        sys.exit("Embedder unavailable")
    for r, v in zip(rows, vecs):
        vectors.put(ctx.conn, "candidate", r["id"], ctx.embedder.model, v)
    ctx.conn.commit()
    print(f"Embedded {len(rows)} asks with {ctx.embedder.model}")


def cmd_reset(args):
    if not args.yes:
        sys.exit("This deletes tasks.db (config.json is kept). Re-run with --yes.")
    for name in ("tasks.db", "tasks.db-wal", "tasks.db-shm", "pending_judgments.json"):
        p = os.path.join(args.store, name)
        if os.path.exists(p):
            os.remove(p)
    print("Store reset.")


def main(argv=None):
    p = argparse.ArgumentParser(description="Task matching spike")
    p.add_argument("--store", default=store.default_store_dir(), help="store folder (env TM_STORE)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init")
    s.add_argument("--me-email", action="append")
    s.add_argument("--me-slack", action="append")
    s.add_argument("--me-name", action="append")
    s.add_argument("--embedder", choices=["ollama", "hash", "off"])
    s.add_argument("--ollama-model")
    s.set_defaults(fn=cmd_init)

    sub.add_parser("cursors").set_defaults(fn=cmd_cursors)
    for name, fn in (("ingest", cmd_ingest), ("apply", cmd_apply)):
        s = sub.add_parser(name)
        s.add_argument("file")
        s.add_argument("--embedder", choices=["ollama", "hash", "off"])
        s.set_defaults(fn=fn)
    for name, fn in (("propose", cmd_propose), ("reembed", cmd_reembed)):
        s = sub.add_parser(name)
        s.add_argument("--embedder", choices=["ollama", "hash", "off"])
        s.set_defaults(fn=fn)
    s = sub.add_parser("sync")
    s.add_argument("--file")
    s.set_defaults(fn=cmd_sync)
    s = sub.add_parser("report")
    s.add_argument("--out")
    s.add_argument("--embedder", choices=["ollama", "hash", "off"])
    s.set_defaults(fn=cmd_report)
    s = sub.add_parser("show")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_show)
    for name, state in (("done", "done"), ("drop", "dropped"), ("reopen", "open")):
        s = sub.add_parser(name)
        s.add_argument("id", type=int)
        s.set_defaults(fn=lambda a, st=state: cmd_state(a, st))
    s = sub.add_parser("schedule")
    s.add_argument("id", type=int)
    s.add_argument("date")
    s.set_defaults(fn=lambda a: cmd_state(a, "scheduled"))
    s = sub.add_parser("merge", help="merge A into B")
    s.add_argument("a", type=int)
    s.add_argument("b", type=int)
    s.set_defaults(fn=cmd_merge)
    s = sub.add_parser("keep", help="keep A and B separate")
    s.add_argument("a", type=int)
    s.add_argument("b", type=int)
    s.set_defaults(fn=cmd_keep)
    s = sub.add_parser("split", help="undo a task merge")
    s.add_argument("merge_id", type=int)
    s.set_defaults(fn=cmd_split)
    s = sub.add_parser("detach", help="pull an auto-attached source out into its own task")
    s.add_argument("candidate_id", type=int)
    s.add_argument("--embedder", choices=["ollama", "hash", "off"])
    s.set_defaults(fn=cmd_detach)
    s = sub.add_parser("reset")
    s.add_argument("--yes", action="store_true")
    s.set_defaults(fn=cmd_reset)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
