"""`fuzz serve`: the HTTP API for UIs, the event stream, and the demo UI's static files.

Listens on 127.0.0.1 only. API calls need `Authorization: Bearer <token>` (or ?token= for
EventSource, which can't set headers); tokens.json in the store folder maps each token to a user.
Static files need no token: they are the UI.
"""

import json
import mimetypes
import os
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import answers, cards, config, engine, events, scheduler, tasks
from .db import Core, FuzzError

UI_ROOT = Path(__file__).resolve().parents[2]  # the repo root: index.html, js/, css/, assets/
STATIC_DIRS = ("js", "css", "assets")
SSE_HEARTBEAT = 15
TICK_SECONDS = 60


def tokens_path(home):
    return os.path.join(home, "tokens.json")


def load_tokens(home):
    p = tokens_path(home)
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def ensure_token(home, user_id=1):
    """The token for a user, creating it the first time. The file is readable only by you."""
    toks = load_tokens(home)
    for t, uid in toks.items():
        if uid == user_id:
            return t
    t = secrets.token_urlsafe(24)
    toks[t] = user_id
    os.makedirs(home, exist_ok=True)
    with open(tokens_path(home), "w") as f:
        json.dump(toks, f, indent=2)
    os.chmod(tokens_path(home), 0o600)
    return t


def task_view(core, t, full=False):
    out = cards.task_summary(t)
    out["log_head"] = (events.task_log(core, t["id"], 1) or [None])[0]
    if full:
        out["log"] = events.task_log(core, t["id"])
        out["sources"] = core.all("SELECT id, role, title, withdrawn FROM sources WHERE task_id=? AND user_id=?",
                                  (t["id"], core.user_id))
        out["cards"] = [cards.view(core, c, t) for c in cards.open_cards(core, t["id"])]
        from . import files
        out["files"] = files.listing(core, t["id"])
        out["drafts"] = core.all("SELECT * FROM drafts WHERE task_id=? AND user_id=? ORDER BY id DESC",
                                 (t["id"], core.user_id))
        out["steps_used"], out["attempts"] = t["steps_used"], t["attempts"]
        out["merged_into"], out["parent_id"] = t["merged_into"], t["parent_id"]
    return out


class App:
    """Routes, shared by every request thread. One Core (and one lock) per user."""

    def __init__(self, home, clock=None):
        self.home = home
        self.clock = clock
        self._cores = {}
        self.send_kicked = {}
        self._mu = threading.Lock()
        self.changed = threading.Condition()

    def core(self, user_id):
        with self._mu:
            if user_id not in self._cores:
                c = Core(self.home, user_id, clock=self.clock)
                c.on_commit(self._notify)
                self._cores[user_id] = c
            return self._cores[user_id]

    def _notify(self):
        with self.changed:
            self.changed.notify_all()

    def user_for(self, token):
        uid = load_tokens(self.home).get(token or "")
        return int(uid) if uid else None

    # ---- routes: (method, regex) -> handler(core, match, body, query)
    def routes(self):
        R = [
            ("GET", r"/tasks", self.list_tasks),
            ("POST", r"/tasks", self.capture),
            ("GET", r"/tasks/(\d+)", self.get_task),
            ("POST", r"/tasks/(\d+)/(assign|done|park|wait|letgo|session|reopen|schedule)", self.task_action),
            ("POST", r"/tasks/(\d+)/moments", self.add_moment),
            ("POST", r"/tasks/(\d+)/files", self.upload),
            ("DELETE", r"/tasks/(\d+)/files/(\d+)", self.remove_file),
            ("GET", r"/cards", self.list_cards),
            ("POST", r"/cards/(\d+)/answer", self.answer),
            ("GET", r"/undo", self.undo_list),
            ("POST", r"/undo", self.undo),
            ("GET", r"/events", self.events_since),
            ("POST", r"/checkin", self.checkin),
            ("POST", r"/signals/at_desk", self.at_desk),
            ("POST", r"/tick", self.tick),
            ("GET", r"/me", self.me_get),
            ("PUT", r"/me", self.me_put),
            ("GET", r"/engine", self.engine_get),
            ("PUT", r"/engine", self.engine_put),
            ("POST", r"/engine/check", self.engine_check),
            ("POST", r"/engine/run", self.engine_run),
            ("POST", r"/engine/clients/([\w-]+)/(install|update|repair|uninstall)", self.engine_action),
        ]
        return [(m, re.compile("^" + p + "$"), h) for m, p, h in R]

    def list_tasks(self, core, m, body, q):
        return {"tasks": [task_view(core, t) for t in tasks.list_tasks(core, q.get("state"))]}

    def capture(self, core, m, body, q):
        tid = tasks.capture(core, body.get("text"), body.get("docs"), due=body.get("due"))
        return {"task_id": tid}, 201

    def get_task(self, core, m, body, q):
        return task_view(core, tasks.require(core, int(m.group(1))), full=True)

    def task_action(self, core, m, body, q):
        tid, act = int(m.group(1)), m.group(2)
        if act == "assign":
            tasks.assign(core, tid, body.get("instructions"))
        elif act == "done":
            tasks.done(core, tid)
        elif act == "park":
            tasks.park(core, tid)
        elif act == "wait":
            tasks.wait(core, tid, body.get("on"))
        elif act == "letgo":
            tasks.let_go(core, tid)
        elif act == "session":
            tasks.session(core, tid)
        elif act == "schedule":
            tasks.schedule(core, tid, body.get("anchor"))
        elif act == "reopen":
            where = body.get("where", "front")
            if where not in ("front", "back"):
                raise FuzzError("where must be front or back", "where")
            tasks.bring_back(core, tid, where=where, reason="You brought this back.", type="task.reopened",
                             tags=("returning",))
        return {"task_id": tid, "state": tasks.get(core, tid)["state"]}

    def upload(self, core, m, body, q):
        """The raw file is the body: POST /tasks/14/files?name=budget.pdf with its Content-Type."""
        from . import files
        f = files.attach(core, int(m.group(1)), q.get("name"), body["_raw"], body.get("_type"))
        return {"source_id": f["id"], "name": f["title"], "mime": f["mime"], "size": f["size"]}, 201

    def remove_file(self, core, m, body, q):
        from . import files
        files.detach(core, int(m.group(1)), int(m.group(2)))
        return {"removed": int(m.group(2))}

    def add_moment(self, core, m, body, q):
        """A described date you know yourself: {label, at, key?, cancelled?}."""
        from . import timeres
        tid = int(m.group(1))
        if not isinstance(body.get("label"), str):
            raise FuzzError("label is required, like “Before the leadership meeting”", "label")
        anchor = {"type": "moment", "label": body["label"], "at": timeres.local_iso(core, body.get("at")),
                  "key": body.get("key") or timeres.moment_key(body["label"]), "cancelled": bool(body.get("cancelled"))}
        label = scheduler.suggest_schedule(core, tid, anchor, body.get("reason"), actor="human")
        return {"task_id": tid, "label": label, "key": anchor["key"]}, 201

    def list_cards(self, core, m, body, q):
        return {"cards": [cards.view(core, c, t) for c, t in cards.queue(core)], "moment": cards.moment(core)}

    def answer(self, core, m, body, q):
        if "option" not in body:
            raise FuzzError("option is required", "option")
        return answers.answer(core, int(m.group(1)), body["option"], body.get("value"))

    def undo_list(self, core, m, body, q):
        return {"recent": events.undo_list(core)}

    def undo(self, core, m, body, q):
        return events.undo(core, body.get("group"))

    def events_since(self, core, m, body, q):
        return {"events": events.since(core, int(q.get("after") or 0), min(int(q.get("limit") or 200), 1000))}

    def checkin(self, core, m, body, q):
        """The UI asked how you're doing: {answer, follow_up?}. It decides when to ask; the core keeps the answer."""
        from . import checkins
        return checkins.record(core, body.get("answer"), body.get("follow_up")), 201

    def at_desk(self, core, m, body, q):
        return {"came_back": scheduler.wake(core)}

    def tick(self, core, m, body, q):
        return scheduler.tick(core)

    def me_get(self, core, m, body, q):
        return {k: core.config["me"].get(k, []) for k in config.ME_KEYS}

    def me_put(self, core, m, body, q):
        """{names?, emails?, slack_ids?}: each list given replaces what is there."""
        for k, v in body.items():
            if k not in config.ME_KEYS or not isinstance(v, list):
                raise FuzzError("Send names, emails and slack_ids, each a list", k)
        if not body.get("emails", True):
            raise FuzzError("Keep at least one email address", "emails")
        cfg = core.config
        config.update_me(cfg, replace=body)
        core.save_config(cfg)
        return self.me_get(core, m, body, q)

    def engine_get(self, core, m, body, q):
        return engine.get(core)

    def engine_check(self, core, m, body, q):
        return engine.get(core, refresh=True)

    def engine_put(self, core, m, body, q):
        if not body.get("client"):
            raise FuzzError("client is required", "client")
        return {"engine": engine.select(core, body["client"], body.get("model"))}

    def engine_run(self, core, m, body, q):
        role = body.get("role", "executor")
        if role not in ("executor", "extractor", "sender"):
            raise FuzzError("role must be executor, extractor or sender", "role")
        return engine.run_now(core, role, body.get("task_id"), bool(body.get("scripted"))), 202

    def engine_action(self, core, m, body, q):
        return engine.action(core, m.group(1), m.group(2), body.get("roles"), bool(body.get("link")))


def make_handler(app):
    routes = app.routes()

    class Handler(BaseHTTPRequestHandler):
        server_version = "Fuzz/0.1"

        def log_message(self, fmt, *args):
            if os.environ.get("FUZZ_HTTP_LOG"):
                super().log_message(fmt, *args)

        def _send(self, status, obj, headers=None):
            data = json.dumps(obj, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _token(self, q):
            h = self.headers.get("Authorization") or ""
            return h[7:].strip() if h.lower().startswith("bearer ") else q.get("token")

        def _dispatch(self, method):
            url = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            path = url.path.rstrip("/") or "/"
            if method == "GET" and path == "/health":
                return self._send(200, {"ok": True})
            if method == "GET" and path == "/events/stream":
                return self._stream(q)
            for m, rx, h in routes:
                mt = rx.match(path)
                if mt and m == method:
                    uid = app.user_for(self._token(q))
                    if uid is None:
                        return self._send(401, {"error": "A valid token is required", "field": "Authorization"})
                    try:
                        core = app.core(uid)
                        body = self._raw_body(core) if h == app.upload else self._body()
                        with core.lock:
                            res = h(core, mt, body, q)
                        status = 200
                        if isinstance(res, tuple):
                            res, status = res
                        return self._send(status, res)
                    except FuzzError as e:
                        return self._send(e.status, e.to_dict())
                    except (ValueError, KeyError, TypeError) as e:
                        return self._send(400, {"error": f"Bad request: {e}"})
            if method == "GET":
                return self._static(path)
            if any(rx.match(path) for _, rx, _ in routes):
                return self._send(405, {"error": f"{method} isn't allowed on {path}"})
            return self._send(404, {"error": f"No route {path}"})

        def _raw_body(self, core):
            from . import files
            n = int(self.headers.get("Content-Length") or 0)
            limit = files.limits(core)[0]
            if n > limit:
                raise FuzzError(f"The file is over {limit // (1024 * 1024)} MB", "body", 413)
            return {"_raw": self.rfile.read(n) if n else b"", "_type": self.headers.get("Content-Type")}

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return {}
            raw = self.rfile.read(n)
            try:
                body = json.loads(raw)
            except ValueError:
                raise FuzzError("The body must be JSON", "body")
            if not isinstance(body, dict):
                raise FuzzError("The body must be a JSON object", "body")
            return body

        def _static(self, path):
            rel = "index.html" if path == "/" else path.lstrip("/")
            if rel != "index.html" and rel.split("/")[0] not in STATIC_DIRS:
                return self._send(404, {"error": f"No route {path}"})
            p = (UI_ROOT / rel).resolve()
            if UI_ROOT not in p.parents or not p.is_file():
                return self._send(404, {"error": f"No file {path}"})
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(str(p))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _stream(self, q):
            uid = app.user_for(self._token(q))
            if uid is None:
                return self._send(401, {"error": "A valid token is required", "field": "token"})
            last = int(self.headers.get("Last-Event-ID") or q.get("after") or 0)
            reader = Core(app.home, uid, clock=app.clock)   # its own connection, so it never waits on writers
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            beat = time.time()
            try:
                while True:
                    evs = events.since(reader, last, 200)
                    for e in evs:
                        self.wfile.write(f"id: {e['id']}\nevent: {e['type']}\ndata: {json.dumps(e)}\n\n".encode())
                        last = e["id"]
                    if evs:
                        self.wfile.flush()
                        continue
                    if time.time() - beat > SSE_HEARTBEAT:
                        self.wfile.write(b": still here\n\n")
                        self.wfile.flush()
                        beat = time.time()
                    with app.changed:   # woken by writes in this process; polls for other processes (MCP, CLI)
                        app.changed.wait(timeout=1.0)
                    if q.get("once"):
                        return
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                reader.close()

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

    return Handler


SEND_KICK_SECONDS = 120


def kick_sender(app, core, now=None):
    """Start the sender soon after you approve a draft, instead of waiting for launchd. At most one
    start every two minutes per user; a second sender would find nothing to claim anyway."""
    from . import config
    now = now or time.time()
    if not scheduler.sends_waiting(core) or not config.role_engine(core.config, "sender")[0]:
        return False
    if now - app.send_kicked.get(core.user_id, 0) < SEND_KICK_SECONDS:
        return False
    app.send_kicked[core.user_id] = now
    engine.run_now(core, "sender")
    return True


def _ticker(app, stop):
    while not stop.wait(TICK_SECONDS):
        for uid in set(load_tokens(app.home).values()):
            core = app.core(int(uid))
            try:
                with core.lock:
                    scheduler.tick(core)
                    kick_sender(app, core)
            except Exception as e:   # the clock must keep going
                print(f"tick failed for user {uid}: {e}")


PRESENCE_SECONDS = 30


def presence_check(app, watcher, idle):
    """One look at the idle time. Returns the number of tasks that came back."""
    if not watcher.check(idle):
        return 0
    n = 0
    for uid in set(load_tokens(app.home).values()):
        core = app.core(int(uid))
        with core.lock:
            n += scheduler.wake(core)
    return n


def _presence(app, stop):
    from . import presence
    cfg = app.core(1).config.get("presence") or {}
    if not cfg.get("enabled", True) or presence.idle_seconds() is None:
        return   # not a Mac, or the idle time can't be read: fuzz wake still works
    watcher = presence.Watcher(cfg.get("away_minutes", 15))
    while not stop.wait(PRESENCE_SECONDS):
        try:
            presence_check(app, watcher, presence.idle_seconds())
        except Exception as e:
            print(f"presence check failed: {e}")


def make_server(home, host="127.0.0.1", port=8765, clock=None, ticker=True):
    app = App(home, clock)
    ensure_token(home, 1)
    srv = ThreadingHTTPServer((host, port), make_handler(app))
    srv.daemon_threads = True
    srv.app = app
    srv.stop_ticker = threading.Event()
    if ticker:
        threading.Thread(target=_ticker, args=(app, srv.stop_ticker), daemon=True).start()
        threading.Thread(target=_presence, args=(app, srv.stop_ticker), daemon=True).start()
    return srv

