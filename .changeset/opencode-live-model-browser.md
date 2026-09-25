---
"@reddb-io/red-router": patch
---

The OpenCode Zen and OpenCode Go provider pages now list the models OpenCode serves today. The model browser reads OpenCode's live `/models` lists, the same ones routing already fetches and caches, instead of models.dev's copy. So JEV 1.13 and JEV 1.13 Free show on the OpenCode Zen page with the System One badge, and models OpenCode has retired no longer show. models.dev and RedRouter's built-in list still supply names, prices and limits. The last list is saved to disk. Without network the browser shows that saved list, or RedRouter's built-in list, and the source line says which one it's showing.
