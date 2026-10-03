import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LlmBudget, singleRouting } from '../src/agents/budget.js';
import type { LlmProvider, LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { LlmAgents } from '../src/agents/orchestrator.js';
import { ReplayAgents } from '../src/agents/replay.js';
import { DIRECTIVE_SCHEMA } from '../src/agents/strategist.js';
import { runSim } from '../src/cli/sim.js';
import { activeDirective, estimateTokens, isEmptyDirective, limitDirective, strategistContext, strategistPowers, strategistsOfTurn } from '../src/engine/directive.js';
import { buildKnowledge } from '../src/engine/knowledge.js';
import { decideByRules } from '../src/engine/policy.js';
import { Rng } from '../src/engine/rng.js';
import { Engine } from '../src/engine/turn-machine.js';
import { partnersOf, worldStates } from '../src/engine/world-ai.js';
import { DirectiveRecord, type Directive } from '../src/schemas/index.js';
import { JsonStore } from '../src/store/json-store.js';
import { sc } from './diplo-helpers.js';
import { setRelation, tmp } from './helpers.js';

const zones = new Set(Object.keys(sc.world.zones));
const world = () => { const s = structuredClone(sc.world); s.turn = 3; return s; };
const lim = (raw: unknown, factionId = 'USA', s = world()) => limitDirective(raw, { state: s, factionId, zones });
const neutral: Directive = { horizonTurns: 3, priorities: [], zoneInterestDelta: {}, seekAgreements: [], avoid: [], rationale: '' };

describe('direttive: chi e quando', () => {
  it('USA, CHN e RUS di sempre; con tier A si aggiungono (solo fazioni vere, non giocate dall\'umano, non blocchi)', () => {
    const s = world();
    expect(strategistPowers(s)).toEqual(['CHN', 'RUS', 'USA']);
    s.factions.FRA!.tier = 'A'; s.factions.ITA!.tier = 'A'; s.factions.NATO!.tier = 'A';
    expect(strategistPowers(s)).toEqual(['CHN', 'FRA', 'RUS', 'USA']);
  });

  it('una potenza per turno a rotazione, ognuna ogni 3 turni con 3 potenze', () => {
    const p = ['CHN', 'RUS', 'USA'];
    const seq = Array.from({ length: 9 }, (_, i) => strategistsOfTurn(i + 1, p));
    expect(seq.every((x) => x.length === 1)).toBe(true);
    for (const f of p) { const at = seq.flatMap((x, i) => (x[0] === f ? [i + 1] : [])); expect(at.map((t, i) => t - (at[i - 1] ?? t - 3))).toEqual([3, 3, 3]); }
  });

  it('ogni 3–6 turni secondo quante sono: 2 potenze → ogni 3, 5 → ogni 5, 8 → ogni 6', () => {
    const every = (n: number) => { const p = Array.from({ length: n }, (_, i) => `P${i}`); const hits = Array.from({ length: 40 }, (_, t) => strategistsOfTurn(t + 1, p).includes('P0')).flatMap((b, t) => (b ? [t + 1] : [])); return hits[1]! - hits[0]!; };
    expect([every(2), every(3), every(4), every(5), every(6), every(8)]).toEqual([3, 3, 4, 5, 6, 6]);
    expect(strategistsOfTurn(1, [])).toEqual([]);
  });

  it('la direttiva in vigore è la più recente ancora dentro il suo orizzonte', () => {
    const rec = (turn: number, h: number, limited: Directive | null) => ({ schemaVersion: 1, turn, factionId: 'USA', source: 'llm', model: 'm', promptHash: '', contextTokens: 0, request: null, response: null, proposed: null, limited: limited && { ...limited, horizonTurns: h }, limits: [], errors: [], usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 } }) as DirectiveRecord;
    const a = rec(2, 3, neutral); const b = rec(5, 4, neutral);
    expect(activeDirective([a, b], 3)).toBe(a);
    expect(activeDirective([a, b], 4)).toBe(a);
    expect(activeDirective([a, b], 5)).toBe(b); // a scade al turno 5 (2 + 3)
    expect(activeDirective([a, b], 8)).toBe(b);
    expect(activeDirective([a, b], 9)).toBeNull();
    expect(activeDirective([rec(5, 4, null)], 6)).toBeNull();
  });
});

describe('direttive: il motore limita', () => {
  it('pesi, scarti e orizzonte fuori scala vengono riportati nei limiti', () => {
    const r = lim({ horizonTurns: 12, priorities: [{ kind: 'court', target: 'FRA', weight: 1.7 }, { kind: 'deter', target: 'RUS', weight: -2 }, { kind: 'contain', target: 'CHN', weight: 0.4 }],
      zoneInterestDelta: { MAR_NERO: 0.9, CANALE_SICILIA: -0.5 }, seekAgreements: [], avoid: [], rationale: 'x' });
    expect(r.directive.horizonTurns).toBe(6);
    expect(r.directive.priorities).toEqual([{ kind: 'court', target: 'FRA', weight: 1 }, { kind: 'contain', target: 'CHN', weight: 0.4 }]); // il peso negativo diventa 0 e la priorità cade
    expect(r.directive.zoneInterestDelta).toEqual({ MAR_NERO: 0.2, CANALE_SICILIA: -0.2 });
    expect(r.notes.join('|')).toMatch(/orizzonte 12 → 6/);
    expect(r.notes.join('|')).toMatch(/peso 1\.7 → 1/);
    expect(r.notes.join('|')).toMatch(/scarto d'interesse MAR_NERO 0\.9 → 0\.2/);
  });

  it('un bersaglio inesistente (o la potenza stessa, o un blocco) è scartato, non fa fallire la direttiva', () => {
    const r = lim({ horizonTurns: 4, priorities: [{ kind: 'court', target: 'ATLANTIDE', weight: 0.8 }, { kind: 'isolate', target: 'USA', weight: 0.8 }, { kind: 'deter', target: 'NATO', weight: 0.8 }, { kind: 'improve', target: 'FRA', weight: 0.5 }],
      avoid: ['XXX', 'RUS'], seekAgreements: [{ type: 'trade', with: 'ZZZ' }] });
    expect(r.directive.priorities).toEqual([{ kind: 'improve', target: 'FRA', weight: 0.5 }]);
    expect(r.directive.avoid).toEqual(['RUS']);
    expect(r.directive.seekAgreements).toEqual([]);
    expect(r.notes.filter((n) => /inesistente/.test(n))).toHaveLength(5);
    // uno Stato del registro senza fazione esiste
    expect(lim({ priorities: [{ kind: 'court', target: 'IND', weight: 0.5 }] }).directive.priorities).toEqual([{ kind: 'court', target: 'IND', weight: 0.5 }]);
  });

  it('tipi di accordo non ammessi e zone sconosciute si scartano; liste ai tetti; somma dei pesi ≤ 2', () => {
    const r = lim({ horizonTurns: 3, seekAgreements: [{ type: 'defense', with: 'FRA' }, { type: 'trade', with: 'FRA' }, { type: 'trade', with: 'FRA' }, { type: 'non_aggression', with: 'GBR' }, { type: 'intel_sharing', with: 'TUR' }],
      zoneInterestDelta: { MARTE: 0.1, MAR_NERO: 0.1, CANALE_SICILIA: 0.15, MED_OCCIDENTALE: 0.05, LEVANTE: 0.2 },
      priorities: ['FRA', 'GBR', 'TUR', 'EGY', 'ISR'].map((target, i) => ({ kind: 'improve', target, weight: 0.9 - i * 0.1 })), avoid: ['CHN', 'RUS', 'IRN'] });
    expect(r.directive.seekAgreements).toEqual([{ type: 'trade', with: 'FRA' }, { type: 'non_aggression', with: 'GBR' }]);
    expect(Object.keys(r.directive.zoneInterestDelta).length).toBeLessThanOrEqual(3);
    expect(r.directive.zoneInterestDelta.MARTE).toBeUndefined();
    expect(r.directive.priorities).toHaveLength(4);
    expect(r.directive.priorities.reduce((a, p) => a + p.weight, 0)).toBeLessThanOrEqual(2);
    expect(r.directive.avoid).toHaveLength(2);
    expect(r.notes.join('|')).toMatch(/tipo di accordo «defense» non ammesso/);
  });

  it('priorità contrastanti sullo stesso bersaglio: resta la più pesante; da evitare non può essere da avvicinare', () => {
    const r = lim({ priorities: [{ kind: 'court', target: 'FRA', weight: 0.3 }, { kind: 'isolate', target: 'FRA', weight: 0.7 }, { kind: 'improve', target: 'GBR', weight: 0.5 }], avoid: ['GBR', 'RUS'] });
    expect(r.directive.priorities).toEqual([{ kind: 'isolate', target: 'FRA', weight: 0.7 }, { kind: 'improve', target: 'GBR', weight: 0.5 }]);
    expect(r.directive.avoid).toEqual(['RUS']);
  });

  it('la motivazione si taglia a 60 parole; la spazzatura non rompe niente', () => {
    expect(lim({ rationale: Array.from({ length: 90 }, () => 'ab').join(' ') }).directive.rationale.split(' ')).toHaveLength(60);
    expect(lim({ rationale: Array.from({ length: 90 }, (_, i) => `parola${i}`).join(' ') }).directive.rationale.length).toBeLessThanOrEqual(420); // e comunque ≤ 420 caratteri
    for (const junk of [null, 'ciao', 42, [], { priorities: 'tutti', zoneInterestDelta: [1], seekAgreements: {}, avoid: 7 }]) {
      const r = lim(junk);
      expect(isEmptyDirective(r.directive)).toBe(true);
      expect(r.directive.horizonTurns).toBe(3);
    }
  });

  it('è idempotente: una direttiva già limitata torna uguale e senza note (il replay la rilegge così)', () => {
    const once = lim({ horizonTurns: 9, priorities: [{ kind: 'court', target: 'FRA', weight: 3 }, { kind: 'deter', target: 'RUS', weight: 1.4 }, { kind: 'contain', target: 'ATLANTIDE', weight: 1 }], zoneInterestDelta: { MAR_NERO: 0.7 }, avoid: ['CHN'], rationale: 'x' });
    const twice = lim(once.directive);
    expect(twice.directive).toEqual(once.directive);
    expect(twice.notes).toEqual([]);
  });

  it('lo schema inviato al modello porta i tetti (maxItems, maxLength, al massimo 3 zone)', () => {
    const s = DIRECTIVE_SCHEMA as { properties: Record<string, { maxItems?: number; maxLength?: number; maxProperties?: number }> };
    expect(s.properties.priorities!.maxItems).toBe(4);
    expect(s.properties.seekAgreements!.maxItems).toBe(2);
    expect(s.properties.avoid!.maxItems).toBe(2);
    expect(s.properties.zoneInterestDelta!.maxProperties).toBe(3);
    expect(s.properties.rationale!.maxLength).toBe(420);
  });
});

describe('direttive: il contesto', () => {
  it('≤ 1.200 token, solo dalla Knowledge: 10 righe d\'opinione con le fasce, crisi, incidenti, trattati, direttiva precedente', () => {
    const s = world();
    setRelation(s, 'USA', 'CHN', -55, 60);
    const k = buildKnowledge(s, 'USA', [], { inbox: [], news: [], prevEvents: [] });
    const c = strategistContext(k, { ...neutral, priorities: [{ kind: 'court', target: 'FRA', weight: 0.5 }] }, { CHN: 'Cina' });
    expect(c.tokens).toBeLessThanOrEqual(1200);
    expect(estimateTokens(c.text)).toBe(c.tokens);
    const j = JSON.parse(c.text);
    expect(j.relazioni.length).toBeLessThanOrEqual(10);
    expect(j.relazioni.find((r: { con: string }) => r.con === 'CHN')).toMatchObject({ nome: 'Cina', opinione: -55, fascia: 'ostile', tensione: 60 });
    expect(j.relazioni.every((r: { fascia: string; tiVede: string }) => !!r.fascia && !!r.tiVede)).toBe(true);
    expect(j.direttivaPrecedente.priorita).toEqual(['court FRA 0.5']);
    expect(c.targets).toEqual(j.relazioni.map((r: { con: string }) => r.con));
    // niente di ciò che la fazione non sa: la verità di terra (unità altrui, contatti reali) non c'è
    expect(c.text).not.toMatch(/truthUnitId|ownUnits|loadout/);
  });

  it('una situazione enorme si stringe finché sta nel tetto', () => {
    const s = world();
    const k = buildKnowledge(s, 'USA', [], { inbox: [], news: [], prevEvents: [] });
    const big = structuredClone(k);
    big.incidents = Array.from({ length: 200 }, (_, i) => ({ turn: 3, kind: 'threat' as const, from: 'RUS', to: 'USA', ref: `x${i}`, zoneId: 'MAR_NERO', text: 'y'.repeat(300) }));
    big.knownCrises = Array.from({ length: 60 }, (_, i) => ({ ...k.knownCrises[0]!, id: `C${i}`, title: 'z'.repeat(400), involved: Array(8).fill('RUS') }));
    big.ownFaction.name = 'N'.repeat(2000);
    expect(strategistContext(big, null).tokens).toBeLessThanOrEqual(1200 + 600); // il nome della fazione non si taglia: il resto sì
    const reasonable = structuredClone(k);
    reasonable.knownCrises = Array.from({ length: 12 }, (_, i) => ({ ...k.knownCrises[0]!, id: `C${i}`, title: 'crisi lunga '.repeat(8), involved: ['RUS', 'TUR', 'GRC'] }));
    expect(strategistContext(reasonable, null).tokens).toBeLessThanOrEqual(1200);
  });
});

describe('direttive: effetto sul decisore a regole', () => {
  const decide = (d?: Directive) => {
    const s = world(); s.factions.TUR!.policy = { aggressiveness: 0.9, riskTolerance: 0.5, cyberPropensity: 0, diplomacyStyle: 'formal', zoneInterests: {}, maxStancesPerTurn: 0 };
    return decideByRules({ knowledge: buildKnowledge(s, 'TUR', [], { inbox: [], news: [] }), geo: { zones: s.zones, bases: s.bases, infrastructure: s.infrastructure }, rng: new Rng('p', 0, 2), ...(d ? { directive: d } : {}) });
  };
  it('le mosse spinte dalla direttiva hanno una motivazione con regola «directive»', () => {
    const plain = decide();
    expect(plain.rationale.some((r) => r.rule === 'directive')).toBe(false);
    const d = decide({ ...neutral, seekAgreements: [{ type: 'trade', with: 'EGY' }] });
    expect(d.orders.diplomacy.some((a) => a.kind === 'PROPOSE_AGREEMENT')).toBe(true);
    expect(d.rationale.some((r) => r.rule === 'directive' && /^Direttiva: proposta di tregua verso/.test(r.text))).toBe(true);
  });
});

/** Campagne complete: la direttiva viaggia nel registro, il replay la rilegge senza LLM, senza budget non ce n'è e il gioco va avanti. */
describe('direttive: il turno, il registro e il replay', () => {
  const play = async (calls: number, turns: number, provider: LlmProvider = new MockLLMProvider()) => {
    const store = new JsonStore(tmp());
    const e = new Engine(store, new LlmAgents(provider, new LlmBudget(singleRouting(provider), { callsPerTurn: calls })));
    const c = await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'dir', seed: 'direttive', config: { factionMode: 'rules' } }), turns);
    return { e, store, c: c.campaign };
  };
  const records = async (store: JsonStore, id: string, turns: number) => (await Promise.all(Array.from({ length: turns }, (_, i) => store.listDirectives(id, i + 1)))).flat();

  it('una potenza per turno a rotazione, con richiesta, risposta e versione limitata nel registro', async () => {
    const { store, c } = await play(10, 6);
    const all = await records(store, c.id, 6);
    expect(all.map((r) => `${r.turn}:${r.factionId}`)).toEqual(['1:RUS', '2:USA', '3:CHN', '4:RUS', '5:USA', '6:CHN']);
    for (const r of all) {
      expect(DirectiveRecord.parse(r)).toBeTruthy();
      expect(r).toMatchObject({ source: 'llm', model: 'mock' });
      expect(r.contextTokens).toBeLessThanOrEqual(1200);
      expect(r.request!.system).toContain('INTENZIONI');
      expect(JSON.parse(r.response!).priorities).toBeDefined();
      expect(r.limited!.horizonTurns).toBeGreaterThanOrEqual(3);
      expect(r.limits).toEqual([]); // il mock propone solo id del contesto
    }
    // il decisore ha letto la direttiva in vigore: la decisione la registra
    const d = await store.getDecision(c.id, 3, 'USA');
    expect(d!.directive).toEqual(all.find((r) => r.turn === 2)!.limited);
    expect(readdirSync(store.dir(c.id, 'directives')).sort()).toEqual(['turn-0001', 'turn-0002', 'turn-0003', 'turn-0004', 'turn-0005', 'turn-0006']);
  }, 120_000);

  it('una direttiva con un bersaglio inventato: il motore scarta la voce e lo scrive nel registro', async () => {
    const liar: LlmProvider = { name: 'bugiardo', async complete(req: LlmRequest) {
      if (req.role !== 'strategist') return new MockLLMProvider().complete(req);
      const body = JSON.stringify({ horizonTurns: 9, priorities: [{ kind: 'court', target: 'ATLANTIDE', weight: 1 }, { kind: 'improve', target: 'FRA', weight: 4 }], zoneInterestDelta: { MAR_NERO: 0.9 }, seekAgreements: [], avoid: [], rationale: 'ok' });
      return { text: body, usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'bugiardo' };
    } };
    const { store, c } = await play(10, 2, liar);
    const r = (await records(store, c.id, 2)).find((x) => x.factionId === 'USA')!;
    expect(r.limited).toMatchObject({ horizonTurns: 6, priorities: [{ kind: 'improve', target: 'FRA', weight: 1 }], zoneInterestDelta: { MAR_NERO: 0.2 } });
    expect(r.limits.some((l) => /ATLANTIDE/.test(l))).toBe(true);
    expect(r.proposed).toMatchObject({ horizonTurns: 9 }); // la proposta resta com'era, accanto alla versione limitata
  }, 120_000);

  it('tutte le voci inventate: un repair, poi nessuna direttiva (effetto nullo) e il turno va avanti', async () => {
    let calls = 0;
    const liar: LlmProvider = { name: 'bugiardo', async complete(req: LlmRequest) {
      if (req.role !== 'strategist' && !(req.role === 'repair' && req.meta.repairOf === 'strategist')) return new MockLLMProvider().complete(req);
      calls++;
      return { text: JSON.stringify({ horizonTurns: 4, priorities: [{ kind: 'court', target: 'ATLANTIDE', weight: 1 }], rationale: '' }), usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'bugiardo' };
    } };
    const { store, c } = await play(10, 2, liar);
    const recs = await records(store, c.id, 2);
    expect(recs.every((r) => r.source === 'none' && r.limited === null)).toBe(true);
    expect(recs[0]!.errors.join(' ')).toMatch(/nessuna voce valida/);
    expect(calls).toBe(recs.length * 2); // la richiesta e UN repair per potenza
    expect((await store.getDecision(c.id, 2, 'USA'))!.directive).toBeUndefined();
  }, 120_000);

  it('senza budget (LLM_BUDGET_CALLS=0) nessuna direttiva: il gioco continua con le regole di sempre', async () => {
    const mock = new MockLLMProvider();
    const { store, c } = await play(0, 4, mock);
    expect(mock.calls).toBe(0);
    const recs = await records(store, c.id, 4);
    expect(recs.length).toBe(4);
    expect(recs.every((r) => r.source === 'none' && r.limited === null && r.errors[0]!.includes('LLM_BUDGET_CALLS=0'))).toBe(true);
    expect((await store.getDecision(c.id, 3, 'USA'))!.directive).toBeUndefined();
  }, 120_000);

  /** replay: stesso stato e stesse decisioni, la direttiva viene dal registro, nessuna chiamata LLM */
  const replayOf = async (store: JsonStore, e: Engine, srcId: string, turns: number) => {
    const src = await store.getCampaign(srcId);
    const replay = new Engine(store, new ReplayAgents(store, src.id));
    const c = await replay.createCampaign({ scenarioId: src.scenarioId, name: 'rep', seed: src.seed, config: src.config });
    return runSim(replay, c, turns, async (t) => { const o = await store.getOrders(src.id, t, 'ITA'); if (o) await store.saveOrders(c.id, o); });
  };
  for (const [name, calls] of [['con le direttive del modello', 10], ['senza LLM (budget 0)', 0]] as const) {
    it(`replay identico ${name}`, async () => {
      const { e, store, c: src } = await play(calls, 6);
      const r = await replayOf(store, e, src.id, 6);
      for (let t = 1; t <= 6; t++) {
        expect(await store.getState(r.campaign.id, t)).toEqual(await store.getState(src.id, t));
        expect(await store.getRolls(r.campaign.id, t)).toEqual(await store.getRolls(src.id, t));
        const [a, b] = [await store.listDirectives(src.id, t), await store.listDirectives(r.campaign.id, t)];
        expect(b.map((x) => x.limited)).toEqual(a.map((x) => x.limited));
        for (const f of ['USA', 'CHN', 'RUS', 'TUR']) {
          const [da, db] = [await store.getDecision(src.id, t, f), await store.getDecision(r.campaign.id, t, f)];
          expect({ ...db, orders: { ...db!.orders, source: 'x' } }).toEqual({ ...da, orders: { ...da!.orders, source: 'x' } });
        }
        expect(await store.getWorldDecision(r.campaign.id, t)).toEqual(await store.getWorldDecision(src.id, t));
      }
      expect(readdirSync(store.dir(r.campaign.id)).includes('llm-log')).toBe(false);
    }, 180_000);
  }
});

describe('direttive: effetto sull\'IA mondiale', () => {
  it('uno Stato corteggiato (improve/court) da una potenza la considera più volentieri partner, in proporzione al peso; le altre priorità no', () => {
    const s = world();
    const n = worldStates().find((x) => x.iso3 === 'IND')!;
    const score = (dirs: { faction: string; directive: Directive }[], who = 'CHN') => partnersOf(s, n, 'ITA', dirs).find((p) => p.actor === who)?.score ?? 0;
    const base = score([]);
    const dir = (kind: Directive['priorities'][number]['kind'], weight: number) => [{ faction: 'CHN', directive: { ...neutral, priorities: [{ kind, target: 'IND', weight }] } }];
    expect(score(dir('court', 1))).toBeCloseTo(base + 25, 5);
    expect(score(dir('improve', 0.4))).toBeCloseTo(base + 10, 5);
    expect(score(dir('isolate', 1))).toBe(base);
    expect(score(dir('court', 1), 'USA')).toBe(score([], 'USA'));
    // il bonus può portare la potenza in cima ai partner dello Stato
    const top = partnersOf(s, n, 'ITA', [{ faction: 'BRA', directive: { ...neutral, priorities: [{ kind: 'court', target: 'IND', weight: 1 }] } }]);
    expect(top[0]!.actor === 'BRA' || top.some((p) => p.actor === 'BRA')).toBe(true);
  });
});
