import type { TurnCtx } from './context.js';
import { PARAMS } from './params.js';

/** OPEN: entrate per turno e quote operative delle unità schierate. */
export function chargeOperations(ctx: TurnCtx) {
  const mult = PARAMS.opCostMultiplier[ctx.campaign.turnLength];
  for (const f of Object.values(ctx.state.factions)) {
    if (f.kind === 'bloc') continue;
    if (f.budget.perTurnIncome) ctx.spend(f.id, f.budget.perTurnIncome, 'income', 'income', 'Rifinanziamento periodico');
    const units = Object.values(ctx.state.units).filter((u) => u.factionId === f.id && (u.status === 'deployed' || u.status === 'transit'));
    const cost = units.reduce((a, u) => a + u.opCostPerTurn * Math.max(1, u.domain === 'air' ? u.count / 6 : 1), 0) * mult;
    if (cost > 0) ctx.spend(f.id, -cost, 'operations', 'ops', `Quote operative (${units.length} unità schierate)`);
  }
}

/** DEBRIEF: effetti energetici sugli indicatori e penalità per chi dipende dalle infrastrutture. */
export function applyEnergy(ctx: TurnCtx) {
  const infra = Object.values(ctx.state.infrastructure);
  const lost = infra.reduce((a, i) => a + (i.flowShareIta ?? 0) * (i.status === 'offline' ? 1 : i.status === 'degraded' ? 0.4 : 0), 0);
  const chokes = infra.filter((i) => i.type === 'chokepoint' && i.status !== 'operational').length;
  const red = ctx.state.crises.RED_SEA?.escalation ?? 0;
  const g = ctx.state.globalIndicators;
  const target = {
    ttfEurMwh: Math.round(35 + lost * PARAMS.energy.ttfPerLostShare + red),
    medShippingRisk: Math.min(100, Math.round(20 + red * 6 + chokes * 15)),
    brentUsd: Math.round(72 + red * 1.5 + chokes * 6),
    migrationPressure: Math.min(100, Math.round(20 + (ctx.state.crises.SAHEL_MIG?.escalation ?? 0) * 8)),
  };
  const delta = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, Math.round((v - g[k as keyof typeof g]) / 2)]).filter(([, v]) => v !== 0));
  if (Object.keys(delta).length) ctx.emit('INDICATORS_CHANGED', 'world', { delta });
  if (lost > 0.01) {
    ctx.emit('FACTION_CHANGED', 'world', { factionId: 'ITA', delta: { stability: -Math.round(lost * PARAMS.energy.stabilityPerLostShare) } }, { visibility: ['ITA'] });
    ctx.spend('ITA', -Math.round(lost * PARAMS.energy.penaltyPerLostShare), 'penalty', 'energy', `Approvvigionamento energetico ridotto (${Math.round(lost * 100)}% dei flussi)`);
  }
}
