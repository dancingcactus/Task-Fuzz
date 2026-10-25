# Fuzz: clickable demo

A clickable, no-build web app version of the five design artifacts, with demo data, for refining the design.
Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
# then open http://localhost:8000
```

Everything runs in the browser. Nothing is sent anywhere, and the data is invented. Only your theme,
appearance and calm-mode choices are saved (in `localStorage`). **Settings > Reset demo data** starts over.

## What's in it

| Screen | Source artifact | What to try |
| --- | --- | --- |
| **Triage** | Triage Queue Mockup (layout, card information architecture) + Fuzz Triage (reactions, motion) | Assign, Work in Claude, Schedule, Done (and its menu: Park it, Waiting on someone), drop, park a stray thought, undo. Keys: **A** assign, **C** work in Claude, **D** done, **S** schedule (then **1** to **3** for a time, **M** for more times, **Esc** to go back), **P** park, **W** waiting on someone; **R** ask Fuzz to change a draft and **L** not now; **K** keep and **L** let go on a stale card. Numbers pick from the choice on screen: **1** to **3** on entity and duplicate cards, quick answers on a handback, **1** to **4** for your mood on a check-in and then its follow-up, **Esc** to skip. Press **?** (or Keys, under the card) for the full list. The next card takes input as soon as it is on screen, while Fuzz is still reacting. You arrive on a short "While you were away" card (what Fuzz finished, what came back, what is still running or waiting) and start with Enter, and an empty queue opens with a recap of the session |
| **Lineup** | Triage Queue Mockup | One page, by who has the ball: **To decide** (how many cards wait in Triage), **Yours** (taken on, in Claude, or drafts you set aside), **With Fuzz** (his lane: what he is doing right now, step dots, slots busy, and a note when a task finishes or comes back), **With others**, **Later** (scheduled, plus any parked task that woke up), **Parked** (collapsed) and **Finished** (collapsed). Open any row for the full "done so far" log, sources, drafts and actions |
| **New task** | Triage Queue Mockup | Type or dictate (simulated), attach files (names only), Ctrl/Cmd+Enter. Press **N** anywhere to jump here and start typing, and **Esc** to go back to Triage (what you typed is kept for next time). From the field, Tab goes to Capture and Shift+Tab to attaching a document |
| **Fuzz speaks** | Fuzz Triage | Everything the app tells you comes from Fuzz, never a toast: from the perch on Triage, from a small Fuzz bottom right on other pages. Screen readers hear outcomes and Fuzz's answers, not his quips |
| **Theme** | Warm Theme System | Eight themes (Terracotta, Honey, Moss, Lagoon, Indigo, Plum, Espresso, Warm gray), Light / Dark / Match system, Standard or High contrast, and a code font |
| **Code preview** | Warm Theme System (code style) | When Fuzz shows his work, code appears on the card's **Code** tab and in the task detail on Lineup. Try the dashboard filter bug (TypeScript, highlighted line), the dashboard spike (diff) and the feedback summary (JSON) |

Fuzz appears three ways: the full animated robot on the Triage perch, a small themed face used as the logo,
"how are you" icons and notices, and static SVG files in `assets/` (`fuzz-mark.svg`, `fuzz-logo.svg`,
`fuzz-favicon.svg`). The robot re-tints with every palette: the cabinet takes the accent, the screen glow stays warm.

The **Fuzz mood lab** plays every mood, deadline level and reaction on demand, which is the quickest way to review
the motion. It is a design tool, not part of the product, so it only appears when you open the app with `?lab`
(for example `http://localhost:8000/?lab`), collapsed under the Triage card.

## Theme system

Colours and fonts come from the **Warm Theme System** artifact (`js/themes.js`):

- **Foundation:** warm surfaces, text and status colours (done, waiting, blocked, always with an icon) shared by every theme.
- **Themes:** each supplies only an accent, an on-accent and a link colour, for light, dark and both high-contrast variants.
- **High contrast:** works with every theme. 2px borders, underlined links, an ink edge on primary buttons, and deeper or lighter colours.
- **Type:** Nunito ExtraBold (800) for titles and headings, Nunito Sans (400 and 600) for everything else.
- **Code preview** (`js/code.js`): 13px / 20px with line numbers, an accent-marked highlighted line, diffs with + and − signs as well as a tint, sideways scrolling for long lines, and a 44px Copy button that says Copied. Syntax colours are the same in every theme. The code font (JetBrains Mono by default, or DM Mono, Source Code Pro, Fira Code, IBM Plex Mono) is chosen in Theme settings and only that font is loaded. For diffs, Copy gives the new version (context and added lines).

To give a task code, add `code: [{ lang: 'ts' | 'js' | 'json' | 'diff', base, file, code, highlight, note }]` in `js/data.js`. Backticks in notes and log lines become inline code.

## Cards in the queue

The demo queue has every card type from the mockups and the matching doc:

- **Task**: instructions pre-filled, one decision, smallest first step, due bar, tabs for Conversation, Context, Done so far and Sources.
- **Time-sensitive** (the first two cards): a rough, human time ("due in under 2 hours", "about 20 minutes", "past its time"; Fuzz's screen shows whole minutes), and Fuzz's three rush levels. After you say you're Tired or Overloaded, Fuzz mentions the deadline gently instead, with no flash.
- **Stale**: asks whether it still matters ("Quiet for 9 days. Nothing new has come up.") with Yes, keep it / Let it go.
- **Handed back**: sits at the end of the queue, Fuzz looks sheepish and asks a quick either/or. Each answer has its own outcome: it replaces Fuzz's suggested instructions (anything you typed stays, after it), can change the draft and who it goes to, and "I'll find it" keeps the task with you, under Yours in Lineup, instead of handing it back to Fuzz.
- **Entity check** (person and term): Same person / Different people, Save definition.
- **Possible duplicate**: Merge / Keep separate, with the reason shown.
- **Check-in**: comes back through the session, often at first and then less often (after 2 cleared cards, then after at least 2 more and 5 minutes, then 10, then 20), and never while time-sensitive cards are waiting. Good or Okay keeps the usual order, Tired brings gentle cards first (with an optional 5-minute break), Overloaded brings quick cards first (or holds the rest until tomorrow). Once you answer, the other moods step aside and only one or two next steps remain. The spacing is `CI_FIRST` and `CI_GAP_MIN` in `js/view-triage.js`.

Fuzz also works in the background: tasks you assign move through research and drafting on their own, finish as
**Needs your OK** cards at the back of the triage queue (counted in Lineup under To decide; one you set aside with Not now moves to Yours), and one of them (the dashboard filter bug) gets stuck and comes back to your queue.

## How the Agentic Operating System principles show up

| # | Principle | In the app |
| --- | --- | --- |
| 1 | Execution partner | **Assign to Fuzz** is the primary action. Fuzz keeps working at inbox zero and the empty queue lists what he is doing |
| 2 | Non-linear work | A handback is a normal card that goes to the end of the queue, not an error |
| 3 | Show the work | Every task has a "Done so far" log (research, action, guidance, status, sent, blocked), and every click in the app writes to it |
| 4 | Thin records | Tasks hold a reference list (Sources) and the extracted ask, never the full message |
| 5 | Shared entity service | Entity checks (person, term) and merge/keep-separate matching cards |
| 6 | Humans approve what can't be undone | A finished draft joins the triage queue as a **Needs your OK** card that says who it goes to and how, lets you edit it or **Ask Fuzz to change it**, and sends only on **Approve and send** (never from a single key). Concurrency starts at five (the sixth task shows "Next up"). Every change that can be undone has **Undo** (an Undo button in the header with a list of recent actions); sending can't be, so it never appears there, and undoing an earlier change never brings a sent message back |
| 8 | Capture costs nothing | New task is one field, one key (N), no categories. |
| 9 | Lower the cost of starting | "Smallest first step, two minutes" on each task card |
| 10 | Time is human | Schedule offers three likely times ("when I'm back at my desk", "later today", "before it's due"), with "before the planning review", next week and an exact time behind **More times**. Age is a three-segment cue, not a date |
| 11 | No shame spirals | No red overdue counts (past-due says "past its time"), a progress bar that only grows (cleared cards become ticks that fold into a counted block, new cards only add segments, and it counts what's cleared, not what's left), stale cards ask rather than pile up, Parked never nags |
| 12 | Easy re-entry | A "While you were away" card when you arrive, a "Where you left off" recap on returning cards, a session recap when the queue is empty, and **Park a stray thought** without leaving the card |
| 13 | One thing at a time | One card that leads with the question to decide, then what it's about, then what Fuzz found (one line), then the instructions (Fuzz's suggestion pre-filled) and actions. On a phone the actions sit in thumb reach, in two short rows (Assign and Done, then Work in Claude and Schedule). Each new card opens at its question, scrolling back up if you had read down the last one, and while Fuzz's perch is scrolled out of view his lines also appear in a small bubble under the header. A stale card asks whether it still matters before showing any other actions |
| 14 | Work alongside | Fuzz works visibly in the background, with a light status line now and then (never nagging) |
| 15 | Ambient beats initiated | Fuzz tells you when a draft is ready or something is handed back, from the perch or a small Fuzz on other pages. Fuzz also checks in on how you are, often at first and then less often |
| 16 | Match the task to the moment | Your check-in answer reorders the queue: Tired brings gentle cards first, Overloaded brings quick ones first |
| 17, 18 | Emotional connection, warm and quirky | Fuzz, the palettes, and a Calm mode that keeps the fades and drops the flashes |

Principles 7 (simplest thing that works) is about the build, so it shows up as the shape of this repo.

## What is simulated

- The AI work: a timer walks assigned tasks through scripted steps (`js/store.js`, `tick`). Step length is `STEP_MS`.
- Dictation inserts a fixed sentence. Attached files record only their names.
- "Work in Claude" moves the task to Current instead of opening anything.
- Sending goes nowhere. **Ask Fuzz to change it** logs your note and brings the draft back as it was, since there is no model to rewrite it.
- Source linking and matching (the Task matching doc) is represented by the duplicate and entity cards only.
  A working spike of the matcher itself, as a GitHub Copilot skill, is in [`spikes/task-matching/`](spikes/task-matching/README.md).

The real backend is in [`core/`](core/README.md): the store and event log, cards, the scheduler,
the MCP server for the AI roles, the HTTP API and the installer for Claude Code and Copilot. `fuzz serve`
also serves this demo, but the demo doesn't call the core yet.

## Layout of the code

```
index.html          shell
css/fuzz.css        Fuzz, card stack, stamps, check-in (ported from the Fuzz Triage prototype)
css/app.css         everything else, driven by theme tokens
js/themes.js        the Warm Theme System: foundation, eight themes, high contrast, code colours and fonts
js/code.js          code preview
js/data.js          demo tasks (all invented)
js/store.js         shared state, undo snapshots, the background work loop
js/fuzz-svg.js      the full robot (generated from the prototype)
js/fuzz.js          robot controller, plus the small Fuzz faces
js/view-*.js        Triage, Lineup, New task
js/notify.js        Fuzz speaks: notices and Undo (no toasts)
js/progress.js      the segmented triage progress bar
js/app.js           router, header, theme popover
assets/             Fuzz logo files
```

To change a theme, edit `js/themes.js`. To change what Fuzz says or does on a moment, edit the lists near
`ASSIGNS`, `DONES` and `CI_REPLY` in `js/view-triage.js`. To change the demo data, edit `js/data.js`.
