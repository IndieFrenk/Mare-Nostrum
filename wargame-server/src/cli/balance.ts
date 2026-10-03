// Statistica di bilanciamento su più seed, senza rete: fazioni a regole (predefinito) o IA mock, e un giocatore «moderato» come
// quello del playtest (due pattuglie, una mossa diplomatica a rotazione DEMARCHE/REASSURANCE/BACKCHANNEL, una lettera ogni 2 turni).
// Uso: npm --prefix wargame-server run balance -- --seeds 10 --turns 20 [--mode rules|llm] [--json out.json]
// Riporta: escalation finale per crisi, quante crisi a 10/10, turno medio del primo 10/10, pressione migratoria media; ordini con
// unità per fazione IA per turno, ingaggi, lettere IA di iniziativa per turno, chiamate LLM per turno e tempo per turno.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MockLLMProvider } from '../agents/mock-provider.js';
import { LlmAgents } from '../agents/orchestrator.js';
import type { LlmRequest } from '../agents/llm-client.js';
import { PARAMS } from '../engine/params.js';
import { worldData } from '../engine/world-data.js';
import { Engine, agentFactions } from '../engine/turn-machine.js';
import type { FactionMode } from '../config.js';
import type { OrdersBody } from '../schemas/index.js';
import { JsonStore } from '../store/json-store.js';
import { runSim } from './sim.js';

/** Ordini del giocatore moderato del playtest (stesse scelte di cli/playtest.ts, senza bozze LLM né acquisti). */
export async function moderatePlayer(engine: Engine, id: string, t: number) {
  const k = await engine.knowledge(id);
  const ships = k.ownUnits.filter((u) => u.status === 'ready' && u.readiness >= 50 && ['frigate', 'opv', 'destroyer'].includes(u.type));
  const worn = k.ownUnits.filter((u) => u.status === 'deployed' && u.readiness < 35);
  const zones = ['CANALE_SICILIA', 'IONIO', 'TIRRENO', 'MAR_LIBICO', 'MEDITERRANEO_ORIENTALE'];
  const o: OrdersBody = { military: [], diplomacy: [], procurement: [], statements: [] };
  ships.slice(0, 2).forEach((s, i) => o.military.push({ id: `p${i}`, kind: 'PATROL', unitIds: [s.id], zoneId: i === 0 ? s.zoneId : zones[t % zones.length]!, roe: 'WEAPONS_TIGHT' }));
  if (worn.length) o.military.push({ id: 'rtb', kind: 'RETURN_TO_BASE', unitIds: worn.map((u) => u.id) });
  const diplo: OrdersBody['diplomacy'] = [
    { id: 'd1', kind: 'DEMARCHE', target: 'TUR', message: 'Chiediamo moderazione nel Mediterraneo orientale.', visibility: 'public' },
    { id: 'd2', kind: 'REASSURANCE', target: 'LBY_GNU', message: 'L\'Italia sostiene la stabilità e la cooperazione sulla migrazione.', visibility: ['LBY_GNU'] },
    { id: 'd3', kind: 'BACKCHANNEL', target: 'EGY', message: 'Proponiamo un coordinamento riservato sul Mar Rosso.' },
  ];
  o.diplomacy.push(diplo[t % diplo.length]!);
  if (t % 2 === 1) {
    const to = ['TUR', 'LBY_GNU', 'EGY'][Math.floor(t / 2) % 3]!;
    o.diplomacy.push({ id: `pl${t}`, kind: 'LETTER', target: to, subject: 'Proposta di dialogo', body: 'Signor Presidente,\nLe propongo un canale di dialogo diretto tra i nostri Governi.', tone: (['firm', 'cordial', 'formal'] as const)[Math.floor(t / 2) % 3]!, visibility: 'private' });
  }
  if (t % 2 === 1) o.statements.push({ id: 's1', audience: 'opinione pubblica', text: 'La Marina garantisce la sicurezza delle rotte.', tone: 'firm' });
  const v = await engine.validate(id, o);
  if (!v.valid) for (const key of ['military', 'diplomacy', 'procurement', 'statements'] as const) (o[key] as { id: string }[]) = (o[key] as { id: string }[]).filter((x) => !v.errors.some((e) => e.startsWith(`${x.id}:`)));
  await engine.submitOrders(id, o);
}

/** Per turno: ordini IA con unità per fazione, ingaggi, lettere IA di iniziativa, chiamate LLM (mock) e tempo. */
export interface TurnStats { unitOrdersPerFaction: number; engagements: number; initiatives: number; llmCalls: number; ms: number }
/**
 * `opinionMean`: fiducia media tra tutte le coppie ordinate di fazioni (la riga di ogni fazione: opinione verso le altre) a fine turno,
 * dal turno 0; `worldTension`: tensione mondiale a fine turno (NaN per i motori che non l'hanno).
 */
export interface BalanceRun {
  seed: string; mode: FactionMode; final: Record<string, number>; firstMax: Record<string, number | null>; migration: number[]; turns: TurnStats[]; llmByRole: Record<string, number>; opinionMean: number[]; worldTension: number[];
  /** capitale diplomatico (settore 09): media per fazione a fine turno (dal turno 0), quota di fazioni al tetto e a zero per turno, azioni diplomatiche per tipo, accordi firmati, voti, ultimatum */
  capitalMean: number[]; capitalAtCap: number[]; capitalAtZero: number[]; diploByKind: Record<string, number>; agreementsSigned: number; votes: { total: number; passed: number }; ultimatums: { issued: number; expired: number; met: number };
  /** IA mondiale (settore 10): azioni del livello C per tipo, reazioni (eventi gravi, Stati che condannano / sostengono / tacciono), accordi commerciali in vigore alla fine, lettere di uno Stato del mondo all'Italia, azioni rifiutate, eventi per turno e ms di AI_DECISIONS + ADJUDICATION */
  world: { actionsByKind: Record<string, number>; reactionEvents: number; condemn: number; support: number; silent: number; blockAdopters: number; tradeActive: number; lettersToPlayer: number; rejected: number; eventsPerTurn: number; msAiAdjudication: number[] };
}
const meanTrust = (s: { relations: Record<string, Record<string, { trust: number }>> }) => { const v = Object.values(s.relations).flatMap((r) => Object.values(r).map((x) => x.trust)); return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); };

/** Mock che conta le chiamate per ruolo (quelle delle fazioni spariscono in modalità rules). */
class CountingMock extends MockLLMProvider {
  byRole: Record<string, number> = {};
  total = 0;
  override async complete(req: LlmRequest) { this.byRole[req.role] = (this.byRole[req.role] ?? 0) + 1; this.total++; return super.complete(req); }
}

export async function balanceRun(seed: string, turns: number, dir: string, mode: FactionMode = 'rules'): Promise<BalanceRun> {
  const mock = new CountingMock();
  const engine = new Engine(new JsonStore(dir), new LlmAgents(mock));
  let worldRejected = 0;
  engine.onProgress = (_, m) => { if (m.rejected) worldRejected += (m.rejected as { factionId: string }[]).filter((x) => !!worldData().nation(x.factionId) && !worldData().nation(x.factionId)!.factionId).length; };
  const c = await engine.createCampaign({ scenarioId: 'med-2026', name: `balance ${seed}`, seed, config: { factionMode: mode } });
  const perTurn: TurnStats[] = [];
  let calls = mock.total; let t0 = Date.now();
  const r = await runSim(engine, c, turns, async (t) => {
    // il turno precedente è chiuso: le sue chiamate e il suo tempo (la creazione conta nel primo)
    if (t > 1) { perTurn.push({ unitOrdersPerFaction: 0, engagements: 0, initiatives: 0, llmCalls: mock.total - calls, ms: Date.now() - t0 }); calls = mock.total; t0 = Date.now(); }
    await moderatePlayer(engine, c.id, t);
  });
  perTurn.push({ unitOrdersPerFaction: 0, engagements: 0, initiatives: 0, llmCalls: mock.total - calls, ms: Date.now() - t0 });
  const firstMax: Record<string, number | null> = {}; const migration: number[] = [];
  const opinionMean = [meanTrust(await engine.store.getState(r.campaign.id, 0))]; const worldTension: number[] = [];
  let final: Record<string, number> = {};
  const capitalOf = (s: { diplomacy?: { capital: Record<string, number> } }) => Object.values(s.diplomacy?.capital ?? {});
  const capitalMean: number[] = []; const capitalAtCap: number[] = []; const capitalAtZero: number[] = [];
  const noteCapital = (s: Parameters<typeof capitalOf>[0]) => {
    const c = capitalOf(s);
    capitalMean.push(+(c.reduce((a, b) => a + b, 0) / Math.max(1, c.length)).toFixed(2));
    capitalAtCap.push(+(c.filter((x) => x >= PARAMS.diplo.capital.cap - 0.05).length / Math.max(1, c.length)).toFixed(3));
    capitalAtZero.push(+(c.filter((x) => x < 0.5).length / Math.max(1, c.length)).toFixed(3));
  };
  noteCapital(await engine.store.getState(r.campaign.id, 0));
  const world: BalanceRun['world'] = { actionsByKind: {}, reactionEvents: 0, condemn: 0, support: 0, silent: 0, blockAdopters: 0, tradeActive: 0, lettersToPlayer: 0, rejected: 0, eventsPerTurn: 0, msAiAdjudication: [] };
  let totalEvents = 0;
  const diploByKind: Record<string, number> = {}; let agreementsSigned = 0; const votes = { total: 0, passed: 0 }; const ultimatums = { issued: 0, expired: 0, met: 0 };
  const agents = agentFactions(await engine.store.getState(r.campaign.id, 0));
  for (let t = 1; t <= turns; t++) {
    const s = await engine.store.getState(r.campaign.id, t);
    migration.push(s.globalIndicators.migrationPressure);
    opinionMean.push(meanTrust(s)); worldTension.push((s.globalIndicators as { worldTension?: number }).worldTension ?? NaN);
    noteCapital(s);
    for (const cr of Object.values(s.crises)) { if (!(cr.id in firstMax)) firstMax[cr.id] = null; if (cr.escalation >= 10 && firstMax[cr.id] === null) firstMax[cr.id] = t; }
    final = Object.fromEntries(Object.values(s.crises).map((cr) => [cr.id, cr.escalation]));
    const ds = (await Promise.all(agents.map((f) => engine.store.getDecision(r.campaign.id, t, f)))).filter((d) => !!d);
    const units = ds.reduce((n, d) => n + d.orders.military.filter((o) => 'unitIds' in o && o.unitIds.length).length, 0);
    const events = await engine.store.getEvents(r.campaign.id, t);
    totalEvents += events.length;
    const wd = await engine.store.getWorldDecision(r.campaign.id, t);
    if (wd) {
      for (const a of wd.actions) world.actionsByKind[a.action.kind] = (world.actionsByKind[a.action.kind] ?? 0) + 1;
      world.reactionEvents += wd.reactions.length;
      for (const x of wd.reactions) { world.condemn += x.condemn.length; world.support += x.support.length; world.silent += x.silent.length; }
      world.blockAdopters += wd.blockSanctions.reduce((n, b) => n + b.adopters.length, 0);
      world.lettersToPlayer += wd.letters.filter((l) => l.to === 'ITA').length;
    }
    for (const f of Object.keys(s.factions)) for (const d of (await engine.store.getOrders(r.campaign.id, t, f))?.diplomacy ?? []) diploByKind[d.kind] = (diploByKind[d.kind] ?? 0) + 1;
    agreementsSigned += events.filter((e) => e.type === 'AGREEMENT_CHANGED' && (e.payload as { agreement: { status: string } }).agreement.status === 'active').length;
    for (const e of events.filter((e) => e.type === 'INSTITUTION_VOTE')) { votes.total++; if ((e.payload as { passed: boolean }).passed) votes.passed++; }
    ultimatums.issued += events.filter((e) => e.type === 'DIPLOMACY_CHANGED' && (e.payload as { change: { op: string } }).change.op === 'ultimatum_add').length;
    ultimatums.expired += events.filter((e) => e.type === 'ULTIMATUM_EXPIRED').length; ultimatums.met += events.filter((e) => e.type === 'ULTIMATUM_MET').length;
    Object.assign(perTurn[t - 1]!, {
      unitOrdersPerFaction: +(units / Math.max(1, agents.length)).toFixed(2),
      engagements: events.filter((e) => e.type === 'ENGAGEMENT_OPENED').length,
      initiatives: ds.reduce((n, d) => n + d.letters.filter((l) => l.kind === 'initiative').length, 0),
    });
  }
  const timings = await engine.store.getTimings(r.campaign.id);
  for (let t = 1; t <= turns; t++) world.msAiAdjudication.push(timings.filter((x) => x.turn === t && (x.phase === 'AI_DECISIONS' || x.phase === 'ADJUDICATION')).reduce((n, x) => n + x.ms, 0));
  world.tradeActive = Object.values((await engine.store.getState(r.campaign.id)).agreements).filter((a) => a.type === 'trade' && a.status === 'active').length;
  world.rejected = worldRejected; world.eventsPerTurn = Math.round(totalEvents / Math.max(1, turns));
  return { seed, mode, final, firstMax, migration, turns: perTurn, llmByRole: mock.byRole, opinionMean, worldTension, capitalMean, capitalAtCap, capitalAtZero, diploByKind, agreementsSigned, votes, ultimatums, world };
}

const capitalByTurn = (rows: number[][]) => Array.from({ length: Math.max(0, ...rows.map((r) => r.length)) }, (_, i) => +(rows.map((r) => r[i]).filter((x): x is number => x !== undefined).reduce((a, b, _j, l) => a + b / l.length, 0)).toFixed(1));
const sumKinds = (runs: BalanceRun[]) => runs.reduce<Record<string, number>>((a, r) => { for (const [k, n] of Object.entries(r.diploByKind)) a[k] = (a[k] ?? 0) + n; return a; }, {});

export function summarize(runs: BalanceRun[]) {
  const ids = Object.keys(runs[0]?.final ?? {}).sort();
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null);
  const perCrisis = Object.fromEntries(ids.map((id) => {
    const fin = runs.map((r) => r.final[id]!);
    const first = runs.map((r) => r.firstMax[id]).filter((x): x is number => x !== null);
    return [id, { mean: avg(fin), min: Math.min(...fin), max: Math.max(...fin), at10: first.length, firstTen: avg(first) }];
  }));
  const at10 = runs.map((r) => Object.values(r.firstMax).filter((x) => x !== null).length);
  const finalAt10 = runs.map((r) => Object.values(r.final).filter((x) => x >= 10).length);
  const allFirst = runs.flatMap((r) => Object.values(r.firstMax).filter((x): x is number => x !== null));
  const turns = runs.flatMap((r) => r.turns);
  const roles = [...new Set(runs.flatMap((r) => Object.keys(r.llmByRole)))].sort();
  return {
    perCrisis, crisesEverAt10PerRun: avg(at10), crisesAt10AtEndPerRun: avg(finalAt10), runsWithMoreThan2AtEnd: finalAt10.filter((n) => n > 2).length,
    firstTenMeanTurn: avg(allFirst), migrationMean: avg(runs.flatMap((r) => r.migration)), migrationFinalMean: avg(runs.map((r) => r.migration.at(-1)!)),
    turnsAtMigration100: runs.reduce((a, r) => a + r.migration.filter((m) => m >= 100).length, 0),
    // obiettivi della modalità rules: ≥ 1 ordine con unità per fazione IA per turno, ingaggi > 0, ≥ 1 lettera di iniziativa per turno
    unitOrdersPerFactionPerTurn: avg(turns.map((t) => t.unitOrdersPerFaction)), turnsBelowOneUnitOrder: turns.filter((t) => t.unitOrdersPerFaction < 1).length,
    engagementsPerRun: avg(runs.map((r) => r.turns.reduce((a, t) => a + t.engagements, 0))), runsWithoutEngagements: runs.filter((r) => !r.turns.some((t) => t.engagements)).length,
    initiativesPerTurn: avg(turns.map((t) => t.initiatives)), turnsWithoutInitiative: turns.filter((t) => !t.initiatives).length,
    llmCallsPerTurn: avg(turns.map((t) => t.llmCalls)), msPerTurn: avg(turns.map((t) => t.ms)),
    llmCallsPerTurnByRole: Object.fromEntries(roles.map((x) => [x, +(runs.reduce((a, r) => a + (r.llmByRole[x] ?? 0), 0) / Math.max(1, turns.length)).toFixed(1)])),
    turnsTotal: turns.length,
    // diplomazia (settore 08): deriva della fiducia media tra fazioni dal turno 0 al finale (obiettivo ≤ ±10) e tensione mondiale (non resta a 100)
    opinionDriftMean: avg(runs.map((r) => r.opinionMean.at(-1)! - r.opinionMean[0]!)),
    opinionDriftMaxAbs: runs.length ? +Math.max(...runs.map((r) => Math.abs(r.opinionMean.at(-1)! - r.opinionMean[0]!))).toFixed(1) : null,
    opinionMeanStart: avg(runs.map((r) => r.opinionMean[0]!)),
    worldTensionMean: avg(runs.flatMap((r) => r.worldTension).filter((x) => !Number.isNaN(x))), worldTensionMax: Math.max(...runs.flatMap((r) => r.worldTension).filter((x) => !Number.isNaN(x)), -Infinity),
    worldTensionFinalMean: avg(runs.map((r) => r.worldTension.at(-1)!).filter((x) => !Number.isNaN(x))), turnsAtWorldTension100: runs.reduce((a, r) => a + r.worldTension.filter((x) => x >= 100).length, 0),
    // capitale diplomatico (settore 09): non deve restare sempre al tetto né a zero
    capitalMeanByTurn: capitalByTurn(runs.map((r) => r.capitalMean)), capitalAtCapShare: avg(runs.flatMap((r) => r.capitalAtCap.slice(1)).map((x) => x * 100)), capitalAtZeroShare: avg(runs.flatMap((r) => r.capitalAtZero.slice(1)).map((x) => x * 100)),
    diploPerTurnByKind: Object.fromEntries(Object.entries(sumKinds(runs)).sort(([, a], [, b]) => b - a).map(([k, n]) => [k, +(n / Math.max(1, turns.length)).toFixed(2)])),
    agreementsSignedPerRun: avg(runs.map((r) => r.agreementsSigned)), votesPerRun: avg(runs.map((r) => r.votes.total)), votesPassedPerRun: avg(runs.map((r) => r.votes.passed)),
    worldActionsPerTurnByKind: Object.fromEntries(Object.entries(runs.reduce<Record<string, number>>((a, r) => { for (const [k, n] of Object.entries(r.world.actionsByKind)) a[k] = (a[k] ?? 0) + n; return a; }, {})).sort(([, a], [, b]) => b - a).map(([k, n]) => [k, +(n / Math.max(1, turns.length)).toFixed(2)])),
    worldReactionsPerGraveEvent: (() => { const e = runs.reduce((n, r) => n + r.world.reactionEvents, 0); const f = (k: 'condemn' | 'support' | 'silent') => (e ? +(runs.reduce((n, r) => n + r.world[k], 0) / e).toFixed(1) : 0); return { events: e, condemn: f('condemn'), support: f('support'), silent: f('silent') }; })(),
    worldTradeAgreementsAtEnd: avg(runs.map((r) => r.world.tradeActive)), worldBlockAdoptersPerRun: avg(runs.map((r) => r.world.blockAdopters)),
    worldLettersToItalyPerRun: avg(runs.map((r) => r.world.lettersToPlayer)), worldRejectedPerRun: avg(runs.map((r) => r.world.rejected)),
    eventsPerTurn: avg(runs.map((r) => r.world.eventsPerTurn)), msAiAdjudicationMean: avg(runs.flatMap((r) => r.world.msAiAdjudication)), msAiAdjudicationMax: Math.max(0, ...runs.flatMap((r) => r.world.msAiAdjudication)),
    ultimatumsPerRun: avg(runs.map((r) => r.ultimatums.issued)), ultimatumsExpiredPerRun: avg(runs.map((r) => r.ultimatums.expired)), ultimatumsMetPerRun: avg(runs.map((r) => r.ultimatums.met)),
  };
}

async function main() {
  const { values: a } = parseArgs({ options: { seeds: { type: 'string', default: '10' }, turns: { type: 'string', default: '20' }, json: { type: 'string' }, prefix: { type: 'string', default: 'bal' }, mode: { type: 'string', default: 'rules' } } });
  const mode: FactionMode = a.mode === 'llm' ? 'llm' : 'rules';
  const dir = mkdtempSync(path.join(tmpdir(), 'wg-balance-'));
  const runs: BalanceRun[] = [];
  try {
    for (let i = 1; i <= Number(a.seeds); i++) {
      const r = await balanceRun(`${a.prefix}-${i}`, Number(a.turns), dir, mode);
      runs.push(r);
      console.log(`seed ${r.seed}: finale ${Object.entries(r.final).map(([k, v]) => `${k} ${v}`).join(', ')} · primo 10/10 ${JSON.stringify(Object.fromEntries(Object.entries(r.firstMax).filter(([, v]) => v !== null)))} · migrazione finale ${r.migration.at(-1)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const s = summarize(runs);
  console.log(`\n${runs.length} seed × ${a.turns} turni (fazioni: ${mode === 'rules' ? 'regole del motore' : 'IA mock'}, giocatore moderato)`);
  console.log('crisi           media  min  max  seed con 10/10  turno medio 1° 10/10');
  for (const [id, x] of Object.entries(s.perCrisis)) console.log(`${id.padEnd(14)} ${String(x.mean).padStart(5)} ${String(x.min).padStart(4)} ${String(x.max).padStart(4)} ${String(x.at10).padStart(15)} ${String(x.firstTen ?? '—').padStart(21)}`);
  console.log(`crisi arrivate a 10/10 per partita: ${s.crisesEverAt10PerRun} · a 10/10 alla fine: ${s.crisesAt10AtEndPerRun} (partite con più di 2: ${s.runsWithMoreThan2AtEnd})`);
  console.log(`turno medio del primo 10/10: ${s.firstTenMeanTurn ?? '—'} · pressione migratoria media ${s.migrationMean} (finale ${s.migrationFinalMean}, turni a 100: ${s.turnsAtMigration100})`);
  console.log(`ordini IA con unità per fazione per turno: ${s.unitOrdersPerFactionPerTurn} (turni sotto 1: ${s.turnsBelowOneUnitOrder}/${s.turnsTotal}) · ingaggi per partita: ${s.engagementsPerRun} (partite senza: ${s.runsWithoutEngagements})`);
  console.log(`lettere IA di iniziativa per turno: ${s.initiativesPerTurn} (turni senza: ${s.turnsWithoutInitiative}/${s.turnsTotal}) · chiamate LLM per turno: ${s.llmCallsPerTurn} ${JSON.stringify(s.llmCallsPerTurnByRole)} · ${s.msPerTurn} ms per turno (mock)`);
  console.log(`fiducia media tra fazioni: ${s.opinionMeanStart} all'inizio, deriva media a fine partita ${s.opinionDriftMean} (massima in valore assoluto ${s.opinionDriftMaxAbs}; obiettivo ≤ ±10) · tensione mondiale: media ${s.worldTensionMean ?? 'n/d'}, massima ${Number.isFinite(s.worldTensionMax) ? s.worldTensionMax : 'n/d'}, finale ${s.worldTensionFinalMean ?? 'n/d'}, turni a 100: ${s.turnsAtWorldTension100}`);
  console.log(`capitale diplomatico medio per fazione, per turno (dal turno 0): ${s.capitalMeanByTurn.join(' ')} · fazioni al tetto ${s.capitalAtCapShare}% e a zero ${s.capitalAtZeroShare}% dei turni`);
  console.log(`azioni diplomatiche per turno (tutte le fazioni): ${Object.entries(s.diploPerTurnByKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`per partita: accordi firmati ${s.agreementsSignedPerRun} · votazioni ${s.votesPerRun} (approvate ${s.votesPassedPerRun}) · ultimatum ${s.ultimatumsPerRun} (scaduti ${s.ultimatumsExpiredPerRun}, soddisfatti ${s.ultimatumsMetPerRun})`);
  console.log(`IA mondiale: azioni del livello C per turno ${Object.entries(s.worldActionsPerTurnByKind).map(([k, n]) => `${k} ${n}`).join(', ') || '—'} (rifiutate per partita: ${s.worldRejectedPerRun})`);
  console.log(`  reazioni: ${s.worldReactionsPerGraveEvent.events} eventi gravi in totale, per evento condannano ${s.worldReactionsPerGraveEvent.condemn}, sostengono ${s.worldReactionsPerGraveEvent.support}, tacciono ${s.worldReactionsPerGraveEvent.silent} Stati · accordi commerciali in vigore a fine partita ${s.worldTradeAgreementsAtEnd} · adeguamenti a sanzioni di blocco per partita ${s.worldBlockAdoptersPerRun} · lettere di uno Stato del mondo all'Italia per partita ${s.worldLettersToItalyPerRun}`);
  console.log(`  eventi per turno ${s.eventsPerTurn} · AI_DECISIONS + ADJUDICATION: ${s.msAiAdjudicationMean} ms in media, massimo ${s.msAiAdjudicationMax} ms (obiettivo ≤ 3000)`);
  if (a.json) writeFileSync(a.json, JSON.stringify({ runs, summary: s }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
