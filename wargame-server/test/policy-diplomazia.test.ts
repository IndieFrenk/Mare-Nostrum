import { describe, expect, it } from 'vitest';
import { TurnCtx } from '../src/engine/context.js';
import { checkRedLines } from '../src/engine/crises.js';
import { buildKnowledge, incidentsFrom } from '../src/engine/knowledge.js';
import { decideByRules } from '../src/engine/policy.js';
import { Rng } from '../src/engine/rng.js';
import { resolveDiplomacy } from '../src/engine/diplomacy.js';
import { sc, campaign, agreement, threat } from './diplo-helpers.js';
import { setTension } from '../src/engine/opinion.js';
import { setRelation } from './helpers.js';

describe('decisore a regole: accettazione, garanzia e capitale', () => {
  it('il decisore a regole risponde con acceptance() e cita i motivi', () => {
    const s = structuredClone(sc.world);
    setRelation(s, 'EGY', 'ITA', 45);
    s.agreements['AG-X'] = agreement('AG-X', 'trade', ['ITA', 'EGY'], 'proposed');
    const geo = { zones: s.zones, bases: s.bases, infrastructure: s.infrastructure };
    const k = buildKnowledge(s, 'EGY', [], { inbox: [], news: [] });
    expect(k.diplomacy!.proposals[0]).toMatchObject({ agreementId: 'AG-X', from: 'ITA', accept: true });
    const d = decideByRules({ knowledge: k, geo, rng: new Rng('p', 0, 1) });
    expect(d.orders.diplomacy.find((a) => a.kind === 'RESPOND_AGREEMENT')).toMatchObject({ agreementId: 'AG-X', response: 'accept' });
    expect(d.rationale.find((r) => r.rule === 'agreement')!.text).toMatch(/punteggio .*Opinione verso il proponente/);
    setRelation(s, 'EGY', 'ITA', -60);
    const k2 = buildKnowledge(s, 'EGY', [], { inbox: [], news: [] });
    expect(decideByRules({ knowledge: k2, geo, rng: new Rng('p', 0, 1) }).orders.diplomacy.find((a) => a.kind === 'RESPOND_AGREEMENT')).toMatchObject({ response: 'reject' });
  });

  it('garanzia: il garante vede la linea rossa superata del garantito e risponde accanto a lui', () => {
    const s = structuredClone(sc.world);
    s.agreements['AG-GUA'] = agreement('AG-GUA', 'guarantee', ['FRA', 'ITA']);
    s.factions.ITA!.redLines.push({ id: 'RL-T', text: 'Blocco dell\'Egeo', trigger: 'crisis(EAST_MED).escalation >= 0', response: 'Risposta militare' });
    const ctx = new TurnCtx(s, campaign(), sc, new Rng('g', 0, 1), 0);
    checkRedLines(ctx);
    const ev = ctx.events.find((e) => e.type === 'RED_LINE_CROSSED' && e.payload.redLineId === 'RL-T')!;
    expect(ev.visibility).toEqual(['ITA', 'FRA']);
    const inc = incidentsFrom(ctx.events, 'FRA').find((x) => x.kind === 'red_line' && x.ref === 'RL-T')!;
    expect(inc).toMatchObject({ from: 'ITA', to: 'ITA', text: 'Blocco dell\'Egeo', response: 'Risposta militare' });
    expect(incidentsFrom(ctx.events, 'TUR').some((x) => x.ref === 'RL-T')).toBe(false);
    const k = buildKnowledge(ctx.state, 'FRA', [], { inbox: [], news: [], prevEvents: ctx.events });
    const d = decideByRules({ knowledge: k, geo: { zones: s.zones, bases: s.bases, infrastructure: s.infrastructure }, rng: new Rng('g', 0, 1) });
    expect(d.rationale.some((r) => r.text.startsWith('Garanzia a ITA'))).toBe(true);
    expect(d.orders.diplomacy.some((a) => a.kind === 'REASSURANCE' && a.target === 'ITA')).toBe(true);
  });


  /** La decisione di una fazione su un mondo (e gli eventi del turno precedente come incidenti subiti). */
  const decide = (s: ReturnType<typeof structuredClone<typeof sc.world>>, f: string, prevEvents: ReturnType<TurnCtx['events']['slice']> = []) =>
    decideByRules({ knowledge: buildKnowledge(s, f, [], { inbox: [], news: [], prevEvents }), geo: { zones: s.zones, bases: s.bases, infrastructure: s.infrastructure }, rng: new Rng('p', 0, 1) });
  const aggressive = (s: typeof sc.world, f: string) => { s.factions[f]!.policy = { aggressiveness: 1, riskTolerance: 0.5, cyberPropensity: 0, diplomacyStyle: 'assertive', zoneInterests: {}, maxStancesPerTurn: 0 }; };

  it('risponde a una minaccia con il primo gradino della scala (richiamo dell\'ambasciatore) e solo poi con le sanzioni', () => {
    const s = structuredClone(sc.world);
    aggressive(s, 'TUR');
    s.turn = 2;
    const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 1), 0);
    resolveDiplomacy(ctx, 'RUS', threat('t1', 'TUR'));
    const kinds = () => decide(s, 'TUR', ctx.events).orders.diplomacy.map((a) => a.kind);
    expect(kinds()).toContain('RECALL_AMBASSADOR');
    expect(kinds()).not.toContain('SANCTION');
    // con i rapporti già ridotti si passa alle sanzioni
    s.diplomacy!.ties['RUS|TUR'] = 'recalled';
    expect(kinds()).toContain('SANCTION');
    expect(kinds()).not.toContain('RECALL_AMBASSADOR');
  });

  it('non propone ciò che non può pagare e lo dice nella motivazione; nemmeno ciò che è in ricarica', () => {
    const s = structuredClone(sc.world);
    aggressive(s, 'TUR');
    s.turn = 2;
    const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 1), 0);
    resolveDiplomacy(ctx, 'RUS', threat('t1', 'TUR'));
    s.diplomacy!.capital.TUR = 2;
    const poor = decide(s, 'TUR', ctx.events);
    expect(poor.orders.diplomacy.some((a) => a.kind === 'RECALL_AMBASSADOR' || a.kind === 'SANCTION')).toBe(false);
    expect(poor.rationale.some((r) => /^Rinuncia a .*capitale diplomatico 2 CD, ne servono/.test(r.text))).toBe(true);
    s.diplomacy!.capital.TUR = 20;
    expect(decide(s, 'TUR', ctx.events).orders.diplomacy.some((a) => a.kind === 'RECALL_AMBASSADOR')).toBe(true);
    s.diplomacy!.cooldowns['TUR|RECALL_AMBASSADOR|RUS'] = 9;
    expect(decide(s, 'TUR', ctx.events).orders.diplomacy.some((a) => a.kind === 'RECALL_AMBASSADOR')).toBe(false);
  });

  it('migliora le relazioni con un partner di trattato dall\'opinione bassa (uno slot libero) e libera lo slot a relazioni consolidate', () => {
    const s = structuredClone(sc.world);
    setRelation(s, 'ITA', 'TUR', 5); setRelation(s, 'ITA', 'USA', 70); setRelation(s, 'ITA', 'FRA', 70); setRelation(s, 'ITA', 'GBR', 70); setRelation(s, 'ITA', 'GRC', 70); setRelation(s, 'ITA', 'ESP', 70); setRelation(s, 'ITA', 'DEU', 70);
    const d = decide(s, 'ITA');
    expect(d.orders.diplomacy.find((a) => a.kind === 'IMPROVE_RELATIONS')).toMatchObject({ target: 'TUR' });
    expect(d.rationale.some((r) => r.rule === 'relations' && r.text.includes('Partner TUR'))).toBe(true);
    // senza slot liberi non lo propone; con le relazioni già consolidate (opinione ≥ 60) libera lo slot
    s.diplomacy!.improving.push({ actor: 'ITA', target: 'EGY', since: 0 }, { actor: 'ITA', target: 'GRC', since: 0 }, { actor: 'ITA', target: 'ESP', since: 0 });
    const full = decide(s, 'ITA').orders.diplomacy;
    expect(full.some((a) => a.kind === 'IMPROVE_RELATIONS')).toBe(false);
    expect(full.filter((a) => a.kind === 'STOP_IMPROVE').map((a) => (a as { target: string }).target)).toEqual(['ESP', 'GRC']);
  });

  it('l\'ultimatum solo come risposta scritta in una linea rossa, e solo con una tensione di coppia ≥ 30; la risoluzione va al CdS per i suoi membri e all\'AG per gli altri', () => {
    const run = (f: string, response: string, trigger = 'crisis(EAST_MED).escalation >= 0', tens?: number) => {
      const s = structuredClone(sc.world);
      s.turn = 2;
      s.factions[f]!.redLines = [{ id: 'RL-T', text: 'Blocco delle acque', trigger, response }];
      if (tens !== undefined) for (const x of ['TUR', 'GRC', 'EGY', 'ISR', 'CYP']) if (x !== f) setTension(s, f, x, tens);
      const ctx = new TurnCtx(s, campaign(), sc, new Rng('p', 0, 1), 0);
      checkRedLines(ctx);
      return decide(s, f, ctx.events);
    };
    const withUlt = run('GRC', 'Ultimatum e poi risposta militare', undefined, 60);
    expect(withUlt.orders.diplomacy.find((a) => a.kind === 'ULTIMATUM')).toMatchObject({ deadlineTurns: 2 });
    expect(withUlt.rationale.some((r) => r.rule === 'red_line' && /ultimatum/i.test(r.text))).toBe(true);
    // tensione bassa: l'ultimatum non è ammesso, il decisore non lo propone
    expect(run('GRC', 'Ultimatum e poi risposta militare', undefined, 10).orders.diplomacy.some((a) => a.kind === 'ULTIMATUM')).toBe(false);
    // senza «ultimatum» nella risposta scritta mai
    expect(run('GRC', 'Risposta militare proporzionata', undefined, 60).orders.diplomacy.some((a) => a.kind === 'ULTIMATUM')).toBe(false);
    // la sede della risoluzione: Francia è membro permanente (CdS), l'Egitto no (AG)
    const fra = run('FRA', 'Portare la questione al Consiglio di sicurezza');
    expect(fra.orders.diplomacy.find((a) => a.kind === 'RESOLUTION')).toMatchObject({ forum: 'UNSC' });
    const egy = run('EGY', 'Portare la questione al Consiglio di sicurezza');
    expect(egy.orders.diplomacy.find((a) => a.kind === 'RESOLUTION')).toMatchObject({ forum: 'UNGA' });
  });
});
