"""`fuzz`: the command line. Admin and debugging for you; the AI uses MCP, never this."""

import argparse
import json
import os
import shutil
import sys

from . import answers, cards, doctor, events, installer, matching, scheduler, tasks
from .config import ME_KEYS, get as cfg_get, set_ as cfg_set, update_me
from .db import Core, FuzzError, default_home


def _core(a):
    return Core(a.home, a.user)


def _print(obj):
    print(json.dumps(obj, indent=2, default=str, ensure_ascii=False))


def _value(v):
    if v is None:
        return None
    try:
        return json.loads(v)
    except ValueError:
        return v


def cmd_init(a):
    from .http_api import ensure_token
    core = _core(a)
    cfg = core.config
    me = update_me(cfg, add={"names": a.me_name, "emails": a.me_email, "slack_ids": a.me_slack})
    if a.embedder:
        cfg["embedder"] = a.embedder
    if a.tz:
        cfg["tz"] = a.tz
    core.save_config(cfg)
    tok = ensure_token(core.home, core.user_id)
    _print({"home": core.home, "user": core.user_id, "token": tok, "me": me})
    if len(me["emails"]) < 2:
        print("Have a work and a personal address? Add the other too, so Fuzz knows both are yours:\n"
              "  fuzz me add --email you@work.example --slack W123", file=sys.stderr)


def cmd_me(a):
    """Every name, email and Slack ID that is yours. The executor uses a connector signed in to any of them
    without asking which account you meant."""
    core = _core(a)
    cfg = core.config
    if a.op != "show":
        vals = {"names": a.name, "emails": a.email, "slack_ids": a.slack}
        if not any(vals.values()):
            raise FuzzError("Pass --email, --name or --slack", "email")
        update_me(cfg, **{a.op: vals})
        core.save_config(cfg)
    _print({k: cfg["me"].get(k, []) for k in ME_KEYS})


def cmd_user_add(a):
    from .http_api import ensure_token
    core = _core(a)
    uid = (core.one("SELECT COALESCE(MAX(id), 0) m FROM users")["m"]) + 1
    core.q("INSERT INTO users (id, name, created_at) VALUES (?,?,?)", (uid, a.name, core.now_iso()))
    _print({"user": uid, "token": ensure_token(core.home, uid)})


def cmd_serve(a):
    from .http_api import ensure_token, make_server
    srv = make_server(a.home or default_home(), "127.0.0.1", a.port)
    tok = ensure_token(a.home or default_home(), 1)
    print(f"Fuzz core on http://127.0.0.1:{a.port}/ (token in {os.path.join(a.home or default_home(), 'tokens.json')})")
    print(f"Open your queue: http://127.0.0.1:{a.port}/?token={tok}  (once per browser; it remembers)", flush=True)
    if a.show_token:
        print(f"token: {tok}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_mcp(a):
    from .mcp_server import serve
    serve(a.role, a.run, a.home, a.user)


def cmd_run(a):
    from .runner import run_role
    core = _core(a)
    sigs = []
    for path in a.signals or []:
        with open(path) as f:
            sigs += json.load(f)
    res = run_role(core, a.role, a.client, a.model, a.task, a.scripted, a.verbose, a.trigger, sigs)
    _print(res)


def _attach(core, tid, path):
    from . import files
    with open(path, "rb") as f:
        data = f.read()
    r = files.attach(core, tid, os.path.basename(path), data)
    return {"source_id": r["id"], "name": r["title"], "mime": r["mime"], "size": r["size"], "path": r["path"]}


def cmd_capture(a):
    core = _core(a)
    for p in a.file or []:
        if not os.path.isfile(p):
            raise FuzzError(f"No file {p}", "file")
    tid = tasks.capture(core, " ".join(a.text), a.doc, due=a.due)
    _print({"task_id": tid, "files": [_attach(core, tid, p) for p in a.file or []]})


def cmd_attach(a):
    if not os.path.isfile(a.path):
        raise FuzzError(f"No file {a.path}", "path")
    _print(_attach(_core(a), a.id, a.path))


def cmd_tasks(a):
    core = _core(a)
    for t in tasks.list_tasks(core, a.state):
        print(f"#{t['id']:<4} {t['state']:<9} {t['title']}")


def cmd_show(a):
    from .http_api import task_view
    core = _core(a)
    t = tasks.live(core, a.id)
    if t is None:
        raise FuzzError(f"No task {a.id}", "id", 404)
    _print(task_view(core, t, full=True))


def cmd_cards(a):
    core = _core(a)
    for c, t in cards.queue(core):
        v = cards.view(core, c, t)
        print(f"card {v['id']:<4} {v['kind']:<13} {('#' + str(t['id'])) if t else '':<5} {v['prompt']}"
              f"  [{', '.join(v['options'])}]")


def cmd_answer(a):
    _print(answers.answer(_core(a), a.card, a.option, _value(a.value)))


def cmd_task_action(a):
    core = _core(a)
    fn = {"assign": lambda: tasks.assign(core, a.id, a.value), "done": lambda: tasks.done(core, a.id),
          "park": lambda: tasks.park(core, a.id), "letgo": lambda: tasks.let_go(core, a.id),
          "wait": lambda: tasks.wait(core, a.id, a.value), "session": lambda: tasks.session(core, a.id),
          "schedule": lambda: tasks.schedule(core, a.id, _value(a.value)),
          "reopen": lambda: tasks.bring_back(core, a.id, "front", "You brought this back.", "task.reopened")}[a.action]
    fn()
    _print({"task_id": a.id, "state": tasks.get(core, a.id)["state"]})


def cmd_moment(a):
    from .timeres import local_iso, moment_key
    core = _core(a)
    anchor = {"type": "moment", "label": a.label, "at": local_iso(core, a.when, "when"),
              "key": a.key or moment_key(a.label), "cancelled": a.cancelled}
    _print({"task_id": a.id, "label": scheduler.suggest_schedule(core, a.id, anchor, None, actor="human"),
            "key": anchor["key"]})


def cmd_merge(a):
    _print({"merge_id": matching.merge(_core(a), a.a, a.b)})


def cmd_keep(a):
    matching.keep_separate(_core(a), a.a, a.b)
    _print({"kept_separate": [a.a, a.b]})


def cmd_split(a):
    matching.split(_core(a), a.merge_id)
    _print({"split": a.merge_id})


def cmd_undo(a):
    core = _core(a)
    _print(events.undo_list(core) if a.list else events.undo(core, a.group))


def cmd_tick(a):
    _print(scheduler.tick(_core(a)))


def cmd_wake(a):
    _print({"came_back": scheduler.wake(_core(a))})


def cmd_checkin(a):
    from . import checkins
    _print(checkins.record(_core(a), a.answer, a.follow_up))


def cmd_rebuild(a):
    core = _core(a)
    if a.check:
        diff = events.check_replay(core)
        _print({"replay_matches": not diff, "differs": diff})
        if diff:
            sys.exit(1)
    else:
        _print({"replayed": events.rebuild(core)})


def cmd_config(a):
    core = _core(a)
    cfg = core.config
    if a.op == "get":
        _print(cfg_get(cfg, a.key) if a.key else cfg)
        return
    if a.key in ("engine.client", "engine.model"):
        val = _value(a.value)
        _print({"engine": installer.set_engine(core, **{a.key.split(".")[1]: val})})
        return
    cfg_set(cfg, a.key, _value(a.value))
    core.save_config(cfg)
    _print({a.key: cfg_get(cfg, a.key)})


def cmd_install(a):
    roles = a.roles.split(",") if a.roles else installer.ROLES
    _print(installer.install(_core(a), a.client, roles, a.link, False if a.no_launchd else None))


def cmd_uninstall(a):
    _print(installer.uninstall(_core(a), a.client))


def cmd_doctor(a):
    st = doctor.status(_core(a), refresh=True, check_start=not a.no_start_check)
    if a.json:
        _print(st)
        return
    eng = st["engine"]
    print(f"Engine: {eng['client'] or 'not set'}" + (f" ({eng['model']})" if eng.get("model") else ""))
    for c in st["clients"]:
        word = {"ready": "Ready", "needs_attention": "Needs attention", "not_installed": "Not installed"}[c["summary"]]
        print(f"\n{c['label']}: {word}" + (f" — {c['first_fix']}" if c["first_fix"] else ""))
        print(f"  client   {'found ' + (c['version'] or '') if c['found'] else 'not found'}")
        for s in c["skills"]:
            print(f"  skill    {s['name']}: {s['status']}" + (f" (via {s['via']})" if s.get("via") else ""))
        for m in c["mcp"]:
            starts = "" if m["starts"] is None else (f", starts with {m['tools']} tools" if m["starts"] else ", doesn't start")
            print(f"  mcp      {m['name']}: {'registered' if m['registered'] else 'not registered'}{starts}")
        if c["last_run"]:
            r = c["last_run"]
            print(f"  last run {r['role']} {r['outcome'] or 'running'} at {r['started_at']}")
        if c["installed"]:
            print(f"  connect  {c['connectors']['note']}")


def cmd_reset(a):
    if not a.yes:
        raise FuzzError("This deletes the whole store. Pass --yes to confirm.", "yes")
    home = a.home or default_home()
    for name in ("fuzz.db", "fuzz.db-wal", "fuzz.db-shm"):
        p = os.path.join(home, name)
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(os.path.join(home, "runs"), ignore_errors=True)
    _print({"reset": home})


def parser():
    p = argparse.ArgumentParser(prog="fuzz", description="The Fuzz core: store, rules, HTTP API and MCP server.")
    p.add_argument("--home", default=None, help="store folder (default: $FUZZ_HOME or the platform data folder)")
    p.add_argument("--user", type=int, default=None, help="user id (default 1)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="set up the store, who you are, and the API token")
    s.add_argument("--me-name", action="append")
    s.add_argument("--me-email", action="append")
    s.add_argument("--me-slack", action="append")
    s.add_argument("--embedder", choices=["ollama", "hash", "off"])
    s.add_argument("--tz")
    s.set_defaults(fn=cmd_init)

    s = sub.add_parser("me", help="who you are: add your other email addresses, names and Slack IDs")
    s.add_argument("op", nargs="?", default="show", choices=["show", "add", "remove"])
    s.add_argument("--email", action="append")
    s.add_argument("--name", action="append")
    s.add_argument("--slack", action="append")
    s.set_defaults(fn=cmd_me)

    s = sub.add_parser("user", help="add a user (each has their own queue)")
    s.add_argument("op", choices=["add"])
    s.add_argument("name")
    s.set_defaults(fn=cmd_user_add)

    s = sub.add_parser("serve", help="run the HTTP API, event stream and UI on 127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--show-token", action="store_true")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("mcp", help="run the MCP server over stdio (started by an AI client)")
    s.add_argument("--role", required=True, choices=["executor", "extractor", "sender"])
    s.add_argument("--run", type=int)
    s.set_defaults(fn=cmd_mcp)

    s = sub.add_parser("run", help="run a role headless, the same way launchd does")
    s.add_argument("role", choices=["executor", "extractor", "sender"])
    s.add_argument("--client", choices=["claude-code", "copilot"])
    s.add_argument("--model")
    s.add_argument("--task", type=int)
    s.add_argument("--scripted", action="store_true", help="canned output: checks the core without calling a model")
    s.add_argument("--verbose", action="store_true")
    s.add_argument("--trigger", default="manual", choices=["manual", "launchd", "ui"])
    s.add_argument("--signals", action="append", help="scripted extractor: a signals JSON file to submit")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("capture", help="capture a task")
    s.add_argument("text", nargs="+")
    s.add_argument("--doc", action="append", help="a document's name only (the demo's behaviour)")
    s.add_argument("--file", action="append", help="attach a file (Fuzz keeps a copy for the executor)")
    s.add_argument("--due")
    s.set_defaults(fn=cmd_capture)

    s = sub.add_parser("attach", help="attach a file to a task")
    s.add_argument("id", type=int)
    s.add_argument("path")
    s.set_defaults(fn=cmd_attach)

    s = sub.add_parser("tasks", help="list tasks")
    s.add_argument("--state")
    s.set_defaults(fn=cmd_tasks)

    s = sub.add_parser("show", help="one task with its log, sources and cards")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_show)

    sub.add_parser("cards", help="the triage queue").set_defaults(fn=cmd_cards)

    s = sub.add_parser("answer", help="answer a card")
    s.add_argument("card", type=int)
    s.add_argument("option")
    s.add_argument("--value", help="text, or JSON such as '{\"anchor\": {\"type\": \"at_desk\"}}'")
    s.set_defaults(fn=cmd_answer)

    s = sub.add_parser("task", help="act on a task directly (debugging)")
    s.add_argument("id", type=int)
    s.add_argument("action", choices=["assign", "done", "park", "letgo", "wait", "session", "schedule", "reopen"])
    s.add_argument("--value")
    s.set_defaults(fn=cmd_task_action)

    s = sub.add_parser("moment", help="add a described date to a task's Schedule options (at most two)")
    s.add_argument("id", type=int)
    s.add_argument("label", help="e.g. \"Before the leadership meeting\"")
    s.add_argument("when", help="when it should come back, e.g. 2026-10-30T09:00 (your time zone)")
    s.add_argument("--key", help="name it, to move or cancel it later (default: from the label)")
    s.add_argument("--cancelled", action="store_true", help="the meeting was cancelled")
    s.set_defaults(fn=cmd_moment)

    for name, fn in (("merge", cmd_merge), ("keep", cmd_keep)):
        s = sub.add_parser(name, help=f"{name} two tasks (a into b for merge)")
        s.add_argument("a", type=int)
        s.add_argument("b", type=int)
        s.set_defaults(fn=fn)
    s = sub.add_parser("split", help="undo a merge by its id")
    s.add_argument("merge_id", type=int)
    s.set_defaults(fn=cmd_split)

    s = sub.add_parser("undo", help="undo your last decision")
    s.add_argument("--list", action="store_true")
    s.add_argument("--group", type=int)
    s.set_defaults(fn=cmd_undo)

    sub.add_parser("tick", help="run the clock once: due tasks come back, deadlines, stale").set_defaults(fn=cmd_tick)
    sub.add_parser("wake", help="you're back at your desk").set_defaults(fn=cmd_wake)
    s = sub.add_parser("checkin", help="record how you're doing (the UI decides when to ask)")
    s.add_argument("answer", choices=["good", "okay", "tired", "overloaded"])
    s.add_argument("--follow-up", choices=["take_5", "hold_rest", "quick_first"])
    s.set_defaults(fn=cmd_checkin)

    s = sub.add_parser("rebuild", help="replay the event log into the tasks and cards tables")
    s.add_argument("--check", action="store_true", help="only report whether replay matches")
    s.set_defaults(fn=cmd_rebuild)

    s = sub.add_parser("config", help="get or set config (engine.client switches the engine)")
    s.add_argument("op", choices=["get", "set"])
    s.add_argument("key", nargs="?")
    s.add_argument("value", nargs="?")
    s.set_defaults(fn=cmd_config)

    s = sub.add_parser("install", help="install the skills and MCP server for a client")
    s.add_argument("--client", required=True, choices=["claude-code", "copilot"])
    s.add_argument("--roles", help="executor,extractor,sender (default all three)")
    s.add_argument("--link", action="store_true", help="symlink the skills, for development")
    s.add_argument("--no-launchd", action="store_true")
    s.set_defaults(fn=cmd_install)

    s = sub.add_parser("uninstall", help="remove exactly what install added")
    s.add_argument("--client", required=True, choices=["claude-code", "copilot"])
    s.set_defaults(fn=cmd_uninstall)

    s = sub.add_parser("doctor", help="check each client is ready")
    s.add_argument("--json", action="store_true")
    s.add_argument("--no-start-check", action="store_true", help="don't start the MCP server to check it")
    s.set_defaults(fn=cmd_doctor)

    s = sub.add_parser("reset", help="delete the store's database")
    s.add_argument("--yes", action="store_true")
    s.set_defaults(fn=cmd_reset)
    return p


def main(argv=None):
    a = parser().parse_args(argv)
    try:
        a.fn(a)
    except FuzzError as e:
        print(f"fuzz: {e}" + (f" (field: {e.field})" if e.field else ""), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
