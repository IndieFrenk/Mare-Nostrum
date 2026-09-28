import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { buildLexicon, recognize } from '../src/engine/names.js';
import { loadScenario } from '../src/engine/scenario.js';
import { PARSER_CASES, scoreParsed } from '../src/cli/parser-cases.js';
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

describe('console ordini: controlli dopo l\'LLM (errori veri dei modelli locali)', () => {
  const setup = async (reply: unknown, seed: string) => {
    const e = makeEngine(new ScriptedParser(reply));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
    return { e, c };
  };

  it('4B: CYBER_OP e DEMARCHE con una zona come destinatario → errori, avviso cyber e movimento senza unità', async () => {
    const { e, c } = await setup({ orders: { ...empty,
      military: [{ id: 'o1', kind: 'CYBER_OP', target: 'CANALE_SICILIA', targetRef: 'partenze', effect: 'espionage' }],
      diplomacy: [{ id: 'd1', kind: 'DEMARCHE', target: 'CANALE_SICILIA', message: 'Più controlli', visibility: 'public' }] }, ambiguities: [] }, 'q4b');
    const r = await e.parseOrders(c.id, FRASE_1);
    expect(r.validation.valid).toBe(false);
    expect(r.validation.errors.filter((x) => x.includes('CANALE_SICILIA') && x.includes('non è una fazione'))).toHaveLength(2);
    expect(r.validation.risks.some((x) => x.includes('CYBER_OP') && x.includes('non richiesta'))).toBe(true);
    expect(r.ambiguities.some((x) => x.includes('muovere forze') && x.includes('«manda»'))).toBe(true);
    expect(r.ambiguities.some((x) => x.includes('ITA-F590 è nominata'))).toBe(true);
    expect(r.ambiguities.some((x) => x.includes('Tunisia (TUN) è nominata'))).toBe(true);
  });

  it('9B: due CYBER_OP disruption contro la Grecia → avviso «alleato» e cyber non richiesta, SHOW_OF_FORCE mancante', async () => {
    const { e, c } = await setup({ orders: { ...empty, military: [
      { id: 'o1', kind: 'CYBER_OP', target: 'GRC', targetRef: 'reti', effect: 'disruption' },
      { id: 'o2', kind: 'CYBER_OP', target: 'GRC', targetRef: 'comandi', effect: 'disruption' }] }, ambiguities: [] }, 'q9b');
    const r = await e.parseOrders(c.id, FRASE_2);
    // il validatore le accetta (la Grecia è una fazione): gli avvisi vengono dai controlli
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.risks.filter((x) => x.includes('contro Grecia (GRC), alleato (NATO, EU)'))).toHaveLength(1);
    expect(r.validation.risks.filter((x) => x.includes('non richiesta'))).toHaveLength(2);
    expect(r.ambiguities.some((x) => x.includes('muovere forze') && x.includes('porta'))).toBe(true);
    expect(r.ambiguities.some((x) => x.includes('rassicurare'))).toBe(true);
  });

  it('9B sulla frase 1: risposta corretta → nessun avviso', async () => {
    const { e, c } = await setup({ orders: { ...empty,
      military: [{ id: 'm1', kind: 'MOVE', unitIds: ['ITA-F590'], to: 'CANALE_SICILIA', speed: 'cruise' }],
      diplomacy: [{ id: 'd1', kind: 'DEMARCHE', target: 'TUN', message: 'Più controlli sulle partenze', visibility: 'public' }] }, ambiguities: [] }, 'ok9b');
    const r = await e.parseOrders(c.id, FRASE_1);
    expect(r.validation.valid).toBe(true);
    expect(r.validation.risks.filter((x) => x.startsWith('⚠'))).toEqual([]);
    expect(r.ambiguities).toEqual([]);
  });

  it('SHOW_OF_FORCE della Cavour nello Ionio e REASSURANCE alla Grecia → nessun avviso', async () => {
    const { e, c } = await setup({ orders: { ...empty,
      military: [{ id: 'm1', kind: 'SHOW_OF_FORCE', unitIds: ['ITA-CAVOUR'], zoneId: 'IONIO', roe: 'WEAPONS_TIGHT' }],
      diplomacy: [{ id: 'd1', kind: 'REASSURANCE', target: 'GRC', message: 'Nessuna minaccia per Atene', visibility: 'public' }] }, ambiguities: [] }, 'ok2');
    const r = await e.parseOrders(c.id, FRASE_2);
    expect(r.validation.valid).toBe(true);
    expect(r.validation.risks.filter((x) => x.startsWith('⚠'))).toEqual([]);
    expect(r.ambiguities).toEqual([]);
  });

  it('minacce, sanzioni, strike e blocchi verso un alleato (anche per fiducia ≥ 40) sono segnalati', async () => {
    const { e, c } = await setup({ orders: { ...empty,
      military: [{ id: 'm1', kind: 'BLOCKADE', unitIds: ['ITA-F591'], zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' }],
      diplomacy: [{ id: 'd1', kind: 'THREAT', target: 'USA', message: 'x', visibility: 'public' }, { id: 'd2', kind: 'SANCTION', target: 'TUR', scope: 'x' }, { id: 'd3', kind: 'SANCTION', target: 'RUS', scope: 'x' }] }, ambiguities: [] }, 'ostili');
    const r = await e.parseOrders(c.id, 'Minaccia gli Stati Uniti, sanziona Turchia e Russia e blocca l\'Egeo con la Fasan');
    const alleati = r.validation.risks.filter((x) => x.includes('alleato'));
    expect(alleati.some((x) => x.startsWith('⚠ THREAT contro Stati Uniti (USA)'))).toBe(true);
    expect(alleati.some((x) => x.startsWith('⚠ SANCTION contro Turchia (TUR), alleato (NATO)'))).toBe(true);
    expect(alleati.some((x) => x.includes('BLOCKADE in EGEO contro Grecia (GRC)'))).toBe(true);
    expect(alleati.some((x) => x.includes('Russia'))).toBe(false);
  });

  it('il validatore rifiuta destinatari che non sono fazioni anche negli accordi e verso sé stessi', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'val', seed: 'val' });
    const v = await e.validate(c.id, { ...empty,
      military: [{ id: 'c1', kind: 'CYBER_OP', target: 'ITA', targetRef: 'x', effect: 'espionage' }],
      diplomacy: [
        { id: 'a1', kind: 'PROPOSE_AGREEMENT', target: ['EGEO'], agreement: { type: 'migration', parties: ['ITA', 'IONIO'], terms: 'x', endTurn: null, visibility: 'public' } },
        { id: 'a2', kind: 'DEMARCHE', target: 'ITA', message: 'x', visibility: 'public' },
      ] });
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual(expect.arrayContaining([
      'c1: un\'operazione cyber non può colpire la propria fazione', 'a1: destinatario EGEO sconosciuto (non è una fazione)', 'a1: destinatario IONIO sconosciuto (non è una fazione)', 'a2: DEMARCHE non può essere rivolto alla propria fazione',
    ]));
  });
});

describe('banco «parser»: casi e punteggio', () => {
  it('almeno 12 frasi, incluse le due dei modelli locali', () => {
    expect(PARSER_CASES.length).toBeGreaterThanOrEqual(12);
    expect(PARSER_CASES.map((c) => c.text)).toEqual(expect.arrayContaining([FRASE_1, FRASE_2]));
  });

  it('4B → sbagliato, 9B → pericoloso, risposta giusta → corretto', async () => {
    const run = async (reply: unknown, text: string, seed: string) => {
      const e = makeEngine(new ScriptedParser(reply));
      const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
      return scoreParsed(PARSER_CASES.find((x) => x.text === text)!, await e.parseOrders(c.id, text));
    };
    const q4b = await run({ orders: { ...empty, diplomacy: [{ id: 'd1', kind: 'DEMARCHE', target: 'CANALE_SICILIA', message: 'x', visibility: 'public' }] } }, FRASE_1, 's4b');
    expect(q4b.verdict).toBe('sbagliato');
    expect(q4b.reasons).toContain('manca PATROL/MOVE/PRESENCE ITA-F590 in CANALE_SICILIA');
    const q9b = await run({ orders: { ...empty, military: [{ id: 'o1', kind: 'CYBER_OP', target: 'GRC', targetRef: 'reti', effect: 'disruption' }] } }, FRASE_2, 's9b');
    expect(q9b.verdict).toBe('pericoloso');
    const ok = await run({ orders: { ...empty, military: [{ id: 'm1', kind: 'SHOW_OF_FORCE', unitIds: ['ITA-CAVOUR'], zoneId: 'IONIO', roe: 'WEAPONS_TIGHT' }],
      diplomacy: [{ id: 'd1', kind: 'REASSURANCE', target: 'GRC', message: 'x', visibility: 'public' }] } }, FRASE_2, 'sok');
    expect(ok).toEqual({ verdict: 'corretto', reasons: [] });
  });
});
