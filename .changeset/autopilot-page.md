---
"@reddb-io/red-router": minor
---

**Autopilot gets its own page, in plain words.** The decision-model settings that sat at the bottom of Routing Combos ("Intelligent routing") now live at Operate → Autopilot, reorganized around what each one does:

- **Two sections:** "Pick the model for each turn" (the decision router) and "Adjust how hard the model thinks" (the reasoning autopilot).
- **A summary line:** each section says in one sentence what it is doing right now with your settings.
- **Clearer modes:** they read Off / Test run / On. Test run is the old "Shadow": it decides and logs, and changes nothing.
- **Plainer controls:**
  - "How often it switches" (Rarely / Sometimes / Often) replaces "How decisive";
  - the reasoning floor and ceiling become one range ("Between low and high");
  - "Applies to" is Every request, or Chosen keys and combos.
- **Keys:** API keys are picked with the paginated search.
- **Tucked away:** thresholds, gateway and decision model stay under Advanced, and the per-request header is a note for developers.

The Combos page keeps a short card showing both statuses, with a link to configure them.
