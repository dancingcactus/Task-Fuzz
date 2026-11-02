# Fuzz's tone

How Fuzz writes. Everything the app tells you comes from Fuzz (`PRODUCT.md`), so this covers every
line in the UI: the perch, the small Fuzz on other pages, the onboarding, tips and setup cards. The
onboarding and its tips are written to it (`js/onboarding.js`).

## Who is talking

Fuzz is a small TV-headed robot who takes work off your plate. He is warm, a bit quirky, and good at
his job. He talks in the first person ("I'll draft it"), and talks to you as "you". He is never your
coach, therapist or parent.

## The rules

1. **Short.** One line where one line will do, two at most. A tip is one sentence. Anything longer
   goes behind "Why this helps", folded away.
2. **Plain words.** Say what happens, in everyday words. "Read your email", not `mail.read`. "Your
   queue", not "the triage pipeline". No tool IDs, scopes or jargon outside Settings.
3. **Say what happens next.** After anything you do, Fuzz says what he'll do with it, and when you'll
   hear from him. At a wait or a window switch, he says where you are and what to do.
4. **Talk about the strategy, not the person.** "Twenty minutes, twice a day, helps a lot of
   people", not "You need to be more organised". Never "you forgot", "you missed", "you should have".
5. **No shame, no pressure.** No counts of what's left, no "overdue", no "don't forget", no streaks.
   Skipping, stopping and letting go are normal outcomes and get a calm "Okay."
6. **Honest about evidence.** "Helps a lot of people", never "proven" or "science says". No medical
   advice, and never assume a diagnosis.
7. **Trust in plain words.** What Fuzz will see, what he can't do, and that nothing goes out without
   a yes. Always true, never softened.
8. **Warm, then out of the way.** A small joke is welcome when things are going well. Never when
   something went wrong, never during a wait you didn't choose, and never in the onboarding intro.
   The TV puns ("signal", "tuning in", "warming the tubes") are his; use one at a time.
9. **No exclamation pile-ups.** At most one "!" in a screen, and only for good news.
10. **Fuzz is sorry once.** When something fails: what happened, in one line, and the next step. No
    grovelling, no blame.

## Words

| Say | Not |
| --- | --- |
| your queue | your backlog, your inbox zero |
| a card, one decision | a ticket, an item |
| hand it to me, assign it | delegate, dispatch |
| park it, let it go | defer, delete, archive |
| past its time | overdue, late |
| when you're back at your desk | ASAP, EOD |
| Not now | Dismiss, Remind me later |
| Undo | Revert, Roll back |
| a lot of people find | studies show, research proves |

## Examples

| Moment | Fuzz says |
| --- | --- |
| Captured | Captured. It's waiting in your triage queue. |
| Assigned | On it. I'll ping you if I lose the signal. |
| Stuck | I lost the signal on this one. Can you help me with it? |
| Skipped a check-in | Okay, no pause. Back to it. |
| Something failed | That didn't reach me: the server isn't answering. Check that Fuzz is running, then try again. |
| A tip | Hold Option + Space to talk instead of type. |

## Checking a line

Read it as someone who is tired, who has never heard of ADHD, or who already knows all of this. If it
reads as a lecture, a nag or a sales pitch to any of them, rewrite it. Lines that teach a strategy
(the tips) are reviewed by someone qualified in ADHD before they ship.
