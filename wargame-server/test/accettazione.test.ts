import { describe, expect, it } from 'vitest';
import type { Agreement } from '../src/schemas/index.js';
import { acceptance, rejKey } from '../src/engine/acceptance.js';
import { adjudicate } from '../src/engine/adjudication.js';
import { opinionOf } from '../src/engine/opinion.js';
import { sc, ctxOf, validate, demarche, trade, agreement, orders } from './diplo-helpers.js';
import { setRelation } from './helpers.js';

describe('accettazione dei trattati (deterministica, con i motivi)', () => {
  it('il punteggio è la somma dei motivi; accetta con ≥ 0', () => {
    const r = acceptance(sc.world, 'EGY', { type: 'trade', parties: ['ITA', 'EGY'] }, 'ITA');
    expect(Math.round(r.reasons.reduce((a, x) => a + x.value, 0) * 10) / 10).toBe(r.score);
    expect(r.accept).toBe(r.score >= 0);
    expect(r.reasons.some((x) => x.label.startsWith('Opinione verso il proponente'))).toBe(true);
    expect(r.reasons.some((x) => x.label.startsWith('Tipo di accordo'))).toBe(true);
    expect(acceptance(sc.world, 'EGY', { type: 'trade', parties: ['ITA', 'EGY'] }, 'ITA')).toEqual(r);
  });

  it('un partner cordiale accetta una cooperazione di difesa; un neutro una garanzia no senza un nemico comune, con un nemico comune sì', () => {
    const s = structuredClone(sc.world);
    setRelation(s, 'MAR', 'ITA', 40);
    expect(acceptance(s, 'MAR', { type: 'defense_cooperation', parties: ['ITA', 'MAR'] }, 'ITA').accept).toBe(true);
    // l'India (né alleata né piccola) con un'opinione neutra rifiuta una garanzia dell'Italia
    for (const [a, b] of [['IND', 'ITA'], ['IND', 'IRN'], ['ITA', 'IRN'], ['IRN', 'IND'], ['IRN', 'ITA']]) setRelation(s, a!, b!, 0);
    const before = acceptance(s, 'IND', { type: 'guarantee', parties: ['ITA', 'IND'] }, 'ITA');
    expect(before.accept).toBe(false);
    expect(before.reasons.some((x) => x.label.startsWith('Minaccia comune'))).toBe(false);
    // il destinatario teme X e il proponente è rivale di X
    setRelation(s, 'IND', 'IRN', -60); setRelation(s, 'ITA', 'IRN', -60);
    const after = acceptance(s, 'IND', { type: 'guarantee', parties: ['ITA', 'IND'] }, 'ITA');
    expect(after.reasons.find((x) => x.label.startsWith('Minaccia comune'))!.value).toBeGreaterThan(0);
    expect(after.score).toBeGreaterThan(before.score + 10);
    expect(after.accept).toBe(true);
    // la minaccia comune pesa solo sui trattati di sicurezza: un accordo commerciale non cambia
    expect(acceptance(s, 'IND', { type: 'trade', parties: ['ITA', 'IND'] }, 'ITA').reasons.some((x) => x.label.startsWith('Minaccia comune'))).toBe(false);
  });

  it('un accordo che confligge con un trattato del destinatario o che include un suo rivale fa rifiutare; una proposta già respinta di recente pesa', () => {
    const s = structuredClone(sc.world);
    setRelation(s, 'EGY', 'ITA', 40);
    const base = acceptance(s, 'EGY', { type: 'defense_cooperation', parties: ['ITA', 'EGY'] }, 'ITA');
    // EGY ha un patto di difesa con un rivale del proponente
    s.agreements['AG-EGY-RUS'] = agreement('AG-EGY-RUS', 'defense', ['EGY', 'RUS']);
    setRelation(s, 'ITA', 'RUS', -60);
    const clash = acceptance(s, 'EGY', { type: 'defense_cooperation', parties: ['ITA', 'EGY'] }, 'ITA');
    expect(clash.reasons.some((x) => x.label.startsWith('Conflitto con un trattato in vigore'))).toBe(true);
    expect(clash.score).toBeLessThan(base.score);
    // tra le parti c'è un nemico del destinatario
    setRelation(s, 'EGY', 'ISR', -70);
    expect(acceptance(s, 'EGY', { type: 'trade', parties: ['ITA', 'EGY', 'ISR'] }, 'ITA').reasons.some((x) => x.label.startsWith('Tra le parti c\'è un rivale'))).toBe(true);
    s.diplomacy!.cooldowns[rejKey('ITA', 'EGY', 'trade')] = 5;
    const rej = acceptance(s, 'EGY', { type: 'trade', parties: ['ITA', 'EGY'] }, 'ITA');
    expect(rej.reasons.find((x) => x.label === 'Proposta già respinta di recente')!.value).toBe(-12);
    s.turn = 5;
    expect(acceptance(s, 'EGY', { type: 'trade', parties: ['ITA', 'EGY'] }, 'ITA').reasons.some((x) => x.label.startsWith('Proposta già respinta'))).toBe(false);
  });

  it('la tensione mondiale spinge i trattati di sicurezza e frena il commercio; la tregua pesa con la crisi in comune', () => {
    const s = structuredClone(sc.world);
    const low = acceptance(s, 'TUN', { type: 'defense', parties: ['ITA', 'TUN'] }, 'ITA').score;
    s.globalIndicators.worldTension = 70;
    expect(acceptance(s, 'TUN', { type: 'defense', parties: ['ITA', 'TUN'] }, 'ITA').score).toBeGreaterThan(low);
    const t70 = acceptance(s, 'TUN', { type: 'trade', parties: ['ITA', 'TUN'] }, 'ITA');
    expect(t70.reasons.some((x) => x.label.startsWith('Tensione mondiale') && x.value < 0)).toBe(true);
    const c = acceptance(s, 'TUR', { type: 'ceasefire', parties: ['GRC', 'TUR'] }, 'GRC');
    expect(c.reasons.some((x) => x.label.startsWith('Crisi in comune'))).toBe(true);
  });

  it('dry-run: il validatore restituisce punteggio e motivi per ogni proposta, anche verso uno Stato del mondo', () => {
    const v = validate(sc.world, 'ITA', [trade('p1', ['ITA', 'EGY']), trade('p2', ['ITA', 'POL'], 'defense_cooperation')]);
    expect(v.valid).toBe(true);
    expect(v.acceptance!.map((a) => [a.actionId, a.target])).toEqual([['p1', 'EGY'], ['p2', 'POL']]);
    for (const a of v.acceptance!) { expect(a.reasons.length).toBeGreaterThan(2); expect(a.accept).toBe(a.score >= 0); }
    expect(validate(sc.world, 'ITA', [demarche('d1', 'TUR')]).acceptance).toBeUndefined();
  });

  it('gli Stati del mondo rispondono nell\'aggiudicazione dello stesso turno, le fazioni nel turno dopo', () => {
    // ITA→POL: proposta commerciale tra Stati vicini e cordiali: accettata subito
    const ctx = ctxOf((s) => { setRelation(s, 'POL', 'ITA', 40); });
    adjudicate(ctx, [orders('ITA', [trade('p1', ['ITA', 'POL'])])]);
    const ag = Object.values(ctx.state.agreements).find((a) => a.id.includes('p1'))!;
    expect(ag.status).toBe('active');
    expect(ctx.events.find((e) => e.type === 'AGREEMENT_CHANGED' && (e.payload.agreement as Agreement).id === ag.id)!.payload.acceptance).toBeTruthy();
    expect(opinionOf(ctx.state, 'POL', 'ITA').modifiers.some((m) => m.kind === 'treaty' && m.value === 10)).toBe(true);
    // un trattato scaduto o violato toglie «Trattato attivo»
    ctx.emit('AGREEMENT_CHANGED', 'world', { agreement: { ...ag, status: 'expired' } });
    expect(opinionOf(ctx.state, 'POL', 'ITA').modifiers.some((m) => m.kind === 'treaty')).toBe(false);
    // rifiutata: ostile e base militare → stato `expired`, ricarica di proposta respinta
    const rej = ctxOf((s) => { setRelation(s, 'POL', 'ITA', -50); });
    adjudicate(rej, [orders('ITA', [trade('p2', ['ITA', 'POL'], 'basing')])]);
    expect(Object.values(rej.state.agreements).find((a) => a.id.includes('p2'))!.status).toBe('expired');
    expect(rej.state.diplomacy!.cooldowns[rejKey('ITA', 'POL', 'basing')]).toBeGreaterThan(1);
    // una fazione risponde nel turno dopo: la proposta resta `proposed`
    const f = ctxOf();
    adjudicate(f, [orders('ITA', [trade('p3', ['ITA', 'EGY'])])]);
    expect(Object.values(f.state.agreements).find((a) => a.id.includes('p3'))!.status).toBe('proposed');
  });

});
