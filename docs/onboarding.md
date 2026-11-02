# Onboarding: requirements

Status: built, steps 1 to 6 of the order of work, in `js/onboarding.js`, `core/fuzz/onboarding.py`,
`install.sh` and `docs/fuzz-tone.md`. Step 7, trying it with someone who has ADHD, hasn't happened, and the
tip wording hasn't been reviewed by someone qualified in ADHD yet. The code facts below were checked
against `claude/ask-me-later` at `895ecd3`.

## Goal

A new user goes from nothing to working a real card, in the browser, in one short sitting. On the way
Fuzz introduces himself, sets up what he needs, and teaches how to be effective with ADHD.

This replaces the old four-step guided setup (`js/setup.js`, now removed) as the first-run experience.
Changing anything later happens on the Settings page (`#/settings`, see "As built").

## The flow

1. **One paste.** A single command, copied from the README, installs the core, initialises it, starts `fuzz serve` and
   opens the browser, already signed in. The user never copies a token or opens a log file, and never
   goes back to the terminal.
2. **A short form.** Name, app (Claude or Copilot) and working hours. These are the only things asked
   before Fuzz has done anything.
   - The app Fuzz finds on the Mac is highlighted. Choosing one installs Fuzz for it in the background.
   - Working hours include weekends and "no fixed hours". Fuzz reads for new asks during these hours.
   - See [When the app isn't ready](#when-the-app-isnt-ready).
3. **Fuzz introduces himself.** Who he is and what his job is, in his own tone, in a few lines. This
   includes the trust promise: nothing goes out without a yes, and everything has Undo.
4. **Press N.** Fuzz asks them to press N and enter one real task, nudging towards something he can
   write or think through, since he has no lookup tools yet. The New task screen shows the dictation
   tip. Anyone using a mouse can use the New task button.
5. **Tips during the wait.** A captured task goes to Fuzz before it reaches Triage, so there's a real
   wait. Fuzz uses it for the three [first tips](#first-tips). The tips can be ignored.
6. **The first card.** When the task is ready, Fuzz says so and waits until the user is ready. He then
   walks them through that one decision, teaching only the action that fits. A captured task can land
   two ways, and both need a path:
   - **As a normal card:** Fuzz teaches Assign.
   - **Already done,** when looking it up was the whole job: Fuzz shows what he did.
7. **What's next.** One line saying that Fuzz only knows what they type until a source is connected.
   The onboarding ends here, Fuzz runs a first read, and setup cards take over.

The first read must use Run now. Scheduled reading stops outside working hours, so a user setting up on
a Saturday would otherwise see nothing until Monday.

### When the app isn't ready

Fuzz can only use a client that passes its check, and install has to finish before the first task. So
choosing an app has three outcomes:

- **Ready:** Fuzz carries on.
- **Installed but has a problem:** Fuzz repairs it, or says what to do.
- **Neither yet:** Fuzz gives a link to get one and offers Demo data, so the user isn't stuck.

### Interruptions

Closing the page at any step keeps everything. Coming back resumes at the same step. Anyone can skip
the intro, and people who have already set up never see it. Settings has **Show me around again**, for
the intro and the tips.

## What Fuzz teaches

### First tips

These three are the only tips in the onboarding itself:

1. **Set aside 20 minutes, once or twice a day, to go through your queue.** Put it on your calendar.
   Fuzz offers a one-click calendar file for a time inside their working hours, with a link back to
   Fuzz. The app sends no reminders of its own.
2. **Don't be afraid to ask Fuzz to change things, or to send a task back to him as often as you
   like.** On a draft, R asks for a change. On other cards, the instructions box does it. Fuzz repeats
   this on their first draft.
3. **Missing a session loses nothing.** Nothing is lost, and stopping at 20 minutes with cards left is
   fine. This one matters most, because it stops the appointment becoming one more thing to fail at.

### Later tips

Each is said once, when it first becomes relevant, by Fuzz, in a line or two:

| Tip | When Fuzz says it |
| --- | --- |
| Hold Option + Space to dictate | On the first New task screen |
| Press T to park a stray thought | On the first card |
| Everything has Undo | After their first action |
| Say how you're doing, and the queue changes to match | At the first check-in |
| Letting something go is a real outcome | On the first stale card |
| Schedule in human terms, like "when I'm back at my desk" | The first time they open Schedule |
| Work in Claude when you want to do it together | When a task comes back handed over |
| Press ? for all the keys | Once they've worked a few cards |

### How to word them

- Say "helps a lot of people", not "proven". Evidence varies by strategy.
- Someone qualified in ADHD reviews the lines before they ship.
- No medical advice, and no assumption of a diagnosis. `PRODUCT.md` also includes people with heavy
  executive-function load.

## Settings

| Setting | When | How |
| --- | --- | --- |
| Name | Form | Typed |
| App (Claude or Copilot) | Form | Pick one; the installed one is highlighted |
| Working hours | Form | Hours, weekends, or no fixed hours |
| Lookup source | First setup card | The first connector, in plain words |
| Output folder | Setup card | One-tap yes to `~/Documents/Fuzz`, because it's a real permission |
| Colour theme | Light card a few days in | One tap with a live preview |
| Send tools | When the first draft is approved | Never pre-ticked |
| Other emails, Slack ID | When a connector shows an address Fuzz doesn't know | Never asked up front |
| Calm mode, high contrast, appearance, code font | Not asked | Stay in Settings |
| Model, stale days, parked reviews, back-at-desk, Ollama | Not asked | Keep the defaults |

Settings stays reachable throughout, so the onboarding can't be a locked dialog. Someone who needs high
contrast must be able to get to it during the intro. Systems set to reduce motion already turn Calm mode
on.

### Setup cards

Everything after the form arrives as a card in the queue:

- There is only ever one setup card at a time, and it comes after real work.
- The order is lookup source, then output folder, then colour theme.
- "Not now" means it. The card goes away quietly and comes back at most once. It never builds up.
- Answering one counts as progress. Ignoring one never counts against them.
- The lookup source card leaves the browser, because connectors sign in through Claude or Copilot. It
  needs principle 5 most: instructions that stay visible, and a way back.

## Principles

These add to the Product Principles in `PRODUCT.md` and the numbered principles in the README, and
don't replace them.

1. **Show value before asking for effort.** Interest is the fuel, and first-session novelty burns off
   fast. *Test:* after the form, the next thing they do is hand Fuzz something real.
2. **Ask only what Fuzz can't work out.** A blank field means recalling or fetching something, and
   leaving the app to do that can end the session. *Test:* no step needs a trip to another app to look
   something up.
3. **One decision per screen, with a safe default.** Decisions drain people quickly. Send tools are
   the exception and stay unticked. *Test:* a tired user can accept everything and end up safe and
   working.
4. **Leaving is a normal way through.** Interruptions are guaranteed, and coming back is one of the
   hardest parts. *Test:* close it mid-sentence, come back tomorrow, and everything is still there.
5. **Don't lose them at the hand-offs.** Waits and window switches are where working memory fails.
   Say what's happening and what to do next, keep it visible, and bring them back. *Test:* someone who
   wanders off during a wait can tell where they are at a glance.
6. **No setup debt.** No percentages, "finish setup" badges or reminders, and no streaks or lesson
   counts. A missing piece comes up once, in context, when it would pay off. *Test:* a user who skips
   everything never sees a sign of it, except an offer at a useful moment.
7. **Earn trust in plain words.** Say what Fuzz will see, what he can't do, and that nothing sends
   without a yes. Describe abilities, such as "Read your email", not tool IDs. *Test:* a non-developer
   can repeat what they agreed to.
8. **End on a start.** Starting is the core difficulty, so finishing leads straight into doing
   something. *Test:* the last screen is their first real card.
9. **One paste, then the browser.** Every terminal step is a place to stall. *Test:* the user never
   returns to the terminal, copies a token or opens a log file.
10. **Teach by doing, one idea at a time.** A strategy tried on your own real task can stick. Each
    tip is one sentence from Fuzz, attached to what's happening then, with the longer why folded away.
    *Test:* removing every tip wouldn't add a step, and skipping them costs nothing.
11. **Talk about the strategy, not the person.** Advice can sound like "you've been doing it wrong",
    and shame is what Fuzz exists to avoid. *Test:* each line reads fine to someone who is tired,
    undiagnosed or already knows all this.
12. **Fuzz introduces himself by working.** A tour spends the user's early interest and proves
    nothing. The intro is always calm, with no flashes or gags, and the normal lively default starts
    after it. *Test:* someone can skip every word and still know Fuzz takes work off their plate.
13. **Settings arrive as cards, when they'd pay off.** A settings tour means decisions with no
    experience to base them on. *Test:* each question either changes something on screen or tells the
    user what Fuzz may now do.

Everything comes from Fuzz, in his tone, and Calm mode is respected, as `PRODUCT.md` already requires.

These principles come from common ADHD traits and the code, not from testing. There are no real users
yet, so treat them as hypotheses until someone with ADHD tries the flow.

## What needs building

| Need | Today | Work |
| --- | --- | --- |
| Tone guide for Fuzz's writing | Lines scattered through the UI | Write it first; the intro and tips depend on it |
| One-paste bootstrap | Four commands, then a token link | A script that does it all and opens the browser signed in, with the command in the README |
| Install from the browser | `POST /engine/clients/{client}/install` exists; the UI doesn't call it | UI only, but see below |
| Choosing the app | `PUT /engine` exists; the UI doesn't call it | UI only |
| Repairing a client | The `repair` action exists; the UI doesn't call it | UI only |
| Working hours | `extract.hours` and `extract.weekends` in config, no route | A small backend route |
| First read | `POST /engine/run` with role `extractor` | Call it at the end of the flow |
| Calendar file | Nothing | Generate an `.ics` in the browser |
| Setup cards | Nothing; check-ins and permission cards are the precedent | A new card type |
| Identity from a connector | Nothing | Needed before Slack IDs and other emails can stay unasked |
| Resume and Show me around again | Reopening setup starts at step 1; closing it stops it reopening | Saved progress, and a Settings entry |
| First-card walkthrough | Nothing | Both landing paths |

**Installing restarts the server.** `fuzz install` reloads the launchd jobs, including the `fuzz serve`
that would be handling the request. The page has to survive that and reconnect.

## Order of work

1. Write the tone guide.
2. Build the one-paste bootstrap and browser sign-in.
3. Build the form, including the install path, its three outcomes and the restart.
4. Build the intro, New task step, tips and first card.
5. Build the calendar file.
6. Build setup cards and later tips.
7. Try the flow with someone who has ADHD.

## As built

- **The order.** Fuzz introduces himself first, asks two questions (name and app), says how he helps,
  asks his first question on a card in Triage (working hours), and only then asks for a task, pointing at the New task
  button (the floating one on a phone). The app's header appears with the Triage question; until then it,
  Settings included, is hidden, so the first screens are only Fuzz. This trades away the "Settings stays
  reachable" rule above for the intro and the questions. A system set to reduce motion still gets Calm
  mode, but high contrast can't be switched on until the header appears.
- **Where it lives.** The flow is a page, `#/welcome` (`js/onboarding.js`). Progress is kept by the core in `onboarding-u<user>.json` (`GET/PUT /onboarding`), not as
  events, so Undo never reverses a step. People with tasks already, or the old guided setup finished, skip
  it.
- **The form** highlights the app it finds and sets Fuzz up in it when picked, or when you go on with the
  default. Install and repair go through `POST /engine/clients/{client}/install|repair`, then the page
  waits for the server's `boot` id in `GET /health` to change (or a few quiet seconds where nothing
  restarts), checks the client and picks it with `PUT /engine`. A client that isn't there gets a link to
  get it, "I've installed it" to look again, and Try the demo, which runs the same intro on demo data.
- **Working hours are Fuzz's first question**, right after how he helps. The header fades in on Triage,
  where a question card waits ("When do you work?", introduced as "This is Triage… here's an easy one to
  start"), so the first card anyone works is an easy one. One key answers it: your usual hours on
  weekdays, every day, no fixed hours, or Different hours for a picker. Esc keeps the usual hours for now.
  N stays off until it's answered.
- **Then the new task.** Answering (or skipping) brings Fuzz's ask for one real task, with the New task
  button ringed and pointed at.
- **How Fuzz helps, guilt-free** is its own step, right after the name and app, still with the header
  hidden. The three first tips are told as what Fuzz does: one queue, so a short session is enough
  (with the calendar file); nothing he does is final; he doesn't keep score. Each has "Why this helps"
  folded away, and Got it (Enter) moves on.
- **The wait** teaches the next habit: keep an eye on Triage, where Fuzz brings tasks he has looked into
  and any questions he has. The Triage tab is ringed and pointed at. Going there early is fine: Fuzz is
  shown reading up on the task, and when it lands the lesson is on its card.
- **The first card** is picked to the front of Triage and carries the lesson above its question. Acting on
  it in any way ends the onboarding: the Undo tip, and one line saying the next card is a task for Fuzz.
- **Fuzz's own task, "Let me find your asks",** is the last card (`POST /onboarding/kickoff`, made once,
  tagged `kickoff`). Assigning it doesn't start the executor (the tag keeps it off the executor's list):
  Fuzz asks the app what it can reach (the guided setup's discovery run), then asks one permission card
  per source, "Can I read Gmail?", reading only, Yes or Not this one. Yes turns on that source's lookup
  tools; send tools are never asked about here. When every card is answered the task is done, its log
  says what was allowed, and the first read starts (Run now). Nothing found, or the listing failing,
  hands the task back with what to do. It replaces the lookup setup card. Check-ins wait until it's done.
- **The intro is calm**: Calm mode is on from the form to the first card, whatever the setting.
- **Setup cards** (output folder, then colour theme; lookup only for anyone without the kickoff task) are
  drawn by Triage, like check-ins, with the core keeping the answers. One shows per
  visit, after a card is cleared, never on the visit the onboarding ended. Not now always works (Escape),
  and a second Not now retires the card. The lookup card asks the app what it can reach (the guided setup's
  discovery run) and offers only its suggested ways to read, in the tools' own plain words.
- **Later tips** are said by Fuzz, once each, a moment after the card they belong to arrives, and only if
  you're still on it.

- **Settings** (`#/settings`, `js/view-settings.js`, the gear in the header; there are no quick settings)
  replaces the four-step wizard with one page of sections, each saved on its own: About you (names,
  emails, Slack IDs); App (status, set up, repair, switch, check again); Working hours (the same choices
  as Fuzz's question); What Fuzz can read and send (one row per source in plain words, with Reading and
  Sending switches, List again, and each tool by name under Details, with its token cost); Where Fuzz
  saves files; Look and feel (theme, appearance, contrast, code font, Calm mode, applied at once and kept
  in this browser); Your queue (Refresh now, or Reset demo data in the demo, and Switch account); and Show me
  around again. In the demo the page has only Look and feel, Demo and the tour.

Not built yet:

- **Send tools when the first draft is approved.** Approving still works as before; the sender hands a
  draft back when no send tools are allowed. The guided setup in Settings picks them.
- **Identity from a connector.** Other emails and Slack IDs are no longer asked up front, but nothing reads
  them from a connector yet, so they still come from Settings › About you or `fuzz me add`.
- **Step 7.** No one with ADHD has tried the flow, and the tips haven't had the qualified review.
