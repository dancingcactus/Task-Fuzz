# Fuzz core

The backend from [`docs/fuzz-core-design.md`](../docs/fuzz-core-design.md), build-order steps 1 to 5: the
store and event log, the rules, cards, the time resolver, the scheduler, the MCP server for AI
workers, the HTTP API and event stream for UIs, the CLI, and the installer for Claude Code and
GitHub Copilot.

Python 3.11+, SQLite, the official MCP Python SDK (v2) and `jsonschema`. Nothing else.

```bash
pip install -e core            # gives you the `fuzz` command (or: python3 -m fuzz, with core/ on PYTHONPATH)
fuzz init --me-name Justin --me-email you@example.com --me-slack W123
fuzz serve                     # http://127.0.0.1:8765/ — the API, the event stream and the demo UI
```

The store lives in `~/Library/Application Support/Fuzz/` on a Mac (`~/.local/share/fuzz` elsewhere).
Set `FUZZ_HOME` or pass `--home` to use another folder.

## Try it without a model

Scripted roles return canned output through the real MCP server, so the whole loop runs offline:

```bash
export FUZZ_HOME=$(mktemp -d)
fuzz init --me-name Justin --me-email jgrover@adobe.com --embedder hash
fuzz run extractor --scripted --verbose --signals spikes/task-matching/skill/fixtures/day1.json
fuzz cards                                 # the triage queue
fuzz answer 1 assign --value '{"instructions": "Keep it short"}'
fuzz run executor --scripted --verbose     # claims, logs steps, writes a draft
fuzz cards                                 # a draft card is waiting
fuzz answer <draft card> approve
fuzz undo                                  # a compensating event, never a delete
fuzz rebuild --check                       # replaying the log gives the same tables
```

## With a real engine

```bash
fuzz install --client claude-code          # skills to ~/.claude/skills/, `claude mcp add-json --scope user`
fuzz install --client copilot              # MCP entries in ~/.copilot/mcp-config.json; skills already shared
fuzz doctor                                # Ready / Needs attention / Not installed, per client
fuzz run executor [--client copilot] [--model …] [--task 14] [--verbose]
fuzz uninstall --client claude-code        # removes exactly what install added
```

`--link` symlinks the skills instead of copying them, for development. On a Mac, install also
writes launchd jobs for `fuzz serve` and the two roles.

A headless run gets its own MCP config that starts `fuzz mcp --role <role> --run <id>`, so it sees
only Fuzz's server, and every event it writes carries the run, model and `prompt_version`. Claude
Code runs with `--strict-mcp-config --tools "" --allowedTools "mcp__fuzz-<role>__*"`: no shell and no
file writes. Copilot runs with `--allow-tool fuzz-<role> --deny-tool shell --deny-tool write`.

## Interfaces

All three are thin layers over the same library, so they can't drift apart.

**MCP** (`fuzz mcp --role executor|extractor`, stdio). Each role sees only its own tools.

| Executor (13 tools) | Extractor (5 tools) |
| --- | --- |
| `whoami`, `claim_next_task`, `get_task`, `read_source`, `log_step`, `save_notes`, `save_draft`, `hand_back`, `create_task`, `request_permission`, `suggest_schedule`, `update_brief`, `release` | `whoami`, `get_cursors`, `submit_signals`, `get_pending_judgments`, `submit_verdicts` |

There is no send, post or delete tool. `update_brief` writes the task's `context_md` (a Markdown
brief for tasks with no draft) and `question` (the one thing Fuzz is asking you now).

**HTTP** (`fuzz serve`, `127.0.0.1` only, `Authorization: Bearer <token>` from `tokens.json`):

```
GET  /tasks?state=…            GET  /tasks/{id}          POST /tasks {text, docs?, due?}
POST /tasks/{id}/assign|done|park|wait|letgo|session|reopen|schedule
GET  /cards                    POST /cards/{id}/answer {option, value?}
GET  /undo                     POST /undo {group?}
GET  /events?after=N           GET  /events/stream       (server-sent events; ?token= for EventSource)
POST /signals/at_desk          POST /tick
GET  /engine                   PUT  /engine {client, model}
POST /engine/check             POST /engine/run {role, task_id?, scripted?}
POST /engine/clients/{client}/install|update|repair|uninstall
```

Errors are JSON with the field to fix: `{"error": "option must be one of …", "field": "option"}`.

**CLI**: `fuzz --help`. Everything the spike's `tm.py` did is here or in MCP (`merge`, `keep`,
`split`, `show`, `tasks`, `cards`, `answer`, `undo`, `tick`, `wake`, `rebuild`, `config`, `reset`).

## Layout

```
fuzz/db.py          schema, Core (connection, user, clock, run), transactions
fuzz/events.py      event types, the projection reducer, replay, undo
fuzz/states.py      task states and allowed moves
fuzz/tasks.py       task commands, including update_brief
fuzz/cards.py       card kinds, one-card-per-task bookkeeping, queue order, the card view
fuzz/answers.py     answer(card, option, value): the "what each answer writes" table
fuzz/timeres.py     anchors, labels and the Schedule options
fuzz/scheduler.py   claim, leases, step budget, handbacks, the minute tick, wake
fuzz/drafts.py      the approval gate: drafts and permissions
fuzz/matching/      the spike's matcher, moved in: entities, vectors, stages 1–4
fuzz/signals.py     signal and verdict schemas
fuzz/tools.py       the AI roles' tools as plain functions
fuzz/mcp_server.py  the MCP server, one tool set per role
fuzz/runner.py      `fuzz run`; fuzz/roles/scripted.py the scripted roles
fuzz/runs.py        the runs table
fuzz/adapters/      one adapter per client: Claude Code, Copilot
fuzz/installer.py   install / uninstall with a manifest; fuzz/doctor.py; fuzz/engine.py
fuzz/http_api.py    the HTTP API, event stream and static UI
fuzz/cli.py         the `fuzz` command
skills/             fuzz-executor and fuzz-extract (instructions only, versioned)
tests/              unittest suites
```

## Tests

```bash
python3 -m unittest discover core/tests
```

They cover replay against the live tables, every card kind and answer (including Undo), postpone
and expiry, check-in spacing, the brief fields, the time resolver on a fixed clock, the scheduler
(five at a time, leases, the budget), role scoping and the MCP contract (in-process and over stdio),
the spike's two-day scenario through the extractor tools, the HTTP API and event stream, two-user
isolation, and the installer and adapters against a fake home folder with stub `claude` and
`copilot` executables.

## Not built yet

- Pointing the demo UI at the core (its `tick` is still simulated), and the Settings > Engine page.
- Calendar anchors (`before_event`, `after_event`, `next_with_person`, `lighter_day`) and AI suggestions that use them.
  "Later today" uses 4 PM until the calendar is readable, and "back at my desk" fires on `fuzz wake` or `POST /signals/at_desk`.
- Actuators. Approving a draft marks it approved; you copy it into Mail or Slack.
- Waking the executor on `task.assigned` instead of on a timer.
- Automatic entity cards. The answers exist; the matcher doesn't raise them yet.
- Copilot's MCP config file and per-run flag are still marked "to confirm" (`fuzz/adapters/copilot.py`).
