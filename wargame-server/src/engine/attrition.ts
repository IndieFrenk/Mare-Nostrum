import type { TurnCtx } from './context.js';
import { PARAMS } from './params.js';

/** OPEN: usura delle unità schierate, recupero di quelle a terra, riparazioni. */
export function applyAttrition(ctx: TurnCtx) {
  const P = PARAMS;
  for (const u of Object.values(ctx.state.units)) {
    if (u.status === 'destroyed') continue;
    const vis = { visibility: [u.factionId] };
    if (u.status === 'deployed' || u.status === 'transit') {
      const usageHours = u.usageHours + P.usage.deployedHours;
      const readiness = Math.max(P.readiness.min, u.readiness - P.readiness.decayDeployed);
      ctx.emit('UNIT_STATUS', u.factionId, { unitId: u.id, patch: { usageHours, readiness } }, vis);
      if (usageHours > P.usage.wearThreshold && ctx.rng.chance(`avaria per usura ${u.id}`, P.usage.breakdownChance).ok) {
        ctx.emit('UNIT_STATUS', u.factionId, { unitId: u.id, patch: { readiness: Math.max(P.readiness.min, readiness - 20), status: 'damaged', damage: Math.max(u.damage, 15) } }, vis);
      }
    } else if (u.status === 'maintenance') {
      const damage = Math.max(0, u.damage - P.repair.damagePerTurn);
      const cost = (u.damage - damage) * P.repair.costPerPoint * (u.domain === 'sea' || u.domain === 'subsurface' ? 1 : 0.3);
      if (cost > 0) ctx.spend(u.factionId, -cost, 'repair', u.id, `Riparazione ${u.name}`);
      ctx.emit('UNIT_STATUS', u.factionId, { unitId: u.id, patch: { damage, readiness: Math.min(100, u.readiness + P.readiness.recoverRepair), usageHours: Math.max(0, u.usageHours - 400), status: damage === 0 ? 'ready' : 'maintenance' } }, vis);
    } else if (u.status === 'ready' && u.readiness < 100) {
      ctx.emit('UNIT_STATUS', u.factionId, { unitId: u.id, patch: { readiness: Math.min(100, u.readiness + P.readiness.recoverAtBase) } }, vis);
    }
  }
}
