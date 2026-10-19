---
name: task-matching
description: Spike of the Task Matching method. Scans Justin's Outlook email, Slack and meeting summaries since the last run, extracts asks, and matches each one against a lasting task store (anchor lookup, entity overlap, semantic similarity, then you as the AI judge), so a request that arrives by meeting, then Slack, then email becomes one task instead of three. Writes /Users/jgrover/Context/dailyBriefs/matching/Matched Tasks.md. Use when Justin says "run task matching", "match my tasks", "dedupe my tasks", "update matched tasks", or asks to merge, split, keep separate, drop or schedule a matched task (e.g. "merge 14 into 7").
---

# Task Matching (spike)

This is a throwaway spike of the design in the "Task matching: source architecture
and methodology" doc. It is separate from daily-catchup: it keeps its own store and
writes its own file, and it never touches `Daily Tasks.md`.

The rules it follows:
- **Deterministic before fuzzy.** The script settles what it can (same thread, same Message-ID). You judge only the shortlist it hands you.
- **Never lose information.** When you're unsure, say so with a medium confidence. That becomes a "possible duplicate" for Justin, not a silent merge.
- **His decisions stick.** A task he marked done or let go is not revived by a repeat. Only a genuinely new ask brings it back.

Paths:
- `SKILL_DIR` is the folder containing this SKILL.md. The CLI is `python3 "$SKILL_DIR/scripts/tm.py"`, shown below as `tm`.
- Store: `/Users/jgrover/Context/dailyBriefs/matching/` (`tasks.db`, `config.json`, `Matched Tasks.md`). Pass `--store <dir>` before the subcommand only if Justin asks for a different one.
- Meeting summaries: `/Users/jgrover/Context/meetings/summaries/` (`YYYYMMDD - <title> - Write Meeting Notes.md`, with an `## Action Items` table)
- Justin: `jgrover@adobe.com`, Slack `W4R5SVCU9`

## Step 0: First run only

If `tasks.db` doesn't exist yet:

```bash
tm init --me-email jgrover@adobe.com --me-slack W4R5SVCU9 --me-name Justin --me-name "Justin Grover"
```

It reports whether sqlite-vec loaded and whether the embedder (Ollama, `nomic-embed-text`) answered.
If the embedder check fails, carry on: stage 3 is skipped and the report says so. Tell Justin
once ("Ollama isn't running, so semantic matching was off this run") and don't try to fix it yourself.

## Step 1: Read his decisions from the last report

```bash
tm sync
```

This reads `[x]` (done), `[-]` (let go) and `⏰ YYYY-MM-DD` (scheduled) from the last `Matched Tasks.md`
into the store. Always run it before ingesting, so a repeat signal sees the task's current state.

## Step 2: Gather signals

```bash
tm cursors
```

This prints `EMAIL_SINCE`, `SLACK_SINCE` and `MEETING_SINCE`: the last thing seen minus a 6-hour
overlap, or 3 days back on the first run. Re-reading the overlap is harmless, because ingest skips
any signal it already has.

Find the tools fresh each time (connector IDs change): `ToolSearch("outlook email search inbox")`,
`ToolSearch("slack search public private messages")`.

**Delegate the reading to a subagent** if your client has them (otherwise do it inline, keeping only signals in context). Give it the three `SINCE` values, the noise rules below and
`references/signal-schema.md`, and have it write a JSON array of signals to
`/Users/jgrover/Context/dailyBriefs/matching/signals.json`. It returns only a count to you. It must:
- Read email (Inbox, newest first, paginate), Slack (`to:me`, mentions of `<@W4R5SVCU9>`, DMs, threads
  Justin is in), and every meeting summary whose `YYYYMMDD` prefix is on or after `MEETING_SINCE`.
- Emit **one signal per message, Slack message or meeting action-item row**, including replies with no
  ask ("thanks!", "done"). Those carry `candidates: []` and are how suppression gets tested.
- Fill the anchor fields exactly as the schema says. They decide stage 1, so a guessed or reformatted
  anchor breaks matching. Use the real `webLink` / `permalink` for `link`, and never construct a URL.
- Extract candidates from **new text only**, never quoted history, with one candidate per distinct ask.
- Skip noise entirely: automated digests (Splunk, Jira subscriptions), newsletters and marketing,
  large-distribution FYIs, and meeting-invite logistics.

## Step 3: Ingest and run stages 1-3

```bash
tm ingest /Users/jgrover/Context/dailyBriefs/matching/signals.json
tm propose
```

`propose` settles what it can (anchor merges, clear new tasks, asks for someone else) and writes the
rest to `pending_judgments.json` in the store. Each item has the candidate, up to 3 shortlisted tasks
with their state, shared entities, semantic score, title history and recent history.

## Step 4: Judge (you are stage 4)

Read `references/judge-rubric.md`, then `pending_judgments.json`. For every item, write one verdict to
`/Users/jgrover/Context/dailyBriefs/matching/verdicts.json`:

```json
[{"candidate_id": 12, "task_id": 3, "verdict": "same", "confidence": 0.9, "new_ask": false,
  "reason": "Deposit is the next step of booking the venue", "new_title": "optional"}]
```

Then apply them:

```bash
tm apply /Users/jgrover/Context/dailyBriefs/matching/verdicts.json
```

The script, not you, maps verdict and confidence to an outcome (merge at 0.85 or above, possible
duplicate from 0.6, related, or new) and applies the state rules for done, dropped and scheduled tasks.

## Step 5: Report

```bash
tm report
```

This writes `Matched Tasks.md` (sections: Possible duplicates, Reopened, New, Updated, Still open,
Ignored repeats, and a table of which stage decided what). In chat, give Justin:
- one line of counts (for example "14 signals → 3 merged by thread, 2 by judgment, 1 possible duplicate, 4 new, 2 ignored"),
- each possible duplicate as a one-line question ("Is #14 *Finish the deck review* the same as #7 *Review the Q4 pricing deck*?"),
- anything reopened, with its reason.

Don't repeat the whole file.

## Acting on his answers

| He says | Run |
| --- | --- |
| "merge 14 into 7", "yes, same" | `tm merge 14 7` |
| "keep them separate", "no, different" | `tm keep 14 7` |
| "undo that merge" | `tm show <task>` to find the merge id, then `tm split <merge_id>` |
| "that Slack message isn't part of #7" | `tm show 7`, find the candidate id, then `tm detach <candidate_id>` |
| "done with 7" / "drop 7" / "push 7 to Friday" | `tm done 7` / `tm drop 7` / `tm schedule 7 YYYY-MM-DD` |
| "why did these merge?" | `tm show <task>`: anchors, entities, history and every decision with its stage, scores and reason |

After any of these, run `tm report` again so the file matches.

Merge, keep, split and detach are also recorded in the `feedback` table. That is the data for
tuning the thresholds later, so use these commands rather than editing the database by hand.
