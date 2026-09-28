// Verifica la configurazione OmniRoute: raggiungibilità, modelli per ruolo, output JSON strutturato e latenza.
// Uso: npm run llm:check
import { z } from 'zod';
import { AGENT_ROLES, llmDefaults } from '../config.js';
import { extractJson, OpenAiCompatProvider } from '../agents/llm-client.js';

const base = process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1';
const key = process.env.LLM_API_KEY;
const cfg = llmDefaults();
console.log(`OmniRoute: ${base}${key ? ' (con API key)' : ''}`);

let available: string[] = [];
try {
  const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  available = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  console.log(`✓ raggiungibile, ${available.length} modelli/combo esposti`);
} catch (e) {
  console.error(`✗ OmniRoute non raggiungibile: ${(e as Error).message}. Avvialo o imposta LLM_BASE_URL.`);
  process.exit(1);
}

const Probe = z.object({ ok: z.boolean(), fazione: z.string() });
const provider = new OpenAiCompatProvider(base, key);
let failures = 0;
for (const model of [...new Set(Object.values(cfg).map((c) => c.model))]) {
  const roles = AGENT_ROLES.filter((r) => cfg[r].model === model).join(', ');
  if (model === 'default') { console.warn(`! nessun modello configurato per: ${roles} (imposta LLM_MODEL o LLM_MODEL_<RUOLO>)`); failures++; continue; }
  if (available.length && !available.includes(model)) console.warn(`! "${model}" non è nell'elenco /models (ok se è un alias risolto da OmniRoute)`);
  try {
    const r = await provider.complete({
      role: 'repair', model, temperature: 0, maxTokens: 100, timeoutMs: cfg.faction_major.timeoutMs, schemaName: 'Probe', jsonSchema: z.toJSONSchema(Probe) as Record<string, unknown>, meta: {},
      system: 'Rispondi SOLO con JSON.', user: 'Restituisci {"ok": true, "fazione": "ITA"}',
    });
    const valid = Probe.safeParse(extractJson(r.text)).success;
    console.log(`${valid ? '✓' : '✗'} ${model} [${roles}] ${r.latencyMs} ms, token ${r.usage.promptTokens}+${r.usage.completionTokens}${valid ? '' : ` — JSON non valido: ${r.text.slice(0, 120)}`}`);
    if (!valid) failures++;
  } catch (e) {
    console.error(`✗ ${model} [${roles}]: ${(e as Error).message}`);
    failures++;
  }
}
process.exit(failures ? 1 : 0);
