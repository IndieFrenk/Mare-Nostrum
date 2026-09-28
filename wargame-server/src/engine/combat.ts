import type { Engagement, Unit } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { buildCmoPackage } from './cmo.js';
import { PARAMS } from './params.js';

const MAJOR_SHIPS = new Set<Unit['type']>(['carrier', 'lhd', 'destroyer', 'frigate', 'submarine']);
const OFFENSIVE = new Set(['asm', 'aa', 'torp', 'land']);

export function isMajor(ctx: TurnCtx, sides: Engagement['sides'], missiles = 0) {
  const t = ctx.campaign.config.cmoThreshold;
  if (missiles >= t.missileSalvo) return true;
  return sides.some((sd) => {
    const us = sd.unitIds.map((id) => ctx.state.units[id]);
    return us.filter((u) => MAJOR_SHIPS.has(u.type)).length >= t.majorShips || us.filter((u) => u.domain === 'air').reduce((a, u) => a + u.count, 0) >= t.aircraftPerSide;
  });
}

export function openEngagement(ctx: TurnCtx, zoneId: string, sides: Engagement['sides'], opts: { missiles?: number; orderId?: string; objective?: string } = {}): Engagement {
  const major = isMajor(ctx, sides, opts.missiles);
  const withPlayer = sides.some((s) => s.factionId === ctx.campaign.playerFaction);
  const cmo = withPlayer && (major || ctx.campaign.config.cmoOnRequest);
  const eng: Engagement = {
    id: `ENG-${ctx.turn}-${Object.keys(ctx.state.engagements).length + 1}`, turn: ctx.turn, zoneId, location: ctx.state.zones[zoneId].center,
    sides, scale: major ? 'major' : 'minor', resolution: cmo ? 'cmo' : 'auto', status: cmo ? 'pending_cmo' : 'resolved',
  };
  if (eng.resolution === 'cmo') eng.cmoPackage = buildCmoPackage(ctx, eng, opts.objective);
  ctx.emit('ENGAGEMENT_OPENED', sides[0].factionId, { engagement: eng }, { targets: sides.map((s) => s.factionId), causedBy: opts.orderId ? { orderId: opts.orderId } : null });
  for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) ctx.relate(sides[i].factionId, sides[j].factionId, -10, 15, `scontro in ${zoneId}`, { incident: true });
  for (const c of Object.values(ctx.state.crises).filter((c) => c.zoneIds.includes(zoneId))) ctx.escalate(c.id, major ? 2 : 1, `ingaggio ${eng.id}`, { byOrders: true });
  if (eng.resolution === 'auto') resolveSalvo(ctx, eng.id, 0);
  return ctx.state.engagements[eng.id];
}

/** Modello a salve semplificato: attacco (atk × prontezza) contro difesa di punto/area, tiri registrati. */
export function resolveSalvo(ctx: TurnCtx, engagementId: string, uncertainty: number) {
  const eng = ctx.state.engagements[engagementId];
  const rollIds: string[] = [];
  const lines: string[] = [];
  const power = (ids: string[], k: 'atk' | 'def') => ids.map((id) => ctx.state.units[id]).filter((u) => u.status !== 'destroyed')
    .reduce((a, u) => a + ctx.catalog.classes[u.classId][k] * (u.domain === 'air' ? Math.sqrt(u.count) : 1) * (u.readiness / 100), 0);
  for (const side of eng.sides) {
    const enemies = eng.sides.filter((s) => s !== side).flatMap((s) => s.unitIds).filter((id) => ctx.state.units[id].status !== 'destroyed');
    if (!enemies.length) continue;
    const atk = power(side.unitIds, 'atk');
    const def = power(enemies, 'def');
    const r = ctx.rng.roll(`salva ${side.factionId} in ${eng.id}`, '2d6', { modifiers: uncertainty ? [{ name: 'incertezza risoluzione automatica', value: Math.round((ctx.rng.next() - 0.5) * 6 * uncertainty) }] : [] });
    rollIds.push(r.id);
    const hits = Math.max(0, Math.round(atk * (r.total / 7) - def * 0.6));
    for (const id of side.unitIds) {
      const u = ctx.state.units[id];
      const mun = Object.entries(u.loadout).find(([m, q]) => q > 0 && OFFENSIVE.has(ctx.catalog.munitions[m]?.role));
      if (mun) ctx.emit('MUNITION_EXPENDED', u.factionId, { factionId: u.factionId, unitId: u.id, munitionId: mun[0], qty: Math.min(mun[1], 2 + Math.floor(hits / 2)) }, { visibility: [u.factionId] });
    }
    for (let h = 0; h < hits; h++) {
      const alive = enemies.filter((id) => ctx.state.units[id].status !== 'destroyed');
      if (!alive.length) break;
      const t = ctx.state.units[ctx.rng.pick(alive)];
      const air = t.domain === 'air' && t.count > 1;
      const damage = air ? t.damage : t.damage + 20 + ctx.rng.int(0, 20);
      ctx.emit('UNIT_DAMAGED', side.factionId, { unitId: t.id, damage, countLoss: air ? 1 : 0 }, { targets: [t.id], causedBy: { rollId: r.id } });
    }
    lines.push(`${side.factionId}: ${hits} colpi a segno`);
  }
  ctx.emit('ENGAGEMENT_RESOLVED', 'world', { engagementId, patch: { status: 'resolved', autoResult: { rollIds, summary: lines.join('; ') } } }, { targets: eng.sides.map((s) => s.factionId) });
}

/** ADJUDICATION: interazioni tra forze nella stessa zona. */
export function detectInteractions(ctx: TurnCtx) {
  const s = ctx.state;
  const deployed = Object.values(s.units).filter((u) => u.status === 'deployed' && u.domain !== 'land');
  const byZone = new Map<string, Map<string, Unit[]>>();
  for (const u of deployed) {
    const z = byZone.get(u.zoneId) ?? new Map<string, Unit[]>();
    z.set(u.factionId, [...(z.get(u.factionId) ?? []), u]);
    byZone.set(u.zoneId, z);
  }
  for (const [zoneId, fs] of [...byZone].sort(([a], [b]) => a.localeCompare(b))) {
    const ids = [...fs.keys()].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      const rel = s.relations[a]?.[b];
      if (!rel) continue;
      const roe = (f: string) => fs.get(f)!.map((u) => (u.currentTask as { roe?: string; kind?: string } | null));
      const free = [...roe(a), ...roe(b)].some((t) => t?.roe === 'WEAPONS_FREE');
      const coercive = rel.tension >= 30 && [...roe(a), ...roe(b)].some((t) => t?.kind === 'BLOCKADE' || t?.kind === 'EXCLUSION_ZONE' || t?.kind === 'SHOW_OF_FORCE');
      if (rel.tension >= PARAMS.engagement.tensionForHostile && (free || (coercive && ctx.rng.chance(`escalation a fuoco ${a}/${b} in ${zoneId}`, 0.3).ok))) {
        openEngagement(ctx, zoneId, [{ factionId: a, unitIds: fs.get(a)!.map((u) => u.id) }, { factionId: b, unitIds: fs.get(b)!.map((u) => u.id) }]);
      } else if (rel.tension >= 45 || coercive) {
        if (ctx.rng.chance(`incidente ravvicinato ${a}/${b} in ${zoneId}`, PARAMS.engagement.incidentChance + (coercive ? 0.2 : 0)).ok) {
          ctx.emit('RANDOM_EVENT', 'world', { eventId: 'CLOSE_ENCOUNTER', text: `Incontro ravvicinato pericoloso tra unità ${a} e ${b}`, zoneId }, { targets: [a, b] });
          ctx.relate(a, b, -3, 5, `incidente in ${zoneId}`, { incident: true, propagate: false });
        }
      }
    }
  }
}
