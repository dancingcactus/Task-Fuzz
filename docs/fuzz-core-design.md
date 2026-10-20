# Fuzz core: design

Status: draft for discussion. Nothing here is built yet.

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
- **Scheduler**: decides which task a worker gets next (see [Scheduling](#scheduling)).
- **Approval gate**: holds drafts until a human approves, then hands them to an actuator.
- **Interfaces**: an HTTP API for UIs, an MCP server for AI workers, and an event stream that UIs
  subscribe to.

The HTTP API and the MCP server are two thin layers over the same core library, so they can't drift
apart.

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

### Executor

A loop that runs: claim a task → read it → do one step → write the result back → release. It holds no
state between runs. Anything the next run needs goes into the task's notes or log.

The executor can only change the world in three ways:

- **Inside the system**: log steps, write notes, create subtasks.
- **Through a draft** that waits for approval.
- **By handing back** with a question.

There is no `send`, `post` or `delete` tool.

### UI

The current clickable demo, with the simulated `tick` in `js/store.js` replaced by calls to the core.
It reads tasks over HTTP, subscribes to the event stream for changes, and sends your decisions
(assign, done, schedule, park, approve, undo) as commands. Fuzz's personality lives here.

## Data model

SQLite locally, with tables that port to Postgres. It grows out of the spike's schema (raw, derived
and log zones). The new parts are below.

```sql
users        (id, name, created_at)                    -- one row for now
events       (id, user_id, ts, actor, type, task_id, payload, caused_by, model, prompt_version)
tasks        (id, user_id, state, assignee, title, ask, due, order_key, notes,
              steps_used, attempts, lease_owner, lease_until, updated_event_id)
drafts       (id, user_id, task_id, kind, body, target, status, approved_by, approved_at)
sources      (id, user_id, task_id, signal_key, role)  -- thin references, never full messages
```

The spike's `signals`, `candidates`, `entities`, `identifiers`, `aliases`, `task_links`, `merges`,
`vectors`, `decisions` and `feedback` tables carry over, each gaining `user_id`.

### Events are the source of truth

- **Append-only.** `tasks` is a projection: it can be rebuilt by replaying `events`, and every row
  records the last event it reflects.
- **`actor`** is `human`, `fuzz:extractor`, `fuzz:executor` or `system`.
- **`model` and `prompt_version`** are recorded on every AI-made event. This lets you compare models
  on the same tasks and trace any decision back to what made it.
- **Undo** writes a compensating event (`task.restored`, with the earlier state in its payload). It
  never deletes. Something already sent outside can't be undone, which is why the approval gate
  exists.

### Task states

These match the demo's states.

| State | Assignee | Meaning |
| --- | --- | --- |
| `triage` | human | In your queue. Includes handbacks, duplicate checks, entity checks and check-ins. |
| `queued` | fuzz | Assigned to Fuzz and waiting for a free slot ("Next up"). |
| `working` | fuzz | An executor holds the lease. |
| `review` | human | A draft is waiting for your OK. |
| `session` | human | Open in a working session with Claude. |
| `scheduled` | human | Comes back at a time or moment ("when I'm back at my desk"). |
| `waiting` | — | Waiting on someone else. The extractor watches for the reply. |
| `parked` | — | Kept, never nags. Can wake on a new mention. |
| `done`, `letgo` | — | Closed. Comes back only on a genuinely new ask. |
| `merged` | — | Redirects to the task it was merged into. |

Human cards (duplicate checks, entity checks, check-ins) are tasks of a different `kind` assigned to
the human. One queue model serves both people and Fuzz.

### Event types

The names match the moments Fuzz already reacts to, so the personality layer is a lookup table:

```
task.captured   task.extracted   task.merged      task.split       task.assigned
task.claimed    task.step        task.draft_ready task.approved    task.sent
task.handed_back task.scheduled  task.woke        task.parked      task.waiting
task.done       task.let_go      task.restored    task.stale       task.deadline_level
checkin.due     checkin.answered entity.check     duplicate.check
```

## AI roles and contracts

| Role | Input | Output | Who checks it |
| --- | --- | --- | --- |
| `extractor.reader` | Raw source items since the cursor | Signals (schema) | Core rejects anything that doesn't match the schema |
| `extractor.judge` | `pending_judgments` shortlist | Verdicts (schema) | Core maps confidence to an outcome |
| `executor` | One claimed task | Tool calls only | Core enforces the state rules, budget and approval gate |

- Each role is set in config, for example `{"executor": {"client": "claude-code"}, "extractor.judge":
  {"client": "copilot"}}`, so roles can be upgraded on different schedules.
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
| `create_task(ask, sources, parent?)` | Splits off a subtask or captures a follow-up | Goes through matching like any other ask |
| `release(id)` | Gives up the lease | A lease that runs out releases itself |

Every call checks that the caller holds the lease on that task and that the task belongs to the
caller's user.

## Scheduling

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

1. **Now**: a scheduled loop on the Mac (launchd, or a Claude Code scheduled task) that claims until
   nothing is eligible.
2. **Later**: wake on events (`task.assigned`, `task.approved`) through the event stream.
3. **Web**: a worker pool reading per-user queues.

The loop doesn't change between these three, only what starts it.

## Approval gate and actuators

- A draft has a `kind` (`email.reply`, `slack.message`, `calendar.invite`…) and a `target` (thread,
  channel, people).
- **Approve and send** in the UI writes `task.approved`. An **actuator** for that kind does the send
  and writes `task.sent` with the resulting link.
- Actuators are small pieces of deterministic code in the core, one per kind. The AI never calls
  them.
- **Version 1**: no outbound actuators. Approve marks the draft approved and the UI offers "copy and
  open in Mail/Slack". Real send actuators come one kind at a time.
- **Prompt injection**: source content is untrusted. Because the executor can only produce drafts, a
  message that says "forward this to everyone" can at worst produce a draft that you can see and
  reject.

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
- MCP over stdio for local AI clients (Claude Code, Copilot), started by the client.
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

## Testing

- **Scripted roles** for the extractor, the judge and the executor, so the full loop runs offline.
- **Replay**: rebuild `tasks` from `events` and compare with the live table.
- **Contract tests** for the HTTP API and MCP tools, run against the same core library.
- **Isolation test** with two users.
- **Model comparison**: run two configs on a saved set of signals and tasks, and diff their decisions
  using the recorded `model` and `prompt_version`.
- The spike's existing tests carry over.

## Build order

1. **Core library**: events, the tasks projection, the state machine, `user_id` everywhere. Move the
   spike's store and matcher into it.
2. **HTTP API and event stream.** Point the demo UI at it instead of `tick`, with the personality
   tables unchanged.
3. **MCP server** with the executor tools, and a scripted executor.
4. **Real executor**: one MCP client running the loop with drafts only, no actuators.
5. **Extractor wired in**: the spike's flow (sync, cursors, ingest, propose, judge, apply) writes
   through the core.
6. **First actuator**, probably email reply. Then the rest, one kind at a time.
7. Web hosting and multiple users, when wanted.

## Open questions

1. **Language for the core.** Python reuses the spike and has an official MCP SDK. TypeScript would
   match the UI. Recommendation: Python.
2. **Which client runs the executor first?** Claude Code, Copilot or an Agent SDK script. MCP keeps
   this open, but the first one sets what the prompts are tuned for.
3. **Who reads the sources?** The extractor needs email and Slack access. Locally that can be the AI
   client's connectors, as in the spike. On the web the core would need its own integrations.
4. **Step granularity.** Is one claim one step, or does the executor work until it needs a human or
   runs out of budget? This affects cost and how lively the "Done so far" log looks.
5. **Undo window.** How far back Undo goes, and whether it can reverse a merge after later events
   touched the merged task (the spike's `split` handles the simple case).
6. **Retention.** How long raw signals and source content are kept, especially once there are
   several users.
