---
"@reddb-io/red-router": minor
---

The dashboard shell now follows the RedDB design system: a narrow **side rail** with one icon per area (Home, Proxy, Optimize, Agents, Observe, Tools, System) next to a **side panel** listing that area's entries, built on the design system's `sidebar-rail`, `sidebar-navigation`, `nav-item` and `tabs` contracts (vendored and hash-locked). Pick an area on the rail to browse it without leaving the page; pick the current area, or use the panel button, to open and close the panel. The panel is wider (288 px by default, 240–480 px by dragging its edge, double-click resets) and remembers its width and whether it was open.

Icons in the shell are lucide glyphs through a new `Icon` wrapper that mirrors the design system's: one neutral ink (muted at rest, foreground when current), the design system's sizes, no per-icon colours. The rainbow accent map is gone, and so are the amber and red Restart/Shutdown buttons (they are plain rail buttons; the confirmation keeps the danger style). A ratchet test now stops new Material Symbols from being added while the rest of the app moves to lucide.

Hierarchy: Quota now sits with Providers, Integrations with Observe, "Build" became "Tools", and Labs (Chaos mode, Gamification, Batch) is a group under System. Token saver's 16 tabs are seven — Overview, Engines, Combos, Studio, Exclusions, Live, Analytics — with a new Engines page (a card per compression engine linking to its page), and Settings keeps seven tabs with the rest under "More".
