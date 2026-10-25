/* Demo data. Everything here is invented. Source systems stay the raw store (principle 4), so each
   task carries only a reference (sources), the extracted ask (incoming) and the log of work. */
(function () {
  function L(kind, time, text) { return { kind: kind, time: time, text: text }; }

  /* Code Fuzz found or wrote while working, shown in the code preview. */
  var CODE = {
 "owner": [
  {
   "lang": "ts",
   "file": "src/dashboard/filters.ts",
   "highlight": 9,
   "note": "`onRefresh()` replaces the saved filters with the defaults, which is why they reset. Ines wrote `loadFilters()`; Tomas last changed `onRefresh()`.",
   "code": "// Restore saved filters after a refresh\nexport function loadFilters(userId: string): Filters {\n  const saved = storage.get(\"filters:\" + userId);\n  if (!saved) return defaultFilters();\n  return { ...defaultFilters(), ...JSON.parse(saved) };\n}\n\nexport function onRefresh(state: DashboardState) {\n  state.filters = defaultFilters(); // resets saved filters\n  render(state);\n}"
  }
 ],
 "spike": [
  {
   "lang": "diff",
   "base": "ts",
   "file": "track.ts",
   "note": "The tracking deploy at 8:02 AM sends `page_view` twice. Skipping events already sent would stop the double count.",
   "code": " export function track(event: TrackEvent) {\n-  analytics.send(event.name, event.props);\n+  if (seen.has(event.id)) return;\n+  seen.add(event.id);\n+  analytics.send(event.name, event.props);\n }"
  }
 ],
 "feedback": [
  {
   "lang": "json",
   "file": "themes.json",
   "note": "Each theme keeps a link to every quote so you can check them.",
   "code": "{\n  \"themes\": [\n    { \"name\": \"Large tables load slowly\", \"quotes\": 14 },\n    { \"name\": \"Scheduled exports are confusing\", \"quotes\": 9 },\n    { \"name\": \"Customers want shareable views\", \"quotes\": 7 }\n  ],\n  \"unsorted\": 17\n}"
  }
 ]
};

  function build() {
    var now = Date.now();
    var items = [

      /* ---------- Triage queue, in order ---------- */
      { id: 'headcount', kind: 'task', state: 'triage', title: 'Confirm headcount for tomorrow’s offsite booking', source: 'Slack', who: 'Marcus',
        age: '35 minutes', stage: 'fresh', mins: 3, energy: 'low', dueMin: 95,
        incoming: 'Marcus needs a final number so the venue can lock the booking. The venue wants it before the end of the day.',
        ask: 'Is it 14 or 16 people?',
        hint: 'Check the RSVP sheet, count confirmed attendees and reply to the venue with the final number. Flag me right away if it will not make the deadline.',
        aiHeading: 'What Fuzz did', aiNote: 'I counted 14 confirmed RSVPs and 2 maybes in the sheet. The venue wants one number, so the maybes are the open question.',
        firstStep: 'Open the RSVP sheet and look at the “Maybe” column.',
        log: [L('research', '9:42 AM', 'Counted 14 yes and 2 maybe in the RSVP sheet.'), L('action', '9:40 AM', 'Pulled this task out of Marcus’s Slack message.')],
        sources: [{ type: 'Slack', title: 'Thread in #offsite-planning' }, { type: 'Doc', title: 'Offsite RSVP sheet' }],
        sendTo: { to: 'Marcus', via: 'Slack, #offsite-planning' },
        draft: 'Hi Marcus, final count for the offsite is 14 confirmed. I will send an update only if one of the two maybes changes. Thanks!' },

      { id: 'room', kind: 'task', state: 'triage', title: 'Book the room for Thursday’s workshop', source: 'Meeting', who: 'Staff sync',
        age: '1 day', stage: 'settling', mins: 2, energy: 'low', dueMin: 250,
        incoming: 'In the staff sync you said you would book a room for the Thursday workshop. Eight people are coming.',
        ask: 'Should I take the big room on 3 or the quiet one on 5?',
        hint: 'Book the earliest open room that fits eight people on Thursday afternoon, and send the invite to the attendees.',
        aiHeading: 'What Fuzz did', aiNote: 'Both rooms are free Thursday at 2 PM. The big room has a screen, and the quiet one does not.',
        firstStep: 'Look at the calendar for Thursday afternoon.',
        log: [L('research', 'Yesterday', 'Checked both room calendars for Thursday.'), L('action', 'Yesterday', 'Pulled this task out of the staff sync notes.')],
        sources: [{ type: 'Calendar', title: 'Room 3 and Room 5 calendars' }, { type: 'Doc', title: 'Staff sync notes' }],
        sendTo: { to: 'the eight workshop attendees', via: 'Calendar invite' },
        draft: 'Booked Room 3 for Thursday 2:00 to 4:00 PM. Invite sent to the eight attendees with the workshop agenda attached.' },

      { id: 'launch', kind: 'task', state: 'triage', title: 'Decide the launch date for the report builder', source: 'Email', who: 'Elena Park',
        age: '4 hours', stage: 'fresh', mins: 10, energy: 'high',
        due: { label: 'Elena needs a date by Monday', left: 'About 2 days left', frac: 0.3 },
        incoming: 'Elena needs a launch date by Monday so support, docs and marketing can plan around it. Engineering says the date depends on one open performance issue.',
        ask: 'Should we commit to the earlier date, or hold the later one?',
        hint: 'Propose the later date with a clear fallback, keep the tone confident, and show me the draft before sending.',
        aiHeading: 'What Fuzz did', aiNote: 'I pulled together the email thread, the spec and the status of the open issue, then drafted a reply that proposes the later date with a fallback.',
        firstStep: 'Read the last two lines of the engineering comment.',
        context: ['Support needs two weeks of notice before they can train the team.', 'The open performance issue slows reports built on very large tables.', 'Docs are mostly written. The last pages wait on final screenshots.', 'Marketing is holding a newsletter slot for the later date.', 'Two beta customers asked for the earlier date.'],
        log: [
          L('action', '2:40 PM', 'Drafted a reply that proposes the later date with a fallback.'),
          L('guidance', '2:36 PM', 'You said: propose the later date, keep the tone confident, and show you the draft first.'),
          L('research', '2:32 PM', 'Checked the latest comment from engineering on the performance issue.'),
          L('blocked', '2:25 PM', 'Could not open the support training schedule. Fuzz has no access to that folder, so the two-week notice is unconfirmed.'),
          L('research', '2:18 PM', 'Read the spec and release checklist, and listed what is still open.'),
          L('status', '2:00 PM', 'Came back from “Schedule for later” and joined your queue.'),
          L('status', '11:20 AM', 'You scheduled this for this afternoon.'),
          L('sent', '11:12 AM', 'Sent Elena a short holding reply: “Thanks, I will have a date for you by Monday.”'),
          L('action', '11:00 AM', 'Pulled this task out of Elena’s email and collected two related Slack threads.')],
        sources: [{ type: 'Email', title: 'Launch timing for the report builder' }, { type: 'Slack', title: 'Thread in #report-builder about the date' }, { type: 'Doc', title: 'Report builder spec and release checklist' }, { type: 'Ticket', title: 'Slow load on very large tables' }],
        sendTo: { to: 'Elena Park', via: 'Email reply' },
        draft: 'Hi Elena, I recommend we commit to the later date, with a fallback of two weeks after if the performance fix slips. Support gets their two weeks of notice, and docs finish with final screenshots. I will confirm Monday morning.' },

      { id: 'readout', kind: 'task', state: 'triage', title: 'Reply to Priya about the Q4 experiment readout', source: 'Email', who: 'Priya Raman',
        age: '2 hours', stage: 'fresh', mins: 5, energy: 'normal',
        due: { label: 'Priya needs a call before Tuesday', left: 'About 3 days left', frac: 0.45 },
        incoming: 'Priya wants a clear call on whether the winning variant ships, before Tuesday, so she can brief her team.',
        ask: 'Do you agree with shipping the winning variant?',
        hint: 'Recommend shipping, keep it under five sentences, and send me the draft before you reply.',
        aiHeading: 'What Fuzz did', aiNote: 'I pulled the final results and guardrail metrics, and drafted a short reply with a recommendation.',
        firstStep: 'Open the results doc and read the summary table.',
        log: [L('action', '10:14 AM', 'Drafted a five-sentence reply recommending the winning variant.'), L('research', '10:08 AM', 'Pulled the final results and the guardrail metrics.')],
        sources: [{ type: 'Email', title: 'Priya: Q4 readout, can you confirm?' }, { type: 'Doc', title: 'Q4 experiment results' }],
        sendTo: { to: 'Priya Raman', via: 'Email reply' },
        draft: 'Hi Priya, yes, I recommend shipping the winning variant. It beat control on the primary metric and the guardrail metrics held. I can walk your team through it Thursday if useful.' },

      { id: 'dana', kind: 'entity', entity: 'person', state: 'triage', title: 'Dana in Slack and Dana Reyes in email', source: 'Entity check', who: '',
        age: '2 days', stage: 'settling', mins: 1, energy: 'low',
        meta: 'Slack and email · seen 4 times this week',
        incoming: 'Two people named Dana keep showing up around the offsite budget. If they are one person, Fuzz can combine their history and match tasks more reliably.',
        ask: 'Is Dana in Slack the same person as Dana Reyes in email?',
        aiHeading: 'Why Fuzz asked', aiNote: 'Both appear in threads about the offsite budget and share a first name. The Slack profile and the email address have no visible link, so I cannot tell for sure.',
        effect: 'If yes, the two profiles merge and three open tasks are linked. If no, they stay separate and I stop asking about the name Dana.',
        boxLabel: 'Anything that helps?', placeholder: 'For example: Dana Reyes is on the finance team.',
        primary: 'Same person', secondary: 'Different people',
        profiles: [{ where: 'Slack', name: 'Dana', detail: 'Display name only, active in #offsite-planning.', seen: '3 mentions this week' }, { where: 'Email', name: 'Dana Reyes', detail: 'Finance team, on the offsite budget thread.', seen: '1 thread this week' }],
        answers: { primary: 'Merged the two profiles. Next one.', secondary: 'Kept them separate. Next one.' } },

      { id: 'naming', kind: 'task', state: 'triage', title: 'Update the experiment naming guide', source: 'Meeting', who: 'Team retro',
        age: '9 days', stage: 'stale', mins: 20, energy: 'normal',
        incoming: 'In the team retro you said you would refresh the naming guide so new experiments follow one pattern.',
        ask: 'Does this still matter, or can it go?',
        hint: 'Update the guide with the three naming rules from the retro and share it in #experimentation.',
        aiHeading: 'What Fuzz noticed', aiNote: 'Nothing new has come up about this since the retro, and nobody has asked about it. It may have quietly stopped mattering.',
        firstStep: 'Open the guide and add one line for the first rule.',
        log: [L('action', '9 days ago', 'Pulled this task out of the retro notes.')],
        sources: [{ type: 'Doc', title: 'Retro notes' }, { type: 'Doc', title: 'Current naming guide' }] },

      { id: 'owner', kind: 'task', state: 'triage', title: 'Confirm who owns the dashboard filter bug', source: 'Slack', who: 'Jules',
        age: '3 hours', stage: 'fresh', mins: 2, energy: 'low',
        incoming: 'Two people reported that saved filters reset after a refresh, and nobody has said who is picking it up.',
        ask: 'Should this go to the team lead or to the last contributor?',
        hint: 'Ask the last contributor if they can take it, and tag me if nobody answers by tomorrow.',
        aiHeading: 'What Fuzz did', aiNote: 'I found the open ticket and the code that resets the filters. `onRefresh()` replaces `state.filters` with the defaults. I also found the last three people who touched that component.',
        firstStep: 'Open the ticket and read who commented last.',
        log: [L('research', '11:05 AM', 'Found the open ticket and the last three people who touched the filter component.')],
        sources: [{ type: 'Ticket', title: 'Saved filters reset after refresh' }, { type: 'Slack', title: 'Thread in #dashboards' }],
        script: { steps: [['research', 'Looked at who touched the filter component in the last month.'], ['research', 'Read the ticket and its two comments.']],
          ending: { type: 'handback', ask: 'Two people touched this component most recently, Ines on the team and Tomas on contract. I can’t tell which of them owns the filter code now. Who should I ask?', hint: 'Tag me if nobody answers by tomorrow.', quick: [{ label: 'Ask Ines', instr: 'Ask Ines whether she owns the filter code and can take the bug. Tag me if she doesn’t answer by tomorrow.' }, { label: 'Ask Tomas', instr: 'Ask Tomas whether he owns the filter code and can take the bug. Tag me if he doesn’t answer by tomorrow.' }], log: 'Could not tell which of the two recent contributors owns the filter code, so I handed this back.' } } },

      { id: 'dup', kind: 'dup', state: 'triage', dupOf: 'readout', title: 'Send Priya the Q4 summary deck', source: 'Slack', who: 'Priya Raman',
        age: '1 hour', stage: 'fresh', mins: 1, energy: 'low',
        meta: '',
        incoming: 'In Slack, Priya asked for the Q4 summary deck so she can brief her team. It looks close to the email you already have in this queue.',
        ask: 'Is this the same task as “Reply to Priya about the Q4 experiment readout”?',
        aiHeading: 'Why Fuzz thinks so', aiNote: 'Same person, same Q4 results doc, two hours apart. The judge said same task with medium confidence, so I kept both and linked them instead of merging.',
        effect: 'If merged, the Slack message attaches as another source on the email task and nothing is lost. You can split them again anytime.',
        boxLabel: 'Anything that helps?', placeholder: 'Optional note.',
        primary: 'Merge', secondary: 'Keep separate',
        answers: { primary: 'Merged. The Slack message is now a source on the Priya task.', secondary: 'Kept separate, and linked so Fuzz won’t ask again.' } },

      { id: 'lantern', kind: 'entity', entity: 'term', state: 'triage', title: 'Project Lantern', source: 'Entity check', who: '',
        age: '3 days', stage: 'settling', mins: 1, energy: 'low',
        meta: 'Slack, meetings and email · seen 5 times this week',
        incoming: 'The name keeps appearing in messages, but there is no project, document or term in your notes with that name yet.',
        ask: 'What should I call Project Lantern in your notes?',
        aiHeading: 'Why Fuzz asked', aiNote: 'Three messages call it a launch and two call it a review. The suggested definition is my best guess from the report builder threads, so please correct it.',
        effect: 'It becomes a project page that tasks, people and documents can link to, and Fuzz uses your definition in working sessions.',
        boxLabel: 'What is it?', placeholder: 'A short definition.', hint: 'The relaunch of the report builder for enterprise customers.',
        primary: 'Save definition', secondary: 'Same as an existing project',
        mentions: [{ where: 'Slack', text: '“Lantern slips if the performance fix slips.”' }, { where: 'Meeting', text: '“Lantern review moves to the 28th.”' }, { where: 'Email', text: '“Can you share the Lantern one-pager?”' }],
        answers: { primary: 'Saved to your notes. Next one.', secondary: 'Linked to an existing project. Next one.' } },

      { id: 'quotes', kind: 'task', state: 'triage', title: 'Collect customer quotes for the board update', source: 'Slack', who: 'Marcus',
        age: '1 day', stage: 'settling', mins: 15, energy: 'high',
        incoming: 'A long thread of customer comments about the new report builder. Marcus asked for three quotes that tell the story for the board.',
        ask: 'Which themes should the quotes lead with?',
        hint: 'Lead with the report builder themes and keep every quote linked to its source.',
        aiHeading: 'What Fuzz did', aiNote: 'I grouped the comments into themes and kept the original links so you can check them.',
        firstStep: 'Skim the three theme headings I grouped.',
        log: [L('research', 'Yesterday', 'Grouped 48 comments into five draft themes.')],
        sources: [{ type: 'Slack', title: '#report-builder customer thread' }] },

      { id: 'agenda', kind: 'task', state: 'triage', handedBack: true, title: 'Draft the agenda for the roadmap sync', source: 'Meeting', who: 'Roadmap kickoff',
        age: '2 days', stage: 'settling', mins: 10, energy: 'normal',
        due: { label: 'The sync is next Wednesday', left: 'Plenty of time', frac: 0.75 },
        meta: 'Meeting · handed back 20 min ago',
        incoming: 'During the kickoff you said you would send an agenda for next week’s roadmap sync.',
        ask: 'Is this for the leads only, or for the whole team?',
        hint: 'Use last week’s format and keep it to 45 minutes.',
        aiHeading: 'Why Fuzz handed this back', aiNote: 'I collected the last three agendas and seven open items from your notes, but I can’t tell who the audience is, and that changes what belongs on the page.',
        askBack: 'Lost the signal. Who’s the audience: leads only, or the whole team?',
        quick: [{ label: 'Leads only', instr: 'This is for the leads only. Use the shorter outline, last week’s format, and keep it to 45 minutes.' },
          { label: 'Whole team', instr: 'This is for the whole team. Use the fuller outline, last week’s format, and keep it to 45 minutes.',
            set: { sendTo: { to: 'the whole team', via: 'Email' }, draft: 'Roadmap sync agenda, whole team, 45 minutes: 1) Where the roadmap stands (10 min), 2) Report builder launch (10 min), 3) Q1 priorities and what they mean for each team (15 min), 4) Questions (10 min).' } }],
        firstStep: 'Pick the outline that matches the audience.',
        conversation: [
          { who: 'You', time: 'Yesterday, 4:10 PM', text: 'Draft an agenda for next week’s roadmap sync. Pull from my kickoff notes.' },
          { who: 'Fuzz', time: 'Yesterday, 4:12 PM', text: 'I found seven open items in your notes. Should I follow the format from last week’s agenda?' },
          { who: 'You', time: 'Yesterday, 4:20 PM', text: 'Yes, same format. Keep it to 45 minutes.' },
          { who: 'Fuzz', time: 'Today, 3:00 PM', text: 'I drafted two outlines, one for the leads and one for the whole team. I can’t tell who the audience is, so I am handing this back to you.' }],
        log: [
          L('status', '3:00 PM', 'Handed back to you. It joined the end of your queue.'),
          L('action', '3:00 PM', 'Wrote two draft outlines, one for leads and one for the full team.'),
          L('blocked', '2:58 PM', 'Could not find who is invited. The calendar invite has no attendee list, so the audience is unclear.'),
          L('action', '2:55 PM', 'Fit both outlines to the 45-minute length you asked for.'),
          L('guidance', 'Yesterday, 4:20 PM', 'You said: use the same format and keep it to 45 minutes.'),
          L('research', 'Yesterday, 4:12 PM', 'Found seven open items in the kickoff notes.'),
          L('research', 'Yesterday, 4:11 PM', 'Reviewed the last three roadmap agendas.'),
          L('status', 'Yesterday, 4:10 PM', 'You assigned this to Fuzz.')],
        sources: [{ type: 'Doc', title: 'Roadmap kickoff notes' }, { type: 'Doc', title: 'Last week’s roadmap sync agenda' }, { type: 'Calendar', title: 'Roadmap sync invite' }],
        sendTo: { to: 'the roadmap leads', via: 'Email' },
        draft: 'Roadmap sync agenda, leads only, 45 minutes: 1) Q1 priorities (10 min), 2) Report builder launch (10 min), 3) Staffing (10 min), 4) Risks (10 min), 5) Decisions and owners (5 min).' },

      { id: 'renewal', kind: 'task', state: 'triage', handedBack: true, title: 'Follow up on the vendor contract renewal', source: 'Email', who: 'Vendor account team',
        age: '3 days', stage: 'settling', mins: 5, energy: 'normal',
        meta: 'Email · handed back 1 hour ago',
        incoming: 'The vendor asked whether you plan to renew, and mentioned a deadline without giving the date.',
        ask: 'Do you know where the contract lives, or should Fuzz ask the vendor?',
        hint: 'Hold off on any commitment until we know the renewal date and terms.',
        aiHeading: 'Why Fuzz handed this back', aiNote: 'I searched your inbox and shared files but could not find the renewal date or the current terms.',
        askBack: 'Lost the signal. I can’t find the renewal terms. Where does the contract live?',
        quick: [{ label: 'I’ll find it', mine: true, instr: 'I’ll find the contract myself.' }, { label: 'Ask the vendor', instr: 'Ask the vendor for the renewal date and current terms, and hold off on any commitment.' }],
        firstStep: 'Check the “Contracts” folder for a signed copy.',
        log: [L('blocked', '1 hour ago', 'Searched the inbox and shared files. No renewal date or current terms found.'), L('status', '1 hour ago', 'Handed back to you. It joined the end of your queue.')],
        sources: [{ type: 'Email', title: 'Vendor: are you planning to renew?' }] },

      /* ---------- Current (already in motion) ---------- */
      { id: 'retro', kind: 'task', state: 'review', title: 'Send the Q3 retro summary to the team', source: 'Email', who: 'Team retro', age: '2 hours', stage: 'fresh', mins: 3,
        now: 'Draft ready to review',
        incoming: 'You said you would send the team a short summary of the Q3 retro by end of week.',
        aiNote: 'The draft is written. It will not send until you approve it.',
        log: [L('action', '2:52 PM', 'Drafted a short summary with the three actions the team agreed on.'), L('research', '2:47 PM', 'Read the retro notes and the action list.'), L('status', '2:40 PM', 'You assigned this to Fuzz from triage.')],
        sources: [{ type: 'Doc', title: 'Q3 retro notes' }],
        sendTo: { to: 'the team', via: 'Email' },
        draft: 'Hi team, thanks for a good retro. Three things we agreed on: 1) shorten the weekly sync to 25 minutes, 2) write down experiment decisions in one doc, 3) rotate who runs the demo. I will follow up on owners Monday.' },
      { id: 'feedback', kind: 'task', state: 'ai', title: 'Summarize the customer feedback thread', source: 'Slack', who: 'Marcus', age: '1 day', stage: 'settling', mins: 15,
        now: 'Grouping 48 comments into themes',
        incoming: 'A long Slack thread of customer comments about the new report builder. Marcus asked for the three themes that matter most.',
        aiNote: 'Grouping 48 comments into themes and keeping a link to every quote so you can check them.',
        doneNote: 'Grouped all 48 comments into three themes, each with three linked quotes you can check.',
        log: [L('action', '3:10 PM', 'Sorted 31 of 48 comments into five draft themes.'), L('research', '2:58 PM', 'Read the full thread and two linked support tickets.'), L('status', '2:55 PM', 'You assigned this to Fuzz from triage.')],
        sources: [{ type: 'Slack', title: '#report-builder thread' }, { type: 'Ticket', title: 'Support ticket 4821' }],
        script: { steps: [['action', 'Sorted the remaining 17 comments into themes.'], ['research', 'Matched each theme to the strongest three quotes.']], ending: { type: 'review' } },
        sendTo: { to: 'Marcus', via: 'Slack, #report-builder' },
        draft: 'Top themes: 1) Large tables load slowly, 2) Scheduled exports are confusing, 3) Customers want shareable views. Each has three linked quotes.' },
      { id: 'spike', kind: 'task', state: 'ai', title: 'Look into the experiment dashboard spike', source: 'Parked thought', who: 'You', age: '10 minutes', stage: 'fresh', mins: 10,
        now: 'Checking this morning’s event logs',
        incoming: 'You parked a thought about a weird spike on the experiment dashboard this morning, and handed it to Fuzz.',
        aiNote: 'Checking this morning’s event logs for a tracking change. I found one: `track()` sends `page_view` twice since the 8:02 AM deploy. It will only bother you if the spike is real.',
        doneNote: 'Matched the spike to the 8:02 AM tracking deploy: `track()` sent `page_view` twice for about 40 minutes. It isn’t real traffic.',
        log: [L('research', '3:15 PM', 'Found a deploy to the tracking library at 8:02 AM.'), L('research', '3:08 PM', 'Compared today’s traffic with the last four Saturdays.'), L('status', '3:05 PM', 'Assigned to Fuzz from your parked thoughts.')],
        sources: [{ type: 'Doc', title: 'Experiment dashboard' }, { type: 'Doc', title: 'Deploy log' }],
        script: { steps: [['research', 'Confirmed the spike lines up with the tracking deploy.']], ending: { type: 'review' } },
        draft: 'The spike is a tracking artifact. A deploy at 8:02 AM double-counted page views for about 40 minutes. No real traffic change. I suggest no action.' },
      { id: 'pricing', kind: 'task', state: 'session', title: 'Decide the pricing page copy', source: 'Email', who: 'Nadia', age: '4 hours', stage: 'fresh', mins: 20,
        now: 'Choosing between two headlines',
        incoming: 'Nadia needs final copy for the pricing page and sent two headline options.',
        aiNote: 'You opened this in Claude. Fuzz keeps the email thread and the style guide open while you work.',
        log: [L('status', '1:10 PM', 'You opened this in a working session with Claude.'), L('research', '1:08 PM', 'Gathered both headline options and the style guide.')],
        sources: [{ type: 'Email', title: 'Nadia: pricing page copy' }, { type: 'Doc', title: 'Style guide' }] },
      { id: 'sam', kind: 'task', state: 'scheduled', title: 'Find time with Sam for 1:1 prep', source: 'Meeting', who: 'Staff sync', age: '1 day', stage: 'settling', mins: 5,
        scheduledFor: 'tomorrow morning', now: 'Back tomorrow morning',
        incoming: 'In the weekly staff sync you said you would find thirty minutes with Sam before the planning review.',
        aiNote: 'Comes back tomorrow morning. Fuzz already found three open windows on both calendars.',
        log: [L('research', 'Yesterday', 'Found three shared open windows before the review.'), L('status', 'Yesterday', 'You scheduled this for tomorrow morning.')],
        sources: [{ type: 'Doc', title: 'Staff sync notes' }, { type: 'Calendar', title: 'Sam’s calendar' }] },
      { id: 'registration', kind: 'task', state: 'scheduled', title: 'Renew the car registration', source: 'Captured by you', who: 'You', age: '2 days', stage: 'settling', mins: 10,
        scheduledFor: 'when you’re back at your desk', now: 'Back when you’re at your desk',
        incoming: 'You captured this yourself. The registration renewal notice is due at the end of the month.',
        aiNote: 'Comes back the next time you are at your desk, since it needs the renewal form.',
        log: [L('status', '2 days ago', 'You scheduled this for when you are at your desk.'), L('status', '2 days ago', 'You captured this task.')],
        sources: [{ type: 'Note', title: 'Renewal notice' }] },

      /* ---------- Parked ---------- */
      { id: 'glossary', kind: 'task', state: 'parked', woke: true, title: 'Explore a shared metrics glossary', source: 'Slack', who: 'Analytics', age: '6 days', stage: 'settling', parkedAgo: '6 days ago',
        now: 'Marcus asked about it in #analytics today',
        incoming: 'An idea from Slack to build one shared glossary of metric names with the analytics team.',
        aiNote: 'Marcus asked about a shared glossary in #analytics this morning, so this may matter again.',
        log: [L('status', 'Today', 'Noticed a new mention by Marcus in #analytics.'), L('status', '6 days ago', 'You parked this from triage.')],
        sources: [{ type: 'Slack', title: '#analytics thread' }] },
      { id: 'drive', kind: 'task', state: 'parked', title: 'Tidy the shared drive folders', source: 'Meeting', who: 'Team retro', age: '4 days', stage: 'settling', parkedAgo: 'Today', now: '',
        incoming: 'In the retro someone said the shared drive has become hard to navigate, and you offered to look at it.',
        aiNote: 'Nothing new has come up since the retro. Fuzz will speak up if anyone asks about it.',
        log: [L('status', 'Today', 'You parked this from triage.'), L('action', '4 days ago', 'Pulled this task out of the retro notes.')],
        sources: [{ type: 'Doc', title: 'Retro notes' }] },
      { id: 'pricingtiers', kind: 'task', state: 'parked', title: 'Review the vendor’s new pricing tiers', source: 'Email', who: 'Vendor', age: '3 days', stage: 'settling', parkedAgo: '3 days ago', now: '',
        incoming: 'The vendor emailed new pricing tiers that take effect next quarter.',
        aiNote: 'No action is needed before renewal. Fuzz linked this to the open renewal question.',
        log: [L('status', '3 days ago', 'You parked this from triage.'), L('action', '3 days ago', 'Linked it to the vendor renewal task.')],
        sources: [{ type: 'Email', title: 'Vendor pricing email' }] },
      { id: 'calculator', kind: 'task', state: 'parked', title: 'Write up the test power calculator idea', source: 'Captured by you', who: 'You', age: '2 weeks', stage: 'settling', parkedAgo: '2 weeks ago', now: '',
        incoming: 'You captured an idea for a small calculator that shows how long a test needs to run.',
        aiNote: 'Parked with no date. Fuzz has not done any work on it.',
        log: [L('status', '2 weeks ago', 'You parked this right after capturing it.')],
        sources: [{ type: 'Note', title: 'Your capture note' }] },

      /* ---------- Waiting on others ---------- */
      { id: 'budget', kind: 'task', state: 'waiting', title: 'Approval of the offsite budget', source: 'Email', who: 'Dana Reyes', waitingOn: 'Dana Reyes', waitedFor: '4 days', age: '4 days', stage: 'settling',
        nextCheck: 'Nudge drafted, needs your OK', nudge: true,
        incoming: 'You asked Dana Reyes on Tuesday to approve the offsite budget so you can book the venue.',
        aiNote: 'A short, friendly follow-up is drafted. It will not send until you approve it.',
        log: [L('action', 'Today', 'Drafted a follow-up nudge for your review.'), L('research', 'Thursday', 'Checked for a reply. Nothing yet.'), L('status', 'Tuesday', 'You moved this to Waiting on others.')],
        sources: [{ type: 'Email', title: 'Budget email thread' }, { type: 'Doc', title: 'Offsite budget sheet' }],
        sendTo: { to: 'Dana Reyes', via: 'Email' },
        draft: 'Hi Dana, a gentle nudge on the offsite budget. I would like to book the venue by Friday, and your approval is the last step. Thanks!' },
      { id: 'estimate', kind: 'task', state: 'waiting', title: 'Engineering estimate on the performance fix', source: 'Slack', who: 'Elena', waitingOn: 'Elena', waitedFor: '2 days', age: '2 days', stage: 'settling',
        nextCheck: 'Tomorrow morning',
        incoming: 'You asked Elena for the engineering estimate on the performance fix, which decides the launch date.',
        aiNote: 'Fuzz looks at the ticket again tomorrow morning and drafts a nudge if nothing has moved.',
        log: [L('research', 'Today', 'Checked the ticket. No new estimate.'), L('status', '2 days ago', 'You moved this to Waiting on others.')],
        sources: [{ type: 'Slack', title: '#report-builder thread' }, { type: 'Ticket', title: 'Performance ticket' }] },
      { id: 'catering', kind: 'task', state: 'waiting', title: 'Quote for the offsite catering', source: 'Email', who: 'Caterer', waitingOn: 'The caterer', waitedFor: '1 day', age: '1 day', stage: 'fresh',
        nextCheck: 'Monday',
        incoming: 'You asked the caterer for a quote and the dietary options for sixteen people.',
        aiNote: 'Fuzz drafts a nudge on Monday if there is no reply.',
        log: [L('status', 'Yesterday', 'Sent your question to the catering team.'), L('status', 'Yesterday', 'You moved this to Waiting on others.')],
        sources: [{ type: 'Email', title: 'Catering email thread' }] },

      /* ---------- Done and let go ---------- */
      { id: 'venue', kind: 'task', state: 'done', title: 'Send the offsite agenda to the venue', source: 'Email', who: 'Venue', age: '2 days', stage: 'fresh', doneAgo: 'Yesterday', now: 'Sent with your OK',
        incoming: 'The venue asked for the agenda so they can plan the room layout.',
        aiNote: 'Done. Fuzz sent the agenda after you approved the draft.',
        log: [L('sent', 'Yesterday', 'Sent the agenda to the venue after you approved the draft.'), L('action', 'Yesterday', 'Drafted the cover note.'), L('status', '2 days ago', 'You assigned this to Fuzz.')],
        sources: [{ type: 'Email', title: 'Venue: agenda request' }] },
      { id: 'desk', kind: 'task', state: 'letgo', title: 'Look into a standing desk', source: 'Captured by you', who: 'You', age: '3 weeks', stage: 'stale', doneAgo: '3 days ago', now: 'Let go after sitting for three weeks',
        incoming: 'You captured a note to look into standing desks.',
        aiNote: 'You let this go. Bring it back anytime and Fuzz will pick up from the note.',
        log: [L('status', '3 days ago', 'You let this go.'), L('status', '3 weeks ago', 'You captured this task.')],
        sources: [{ type: 'Note', title: 'Your capture note' }] }
    ];

    items.forEach(function (it, i) {
      it.order = i;
      if (it.dueMin) it.dueAt = now + it.dueMin * 60000;
      it.log = it.log || [];
      it.sources = it.sources || [];
      it.context = it.context || [];
      it.code = CODE[it.id] || [];
      it.conversation = it.conversation || [];
    });

    return {
      items: items,
      queue: items.filter(function (i) { return i.state === 'triage'; }).map(function (i) { return i.id; }),
      totalEver: items.filter(function (i) { return i.state === 'triage'; }).length,
      captured: [
        { text: 'Ask Dana about the offsite budget', ref: null, status: 'Waiting in triage', time: '10 minutes ago', tone: 'wait' },
        { text: 'Planning review notes.docx', ref: null, status: 'Three tasks added to triage', time: '2 hours ago', tone: 'fresh', doc: true },
        { text: 'Look into why the staging build is slow', ref: null, status: 'Fuzz is working on it', time: '1 hour ago', tone: 'accent' },
        { text: 'Renew the car registration', ref: 'registration', status: 'Scheduled', time: 'Yesterday', tone: 'wait' }
      ]
    };
  }

  window.Demo = { build: build, L: L };
})();
