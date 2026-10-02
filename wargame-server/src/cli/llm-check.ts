// Verifica la configurazione dei modelli: raggiungibilità, modelli per ruolo, output JSON strutturato e latenza.
// Senza profilo: l'endpoint unico (OmniRoute, LLM_BASE_URL) con il modello di ogni ruolo. Con LLM_PROFILE: ogni modello di ogni endpoint del
// profilo (principali e ripiego), con le richieste al minuto dichiarate. Uso: npm run llm:check
import { z } from 'zod';
import { AGENT_ROLES, llmDefaults } from '../config.js';
import { extractJson, OpenAiCompatProvider, RateLimitError, type LlmProvider } from '../agents/llm-client.js';
import { loadProfile, profileRouting, roleChain } from '../agents/profiles.js';

const Probe = z.object({ ok: z.boolean(), fazione: z.string() });
const cfg = llmDefaults();
const profile = loadProfile();

/** Modelli elencati da {base}/models: `names` null se il server risponde ma non li elenca, `ok` falso se non risponde. */
async function listed(base: string, key: string | undefined): Promise<{ ok: boolean; names: string[] | null }> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
    if (res.status === 404 || res.status === 405) return { ok: true, names: null };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { id: string }[]; models?: { name?: string }[] };
    return { ok: true, names: j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name ?? '') ?? null };
  } catch (e) {
    console.error(`✗ ${base} non raggiungibile: ${(e as Error).message}. Avvialo o controlla LLM_BASE_URL / il profilo.`);
    return { ok: false, names: null };
  }
}

async function probe(provider: LlmProvider, model: string, roles: string, timeoutMs: number, extra = ''): Promise<boolean> {
  try {
    const r = await provider.complete({
      role: 'repair', model, temperature: 0, maxTokens: 100, timeoutMs, schemaName: 'Probe', jsonSchema: z.toJSONSchema(Probe) as Record<string, unknown>, meta: {},
      system: 'Rispondi SOLO con JSON.', user: 'Restituisci {"ok": true, "fazione": "ITA"}',
    });
    const valid = Probe.safeParse(extractJson(r.text)).success;
    console.log(`${valid ? '✓' : '✗'} ${model} [${roles}]${extra} ${r.latencyMs} ms, token ${r.usage.promptTokens}+${r.usage.completionTokens}${valid ? '' : ` — JSON non valido: ${r.text.slice(0, 120)}`}`);
    return valid;
  } catch (e) {
    console.error(`${e instanceof RateLimitError ? '!' : '✗'} ${model} [${roles}]${extra}: ${(e as Error).message}${e instanceof RateLimitError ? ' (429: il modello c\'è ma la quota è finita: il profilo passerebbe al successivo)' : ''}`);
    return e instanceof RateLimitError;
  }
}

let failures = 0;
if (profile) {
  const routing = profileRouting(profile);
  console.log(`Profilo «${profile.name}»${profile.description ? ` — ${profile.description}` : ''}`);
  const seen = new Set<string>();
  for (const ep of routing.all()) {
    const key = `${ep.key}|${ep.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const roles = AGENT_ROLES.filter((r) => roleChain(profile, r).some((e) => e.model === ep.model && e.baseUrl.replace(/\/+$/, '') === ep.key));
    const which = roles.map((r) => (roleChain(profile, r)[0]!.model === ep.model ? r : `${r} (ripiego)`)).join(', ');
    const { ok, names } = await listed(ep.key, (ep.provider as OpenAiCompatProvider).apiKey);
    if (!ok) { failures++; continue; }
    if (names && !names.some((n) => n === ep.model || n === `models/${ep.model}` || n === `${ep.model}:latest`)) console.warn(`! "${ep.model}" non è nell'elenco /models di ${ep.key} (ok se è un alias risolto dal server)`);
    if (!(await probe(ep.provider, ep.model!, which, cfg.faction_major.timeoutMs, ` ${ep.rpm ? `${ep.rpm} richieste/min` : 'senza limite al minuto'}`))) failures++;
  }
} else {
  const base = process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1';
  const key = process.env.LLM_API_KEY;
  console.log(`OmniRoute: ${base}${key ? ' (con API key)' : ''}`);
  const { ok, names: available } = await listed(base, key);
  if (!ok) process.exit(1);
  console.log(`✓ raggiungibile${available ? `, ${available.length} modelli/combo esposti` : ''}`);
  const provider = new OpenAiCompatProvider(base, key);
  for (const model of [...new Set(Object.values(cfg).map((c) => c.model))]) {
    const roles = AGENT_ROLES.filter((r) => cfg[r].model === model).join(', ');
    if (model === 'default') { console.warn(`! nessun modello configurato per: ${roles} (imposta LLM_MODEL, LLM_MODEL_<RUOLO> o LLM_PROFILE)`); failures++; continue; }
    if (available?.length && !available.includes(model)) console.warn(`! "${model}" non è nell'elenco /models (ok se è un alias risolto da OmniRoute)`);
    if (!(await probe(provider, model, roles, cfg.faction_major.timeoutMs))) failures++;
  }
}
process.exit(failures ? 1 : 0);
