import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatProvider, portableSchema } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import type { LlmRequest } from '../src/agents/llm-client.js';
import { makeEngine } from './helpers.js';

/** Server OpenAI-compatible finto (come OmniRoute): rifiuta json_schema con 400, risponde con il mock a json_object. */
describe('client OpenAI-compatible (OmniRoute)', () => {
  let server: Server; let base = '';
  const seen: { response_format: { type: string }; model: string; messages: { content: string }[] }[] = [];
  const mock = new MockLLMProvider();
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'wargame-strong' }] }));
        const b = JSON.parse(body);
        seen.push(b);
        if (b.response_format.type === 'json_schema') { res.statusCode = 400; return res.end('{"error":"response_format json_schema non supportato"}'); }
        // il mock ha bisogno dei meta strutturati: li ricaviamo dalla richiesta registrata dal test
        const i = pending.findIndex((p) => p.system === b.messages[0].content && p.user === b.messages[1].content);
        const r = await mock.complete(pending.splice(i, 1)[0]!);
        res.end(JSON.stringify({ model: b.model, choices: [{ message: { content: `Ecco:\n\`\`\`json\n${r.text}\n\`\`\`` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      });
    }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());
  const pending: LlmRequest[] = [];

  it('un turno completo via HTTP con fallback a json_object', async () => {
    const http = new OpenAiCompatProvider(base);
    const spy = { name: 'spy', complete: (r: LlmRequest) => { pending.push(r); return http.complete(r); } };
    const e = makeEngine(spy as never);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'http', seed: 'http' });
    await e.advance(c.id);
    expect(seen[0]!.response_format.type).toBe('json_schema');
    // le chiamate già in volo possono tentare json_schema una volta; poi il client resta su json_object
    expect(seen.filter((b) => b.response_format.type === 'json_schema').length).toBeLessThanOrEqual(4);
    expect(seen.slice(-20).every((b) => b.response_format.type === 'json_object')).toBe(true);
    const d = (await e.store.getDecision(c.id, 1, 'TUR'))!;
    expect(d.validation).toMatchObject({ valid: true, fallbackUsed: false });
    expect(d.usage.promptTokens).toBeGreaterThan(0);
  }, 60_000);
});

describe('client OpenAI-compatible: errori 400 che non riguardano lo schema', () => {
  it('un modello non disponibile fallisce subito e non spegne json_schema per gli altri modelli', async () => {
    const seen: { model: string; response_format: { type: string } }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b = JSON.parse(body);
        seen.push(b);
        if (b.model === 'combo' && b.response_format.type === 'json_schema') { res.statusCode = 502; return res.end('{"error":{"message":"cohere: [400]: invalid \'json_schema\' provided: object type must specify properties"}}'); }
        if (b.model === 'nope') { res.statusCode = 400; return res.end('{"error":{"message":"Model \'nope\' is not available in the active live catalog"}}'); }
        res.end(JSON.stringify({ model: b.model, choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const http = new OpenAiCompatProvider(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
    const req = (model: string): LlmRequest => ({ role: 'repair', model, temperature: 0, maxTokens: 10, timeoutMs: 5000, system: 's', user: 'u', schemaName: 'P', jsonSchema: { type: 'object' }, meta: {} });
    const t0 = Date.now();
    await expect(http.complete(req('nope'))).rejects.toThrow(/LLM HTTP 400/);
    expect(Date.now() - t0).toBeLessThan(1500); // nessun retry con backoff
    expect(seen.filter((b) => b.model === 'nope')).toHaveLength(1);
    await expect(http.complete(req('ok'))).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(seen.at(-1)!.response_format.type).toBe('json_schema');
    // combo che passa a un provider senza json_schema (502 con l'errore dentro): si ripiega su json_object per quella combo
    await expect(http.complete(req('combo'))).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(seen.filter((b) => b.model === 'combo').map((b) => b.response_format.type)).toEqual(['json_schema', 'json_object']);
    await http.complete(req('ok'));
    expect(seen.at(-1)!.response_format.type).toBe('json_schema');
    // LLM_RESPONSE_FORMAT=json_object: mai json_schema
    await new OpenAiCompatProvider(http.baseUrl, undefined, 'json_object').complete(req('ok'));
    expect(seen.at(-1)!.response_format.type).toBe('json_object');
    server.close();
  });
});

describe('schema portabile per response_format', () => {
  it('toglie i vincoli che Cohere & co. rifiutano, lascia struttura e tipi', () => {
    const s = { $schema: 'x', type: 'object', properties: { factionId: { type: 'string', minLength: 2 }, list: { type: 'array', items: { type: 'number', minimum: 0 }, maxItems: 3 } }, required: ['factionId'] };
    expect(portableSchema(s)).toEqual({ type: 'object', properties: { factionId: { type: 'string' }, list: { type: 'array', items: { type: 'number' } } }, required: ['factionId'] });
    // un campo che si chiama «format» resta
    expect(portableSchema({ type: 'object', properties: { format: { type: 'string', maxLength: 5 } } })).toEqual({ type: 'object', properties: { format: { type: 'string' } } });
  });
});
