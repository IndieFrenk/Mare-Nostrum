import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { Engine } from '../engine/turn-machine.js';
import { budgetFor } from '../index.js';
import { LlmAgents } from '../agents/orchestrator.js';
import { MockLLMProvider } from '../agents/mock-provider.js';
import { OpenAiCompatProvider } from '../agents/llm-client.js';
import { ReplayAgents } from '../agents/replay.js';
import { JsonStore } from '../store/json-store.js';
import type { Campaign, LlmCall } from '../schemas/index.js';

/** Simulazione headless: `sim -- --turns 5 --mock [--mode rules|llm]` · `sim -- --replay <id>` · smoke LLM reale senza --mock. */
export async function runSim(engine: Engine, c: Campaign, turns: number, player?: (turn: number) => Promise<void>) {
  const t0 = Date.now();
  while (c.currentTurn <= turns) {
    await player?.(c.currentTurn);
    c = await engine.advance(c.id);
    while (c.phase === 'CMO_PENDING') {
      const st = await engine.store.getState(c.id);
      for (const e of Object.values(st.engagements).filter((e) => e.status === 'pending_cmo')) await engine.submitAar(c.id, e.id, { autoResolve: true });
      c = await engine.advance(c.id);
    }
  }
  return { campaign: c, ms: Date.now() - t0 };
}

async function main() {
  const { values } = parseArgs({ options: { turns: { type: 'string', default: '5' }, mock: { type: 'boolean', default: false }, replay: { type: 'string' }, seed: { type: 'string' }, scenario: { type: 'string', default: 'med-2026' }, mode: { type: 'string' } } });
  const store = new JsonStore(config.dataDir);
  if (values.replay) {
    const src = await store.getCampaign(values.replay);
    const engine = new Engine(store, new ReplayAgents(store, src.id));
    const c = await engine.createCampaign({ scenarioId: src.scenarioId, name: `Replay di ${src.name}`, seed: src.seed, turnLength: src.turnLength, config: src.config });
    const last = src.phase === 'CLOSED' ? src.currentTurn : src.currentTurn - 1;
    const r = await runSim(engine, c, last, async (turn) => {
      const o = await store.getOrders(src.id, turn, src.playerFaction);
      if (o) await store.saveOrders(c.id, { ...o, source: 'replay' });
    });
    const [a, b] = await Promise.all([store.getState(src.id, last), store.getState(r.campaign.id, last)]);
    const same = JSON.stringify(a) === JSON.stringify(b);
    console.log(`replay ${r.campaign.id} (fazioni: ${r.campaign.config.factionMode}): turni 1-${last}, stato ${same ? 'IDENTICO' : 'DIVERGENTE'}`);
    process.exit(same ? 0 : 1);
  }
  const provider = values.mock ? new MockLLMProvider() : new OpenAiCompatProvider();
  const engine = new Engine(store, new LlmAgents(provider, budgetFor(provider)));
  engine.onProgress = (_, m) => { if (m.agent) console.log(`  · ${m.agent}: ${m.status}`); };
  const mode = values.mode === 'llm' || values.mode === 'rules' ? values.mode : undefined;
  const c = await engine.createCampaign({ scenarioId: values.scenario!, name: `Sim ${new Date().toISOString()}`, seed: values.seed, ...(mode ? { config: { factionMode: mode } } : {}) });
  const r = await runSim(engine, c, Number(values.turns));
  const s = await store.getState(r.campaign.id);
  console.log(`campagna ${r.campaign.id} (fazioni: ${r.campaign.config.factionMode}): turno ${r.campaign.currentTurn} (${r.campaign.phase}), ${r.ms} ms, FOED ${s.factions.ITA.budget.discretionary} M€`);
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = store.dir(r.campaign.id, 'llm-log');
  const calls = (await Promise.all((await readdir(dir).catch(() => [])).map((f) => readFile(`${dir}/${f}`, 'utf8'))))
    .flatMap((t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as LlmCall));
  const byRole = new Map<string, LlmCall[]>();
  for (const c of calls) byRole.set(c.role, [...(byRole.get(c.role) ?? []), c]);
  console.log('ruolo            chiamate  ok%   token in/out     latenza media');
  for (const [role, cs] of byRole) {
    const sum = (f: (c: LlmCall) => number) => cs.reduce((a, c) => a + f(c), 0);
    console.log(`${role.padEnd(16)} ${String(cs.length).padStart(8)}  ${String(Math.round((100 * cs.filter((c) => c.ok).length) / cs.length)).padStart(3)}%  ${`${sum((c) => c.tokens.in)}/${sum((c) => c.tokens.out)}`.padStart(15)}  ${Math.round(sum((c) => c.latencyMs) / cs.length)} ms`);
  }
  for (const cr of Object.values(s.crises)) console.log(`  crisi ${cr.id}: ${cr.escalation}/10 ${cr.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
