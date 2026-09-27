import type { TurnCtx } from './context.js';
import { evaluate } from './conditions.js';
import { PARAMS } from './params.js';

/** OPEN: deriva delle crisi con 2d6 ed eventi casuali pesati per zona/tensione. */
export function evolveCrises(ctx: TurnCtx) {
  for (const c of Object.values(ctx.state.crises)) {
    if (c.status === 'resolved' || c.status === 'frozen') continue;
    const r = ctx.rng.roll(`deriva crisi ${c.id}`, '2d6');
    if (r.total >= PARAMS.crisisDriftUp) ctx.escalate(c.id, 1, 'deriva: deterioramento spontaneo');
    else if (r.total <= PARAMS.crisisDriftDown) ctx.escalate(c.id, -1, 'deriva: raffreddamento');
  }
  const table = ctx.scenario.events;
  const touched = new Set<string>();
  const escalateOnce = (id: string, delta: number, cause: string) => { if (!touched.has(id)) { touched.add(id); ctx.escalate(id, delta, cause); } };
  for (const z of Object.values(ctx.state.zones)) {
    const rows = table.filter((e) => e.zones.includes(z.id) && e.minTension <= z.tension);
    if (!rows.length || !ctx.rng.chance(`evento casuale in ${z.id}`, PARAMS.randomEventChance * (0.5 + z.tension / 100)).ok) continue;
    const total = rows.reduce((a, e) => a + e.weight, 0);
    let x = ctx.rng.next() * total;
    const ev = rows.find((e) => (x -= e.weight) < 0) ?? rows[0];
    ctx.emit('RANDOM_EVENT', 'world', { eventId: ev.id, text: ev.text, zoneId: z.id }, { targets: [z.id] });
    if (ev.crisis) escalateOnce(ev.crisis[0], ev.crisis[1], ev.text);
    if (ev.crisisAny) for (const c of Object.values(ctx.state.crises).filter((c) => c.zoneIds.includes(z.id))) escalateOnce(c.id, ev.crisisAny, ev.text);
    if (ev.infra && ctx.state.infrastructure[ev.infra[0]]?.status === 'operational') ctx.emit('INFRA_STATUS', 'world', { infraId: ev.infra[0], status: ev.infra[1], cause: ev.text }, { targets: [ev.infra[0]] });
    if (ev.indicators) ctx.emit('INDICATORS_CHANGED', 'world', { delta: ev.indicators });
  }
}

/** Infrastrutture degradate tornano operative con il tempo (riparazioni civili). */
export function recoverInfrastructure(ctx: TurnCtx) {
  for (const i of Object.values(ctx.state.infrastructure)) {
    if (i.status === 'operational') continue;
    if (ctx.rng.chance(`ripristino ${i.id}`, i.status === 'degraded' ? 0.4 : 0.15).ok) ctx.emit('INFRA_STATUS', 'world', { infraId: i.id, status: i.status === 'offline' ? 'degraded' : 'operational', cause: 'riparazioni' }, { targets: [i.id] });
  }
}

export function checkRedLines(ctx: TurnCtx) {
  for (const f of Object.values(ctx.state.factions)) {
    for (const rl of f.redLines) {
      if (f.crossedRedLines.includes(rl.id) || !evaluate(ctx.state, rl.trigger)) continue;
      ctx.emit('RED_LINE_CROSSED', f.id, { redLineId: rl.id, text: rl.text, response: rl.response }, { visibility: [f.id] });
      ctx.emit('FACTION_CHANGED', f.id, { factionId: f.id, delta: { posture: -1 }, patch: { crossedRedLines: [...f.crossedRedLines, rl.id] } }, { visibility: [f.id] });
    }
  }
}
