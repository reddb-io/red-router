import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { installCatalogSource } from "../../open-sse/providers/catalogOverride.js";
import registry from "../../open-sse/providers/registry/index.js";

const DEF_CTX = 200000, DEF_OUT = 64000;

function audit(label) {
  let total = 0, realCtx = 0, realOut = 0, both = 0;
  const miss = {};
  for (const p of registry) {
    for (const m of p.models || []) {
      if (m.type || m.kind) continue; // LLM only (image/tts/embedding have kind caps)
      total++;
      const caps = getCapabilitiesForModel(p.id, m.id);
      const rc = caps.contextWindow !== DEF_CTX, ro = caps.maxOutput !== DEF_OUT;
      if (rc) realCtx++;
      if (ro) realOut++;
      if (rc && ro) both++;
      else (miss[p.id] ||= []).push(m.id);
    }
  }
  const pct = (x) => `${x}/${total} (${Math.round(100 * x / total)}%)`;
  console.log(`\n[${label}] LLM models: ${total}`);
  console.log(`  context_length real:  ${pct(realCtx)}`);
  console.log(`  max_completion real:  ${pct(realOut)}`);
  console.log(`  both real:            ${pct(both)}`);
  const providers = Object.entries(miss).sort((a, b) => b[1].length - a[1].length);
  for (const [p, ids] of providers.slice(0, 10)) {
    console.log(`  default-guess: ${p} (${ids.length}) e.g. ${ids.slice(0, 3).join(", ")}`);
  }
}

audit("A) static tables only (offline worst case)");
await installCatalogSource();
audit("B) + vendored models.dev snapshot (runtime, seeded by PR #3)");
