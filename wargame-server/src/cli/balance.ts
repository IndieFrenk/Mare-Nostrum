// Statistica di bilanciamento delle crisi su più seed, senza rete: IA mock e un giocatore «moderato» come quello del playtest
// (due pattuglie, una mossa diplomatica a rotazione DEMARCHE/REASSURANCE/BACKCHANNEL, una lettera ogni 2 turni, niente strike).
// Uso: npm --prefix wargame-server run balance -- --seeds 10 --turns 20 [--json out.json]
// Riporta: escalation finale per crisi (distribuzione), quante crisi a 10/10, turno medio del primo 10/10, pressione migratoria media.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MockLLMProvider } from '../agents/mock-provider.js';
import { LlmAgents } from '../agents/orchestrator.js';
import { Engine } from '../engine/turn-machine.js';
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

export interface BalanceRun { seed: string; final: Record<string, number>; firstMax: Record<string, number | null>; migration: number[] }

export async function balanceRun(seed: string, turns: number, dir: string): Promise<BalanceRun> {
  const engine = new Engine(new JsonStore(dir), new LlmAgents(new MockLLMProvider()));
  const c = await engine.createCampaign({ scenarioId: 'med-2026', name: `balance ${seed}`, seed });
  const r = await runSim(engine, c, turns, (t) => moderatePlayer(engine, c.id, t));
  const firstMax: Record<string, number | null> = {}; const migration: number[] = [];
  let final: Record<string, number> = {};
  for (let t = 1; t <= turns; t++) {
    const s = await engine.store.getState(r.campaign.id, t);
    migration.push(s.globalIndicators.migrationPressure);
    for (const cr of Object.values(s.crises)) { if (!(cr.id in firstMax)) firstMax[cr.id] = null; if (cr.escalation >= 10 && firstMax[cr.id] === null) firstMax[cr.id] = t; }
    final = Object.fromEntries(Object.values(s.crises).map((cr) => [cr.id, cr.escalation]));
  }
  return { seed, final, firstMax, migration };
}

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
  return {
    perCrisis, crisesEverAt10PerRun: avg(at10), crisesAt10AtEndPerRun: avg(finalAt10), runsWithMoreThan2AtEnd: finalAt10.filter((n) => n > 2).length,
    firstTenMeanTurn: avg(allFirst), migrationMean: avg(runs.flatMap((r) => r.migration)), migrationFinalMean: avg(runs.map((r) => r.migration.at(-1)!)),
    turnsAtMigration100: runs.reduce((a, r) => a + r.migration.filter((m) => m >= 100).length, 0),
  };
}

async function main() {
  const { values: a } = parseArgs({ options: { seeds: { type: 'string', default: '10' }, turns: { type: 'string', default: '20' }, json: { type: 'string' }, prefix: { type: 'string', default: 'bal' } } });
  const dir = mkdtempSync(path.join(tmpdir(), 'wg-balance-'));
  const runs: BalanceRun[] = [];
  try {
    for (let i = 1; i <= Number(a.seeds); i++) {
      const r = await balanceRun(`${a.prefix}-${i}`, Number(a.turns), dir);
      runs.push(r);
      console.log(`seed ${r.seed}: finale ${Object.entries(r.final).map(([k, v]) => `${k} ${v}`).join(', ')} · primo 10/10 ${JSON.stringify(Object.fromEntries(Object.entries(r.firstMax).filter(([, v]) => v !== null)))} · migrazione finale ${r.migration.at(-1)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const s = summarize(runs);
  console.log(`\n${runs.length} seed × ${a.turns} turni (IA mock, giocatore moderato)`);
  console.log('crisi           media  min  max  seed con 10/10  turno medio 1° 10/10');
  for (const [id, x] of Object.entries(s.perCrisis)) console.log(`${id.padEnd(14)} ${String(x.mean).padStart(5)} ${String(x.min).padStart(4)} ${String(x.max).padStart(4)} ${String(x.at10).padStart(15)} ${String(x.firstTen ?? '—').padStart(21)}`);
  console.log(`crisi arrivate a 10/10 per partita: ${s.crisesEverAt10PerRun} · a 10/10 alla fine: ${s.crisesAt10AtEndPerRun} (partite con più di 2: ${s.runsWithMoreThan2AtEnd})`);
  console.log(`turno medio del primo 10/10: ${s.firstTenMeanTurn ?? '—'} · pressione migratoria media ${s.migrationMean} (finale ${s.migrationFinalMean}, turni a 100: ${s.turnsAtMigration100})`);
  if (a.json) writeFileSync(a.json, JSON.stringify({ runs, summary: s }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
