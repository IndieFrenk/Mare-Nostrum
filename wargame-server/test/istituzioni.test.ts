import { describe, expect, it } from 'vitest';
import type { Campaign, WorldState } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { checkAction } from '../src/engine/diplo-actions.js';
import { resolveDiplomacy } from '../src/engine/diplomacy.js';
import { runVote, tally, voteScore } from '../src/engine/institutions.js';
import { opinionOf } from '../src/engine/opinion.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { worldData } from '../src/engine/world-data.js';
import { setRelation } from './helpers.js';

const sc = loadScenario('med-2026');
const fresh = () => { const s = structuredClone(sc.world); s.turn = 1; return s; };
const ctxOf = (mutate?: (s: WorldState) => void) => {
  const s = fresh(); mutate?.(s);
  return new TurnCtx(s, { turnLength: 'week', playerFaction: 'ITA', seed: 's', rngCursor: 0, phase: 'ADJUDICATION', currentTurn: 1 } as unknown as Campaign, sc, new Rng('istituzioni', 0, 1), 0);
};
/** Porta uno Stato a votare contro il proponente e con il bersaglio (opinioni estreme): vota no. */
const hostile = (s: WorldState, iso: string, proposer: string, target: string) => { setRelation(s, iso, proposer, -100); setRelation(s, iso, target, 100); };

describe('istituzioni: le regole di decisione vengono dal registro', () => {
  it('le sedi sono le istituzioni del registro, con la loro regola: CdS con veto, AG maggioranza, UE QMV, NATO consenso', () => {
    const w = worldData();
    expect(w.institution('UNSC')).toMatchObject({ decision: 'unsc' }); expect(w.institution('UNSC')!.members).toHaveLength(15);
    expect(w.institution('UNSC')!.leaders.sort()).toEqual(['CHN', 'FRA', 'GBR', 'RUS', 'USA']);
    expect(w.institution('UNGA')).toMatchObject({ decision: 'majority' }); expect(w.institution('UNGA')!.members.length).toBeGreaterThan(190);
    expect(w.institution('EU')).toMatchObject({ decision: 'qmv' }); expect(w.institution('NATO')).toMatchObject({ decision: 'consensus' });
    expect(['ARAB_LEAGUE', 'AU'].map((i) => w.institution(i)!.decision)).toEqual(['consensus', 'consensus']);
  });

  it('CdS: servono 9 voti e nessun veto dei permanenti; un permanente che si astiene non blocca', () => {
    const s = fresh();
    // proposta del Regno Unito contro la Russia: veto russo
    const r = runVote(s, 'UNSC', { proposer: 'GBR', target: 'RUS', topic: 'aggression' });
    expect(r.vetoes).toEqual(['RUS']); expect(r.passed).toBe(false); expect(r.yes.length).toBeGreaterThanOrEqual(9);
    // senza bersaglio (tema umanitario) passa all'unanimità
    const h = runVote(s, 'UNSC', { proposer: 'FRA', topic: 'humanitarian' });
    expect(h.passed).toBe(true); expect(h.yes).toHaveLength(15); expect(h.vetoes).toEqual([]);
    // una risoluzione che nessuno appoggia: sotto 9 voti non passa, anche senza veto
    const few = fresh();
    for (const iso of worldData().institution('UNSC')!.members.filter((x) => x !== 'FRA')) hostile(few, iso, 'FRA', 'TUR');
    const f = runVote(few, 'UNSC', { proposer: 'FRA', target: 'TUR', topic: 'sanctions' });
    expect(f.yes.length).toBeLessThan(9); expect(f.passed).toBe(false);
  });

  it('AG: maggioranza semplice dei votanti, gli astenuti non contano', () => {
    const s = fresh();
    const ok = runVote(s, 'UNGA', { proposer: 'ITA', topic: 'humanitarian' });
    expect(ok.passed).toBe(true); expect(ok.yes.length + ok.no.length + ok.abstain.length).toBe(worldData().institution('UNGA')!.members.length);
    // più no che sì: respinta anche con tanti astenuti
    const bad = fresh();
    for (const iso of worldData().institution('UNGA')!.members.filter((x) => x !== 'ITA')) hostile(bad, iso, 'ITA', 'TUR');
    const r = runVote(bad, 'UNGA', { proposer: 'ITA', target: 'TUR', topic: 'sanctions' });
    expect(r.no.length).toBeGreaterThan(r.yes.length); expect(r.passed).toBe(false);
  });

  it('UE: unanimità per sanzioni e politica estera (l\'astensione non blocca), maggioranza qualificata per il resto', () => {
    const eu = worldData().institution('EU')!.members;
    expect(eu).toHaveLength(27);
    expect(runVote(fresh(), 'EU_COUNCIL', { proposer: 'ITA', target: 'RUS', topic: 'sanctions' }).passed).toBe(true);
    // il bersaglio vota no: con le sanzioni (unanimità) la proposta cade, con un tema da QMV passa lo stesso
    const sanc = runVote(fresh(), 'EU_COUNCIL', { proposer: 'ITA', target: 'HUN', topic: 'sanctions' });
    expect(sanc.no).toEqual(['HUN']); expect(sanc.passed).toBe(false); expect(sanc.rule).toMatch(/unanimità/);
    const other = runVote(fresh(), 'EU_COUNCIL', { proposer: 'ITA', target: 'HUN', topic: 'other' });
    expect(other.passed).toBe(true); expect(other.rule).toMatch(/maggioranza qualificata/);
    // regola pura: l'unanimità non conta gli astenuti, la QMV sì (55% degli Stati e 65% della popolazione)
    expect(tally('EU', 'sanctions', eu.slice(0, 20), [], eu.slice(20)).passed).toBe(true);
    expect(tally('EU', 'sanctions', eu.slice(0, 26), ['HUN'], []).passed).toBe(false);
    const byPop = [...eu].sort((a, b) => worldData().nation(b)!.population - worldData().nation(a)!.population);
    expect(tally('EU', 'other', byPop.slice(0, 15), byPop.slice(15), []).passed).toBe(true); // 15/27 = 55,6% degli Stati e quasi tutta la popolazione
    expect(tally('EU', 'other', byPop.slice(0, 14), [], byPop.slice(14)).passed).toBe(false); // 14/27 = 51,9%: gli astenuti contano come no
    const big = byPop.slice(0, 5), small = byPop.slice(5);
    expect(tally('EU', 'other', small.slice(0, 16), big, small.slice(16)).passed).toBe(false); // maggioranza di Stati (16/27), ma meno del 65% della popolazione
  });

  it('NATO, Lega Araba, UA: consenso — un solo no blocca, l\'astensione no', () => {
    expect(runVote(fresh(), 'NATO', { proposer: 'ITA', target: 'RUS', topic: 'aggression' })).toMatchObject({ passed: true, rule: expect.stringMatching(/consenso/) });
    const r = runVote(fresh(), 'NATO', { proposer: 'ITA', target: 'TUR', topic: 'aggression' });
    expect(r.no).toEqual(['TUR']); expect(r.passed).toBe(false);
    expect(runVote(fresh(), 'ARAB_LEAGUE', { proposer: 'EGY', target: 'SYR', topic: 'aggression' }).passed).toBe(false);
    expect(tally('ARAB_LEAGUE', 'other', ['EGY'], [], ['SYR', 'LBN']).passed).toBe(true);
    expect(tally('AU', 'other', ['EGY'], ['ETH'], []).passed).toBe(false);
    expect(runVote(fresh(), 'AU', { proposer: 'EGY', topic: 'humanitarian' }).passed).toBe(true);
  });

  it('il voto è deterministico e ha motivi: opinione, vicinanza, blocco, tema; il proponente vota sì e il bersaglio no', () => {
    const s = fresh();
    expect(voteScore(s, 'ITA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' }).vote).toBe('yes');
    expect(voteScore(s, 'RUS', { proposer: 'ITA', target: 'RUS', topic: 'aggression' }).vote).toBe('no');
    const v = voteScore(s, 'FRA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' });
    expect(v.vote).toBe('yes');
    expect(v.reasons.map((r) => r.label)).toEqual(expect.arrayContaining(['Opinione verso il proponente', 'Opinione verso il bersaglio', 'Coesione del blocco']));
    expect(Math.round(v.reasons.reduce((a, r) => a + r.value, 0) * 100) / 100).toBe(v.score);
    expect(runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' })).toEqual(runVote(structuredClone(s), 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' }));
    // il tema conta: le sanzioni dividono, l'umanitario unisce
    const sanc = runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'sanctions' });
    const hum = runVote(s, 'UNGA', { proposer: 'ITA', topic: 'humanitarian' });
    expect(sanc.yes.length).toBeLessThan(runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' }).yes.length);
    expect(hum.yes).toHaveLength(193);
  });
});

describe('RESOLUTION: effetti del voto', () => {
  const res = (forum: 'UNSC' | 'UNGA' | 'EU_COUNCIL' | 'NATO', extra: Record<string, unknown> = {}) => ({ id: 'r1', kind: 'RESOLUTION' as const, forum, subject: 'Condanna dell\'aggressione', topic: 'aggression' as const, ...extra });

  it('INSTITUTION_VOTE compatto (tre elenchi di ISO3), risoluzione approvata come mandato, credibilità e opinione', () => {
    const ctx = ctxOf();
    const cr = ctx.state.factions.ITA!.credibility; const rus = opinionOf(ctx.state, 'RUS', 'ITA').value;
    resolveDiplomacy(ctx, 'ITA', res('UNGA', { target: 'RUS' }));
    const ev = ctx.events.find((e) => e.type === 'INSTITUTION_VOTE')!;
    expect(ev.payload).toMatchObject({ forum: 'UNGA', institutionId: 'UNGA', proposer: 'ITA', target: 'RUS', passed: true });
    for (const k of ['yes', 'no', 'abstain']) expect(Array.isArray(ev.payload[k])).toBe(true);
    expect((ev.payload.yes as string[]).length + (ev.payload.no as string[]).length + (ev.payload.abstain as string[]).length).toBeGreaterThan(190);
    expect(ev.causedBy).toEqual({ orderId: 'r1' });
    expect(ctx.state.factions.ITA!.credibility).toBe(cr + 3);
    expect(ctx.state.diplomacy!.resolutions).toHaveLength(1);
    expect(ctx.state.diplomacy!.resolutions[0]).toMatchObject({ forum: 'UNGA', target: 'RUS', proposer: 'ITA', turn: 1, expiresTurn: 9 });
    // condanna pubblica del bersaglio e voto contrario dei più popolosi che hanno votato no
    expect(opinionOf(ctx.state, 'RUS', 'ITA').modifiers.some((m) => m.kind === 'condemnation')).toBe(true);
    expect(opinionOf(ctx.state, 'RUS', 'ITA').value).toBeLessThan(rus);
    const no = ev.payload.no as string[];
    expect(no.length).toBeGreaterThan(0);
    const mods = ctx.state.diplomacy!.modifiers.filter((m) => m.kind === 'vote_against' && m.to === 'ITA');
    expect(mods.length).toBeGreaterThan(0); expect(mods.length).toBeLessThanOrEqual(20);
    expect(mods.every((m) => m.value === -3 && no.includes(worldData().isoOf(m.from) ?? m.from))).toBe(true);
  });

  it('una risoluzione respinta costa credibilità e non dà mandato; il CdS è un veto russo', () => {
    const ctx = ctxOf();
    const cr = ctx.state.factions.GBR!.credibility;
    resolveDiplomacy(ctx, 'GBR', res('UNSC', { target: 'RUS' }));
    const ev = ctx.events.find((e) => e.type === 'INSTITUTION_VOTE')!;
    expect(ev.payload).toMatchObject({ passed: false, vetoes: ['RUS'] });
    expect(ctx.state.factions.GBR!.credibility).toBe(cr - 2);
    expect(ctx.state.diplomacy!.resolutions).toEqual([]);
  });

  it('le vecchie NATO_ART4, EU_COUNCIL e UNSC_DRAFT restano come alias in lettura', () => {
    for (const [kind, forum] of [['NATO_ART4', 'NATO'], ['EU_COUNCIL', 'EU_COUNCIL'], ['UNSC_DRAFT', 'UNSC']] as const) {
      const ctx = ctxOf();
      resolveDiplomacy(ctx, 'FRA', { id: 'x', kind, subject: 'prova' });
      expect(ctx.events.find((e) => e.type === 'INSTITUTION_VOTE')!.payload).toMatchObject({ forum, proposer: 'FRA' });
    }
  });

  it('il validatore: solo i membri della sede, con costo per sede e ricarica', () => {
    const s = fresh();
    expect(checkAction(s, 'ITA', res('UNSC'))).toEqual([expect.stringContaining('non è membro della sede UNSC')]);
    expect(checkAction(s, 'ITA', res('UNGA'))).toEqual([]);
    expect(checkAction(s, 'ITA', res('NATO'))).toEqual([]);
    expect(checkAction(s, 'EGY', res('NATO'))).toEqual([expect.stringContaining('non è membro della sede NATO')]);
    expect(checkAction(s, 'FRA', res('UNSC'))).toEqual([]);
    const ctx = ctxOf();
    resolveDiplomacy(ctx, 'ITA', res('UNGA'));
    expect(checkAction(ctx.state, 'ITA', res('UNGA')).join()).toContain('in ricarica');
    expect(checkAction(ctx.state, 'ITA', res('NATO'))).toEqual([]); // un'altra sede
  });
});
