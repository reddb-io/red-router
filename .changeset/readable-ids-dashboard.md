---
"@reddb-io/red-router": minor
---

The dashboard now shows and saves readable model ids (`codex/gpt-5.5`, `opencode-go/glm-5.3-flash`, `claude-code/claude-opus-5`) instead of short codes (`cx/`, `ocg/`, `cc/`). `/v1/models` already listed them this way.

Where it changes:
- the provider page: the copy button, and the alias target;
- the model picker for combos, CLI tools and the decision router;
- the combos list;
- the media and tools cards and their examples;
- the defaults and examples for CLI tools and API key policies.

Saved references in either form keep working: short codes still route, and the picker recognizes `cx/x` and `codex/x` as the same model. When you edit a combo, its members switch to the readable form. Custom models, aliases and disabled models keep their internal storage key, so no data migration is needed.
