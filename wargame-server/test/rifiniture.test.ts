import { describe, expect, it } from 'vitest';
import type { GameEvent, LlmCall } from '../src/schemas/index.js';
import type { LlmProvider, LlmRequest } from '../src/agents/llm-client.js';
import { writeNews } from '../src/agents/gm-narrator.js';
import { numbersNotInFacts } from '../src/agents/repair.js';
import { makeEngine } from './helpers.js';
import { letterTriggers } from '../src/engine/letter-triggers.js';
import { loadScenario } from '../src/engine/scenario.js';
import { runSim } from '../src/cli/sim.js';
import type { FactionOrders } from '../src/schemas/index.js';
import { translateStances } from '../src/engine/stances.js';
import { TurnCtx } from '../src/engine/context.js';
import { Rng } from '../src/engine/rng.js';
import { continueTransit } from '../src/engine/movement.js';
import { adjudicate } from '../src/engine/adjudication.js';
import { crisisCoolChance, detenteActions } from '../src/engine/crises.js';
import { resolveDiplomacy } from '../src/engine/diplomacy.js';
import { migrationTarget } from '../src/engine/economy.js';
import { PARAMS } from '../src/engine/params.js';
import { leaderOf } from '../src/engine/diplomacy.js';
import { readFileSync, writeFileSync } from 'node:fs';

/** Modello finto: risponde sempre con lo stesso testo e conta le chiamate. */
const fixed = (payload: unknown): LlmProvider & { calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return { name: 'finto', calls, async complete(req) { calls.push(req); return { text: JSON.stringify(payload), usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'finto' }; } };
};

describe('notizie: un numero inventato non cancella tutto il turno', () => {
  const ev = (seq: number, type: GameEvent['type'], payload: Record<string, unknown>): GameEvent =>
    ({ id: `E4-${seq}`, turn: 4, seq, phase: 'DEBRIEF', type, actor: 'world', targets: [], payload, visibility: 'public', causedBy: null });
  const events = [ev(12, 'CRISIS_CHANGED', { crisisId: 'RED_SEA', delta: 1, cause: 'attacco a un mercantile' }), ev(15, 'RANDOM_EVENT', { eventId: 'X', text: 'Sbarchi a Lampedusa', zoneId: 'CANALE_SICILIA' })];

  it('5 notizie di cui una con un numero inventato → ne restano 4, senza repair, e lo scarto è nel registro', async () => {
    const news = [
      { outlet: 'ANSA', headline: 'Mar Rosso, sale la tensione', body: 'Nuovo attacco a un mercantile (E4-12).', eventIds: ['E4-12'] },
      { outlet: 'TRT', headline: 'Sbarchi a Lampedusa', body: 'Arrivati 438 migranti in una notte.', eventIds: ['E4-15'] },
      { outlet: 'RT', headline: 'Crisi nel Mar Rosso', body: 'La crisi sale di 1 livello.', eventIds: ['E4-12'] },
      { outlet: 'CNN', headline: 'Lampedusa', body: 'Sbarchi nel Canale di Sicilia.', eventIds: ['E4-15'] },
      { outlet: 'Xinhua', headline: 'Mediterraneo', body: 'Rotte sotto pressione, riferimento E4-99.', eventIds: [] },
    ];
    const p = fixed({ news });
    const log: LlmCall[] = [];
    const c = { config: { llm: { gm_narrator: { model: 'finto', temperature: 0, maxTokens: 100, timeoutMs: 1000 } } } } as never;
    const out = await writeNews(p, log, c, 4, events);
    expect(out).toHaveLength(4);
    expect(out.map((n) => n.headline)).not.toContain('Sbarchi a Lampedusa');
    expect(out.map((n) => n.id)).toEqual(['N4-1', 'N4-2', 'N4-3', 'N4-4']);
    expect(p.calls).toHaveLength(1);
    expect(log[0]).toMatchObject({ ok: true });
    expect(log[0]!.error).toContain('438');
  });

  it('se tutte le notizie hanno numeri inventati si chiede il repair', async () => {
    const p = fixed({ news: [{ outlet: 'ANSA', headline: 'Sbarchi', body: 'Arrivati 438 migranti.', eventIds: [] }] });
    const log: LlmCall[] = [];
    const c = { config: { llm: { gm_narrator: { model: 'finto', temperature: 0, maxTokens: 100, timeoutMs: 1000 } } } } as never;
    // dopo il repair fallito le notizie vengono dai fatti (agenzia ANSA, stessi eventi): niente numeri inventati
    const out = await writeNews(p, log, c, 4, events);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((n) => n.outlet === 'ANSA' && n.factsRef.length === 1)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('438');
    expect(p.calls.length).toBe(3);
    expect(log.every((l) => !l.ok)).toBe(true);
  });

  it('gli id degli eventi citati nel testo non contano come numeri', () => {
    expect(numbersNotInFacts('Vedi E4-12 ed E4-99.', ['nessun numero'])).toEqual([]);
    expect(numbersNotInFacts('Arrivati 438 migranti (E4-12)', ['{"delta":1}'])).toEqual(['438']);
  });

  it('con il mock il turno ha le sue notizie', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'n', seed: 'notizie' });
    await e.advance(c.id);
    expect((await e.store.getNarrative(c.id, 1))!.news.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('lettere IA di iniziativa: inneschi del motore', () => {
  const sc = loadScenario('med-2026');
  const writers = Object.values(sc.world.factions).filter((f) => f.controller === 'ai').map((f) => f.id);
  const ev = (seq: number, type: GameEvent['type'], actor: string, payload: Record<string, unknown>): GameEvent =>
    ({ id: `E3-${seq}`, turn: 3, seq, phase: 'ADJUDICATION', type, actor, targets: [], payload, visibility: 'public', causedBy: null });
  const orders = (factionId: string, diplomacy: FactionOrders['diplomacy']): FactionOrders =>
    ({ schemaVersion: 1, factionId, turn: 3, source: 'ai', military: [], diplomacy, procurement: [], statements: [] });

  it('minaccia, sanzione, blocco, ingaggio, tensione e accordo fanno scrivere chi li ha subiti, in ordine stabile', () => {
    const prevPrev = structuredClone(sc.world); const prev = structuredClone(sc.world);
    prev.relations.ALG!.TUN!.tension += 10; prev.relations.TUN!.ALG!.tension += 10; // il reducer le aggiorna entrambe
    const t = letterTriggers({
      state: sc.world, writers, prevState: prev, prevPrevState: prevPrev,
      prevOrders: [orders('TUR', [{ id: 'x', kind: 'THREAT', target: 'GRC', message: 'Ultimo avvertimento.', visibility: 'public' }, { id: 'y', kind: 'SANCTION', target: 'CHN', scope: 'acciaio' }]),
        orders('ITA', [{ id: 'z', kind: 'THREAT', target: 'NATO', message: 'x', visibility: 'public' }])],
      prevEvents: [
        ev(1, 'RELATION_CHANGED', 'FRA', { a: 'FRA', b: 'RUS', trust: -5, tension: 10, note: 'BLOCKADE in MAR_LIBICO' }),
        ev(2, 'ENGAGEMENT_OPENED', 'USA', { engagement: { id: 'ENG-3-1', zoneId: 'MAR_ROSSO', sides: [{ factionId: 'USA', unitIds: [] }, { factionId: 'IRN', unitIds: [] }] } }),
        ev(3, 'AGREEMENT_CHANGED', 'EGY', { agreement: { id: 'AG-3-ISR-1', type: 'energy', parties: ['ISR', 'EGY'], status: 'active' } }),
      ],
    });
    const key = t.map((x) => `${x.factionId}>${x.to}:${x.kind}:${x.tone}`);
    expect(key).toEqual([
      'ALG>TUN:tension:formal', 'CHN>TUR:sanction:firm', 'EGY>ISR:agreement:cordial', 'GRC>TUR:threat:firm',
      'IRN>USA:engagement:firm', 'RUS>FRA:blockade:firm', 'TUN>ALG:tension:formal', 'USA>IRN:engagement:firm',
    ]);
    // il gist viene dai fatti, senza numeri da inventare
    expect(t.find((x) => x.kind === 'blockade')!.gist).toContain(sc.world.zones.MAR_LIBICO!.name);
    expect(t.every((x) => !/\d/.test(x.gist))).toBe(true);
    // al primo turno (nessuno stato precedente) non c'è tensione da confrontare
    expect(letterTriggers({ state: sc.world, writers, prevState: null, prevPrevState: null, prevOrders: [], prevEvents: [] })).toEqual([]);
  });

  it('in mock: almeno 1 iniziativa dagli inneschi in media dal turno 2, tetto lettersPerTurn rispettato, replay identico', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'ini', seed: 'iniziative', config: { factionMode: 'llm', agentCadence: { lettersPerTurn: 2 } } });
    const r = await runSim(e, c, 5);
    const factions = Object.keys((await e.store.getState(r.campaign.id)).factions);
    let triggered = 0;
    for (let t = 2; t <= 5; t++) {
      const ls = (await Promise.all(factions.map((f) => e.store.getDecision(r.campaign.id, t, f)))).flatMap((d) => d?.letters ?? []);
      expect(ls.filter((l) => l.kind === 'initiative').length).toBeLessThanOrEqual(2);
      triggered += ls.filter((l) => l.trigger).length;
    }
    expect(triggered / 4).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('unità impegnate tra un turno e l\'altro', () => {
  const sc = loadScenario('med-2026');
  const ships = () => Object.values(structuredClone(sc.world.units)).filter((u) => u.factionId === 'ITA' && ['frigate', 'destroyer', 'opv'].includes(u.type)).sort((a, b) => a.id.localeCompare(b.id));
  const task = (zoneId: string) => ({ id: 'ITA-1-1', kind: 'PATROL', unitIds: [], zoneId, roe: 'WEAPONS_TIGHT' });

  it('una postura nella zona dove l\'unità è già impegnata (anche in viaggio) la conferma invece di scartarla', () => {
    const us = ships();
    // tutte le navi sono fuori: una in transito verso MAR_ROSSO (ancora in IONIO), le altre schierate con un compito in EGEO
    us.forEach((u) => Object.assign(u, { status: 'deployed', zoneId: 'EGEO', currentTask: task('EGEO') }));
    Object.assign(us[0]!, { status: 'transit', zoneId: 'IONIO', currentTask: task('MAR_ROSSO') });
    const r = translateStances({ units: us, zones: sc.world.zones, budget: 1000, turnLength: 'week', stances: [
      { zoneId: 'MAR_ROSSO', stance: 'patrol', intensity: 1 }, { zoneId: 'EGEO', stance: 'patrol', intensity: 1 }, { zoneId: 'IONIO', stance: 'patrol', intensity: 1 }] });
    expect(r.orders[0]).toMatchObject({ kind: 'PATROL', zoneId: 'MAR_ROSSO', unitIds: [us[0]!.id] });
    expect(r.orders[1]).toMatchObject({ kind: 'PATROL', zoneId: 'EGEO' });
    expect((r.orders[1] as { unitIds: string[] }).unitIds.every((id) => us.find((u) => u.id === id)!.zoneId === 'EGEO')).toBe(true);
    // in IONIO la nave di passaggio verso il Mar Rosso non viene distolta
    expect(r.orders.find((o) => 'zoneId' in o && o.zoneId === 'IONIO')).toBeUndefined();
    expect(r.notes.join()).toContain('postura patrol in IONIO: nessuna unità adatta disponibile');
    // il ritiro da MAR_ROSSO richiama anche chi ci sta ancora andando
    const w = translateStances({ units: us, zones: sc.world.zones, budget: 1000, turnLength: 'week', stances: [{ zoneId: 'MAR_ROSSO', stance: 'withdraw', intensity: 1 }] });
    expect(w.orders).toEqual([expect.objectContaining({ kind: 'RETURN_TO_BASE', unitIds: [us[0]!.id] })]);
  });

  it('un\'unità rimasta in transito prosegue verso la zona del compito all\'apertura del turno', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'tr', seed: 'transito' });
    const state = await e.store.getState(c.id);
    const u = Object.values(state.units).find((x) => x.factionId === 'ITA' && x.type === 'frigate')!;
    Object.assign(u, { status: 'transit', zoneId: 'IONIO', location: state.zones.IONIO!.center, currentTask: task('MAR_ROSSO') });
    const ctx = new TurnCtx(state, c, loadScenario('med-2026'), new Rng(c.seed, c.rngCursor, 2), 0);
    continueTransit(ctx);
    expect(ctx.state.units[u.id]).toMatchObject({ status: 'deployed', zoneId: 'MAR_ROSSO' });
    expect(ctx.events.map((x) => x.type)).toEqual(['UNIT_MOVED']);
  });
});

describe('bilanciamento delle crisi', () => {
  const ctxOf = async (seed: string) => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: seed, seed });
    const state = await e.store.getState(c.id);
    return new TurnCtx(state, c, loadScenario('med-2026'), new Rng(c.seed, c.rngCursor, 2), 0);
  };

  it('al massimo +1 di escalation per crisi per turno dagli ordini; le singole azioni pesano ancora sulle relazioni', async () => {
    const ctx = await ctxOf('tetto');
    const s = ctx.state;
    const before = s.crises.RED_SEA!.escalation;
    const ship = (f: string) => Object.values(s.units).find((u) => u.factionId === f && ['destroyer', 'frigate'].includes(u.type) && u.status === 'ready')!;
    // un'unità iraniana nella zona: i due blocchi colpiscono le relazioni con l'Iran
    const irn = Object.values(s.units).find((u) => u.factionId === 'IRN' && u.domain === 'sea')!;
    Object.assign(irn, { zoneId: 'MAR_ROSSO', status: 'deployed', location: s.zones.MAR_ROSSO!.center });
    const tensionBefore = { USA: s.relations.USA!.IRN!.tension, FRA: s.relations.FRA!.IRN!.tension };
    const blockade = (f: string): FactionOrders => ({ schemaVersion: 1, factionId: f, turn: ctx.turn, source: 'ai', diplomacy: [], procurement: [], statements: [],
      military: [{ id: `${f}-b`, kind: 'BLOCKADE', unitIds: [ship(f).id], zoneId: 'MAR_ROSSO', roe: 'WEAPONS_HOLD' }] });
    ctx.phase = 'ADJUDICATION';
    adjudicate(ctx, [blockade('USA'), blockade('FRA')]);
    const fromOrders = ctx.events.filter((x) => x.type === 'CRISIS_CHANGED' && x.payload.crisisId === 'RED_SEA' && x.payload.byOrders);
    expect(fromOrders.reduce((a, x) => a + Number(x.payload.delta), 0)).toBe(1);
    expect(s.crises.RED_SEA!.escalation - before).toBe(1);
    expect(s.relations.USA!.IRN!.tension).toBeGreaterThan(tensionBefore.USA);
    expect(s.relations.FRA!.IRN!.tension).toBeGreaterThan(tensionBefore.FRA);
    // gli effetti che non vengono dagli ordini (eventi, deriva) non sono limitati
    ctx.escalate('RED_SEA', 1, 'evento');
    expect(s.crises.RED_SEA!.escalation - before).toBe(2);
    // il tetto vale per crisi: un'altra crisi può ancora salire di 1 per gli ordini
    const east = s.crises.EAST_MED!.escalation;
    ctx.escalate('EAST_MED', 2, 'strike', { byOrders: true });
    expect(s.crises.EAST_MED!.escalation - east).toBe(PARAMS.crisisOrderCapPerTurn);
  }, 30_000);

  it('le azioni distensive tra le parti di una crisi aumentano la probabilità di raffreddamento nel turno dopo', async () => {
    const ctx = await ctxOf('distensione');
    resolveDiplomacy(ctx, 'ITA', { id: 'r', kind: 'REASSURANCE', target: 'LBY_GNU', message: 'ok', visibility: 'public' });
    resolveDiplomacy(ctx, 'ITA', { id: 'b', kind: 'BACKCHANNEL', target: 'TUN', message: 'ok' });
    resolveDiplomacy(ctx, 'ITA', { id: 'l', kind: 'LETTER', target: 'ALG', subject: 'Dialogo', body: 'Signor Presidente, parliamone.', tone: 'conciliatory', visibility: 'private' });
    resolveDiplomacy(ctx, 'ITA', { id: 'l2', kind: 'LETTER', target: 'ALG', subject: 'Dialogo', body: 'Signor Presidente.', tone: 'firm', visibility: 'private' });
    resolveDiplomacy(ctx, 'ITA', { id: 'd', kind: 'DEMARCHE', target: 'TUN', message: 'no', visibility: 'public' });
    const sahel = ctx.state.crises.SAHEL_MIG!.involved; // ITA, TUN, LBY_GNU, ALG, RUS
    expect(detenteActions(ctx.events, sahel)).toBe(3);
    expect(detenteActions(ctx.events, ctx.state.crises.EAST_MED!.involved)).toBe(0);
    // dopo un turno agitato senza diplomazia non si raffredda; con la diplomazia sì, e di più se le azioni sono di più
    expect(crisisCoolChance(false, 0.5, 0)).toBe(0);
    expect(crisisCoolChance(false, 0.5, 1)).toBeCloseTo(PARAMS.detenteCoolBonus);
    expect(crisisCoolChance(true, 0.5, 2)).toBeGreaterThan(crisisCoolChance(true, 0.5, 0));
    expect(crisisCoolChance(true, 1, 10)).toBeLessThanOrEqual(0.9);
  }, 30_000);

  it('la pressione migratoria non resta fissa a 100: massimo di regime 75, meno con un accordo migratorio', async () => {
    const ctx = await ctxOf('migrazione');
    ctx.state.crises.SAHEL_MIG!.escalation = 10;
    for (const a of Object.values(ctx.state.agreements)) if (a.type === 'migration') a.status = 'expired';
    expect(migrationTarget(ctx)).toBe(PARAMS.migration.base + 10 * PARAMS.migration.perLevel);
    expect(migrationTarget(ctx)).toBeLessThan(100);
    ctx.state.agreements['AG-X'] = { id: 'AG-X', type: 'migration', parties: ['ITA', 'LBY_GNU'], terms: 'rimpatri', startTurn: 1, endTurn: null, visibility: 'public', status: 'active' };
    expect(migrationTarget(ctx)).toBe(PARAMS.migration.base + 10 * PARAMS.migration.perLevel - PARAMS.migration.perAgreement);
  }, 30_000);
});

describe('campagne vecchie senza cariche dei leader', () => {
  it('in lettura leaderTitle e capital mancanti vengono dallo scenario, senza riscrivere i file salvati', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'vecchia', seed: 'vecchia' });
    // stato come nelle campagne create prima delle lettere: niente leaderTitle né capital
    for (const f of [e.store.dir(c.id, 'state', 'current.json'), e.store.dir(c.id, 'state', 'turn-0000.json')]) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      for (const x of Object.values(raw.factions) as Record<string, unknown>[]) { delete x.leaderTitle; delete x.capital; }
      writeFileSync(f, JSON.stringify(raw));
    }
    const file = e.store.dir(c.id, 'state', 'current.json');
    const before = readFileSync(file, 'utf8');
    const s = await e.store.getState(c.id);
    const tur = loadScenario('med-2026').world.factions.TUR!;
    expect(leaderOf(s, 'TUR')).toEqual({ title: tur.leaderTitle, capital: tur.capital });
    expect(leaderOf(s, 'TUR').title).not.toContain('Capo di Stato');
    expect((await e.store.getState(c.id, 0)).factions.ITA!.capital).toBe(loadScenario('med-2026').world.factions.ITA!.capital);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // una lettera scritta in un turno della campagna vecchia porta la carica vera
    const k = await e.knowledge(c.id);
    const d = await e.draftLetter(c.id, { target: 'TUR', gist: 'Dialogo diretto.', tone: 'cordial' });
    expect(d.body).not.toContain('Capo di Stato');
    expect(k.turn).toBe(1);
  }, 30_000);
});
