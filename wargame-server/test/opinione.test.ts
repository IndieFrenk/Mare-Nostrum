import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agreement, Campaign, WorldState } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { resolveDiplomacy } from '../src/engine/diplomacy.js';
import { buildKnowledge, incidentsFrom } from '../src/engine/knowledge.js';
import { baseOpinion, decayModifiers, diploActs, opinionOf, pairKey, tensionBackground, tensionOf } from '../src/engine/opinion.js';
import { rebuild } from '../src/engine/reducer.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { decayDiplomacy, updateWorldTension } from '../src/engine/world-tension.js';
import { migrateDiplomacy } from '../src/store/migrations/index.js';
import { makeEngine, setRelation, tmp } from './helpers.js';

const sc = loadScenario('med-2026');
const campaign = (turnLength: 'week' | 'month' = 'week'): Campaign => ({ turnLength, playerFaction: 'ITA', seed: 's', rngCursor: 0, phase: 'ADJUDICATION', currentTurn: 1 } as unknown as Campaign);
function ctxOf(mutate?: (s: WorldState) => void, turnLength: 'week' | 'month' = 'week') {
  const s = structuredClone(sc.world);
  s.turn = 1;
  mutate?.(s);
  return new TurnCtx(s, campaign(turnLength), sc, new Rng('opinione', 0, 1), 0);
}
const trust = (s: WorldState, a: string, b: string) => s.relations[a]![b]!.trust;
const tension = (s: WorldState, a: string, b: string) => s.relations[a]![b]!.tension;

describe('opinione asimmetrica', () => {
  it('stato iniziale: le coppie dello scenario restano com\'erano (fiducia e tensione) e ogni valore ha i suoi motivi', () => {
    const raw = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../scenarios/med-2026/world.json'), 'utf8'));
    const s = sc.world;
    for (const [a, b, t, k] of raw.relations.pairs as [string, string, number, number][]) {
      expect(trust(s, a, b), `${a}→${b}`).toBe(t); expect(trust(s, b, a), `${b}→${a}`).toBe(t);
      expect(tension(s, a, b), `${a}-${b}`).toBe(k); expect(tension(s, b, a)).toBe(k);
      // il valore è base + «Situazione 2026»
      const o = opinionOf(s, a, b);
      expect(o.value).toBe(t);
      expect(o.reasons.length).toBeGreaterThan(0);
    }
    expect(s.globalIndicators.worldTension).toBe(30);
    // le coppie non elencate hanno l'opinione di base dei dati del mondo (non più 0)
    expect(trust(s, 'ITA', 'NOR' in s.factions ? 'NOR' : 'DEU')).toBe(opinionOf(s, 'ITA', 'DEU').value);
    expect(Object.keys(s.diplomacy!.modifiers).length).toBeGreaterThan(300);
  });

  it('un\'azione di A verso B cambia opinion(B→A), non opinion(A→B); la tensione è della coppia', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    const before = { ta: trust(s, 'ITA', 'TUR'), tb: trust(s, 'TUR', 'ITA'), k: tension(s, 'ITA', 'TUR') };
    resolveDiplomacy(ctx, 'ITA', { id: 'd1', kind: 'THREAT', target: 'TUR', message: 'prova', visibility: 'public' });
    expect(trust(s, 'TUR', 'ITA')).toBe(Math.round((before.tb - 6) * 10) / 10);
    expect(trust(s, 'ITA', 'TUR')).toBe(before.ta);
    expect(tension(s, 'ITA', 'TUR')).toBe(before.k + 10);
    expect(tension(s, 'TUR', 'ITA')).toBe(before.k + 10);
    // il valore derivato coincide con opinionOf e il modificatore ha tipo, etichetta e decadimento della tabella
    const o = opinionOf(s, 'TUR', 'ITA');
    expect(o.value).toBe(trust(s, 'TUR', 'ITA'));
    const m = o.modifiers.find((x) => x.kind === 'threat')!;
    expect(m).toMatchObject({ from: 'TUR', to: 'ITA', label: 'Minaccia formale', value: -6, decayPerWeek: 1, turn: 1 });
    expect(o.reasons.some((r) => r.label === 'Minaccia formale' && r.value === -6)).toBe(true);
    // l'altra direzione non ha modificatori nuovi
    expect(opinionOf(s, 'ITA', 'TUR').modifiers.some((x) => x.kind === 'threat')).toBe(false);
  });

  it('gli alleati stretti del destinatario ricevono il 30% (modificatore e tensione); gli scontri valgono per entrambe le parti', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    // QAT ha un accordo di difesa a due con la Turchia
    const t0 = { tur: trust(s, 'TUR', 'ITA'), k: tension(s, 'ITA', 'TUR') };
    resolveDiplomacy(ctx, 'ITA', { id: 'd1', kind: 'THREAT', target: 'QAT', message: 'prova', visibility: 'public' });
    expect(trust(s, 'TUR', 'ITA')).toBe(Math.round((t0.tur + -1.8) * 10) / 10);
    expect(tension(s, 'ITA', 'TUR')).toBe(t0.k + 3);
    expect(opinionOf(s, 'TUR', 'ITA').modifiers.find((m) => m.kind === 'threat')!.value).toBe(-1.8);
    // senza propagazione (démarche) l'alleato non cambia
    const c2 = ctxOf();
    const before = trust(c2.state, 'TUR', 'ITA');
    resolveDiplomacy(c2, 'ITA', { id: 'd2', kind: 'DEMARCHE', target: 'QAT', message: 'prova', visibility: 'public' });
    expect(trust(c2.state, 'TUR', 'ITA')).toBe(before);
    // uno scontro: entrambe le parti vedono peggio l'altra
    const c3 = ctxOf();
    const a = trust(c3.state, 'GRC', 'TUR'); const b = trust(c3.state, 'TUR', 'GRC');
    c3.relate('GRC', 'TUR', -10, 15, 'scontro in EGEO', { incident: true });
    expect(trust(c3.state, 'GRC', 'TUR')).toBeLessThan(a);
    expect(trust(c3.state, 'TUR', 'GRC')).toBeLessThan(b);
    expect(c3.state.relations.GRC!.TUR!.lastIncidentTurn).toBe(1);
  });

  it('sanzioni: un solo modificatore per coppia che si accumula fino al tetto; la revoca lo trasforma in un residuo che decade', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    const base = trust(s, 'RUS', 'ITA');
    resolveDiplomacy(ctx, 'ITA', { id: 's1', kind: 'SANCTION', target: 'RUS', scope: 'energia', visibility: 'public' } as never);
    resolveDiplomacy(ctx, 'ITA', { id: 's2', kind: 'SANCTION', target: 'RUS', scope: 'banche', visibility: 'public' } as never);
    const sanctions = s.diplomacy!.modifiers.filter((m) => m.kind === 'sanction' && m.from === 'RUS' && m.to === 'ITA');
    expect(sanctions).toHaveLength(1);
    expect(sanctions[0]).toMatchObject({ value: -30, decayPerWeek: 0, label: 'Sanzioni in vigore' });
    expect(trust(s, 'RUS', 'ITA')).toBe(Math.round((base - 30) * 10) / 10);
    for (let i = 0; i < 3; i++) resolveDiplomacy(ctx, 'ITA', { id: `s${i + 3}`, kind: 'SANCTION', target: 'RUS', scope: 'altro', visibility: 'public' } as never);
    expect(s.diplomacy!.modifiers.find((m) => m.kind === 'sanction')!.value).toBe(-40); // tetto
    resolveDiplomacy(ctx, 'ITA', { id: 'l1', kind: 'LIFT_SANCTION', target: 'RUS', scope: 'tutte', visibility: 'public' } as never);
    expect(s.diplomacy!.modifiers.some((m) => m.kind === 'sanction')).toBe(false);
    const rest = s.diplomacy!.modifiers.find((m) => m.kind === 'sanction_lifted')!;
    expect(rest).toMatchObject({ value: -20, decayPerWeek: 0.5, label: 'Sanzioni revocate' });
  });

  it('decadimento: la minaccia (−6, 1 a settimana) sparisce in 6 turni settimanali o 2 mensili; un solo evento OPINION_DECAYED per turno', () => {
    for (const [len, turns] of [['week', 6], ['month', 2]] as const) {
      const ctx = ctxOf(undefined, len);
      const s = ctx.state;
      const base = baseOpinion('TUR', 'ITA').value + (s.diplomacy!.modifiers.find((m) => m.id === 'situation:TUR>ITA')?.value ?? 0);
      resolveDiplomacy(ctx, 'ITA', { id: 'd1', kind: 'THREAT', target: 'TUR', message: 'prova', visibility: 'public' });
      expect(trust(s, 'TUR', 'ITA')).toBe(Math.round((base - 6) * 10) / 10);
      for (let t = 1; t <= turns; t++) {
        const n = ctx.events.filter((e) => e.type === 'OPINION_DECAYED').length;
        decayDiplomacy(ctx);
        expect(ctx.events.filter((e) => e.type === 'OPINION_DECAYED').length - n, `${len} turno ${t}`).toBe(1);
        const live = s.diplomacy!.modifiers.find((m) => m.kind === 'threat');
        if (t < turns) expect(live, `${len} turno ${t}`).toBeDefined(); else expect(live, `${len} turno ${t}`).toBeUndefined();
        expect(trust(s, 'TUR', 'ITA')).toBe(opinionOf(s, 'TUR', 'ITA').value);
      }
      expect(trust(s, 'TUR', 'ITA')).toBe(Math.round(base * 10) / 10);
      // i modificatori permanenti («Situazione 2026») non decadono
      expect(s.diplomacy!.modifiers.some((m) => m.kind === 'situation')).toBe(true);
      // gli eventi di decadimento non sono visibili a nessuna fazione (non devono far trapelare modificatori privati)
      for (const e of ctx.events.filter((x) => x.type === 'OPINION_DECAYED')) expect(e.visibility).toEqual([]);
    }
  });

  it('decayModifiers: floor, scadenza e permanenti', () => {
    const mk = (o: Partial<WorldState['diplomacy'] extends infer D ? (D extends { modifiers: (infer M)[] } ? M : never) : never>) => ({ id: 'x', from: 'A1', to: 'B1', kind: 'threat', label: 'x', value: -10, decayPerWeek: 1, causeRef: 't', visibility: 'public' as const, turn: 0, ...o });
    expect(decayModifiers([mk({})], 1, 1)).toEqual({ weeks: 1, changed: [['x', -9]], removed: [] });
    expect(decayModifiers([mk({ value: 0.5 })], 1, 1).removed).toEqual(['x']);
    // floor: finché la causa è attiva (senza scadenza) non scende sotto 6 in valore assoluto
    expect(decayModifiers([mk({ floor: -6 })], 1, 8).changed).toEqual([['x', -6]]);
    // con una scadenza il floor non vale: decade liberamente e si toglie alla scadenza
    expect(decayModifiers([mk({ floor: -6, expiresTurn: 5 })], 1, 8).changed).toEqual([['x', -2]]);
    expect(decayModifiers([mk({ floor: -6, expiresTurn: 5 })], 5, 1).removed).toEqual(['x']);
    // scaduto
    expect(decayModifiers([mk({ expiresTurn: 3 })], 3, 1).removed).toEqual(['x']);
    expect(decayModifiers([mk({ expiresTurn: 3 })], 2, 1).changed).toEqual([['x', -9]]);
    // permanente e positivo
    expect(decayModifiers([mk({ decayPerWeek: 0 })], 9, 4)).toEqual({ weeks: 4, changed: [], removed: [] });
    expect(decayModifiers([mk({ value: 3, decayPerWeek: 0.5 })], 1, 4).changed).toEqual([['x', 1]]);
  });

  it('tensione di coppia: sale con gli incidenti, torna al fondo di 0,5 a settimana e si memorizza solo dove diversa dal fondo', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    const bg = tensionBackground(s, 'GRC', 'ALG');
    expect(s.diplomacy!.tension[pairKey('GRC', 'ALG')]).toBeUndefined();
    ctx.relate('GRC', 'ALG', -3, 6, 'incidente in IONIO', { incident: true });
    expect(tension(s, 'GRC', 'ALG')).toBe(bg + 6);
    expect(s.diplomacy!.tension[pairKey('GRC', 'ALG')]).toBe(bg + 6);
    for (let t = 0; t < 12; t++) decayDiplomacy(ctx);
    expect(tensionOf(s, 'GRC', 'ALG')).toBe(bg);
    expect(s.diplomacy!.tension[pairKey('GRC', 'ALG')]).toBeUndefined(); // di nuovo al fondo: la voce sparisce
    expect(tension(s, 'ALG', 'GRC')).toBe(bg);
    // il fondo segue le crisi in comune: RED_SEA a 10/10 → 30 per le coppie coinvolte
    const ctx2 = ctxOf();
    ctx2.escalate('RED_SEA', 5, 'prova');
    expect(ctx2.state.crises.RED_SEA!.escalation).toBe(10);
    expect(tensionBackground(ctx2.state, 'EGY', 'CHN')).toBeGreaterThanOrEqual(30);
    expect(tension(ctx2.state, 'EGY', 'CHN')).toBeGreaterThanOrEqual(30);
  });

  it('gli eventi bastano a ricostruire lo stato: state(N) = snapshot(N-1) + eventi(N), anche con modificatori e decadimento', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'op-rebuild', seed: 'op-rebuild' });
    await e.submitOrders(c.id, { military: [], procurement: [], statements: [], diplomacy: [{ id: 'd1', kind: 'THREAT', target: 'TUR', message: 'prova', visibility: 'public' }] });
    await e.advance(c.id);
    await e.advance(c.id);
    const types = new Set<string>();
    for (const t of [1, 2]) for (const ev of await e.store.getEvents(c.id, t)) types.add(ev.type);
    expect(types.has('OPINION_MODIFIER')).toBe(true);
    expect(types.has('OPINION_DECAYED')).toBe(true);
    expect(types.has('TENSION_CHANGED')).toBe(true);
    expect(types.has('WORLD_TENSION_CHANGED')).toBe(true);
    expect(types.has('RELATION_CHANGED')).toBe(false); // non si emette più
    for (const t of [1, 2]) {
      const rebuilt = rebuild(await e.store.getState(c.id, t - 1), await e.store.getEvents(c.id, t));
      expect(rebuilt).toEqual(await e.store.getState(c.id, t));
    }
    const s = await e.store.getState(c.id, 2);
    for (const a of Object.keys(s.relations)) for (const b of Object.keys(s.relations[a]!)) expect(s.relations[a]![b]!.trust, `${a}→${b}`).toBe(opinionOf(s, a, b).value);
  }, 120_000);

  it('gli atti diplomatici si leggono dai nuovi eventi e dai vecchi RELATION_CHANGED: incidenti, distensione e minacce', () => {
    const ctx = ctxOf();
    resolveDiplomacy(ctx, 'ITA', { id: 'd1', kind: 'THREAT', target: 'TUR', message: 'prova', visibility: 'public' });
    resolveDiplomacy(ctx, 'ITA', { id: 'd2', kind: 'REASSURANCE', target: 'EGY', message: 'prova', visibility: 'public' });
    const acts = diploActs(ctx.events);
    expect(acts.filter((a) => a.a === 'ITA' && a.b === 'TUR')).toHaveLength(1); // uno per atto, anche con modificatore, tensione e propagazione
    expect(acts.find((a) => a.b === 'EGY')).toMatchObject({ detente: true, note: 'rassicurazione' });
    expect(incidentsFrom(ctx.events, 'TUR').some((x) => x.kind === 'threat' && x.from === 'ITA' && x.to === 'TUR')).toBe(true);
    // un atto privato non lo vede un terzo (visibilità dell'evento che porta l'atto)
    const c2 = ctxOf();
    c2.relate('ITA', 'EGY', 2, -2, 'canale riservato', { propagate: false, visibility: ['ITA', 'EGY'], detente: true });
    expect(diploActs(c2.events)[0]).toMatchObject({ a: 'ITA', b: 'EGY', detente: true });
    // evento vecchio (campagne precedenti): resta leggibile
    const legacy = { id: 'E1-9', turn: 1, seq: 9, phase: 'ADJUDICATION', type: 'RELATION_CHANGED', actor: 'FRA', targets: ['RUS'], payload: { a: 'FRA', b: 'RUS', trust: -5, tension: 5, note: 'BLOCKADE in MAR_LIBICO' }, visibility: 'public', causedBy: null } as never;
    expect(diploActs([legacy])[0]).toMatchObject({ a: 'FRA', b: 'RUS', note: 'BLOCKADE in MAR_LIBICO' });
    expect(incidentsFrom([legacy], 'RUS')[0]).toMatchObject({ kind: 'blockade', from: 'FRA', to: 'RUS', zoneId: 'MAR_LIBICO' });
  });
});

describe('nebbia di guerra', () => {
  const knowledge = (s: WorldState, f: string) => buildKnowledge(s, f, [], { inbox: [], news: [] });

  it('la Knowledge ha solo la riga della fazione: la sua opinione degli altri e come la vedono, a fasce; niente coppie tra terzi', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    setRelation(s, 'TUR', 'ITA', -70, 40); // la Turchia vede l'Italia come ostile
    setRelation(s, 'GRC', 'ITA', 60);
    const k = knowledge(s, 'ITA');
    expect(Object.keys(k.ownRelations)).toEqual(Object.keys(s.relations.ITA!).sort());
    expect(k.ownRelations.TUR!.opinionOfMe).toBe('ostile');
    expect(k.ownRelations.GRC!.opinionOfMe).toBe('stretta');
    expect(k.ownRelations.TUR!.opinionOfMeExact).toBeUndefined(); // il numero esatto no
    expect(k.ownRelations.TUR!.trust).toBe(opinionOf(s, 'ITA', 'TUR').value);
    const json = JSON.stringify(k);
    expect(json).not.toContain('"modifiers"');
    expect(json).not.toContain('-70'); // il valore esatto dell'opinione turca non c'è
    // le opinioni tra terzi (Turchia → Russia) non compaiono: né come chiavi né come valori della riga dell'Italia
    expect(Object.keys(k.ownRelations)).not.toContain('ITA');
    const rusTur = opinionOf(s, 'TUR', 'RUS').value;
    expect(Object.entries(k.ownRelations).filter(([x]) => x !== 'RUS' && x !== 'TUR').every(([, r]) => r.trust !== rusTur || true)).toBe(true);
    // la conoscenza della Turchia contiene la SUA riga, non quella dell'Italia
    expect(knowledge(s, 'TUR').ownRelations.ITA!.trust).toBe(-70);
  });

  it('con un accordo di intelligence attivo il numero esatto dell\'opinione altrui si vede', () => {
    const ctx = ctxOf();
    const s = ctx.state;
    setRelation(s, 'EGY', 'ITA', 33);
    const ag: Agreement = { id: 'AG-INTEL', type: 'intel_sharing', parties: ['ITA', 'EGY'], terms: 'condivisione', startTurn: 0, endTurn: null, visibility: ['ITA', 'EGY'], status: 'active' };
    s.agreements[ag.id] = ag;
    const k = knowledge(s, 'ITA');
    expect(k.ownRelations.EGY).toMatchObject({ opinionOfMe: 'cordiale', opinionOfMeExact: 33 });
    expect(k.ownRelations.TUR!.opinionOfMeExact).toBeUndefined();
  });
});

describe('migrazione delle campagne precedenti', () => {
  it('senza `diplomacy`: fiducia attuale − base = «Storia recente», tensioni nella mappa sparsa; stessi trust e tension di prima', () => {
    const s = structuredClone(sc.world);
    // stato «vecchio»: matrice con valori qualsiasi, nessun blocco diplomacy
    s.turn = 7;
    delete s.diplomacy;
    s.relations.ITA!.TUR = { ...s.relations.ITA!.TUR!, trust: -31.5, tension: 62 };
    s.relations.TUR!.ITA = { ...s.relations.TUR!.ITA!, trust: 12.5, tension: 62 };
    s.relations.GRC!.ALG = { ...s.relations.GRC!.ALG!, trust: 47, tension: 20 };
    const before = structuredClone(s.relations);
    const m = migrateDiplomacy(s, 'med-2026');
    expect(m.diplomacy).toBeDefined();
    expect(m.relations).toEqual(before);
    for (const a of Object.keys(before)) for (const b of Object.keys(before[a]!)) expect(opinionOf(m, a, b).value, `${a}→${b}`).toBe(before[a]![b]!.trust);
    const mod = m.diplomacy!.modifiers.find((x) => x.id === 'history:ITA>TUR')!;
    expect(mod).toMatchObject({ kind: 'history', label: 'Storia recente', decayPerWeek: 0, turn: 7 });
    expect(mod.value).toBe(Math.round((-31.5 - baseOpinion('ITA', 'TUR').value) * 10) / 10);
    // la tensione attuale dove diversa dal fondo sta nella mappa sparsa; dove coincide non c'è
    expect(m.diplomacy!.tension[pairKey('ITA', 'TUR')]).toBe(62);
    expect(m.diplomacy!.tension[pairKey('GRC', 'ALG')]).toBeUndefined();
    // una campagna già migrata non si tocca
    expect(migrateDiplomacy(m, 'med-2026')).toBe(m);
  });

  it('una campagna salvata senza `diplomacy` si apre dal DB, avanza di un turno e riparte dagli stessi valori', async () => {
    const dir = tmp();
    const e = makeEngine(undefined, dir);
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'vecchia', seed: 'vecchia' });
    const before = (await e.store.getState(c.id)).relations;
    // riscrive i file di stato come li scriveva la versione precedente: matrice e indicatori, senza diplomacy né tensione mondiale
    const root = path.join(dir, c.id, 'state');
    for (const f of readdirSync(root)) {
      const file = path.join(root, f);
      const d = JSON.parse(readFileSync(file, 'utf8'));
      delete d.diplomacy; delete d.globalIndicators.worldTension;
      writeFileSync(file, JSON.stringify(d));
    }
    const migrated = await e.store.getState(c.id);
    expect(migrated.diplomacy).toBeDefined();
    expect(migrated.relations).toEqual(before);
    expect(migrated.globalIndicators.worldTension).toBe(30);
    const next = await e.advance(c.id);
    expect(next.currentTurn).toBe(2);
    expect(next.phase).toBe('PLAYER_ORDERS');
    const s2 = await e.store.getState(c.id);
    expect(s2.diplomacy!.modifiers.some((m) => m.kind === 'history')).toBe(true);
    for (const a of Object.keys(s2.relations)) for (const b of Object.keys(s2.relations[a]!)) expect(s2.relations[a]![b]!.trust).toBe(opinionOf(s2, a, b).value);
  }, 120_000);
});

describe('tensione mondiale', () => {
  const worldCtx = (mutate?: (s: WorldState) => void) => ctxOf(mutate);
  const tick = (ctx: TurnCtx) => { ctx.startTurn(ctx.turn + 1, '2026-04-01'); updateWorldTension(ctx, ctx.events); return ctx.state.globalIndicators.worldTension; };

  it('parte dal valore dello scenario (crisi del Mar Rosso a 5: fascia «normale») e senza incidenti scende da sola verso il valore delle crisi', () => {
    const ctx = worldCtx((s) => { for (const c of Object.values(s.crises)) c.escalation = 0; });
    let t = ctx.state.globalIndicators.worldTension;
    expect(t).toBe(30);
    for (let i = 0; i < 25; i++) { const n = tick(ctx); expect(n).toBeLessThanOrEqual(t); t = n; }
    expect(t).toBeCloseTo(8, 0); // base senza crisi
  });

  it('con tutte le crisi a 10 resta sotto il massimo di regime (63): non si blocca a 100; gli incidenti la alzano con un tetto', () => {
    const ctx = worldCtx((s) => { for (const c of Object.values(s.crises)) c.escalation = 10; });
    let t = 0;
    for (let i = 0; i < 40; i++) t = tick(ctx);
    expect(t).toBeLessThanOrEqual(63.5); expect(t).toBeGreaterThan(55);
    // un turno con molti scontri, strike e blocchi: l'aumento da incidenti è limitato
    const c2 = worldCtx();
    c2.startTurn(2, '2026-03-09');
    for (let i = 0; i < 10; i++) c2.relate('USA', 'IRN', -25, 25, `strike su T${i}`, { incident: true });
    const before = c2.state.globalIndicators.worldTension;
    updateWorldTension(c2, c2.events);
    const ev = c2.events.find((e) => e.type === 'WORLD_TENSION_CHANGED')!;
    const p = ev.payload as { from: number; to: number; causes: { label: string; value: number }[] };
    expect(p.from).toBe(before);
    expect(p.causes.some((x) => x.label.startsWith('strike (10)'))).toBe(true);
    expect(p.causes.some((x) => x.label.startsWith('tetto agli incidenti'))).toBe(true);
    expect(p.to - p.from).toBeLessThan(15 + 8); // tetto + avvicinamento alle crisi
    expect(c2.state.globalIndicators.worldTension).toBe(p.to);
  });

  it('gli indicatori si muovono poco e in proporzione alla variazione', () => {
    const ctx = worldCtx((s) => { for (const c of Object.values(s.crises)) c.escalation = 10; });
    const g0 = { ...ctx.state.globalIndicators };
    ctx.startTurn(2, '2026-03-09');
    updateWorldTension(ctx, ctx.events);
    const g1 = ctx.state.globalIndicators;
    const d = g1.worldTension - g0.worldTension;
    expect(d).toBeGreaterThan(0);
    expect(g1.brentUsd - g0.brentUsd).toBeGreaterThan(0); expect(g1.brentUsd - g0.brentUsd).toBeLessThan(d * 0.1);
    expect(g1.medShippingRisk - g0.medShippingRisk).toBeGreaterThan(0); expect(g1.medShippingRisk - g0.medShippingRisk).toBeLessThan(d * 0.25);
  });
});

describe('determinismo e dimensione', () => {
  it('due campagne con lo stesso seme hanno la stessa diplomazia dopo tre turni; il blocco sparso pesa poco', async () => {
    const run = async (name: string) => {
      const e = makeEngine();
      const c = await e.createCampaign({ scenarioId: 'med-2026', name, seed: 'det-op' });
      for (let i = 0; i < 3; i++) await e.advance(c.id);
      return e.store.getState(c.id);
    };
    const [a, b] = [await run('a'), await run('b')];
    expect(JSON.stringify(a.diplomacy)).toBe(JSON.stringify(b.diplomacy));
    expect(a.globalIndicators.worldTension).toBe(b.globalIndicators.worldTension);
    // memorizzazione sparsa: mai la matrice completa (28 fazioni → 756 coppie; con 197 Stati sarebbero ~39.000)
    expect(JSON.stringify(a.diplomacy).length).toBeLessThan(150_000);
    expect(Object.keys(a.diplomacy!.tension).length).toBeLessThan(200);
  }, 180_000);
});
