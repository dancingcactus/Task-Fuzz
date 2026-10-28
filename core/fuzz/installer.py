"""`fuzz install` / `fuzz uninstall`: the skills, the MCP registration and the launchd jobs, for one client.

Safe to run again. Every file and config entry it touches goes into install-manifest.json in the
store folder, and uninstall removes exactly those. Because Copilot also reads ~/.claude/skills/,
installing for both writes the skills once, there, so Copilot doesn't see each skill twice.
"""

import json
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

from . import adapters, events
from .adapters.base import PKG_PARENT, ROLE_SKILLS, SKILLS_SRC, skill_version
from .db import FuzzError

ROLES = ("executor", "extractor", "sender")
LAUNCHD_INTERVAL = {"executor": 15 * 60, "extractor": 60 * 60, "sender": 2 * 60}   # the sender exits at once if nothing waits


def manifest_path(core):
    return os.path.join(core.home, "install-manifest.json")


def load_manifest(core):
    p = manifest_path(core)
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return json.load(f)


def save_manifest(core, man):
    tmp = manifest_path(core) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(man, f, indent=2)
    os.replace(tmp, manifest_path(core))


def _ours(man):
    return {s["path"] for entry in man.values() if isinstance(entry, dict) for s in entry.get("skills", [])}


def _remove_path(p):
    p = Path(p)
    if p.is_symlink() or p.is_file():
        p.unlink()
    elif p.is_dir():
        shutil.rmtree(p)


def _mkdirs(path, created):
    missing = []
    p = Path(path)
    while not p.exists():
        missing.append(p)
        p = p.parent
    for d in reversed(missing):
        d.mkdir()
        if str(d) not in created:
            created.append(str(d))


def _remove_if_empty(path):
    """Remove a folder or config file Fuzz created, but only if nothing else is in it now."""
    p = Path(path)
    if p.is_dir():
        if not any(p.iterdir()):
            p.rmdir()
    elif p.is_file():
        try:
            data = json.loads(p.read_text() or "{}")
        except ValueError:
            return
        if not any(v for v in data.values()):
            p.unlink()


def _claude_has_skills(man):
    return any(Path(s["path"]).exists() for s in man.get("claude-code", {}).get("skills", []))


def install(core, client, roles=ROLES, link=False, launchd=None, actor="human"):
    adapter = adapters.get(client)
    roles = list(roles)
    for r in roles:
        if r not in ROLES:
            raise FuzzError("roles are executor, extractor and sender", "roles")
    man = load_manifest(core)
    entry = man.get(client) or {"skills": [], "mcp": [], "roles": []}
    ours = _ours(man)

    created = list(entry.get("created", []))   # folders and files Fuzz made, removed again when left empty
    skills = [s for s in entry.get("skills", []) if s["role"] not in roles]
    via = None
    if client == "copilot" and _claude_has_skills(man):
        via = "claude-code"
    for role in roles if not via else []:
        name = ROLE_SKILLS[role]
        src = SKILLS_SRC / name
        dest = adapter.skills_dir() / name
        if dest.exists() or dest.is_symlink():
            if str(dest) not in ours:
                raise FuzzError(f"{dest} exists and wasn't installed by Fuzz. Move it away first.", "client", 409)
            _remove_path(dest)
        _mkdirs(dest.parent, created)
        if link:
            dest.symlink_to(src, target_is_directory=True)
        else:
            shutil.copytree(src, dest)
        skills.append({"role": role, "name": name, "path": str(dest), "link": link,
                       "prompt_version": skill_version(src)})
    entry["skills"] = skills
    entry["skills_via"] = via

    mcp = [m for m in entry.get("mcp", []) if m["name"] not in {adapter.mcp_name(r) for r in roles}]
    for role in roles:
        cfg_file = rec_file = getattr(adapter, "config_path", None)
        existed = cfg_file().exists() if cfg_file else True
        if cfg_file and not existed:
            _mkdirs(cfg_file().parent, created)
        rec = adapter.register_mcp(role, fuzz_home=core.home, user_id=core.user_id)
        if not existed and str(rec_file()) not in created:
            created.append(str(rec_file()))
        mcp.append(dict(rec, role=role))
    entry["mcp"] = mcp
    entry["created"] = created
    entry["roles"] = sorted(set(entry.get("roles", [])) | set(roles))
    man[client] = entry

    if launchd is None:
        launchd = sys.platform == "darwin"
    if launchd:   # every install, so a fix to the jobs (their PATH, say) reaches a machine set up before it
        man["_launchd"] = _write_launchd(core, man.get("_launchd"))
    save_manifest(core, man)

    cfg = core.config
    first = not (cfg.get("engine") or {}).get("client")
    with core.tx(actor):
        events.emit(core, "engine.installed", data={"client": client, "roles": roles, "link": link})
        if first:
            prior = dict(cfg.get("engine") or {})
            cfg["engine"] = {"client": client, "model": prior.get("model")}
            core.save_config(cfg)
            events.emit(core, "engine.selected", data={"engine": cfg["engine"], "prior": prior, "why": "first install"})
    return {"client": client, "skills": [s["path"] for s in skills], "skills_via": via,
            "mcp": [m["name"] for m in mcp], "engine_set": first}


def uninstall(core, client, actor="human"):
    adapter = adapters.get(client)
    man = load_manifest(core)
    entry = man.pop(client, None)
    if entry is None:
        raise FuzzError(f"Fuzz isn't installed for {adapter.label}", "client", 404)
    for s in entry.get("skills", []):
        _remove_path(s["path"])
    for m in entry.get("mcp", []):
        adapter.unregister_mcp(m["role"])
    for p in reversed(entry.get("created", [])):
        _remove_if_empty(p)
    if "_launchd" in man and not [k for k in man if not k.startswith("_")]:
        _remove_launchd(man.pop("_launchd"))
    save_manifest(core, man)
    cfg = core.config
    with core.tx(actor):
        events.emit(core, "engine.removed", data={"client": client})
        if (cfg.get("engine") or {}).get("client") == client:
            prior = dict(cfg["engine"])
            cfg["engine"] = {"client": None, "model": None}
            core.save_config(cfg)
            events.emit(core, "engine.selected", data={"engine": cfg["engine"], "prior": prior, "why": "uninstalled"})
    return {"client": client, "removed": [s["path"] for s in entry.get("skills", [])] + [m["name"] for m in entry.get("mcp", [])]}


# ---------------------------------------------------------------- launchd (macOS)

def launchd_path():
    """launchd starts jobs with only /usr/bin:/bin:/usr/sbin:/sbin, so a run can't find `copilot` or `claude`
    in ~/.local/bin. Give the jobs the folders the clients are in, then the PATH you installed from."""
    dirs = [os.path.dirname(p) for p in (shutil.which(a.exe) for a in adapters.ADAPTERS.values()) if p]
    dirs += (os.environ.get("PATH") or "").split(os.pathsep) + ["/usr/local/bin", "/opt/homebrew/bin",
                                                               "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    return os.pathsep.join(dict.fromkeys(d for d in dirs if d))


def _plist(core, label, args, interval=None, keepalive=False):
    d = {"Label": label, "ProgramArguments": [sys.executable, "-m", "fuzz", *args],
         "EnvironmentVariables": {"PYTHONPATH": PKG_PARENT, "FUZZ_HOME": core.home, "PATH": launchd_path()},
         "StandardOutPath": os.path.join(core.home, f"{label}.log"),
         "StandardErrorPath": os.path.join(core.home, f"{label}.log")}
    if interval:
        d["StartInterval"] = interval
    if keepalive:
        d["KeepAlive"] = True
        d["RunAtLoad"] = True
    return d


def _write_launchd(core, prior=None):
    """prior: the last install's record, so folders it created are still removed on uninstall."""
    agents = Path(os.path.expanduser("~/Library/LaunchAgents"))
    created = list((prior or {}).get("created", []))
    _mkdirs(agents, created)
    jobs = {f"com.fuzz.u{core.user_id}.serve": _plist(core, f"com.fuzz.u{core.user_id}.serve", ["serve"], keepalive=True)}
    for role in ROLES:
        label = f"com.fuzz.u{core.user_id}.{role}"
        jobs[label] = _plist(core, label, ["run", role, "--trigger", "launchd"], interval=LAUNCHD_INTERVAL[role])
    paths = []
    for label, d in jobs.items():
        p = agents / f"{label}.plist"
        new = plistlib.dumps(d)
        changed = not p.exists() or p.read_bytes() != new
        if changed:
            p.write_bytes(new)
        paths.append(str(p))
        _reload(label, str(p), changed)
    return {"plists": paths, "created": created}


def _reload(label, path, changed):
    """Load a job, or reload it when its plist changed (unload first, or launchd keeps the job it already
    has). A job that's loaded and unchanged is left running."""
    if not shutil.which("launchctl"):
        return
    loaded = subprocess.run(["launchctl", "list", label], capture_output=True).returncode == 0
    if loaded and not changed:
        return
    if loaded and os.environ.get("XPC_SERVICE_NAME") == label:
        # This process is that job (`fuzz serve`, updating from Settings): unloading it ends this process
        # before load runs, so a detached shell does both once the request has had its answer.
        subprocess.Popen(["/bin/sh", "-c", 'sleep 1; launchctl unload "$0"; launchctl load -w "$0"', path],
                         start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        return
    if loaded:
        subprocess.run(["launchctl", "unload", path], capture_output=True)
    subprocess.run(["launchctl", "load", "-w", path], capture_output=True)


def _remove_launchd(rec):
    for p in rec.get("plists", []):
        if shutil.which("launchctl"):
            subprocess.run(["launchctl", "unload", "-w", p], capture_output=True)
        _remove_path(p)
    for p in reversed(rec.get("created", [])):
        _remove_if_empty(p)


def set_engine(core, client=None, model=None):
    """`fuzz config set engine.client …` goes through here, so every switch writes engine.selected."""
    cfg = core.config
    prior = dict(cfg.get("engine") or {})
    eng = dict(prior)
    if client is not None:
        adapters.get(client)
        eng["client"] = client
    if model is not None:
        eng["model"] = model or None
    cfg["engine"] = eng
    with core.tx("human"):
        core.save_config(cfg)
        events.emit(core, "engine.selected", data={"engine": eng, "prior": prior})
    return eng

