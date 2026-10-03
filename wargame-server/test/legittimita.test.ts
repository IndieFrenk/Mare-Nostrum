import { describe, expect, it } from 'vitest';
import type { Agreement, WorldState } from '../src/schemas/index.js';
import { adjudicate } from '../src/engine/adjudication.js';
import { actionCost, checkAction } from '../src/engine/diplo-actions.js';
import { diplomaticTurn } from '../src/engine/diplo-turn.js';
import { resolveDiplomacy, violateTreaties } from '../src/engine/diplomacy.js';
import { legitimacyCost, mandate } from '../src/engine/legitimacy.js';
import { opinionOf, setTension } from '../src/engine/opinion.js';
import { updateWorldTension } from '../src/engine/world-tension.js';
import { sc, ctxOf, capital, agreement, orders } from './diplo-helpers.js';

describe('ultimatum e legittimità', () => {
  const ult = (turns = 2) => ({ id: 'u1', kind: 'ULTIMATUM' as const, target: 'TUR', demand: 'Ritirare le navi', deadlineTurns: turns });

  it('serve una tensione di coppia ≥ 30; scaduto dà legittimità e alza la tensione mondiale; soddisfatto se il destinatario cerca la distensione', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    setTension(s, 'ITA', 'TUR', 10);
    expect(checkAction(s, 'ITA', ult()).join()).toContain('serve una tensione con TUR di almeno 30');
    setTension(s, 'ITA', 'TUR', 60);
    expect(checkAction(s, 'ITA', ult())).toEqual([]);
    expect(actionCost(s, 'ITA', ult())).toBe(8);
    resolveDiplomacy(ctx, 'ITA', ult(2));
    expect(s.diplomacy!.ultimatums[0]).toMatchObject({ from: 'ITA', to: 'TUR', deadlineTurn: 3, status: 'pending' });
    expect(checkAction(s, 'ITA', ult()).join()).toMatch(/già in corso|ricarica/);
    // scadenza: all'OPEN del turno 3 senza che TUR cerchi la distensione
    s.turn = 3; diplomaticTurn(ctx);
    expect(ctx.events.some((e) => e.type === 'ULTIMATUM_EXPIRED')).toBe(true);
    expect(s.diplomacy!.ultimatums[0]).toMatchObject({ status: 'expired', legitimateUntil: 9 });
    const wt = s.globalIndicators.worldTension;
    updateWorldTension(ctx, ctx.events);
    const ch = ctx.events.find((e) => e.type === 'WORLD_TENSION_CHANGED')!;
    expect((ch.payload.causes as { label: string; value: number }[]).find((c) => c.label.startsWith('ultimatum scaduti'))!.value).toBe(5);
    expect(s.globalIndicators.worldTension).toBeGreaterThan(wt);
    // con l'ultimatum scaduto un blocco contro TUR non costa legittimità, contro un altro sì
    expect(mandate(s, 'ITA', ['TUR'])).toMatchObject({ ok: true });
    expect(mandate(s, 'ITA', ['EGY']).ok).toBe(false);
    s.turn = 10;
    expect(mandate(s, 'ITA', ['TUR']).ok).toBe(false);
  });

  it('l\'ultimatum è soddisfatto se il destinatario risponde con un gesto di distensione prima della scadenza', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    setTension(s, 'ITA', 'TUR', 60);
    resolveDiplomacy(ctx, 'ITA', ult(2));
    resolveDiplomacy(ctx, 'TUR', { id: 'r1', kind: 'REASSURANCE', target: 'ITA', message: 'ok', visibility: 'public' });
    expect(s.diplomacy!.ultimatums[0]!.answered).toBe(true);
    s.turn = 3; diplomaticTurn(ctx);
    expect(ctx.events.some((e) => e.type === 'ULTIMATUM_MET')).toBe(true);
    expect(ctx.events.some((e) => e.type === 'ULTIMATUM_EXPIRED')).toBe(false);
    expect(s.diplomacy!.ultimatums[0]!.status).toBe('met');
    expect(mandate(s, 'ITA', ['TUR']).ok).toBe(false);
  });

  it('blocco senza mandato: costa CD, credibilità e un modificatore presso i terzi; con una risoluzione, un ultimatum scaduto o tensione ≥ 50 no', () => {
    const run = (mutate?: (s: WorldState) => void) => {
      const ctx = ctxOf((s) => { s.globalIndicators.worldTension = 30; mutate?.(s); });
      const s = ctx.state;
      const cd = capital(s, 'ITA'); const cr = s.factions.ITA!.credibility; const op = opinionOf(s, 'EGY', 'ITA').value;
      const m = legitimacyCost(ctx, 'ITA', ['TUR'], 'EGEO', 'b1');
      return { m, cd: capital(s, 'ITA') - cd, cr: s.factions.ITA!.credibility - cr, op: opinionOf(s, 'EGY', 'ITA').value - op, tur: opinionOf(s, 'TUR', 'ITA').value, s };
    };
    const none = run();
    expect(none.m.ok).toBe(false);
    expect(none.cd).toBeCloseTo(-4, 1); expect(none.cr).toBe(-2); expect(none.op).toBeCloseTo(-3, 1);
    const res = run((s) => { s.diplomacy!.resolutions.push({ id: 'RES-1', forum: 'UNSC', institutionId: 'UNSC', subject: 'x', topic: 'maritime', proposer: 'FRA', target: 'TUR', turn: 1, expiresTurn: 9 }); });
    expect(res.m).toMatchObject({ ok: true }); expect(res.cd).toBe(0); expect(res.cr).toBe(0); expect(res.op).toBe(0);
    expect(run((s) => { s.diplomacy!.resolutions.push({ id: 'RES-2', forum: 'UNGA', institutionId: 'UNGA', subject: 'x', topic: 'maritime', proposer: 'FRA', target: 'EGY', turn: 1, expiresTurn: 9 }); }).m.ok).toBe(false); // un'altra vittima
    expect(run((s) => { s.diplomacy!.resolutions.push({ id: 'RES-3', forum: 'UNGA', institutionId: 'UNGA', subject: 'x', topic: 'maritime', proposer: 'FRA', target: 'TUR', turn: 1, expiresTurn: 1 }); }).m.ok).toBe(false); // scaduta
    expect(run((s) => { s.globalIndicators.worldTension = 55; }).cd).toBe(0);
    // le democrazie con tensione bassa pagano il doppio il costo in CD
    const low = run((s) => { s.globalIndicators.worldTension = 10; });
    expect(low.cd).toBeCloseTo(-8, 1);
    const auth = (() => { const ctx = ctxOf((s) => { s.globalIndicators.worldTension = 10; }); const cd = capital(ctx.state, 'RUS'); legitimacyCost(ctx, 'RUS', ['TUR'], 'EGEO', 'b'); return capital(ctx.state, 'RUS') - cd; })();
    expect(auth).toBeCloseTo(-4, 1);
  });

  it('un BLOCKADE senza mandato, in aggiudicazione, paga il costo; con tensione mondiale ≥ 50 no (e viola un patto di non aggressione)', () => {
    const blockade = (unitIds: string[]) => ({ id: 'b1', kind: 'BLOCKADE', unitIds, zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' });
    const setup = (wt: number) => ctxOf((s) => {
      s.globalIndicators.worldTension = wt;
      const t = Object.values(s.units).find((u) => u.factionId === 'TUR')!; Object.assign(t, { zoneId: 'EGEO', status: 'deployed' });
      s.agreements['AG-NA'] = agreement('AG-NA', 'non_aggression', ['ITA', 'TUR']);
    });
    const ita = Object.values(sc.world.units).filter((u) => u.factionId === 'ITA' && u.domain === 'sea').slice(0, 1).map((u) => u.id);
    const a = setup(30);
    adjudicate(a, [orders('ITA', [], [blockade(ita)])]);
    expect(capital(a.state, 'ITA')).toBeLessThan(capital(sc.world, 'ITA') - 3);
    expect(a.state.agreements['AG-NA']!.status).toBe('violated');
    expect(opinionOf(a.state, 'TUR', 'ITA').modifiers.some((m) => m.kind === 'treaty_violated' && m.value === -30)).toBe(true);
    const b = setup(60);
    adjudicate(b, [orders('ITA', [], [blockade(ita)])]);
    expect(capital(b.state, 'ITA')).toBe(capital(sc.world, 'ITA'));
  });
});


describe('nuovi tipi di trattato', () => {
  it('non aggressione: una violazione (strike o blocco) la fa passare a `violated`, tolta la credibilità e −30 di opinione presso la vittima', () => {
    const ctx = ctxOf((s) => { s.agreements['AG-NA'] = agreement('AG-NA', 'non_aggression', ['ITA', 'TUR']); });
    const cr = ctx.state.factions.ITA!.credibility; const op = opinionOf(ctx.state, 'TUR', 'ITA').value;
    violateTreaties(ctx, 'ITA', 'TUR', 'prova');
    expect(ctx.state.agreements['AG-NA']!.status).toBe('violated');
    expect(ctx.state.factions.ITA!.credibility).toBe(cr - 3);
    expect(opinionOf(ctx.state, 'TUR', 'ITA').value).toBeCloseTo(op - 30, 1);
    // un'altra coppia non è toccata
    const other = ctxOf((s) => { s.agreements['AG-NA'] = agreement('AG-NA', 'non_aggression', ['ITA', 'TUR']); });
    violateTreaties(other, 'ITA', 'EGY', 'prova');
    expect(other.state.agreements['AG-NA']!.status).toBe('active');
  });

  it('accesso militare e cooperazione di difesa: la presenza del partner non è una pressione; la cooperazione conta come alleanza stretta', () => {
    const show = (type: Agreement['type'] | null) => {
      const ctx = ctxOf((s) => {
        Object.assign(Object.values(s.units).find((u) => u.factionId === 'TUR')!, { zoneId: 'EGEO', status: 'deployed' });
        if (type) s.agreements['AG-X'] = agreement('AG-X', type, type === 'military_access' ? ['TUR', 'ITA'] : ['ITA', 'TUR']);
      });
      const ita = Object.values(ctx.state.units).filter((u) => u.factionId === 'ITA' && u.domain === 'sea').slice(0, 1).map((u) => u.id);
      adjudicate(ctx, [orders('ITA', [], [{ id: 's1', kind: 'SHOW_OF_FORCE', unitIds: ita, zoneId: 'EGEO', roe: 'WEAPONS_TIGHT' }])]);
      // la dimostrazione di forza pesa sull'opinione di chi la subisce (altri incidenti, come l'incrocio nella zona, sono un'altra cosa)
      return opinionOf(ctx.state, 'TUR', 'ITA').modifiers.filter((m) => m.kind === 'show_of_force').reduce((n, m) => n + m.value, 0);
    };
    expect(show(null)).toBeCloseTo(-2, 1);
    expect(show('military_access')).toBe(0);
    expect(show('defense_cooperation')).toBe(0);
  });
});
