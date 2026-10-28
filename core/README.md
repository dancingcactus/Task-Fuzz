# Fuzz core

The backend from [`docs/fuzz-core-design.md`](../docs/fuzz-core-design.md), build-order steps 1 to 5: the
store and event log, the rules, cards, the time resolver, the scheduler, the MCP server for AI
workers, the HTTP API and event stream for UIs, the CLI, and the installer for Claude Code and
GitHub Copilot.

Python 3.11+, SQLite, the official MCP Python SDK (v2) and `jsonschema`. Nothing else.

```bash
pip install -e core            # gives you the `fuzz` command (or: python3 -m fuzz, with core/ on PYTHONPATH)
fuzz init --me-name Justin --me-email you@example.com --me-slack W123
fuzz serve                     # the API, the event stream and the UI; open the ?token= link it prints
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
fuzz answer <draft card> approve           # a note is filed; a message moves to `sending`
fuzz run sender --scripted --verbose       # claims approved drafts and marks them sent (sends nothing)
fuzz undo                                  # a compensating event, never a delete
fuzz rebuild --check                       # replaying the log gives the same tables
```

## With a real engine

```bash
fuzz install --client claude-code          # skills to ~/.claude/skills/, `claude mcp add-json --scope user`
fuzz install --client copilot              # MCP entries in ~/.copilot/mcp-config.json; skills already shared
fuzz doctor                                # Ready / Needs attention / Not installed, per client
fuzz run executor [--client copilot] [--model …] [--task 14] [--verbose]
fuzz run sender                            # sends what you approved; exits at once if nothing waits
fuzz uninstall --client claude-code        # removes exactly what install added
```

`--link` symlinks the skills instead of copying them, for development. On a Mac, install also
writes launchd jobs for `fuzz serve` and the three roles, with a `PATH` that finds `copilot` and
`claude` (launchd's own has neither). Every install rewrites and reloads them.

## Setup

```bash
fuzz setup                                 # who you are, the tools Fuzz can use, an output folder, a check
fuzz setup --step tools --client copilot --discover   # list the client's tools again (one run)
fuzz setup --step folder --folder ~/Documents/Fuzz    # or - for none
```

The UI walks through the same steps the first time you connect, and from Settings > Set up Fuzz.
Each step can be skipped and done again later.

1. **Who you are**: your other email addresses, names and Slack IDs, so a connector signed in to any
   of them is yours without asking.
2. **Which tools Fuzz can use.** Fuzz asks the client once which tools it loads: one run that sees
   every tool and can call none (Fuzz can't list them itself, since most connectors sign in through
   the client). What it found is kept in `connectors.json` and grouped into **Look things up** and
   **Send**. Only tools that read are suggested, a tool whose name acts (`do_action`, `delete_…`) is
   never suggested whatever the run said, and a send tool is never pre-selected. Your choice is written
   to `read.tools` and `send.tools` in the client's own syntax (`workiq(fetch)` for Copilot,
   `mcp__claude_ai_Gmail__search` for Claude Code). Re-run it whenever you add a connector.
3. **An output folder** (`output.folder`, suggested `~/Documents/Fuzz`). See Output folder.
4. **Check**: `fuzz doctor`, per client.

**Always allow** on a permission card for a connector adds that connector's lookup tools to
`read.tools`, for every client that found it, so the next run can use it. `whoami` lists the
connectors setup found but you haven't allowed (`can_ask_for`), so the executor asks by a name that
matches. Allow once records the grant only.

## Output folder

The one place the executor may create and change files, with no draft and no permission request: a
document, a spreadsheet, a checklist, an export. Each task gets its own subfolder, `<id> <title>/`,
made when the executor claims it (`get_task` gives it as `output_dir`). A run may write only there:
Claude Code gets `Write` and `Edit` on that folder, Copilot `--allow-tool 'write(<folder>/**)'` instead
of `--deny-tool write` (`write(<folder>)` alone matches nothing inside it). Nothing in it is sent.

Whatever a run leaves in a task's subfolder is recorded on the task (a `sources` row with role
`output`, and a `task.file_written` event), and the card and task sheet link to it through
`GET /files/<source id>`. Files are overwritten in place; once written they stay, and Undo doesn't
remove them. Approved notes (`Note.md`) and results (`Result.md`) are saved there too. A draft can
name files in its subfolder in `attach`; the sender gets their paths, may read that folder, and
attaches them, or reports that its tool can't.

A headless run gets its own MCP config that starts `fuzz mcp --role <role> --run <id>`, so it sees
only Fuzz's server, and every event it writes carries the run, model and `prompt_version`. Claude
Code runs with `--strict-mcp-config --tools "" --allowedTools "mcp__fuzz-<role>__*"`: no shell and no
file writes. The executor also gets read-only access to the attachments folder (see Attachments). Copilot runs with `--allow-tool fuzz-<role> --deny-tool shell --deny-tool write`. Copilot loads your own MCP servers
whatever the config says, and `--allow-tool` only skips the prompt, so the executor and sender also get
`--available-tools`: the model sees Fuzz's server, the tools you listed and, for attachments, `view`, and nothing
else. The sender is the
exception (see Sending).

## Interfaces

All three are thin layers over the same library, so they can't drift apart.

**MCP** (`fuzz mcp --role executor|extractor|sender`, stdio). Each role sees only its own tools.

| Executor (13 tools) | Extractor (5 tools) | Sender (4 tools) |
| --- | --- | --- |
| `whoami`, `claim_next_task`, `get_task`, `read_source`, `log_step`, `save_notes`, `save_draft`, `hand_back`, `create_task`, `request_permission`, `suggest_schedule`, `update_brief`, `finish_gathering`, `release` | `whoami`, `get_cursors`, `submit_signals`, `get_pending_judgments`, `submit_verdicts` | `whoami`, `claim_next_send`, `mark_sent`, `send_failed` |

`suggest_schedule` also takes a moment (see Calendar times).

No role has a Fuzz tool that sends, posts or deletes. The sender sends with its client's own connector. `update_brief` writes the task's `context_md` (a Markdown
brief for tasks with no draft), `summary` (a sentence or two on what Fuzz did or found, shown above the brief) and `question` (the one thing Fuzz is asking you now).

**HTTP** (`fuzz serve`, `127.0.0.1` only, `Authorization: Bearer <token>` from `tokens.json`):

```
GET  /tasks?state=…            GET  /tasks/{id}          POST /tasks {text, docs?, due?}
POST /tasks/{id}/assign|done|park|wait|letgo|session|reopen|schedule
POST /tasks/{id}/moments {label, at, key?, cancelled?}
POST /tasks/{id}/files?name=…  (raw body)    DELETE /tasks/{id}/files/{source_id}
GET  /cards                    POST /cards/{id}/answer {option, value?}
GET  /undo                     POST /undo {group?}       (each command undoes on its own; see Undo)
POST /checkin {answer, follow_up?}
GET  /events?after=N           GET  /events/stream       (server-sent events; ?token= for EventSource)
POST /signals/at_desk          POST /tick
GET  /engine                   PUT  /engine {client, model}
POST /engine/check             POST /engine/run {role: executor|extractor|sender, task_id?, scripted?}
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
fuzz/checkins.py    check-in answers (the UI decides when to ask)
fuzz/timeres.py     anchors, labels and the Schedule options
fuzz/scheduler.py   claim, leases, step budget, handbacks, moments, the minute tick, wake
fuzz/presence.py    back-at-desk detection on a Mac
fuzz/files.py       attachments, in a folder per task
fuzz/outputs.py     the output folder: a subfolder per task, what runs wrote, notes and results as Markdown
fuzz/connectors.py  tool discovery, the lookup/send split, read.tools and send.tools
fuzz/setup.py       `fuzz setup` and the UI's guided setup
fuzz/drafts.py      the approval gate: drafts, sending and permissions
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
skills/             fuzz-executor, fuzz-extract and fuzz-send (instructions only, versioned)
tests/              unittest suites
```

## Tests

```bash
python3 -m unittest discover core/tests
```

They cover replay against the live tables, every card kind and answer (including Undo), postpone
and expiry, check-in spacing, the brief fields, the time resolver on a fixed clock, the scheduler
(two at a time by default, leases, the budget), role scoping and the MCP contract (in-process and over stdio),
the spike's two-day scenario through the extractor tools, the HTTP API and event stream, two-user
isolation, and the installer and adapters against a fake home folder with stub `claude` and
`copilot` executables.

## Undo

Every human command is one undo group. `POST /undo` reverses the newest, or the one named by
`group`, on its own: commands aren't a stack, so undoing a park leaves a later done on another task
alone. It's refused (409, with the reason in `error`) once a later event changed a field that decides
what the command did: Fuzz claimed the task you assigned, the draft you approved went out, or you moved
the task again (undo that first). `GET /undo` lists recent commands with `blocked` set to that reason.

## Check-ins

The UI decides when to ask how you're doing (it knows how long you've been at it) and keeps the
follow-ups. The core keeps the answer: `POST /checkin {"answer": "overloaded", "follow_up": "hold_rest"}`
writes `checkin.answered`, sets the queue's moment, and for `hold_rest` schedules every card that isn't
time-sensitive for tomorrow morning in the same undo group. `fuzz checkin tired` does the same.

## Sending

Approving a draft moves the task to `sending` (a note is just filed). The **sender** role then sends
the approved body, word for word, with its client's own connector and calls `mark_sent`, which writes
`task.sent`; nothing undoes that. If it can't, `send_failed` brings the draft back to review with the
reason. If a send run stops partway, the task comes back to you to check rather than being retried.

The sender is the one headless run that loads your own MCP servers and connectors (no
`--strict-mcp-config`), and it may call only Fuzz's sender tools plus the tools you list for sending:

```bash
fuzz config set send.tools.claude-code '["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Slack__slack_send_message"]'
```

With none listed, `fuzz doctor` says so and every approved draft comes back unsent. Copilot's syntax for
allowing one MCP tool is still to confirm (`fuzz/adapters/copilot.py`). `fuzz serve` starts the sender
within a couple of minutes of an approval, and launchd runs it every two minutes; it exits without
starting a client when nothing waits.

## Lookup tools for the executor

The executor has only Fuzz's own tools (and read access to your attachments) unless you allow it
connector tools for looking things up, such as a search or a calendar. Pick them in `fuzz setup`, or
list them by hand. List only tools that read: whatever is listed runs without asking.

```bash
fuzz config set read.tools.copilot '["Glean"]'      # every tool of Copilot's Glean server
fuzz config set read.tools.claude-code '["mcp__claude_ai_Google_Calendar__list_events"]'
```

With any listed, a Claude Code executor run also loads your own MCP servers (no `--strict-mcp-config`),
and may call only Fuzz's executor tools plus those.

## Gathering context on capture

When an executor engine is set, a task you capture goes to Fuzz before it reaches triage. It waits as
queued with the `gather` tag, `fuzz serve` starts an executor run at once, and the run looks the task
up with your attachments and the lookup tools above, writes the brief and calls `finish_gathering`.
Then the task lands in triage with its card, and nothing has been asked. When looking it up is the
whole task (a summary, an agenda, an answer) and the run's tools reach it, Fuzz does it then and calls
`finish_gathering` with `result: true`: the task arrives done, Done first, and you never assign it. Turn
that off with `fuzz config set gather.finish_results false`. While gathering, the
executor can't draft, hand back, ask for permission or split the task.

If no run gets to it within `gather.minutes` (10), or a run fails on it `budget.max_attempts` times,
it comes to triage as captured. Turn it off with `fuzz config set gather.enabled false`.

### Looking into a task you scheduled

Schedule a task with instructions (`schedule` with `{anchor, instructions}`) and Fuzz gathers on it
the same way, with your request in its notes ("You said: …") and `comes_back` on the claimed task.
`finish_gathering` then moves it to `scheduled` instead of triage, so it still comes back at the time
you picked, with the brief (or the result) in. Fuzz has until that time; if no run gets to it, it comes
back as it was. Without an executor engine the instructions are only kept in the notes.

## Calendar times

The core never reads your calendar. Instead a task carries up to two **moments**: described dates
such as "Before the leadership meeting", Thu 10/30 at 9:00. The AI finds them with its own calendar
connector (`suggest_schedule`, or `moments` on an extracted ask), or you add one:

```bash
fuzz moment 14 "Before the leadership meeting" 2026-10-30T09:00     # your time zone
curl -H "Authorization: Bearer $TOKEN" -d '{"label": "Before the leadership meeting", "at": "2026-10-30T09:00"}' \
  http://127.0.0.1:8765/tasks/14/moments
```

Moments come first in the Schedule options. `at` is when the task comes back. Handing in the same
`key` again with a new time moves a task scheduled on it (`task.anchor_moved`); `cancelled: true`
brings it back to triage with the reason (`task.anchor_lost`). The button reads as the moment's
label (one line, at most 60 characters); every other option's label comes from the core's templates.

**Back at my desk.** On a Mac, `fuzz serve` watches the keyboard and mouse idle time (`ioreg`). When
you come back after 15 minutes or more away (`presence.away_minutes`), the at-desk tasks come back.
`fuzz wake` still works by hand.

## Attachments

Files you add to a task are kept in a folder per task, `<store>/files/u<user>/t<task>/`. Fuzz
doesn't open them. The executor gets each file's path, name, type and size from `get_task` (and
`read_source`) and reads it with its own client's file tools, so PDFs, images and documents are read
however that client reads them best.

```bash
fuzz capture "Summarise the budget" --file budget.pdf --file chart.png
fuzz attach 14 notes.txt
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" --data-binary @budget.pdf \
  "http://127.0.0.1:8765/tasks/14/files?name=budget.pdf"
```

Limits: 25 MB a file and 10 files a task (`files.max_mb`, `files.max_per_task`). Attaching writes
`task.file_attached` ("You attached budget.pdf"). `DELETE /tasks/{id}/files/{source_id}` removes one.

A headless executor run may read **only this user's files folder**. Claude Code gets `--tools Read`
(the one built-in), `--allowedTools "Read(//<folder>/**)"` and `--add-dir <folder>`, and starts in that
folder. In `dontAsk` mode a read anywhere else is refused. It still can't run commands or write.
Copilot gets `--add-dir <folder>` with shell and write still denied; whether its reads stay inside
added folders is still to confirm. Fuzz's log records that a file was handed over; reads made with
the client's own tool aren't in it.

## Not built yet

- The Settings > Engine page. (The UI itself runs on the core: open the link `fuzz serve` prints. See
  `js/live.js`.)
- "Later today" is 4 PM, not "after your last meeting", since the core doesn't read the calendar.
- Waking the executor on `task.assigned` instead of on a timer.
- Automatic entity cards. The answers exist; the matcher doesn't raise them yet.
- Copilot's MCP config file and per-run flag are still marked "to confirm" (`fuzz/adapters/copilot.py`).
