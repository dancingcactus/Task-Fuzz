/* Demo artifacts: files Fuzz "wrote" in its folder, one of each kind the viewer previews. The files live in
   assets/samples/; task is the demo task (js/data.js) each belongs to, and taskTitle its title for the viewer. Live mode lists the real ones (GET /artifacts). */
(function () {
  var MIN = 60000, now = Date.now();
  window.Samples = [
    { id: 'feedback-md', name: 'Customer feedback themes.md', kind: 'markdown', mime: 'text/markdown', size: 937, task: 'feedback', taskTitle: 'Summarize the customer feedback thread', updated: now - 6 * MIN },
    { id: 'readout-pptx', name: 'Q4 readout.pptx', kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 36108, task: 'readout', taskTitle: 'Reply to Priya about the Q4 experiment readout', updated: now - 40 * MIN },
    { id: 'retro-docx', name: 'Q3 retro summary.docx', kind: 'word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 37328, task: 'retro', taskTitle: 'Send the Q3 retro summary to the team', updated: now - 2 * 60 * MIN },
    { id: 'budget-csv', name: 'Offsite budget.csv', kind: 'table', mime: 'text/csv', size: 295, task: 'budget', taskTitle: 'Approval of the offsite budget', updated: now - 26 * 60 * MIN },
    { id: 'agenda-pdf', name: 'Offsite agenda.pdf', kind: 'pdf', mime: 'application/pdf', size: 2265, task: 'venue', taskTitle: 'Send the offsite agenda to the venue', updated: now - 30 * 60 * MIN }
  ].map(function (s) { s.path = 'assets/samples/' + encodeURIComponent(s.name); s.url = 'artifact.html?demo=' + s.id; return s; });
})();
