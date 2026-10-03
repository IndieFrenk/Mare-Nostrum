import { describe, expect, it } from 'vitest';
import { adjudicate } from '../src/engine/adjudication.js';
import { DIPLO_CATALOG, actionCost, checkAction, improveSlots, weeklyRent } from '../src/engine/diplo-actions.js';
import { diplomaticTurn } from '../src/engine/diplo-turn.js';
import { resolveDiplomacy } from '../src/engine/diplomacy.js';
import { opinionOf } from '../src/engine/opinion.js';
import { rebuild } from '../src/engine/reducer.js';
import { sc, ctxOf, validate, capital, demarche, threat, trade, orders } from './diplo-helpers.js';
import { setRelation } from './helpers.js';

describe('capitale diplomatico (CD)', () => {
  it('la rendita viene da PIL, seggio permanente e credibilità: Italia ~3 a settimana, USA ~6, Malta ~1; si parte da 4 settimane', () => {
    const s = sc.world;
    expect(weeklyRent(s, 'ITA')).toBeGreaterThan(2.8); expect(weeklyRent(s, 'ITA')).toBeLessThan(3.3);
    expect(weeklyRent(s, 'USA')).toBeGreaterThan(5.8); expect(weeklyRent(s, 'USA')).toBeLessThan(6.4);
    expect(weeklyRent(s, 'MLT')).toBeGreaterThan(0.9); expect(weeklyRent(s, 'MLT')).toBeLessThan(1.2);
    expect(weeklyRent(s, 'NATO')).toBe(0);
    expect(capital(s, 'ITA')).toBeCloseTo(4 * weeklyRent(s, 'ITA'), 0);
    expect(s.diplomacy!.capital.NATO).toBeUndefined();
    // la credibilità scala la rendita (tra 0,5 e 1,5 volte)
    const hi = structuredClone(s); hi.factions.ITA!.credibility = 90;
    expect(weeklyRent(hi, 'ITA')).toBeCloseTo(weeklyRent(s, 'ITA') * 1.5, 1);
  });

  it('un evento CAPITAL_CHANGED per turno con la rendita di tutte le fazioni; il turno mensile vale 4 settimane; tetto 100', () => {
    for (const [len, weeks] of [['week', 1], ['month', 4]] as const) {
      const ctx = ctxOf(undefined, len);
      const before = capital(ctx.state, 'ITA');
      diplomaticTurn(ctx);
      const ev = ctx.events.filter((e) => e.type === 'CAPITAL_CHANGED');
      expect(ev).toHaveLength(1);
      expect(capital(ctx.state, 'ITA')).toBeCloseTo(before + weeklyRent(ctx.state, 'ITA') * weeks, 1);
      expect(Object.keys(ev[0]!.payload.deltas as object).length).toBeGreaterThan(20);
    }
    const ctx = ctxOf((s) => { s.diplomacy!.capital.USA = 99; });
    diplomaticTurn(ctx);
    expect(capital(ctx.state, 'USA')).toBe(100);
  });

  it('una spesa è un evento con causedBy dell\'ordine; il capitale non scende sotto zero', () => {
    const ctx = ctxOf();
    const before = capital(ctx.state, 'ITA');
    resolveDiplomacy(ctx, 'ITA', demarche('d1', 'TUR'));
    expect(capital(ctx.state, 'ITA')).toBeCloseTo(before - 1, 1);
    const ev = ctx.events.find((e) => e.type === 'CAPITAL_CHANGED')!;
    expect(ev.causedBy).toEqual({ orderId: 'd1' });
    expect(ev.payload.deltas).toEqual({ ITA: -1 });
  });
});


describe('catalogo delle azioni: costi, ricariche, prerequisiti', () => {
  it('ogni azione dello schema ha una riga di catalogo con costo, ricarica ed effetti', () => {
    for (const [kind, spec] of Object.entries(DIPLO_CATALOG)) {
      expect(spec.label, kind).toBeTruthy(); expect(spec.effects.length, kind).toBeGreaterThan(10);
      expect(spec.cooldown, kind).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(DIPLO_CATALOG)).toEqual(expect.arrayContaining(['IMPROVE_RELATIONS', 'STOP_IMPROVE', 'RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO', 'ULTIMATUM', 'MEDIATE', 'RESOLUTION']));
  });

  it('il validatore rifiuta un\'azione senza CD e somma i costi della bozza', () => {
    const s = structuredClone(sc.world);
    s.diplomacy!.capital.ITA = 0.5;
    expect(validate(s, 'ITA', [demarche('d1', 'TUR')]).errors.join()).toContain('capitale diplomatico insufficiente');
    s.diplomacy!.capital.ITA = 2;
    expect(validate(s, 'ITA', [demarche('d1', 'TUR'), demarche('d2', 'FRA')]).valid).toBe(true);
    const three = validate(s, 'ITA', [demarche('d1', 'TUR'), demarche('d2', 'FRA'), demarche('d3', 'GRC')]);
    expect(three.valid).toBe(false);
    expect(three.errors.filter((e) => e.startsWith('d3:') && e.includes('capitale'))).toHaveLength(1);
    expect(validate(s, 'ITA', [demarche('d1', 'TUR'), demarche('d2', 'FRA')]).capitalCost).toBe(2);
  });

  it('la ricarica blocca la stessa azione verso lo stesso destinatario (anche due volte nella stessa bozza), non verso un altro', () => {
    const ctx = ctxOf();
    resolveDiplomacy(ctx, 'ITA', threat('t1', 'TUR'));
    const s = ctx.state;
    expect(s.diplomacy!.cooldowns['ITA|THREAT|TUR']).toBe(3); // usata al turno 1, ricarica 2
    expect(validate(s, 'ITA', [threat('t2', 'TUR')]).errors.join()).toContain('in ricarica fino al turno 3');
    expect(validate(s, 'ITA', [threat('t2', 'EGY')]).valid).toBe(true);
    s.turn = 3;
    expect(validate(s, 'ITA', [threat('t2', 'TUR')]).valid).toBe(true);
    expect(validate(sc.world, 'ITA', [demarche('d1', 'TUR'), demarche('d2', 'TUR')]).errors.join()).toContain('ripetuta nella stessa bozza');
  });

  it('le democrazie con tensione mondiale bassa pagano il doppio le azioni coercitive; le altre no', () => {
    const s = structuredClone(sc.world);
    s.globalIndicators.worldTension = 10;
    expect(actionCost(s, 'ITA', threat('t', 'TUR'))).toBe(6);
    expect(actionCost(s, 'RUS', threat('t', 'TUR'))).toBe(3);
    expect(actionCost(s, 'ITA', demarche('d', 'TUR'))).toBe(1);
    s.globalIndicators.worldTension = 30;
    expect(actionCost(s, 'ITA', threat('t', 'TUR'))).toBe(3);
  });

  it('«migliorare le relazioni»: slot da 2 a 4 secondo la potenza, +2 a turno fino a +30, 1 CD a turno; STOP libera lo slot e il vantaggio decade', () => {
    const s = structuredClone(sc.world);
    expect([improveSlots(s, 'MLT'), improveSlots(s, 'ITA'), improveSlots(s, 'USA')]).toEqual([2, 3, 4]);
    const ctx = ctxOf();
    const op0 = opinionOf(ctx.state, 'TUR', 'ITA').value;
    for (const [i, t] of ['TUR', 'EGY', 'GRC'].entries()) resolveDiplomacy(ctx, 'ITA', { id: `i${i}`, kind: 'IMPROVE_RELATIONS', target: t });
    expect(ctx.state.diplomacy!.improving.map((x) => x.target)).toEqual(['TUR', 'EGY', 'GRC']);
    expect(opinionOf(ctx.state, 'TUR', 'ITA').value).toBeCloseTo(op0 + 2, 1);
    expect(validate(ctx.state, 'ITA', [{ id: 'i3', kind: 'IMPROVE_RELATIONS', target: 'FRA' }]).errors.join()).toContain('slot esauriti (3/3)');
    expect(validate(ctx.state, 'ITA', [{ id: 'i3', kind: 'IMPROVE_RELATIONS', target: 'TUR' }]).errors.join()).toContain('già in corso');
    // ogni turno: −1 CD e +2 (tetto +30 in tutto)
    for (let n = 1; n <= 20; n++) {
      ctx.state.turn = 1 + n;
      const cd = capital(ctx.state, 'ITA');
      diplomaticTurn(ctx);
      expect(capital(ctx.state, 'ITA')).toBeGreaterThan(cd - 3.01 + weeklyRent(ctx.state, 'ITA') - 0.5); // rendita − 3 CD di miglioramenti
    }
    expect(opinionOf(ctx.state, 'TUR', 'ITA').modifiers.find((m) => m.kind === 'improve')!.value).toBe(30);
    // STOP: libera lo slot, il vantaggio resta ma decade di 0,5 a settimana
    resolveDiplomacy(ctx, 'ITA', { id: 's1', kind: 'STOP_IMPROVE', target: 'TUR' });
    expect(ctx.state.diplomacy!.improving.map((x) => x.target)).toEqual(['EGY', 'GRC']);
    expect(opinionOf(ctx.state, 'TUR', 'ITA').modifiers.find((m) => m.kind === 'improve')).toMatchObject({ value: 30, decayPerWeek: 0.5 });
    expect(validate(ctx.state, 'ITA', [{ id: 'i4', kind: 'IMPROVE_RELATIONS', target: 'FRA' }]).valid).toBe(true);
  });

  it('senza CD il miglioramento in corso si interrompe da solo (la rendita non basta a pagarne il turno)', () => {
    const ctx = ctxOf((s) => { s.diplomacy!.capital.LBY_LNA = 1; });
    resolveDiplomacy(ctx, 'LBY_LNA', { id: 'i0', kind: 'IMPROVE_RELATIONS', target: 'RUS' });
    expect(capital(ctx.state, 'LBY_LNA')).toBe(0);
    ctx.state.turn = 2;
    diplomaticTurn(ctx); // rendita 0,8 < 1 CD da pagare
    expect(ctx.state.diplomacy!.improving).toEqual([]);
    expect(ctx.events.some((e) => e.type === 'DIPLOMACY_CHANGED' && (e.payload.change as { op: string }).op === 'improve_stop')).toBe(true);
  });

  it('scala diplomatica: richiamo → espulsione → rottura → ripristino, con i prerequisiti', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    const tie = () => s.diplomacy!.ties['ITA|TUR'];
    expect(checkAction(s, 'ITA', { id: 'e', kind: 'EXPEL_DIPLOMATS', target: 'TUR' }).join()).toContain('serve un\'opinione ≤ −10');
    expect(checkAction(s, 'ITA', { id: 'b', kind: 'BREAK_RELATIONS', target: 'TUR' }).join()).toContain('serve un\'opinione ≤ −30');
    expect(checkAction(s, 'ITA', { id: 'r', kind: 'RESTORE_RELATIONS', target: 'TUR' }).join()).toContain('non sono state ridotte');
    const op = opinionOf(s, 'TUR', 'ITA').value; const k = s.relations.TUR!.ITA!.tension;
    resolveDiplomacy(ctx, 'ITA', { id: 'r1', kind: 'RECALL_AMBASSADOR', target: 'TUR' });
    expect(tie()).toBe('recalled');
    expect(opinionOf(s, 'TUR', 'ITA').value).toBeCloseTo(op - 8, 1);
    expect(s.relations.TUR!.ITA!.tension).toBeCloseTo(k + 8, 1);
    expect(checkAction(s, 'ITA', { id: 'r2', kind: 'RECALL_AMBASSADOR', target: 'TUR' }).join()).toContain('rapporti già a un gradino superiore');
    expect(checkAction(s, 'ITA', { id: 'e', kind: 'EXPEL_DIPLOMATS', target: 'TUR' })).toEqual([]);
    resolveDiplomacy(ctx, 'ITA', { id: 'e1', kind: 'EXPEL_DIPLOMATS', target: 'TUR' });
    expect(tie()).toBe('expelled');
    expect(checkAction(s, 'ITA', { id: 'b', kind: 'BREAK_RELATIONS', target: 'TUR' })).toEqual([]);
    resolveDiplomacy(ctx, 'ITA', { id: 'b1', kind: 'BREAK_RELATIONS', target: 'TUR' });
    expect(tie()).toBe('broken');
    // a relazioni rotte restano solo le azioni ostili e il ripristino; le altre sono chiuse (per entrambe le parti)
    s.turn = 20;
    expect(checkAction(s, 'ITA', demarche('d', 'TUR')).join()).toContain('relazioni diplomatiche con TUR interrotte');
    expect(checkAction(s, 'TUR', demarche('d', 'ITA')).join()).toContain('interrotte');
    expect(checkAction(s, 'ITA', threat('t', 'TUR'))).toEqual([]);
    expect(checkAction(s, 'ITA', { id: 'u', kind: 'RESTORE_RELATIONS', target: 'TUR' })).toEqual([]);
    resolveDiplomacy(ctx, 'ITA', { id: 'u1', kind: 'RESTORE_RELATIONS', target: 'TUR' });
    expect(tie()).toBeUndefined();
  });

  it('embargo sulle armi: vieta aiuti militari e vendite di armi verso il destinatario finché non è revocato', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    resolveDiplomacy(ctx, 'ITA', { id: 'm1', kind: 'ARMS_EMBARGO', target: 'EGY' });
    expect(s.diplomacy!.embargoes).toEqual(['ITA>EGY']);
    expect(validate(s, 'ITA', [{ id: 'a1', kind: 'AID', target: 'EGY', amount: 5, type: 'military' }]).errors.join()).toContain('embargo sulle armi');
    expect(validate(s, 'ITA', [{ id: 'a1', kind: 'AID', target: 'EGY', amount: 5, type: 'economic' }]).valid).toBe(true);
    expect(validate(s, 'ITA', [trade('p1', ['ITA', 'EGY'], 'arms_sale')]).errors.join()).toContain('embargo sulle armi');
    expect(checkAction(s, 'ITA', { id: 'm2', kind: 'ARMS_EMBARGO', target: 'EGY' }).join()).toMatch(/già in vigore|ricarica/);
    s.turn = 5;
    resolveDiplomacy(ctx, 'ITA', { id: 'm3', kind: 'LIFT_ARMS_EMBARGO', target: 'EGY' });
    expect(s.diplomacy!.embargoes).toEqual([]);
    expect(validate(s, 'ITA', [{ id: 'a1', kind: 'AID', target: 'EGY', amount: 5, type: 'military' }]).valid).toBe(true);
  });

  it('mediazione: solo un terzo con opinione ≥ 0 verso entrambe le parti; la crisi scende, le parti apprezzano il mediatore', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    const m = { id: 'x1', kind: 'MEDIATE' as const, crisisId: 'EAST_MED', parties: ['TUR', 'GRC'] };
    setRelation(s, 'ITA', 'TUR', 5); setRelation(s, 'ITA', 'GRC', -10);
    expect(checkAction(s, 'ITA', m).join()).toContain('serve un\'opinione ≥ 0 verso GRC');
    setRelation(s, 'ITA', 'GRC', 10);
    expect(checkAction(s, 'ITA', m)).toEqual([]);
    expect(checkAction(s, 'TUR', { ...m, parties: ['TUR', 'GRC'] }).join()).toContain('non può essere una delle parti');
    expect(checkAction(s, 'ITA', { ...m, parties: ['TUR', 'FRA'] }).join()).toContain('le parti devono essere coinvolte');
    const esc = s.crises.EAST_MED!.escalation; const g = opinionOf(s, 'GRC', 'ITA').value; const cr = s.factions.ITA!.credibility;
    resolveDiplomacy(ctx, 'ITA', m);
    expect(s.crises.EAST_MED!.escalation).toBe(esc - 1);
    expect(opinionOf(s, 'GRC', 'ITA').value).toBeCloseTo(g + 3, 1);
    expect(s.factions.ITA!.credibility).toBe(cr + 1);
    expect(s.diplomacy!.cooldowns['ITA|MEDIATE|EAST_MED']).toBeGreaterThan(1);
  });
});


describe('determinismo e ricostruzione', () => {
  it('stesso stato → stessa accettazione e stesso voto; gli eventi ricostruiscono lo stato', () => {
    const ctx = ctxOf((s) => { setRelation(s, 'POL', 'ITA', 40); });
    const snapshot = structuredClone(ctx.state);
    adjudicate(ctx, [orders('ITA', [demarche('d1', 'TUR'), trade('p1', ['ITA', 'POL']), { id: 'i1', kind: 'IMPROVE_RELATIONS', target: 'EGY' }, { id: 'r1', kind: 'RESOLUTION', forum: 'UNGA', subject: 'prova', topic: 'humanitarian' }])]);
    diplomaticTurn(ctx);
    const replayed = rebuild(snapshot, ctx.events);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(ctx.state));
  });
});
