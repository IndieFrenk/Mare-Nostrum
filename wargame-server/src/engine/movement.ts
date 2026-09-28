import type { LatLon, Unit, ZoneId } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { distanceKm, lerp, nearestZone } from './geo.js';
import { PARAMS } from './params.js';

const naval = (u: Unit) => u.domain === 'sea' || u.domain === 'subsurface';

export function destination(ctx: TurnCtx, to: ZoneId | LatLon, u?: Unit): { loc: LatLon; zoneId: string } {
  if (typeof to === 'string') return { loc: ctx.state.zones[to].center, zoneId: to };
  return { loc: to, zoneId: nearestZone(ctx.state, to, u && naval(u) ? 'sea' : undefined) };
}

/** Muove l'unità verso `to`; navi limitate dalla velocità, aerei/SOF si rischierano entro il turno. */
export function moveUnit(ctx: TurnCtx, u: Unit, to: ZoneId | LatLon, speed: keyof typeof PARAMS.speedKts, orderId: string, arrivedStatus: Unit['status'] = 'deployed') {
  const dest = destination(ctx, to, u);
  const dist = distanceKm(u.location, dest.loc);
  const reach = naval(u) ? PARAMS.speedKts[speed] * 1.852 * PARAMS.hoursPerTurn[ctx.campaign.turnLength] * 0.6 : Infinity;
  const arrived = dist <= reach;
  const loc = arrived ? dest.loc : lerp(u.location, dest.loc, reach / dist);
  const zoneId = arrived ? dest.zoneId : nearestZone(ctx.state, loc, naval(u) ? 'sea' : undefined);
  ctx.emit('UNIT_MOVED', u.factionId, { unitId: u.id, location: loc, zoneId, status: arrived ? arrivedStatus : 'transit', distanceKm: Math.round(Math.min(dist, reach)) }, { visibility: [u.factionId], causedBy: { orderId } });
  return arrived;
}

export function returnToBase(ctx: TurnCtx, u: Unit, status: Unit['status'], orderId: string) {
  const b = ctx.state.bases[u.homeBaseId];
  ctx.emit('UNIT_MOVED', u.factionId, { unitId: u.id, location: b.location, zoneId: b.zoneId, status }, { visibility: [u.factionId], causedBy: { orderId } });
  ctx.emit('UNIT_STATUS', u.factionId, { unitId: u.id, patch: { currentTask: null } }, { visibility: [u.factionId] });
}
