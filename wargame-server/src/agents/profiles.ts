import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentRole } from '../schemas/world.js';
import type { Endpoint, Routing } from './budget.js';
import { OpenAiCompatProvider, type LlmProvider } from './llm-client.js';

/**
 * Profili di provider (`LLM_PROFILE`, docs/wargame/DIPLOMAZIA.md §11): per ogni ruolo un elenco ordinato di modelli (endpoint, modello, campi extra,
 * richieste al minuto): il primo è il principale, gli altri il ripiego su 429 o errore. Si dichiarano in `wargame-server/llm-profiles/<nome>.json`
 * oppure in una variabile JSON di `.env` (`LLM_PROFILE_JSON`, o `LLM_PROFILE` che inizia con «{»). Niente chiavi qui: l'endpoint dice solo in
 * quale variabile d'ambiente cercarla (`apiKeyEnv`, predefinita `LLM_API_KEY`); un campo sconosciuto (es. `apiKey`) fa rifiutare il profilo.
 * `${VAR}` e `${VAR:-predefinito}` nei testi si espandono dall'ambiente. `LLM_MODEL_<RUOLO>` resta valido e vince sul profilo.
 */
export const ProfileEndpoint = z.strictObject({
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  /** campi aggiunti a ogni richiesta (es. `{"reasoning_effort":"none"}`); se manca vale LLM_EXTRA_BODY */
  extraBody: z.record(z.string(), z.unknown()).optional(),
  /** richieste al minuto (0 = nessun limite); se manca vale LLM_RPM (predefinito 8) */
  rpm: z.number().min(0).optional(),
  /** richieste al giorno (0 = nessun limite); se manca vale LLM_RPD (predefinito 1000) */
  rpd: z.number().min(0).optional(),
  /** json_schema (predefinito) o json_object; se manca vale LLM_RESPONSE_FORMAT */
  responseFormat: z.enum(['json_schema', 'json_object']).optional(),
  /** nome della variabile d'ambiente con la chiave (mai la chiave); predefinita LLM_API_KEY */
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
});
export type ProfileEndpoint = z.infer<typeof ProfileEndpoint>;

export const Profile = z.strictObject({
  name: z.string().regex(/^[\w-]+$/),
  description: z.string().optional(),
  /** per ruolo l'elenco ordinato dei modelli; `default` per i ruoli non elencati */
  roles: z.record(z.string(), z.array(ProfileEndpoint).min(1)),
}).superRefine((p, ctx) => {
  const known = new Set<string>([...AgentRole.options, 'default']);
  for (const r of Object.keys(p.roles)) if (!known.has(r)) ctx.addIssue({ code: 'custom', path: ['roles', r], message: `ruolo sconosciuto «${r}» (ammessi: ${[...known].join(', ')})` });
  const missing = AgentRole.options.filter((r) => !p.roles[r] && !(r === 'diplomat' && p.roles.faction_major));
  if (!p.roles.default && missing.length) ctx.addIssue({ code: 'custom', path: ['roles'], message: `senza «default» servono tutti i ruoli (mancano: ${missing.join(', ')})` });
});
export type Profile = z.infer<typeof Profile>;

export const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'llm-profiles');

/** `${VAR}` / `${VAR:-predefinito}` dall'ambiente; una variabile mancante senza predefinito è un errore leggibile. */
export function expand(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (dflt !== undefined) return dflt;
    throw new Error(`profilo LLM: la variabile ${name} non è impostata (.env)`);
  });
}
const expandDeep = <T>(v: T, env: NodeJS.ProcessEnv): T => {
  if (typeof v === 'string') return expand(v, env) as T;
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, env)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, env)])) as T;
  return v;
};

export function parseProfile(raw: unknown, env: NodeJS.ProcessEnv = process.env, source = 'profilo'): Profile {
  const r = Profile.safeParse(raw);
  if (!r.success) throw new Error(`${source}: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ')}`);
  return expandDeep(r.data, env);
}

/** Nomi dei profili in `llm-profiles/`. */
export const listProfiles = (dir = PROFILES_DIR): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort() : []);

/**
 * Il profilo scelto dall'ambiente: `LLM_PROFILE=<nome>` (file in llm-profiles/), `LLM_PROFILE_JSON={...}` o `LLM_PROFILE={...}`.
 * Senza nessuna delle due: nessun profilo (vale la configurazione di sempre: LLM_BASE_URL, LLM_MODEL, LLM_MODEL_<RUOLO>).
 */
export function loadProfile(env: NodeJS.ProcessEnv = process.env, dir = PROFILES_DIR): Profile | null {
  const inline = env.LLM_PROFILE_JSON?.trim() || (env.LLM_PROFILE?.trim().startsWith('{') ? env.LLM_PROFILE.trim() : '');
  if (inline) {
    let raw: unknown;
    try { raw = JSON.parse(inline); } catch (e) { throw new Error(`LLM_PROFILE_JSON non è un JSON valido: ${(e as Error).message}`); }
    return parseProfile(raw, env, 'LLM_PROFILE_JSON');
  }
  const name = env.LLM_PROFILE?.trim();
  if (!name) return null;
  const file = path.join(dir, `${name}.json`);
  if (!/^[\w-]+$/.test(name) || !existsSync(file)) throw new Error(`profilo LLM «${name}» non trovato (disponibili: ${listProfiles(dir).join(', ') || 'nessuno'})`);
  return parseProfile(JSON.parse(readFileSync(file, 'utf8')), env, `llm-profiles/${name}.json`);
}

/** I modelli di un ruolo nel profilo: quello del ruolo, per il diplomat quello di faction_major, altrimenti `default`. */
export function roleChain(p: Profile, role: string): ProfileEndpoint[] {
  return p.roles[role] ?? (role === 'diplomat' ? p.roles.faction_major : undefined) ?? p.roles.default ?? p.roles.faction_major!;
}
/** Il modello principale di ogni ruolo del profilo (per le campagne nuove: `llmDefaults()`). */
export const profileModels = (p: Profile): Record<string, string> => Object.fromEntries(AgentRole.options.map((r) => [r, roleChain(p, r)[0]!.model]));

/**
 * Instradamento di un profilo: un provider HTTP per endpoint (ognuno con i suoi `extraBody` e la sua chiave), senza tentativi in più su 429 (il
 * ripiego sul modello successivo lo fa il gestore del budget). Il modello scelto per la campagna vince sul profilo: se è diverso dal primo del
 * ruolo (LLM_MODEL_<RUOLO>, POST /config) si prova per primo sull'endpoint principale, poi il resto del profilo.
 */
export function profileRouting(p: Profile, env: NodeJS.ProcessEnv = process.env): Routing & { primary: OpenAiCompatProvider } {
  const num = (k: string, d: number) => (env[k]?.trim() ? Math.max(0, Number(env[k]) || 0) : d);
  const rpm = num('LLM_RPM', 8); const rpd = num('LLM_RPD', 1000);
  const made = new Map<string, Endpoint>();
  const endpoint = (e: ProfileEndpoint): Endpoint => {
    const id = JSON.stringify(e);
    let ep = made.get(id);
    if (!ep) {
      const base = e.baseUrl.replace(/\/+$/, '');
      const provider = new OpenAiCompatProvider(base, env[e.apiKeyEnv ?? 'LLM_API_KEY'] || env.LLM_API_KEY || undefined, e.responseFormat ?? env.LLM_RESPONSE_FORMAT ?? 'json_schema', { retry429: 0, ...(e.extraBody ? { extraBody: e.extraBody } : {}) });
      ep = { key: base, label: `${e.model} @ ${base}`, provider, model: e.model, rpm: e.rpm ?? rpm, rpd: e.rpd ?? rpd };
      made.set(id, ep);
    }
    return ep;
  };
  const all = [...new Set([...Object.values(p.roles).flat()])];
  const primary = endpoint(roleChain(p, 'faction_major')[0]!).provider as OpenAiCompatProvider;
  const chains = new Map<string, Endpoint[]>(AgentRole.options.map((r) => [r, roleChain(p, r).map(endpoint)]));
  return {
    name: p.name, baseUrl: (primary as OpenAiCompatProvider).baseUrl, primary,
    all: () => all.map(endpoint),
    endpointsFor(role, requested) {
      const base = chains.get(role) ?? chains.get('faction_major')!;
      if (requested === 'default' || requested === base[0]!.model) return base;
      // una richiesta di riparazione (o di un altro ruolo) porta il modello della richiesta originale: si usa la catena che lo ha per primo
      const owner = [...chains.values()].find((c) => c[0]!.model === requested);
      if (owner) return owner;
      // modello scelto a mano: prima quello sull'endpoint principale del ruolo, poi il profilo
      return [{ ...base[0]!, model: requested, label: `${requested} @ ${base[0]!.key}` }, ...base.filter((b) => b.model !== requested)];
    },
  };
}

/** Provider di un profilo per `bench:models` e `llm:check` (l'endpoint principale del ruolo). */
export const profileProvider = (r: ReturnType<typeof profileRouting>): LlmProvider => r.primary;
