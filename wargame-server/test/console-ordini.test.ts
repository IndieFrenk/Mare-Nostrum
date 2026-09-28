import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { buildLexicon, recognize } from '../src/engine/names.js';
import { loadScenario } from '../src/engine/scenario.js';
import { makeEngine } from './helpers.js';

/** Provider finto: il parser restituisce la risposta scritta nel test (gli errori visti con i modelli locali), il resto è il mock. */
class ScriptedParser implements LlmProvider {
  name = 'scripted';
  requests: LlmRequest[] = [];
  private mock = new MockLLMProvider();
  constructor(public reply: unknown = null) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.role !== 'order_parser' || this.reply === null) return this.mock.complete(req);
    this.requests.push(req);
    return { text: JSON.stringify(this.reply), usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'finto' };
  }
}

const FRASE_1 = 'Manda la fregata Bergamini a pattugliare il Canale di Sicilia e chiedi alla Tunisia più controlli sulle partenze';
const FRASE_2 = 'Porta la Cavour nel Mar Ionio con una dimostrazione di forza e rassicura la Grecia';
const empty = { military: [], diplomacy: [], procurement: [], statements: [] };

describe('console ordini: nomi riconosciuti prima dell\'LLM', () => {
  const sc = loadScenario('med-2026');
  const lex = buildLexicon(Object.values(sc.world.units).filter((u) => u.factionId === 'ITA'), sc);

  it('unità, zone e paesi diventano id nel testo', () => {
    const r1 = recognize(FRASE_1, lex);
    expect(r1.text).toContain('Bergamini [ITA-F590]');
    expect(r1.text).toContain('Canale di Sicilia [CANALE_SICILIA]');
    expect(r1.text).toContain('Tunisia [TUN]');
    const r2 = recognize(FRASE_2, lex);
    expect(r2.hits.map((h) => h.id)).toEqual(['ITA-CAVOUR', 'IONIO', 'GRC']);
    expect(recognize('pattuglia nello Ionio e nell\'Egeo', lex).hits.map((h) => h.id)).toEqual(['IONIO', 'EGEO']);
  });

  it('la classe non è un\'unità e «Libia» è ambigua', () => {
    const r = recognize('Manda una FREMM classe Bergamini verso la Libia', lex);
    expect(r.hits.map((h) => h.id)).not.toContain('ITA-F590');
    expect(r.ambiguous).toEqual([{ alias: 'Libia', ids: ['LBY_GNU', 'LBY_LNA'] }]);
  });

  it('un id già scritto non viene ripetuto', () => {
    expect(recognize('Pattugliare CANALE_SICILIA con ITA-F592', lex).text).toBe('Pattugliare CANALE_SICILIA con ITA-F592');
  });

  it('il prompt del parser ha la tabella nome → id, i campi degli ordini e il testo con gli id', async () => {
    const p = new ScriptedParser({ orders: empty, ambiguities: [] });
    const e = makeEngine(p);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'nomi', seed: 'nomi' });
    await e.parseOrders(c.id, FRASE_1);
    const req = p.requests[0]!;
    expect(req.user).toContain('DIRETTIVA: Manda la fregata Bergamini [ITA-F590] a pattugliare il Canale di Sicilia [CANALE_SICILIA] e chiedi alla Tunisia [TUN]');
    expect(req.user).toMatch(/ITA-F590 = .*Bergamini/);
    expect(req.user).toMatch(/IONIO = Mar Ionio · Ionio/);
    expect(req.user).toMatch(/TUN = Tunisia/);
    expect(req.system).toContain('CAMPI DI OGNI ORDINE');
    expect(req.system).toMatch(/CYBER_OP SOLO se/);
  });
});

describe('console ordini: posture per zona dal parser', () => {
  it('«più presenza nel Canale di Sicilia» → ordine con unità scelte dal motore', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'posture', seed: 'posture' });
    const r = await e.parseOrders(c.id, 'Voglio più presenza nel Canale di Sicilia');
    expect(r.zoneStances).toEqual([{ zoneId: 'CANALE_SICILIA', stance: 'presence', intensity: 2 }]);
    expect(r.orders.military.length).toBeGreaterThan(0);
    expect(r.orders.military[0]).toMatchObject({ kind: 'PRESENCE', zoneId: 'CANALE_SICILIA' });
    expect((r.orders.military[0] as { unitIds: string[] }).unitIds.every((u) => u.startsWith('ITA-'))).toBe(true);
    expect(r.stanceOrders[0]).toMatchObject({ orderId: r.orders.military[0]!.id, stance: 'presence', zoneId: 'CANALE_SICILIA' });
    expect(r.validation.valid).toBe(true);
  });

  it('gli id della bozza sono univoci', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'id', seed: 'id' });
    const r = await e.parseOrders(c.id, FRASE_1);
    const ids = Object.values(r.orders).flat().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.orders.military[0]).toMatchObject({ kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA' });
    expect(r.orders.diplomacy[0]).toMatchObject({ kind: 'DEMARCHE', target: 'TUN' });
  });
});
