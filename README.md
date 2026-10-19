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
| **Triage** | Triage Queue Mockup (layout, card information architecture) + Fuzz Triage (reactions, motion) | Assign, Work in Claude, Schedule, Done (and its menu: Park it, Waiting on someone), drop, park a stray thought, undo |
| **All tasks** | Triage Queue Mockup | Current, Parked, Waiting on others, Done and Let go. Open any row for the full "done so far" log, sources, drafts and actions |
| **New task** | Triage Queue Mockup | Type or dictate (simulated), attach files (names only), Ctrl/Cmd+Enter. Press **N** anywhere to jump here |
| **Fuzz speaks** | Fuzz Triage | Everything the app tells you comes from Fuzz, never a toast: from the perch on Triage, from a small Fuzz bottom right on other pages |
| **Theme** | Warm Theme System | Eight themes (Terracotta, Honey, Moss, Lagoon, Indigo, Plum, Espresso, Warm gray), Light / Dark / Match system, Standard or High contrast, and a code font |
| **Code preview** | Warm Theme System (code style) | When Fuzz shows his work, code appears on the card's **Code** tab and in the task detail on All tasks. Try the dashboard filter bug (TypeScript, highlighted line), the dashboard spike (diff) and the feedback summary (JSON) |

Fuzz appears three ways: the full animated robot on the Triage perch, a small themed face used as the logo,
"how are you" icons and notices, and static SVG files in `assets/` (`fuzz-mark.svg`, `fuzz-logo.svg`,
`fuzz-favicon.svg`). The robot re-tints with every palette: the cabinet takes the accent, the screen glow stays warm.

The **Fuzz mood lab** (collapsed, under the Triage card) plays every mood, deadline level and reaction on demand,
which is the quickest way to review the motion.

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
- **Time-sensitive** (the first two cards): a live countdown, and Fuzz's three rush levels.
- **Stale**: "Still care about this?" with Yes, keep it / Let it go.
- **Handed back**: sits at the end of the queue, Fuzz looks sheepish and asks a quick either/or.
- **Entity check** (person and term): Same person / Different people, Save definition.
- **Possible duplicate**: Merge / Keep separate, with the reason shown.
- **Check-in**: appears after the last time-sensitive card. Good, Okay, Tired (5-minute break) or Overloaded (hold the rest until tomorrow).

Fuzz also works in the background: tasks you assign move through research and drafting on their own, finish as
**Needs your OK**, and one of them (the dashboard filter bug) gets stuck and comes back to your queue.

## How the Agentic Operating System principles show up

| # | Principle | In the app |
| --- | --- | --- |
| 1 | Execution partner | **Assign to Fuzz** is the primary action. Fuzz keeps working at inbox zero and the empty queue lists what he is doing |
| 2 | Non-linear work | A handback is a normal card that goes to the end of the queue, not an error |
| 3 | Show the work | Every task has a "Done so far" log (research, action, guidance, status, sent, blocked), and every click in the app writes to it |
| 4 | Thin records | Tasks hold a reference list (Sources) and the extracted ask, never the full message |
| 5 | Shared entity service | Entity checks (person, term) and merge/keep-separate matching cards |
| 6 | Humans approve what can't be undone | Drafts wait for **Approve and send**, concurrency starts at five (the sixth task shows "Next up"), and every change has **Undo** (an Undo button in the header with a list of recent actions, and a button in Fuzz's bubble) |
| 8 | Capture costs nothing | New task is one field, one key (N), no categories. |
| 9 | Lower the cost of starting | "Smallest first step, two minutes" on each task card |
| 10 | Time is human | Schedule uses "when I'm back at my desk", "before the planning review" and so on, with exact time as the fallback. Age is a three-segment cue, not a date |
| 11 | No shame spirals | No red overdue counts (past-due says "past its time"), stale cards ask rather than pile up, Parked never nags |
| 12 | Easy re-entry | "Where you left off" recap on returning cards, and **Park a stray thought** without leaving the card |
| 13 | One thing at a time | One card, with instructions and actions pinned at the top and Fuzz's suggestion pre-filled |
| 14 | Work alongside | Fuzz works visibly in the background, with a light status line now and then (never nagging) |
| 15 | Ambient beats initiated | Fuzz tells you when a draft is ready or something is handed back, from the perch or a small Fuzz on other pages. Fuzz also asks how you are after the urgent cards |
| 16 | Match the task to the moment | **Right now**: Anything / 5 minutes / Low energy reorders the queue |
| 17, 18 | Emotional connection, warm and quirky | Fuzz, the palettes, and a Calm mode that keeps the fades and drops the flashes |

Principles 7 (simplest thing that works) is about the build, so it shows up as the shape of this repo.

## What is simulated

- The AI work: a timer walks assigned tasks through scripted steps (`js/store.js`, `tick`). Step length is `STEP_MS`.
- Dictation inserts a fixed sentence. Attached files record only their names.
- "Work in Claude" moves the task to Current instead of opening anything.
- Source linking and matching (the Task matching doc) is represented by the duplicate and entity cards only.
  A working spike of the matcher itself, as a GitHub Copilot skill, is in [`spikes/task-matching/`](spikes/task-matching/README.md).

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
js/view-*.js        Triage, All tasks, New task
js/notify.js        Fuzz speaks: notices and Undo (no toasts)
js/app.js           router, header, theme popover
assets/             Fuzz logo files
```

To change a theme, edit `js/themes.js`. To change what Fuzz says or does on a moment, edit the lists near
`ASSIGNS`, `DONES` and `CI_REPLY` in `js/view-triage.js`. To change the demo data, edit `js/data.js`.
