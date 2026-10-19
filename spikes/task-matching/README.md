# Task matching spike (GitHub Copilot skill)

A throwaway spike of the **Task matching: source architecture and methodology** doc. It turns
email, Slack and meeting action items into one signal shape and matches every ask against a lasting
SQLite task store. Matching runs in four stages: anchor lookup, entity overlap, semantic similarity
and an AI judge. The judge is Copilot itself, following `skill/references/judge-rubric.md`.

The skill is self-contained. It doesn't change the daily-catchup skill, and it writes its own
`Matched Tasks.md` next to its store in the vault.

## Install

```bash
# 1. Make the skill visible to Copilot (personal skills folder)
mkdir -p ~/.copilot/skills
ln -s "$(pwd)/spikes/task-matching/skill" ~/.copilot/skills/task-matching
#    or, for one repo only: copy skill/ to <repo>/.github/skills/task-matching/

# 2. Optional: vector search in SQL (falls back to Python cosine without it)
python3 -m pip install --user -r spikes/task-matching/requirements.txt

# 3. Embeddings, kept on the Mac
brew install ollama && ollama serve &   # or the Ollama app
ollama pull nomic-embed-text

# 4. First run
python3 spikes/task-matching/skill/scripts/tm.py init \
  --me-email jgrover@adobe.com --me-slack W4R5SVCU9 --me-name Justin --me-name "Justin Grover"
```

Then ask Copilot to "run task matching". `SKILL.md` walks it through the steps: sync, cursors,
gather, ingest, propose, judge, apply and report.

The store defaults to `~/Context/dailyBriefs/matching/`. Override it with `TM_STORE=<dir>` or
`--store <dir>`. If Ollama isn't running, stage 3 is skipped and the report shows a warning.
`init --embedder hash` uses a crude offline bag-of-words embedder instead.

## Try it without real data

```bash
S=$(mktemp -d); T="python3 spikes/task-matching/skill/scripts/tm.py --store $S"
$T init --me-name Justin --embedder hash
$T ingest spikes/task-matching/skill/fixtures/day1.json && $T propose && $T report
sed -i '' 's/- \[ \] \*\*Approve Sam/- [x] **Approve Sam/' "$S/Matched Tasks.md"   # mark one done
$T sync && $T ingest spikes/task-matching/skill/fixtures/day2.json && $T propose
cat "$S/pending_judgments.json"     # what the judge would see; write verdicts.json, then:
# $T apply verdicts.json && $T report && open "$S/Matched Tasks.md"
```

Tests (stdlib `unittest`, hash embedder, scripted judge):

```bash
python3 -m unittest discover spikes/task-matching/tests
```

They cover these cases:
- An email, a Slack nudge and a forward become one task. The forward links by Message-ID.
- A meeting restatement at medium confidence becomes a possible duplicate.
- Two asks in one thread stay two tasks.
- A thank-you on a done task is ignored, and a new ask reopens it.
- A dropped task stays dropped.
- Ingest is idempotent.
- Merge and split round-trip.
- Report and sync round-trip.
- An embedder outage degrades to no stage 3 instead of failing.

## How it maps to the doc

| Doc | Spike |
| --- | --- |
| Signal → candidate → task | `signals` (raw, append-only) → `candidates` → `tasks` with `task_sources`, `task_anchors`, `history` |
| Entity service | `scripts/entities.py`: exact identifiers (email, Slack ID, doc ID, ticket key, domain), then a unique alias, else provisional. A new Slack ID joins an existing person when the full name is unique. |
| Stage 1, anchors | Thread anchor, Message-ID and ticket key. One live hit auto-merges if meaning agrees. Several hits, or a closed task, go to the judge. |
| Stage 2, entity overlap | Rarity-weighted (IDF). A doc or ticket counts 3, a person by ID 1, a person by first name 0.5, an org 0.3. |
| Stage 3, semantic | Max cosine over the asks a task already holds, through `vectors.py` only (sqlite-vec 0.1.6, pinned). Each vector stores its model, and `tm.py reembed` switches models. |
| Stage 4, judge | Copilot writes `verdicts.json`. `tasks.apply_verdicts` maps confidence to merge (0.85 and up) or possible duplicate (0.6 and up). |
| Task states and suppression | Done: ignored unless there's a new ask. Dropped: comes back only on a re-ask after the drop. Scheduled: attaches quietly and is pulled forward by an earlier deadline. |
| Run mechanics | Per-source cursors with a 6h overlap, signal keys `source:id:version`, and a `decisions` log with stage, scores, reason and `MATCHER_VERSION`. |
| Merges can be undone | `merges.moved` records what moved. `split` and `detach` undo merges and attaches, and old IDs redirect. |
| Your taps tune the matcher | `merge`, `keep`, `split` and `detach` write to `feedback`. |

Inspect everything with `sqlite3 ~/Context/dailyBriefs/matching/tasks.db` or
`datasette ~/Context/dailyBriefs/matching/tasks.db`, and `tm.py show <id>` for a single task.

## Known gaps (it's a spike)

- Candidates waiting on the judge don't create tasks until `apply`. Two related asks that both need
  judging in the same run aren't compared with each other.
- There's no AI step in entity resolution. An ambiguous first name stays provisional and doesn't count.
- Calendar, docs and ticket adapters aren't built yet. No backfill or review list for matcher changes.
  No change feed.
- `reset --yes` wipes the store. There's no rebuild of the derived tables from the raw zone.
- Thresholds and the hash-embedder floors were set on the fixtures only. Expect to tune the Ollama
  floors (`matcher.SEM_FLOOR` and related settings) on real data.
