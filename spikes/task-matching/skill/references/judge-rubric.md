# Judge rubric (stage 4)

For each item in `pending_judgments.json`, compare the candidate's `ask` and `quote` with each
shortlisted task (`title`, `title_history`, `recent_history`). Return **one** verdict per candidate,
naming the single best `task_id`, or no `task_id` for `new`.

## Verdicts

| Verdict | Means | Example |
| --- | --- | --- |
| `same` | Doing the task would satisfy this ask. It's a nudge, a restatement, more detail or the next step of the same deliverable. | "Still need your comments on the pricing deck" vs "Review the Q4 pricing deck" |
| `related` | Same project or people, but a separate piece of work Justin would check off separately. | "Send the vendor contract to legal" vs "Book the offsite venue" (same thread, same sender) |
| `new` | None of the shortlist fits. | |

Shared people or a shared thread is not enough for `same`. Ask yourself: if Justin finished the
task, would this sender still be waiting on him for this ask? If yes, it's not `same`.

## Confidence

- **0.85 to 1.0**: you'd bet on it. The script merges silently, so be sure.
- **0.6 to 0.85**: probably the same, but the wording, scope or deadline differs enough that Justin
  should confirm. The script makes a possible-duplicate card.
- **Below 0.6**: say `related` or `new` instead.

Lean low. A wrong merge hides an ask, while a wrong "possible duplicate" costs Justin one tap.

## `new_ask` (only when the target task is done or dropped)

`needs_new_ask_test: true` means a shortlisted task is already closed. Set `new_ask: true` only if
the signal asks for something the original task did not cover ("could you also approve the travel
request?"). A thank-you, an acknowledgment, a status echo or a repeat of the original ask is
`new_ask: false`.

For a closed task, still use `same` when the signal belongs to that task's thread or topic. The
script reopens it on a new ask, or ignores it otherwise. A dropped task comes back only when
someone asked again after the drop.

## `new_title` (optional, on `same`)

Give one only when the ask has meaningfully moved on, for example "Book the November offsite venue
(deposit due Friday)". The old title is kept in history.

## `reason`

One sentence, written for Justin. It is shown in the report and stored with the decision.
