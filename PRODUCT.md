# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Knowledge workers with ADHD, or with heavy executive-function load. Their work arrives scattered across email, Slack and meetings, and their hardest problems are starting, choosing what comes next, coming back after an interruption, and not sinking into shame when things pile up. They triage with Fuzz in short sessions, often tired or overloaded, and hand as much of the actual doing as possible to Fuzz.

## Product Purpose

Fuzz is an agentic task partner. It turns incoming asks into one card at a time, suggests the next move, and does the work itself (research, drafting, actions) in the background, coming back for approval or a decision. Success means the user clears their queue without dread, starts things easily, and trusts what Fuzz did on their behalf.

This repository is a clickable, no-build demo with invented data. Its current job is **design refinement**: settling the UX and visual design before a real product is built. The AI work, dictation, attachments, source linking and "Work in Claude" are all simulated (see README "What is simulated").

## Positioning

Fuzz is an execution partner, not a list. "Assign to Fuzz" is the primary action, the work is visible as a "Done so far" log, and the interface is built around the user's emotional state as much as the task: check-ins reorder the queue, the progress bar only grows, and nothing counts against you.

## Operating Context

- Triage: one card in focus, with the instructions, Fuzz's pre-filled suggestion and actions pinned (Assign, Work in Claude, Schedule, Done, Park, Waiting on someone, drop, Undo).
- Card types: task, time-sensitive, stale, handed back, entity check (person, term), possible duplicate, check-in.
- Lineup: Current, Parked, Waiting on others, Done and Let go, with full task detail (log, sources, drafts, code).
- New task: one field, one key (N), no categories.
- Background work: assigned tasks progress on their own, finish as "Needs your OK", or get handed back.

## Capabilities and Constraints

- Human approval is required for anything that cannot be undone (drafts wait for "Approve and send"); every change has Undo.
- Tasks keep thin records: a reference list of sources and the extracted ask, never the whole message.
- Time is described in human terms ("when I'm back at my desk", "before the planning review"); exact time is the fallback. No red overdue counts: past due reads "past its time".
- The Agentic Operating System principles (numbered 1–18 in the README) describe the current intent. The user has not made them binding; treat them as strong guidance, not law.
- The no-build static HTML/CSS/JS shape is current practice, not a commitment.
- Undecided: the real product's stack, integrations (email, Slack, meetings, Claude), and accounts or multi-user scope.

## Brand Commitments

- **Fuzz is canon.** The TV-headed robot character, its moods and reactions, its warm and quirky voice, and the rule that everything the app tells you comes from Fuzz (from the Triage perch, or a small Fuzz on other pages), never a toast. Assets: `assets/fuzz-mark.svg`, `assets/fuzz-logo.svg`, `assets/fuzz-favicon.svg`, `js/fuzz-svg.js`.
- **The Warm Theme System is settled** (`js/themes.js`): warm foundation surfaces and status colours, eight accent themes (Terracotta, Honey, Moss, Lagoon, Indigo, Plum, Espresso, Warm gray), Light / Dark / Match system, Standard and High contrast, Nunito ExtraBold for headings and Nunito Sans for body, and a choice of code font. Future work extends it rather than redesigning it.

## Evidence on Hand

- All demo tasks, people and content in `js/data.js` are invented. There are no real users, testimonials, metrics or customer data; do not fabricate any.
- Source design artifacts referenced by the README: Triage Queue Mockup, Fuzz Triage, Warm Theme System, Task matching doc. A matcher spike lives in `spikes/task-matching/`.

## Product Principles

1. **Fuzz does the work.** Default to delegation; the user decides, Fuzz executes and shows what it did.
2. **No shame.** Nothing nags, counts down at you, or piles up in red. Progress only grows; stale items are asked about, not accused.
3. **One thing at a time.** One card, one decision, a two-minute first step.
4. **Match the moment.** How the user feels changes what comes next.
5. **Nothing irreversible without a yes.** Approval before sending, Undo after everything.

## Accessibility & Inclusion

Designed for ADHD and executive-function load: low cognitive cost to start, easy re-entry after interruption, and no punishing signals. High contrast works with every theme; Calm mode keeps fades and drops flashes, and motion must respect it. Status is always shown with an icon as well as colour.
