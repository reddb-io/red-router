---
"@reddb-io/red-router": patch
---

The Combos page header is now one row of same-size actions (`Client presets`, `Create Combo`, `Recommended setup`) and a card for each of the five strategies. Before, it had four stacked buttons in two sizes over a wall of text that covered only three strategies.

- Cursor Default and Claude Default moved into the `Client presets` menu, each with a one-line description.
- Smart and Auto now appear next to Fallback, Round Robin and Fusion.
- The longer explanations moved to where they apply: the Recommended setup modal says what it builds and that re-running updates instead of duplicating; the Cursor Default confirmation carries the Cursor IDE custom-model note.
- The empty state no longer repeats the header's buttons.
- The page subtitle no longer says "with fallback" only.
