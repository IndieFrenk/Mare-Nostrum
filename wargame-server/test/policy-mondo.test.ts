import { describe, expect, it } from 'vitest';
import type { Directive, GameEvent } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { buildKnowledge } from '../src/engine/knowledge.js';
import { decideByRules } from '../src/engine/policy.js';
import { Rng } from '../src/engine/rng.js';
import { campaign, sc } from './diplo-helpers.js';
import { setRelation } from './helpers.js';
import { worldData } from '../src/engine/world-data.js';

const base = () => { const s = structuredClone(sc.world); s.turn = 2; return s; };
const prudent = { aggressiveness: 0.2, riskTolerance: 0.5, cyberPropensity: 0, diplomacyStyle: 'formal' as const, zoneInterests: {}, maxStancesPerTurn: 0 };
const decide = (s: ReturnType<typeof base>, f: string, prevEvents: GameEvent[] = [], directive?: Directive) =>
  decideByRules({ knowledge: buildKnowledge(s, f, [], { inbox: [], news: [], prevEvents }), geo: { zones: s.zones, bases: s.bases, infrastructure: s.infrastructure }, rng: new Rng('p', 0, 2), ...(directive ? { directive } : {}) });
const reaction = (s: ReturnType<typeof base>, actor: string, victim: string, condemn: string[]) => {
  const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 2), 0);
  ctx.emit('INTERNATIONAL_REACTIONS', 'world', { eventRef: 'A1-1', kind: 'strike', actor, victim, severity: 5, condemn, support: [], silent: [], modifiers: [] }, { visibility: 'public' });
  return ctx.events;
};

describe('decisore a regole: reazioni del mondo (livelli A e B)', () => {
  const crowd = worldData().nations.slice(0, 40).map((n) => n.iso3).filter((x) => x !== 'TUR' && x !== 'GRC');

  it('legge l\'opinione (non un trust grezzo): alleato = opinione ≥ allyOpinion, avversario = opinione bassa e tensione alta', () => {
    const s = base();
    setRelation(s, 'EGY', 'ITA', 45, 10);
    setRelation(s, 'EGY', 'ISR', -40, 70);
    s.agreements = {}; // nessun accordo di difesa: conta solo l'opinione
    s.factions.EGY!.policy = { ...prudent, cyberPropensity: 1 };
    const k = buildKnowledge(s, 'EGY', [], { inbox: [], news: [] });
    expect(k.ownRelations.ITA!.trust).toBe(45);
    expect(k.ownRelations.ISR).toMatchObject({ trust: -40, tension: 70 });
  });

  it('un profilo prudente condannato da molti Stati cerca la distensione con la vittima e migliora le relazioni con un critico influente', () => {
    const s = base(); s.factions.TUR!.policy = prudent;
    const d = decide(s, 'TUR', reaction(s, 'TUR', 'GRC', crowd.concat(['FRA'])));
    expect(d.orders.diplomacy.some((a) => (a.kind === 'REASSURANCE' || a.kind === 'BACKCHANNEL') && a.target === 'GRC')).toBe(true);
    expect(d.rationale.some((r) => r.rule === 'detente' && /^Condannata da \d+ Stati dopo strike su GRC/.test(r.text))).toBe(true);
    // senza reazioni nessuna di queste azioni (la fazione non è sotto accusa)
    const calm = decide(s, 'TUR');
    expect(calm.rationale.some((r) => r.text.startsWith('Condannata'))).toBe(false);
  });

  it('i profili aggressivi non cedono; se i condannatori sono pochi non scatta nulla; riguarda solo chi è l\'attore', () => {
    const s = base(); s.factions.TUR!.policy = { ...prudent, aggressiveness: 0.9 };
    expect(decide(s, 'TUR', reaction(s, 'TUR', 'GRC', crowd)).rationale.some((r) => r.text.startsWith('Condannata'))).toBe(false);
    s.factions.TUR!.policy = prudent;
    expect(decide(s, 'TUR', reaction(s, 'TUR', 'GRC', crowd.slice(0, 5))).rationale.some((r) => r.text.startsWith('Condannata'))).toBe(false);
    // la vittima (GRC) non è «condannata»: la reazione non la riguarda come attore
    s.factions.GRC!.policy = prudent;
    expect(decide(s, 'GRC', reaction(s, 'TUR', 'GRC', crowd)).rationale.some((r) => r.text.startsWith('Condannata'))).toBe(false);
  });

  it('una condanna approvata in AG contro la fazione ha lo stesso effetto per i profili prudenti', () => {
    const s = base(); s.factions.TUR!.policy = prudent;
    const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 2), 0);
    ctx.emit('INSTITUTION_VOTE', 'GRC', { forum: 'UNGA', institutionId: 'UNGA', subject: 'Condanna', topic: 'aggression', proposer: 'GRC', target: 'TUR', passed: true, yes: crowd, no: ['PRK'], abstain: [] }, { targets: ['TUR'] });
    const d = decide(s, 'TUR', ctx.events);
    expect(d.rationale.some((r) => /^Condannata in UNGA \(\d+ sì, 1 no\)/.test(r.text))).toBe(true);
    expect(d.orders.diplomacy.some((a) => (a.kind === 'REASSURANCE' || a.kind === 'BACKCHANNEL') && a.target === 'GRC')).toBe(true);
  });
});

describe('decisore a regole: punto d\'ingresso della direttiva', () => {
  const neutral: Directive = { horizonTurns: 3, priorities: [], zoneInterestDelta: {}, seekAgreements: [], avoid: [], rationale: '' };

  it('senza direttiva e con la direttiva deterministica (nessuna priorità) la decisione è identica', () => {
    const s = base();
    const a = decide(s, 'ITA'); const b = decide(s, 'ITA', [], neutral);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('le priorità danno un bonus alle azioni del loro tipo verso il bersaglio; avoid lo toglie alle azioni ostili', () => {
    const s = base(); s.factions.TUR!.policy = { ...prudent, aggressiveness: 0.9 };
    const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 2), 0);
    ctx.relate('RUS', 'TUR', -25, 25, 'strike su UNITA', { incident: true });
    const plain = decide(s, 'TUR', ctx.events);
    expect(plain.orders.diplomacy.some((a) => a.kind === 'RECALL_AMBASSADOR' && a.target === 'RUS')).toBe(true);
    const isolate = decide(s, 'TUR', ctx.events, { ...neutral, priorities: [{ kind: 'isolate', target: 'RUS', weight: 1 }] });
    expect(isolate.rationale.find((r) => r.text.includes('richiamo dell\'ambasciatore'))!.text).toMatch(/\[direttiva \+15\]/);
    expect(isolate.optionsConsidered.find((o) => o.label.includes('richiamo dell\'ambasciatore'))!.expectedGain)
      .toBeGreaterThan(plain.optionsConsidered.find((o) => o.label.includes('richiamo dell\'ambasciatore'))!.expectedGain);
    const avoid = decide(s, 'TUR', ctx.events, { ...neutral, avoid: ['RUS'] });
    expect(avoid.optionsConsidered.find((o) => o.label.includes('richiamo dell\'ambasciatore'))!.expectedGain)
      .toBeLessThan(plain.optionsConsidered.find((o) => o.label.includes('richiamo dell\'ambasciatore'))!.expectedGain);
  });

  it('gli accordi cercati diventano proposte (con costo e ricarica come le altre) e l\'interesse per zona si ritocca', () => {
    const s = base();
    const d = decide(s, 'ITA', [], { ...neutral, seekAgreements: [{ type: 'trade', with: 'EGY' }] });
    const prop = d.orders.diplomacy.find((a) => a.kind === 'PROPOSE_AGREEMENT');
    expect(prop).toMatchObject({ target: ['EGY'], agreement: { type: 'trade' } });
    expect(d.rationale.some((r) => r.text === 'Direttiva: cercare un accordo trade con EGY')).toBe(true);
    // già esistente o proposto: non si ripropone
    s.agreements['AG-T'] = { id: 'AG-T', type: 'trade', parties: ['ITA', 'EGY'], terms: 'x', startTurn: 0, endTurn: null, visibility: 'public', status: 'active' };
    expect(decide(s, 'ITA', [], { ...neutral, seekAgreements: [{ type: 'trade', with: 'EGY' }] }).orders.diplomacy.some((a) => a.kind === 'PROPOSE_AGREEMENT')).toBe(false);
    // zona di interesse ritoccata: una zona sotto la soglia minima d'interesse (0,3) entra tra le pattuglie di routine se la direttiva ne alza l'interesse di 0,2
    const s2 = base(); s2.factions.TUR!.objectives = []; s2.factions.TUR!.policy = { ...prudent, maxStancesPerTurn: 2, zoneInterests: { MED_OCCIDENTALE: 0.2 } };
    expect(decide(s2, 'TUR').zoneStances.some((z) => z.zoneId === 'MED_OCCIDENTALE')).toBe(false);
    expect(decide(s2, 'TUR', [], { ...neutral, zoneInterestDelta: { MED_OCCIDENTALE: 0.2 } }).zoneStances.some((z) => z.zoneId === 'MED_OCCIDENTALE')).toBe(true);
  });
});
