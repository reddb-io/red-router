---
"@reddb-io/red-router": minor
---

**Every page lines up, and a new Console Log.**

- **One page width.** Every dashboard page now starts at the same left edge and has the same width. Before, Usage, Setup, Settings, CLI Tools and Proxy Pools each set their own narrower, centred width, and pages shifted a few pixels depending on whether they scrolled.
- **Settings uses the width.** Its cards flow into two columns on wide screens instead of a narrow strip in the middle.
- **Console Log, rebuilt:**
  - Live tail that follows new lines. Scrolling up pauses it, and "N new" brings you back.
  - Filter by text or `/regex/`, with matches highlighted, and toggle levels (info, warn, error, debug) with counts.
  - Timestamps and line wrapping can be turned on or off; these choices are remembered in your browser.
  - Copy or download what is shown, and clear the console.
  - The server now keeps the last 2,000 lines (it was 200), each with its time and level.
