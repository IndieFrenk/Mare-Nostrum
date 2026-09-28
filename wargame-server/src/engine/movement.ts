import type { LatLon, Unit, WorldState, ZoneId } from '../schemas/index.js';
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

/** Zona in cui si svolge il compito di un'unità (null se il compito non ha una zona: rientro, ISR, strike…). */
export function taskZone(s: Pick<WorldState, 'zones' | 'units' | 'infrastructure'>, task: Unit['currentTask']): string | null {
  const t = task as { kind?: string; zoneId?: string; to?: unknown; protect?: string } | null;
  if (!t) return null;
  if (typeof t.zoneId === 'string' && s.zones[t.zoneId]) return t.zoneId;
  if (t.kind === 'MOVE' && typeof t.to === 'string' && s.zones[t.to]) return t.to;
  if (t.kind === 'ESCORT' && typeof t.protect === 'string') {
    const convoy = /^convoglio\s+(\S+)/i.exec(t.protect)?.[1];
    return s.units[t.protect]?.zoneId ?? s.infrastructure[t.protect]?.zoneId ?? (convoy && s.zones[convoy] ? convoy : null);
  }
  return null;
}

/**
 * OPEN: le unità rimaste in transito proseguono verso la zona del loro compito (stessa velocità di crociera degli ordini di zona).
 * Prima di questa fase un'unità che non arrivava in un turno restava a metà strada per sempre, finché qualcuno non la riordinava.
 */
export function continueTransit(ctx: TurnCtx) {
  for (const u of Object.values(ctx.state.units).sort((a, b) => a.id.localeCompare(b.id))) {
    if (u.status !== 'transit') continue;
    const z = taskZone(ctx.state, u.currentTask);
    if (z) moveUnit(ctx, u, z, 'cruise', String((u.currentTask as { id?: string }).id ?? 'transito'));
  }
}
