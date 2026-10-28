# Fuzz core: design

Status: draft for discussion. Build-order steps 1 to 5 are built in [`core/`](../core/README.md), with two
additions to the task record: `context_md`, a Markdown brief the AI writes for tasks with no draft,
`summary`, a sentence or two on what it did or found, and `question`, the one question it is asking you
now. All are set with the executor's `update_brief` tool
(or on an extracted ask) and written as `task.brief_updated` events. Calendar times (step 7) are built
more simply than below: the core never reads a calendar. A task carries up to two **moments**, described
dates the AI looks up with its own calendar connector (or you type), and the four calendar anchors
collapse into that one. See [Moments](#moments). A task you capture goes to the executor first, to
gather context with its read-only tools, and reaches triage when it calls `finish_gathering`
(`task.gathered`); see `core/README.md`, Gathering context on capture. Files you attach are kept in a folder per task and handed to the
executor as paths; a headless executor run may read that user's files folder with its client's own
read tool, and nothing else (see `core/README.md`, Attachments).

Decided before wiring the UI to the core (each is reflected in the sections below):

- **Undo is per command, not a stack.** Each command undoes on its own. It's refused when a later
  event changed a field that decides what happened (the state, the lease, the draft…), with the
  reason; bookkeeping fields a later event changed keep their newer value. See
  [Events are the source of truth](#events-are-the-source-of-truth).
- **Check-ins belong to the UI.** The UI decides when to ask and keeps the ADHD niceties; the core
  records the answer (`POST /checkin`, `checkin.answered`) and applies what it means for the queue.
  There's no `checkin` card kind.
- **The Schedule panel draws the core's options** (`card.schedule_options`) and keeps no list of its own.
- **The AI sends approved drafts with its own connectors.** Approving moves the task to `sending`; a
  narrow **sender** role sends exactly the approved body and writes `task.sent`. There are no
  actuators in the core. See [Approval gate and sending](#approval-gate-and-sending).

## Summary

Fuzz becomes a task system with a **core** at the centre: a store, an append-only event log and the
rules that decide what happens next. Everything else talks to the core, and to nothing else:

- **Extractors** turn email, Slack and meetings into tasks.
- **Executors** pick up tasks and take the next step on each.
- **UIs** show the queue, take your decisions and give Fuzz his voice.

The AI in the extractor and executor roles is a stateless worker. It reads the store through tools,
does one step and writes the result back. Because no part depends on any other, the AI, the UI and
where it all runs can each change on their own.

It runs locally on a Mac first, for one person. The design keeps two later moves cheap: running as a
web app, and supporting several users who each have their own queue.

```
 sources (email, Slack, meetings)
        │
        ▼
 ┌─────────────┐   signals    ┌──────────────────────────────┐   HTTP + events  ┌──────────────┐
 │  extractor  │ ───────────► │          Fuzz core           │ ◄──────────────► │      UI      │
 │  (any AI)   │              │  store · event log · rules   │                  │  + Fuzz's    │
 └─────────────┘              │  scheduler · approval gate   │                  │  personality │
                              └──────────────────────────────┘                  └──────────────┘
 ┌─────────────┐    tools (MCP)          ▲
 │  executor   │ ────────────────────────┘
 │  (any AI)   │
 └─────────────┘
```

## Goals

1. **Separate extraction, execution and UI.** Each one talks only to the core, through a fixed format.
2. **Make the AI swappable.** Changing the model changes how good the judgments are, never how the
   system behaves.
3. **Show the work.** Every change is an event in the log. "Done so far", Undo and "why did this
   happen?" are all read from it.
4. **Humans approve what can't be undone.** This is enforced by the tools available, not by prompts.
5. **Local first, then web, then multiple users,** without a rewrite.

## Not goals for now

- AI-written personality. Fuzz stays deterministic: the UI chooses lines and moods from fixed tables
  (see [Personality](#personality)).
- Teams or shared queues. Multiple users means one queue per person, nothing shared.
- Real-time collaboration, mobile apps, a plugin system.
- Domains (personal, work and so on). They're a later idea, noted in
  [Later: domains](#later-domains) so nothing now gets in their way.

## Principles that shape the design

| Rule | What it means here |
| --- | --- |
| Deterministic before fuzzy | Code settles everything it can (ordering, anchors, state rules). The AI only judges what code hands it. |
| The AI judges, the core acts | The AI returns a verdict, a draft or a handback. The core turns that into state changes. |
| One log, many views | Task state is computed from events. Nothing changes a task's state without writing an event. |
| No AI logic in the core | If it must behave the same whatever model is running, it is code in the core. |
| Every row has an owner | Every table carries `user_id` from day one, even with one user. |

## Components

### Core

A single local service. It owns the database and is the only thing that writes to it. It provides:

- **Store and event log** (see [Data model](#data-model)).
- **Rules**: the state machine, the done/dropped/scheduled rules from the matching spike, the step
  budget, and automatic handback.
- **Scheduler**: decides which task a worker gets next (see
  [Choosing the next task](#choosing-the-next-task)).
- **Cards**: decides what to ask you, with which answers, and what each answer does (see
  [Cards and actions](#cards-and-actions)).
- **Time resolver**: turns human times like "before the planning review" into real ones, and keeps
  them up to date (see [Scheduling with human time](#scheduling-with-human-time)).
- **Approval gate**: holds drafts until a human approves, then hands them to the sender role, which sends them with its own connectors.
- **Interfaces**: an HTTP API for UIs, an MCP server for AI workers, a CLI for you, and an event
  stream that UIs subscribe to.

The HTTP API, the MCP server and the CLI are thin layers over the same core library, so they can't
drift apart. See [Who uses which interface](#who-uses-which-interface).

### Extractor

Reads sources and produces **signals** in the shape of
[`signal-schema.md`](../spikes/task-matching/skill/references/signal-schema.md). The core runs
matching stages 1 to 3 (anchors, entities, semantic) itself, as in the spike. Stage 4, the judge, is
an AI role that returns verdicts in the spike's format:

```json
{"candidate_id": 12, "task_id": 3, "verdict": "same", "confidence": 0.9, "new_ask": false, "reason": "..."}
```

The core maps confidence to an outcome (merge, possible duplicate, related, new). That is already how
`tasks.apply_verdicts` works.

The extractor stays an AI skill, not core code, because it reads email and Slack through the AI
client's own connectors. It talks to the core through its own MCP tools (see
[Extractor tools](#extractor-tools-mcp)), which replace the spike's `tm.py` commands.

### Executor

A loop that runs: claim a task → read it → do one step → write the result back → release. It holds no
state between runs. Anything the next run needs goes into the task's notes or log.

The executor can only change the world in three ways:

- **Inside the system**: log steps, write notes, create subtasks.
- **Through a draft** that waits for approval.
- **By handing back** with a question.
- **By asking permission** to read a new source or use a connector.

There is no `send`, `post` or `delete` tool.

### UI

The current clickable demo, with the simulated `tick` in `js/store.js` replaced by calls to the core.
It reads tasks over HTTP, subscribes to the event stream for changes, and sends your decisions
(assign, done, schedule, park, approve, undo) as commands. Fuzz's personality lives here. Settings
also installs and chooses the AI engine (see [Engine settings in the UI](#engine-settings-in-the-ui)).

## Data model

SQLite locally, with tables that port to Postgres. It grows out of the spike's schema (raw, derived
and log zones). The new parts are below.

```sql
users        (id, name, created_at)                    -- one row for now
events       (id, user_id, ts, actor, type, task_id, payload, caused_by, run_id, model, prompt_version)
tasks        (id, user_id, state, assignee, title, ask, done_when, group_id, due, order_key, notes, context_md, question,
              variant_tags, steps_used, attempts, lease_owner, lease_until,
              schedule_anchor, schedule_fire_at, schedule_hints, updated_event_id)
groups       (id, user_id, title, origin, link, state)   -- made by the core from the origin, see Groups
cards        (id, user_id, kind, task_id, other_id, prompt, reason, options, suggested,
              schedule_options, status, postponed, created_event_id, answered_event_id)
drafts       (id, user_id, task_id, kind, body, target, status, approved_by, approved_at)
grants       (id, user_id, scope, resource, kind, created_event_id)   -- "always allow" answers
runs         (id, user_id, role, client, model, prompt_version, trigger, started_at, finished_at, outcome)
sources      (id, user_id, task_id, signal_key, role)  -- thin references, never full messages
```

The spike's `signals`, `candidates`, `entities`, `identifiers`, `aliases`, `task_links`, `merges`,
`vectors`, `decisions` and `feedback` tables carry over, each gaining `user_id`.

### Events are the source of truth

- **Append-only.** `tasks` is a projection: it can be rebuilt by replaying `events`, and every row
  records the last event it reflects.
- **`actor`** is `human`, `fuzz:extractor`, `fuzz:executor`, `fuzz:sender` or `system`.
- **`model` and `prompt_version`** are recorded on every AI-made event. This lets you compare models
  on the same tasks and trace any decision back to what made it.
- **Undo** writes a compensating event (`task.restored`, with the earlier state in its payload). It
  never deletes. Commands aren't a stack: each one undoes on its own, whatever came after it on other
  tasks. Undo is refused (409, with the reason) when a later event changed a **decisive** field the undo
  would put back: a task's state, assignee, lease, notes, question, schedule or title, a card's or
  draft's status, a draft's body. So once Fuzz has claimed an assigned task, or a draft has been sent,
  that command can't be undone; you pull the task back instead. A later command you undid and its undo
  cancel out. Bookkeeping fields (tags, order, deadline level) keep whatever later events set them to.
  `GET /undo` lists recent commands with `blocked` saying why one no longer undoes. Something already
  sent outside (`task.sent`) can't be undone, which is why the approval gate exists.

### Task states

These match the demo's states.

| State | Assignee | Meaning |
| --- | --- | --- |
| `triage` | human | In your queue, waiting for a routing decision. Includes handbacks and reopened tasks. |
| `queued` | fuzz | Assigned to Fuzz and waiting for a free slot ("Next up"). |
| `working` | fuzz | An executor holds the lease. |
| `review` | human | A draft is waiting for your OK. |
| `sending` | fuzz | You approved it; Fuzz's sender is sending it with its own connector. Undo takes the approval back until the sender claims it. |
| `session` | human | Open in a working session with Claude. |
| `scheduled` | human | Comes back at a human time ("when I'm back at my desk"). Stores an anchor, not just a time. |
| `waiting` | — | Waiting on someone else. The extractor watches for the reply. |
| `parked` | — | Kept, never nags. Can wake on a new mention. |
| `done`, `letgo` | — | Closed. Comes back only on a genuinely new ask. |
| `merged` | — | Redirects to the task it was merged into. |

What you see in Triage is a list of **cards**, not tasks. A routing card is about one task in
`triage`. Question and approval cards are their own records that point at a task. Check-ins aren't
cards in the core: the UI asks, and the core records the answer. See [Cards and actions](#cards-and-actions).

### Event types

The names match the moments Fuzz already reacts to, so the personality layer is a lookup table:

```
task.captured   task.extracted   task.merged      task.split       task.assigned
task.claimed    task.step        task.draft_ready task.approved    task.sent
task.handed_back task.scheduled  task.woke        task.parked      task.waiting
task.done       task.let_go      task.restored    task.stale       task.deadline_level
task.reopened   task.reply_in    task.came_back   task.anchor_moved task.anchor_lost
task.confirmed  task.draft_edited task.sent_back task.send_failed
task.review_due task.kept_parked task.check_back_set
group.created   group.linked     group.unlinked   group.renamed    group.wrapped
entity.merged   entity.kept_separate entity.defined
card.created    card.answered    card.postponed   card.expired
permission.asked permission.granted permission.denied
checkin.answered
run.started     run.finished
engine.installed engine.removed engine.selected
```

`card.created` carries the card's `kind` (`duplicate`, `entity_person`, `is_task`…), so the
personality layer can react to each kind differently.

## AI roles and contracts

| Role | Input | Output | Who checks it |
| --- | --- | --- | --- |
| `extractor.reader` | Raw source items since the cursor | Signals (schema) | Core rejects anything that doesn't match the schema |
| `extractor.judge` | `pending_judgments` shortlist | Verdicts (schema) | Core maps confidence to an outcome |
| `executor` | One claimed task | Tool calls only | Core enforces the state rules, budget and approval gate |

- Each role is set in config, so roles can be upgraded on different schedules and each can run on
  any supported client. See [Choosing the client for a role](#choosing-the-client-for-a-role).
- The prompts describe the role, not the model (like `judge-rubric.md`), and carry a
  `prompt_version`.
- Every role has a **scripted** version that returns canned output. The spike's tests already do this
  for the judge. If the system runs end to end on scripted roles, the models really are swappable,
  and tests never need to call a model.

## Executor tools (MCP)

Kept small on purpose. Past about fifteen tools, a model starts choosing the wrong one.

| Tool | Does | Notes |
| --- | --- | --- |
| `claim_next_task()` | Returns the next eligible task and takes a lease on it | The scheduler picks the task, not the AI |
| `get_task(id)` | Returns the ask, sources, notes and recent log | Sources are references; use `read_source` to fetch content |
| `read_source(source_id)` | Returns one source's content | Read through the core, so the access is logged and per user |
| `log_step(id, kind, text)` | Adds to "Done so far" | `kind`: research, action, guidance |
| `save_notes(id, text)` | Replaces the short "where I left off" notes | For the next run of a stateless worker |
| `save_draft(id, kind, target, body)` | Stores a draft. The task moves to `review` | The only way towards anything outside the system |
| `hand_back(id, question, options?)` | Sends the task to triage with an either/or question | Goes to the end of the queue |
| `create_task(ask, done_when, sources)` | Splits off a task or captures a follow-up. A split-off task joins the original's group | Goes through matching like any other ask |
| `request_permission(id, scope, resource, why)` | Asks to read a new source or use a connector | Creates a permission card. The task waits until you answer |
| `suggest_schedule(id, anchor, reason)` | Adds a human-time option for this task | Checked by the core. See [AI suggestions](#ai-suggestions) |
| `update_brief(id, context_md?, summary?, question?)` | Writes the Markdown brief, the summary above it and the one question shown to you | The task card's prompt is the question; answering clears it |
| `release(id)` | Gives up the lease | A lease that runs out releases itself |

Every call checks that the caller holds the lease on that task and that the task belongs to the
caller's user.

## Extractor tools (MCP)

The same MCP server, started with a different role (`fuzz mcp --role extractor`). Each role sees only
its own tools, so the executor can't submit signals and the extractor can't claim tasks.

| Tool | Does | Replaces in the spike |
| --- | --- | --- |
| `whoami()` | Returns your names, email addresses, Slack IDs and the folders to read | The values hard-coded in `SKILL.md` |
| `get_cursors()` | Returns where to start reading each source, with the 6-hour overlap | `tm cursors` |
| `submit_signals(signals)` | Checks signals against the schema, stores them and runs stages 1 to 3. Returns counts | `tm ingest` + `tm propose` |
| `get_pending_judgments(page?)` | Returns the shortlists the judge must decide, a page at a time | `pending_judgments.json` |
| `submit_verdicts(verdicts)` | Checks and applies verdicts. Returns counts | `tm apply` |

Matching runs inside `submit_signals`, so the AI can't forget to call it.

Both roles also have `whoami()`, so skills never contain anything about the person using them.

### Keeping tool results small

Most of the tokens in a run are data, not tool definitions, so the tools are built to return little:

- Writes return counts and IDs, never an echo of what was sent.
- Reads return pages and short summaries. `get_task` returns the notes and the last few log
  entries. Source content comes only through `read_source`.
- Errors say exactly which field failed, so the model fixes it in one try.

## Who uses which interface

Everything the spike's CLI did moves into the core library. Each command then goes to the layer that
fits who uses it:

| Spike command | Goes to | Why |
| --- | --- | --- |
| `cursors`, `ingest`, `propose`, `apply` | MCP, extractor role | The AI does these |
| `merge`, `keep`, `split`, `detach`, `done`, `drop`, `schedule` | HTTP card answers from the UI, and the CLI for debugging | These are your decisions. Headless AI doesn't get them as tools |
| `show` | CLI (`fuzz show 14`). The AI uses `get_task` | Looking around |
| `init`, `reembed`, `reset` | CLI only | Admin |
| `sync`, `report` | Removed | They only existed because `Matched Tasks.md` stood in for a UI |

**The AI uses MCP, not the CLI.** A CLI would save a little context, because MCP tool definitions sit
in context every turn, but they are small and cached. The real reason is the approval gate: an AI
using the CLI needs a shell, and even an allowlist of `fuzz *` can be got around with `;`, pipes or
`$(…)`. With MCP only, a headless run has no shell, so "no `send` tool" stays true. MCP over HTTP
also works for cloud agents and the web app, where there is no local CLI.

## Choosing the next task

`claim_next_task` is deterministic code:

1. **Eligible**: `assignee = fuzz` and state `queued`, or a `working` task whose lease has run out.
2. **At most five** tasks in `working` per user (the demo's limit). The rest show "Next up".
3. **Order**: deadline level, then `order_key` (the same ordering triage uses), then age.
4. **Lease**: 10 minutes by default and renewed by any tool call. A crashed worker's task goes back
   to `queued`.
5. **Budget**: each claim and each step counts. After `max_steps` steps, or `max_attempts` claims
   with no progress, the core hands the task back itself ("I got stuck on this").

The triage order (check-in answers, gentle first, quick first, time-sensitive first) is the same
kind of code, run for the human queue.

### What wakes the executor

1. **Now**: a launchd job on the Mac that runs `fuzz run executor`, which claims until nothing is
   eligible. You can run the same command by hand (see [Running a role](#running-a-role)).
2. **Later**: wake on events (`task.assigned`, `task.approved`) through the event stream.
3. **Web**: a worker pool reading per-user queues.

The loop doesn't change between these three, only what starts it.

## Installing the AI roles

The extractor and the executor each come as a **skill**: a `SKILL.md` and its reference files, in the
format Claude Code, GitHub Copilot and OpenAI Codex all read.

**The first two clients are Claude Code and GitHub Copilot**, both supported from the start, so
nothing gets built around one client's quirks. Codex comes later and needs only a new adapter (see
[Client adapters](#client-adapters)).

Installing a role for a client means two things:

1. **The skill files**, in the folder that client reads.
2. **The MCP registration**, so the client knows how to start `fuzz mcp --role <role>`.

### The skills

| Skill | Role | Uses |
| --- | --- | --- |
| `fuzz-extract` | `extractor.reader` and `extractor.judge` | The client's email and Slack connectors, and the [extractor tools](#extractor-tools-mcp) |
| `fuzz-executor` | `executor` | The [executor tools](#executor-tools-mcp) only |

- **Instructions only, no scripts.** The spike puts its Python inside the skill. With several
  clients that would mean several copies drifting apart, so the code lives in the core and the skill
  only calls tools.
- **Written for any client.** The skill names Fuzz's tools and never a client's own (no "use the
  Bash tool", no "spawn a subagent"). Where clients differ, the skill says "if your client can…", as
  the spike already does for subagents.
- **Nothing about you.** The skill gets your names, addresses and folders from `whoami()`, so the
  same files work for every client and every user.
- **Versioned.** Each skill's frontmatter carries its `prompt_version`. The skill passes it on its
  tool calls, the core records it on every event, and `fuzz doctor` warns when an installed skill is
  out of date.
- **One copy.** The skills live in the core's repo. The installer copies them out, or links them
  while you develop.

### Where each client looks

Personal scope only for now. Project scope would put Fuzz in a repo, which doesn't fit a personal
task system.

| Client | Skills folder | MCP config | Headless command |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/` | `claude mcp add --scope user` | `claude -p` |
| GitHub Copilot (CLI and VS Code) | `~/.copilot/skills/`. Also reads `~/.claude/skills/` and `~/.agents/skills/` | VS Code user `mcp.json`. CLI file to confirm | `copilot -p` |
| OpenAI Codex (later) | `~/.codex/skills/` (`$CODEX_HOME`) | `[mcp_servers.fuzz-*]` in `~/.codex/config.toml` | `codex exec` |

These paths change often, so they live in the adapters, and `fuzz doctor` checks them on the
machine. Because Copilot also reads `~/.claude/skills/`, installing for both Claude Code and Copilot
writes the skills once, to `~/.claude/skills/`, so Copilot doesn't see each skill twice.

### Client adapters

Everything that differs between clients lives in one adapter per client, in the core. Nothing else
in the core, and nothing in the skills, knows which client is running. Adding a client means writing
an adapter and passing the adapter tests.

| An adapter knows how to | Claude Code | GitHub Copilot CLI |
| --- | --- | --- |
| Install and remove the skills | `~/.claude/skills/` | `~/.copilot/skills/`, or nothing if Claude Code already installed them |
| Register and remove the MCP server | `claude mcp add` / `remove`, user scope | Its MCP config file (to confirm) |
| Start a headless run | `claude -p <prompt>` | `copilot -p <prompt>` |
| Give the run only Fuzz's MCP server | `--mcp-config <run file> --strict-mcp-config` | A run-specific MCP config (flag to confirm) |
| Allow only Fuzz's tools | `--allowedTools "mcp__fuzz-executor__*"`. Anything else is refused, because nobody is there to approve it | `--allow-tool fuzz-executor`, `--deny-tool shell`, `--deny-tool write`. Deny always wins. `--available-tools fuzz-executor …` hides every other tool, since Copilot loads your own servers too |
| Choose the model | `--model` | `--model` |
| Show the transcript for `--verbose` | `--output-format stream-json` | Its log output |
| Tell whether a run ended cleanly | Exit code and the final result message | Exit code |

**Every headless run gets its own MCP config.** `fuzz run` writes a short-lived config that starts
`fuzz mcp --role executor --run <run id>` and hands it to the client. That does three things on both
clients:

- The run sees Fuzz's server and no other MCP server you have installed.
- Every event the run writes carries its run ID, so the core knows the client, model and
  `prompt_version` without asking the model.
- The installed registration from `fuzz install` is only for using the skill in a normal chat.

### Choosing the client for a role

One **engine** (a client and a model) runs every role by default. The extractor and the executor
don't need different vendors, so the simple case is one choice:

```json
{
  "engine": {"client": "claude-code", "model": "…"},
  "roles":  {}
}
```

- **Per-role overrides are optional.** `"roles": {"extractor.judge": {"model": "…"}}` changes one
  role. They live in the config file for experiments, not in the UI.
- **Switching is a config change.** From Settings in the UI, `fuzz config set engine.client
  copilot`, or `--client` for one run. Skills, tools and rules stay the same.
- **Switching only offers ready clients.** You can pick a client only once its install status is
  Ready (see [Engine settings in the UI](#engine-settings-in-the-ui)). A switch takes effect at the
  next run, never in the middle of one.
- **Both clients can run at once.** Leases already keep two workers off the same task, so running a
  Claude Code executor and a Copilot executor side by side is safe. It's useful for comparing them on
  live work. It isn't the default, because it doubles the cost.
- **Comparisons come from the log.** Every event carries its run, and every run its client and
  model, so "how did Copilot's drafts fare against Claude Code's?" is a query: approved, edited or
  sent back, handbacks, and steps used per task.

### Engine settings in the UI

Installing and choosing the engine is done from **Settings > Engine** in the UI, not only from the
CLI. The UI calls the same core code as `fuzz install`, `fuzz doctor` and `fuzz config`, over HTTP.

**Install status.** One row per client, with each part's status:

| Part | Shows | Comes from |
| --- | --- | --- |
| Client | Found on this Mac, and its version | The adapter looks for the client |
| Skills | Installed, out of date (with versions), or missing, for each skill | The installer's manifest and each skill's `prompt_version` |
| MCP server | Registered, and whether it starts in each role | `fuzz doctor` |
| Headless run | Last run's result and time | The `runs` table |
| Connectors | Email and Slack tools visible, or which are missing | `fuzz doctor` |

Each row sums up as **Ready**, **Needs attention** (with the first thing to fix) or **Not
installed**.

**Actions.** Install, Update (when a skill is out of date), Repair (reinstalls what `doctor` found
broken), Uninstall, and Run now, which starts `fuzz run` for a role so you can test it from the UI.
Connectors can't be installed from Fuzz, so a missing connector shows how to add it in that client.

**Choosing the engine.** One picker for the client and one for the model, showing only clients that
are Ready. Fuzz says when the switch happened, through the personality layer, like any other event.

**HTTP API.**

```
GET  /engine                     current engine, and install status for every client
POST /engine/clients/{client}/install | update | repair | uninstall
POST /engine/check               runs doctor again and returns fresh status
PUT  /engine                     {"client": …, "model": …}
POST /engine/run                 {"role": "executor", "task_id"?: 14}
```

Each install, removal and switch writes an event (`engine.installed`, `engine.removed`,
`engine.selected`), so every change is in the log. Undo works for a switch; an install is reversed
with Uninstall. Status checks write
nothing; they're recomputed on request and cached for a minute.

### The installer

Part of the core's CLI, so it ships with what it installs.

```
fuzz install   --client claude-code|copilot [--roles extractor,executor] [--link]
fuzz uninstall --client …
fuzz doctor
```

- **Safe to run again.** It writes a manifest of every file and config entry it touched, and
  `uninstall` removes exactly those.
- **Edits config files in place**, keeping everything else in them (JSON for both first clients).
- **`--link`** symlinks the skills instead of copying, for development.
- **Sets the engine.** The first client installed becomes the engine if none is set yet. Installing
  also writes the launchd jobs that run the roles.
- **Allows only Fuzz's tools for headless runs.** The adapter passes the client's allow and deny
  flags on every run, allowing the `fuzz` MCP server and nothing else. No shell, no file writes. This
  is what keeps the approval gate true when nobody is watching.

`fuzz doctor` checks, for each client: the skill is there and current, the MCP server starts in each
role, the role config points at an installed client, and an email and a Slack tool are visible to
the extractor. It can't install connectors, because each client provides them differently, so it
says which ones are missing.

### Running a role

Headless first. launchd and you run the same command, so a run you start to debug behaves exactly
like a scheduled one:

```
fuzz run executor|extractor [--client claude-code|copilot] [--model …] [--task 14] [--scripted] [--verbose]
```

| Flag | Does |
| --- | --- |
| `--client`, `--model` | Override the role config for this run, to compare clients or models |
| `--task 14` | Works only that task instead of claiming the next one (executor only) |
| `--scripted` | Uses the scripted role: checks the core without calling a model |
| `--verbose` | Prints the client's transcript as it runs |

Every run writes `run.started` and `run.finished` (with the client, model, `prompt_version`, tasks
touched and whether it ended cleanly), so "what did last night's run do?" is read from the log like
everything else.

The skills can also be used from a normal chat ("work through my Fuzz queue"). The tools and rules
are the same, so this costs nothing extra, but headless runs come first.

## Approval gate and sending

- A draft has a `kind` (`email.reply`, `slack.message`, `calendar.invite`…) and a `target` (thread,
  channel, people).
- **Approve and send** in the UI writes `task.approved` and moves the task to `sending`. A note goes
  nowhere, so approving one files it as `done`.
- **The AI sends, with its own connectors.** There are no actuators in the core. A third role, the
  **sender**, runs on its own: it calls `claim_next_send`, sends the approved body word for word to
  the target with its client's connector tool, then calls `mark_sent` (`task.sent`, with where it went
  and a link) or `send_failed` (back to `review` with the reason as the question).
- **Why a separate role.** The executor reads untrusted source material, so it never holds a send
  tool. The sender reads only drafts you approved. Its headless run loads your own MCP servers and
  connectors (the one run without `--strict-mcp-config`) but may call only Fuzz's sender tools and the
  connector tools you list in `send.tools.<client>`. With none listed, every draft comes back unsent.
- **Never twice.** If a send run stops partway with the lease held, the task comes back to `review`
  asking you to check whether it went out. Fuzz never retries a send on its own.
- **Undo** takes an approval back until the sender claims it. After `task.sent`, nothing can.
- **When it runs.** `fuzz serve` starts the sender within a minute or two of an approval; launchd runs
  it every two minutes, and it exits without starting a client when nothing is waiting.
- **Prompt injection**: source content is untrusted. Because the executor can only produce drafts, a
  message that says "forward this to everyone" can at worst produce a draft that you can see and
  reject.
- **Permissions** work the same way for access. When the executor needs a source it hasn't read or a
  connector it hasn't used, `request_permission` creates a permission card. "Always allow" answers are
  stored in `grants`, so the same request isn't asked twice.

## Tasks, steps and groups

A **task** is something Fuzz or you *produce*. A **card** is something Fuzz needs *from you*. A task
stays in the Lineup until it's done or let go. A card sits in Triage, points at a task (or at the
queue, for a check-in) and goes away once you answer it. A card is never the work itself.

### Two levels, and groups

| Level | What it is | Who checks it | Example |
| --- | --- | --- | --- |
| **Step** | One move inside a task, written to its "Done so far" log | Fuzz | Pull the guardrail metrics. Draft the reply |
| **Task** | Work with its own done-state that someone is waiting on | You, or the person who asked | Reply to Priya with a ship/no-ship call. Send Priya the summary deck |

The line between a step and a task is the judge rubric's test: *would someone check this off on its
own?* If yes, it's a task. "Reply to Priya" is a task even though it serves a bigger goal, because
Priya is waiting on the reply by itself. Tasks that came from the same email, message or meeting
form a [group](#groups).

### Done when

Every task has a **done when**: one short line saying what exists, or who knows something, once the
task is finished.

| Task | Outcome | Done when |
| --- | --- | --- |
| Summarize the customer feedback thread | Something written | A summary exists |
| Reply to Priya about the Q4 readout | A message sent | Priya has a ship/no-ship recommendation |
| Confirm headcount for the offsite | A fact passed on | Marcus has a number |
| Decide the launch date for the report builder | A decision | A date is picked and Elena knows it |
| Book the room for Thursday's workshop | A change in the world | The room is on the calendar |

The extractor writes it with the `ask`, and you can edit it. The executor uses it to tell when it has
finished, and "Needs your OK" checks against it. If the extractor can't write a done-when, the ask
isn't a task yet. It's parked, or it gets an `is_task` card, and Fuzz can offer a sharper version
("A one-page proposal?").

### What is and isn't a task

1. **A task has a done-state.** Something that never finishes ("keep an eye on the dashboard") isn't a
   task. Something it turns up ("the dashboard spiked") can be.
2. **One done-state, one task.** Two asks in one message are two tasks. A nudge about the same outcome
   belongs to the task that already exists.
3. **A card is a question, not work.** If one tap or a short answer resolves it, it's a card. If it
   takes effort to produce, it's a task. Approvals and handbacks are cards on a task.
4. **No decision, no card.** "Fuzz finished the summary" and "thanks!" aren't tasks or cards.

### Groups

One email, Slack message or meeting often brings several asks at once: the action items from a
staff sync, or Marcus's "can you send the deck, book the room and ping Sam?". Each ask is its own
task, but they belong together, and you want to see them that way. A **group** is that: the tasks
that came from the same place.

A group is made from **where the tasks came from**, never from a guess about what they're for. The
core makes groups itself, as code, from the signal's fields. No AI decides, so grouping can't be
wrong in a way you have to correct. (Grouping by shared goal, such as "Priya can brief her team by
Tuesday", is left for later. See [Open questions](#open-questions).)

1. **Fuzz makes groups. You never have to.** New task stays one field with no categories.
2. **Two or more, or none.** A group forms when a second task of yours comes from the same origin.
   One action item gets no group. Most tasks have none.
3. **Only tasks still open.** A new ask joins tasks from the same origin that are still live. Once
   every task in a group is done or let go, the group is finished, and a new ask from the same
   thread starts fresh.
4. **One group per task. No groups inside groups.** A task already in a group stays in it.
5. **Triage stays one task per card.** A group is context on a card, never a card to work through.
6. **Each task keeps its own deadline and done-when.** The asks from one meeting don't share a goal,
   so the group has neither.
7. **Groups only grow towards done.** There's no percentage of what's left and nothing in red.

#### What counts as the same origin

| Source | Origin | Later asks join when |
| --- | --- | --- |
| Email | The thread (`email:<conversationId>`) | A reply in the thread brings a new ask while the group's tasks are still open |
| Meeting | The summary file (`meeting:<file stem>`, every row of it) | An edit to the notes adds an action item |
| Slack | One message, or a **burst**: messages from the same person in the same channel or DM, each within 10 minutes of the one before, with nothing from you in between | Only within the burst |
| Fuzz | The task Fuzz split it from (`create_task` with a parent) | It joins the parent's group, or starts one with the parent |
| Captured by you | None | Never |

Slack is different because a channel or DM is not a conversation with an edge. A DM can run for
weeks and change topic many times, and many DMs have no threads at all. So the channel is never an
origin. The thread isn't either: a reply days later in an old thread is usually about something
else. It can still **merge** into an existing task through matching; it just doesn't join the
group. The burst catches the common way people send a list in Slack, which is several messages in a
row. Your own message, or a 10-minute gap (`grouping.slack_burst_minutes`), ends it.

The group's name comes from its origin: the email's subject or the meeting's title, from the
signal's optional `title`, or "Marcus on Slack" when there is none. You can rename it.

#### Groups in the UI

The word "group" doesn't appear in the UI. A group shows up as a **"From …" line**: "From Staff sync
· 1 of 3 done".

| Place | What changes |
| --- | --- |
| Triage card | One line under the tags. No new buttons. Tapping it opens the group sheet |
| Lineup | Still grouped by who has it (Yours, Fuzz's lane, With others, Later). A row in a group gets the same "From …" line. The Lineup is never grouped by group, because that would hide what's waiting on you |
| Task detail | The "From …" line, which opens the group sheet, and the task's done-when |
| Group sheet | A dialog, like task detail: the name, a link back to the origin (Open the email, Open the meeting notes), each task with its state ("2 done, 1 with Fuzz"), and the latest steps from all its tasks in one log. Actions: Rename, Take a task out, It's wrapped up, each with Undo |
| Fuzz | Celebrates when the last task in a group is done |

What's left out on purpose: a groups page, a group picker, group colours or icons, progress bars,
and group cards in Triage.

**Take out** removes one task from the group. A group of one isn't a group, so taking out the
second-to-last task finishes the group and the last task stands on its own. **It's wrapped up**
finishes the group while some tasks are still open: they keep going on their own, and no new ask
joins the group.

#### In the core

`groups (id, user_id, title, origin, link, state)` is a projected table like `tasks`, and
`tasks.group_id` points at it. `state` is `open` or `wrapped` (you said so). A group whose tasks are
all done or let go is finished without an event: that is worked out when it is read. The events are
`group.created` and `group.linked` (Fuzz, as matching creates tasks), and `group.unlinked`,
`group.renamed` and `group.wrapped` (you, from the group sheet, each undoable). The executor's
`get_task` lists the other tasks in the group by title and state, so a run knows "these all came
from the staff sync" and can reuse what the others found.

## Cards and actions

Every card is the system asking you to make a decision. Each card kind is a different decision, with
its own fixed set of answers. The core owns which kinds exist, which answers each allows and what each
answer does. The UI owns how they look. The AI only fills in content.

**One rule: a card exists only if there's a decision to make.** "Fuzz finished the summary" or "Dana
replied" are not cards. They are things Fuzz says, through the
[personality layer](#personality). That keeps Triage to decisions and the progress bar honest.

### Four families

| Family | Kind | The decision | Answers |
| --- | --- | --- | --- |
| **Routing** | `task` | What should happen to this work? | Assign to Fuzz · Work in Claude · Schedule · Done, plus Park it · Waiting on someone · Drop |
| **Questions** | `duplicate` | Are these the same task? | Merge · Keep separate · Not sure yet |
| | `entity_person` | Are these the same person? | Same person · Different people · Not sure yet |
| | `entity_term` | What is this? | Save definition · Same as an existing project · Not sure yet |
| | `is_task` | Is this a task we should work on? | Yes, it's mine · No, not a task · It's someone else's · Not sure yet |
| **Approvals** | `draft` | Can this leave the system? | Approve and send · Edit · Send back with a note |
| | `nudge` | Can Fuzz chase this reply? | Approve and send nudge · Edit · Not yet |
| | `permission` | Can Fuzz use this? | Allow once · Always allow · No |

- **Routing** cards have the most answers, because work can go many places.
- **Question** cards need one fact so something else can carry on. Answering resolves the question and
  the task or the matcher continues; it doesn't move the work anywhere. `is_task` covers asks the
  extractor wasn't sure were asks at all, or wasn't sure were for you.
- **Approval** cards sit at the approval gate. Approve is the only answer in the system that reaches
  outside it. Permission is grouped here because, like drafts, it decides what Fuzz may do beyond the
  store.
- **Check-ins** aren't cards in the core. When to ask, how often, and the follow-ups (Take 5, Hold the
  rest until tomorrow, Quick ones first) are the UI's: it knows how long you've been at it. The answer
  goes to `POST /checkin {answer, follow_up?}`, which writes `checkin.answered`, sets the queue's moment
  and, for Hold the rest, schedules everything that isn't time-sensitive for tomorrow morning in the same
  command, so one Undo puts it all back.

Every card shares three things: a suggested answer pre-filled as the primary button, a way out (Drop,
Dismiss or Not sure yet), and Undo.

### Task card variants

These are the same `task` card with the same answers. A variant adds a tag, a reason line and
sometimes a panel.

| Variant | What it adds |
| --- | --- |
| Time-sensitive | A live countdown and Fuzz's three rush levels |
| Stale | "Still care about this?" above the actions: Yes, keep it · Let it go |
| Returning | A "Where you left off" recap from History. Used for scheduled tasks that came back |
| Handed back | Fuzz's question and the quick answers he wrote, plus the normal actions. Goes to the end of the queue |
| Reopened | The reason ("Priya asked for the deck again on Slack") and the recap. **Done** means "keep it closed" |

Reopened and woke-up tasks are not separate card kinds. The task card's own answers already cover
them, so a separate Reopen / Keep closed card would only repeat buttons.

### When a new signal brings a task back

This rule lives in the core, as code. Most of it is already in the matching spike.

| Task's state | New signal with no new ask ("thanks!", an FYI) | New signal with a new ask |
| --- | --- | --- |
| Done | History only | Back to Triage, tagged Reopened |
| Let go | History only | Back to Triage, tagged Reopened, only if the ask came after you let it go |
| Parked | History only, and "Woke up" in the Parked list. No card: Parked never nags | Back to Triage, tagged Reopened |
| Scheduled | History only | Stays scheduled. An earlier deadline pulls it forward |
| Waiting | History only, unless it's from the person you're waiting on: then back to Triage as "Reply came in" | Back to Triage |

### The card record

```json
{ "id": "c_41", "kind": "duplicate", "task_id": 14, "other_id": 7,
  "prompt": "Same as “Reply to Priya about the Q4 readout”?",
  "reason": "Same person, same deck, two days apart",
  "options": ["merge", "keep_separate", "not_sure"],
  "suggested": "merge" }
```

Answering is one call for every kind: `answer(card_id, option, value?)`. The core looks up what that
option does for that kind and writes the events. So one Undo and one log cover every card.

### What each answer writes

| Kind | Answer | Events | Result |
| --- | --- | --- | --- |
| `task` | Assign to Fuzz | `task.assigned` | `queued` |
| | Work in Claude | `task.assigned` (to a session) | `session` |
| | Schedule `{anchor}` | `task.scheduled` | `scheduled`, see [Scheduling with human time](#scheduling-with-human-time) |
| | Done | `task.done` | `done` |
| | Park it | `task.parked` | `parked` |
| | Waiting on someone `{who}` | `task.waiting` | `waiting`, with a check-back time. Needs a who. With an executor, Fuzz first picks the time from the context (within a week unless there's strong evidence), else three business days |
| | Drop | `task.let_go` | `letgo` |
| | Stale: Yes, keep it | `card.answered` | Stays, stale clock resets |
| | Parked review: Keep it parked | `task.kept_parked` | Back to `parked`; not asked again for `review.again_days` |
| | Parked review: Bring it back | `card.answered` | Stays in `triage`, first in line, as an ordinary task card |
| | Check-back: They got back to me | `card.answered` | Stays in `triage`, first in line, as an ordinary task card |
| | Check-back: Nudge them | `task.assigned` | `queued`, for Fuzz to draft a nudge for your OK |
| | Check-back: Keep waiting | `task.waiting` | Back to `waiting` with a new check-back time |
| | Handed back: quick answer `{text}` | `card.answered`, `task.assigned` | Back to `queued` with the answer in its notes |
| `duplicate` | Merge | `task.merged` | The other task redirects. Logged in `feedback` |
| | Keep separate | `card.answered` | A `kept_separate` link, so Fuzz won't ask again. Logged in `feedback` |
| `entity_person` | Same person | `entity.merged` | Profiles merge |
| | Different people | `entity.kept_separate` | Both stay, linked as different |
| `entity_term` | Save definition | `entity.defined` | Saved to the term |
| | Same as an existing project | `entity.merged` | Linked to that entity |
| `is_task` | Yes, it's mine | `task.confirmed` | Becomes a routing card in Triage |
| | No, not a task | `task.let_go` | Closed as "not a task". Logged in `feedback` for the extractor |
| | It's someone else's | `task.let_go` | Closed as "someone else's" (tag `theirs`); Fuzz doesn't track other people's work. A new ask that needs you brings it back, for 90 days |
| `draft`, `nudge` | Approve and send | `task.approved`, then `task.sent` from the sender | `sending`, then `done`, or back to `waiting` for a nudge. `task.send_failed` brings it back to `review` |
| | Edit `{body}` | `task.draft_edited` | Stays in `review` |
| | Send back `{note}` | `task.sent_back` | Back to `queued` with the note |
| `permission` | Allow once | `permission.granted` | The task carries on |
| | Always allow | `permission.granted` | A row in `grants`. The task carries on |
| | No | `permission.denied` | The executor works without it, or hands back |
| any question | Not sure yet | `card.postponed` | See below |

### What the AI may and may not do

- **May fill in content:** the prompt, the reason, the suggested answer, a handback's quick answers
  and schedule suggestions.
- **May not add answers.** A new card kind or a new answer is a code change in the core. A handback's
  quick answer isn't a new action: picking "Ask Ines" sends the text "Ask Ines" back to the task, and
  the executor carries on with it. Every card's effect stays fixed even when its wording changes.

### Rules for the queue

- **One card per task at a time, questions first.** A task can't be routed before you know whether
  it's a duplicate, so a question card about a task comes before its routing card.
- **"Not sure yet" postpones, it doesn't fail.** The card comes back later at the end of the queue.
  After two postpones the core takes the safe answer itself (keep separate, stay provisional, keep it
  as a task) and writes `card.expired`. A question you don't answer never blocks the work behind it.
- **The UI is free to change.** Each kind maps to a layout and a reaction from Fuzz (puzzled for
  questions, sheepish for handbacks). Another UI, like Slack buttons, can show the same cards with no
  new logic.

## Scheduling with human time

Schedule is the one answer whose options change from task to task. It stays one answer with a fixed
effect. What varies is the list of times it offers. **Each option is a structured anchor the core
understands, not free text.** The AI can suggest anchors that fit a task; the core decides what each
one means and when it fires.

### Anchors

A small, fixed vocabulary. Adding a type is a code change in the core.

| Anchor | Example label | How the core works out the time |
| --- | --- | --- |
| `in` | In 30 minutes | Now plus a duration |
| `later_today` | Later today | After your last meeting today |
| `at_desk` | When I'm back at my desk | Next time the Mac wakes or unlocks |
| `day_part` | First thing tomorrow, Monday morning | Your first triage session in that part of the day |
| `before_due` | The day before it's due | Due date minus a lead time. Only offered when there's a due date |
| `moment` | Before the leadership meeting, Next time I see Sam | A described date handed in by the AI or you. See [Moments](#moments) |
| `exact` | Thu 2:00 PM | The time you picked. Always the last option |

### Moments

Built instead of the calendar anchors `before_event`, `after_event`, `next_with_person` and
`lighter_day`, which needed the core to read and track a calendar.

- A moment is `{"type": "moment", "key", "label", "at"}`: a short description and the time the task
  should come back. The AI finds it with its own calendar connector and works out the lead time.
- A task carries at most two. They go first in the Schedule options. The core checks each one is in
  the future, before the due date and within a year, and drops it quietly otherwise.
- Handing in the same `key` again with a new `at` moves a task scheduled on it (`task.anchor_moved`).
  `"cancelled": true` brings it back to triage with the reason (`task.anchor_lost`).
- The trade-off: the button reads as the moment's label, not a core template (one line, at most
  60 characters), and a moved meeting is noticed only when a later run hands it in again.

A scheduled task stores the anchor, for example
`{"type": "before_event", "event_id": "…", "lead": "1d"}`, plus the time it currently works out to
(`schedule_fire_at`).

- **The core recalculates when the calendar changes.** If the planning review moves to Friday, the
  task moves with it (`task.anchor_moved`).
- **If the anchor disappears**, for example the meeting is cancelled, the task comes back to Triage as
  a returning card with the reason ("The planning review was cancelled"), and writes
  `task.anchor_lost`.
- When the time comes, the task returns to Triage as a returning card and writes `task.came_back`.

### Building the options

The list combines two sources: options the core works out from the task's timeline, and now and then
an option the AI adds.

**1. The core's options follow the timeline.** The time left until the due date decides which
options make sense:

| Time left | Options the core offers |
| --- | --- |
| Under a few hours | In 30 minutes · After this meeting · An hour before it's due |
| Later today or tomorrow | Later today · When I'm back at my desk · First thing tomorrow · A few hours before it's due |
| A few days | Tomorrow morning · The day before it's due · A lighter day this week |
| Weeks away | Next week · A week before it's due · Sometime next week, on a lighter day |
| No due date | Later today · When I'm back at my desk · Monday morning · Sometime next week |

The core can also add options specific to the task without any AI. It matches the task's entities
against your calendar: an upcoming event that a person on the task is invited to gives "Next time I
see Sam", and an event whose title matches a term on the task gives "Before the Lantern review".

**2. Two rules apply to every option, whoever suggested it.**

- **Nothing lands after the due date.** An option that would is dropped.
- **Exact time is always the last choice.**

### AI suggestions

- **When:** only while the AI is already working on the task, during extraction or an executor step.
  Never when the card is shown.
- **What:** an anchor tied to something real, such as "Before the next leadership meeting" (a
  recurring calendar event) or "After Dana's budget review" (an event mentioned in the thread), plus a
  one-line reason. It's saved with `suggest_schedule` into the task's `schedule_hints`.
- **How many:** at most two slots in the list are kept for AI options, and they go first, since they
  are the most specific. If the AI has nothing worth adding, the list is just the core's.
- **Checked by the core:** the event must exist, be in the future and fall before the due date. A
  suggestion that fails is dropped without a word. If its event moves or is cancelled later, the
  option updates or disappears.

### Putting the list together

- **Built ahead of time, not when you press Schedule.** The options are worked out when the card is
  created and refreshed when the calendar changes. They're stored on the card as
  `schedule_options`, so the panel opens instantly and never waits on a model.
- **Order:** AI suggestions, then the core's task-specific options, then the timeline options, then
  "Pick an exact time". About six options at most, plus exact.
- **Labels come from templates in the core**, such as "Before {event title}", "After {event title}"
  and "Next time I see {first name}". The AI supplies anchors, not wording, so the buttons stay
  consistent and a model swap can't change how they read. The same templates give Fuzz his line
  ("I'll bring it back before the planning review").
- **Answering:** `answer(card_id, "schedule", {anchor})`. The core accepts only an anchor it offered,
  or an exact time.

### Learning which options help

Each pick is recorded in `feedback`, as merges are in the spike. Over time this shows:

- **Whether the AI suggestions get used.** If they're rarely picked, the AI can suggest less often.
- **Which timeline options you never pick.** They can drop out of the table.

It's also the data for comparing two models' suggestions before swapping one.

### What this needs

The time resolver needs to read your calendar and to know when the Mac wakes or unlocks. Locally the
calendar can come through the same connector the extractor uses; the wake signal comes from macOS. On
the web, the core needs its own calendar integration, and "back at my desk" becomes "next time you
open Fuzz".

## Personality

Deterministic, and only in the UI.

- The UI subscribes to core events and maps each one to a mood, a reaction and a line, using the
  tables that exist today (`ASSIGNS`, `DONES`, `CI_REPLY` in `js/view-triage.js`).
- The core emits plain facts with no voice. The same events could drive a different Fuzz in a
  different UI.
- **If AI phrasing comes later**, the rules still choose when Fuzz speaks and in what mood. The AI
  only rewords the line the rules chose, and falls back to the fixed line if it is slow or off-tone.
  This keeps the no-nagging and no-shame rules out of the model's hands.

## Deployment

### Now: local on a Mac

- One Python process, extending the spike's code and reusing its matcher.
- SQLite in WAL mode, under `~/Library/Application Support/Fuzz/` (overridable, as with `TM_STORE`).
- HTTP on `127.0.0.1` only, with a random token in a local config file so other local pages can't
  call it.
- MCP over stdio for local AI clients (Claude Code and Copilot first, Codex later), started by the client and
  registered by `fuzz install`.
- The UI is served by the core as static files, so it stays no-build.
- Secrets (connector tokens) in the macOS Keychain, never in the database.
- Started by a launchd agent.

### Later: web app

| Concern | Local | Web |
| --- | --- | --- |
| Database | SQLite | Postgres (same tables, `user_id` indexed) |
| Auth | Local token | Real sign-in. Every request resolves to a `user_id` |
| MCP | stdio | Streamable HTTP, with a token scoped to one user |
| Workers | One loop | Pool, leasing per user |
| Events to UI | Server-sent events | Server-sent events |
| Secrets | Keychain | A secrets manager, per user |

### Later: multiple users

Costs almost nothing now if done from the start:

- `user_id` on every row, and every query in the core scoped by it. One function returns the current
  user; nothing else reads it.
- Concurrency limits, cursors, config and entities are per user.
- A test that creates two users and checks that nothing leaks between them.

### Later: domains

Separate areas of one person's life, such as personal and work, each with its own sources and queue.
Not designed yet. Two choices now keep it cheap:

- **Skills know nothing about domains.** They get everything from `whoami()`, so adding domains
  doesn't change the skill files or the installer's skill step.
- **A domain is a scope, like `user_id`.** It would most likely become a column on each row, a
  `--domain` flag on `fuzz mcp` and `fuzz run`, and one MCP registration per domain.

## Testing

- **Scripted roles** for the extractor, the judge and the executor, so the full loop runs offline.
- **Replay**: rebuild `tasks` from `events` and compare with the live table.
- **Contract tests** for the HTTP API and MCP tools, run against the same core library.
- **Isolation test** with two users.
- **Card table test**: every kind and answer in [What each answer writes](#what-each-answer-writes)
  produces exactly those events, and Undo restores the earlier state.
- **Time resolver tests** with a fixed fake calendar: each anchor works out to the right time, moves
  when its event moves, and is lost when its event is cancelled. No option ever lands after the due
  date.
- **Model comparison**: run two configs on a saved set of signals and tasks, and diff their decisions
  using the recorded `model` and `prompt_version`.
- **Installer tests** against a fake home folder: install, install again and uninstall for each
  client leave the config files exactly as expected, other entries untouched, and nothing behind.
- **Adapter tests**, the same for every client: the headless command allows only Fuzz's server and
  tools, passes the run's MCP config and model, and a run against a scripted MCP server records its
  run ID on every event. A new client is supported when it passes these.
- **Role scoping**: the executor role can't see extractor tools, and the reverse.
- The spike's existing tests carry over.

## Build order

1. **Core library**: events, the tasks projection, the state machine, `user_id` everywhere. Move the
   spike's store and matcher into it.
2. **Cards and the HTTP API.** The card kinds, the answer table and the event stream. Point the demo
   UI at them instead of `tick`, with the personality tables unchanged.
3. **Time resolver**, with the timeline options and the anchors that don't need a calendar (`in`,
   `at_desk`, `day_part`, `before_due`, `exact`). This replaces the fixed `WHEN` list.
4. **MCP server** with both roles' tools, a scripted executor, and `fuzz run` with `--scripted`.
5. **Adapters, installer and `fuzz doctor`** for Claude Code and Copilot together, so the adapter
   boundary is real from the start. Until step 6, the installer can install the spike's
   `task-matching` skill as a first test of the per-client paths. Codex comes later as a third
   adapter. Then the Settings > Engine page in the UI, over the same code.
6. **Skills and real runs**: `fuzz-executor` running headless with drafts only, no actuators, then
   `fuzz-extract` replacing the spike's flow (cursors, ingest, propose, judge, apply) through the
   extractor tools, including `is_task` cards.
7. **Calendar anchors and AI schedule suggestions**, once the core can read the calendar.
8. **The sender in real runs**: list each client's send tools and try one kind at a time, email reply first.
9. Web hosting and multiple users, when wanted.

## Open questions

1. **Language for the core.** Python reuses the spike and has an official MCP SDK. TypeScript would
   match the UI. Recommendation: Python.
2. **Default engine.** Claude Code and Copilot are both supported from the start. Which one is the
   default, and which model, is a choice to settle once both have run on the same tasks.
3. **Who reads the sources and the calendar?** The extractor needs email and Slack access, and the
   time resolver needs the calendar. Locally that can be the AI client's connectors, as in the spike.
   On the web the core would need its own integrations.
4. **Step granularity.** Is one claim one step, or does the executor work until it needs a human or
   runs out of budget? This affects cost and how lively the "Done so far" log looks.
5. **Undo window.** How far back Undo goes. (Whether it can reverse a command after later events is
   settled: only if none of them changed a decisive field it would put back.)
6. **Retention.** How long raw signals and source content are kept, especially once there are
   several users.
7. **Approval cards in Triage?** Today drafts wait only in All tasks. Putting them in Triage makes it
   the one place to clear decisions. Leaving them out keeps Triage about sorting new work.
8. **Lead times.** The defaults for "before" anchors (an hour, a day, a week), and whether they
   should learn from when you actually pick the task up.
9. **Copilot details to confirm.** Copilot CLI's MCP config file, and how to hand it an MCP config
   for one run only, weren't confirmed in official docs. If it can't take a per-run config, the
   adapter falls back to the installed registration and passes the run ID through an environment
   variable. Codex's personal skills folder is also unconfirmed, for later.
10. **Token cost.** MCP was chosen over the CLI for safety, not cost. A quick measurement (one
    scripted extraction through `tm.py` and through MCP) would show whether the difference is as
    small as expected.
11. **Grouping by goal.** Groups come only from a shared origin for now. Tasks from different places
    that serve one outcome (the Priya reply and the deck she asked for on Slack) could share a group
    through a third answer on the duplicate card, "Same goal, separate tasks". Worth adding once
    origin groups have been used for a while.
