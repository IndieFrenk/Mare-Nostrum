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

  it('il prompt del parser mette in evidenza: unità tra parentesi quadre → ordine con quell\'id, posture solo senza unità', async () => {
    const p = new ScriptedParser({ orders: empty, ambiguities: [] });
    const e = makeEngine(p);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'regola', seed: 'regola' });
    await e.parseOrders(c.id, FRASE_1);
    const sys = p.requests[0]!.system;
    const rule = sys.indexOf('REGOLA PRINCIPALE — UNITÀ NOMINATE');
    // prima di tutte le altre regole, con l'esempio minimo: ordine con l'id, zoneStances vuoto
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(sys.indexOf('REGOLE\n'));
    expect(sys).toContain('dai un ordine in orders.military con quell\'id in "unitIds". Usa zoneStances SOLO se la direttiva non nomina unità');
    expect(sys).toContain('"military":[{"id":"m1","kind":"PRESENCE","unitIds":["ITA-F590"],"zoneId":"IONIO","roe":"WEAPONS_HOLD"}],"zoneStances":[]');
    // prompt corto per i modelli da 4B
    expect(sys.length).toBeLessThan(6000);
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

describe('console ordini: le unità nominate hanno la precedenza sulle posture', () => {
  // errore dei modelli locali: il testo arriva con «Bergamini [ITA-F590]» ma il modello risponde con una postura
  const stanceOnly = (zoneStances: unknown[]) => ({ orders: empty, zoneStances, ambiguities: [] });

  it('«Bergamini» + postura patrol nel Canale di Sicilia → PATROL con ITA-F590, nessuna ambiguità sulla nave', async () => {
    const e = makeEngine(new ScriptedParser(stanceOnly([{ zoneId: 'CANALE_SICILIA', stance: 'patrol', intensity: 1 }])));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'pref', seed: 'pref' });
    const r = await e.parseOrders(c.id, FRASE_1);
    expect(r.orders.military).toEqual([{ id: r.stanceOrders[0]!.orderId, kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' }]);
    expect(r.ambiguities.filter((x) => x.includes('ITA-F590'))).toEqual([]);
  });

  it('«Cavour» + show_of_force intensità 2 nello Ionio → la Cavour c\'è', async () => {
    const e = makeEngine(new ScriptedParser(stanceOnly([{ zoneId: 'IONIO', stance: 'show_of_force', intensity: 2 }])));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'cav', seed: 'cav' });
    const r = await e.parseOrders(c.id, FRASE_2);
    expect(r.orders.military[0]).toMatchObject({ kind: 'SHOW_OF_FORCE', zoneId: 'IONIO' });
    expect((r.orders.military[0] as { unitIds: string[] }).unitIds).toContain('ITA-CAVOUR');
    expect(r.ambiguities.filter((x) => x.includes('ITA-CAVOUR'))).toEqual([]);
  });

  it('un\'unità nominata ma danneggiata non entra nella postura e resta l\'ambiguità', async () => {
    const e = makeEngine(new ScriptedParser(stanceOnly([{ zoneId: 'CANALE_SICILIA', stance: 'patrol', intensity: 1 }])));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'dan', seed: 'dan' });
    const s = await e.store.getState(c.id);
    const k = (await e.store.getKnowledge(c.id, 'ITA', 1))!;
    Object.assign(s.units['ITA-F590']!, { status: 'damaged', damage: 30 });
    Object.assign(k.ownUnits.find((u) => u.id === 'ITA-F590')!, { status: 'damaged', damage: 30 });
    await e.store.saveState(c.id, s);
    await e.store.saveKnowledge(c.id, k);
    const r = await e.parseOrders(c.id, FRASE_1);
    const patrol = r.orders.military.find((o) => o.kind === 'PATROL') as { unitIds: string[] };
    expect(patrol.unitIds).not.toContain('ITA-F590');
    expect(r.orders.military.find((o) => o.kind === 'REPAIR')).toMatchObject({ unitIds: ['ITA-F590'] });
    expect(r.ambiguities).toContain('ITA-F590 è nominata nella direttiva ma nessun ordine la impiega.');
    expect(r.ambiguities).toContain('postura — unità nominata ITA-F590: danneggiata, va in riparazione');
  });
});

describe('console ordini: né ordine né postura → il motore completa la bozza', () => {
  // bozza vuota: come il JSON troncato del 9B su «Fai rientrare alla base la Luigi Rizzo dal Mar Rosso»
  const setup = async (seed: string, budget?: number) => {
    const e = makeEngine(new ScriptedParser({ orders: empty, zoneStances: [], ambiguities: [] }));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
    if (budget !== undefined) {
      const s = await e.store.getState(c.id); s.factions.ITA!.budget.discretionary = budget; await e.store.saveState(c.id, s);
      const k = (await e.store.getKnowledge(c.id, 'ITA', 1))!; k.ownFaction.budget.discretionary = budget; await e.store.saveKnowledge(c.id, k);
    }
    return { parse: (text: string) => e.parseOrders(c.id, text) };
  };
  const completed = (r: { ambiguities: string[] }) => r.ambiguities.filter((x) => x.startsWith('Ordine completato dal motore'));

  it('tipo dal verbo e ROE come nelle posture; l\'ordine è segnalato e validato', async () => {
    const { parse } = await setup('compl');
    const cases: [string, object][] = [
      ['Manda la fregata Bergamini a pattugliare il Canale di Sicilia', { kind: 'PATROL', unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' }],
      ['Porta la Cavour nel Mar Ionio con una dimostrazione di forza', { kind: 'SHOW_OF_FORCE', unitIds: ['ITA-CAVOUR'], zoneId: 'IONIO', roe: 'WEAPONS_TIGHT' }],
      ['Manda la Fasan a scortare i mercantili nel Mar Rosso', { kind: 'ESCORT', unitIds: ['ITA-F591'], protect: 'convoglio MAR_ROSSO', roe: 'WEAPONS_TIGHT' }],
      ['Il cacciatorpediniere Andrea Doria vada nell\'Egeo in presenza, armi in sicura', { kind: 'PRESENCE', unitIds: ['ITA-D553'], zoneId: 'EGEO', roe: 'WEAPONS_HOLD' }],
      ['Fai rientrare alla base la Luigi Rizzo dal Mar Rosso', { kind: 'RETURN_TO_BASE', unitIds: ['ITA-F595'] }],
    ];
    for (const [text, order] of cases) {
      const r = await parse(text);
      expect(r.orders.military, text).toEqual([{ id: expect.any(String), ...order }]);
      expect(completed(r), text).toHaveLength(1);
      expect(r.validation.valid, text).toBe(true);
      // nessun avviso residuo su unità o zona: l'ordine le copre (anche il rientro «dal Mar Rosso»)
      expect(r.ambiguities.filter((x) => !x.startsWith('Ordine completato')), text).toEqual([]);
    }
  });

  it('non completa con due zone, con una negazione o con un\'unità non adatta', async () => {
    const { parse } = await setup('nocompl');
    const two = await parse('Manda la Bergamini dal Tirreno al Canale di Sicilia');
    expect(two.orders.military).toEqual([]);
    expect(two.ambiguities).toContain('ITA-F590 è nominata nella direttiva ma nessun ordine la impiega.');
    const neg = await parse('Non mandare la Bergamini nel Canale di Sicilia');
    expect(neg.orders.military).toEqual([]);
    // una nave in una zona terrestre non si completa: resta l'avviso
    const land = await parse('Manda la Bergamini nell\'entroterra libico');
    expect(land.orders.military).toEqual([]);
    expect(land.ambiguities).toContain('ITA-F590 non impiegabile: unità navale, LIBIA_TERRA è una zona terrestre.');
  });

  it('l\'ordine completato passa dal validatore come gli altri (budget)', async () => {
    const { parse } = await setup('budget', 1);
    const r = await parse('Manda la Bergamini a pattugliare il Canale di Sicilia');
    expect(r.orders.military[0]).toMatchObject({ kind: 'PATROL', unitIds: ['ITA-F590'] });
    expect(r.validation.valid).toBe(false);
    expect(r.validation.errors.some((x) => x.includes('oltre il budget'))).toBe(true);
  });
});

describe('console ordini: controlli dopo l\'LLM (errori veri dei modelli locali)', () => {
  const setup = async (reply: unknown, seed: string) => {
    const e = makeEngine(new ScriptedParser(reply));
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
    return { e, c };
  };

  it('4B: CYBER_OP e DEMARCHE con una zona come destinatario → errori, avviso cyber, ordine della Bergamini completato dal motore', async () => {
    const { e, c } = await setup({ orders: { ...empty,
      military: [{ id: 'o1', kind: 'CYBER_OP', target: 'CANALE_SICILIA', targetRef: 'partenze', effect: 'espionage' }],
      diplomacy: [{ id: 'd1', kind: 'DEMARCHE', target: 'CANALE_SICILIA', message: 'Più controlli', visibility: 'public' }] }, ambiguities: [] }, 'q4b');
    const r = await e.parseOrders(c.id, FRASE_1);
    expect(r.validation.valid).toBe(false);
    expect(r.validation.errors.filter((x) => x.includes('CANALE_SICILIA') && x.includes('non è una fazione'))).toHaveLength(2);
    expect(r.validation.risks.some((x) => x.includes('CYBER_OP') && x.includes('non richiesta'))).toBe(true);
    // né ordine né postura per la Bergamini: il motore completa la bozza e lo dice
    expect(r.orders.military.find((o) => o.kind === 'PATROL')).toMatchObject({ unitIds: ['ITA-F590'], zoneId: 'CANALE_SICILIA', roe: 'WEAPONS_TIGHT' });
    expect(r.ambiguities.some((x) => x.startsWith('Ordine completato dal motore: PATROL per ITA-F590 in CANALE_SICILIA'))).toBe(true);
    expect(r.ambiguities.some((x) => x.includes('ITA-F590 è nominata'))).toBe(false);
    expect(r.ambiguities.some((x) => x.includes('Tunisia (TUN) è nominata'))).toBe(true);
  });

  it('9B: due CYBER_OP disruption contro la Grecia → avviso «alleato» e cyber non richiesta, SHOW_OF_FORCE completata dal motore', async () => {
    const { e, c } = await setup({ orders: { ...empty, military: [
      { id: 'o1', kind: 'CYBER_OP', target: 'GRC', targetRef: 'reti', effect: 'disruption' },
      { id: 'o2', kind: 'CYBER_OP', target: 'GRC', targetRef: 'comandi', effect: 'disruption' }] }, ambiguities: [] }, 'q9b');
    const r = await e.parseOrders(c.id, FRASE_2);
    // il validatore le accetta (la Grecia è una fazione): gli avvisi vengono dai controlli
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.risks.filter((x) => x.includes('contro Grecia (GRC), alleato (NATO, EU)'))).toHaveLength(1);
    expect(r.validation.risks.filter((x) => x.includes('non richiesta'))).toHaveLength(2);
    expect(r.orders.military.find((o) => o.kind === 'SHOW_OF_FORCE')).toMatchObject({ unitIds: ['ITA-CAVOUR'], zoneId: 'IONIO' });
    expect(r.ambiguities.some((x) => x.startsWith('Ordine completato dal motore: SHOW_OF_FORCE per ITA-CAVOUR in IONIO'))).toBe(true);
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

  it('mock con l\'errore dei modelli locali (postura al posto dell\'ordine, niente sul rientro): le frasi con unità nominate sono corrette', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'banco', seed: 'banco' });
    for (const n of [1, 2, 3, 4, 5, 12, 13]) {
      const pc = PARSER_CASES[n - 1]!;
      const r = await e.parseOrders(c.id, pc.text);
      // merito dei punti 1 e 2: l'ordine viene da una postura (unità nominata per prima) o dal completamento del motore
      expect(r.stanceOrders.length > 0 || r.ambiguities.some((x) => x.startsWith('Ordine completato dal motore')), `#${n}`).toBe(true);
      expect(scoreParsed(pc, r), `#${n} ${pc.text}`).toEqual({ verdict: 'corretto', reasons: [] });
    }
  });

  it('4B → sbagliato, 9B → pericoloso, risposta giusta → corretto', async () => {
    const run = async (reply: unknown, text: string, seed: string) => {
      const e = makeEngine(new ScriptedParser(reply));
      const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
      return scoreParsed(PARSER_CASES.find((x) => x.text === text)!, await e.parseOrders(c.id, text));
    };
    const q4b = await run({ orders: { ...empty, diplomacy: [{ id: 'd1', kind: 'DEMARCHE', target: 'CANALE_SICILIA', message: 'x', visibility: 'public' }] } }, FRASE_1, 's4b');
    expect(q4b.verdict).toBe('sbagliato');
    // l'ordine alla Bergamini lo completa il motore; manca la richiesta alla Tunisia
    expect(q4b.reasons).toContain('manca DEMARCHE/BACKCHANNEL → TUN');
    expect(q4b.reasons.some((x) => x.includes('ITA-F590'))).toBe(false);
    const q9b = await run({ orders: { ...empty, military: [{ id: 'o1', kind: 'CYBER_OP', target: 'GRC', targetRef: 'reti', effect: 'disruption' }] } }, FRASE_2, 's9b');
    expect(q9b.verdict).toBe('pericoloso');
    const ok = await run({ orders: { ...empty, military: [{ id: 'm1', kind: 'SHOW_OF_FORCE', unitIds: ['ITA-CAVOUR'], zoneId: 'IONIO', roe: 'WEAPONS_TIGHT' }],
      diplomacy: [{ id: 'd1', kind: 'REASSURANCE', target: 'GRC', message: 'x', visibility: 'public' }] } }, FRASE_2, 'sok');
    expect(ok).toEqual({ verdict: 'corretto', reasons: [] });
  });
});
