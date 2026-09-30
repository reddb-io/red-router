---
"@reddb-io/red-router": patch
---

Editing a connection is easier.

- **The destination is editable.** A RedRouter connection now always shows its Base URL in the edit window (it used to hide behind an "Advanced" link), so a host or IP that changed can be corrected. The Add form shows it too, prefilled with `http://127.0.0.1:25050/v1`.
- **A bigger edit window.** The edit window is about twice as wide and scrolls as one piece.
- **Real field text.** The group tag, routing tags and excluded models fields had placeholder labels ("Tag Group Label", "Tag Group Hint"); they now say what they do.
- **RedRouter provider.** Its link points to `github.com/reddb-io/red-router` (it was `reddb.io`), and it has its own icon instead of a broken image.
