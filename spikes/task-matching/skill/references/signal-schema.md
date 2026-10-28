# Signal schema

`signals.json` is a JSON array. One object per email message, Slack message or meeting
action-item row. See `fixtures/day1.json` and `fixtures/day2.json` for complete examples.

```json
{
  "source": "email | slack | meeting",
  "source_id": "stable id of this one item",
  "version": "1",
  "anchor": "thread anchor, exact format below",
  "message_ids": ["<abc@host>"],
  "link": "real webLink / permalink / file:// URI",
  "ts": "2026-10-16T09:00:00Z",
  "from": {"name": "Priya Shah", "email": "priya@acme.com", "slack_id": "U0PRIYA"},
  "people": [{"name": "Sam Ortiz", "email": "sam@acme.com"}],
  "links": ["https://docs.google.com/.../d/<id>/edit", "https://jira.example/browse/OPS-412"],
  "quote": "one or two sentences of the new text, under 300 characters",
  "title": "the email's subject, optional",
  "withdrawn": false,
  "candidates": [
    {
      "ask": "Review the Q4 pricing deck (discount tiers)",
      "owner": "me | unclear | <person's name>",
      "due": "2026-10-16",
      "people": [{"name": "Priya"}],
      "links": [],
      "topics": ["Q4 pricing"]
    }
  ]
}
```

## Fields by source

| Field | Email | Slack | Meeting |
| --- | --- | --- | --- |
| `source_id` | message id | `<channel>:<ts>` | `<summary file stem>#<row slug>` |
| `version` | `"1"` | `"1"`, or the `edited.ts` when edited | the summary file's modified time |
| `anchor` | `email:<conversationId>` | `slack:<channel>:<thread_ts>`, or `slack:<channel>:<ts>` when unthreaded | `meeting:<summary file stem>#<row slug>` |
| `message_ids` | this message's `Message-ID` plus every id in `In-Reply-To` and `References` | omit | omit |
| `link` | `webLink` | `permalink` | `file://` URI of the summary file plus `#<row slug>` |
| `from` | sender name and email | name and Slack user ID, plus email if the profile shows it | `{"name": "<meeting title>"}` |

- The **row slug** is a short lowercase hyphenated slug of the action item's text. Two rows in one
  file must never share a slug. The same row must produce the same slug on every run.
- `title` is optional: an email's subject, without "Re:" or "Fw:". When one email, meeting or burst of
  Slack messages brings several asks, the core groups their tasks and names the group after it.
- `message_ids` is what links a **forward**, which starts a new conversation, back to the original.
  Include the References header whenever the tool exposes it.
- `links` holds only shared docs and tickets mentioned in the message. Never include the message's own permalink.
- Set `withdrawn: true` (with no candidates) for a Slack message that was deleted. The task stays open.

## Candidates

- One candidate per **distinct ask** in the new text. Two asks in one email are two candidates.
- `owner`: `me` when it's Justin's to do, `unclear` for "someone should...", otherwise the person's
  name. Asks owned by someone else are kept only as context on a matching task.
- `ask` is a short imperative, written so Justin would recognize it: "Approve Sam's PTO request", not "PTO".
- `topics` are optional project or term names. Use the same spelling each time ("Q4 pricing").
- No new ask (a thank-you, "done", an FYI reply in a thread) means `"candidates": []`. Still emit the signal.
