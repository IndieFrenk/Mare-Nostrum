import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as S from '../src/schemas/index.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { JsonStore, LockError } from '../src/store/json-store.js';
import { makeEngine, tmp } from './helpers.js';
import { runSim } from '../src/cli/sim.js';

describe('schemi', () => {
  it('round-trip di tutti gli artefatti di una campagna', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 't', seed: 's1' });
    await runSim(e, c, 2);
    const st = e.store;
    const pairs: [z.ZodType, unknown][] = [
      [S.Campaign, await st.getCampaign(c.id)], [S.WorldState, await st.getState(c.id)], [S.WorldState, await st.getState(c.id, 1)],
      [S.FactionKnowledge, await st.getKnowledge(c.id, 'ITA', 2)], [S.AgentDecision, await st.getDecision(c.id, 1, 'TUR')],
      [S.AgentMemory, await st.getMemory(c.id, 'RUS')], [S.TurnNarrative, await st.getNarrative(c.id, 1)], [S.FactionOrders, await st.getOrders(c.id, 1, 'USA')],
      ...(await st.getEvents(c.id, 1)).slice(0, 50).map((x) => [S.GameEvent, x] as [z.ZodType, unknown]),
      ...(await st.getRolls(c.id, 1)).slice(0, 50).map((x) => [S.DiceRoll, x] as [z.ZodType, unknown]),
      ...(await st.getLedger(c.id)).map((x) => [S.LedgerEntry, x] as [z.ZodType, unknown]),
    ];
    for (const [schema, v] of pairs) {
      expect(v).toBeTruthy();
      expect(schema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
    }
  });

  it('esporta JSON Schema per ogni schema', () => {
    for (const k of ['Campaign', 'WorldState', 'FactionOrders', 'FactionKnowledge', 'AgentDecision', 'AgentMemory', 'GameEvent', 'DiceRoll', 'TurnNarrative', 'LlmCall'] as const) {
      expect(z.toJSONSchema(S[k] as z.ZodType, { io: 'input', unrepresentable: 'any' })).toHaveProperty('type');
    }
  });
});

describe('RNG', () => {
  it('stessa sequenza a parità di seed e ripresa dal cursore', () => {
    const a = new Rng('seed'); const b = new Rng('seed');
    const xs = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(xs);
    const c = new Rng('seed', 10);
    expect(c.next()).toBe(xs[10]);
    expect(new Rng('altro').next()).not.toBe(xs[0]);
  });
  it('tiri registrati con formula e esito', () => {
    const r = new Rng('x');
    const roll = r.roll('prova', '2d6+1', { threshold: 8 });
    expect(roll.raw).toHaveLength(2);
    expect(roll.total).toBe(roll.raw[0] + roll.raw[1] + 1);
    expect(r.rolls).toHaveLength(1);
  });
});

describe('store', () => {
  it('blocca scritture concorrenti con il lock', async () => {
    const s = new JsonStore(tmp());
    let release!: () => void;
    const first = s.withLock('c1', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
    await expect(s.withLock('c1', async () => 1)).rejects.toBeInstanceOf(LockError);
    release(); await first;
    await expect(s.withLock('c1', async () => 2)).resolves.toBe(2);
  });

  it('il lock resta valido per tutto il turno e si libera solo se il processo che lo tiene è morto', async () => {
    const dir = tmp();
    const s = new JsonStore(dir);
    let release!: () => void;
    const first = s.withLock('c2', () => new Promise<void>((r) => (release = r)), 'turno');
    // il lock si scrive in modo asincrono: si aspetta che esista (sotto carico 10 ms fissi non bastano)
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await s.lockInfo('c2')).toMatchObject({ op: 'turno', pid: process.pid });
    const err = await s.withLock('c2', async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(LockError);
    expect(err.message).toMatch(/turno è in corso/);
    release(); await first;
    expect(await s.lockInfo('c2')).toBeNull();
    // lock di un altro processo vivo (il padre), iniziato 10 minuti fa ma rinnovato adesso: resta valido
    const lockPath = path.join(dir, 'c3', '.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid, op: 'turno', since: Date.now() - 600_000, at: Date.now() }));
    await expect(s.withLock('c3', async () => 3)).rejects.toBeInstanceOf(LockError);
    expect(await s.lockInfo('c3')).toMatchObject({ op: 'turno', pid: process.ppid });
    // lock di un processo morto (es. server riavviato a metà turno): si riprende
    await fs.writeFile(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, op: 'turno', since: Date.now(), at: Date.now() }));
    expect(await s.lockInfo('c3')).toBeNull();
    await expect(s.withLock('c3', async () => 4)).resolves.toBe(4);
  });

  it('fork copia solo fino al turno richiesto', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 't', seed: 'fork' });
    await runSim(e, c, 3);
    const f = await e.fork(c.id, 2);
    expect(f.parent).toEqual({ campaignId: c.id, turn: 2 });
    expect(f.phase).toBe('CLOSED');
    expect(await e.store.getState(f.id)).toEqual(await e.store.getState(c.id, 2));
    expect(await e.store.getEvents(f.id, 3)).toEqual([]);
    expect(await e.store.getDecision(f.id, 3, 'TUR')).toBeNull();
    expect((await e.store.getLedger(f.id)).every((l) => l.turn <= 2)).toBe(true);
    expect((await e.store.getMemory(f.id, 'TUR'))!.updatedTurn).toBe(2);
    const next = await e.advance(f.id);
    expect(next.currentTurn).toBe(3);
    expect(next.phase).toBe('PLAYER_ORDERS');
  });

  it('lo scenario med-2026 si carica e valida', () => {
    const sc = loadScenario('med-2026');
    expect(sc.world.factions.ITA.budget.discretionary).toBe(3200);
    expect(Object.values(sc.world.units).filter((u) => u.factionId === 'ITA' && u.classId === 'FREMM_BERGAMINI')).toHaveLength(8);
    expect(Object.values(sc.world.units).filter((u) => u.factionId !== 'ITA').every((u) => u.estimated)).toBe(true);
  });
});
