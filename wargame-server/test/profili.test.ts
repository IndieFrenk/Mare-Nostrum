import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LlmBudget, ManualClock } from '../src/agents/budget.js';
import type { LlmRequest } from '../src/agents/llm-client.js';
import { PROFILES_DIR, expand, listProfiles, loadProfile, parseProfile, profileModels, profileRouting, roleChain } from '../src/agents/profiles.js';
import { AGENT_ROLES, llmDefaults } from '../src/config.js';
import { roleConfig } from '../src/engine/turn-machine.js';
import type { Campaign } from '../src/schemas/index.js';

const req = (user: string, role: LlmRequest['role'] = 'diplomat', model = 'm'): LlmRequest => ({ role, model, temperature: 0, maxTokens: 10, timeoutMs: 2000, system: 's', user, schemaName: 'X', jsonSchema: {}, meta: {} });
const campaign = { id: 'p1', config: { factionMode: 'rules' as const } };

describe('profili di esempio (llm-profiles/)', () => {
  it('ci sono locale, gemini e omniroute e sono tutti validi', () => {
    expect(listProfiles()).toEqual(expect.arrayContaining(['gemini', 'locale', 'omniroute']));
    for (const name of listProfiles()) {
      const p = loadProfile({ LLM_PROFILE: name });
      expect(p!.name, name).toBe(name);
      for (const r of AGENT_ROLES) expect(roleChain(p!, r).length, `${name}/${r}`).toBeGreaterThan(0);
    }
  });

  it('niente chiavi nei file: solo segnaposto e nomi di variabili d\'ambiente', () => {
    for (const name of listProfiles()) {
      const text = readFileSync(path.join(PROFILES_DIR, `${name}.json`), 'utf8');
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s|"apiKey"|"api_key"|"authorization"/i);
      for (const m of text.matchAll(/"apiKeyEnv":\s*"([^"]*)"/g)) expect(m[1], name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('locale: Ollama con qwen3.5 4B/9B e ragionamento spento, nessun limite', () => {
    const p = loadProfile({ LLM_PROFILE: 'locale' })!;
    expect(profileModels(p)).toMatchObject({ faction_major: 'wg-qwen3.5-9b', gm_narrator: 'wg-qwen3.5-9b', diplomat: 'wg-qwen3.5-9b', strategist: 'wg-qwen3.5-9b', chancery: 'wg-qwen3.5-4b', order_parser: 'wg-qwen3.5-4b' });
    const e = roleChain(p, 'chancery')[0]!;
    expect(e).toMatchObject({ baseUrl: 'http://localhost:11434/v1', extraBody: { reasoning_effort: 'none' }, rpm: 0 });
    expect(loadProfile({ LLM_PROFILE: 'locale', OLLAMA_BASE_URL: 'http://pc-casa:11434/v1' })!.roles.default![0]!.baseUrl).toBe('http://pc-casa:11434/v1');
  });

  it('gemini: Flash per diplomat, gm_narrator e strategist, Flash-Lite per il resto, ognuno ripiego dell\'altro', () => {
    const p = loadProfile({ LLM_PROFILE: 'gemini' })!;
    const first = (r: string) => roleChain(p, r)[0]!.model;
    for (const r of ['diplomat', 'gm_narrator', 'strategist']) { expect(first(r)).toBe('gemini-2.5-flash'); expect(roleChain(p, r)[1]!.model).toBe('gemini-2.5-flash-lite'); }
    for (const r of ['chancery', 'order_parser', 'intel_analyst', 'faction_minor', 'reflection']) { expect(first(r)).toBe('gemini-2.5-flash-lite'); expect(roleChain(p, r)[1]!.model).toBe('gemini-2.5-flash'); }
    const e = roleChain(p, 'diplomat')[0]!;
    expect(e).toMatchObject({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', extraBody: { reasoning_effort: 'none' }, apiKeyEnv: 'GEMINI_API_KEY' });
  });

  it('omniroute: un solo LLM_BASE_URL e due combo, rpm dal LLM_RPM (il limite più basso della combo)', () => {
    const p = loadProfile({ LLM_PROFILE: 'omniroute', LLM_BASE_URL: 'http://router:20128/v1' })!;
    expect(new Set(Object.values(p.roles).flat().map((e) => e.baseUrl))).toEqual(new Set(['http://router:20128/v1']));
    expect(profileModels(p)).toMatchObject({ diplomat: 'wargame-strong', strategist: 'wargame-strong', chancery: 'wargame-light' });
    const r = profileRouting(p, { LLM_RPM: '6' } as NodeJS.ProcessEnv);
    expect(r.endpointsFor('chancery', 'wargame-light')[0]!.rpm).toBe(6);
    expect(Object.values(p.roles).flat().every((e) => e.rpm === undefined)).toBe(true);
  });
});

describe('validazione e variabili', () => {
  const ep = { baseUrl: 'http://x/v1', model: 'm' };
  it('una chiave dentro il profilo (apiKey, headers…) è rifiutata', () => {
    expect(() => parseProfile({ name: 'p', roles: { default: [{ ...ep, apiKey: 'sk-qualcosa' }] } })).toThrow(/apiKey|Unrecognized|unrecognized/i);
    expect(() => parseProfile({ name: 'p', roles: { default: [{ ...ep, apiKeyEnv: 'sk-minuscolo' }] } })).toThrow();
  });
  it('ruoli sconosciuti e profili incompleti', () => {
    expect(() => parseProfile({ name: 'p', roles: { default: [ep], cuoco: [ep] } })).toThrow(/ruolo sconosciuto «cuoco»/);
    expect(() => parseProfile({ name: 'p', roles: { gm_narrator: [ep] } })).toThrow(/senza «default» servono tutti i ruoli/);
    expect(() => parseProfile({ name: 'p', roles: { default: [] } })).toThrow();
  });
  it('${VAR}, ${VAR:-predefinito} e variabile mancante', () => {
    expect(expand('${A}/v1', { A: 'http://a' })).toBe('http://a/v1');
    expect(expand('${A:-http://b}', {})).toBe('http://b');
    expect(expand('${A:-http://b}', { A: '' })).toBe('http://b');
    expect(() => expand('${A}', {})).toThrow(/variabile A non è impostata/);
  });
  it('LLM_PROFILE: nome, JSON in .env, nessuno', () => {
    expect(loadProfile({})).toBeNull();
    expect(loadProfile({ LLM_PROFILE: '' })).toBeNull();
    expect(() => loadProfile({ LLM_PROFILE: 'inesistente' })).toThrow(/non trovato \(disponibili: gemini, locale, omniroute\)/);
    expect(() => loadProfile({ LLM_PROFILE: '../.env' })).toThrow(/non trovato/);
    const json = JSON.stringify({ name: 'mio', roles: { default: [{ baseUrl: '${B:-http://z/v1}', model: 'mod', rpm: 3 }] } });
    expect(loadProfile({ LLM_PROFILE_JSON: json })).toMatchObject({ name: 'mio', roles: { default: [{ baseUrl: 'http://z/v1', model: 'mod', rpm: 3 }] } });
    expect(loadProfile({ LLM_PROFILE: json })!.name).toBe('mio');
    expect(() => loadProfile({ LLM_PROFILE_JSON: '{rotto' })).toThrow(/non è un JSON valido/);
  });
  it('il diplomat senza voce propria usa quella di faction_major', () => {
    const p = parseProfile({ name: 'p', roles: { default: [{ ...ep, model: 'base' }], faction_major: [{ ...ep, model: 'forte' }] } });
    expect(roleChain(p, 'diplomat')[0]!.model).toBe('forte');
    expect(roleChain(p, 'chancery')[0]!.model).toBe('base');
  });
});

describe('modelli delle campagne nuove (llmDefaults)', () => {
  const saved = { ...process.env };
  afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  const keys = ['LLM_PROFILE', 'LLM_PROFILE_JSON', 'LLM_MODEL', 'LLM_MODEL_FACTION_MAJOR', 'LLM_MODEL_STRATEGIST', 'LLM_MODEL_DIPLOMAT'];
  const clean = () => { for (const k of keys) delete process.env[k]; };

  it('senza profilo vale la configurazione di sempre, anche per i ruoli nuovi', () => {
    clean(); process.env.LLM_MODEL = 'wargame-light'; process.env.LLM_MODEL_FACTION_MAJOR = 'wargame-strong';
    const d = llmDefaults();
    expect(d.faction_major.model).toBe('wargame-strong');
    expect(d.diplomat.model).toBe('wargame-strong');
    expect(d.strategist.model).toBe('wargame-light');
    expect(d.chancery.model).toBe('wargame-light');
    expect(d.strategist.maxTokens).toBe(1000);
  });
  it('con il profilo il modello di ogni ruolo è il primo del suo elenco, ma LLM_MODEL_<RUOLO> vince', () => {
    clean(); process.env.LLM_PROFILE = 'gemini'; process.env.LLM_MODEL = 'ignorato';
    expect(llmDefaults().strategist.model).toBe('gemini-2.5-flash');
    expect(llmDefaults().chancery.model).toBe('gemini-2.5-flash-lite');
    process.env.LLM_MODEL_STRATEGIST = 'gemini-2.5-pro';
    expect(llmDefaults().strategist.model).toBe('gemini-2.5-pro');
    expect(llmDefaults().diplomat.model).toBe('gemini-2.5-flash');
  });
  it('una campagna vecchia senza strategist/chancery usa faction_major con i tetti del ruolo', () => {
    clean(); process.env.LLM_MODEL = 'wargame-light';
    const cfg = { model: 'vecchio', temperature: 0.5, maxTokens: 3000, timeoutMs: 1000 };
    const c = { config: { llm: { faction_major: cfg } } } as unknown as Campaign;
    expect(roleConfig(c, 'strategist')).toMatchObject({ model: 'wargame-light', maxTokens: 1000, timeoutMs: 1000 });
    expect(roleConfig(c, 'diplomat')).toBe(cfg);
  });
});

/** Due endpoint HTTP finti: il primo risponde 429, il secondo risponde; registrano intestazioni e corpo. */
describe('instradamento su endpoint veri', () => {
  let a: Server; let b: Server; let baseA = ''; let baseB = '';
  const seen: { which: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  let aMode: '429' | 'ok' = '429';
  const listen = async (which: string) => {
    const s = createServer((rq, res) => {
      let body = ''; rq.on('data', (c) => (body += c));
      rq.on('end', () => {
        const j = JSON.parse(body); seen.push({ which, auth: rq.headers.authorization, body: j });
        if (which === 'a' && aMode === '429') { res.statusCode = 429; res.setHeader('retry-after', '3'); return res.end('{}'); }
        res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
      });
    }).listen(0);
    await new Promise((r) => s.once('listening', r));
    return { s, base: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1` };
  };
  beforeAll(async () => { ({ s: a, base: baseA } = await listen('a')); ({ s: b, base: baseB } = await listen('b')); });
  afterAll(() => { a.close(); b.close(); });

  const profile = () => parseProfile({ name: 't', roles: {
    default: [{ baseUrl: baseB, model: 'lite', extraBody: { reasoning_effort: 'none' }, rpm: 0, apiKeyEnv: 'TEST_KEY_B' }, { baseUrl: baseA, model: 'flash', rpm: 0 }],
    diplomat: [{ baseUrl: baseA, model: 'flash', extraBody: { reasoning_effort: 'none' }, rpm: 0, apiKeyEnv: 'TEST_KEY_A' }, { baseUrl: baseB, model: 'lite', rpm: 0 }],
  } });
  const env = { TEST_KEY_A: 'chiave-a', TEST_KEY_B: 'chiave-b', LLM_API_KEY: 'chiave-generica' } as NodeJS.ProcessEnv;

  it('extraBody, chiave e modello vanno all\'endpoint giusto; su 429 si passa al ripiego del profilo', async () => {
    seen.length = 0; aMode = '429';
    const routing = profileRouting(profile(), env);
    const clock = new ManualClock(0);
    const budget = new LlmBudget(routing, { callsPerTurn: 10, cache: false, clock });
    const r = await budget.run(campaign, 1, 1, req('lettera', 'diplomat', 'flash'));
    expect(r.model).toBe('lite');
    expect(seen.map((s) => s.which)).toEqual(['a', 'b']);
    expect(seen[0]).toMatchObject({ auth: 'Bearer chiave-a', body: { model: 'flash', reasoning_effort: 'none' } });
    // il ripiego non ha extraBody propri: vale LLM_EXTRA_BODY (qui nessuno) e la chiave generica
    expect(seen[1]).toMatchObject({ auth: 'Bearer chiave-generica', body: { model: 'lite' } });
    expect(seen[1]!.body.reasoning_effort).toBeUndefined();
    // il primo resta in pausa per il Retry-After (3 s) e poi torna
    await budget.run(campaign, 1, 1, req('altra', 'diplomat', 'flash'));
    expect(seen.map((s) => s.which)).toEqual(['a', 'b', 'b']);
    aMode = 'ok'; clock.advance(3_001);
    expect((await budget.run(campaign, 1, 1, req('ancora', 'diplomat', 'flash'))).model).toBe('flash');
    expect((await budget.status(campaign, 1)).campaign!.turn).toMatchObject({ rate429: 1, fallbacks: 2 });
  });

  it('il modello scelto a mano per la campagna vince sul profilo e il profilo resta come ripiego', () => {
    const routing = profileRouting(profile(), env);
    const chain = routing.endpointsFor('diplomat', 'gemini-2.5-pro');
    expect(chain.map((e) => e.model)).toEqual(['gemini-2.5-pro', 'flash', 'lite']); // il modello scelto, poi tutto il profilo
    expect(chain[0]!.key).toBe(baseA);
    // una riparazione porta il modello della richiesta originale: si usa la catena che lo ha per primo
    expect(routing.endpointsFor('repair', 'flash').map((e) => e.model)).toEqual(['flash', 'lite']);
    expect(routing.endpointsFor('chancery', 'default').map((e) => e.model)).toEqual(['lite', 'flash']);
  });
});
