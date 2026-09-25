---
"@reddb-io/red-router": patch
---

The OpenRouter model browser now finds every OpenRouter model, including TypeSafe's `typesafe/jev-1.13`. It used to ask OpenRouter for its default list, which only has text-generating models, so image, audio and decision models never showed up (about 165 models).

Decision models like JEV don't answer chat. They return a typed choice through `/v1/systemone`. The browser marks them **System One** and links to where they work (Tools Providers → System One), instead of offering to add them as chat models. Image and audio generators stay on their media pages.
