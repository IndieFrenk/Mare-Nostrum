import type { FactionOrders, Order } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { detectInteractions, openEngagement } from './combat.js';
import { checkRedLines } from './crises.js';
import { resolveDiplomacy, resolveStatement } from './diplomacy.js';
import { moveUnit, returnToBase } from './movement.js';
import { PARAMS } from './params.js';
import { placeOrder } from './procurement.js';
import { validateOrders } from './validators.js';

const ACTIONS = new Set(['STRIKE', 'SOF_OP', 'CYBER_OP']);

/** Esecuzione simultanea: diplomazia → acquisti → movimenti → azioni → interazioni → linee rosse. */
export function adjudicate(ctx: TurnCtx, all: FactionOrders[]) {
  const orders = [...all].sort((a, b) => a.factionId.localeCompare(b.factionId));
  const rejected: { factionId: string; id: string; errors: string[] }[] = [];
  const ok = (o: FactionOrders, body: Partial<FactionOrders>, id: string) => {
    const refs = new Set((ctx.truthContacts[o.factionId] ?? []).map((c) => c.id));
    const v = validateOrders(ctx.state, ctx.catalog, o.factionId, { military: [], diplomacy: [], procurement: [], statements: [], ...body }, refs, ctx.campaign.turnLength);
    if (!v.valid) rejected.push({ factionId: o.factionId, id, errors: v.errors });
    return v.valid;
  };
  for (const o of orders) {
    for (const d of o.diplomacy) if (ok(o, { diplomacy: [d] }, d.id)) resolveDiplomacy(ctx, o.factionId, d);
    for (const st of o.statements) resolveStatement(ctx, o.factionId, st);
  }
  for (const o of orders) {
    const seen = new Map<string, number>();
    for (const p of o.procurement) if (ok(o, { procurement: [p] }, p.id)) { const n = seen.get(p.itemId) ?? 0; placeOrder(ctx, o.factionId, p, n); seen.set(p.itemId, n + 1); }
  }
  for (const o of orders) for (const m of o.military) if (!ACTIONS.has(m.kind) && ok(o, { military: [m] }, m.id)) posture(ctx, o.factionId, m);
  for (const o of orders) for (const m of o.military) if (ACTIONS.has(m.kind) && ok(o, { military: [m] }, m.id)) action(ctx, o.factionId, m);
  detectInteractions(ctx);
  checkRedLines(ctx);
  return rejected;
}

function posture(ctx: TurnCtx, f: string, m: Order) {
  const s = ctx.state;
  const units = ('unitIds' in m ? m.unitIds : []).map((id) => s.units[id]);
  const setTask = () => units.forEach((u) => ctx.emit('UNIT_STATUS', f, { unitId: u.id, patch: { currentTask: m } }, { visibility: [f], causedBy: { orderId: m.id } }));
  switch (m.kind) {
    case 'MOVE': units.forEach((u) => moveUnit(ctx, u, m.to, m.speed, m.id)); setTask(); break;
    case 'REPAIR': units.forEach((u) => returnToBase(ctx, u, 'maintenance', m.id)); break;
    case 'RETURN_TO_BASE': case 'STAND_DOWN': units.forEach((u) => returnToBase(ctx, u, m.kind === 'STAND_DOWN' ? 'maintenance' : 'ready', m.id)); break;
    case 'ISR': {
      const isrAssets = s.factions[f].isrAssets.map((a) => (m.assetIds.includes(a.id) ? { ...a, tasking: m.zoneId } : a));
      ctx.emit('FACTION_CHANGED', f, { factionId: f, patch: { isrAssets } }, { visibility: [f], causedBy: { orderId: m.id } });
      ctx.spend(f, -PARAMS.sortieCost.ISR * m.assetIds.length, 'intel', m.id, `Tasking ISR su ${m.zoneId}`);
      break;
    }
    case 'ESCORT': {
      const zone = s.units[m.protect]?.zoneId ?? s.infrastructure[m.protect]?.zoneId ?? units[0]?.zoneId;
      units.forEach((u) => moveUnit(ctx, u, zone, 'cruise', m.id)); setTask(); break;
    }
    default: {
      if (!('zoneId' in m)) break;
      units.forEach((u) => moveUnit(ctx, u, m.zoneId, m.kind === 'EVACUATION' ? 'flank' : 'cruise', m.id)); setTask();
      const present = [...new Set(Object.values(s.units).filter((u) => u.zoneId === m.zoneId && u.status === 'deployed' && u.factionId !== f).map((u) => u.factionId))];
      if (m.kind === 'SHOW_OF_FORCE') { ctx.emit('FACTION_CHANGED', f, { factionId: f, delta: { credibility: 1 } }); present.forEach((o) => ctx.relate(f, o, -2, 5, `dimostrazione di forza in ${m.zoneId}`, { propagate: false })); }
      if (m.kind === 'BLOCKADE' || m.kind === 'EXCLUSION_ZONE') {
        present.forEach((o) => ctx.relate(f, o, -5, 10, `${m.kind} in ${m.zoneId}`));
        Object.values(s.crises).filter((c) => c.zoneIds.includes(m.zoneId)).forEach((c) => ctx.escalate(c.id, 1, `${m.kind} di ${f}`));
      }
      if (m.kind === 'EVACUATION') ctx.emit('FACTION_CHANGED', f, { factionId: f, delta: { credibility: 2 } }, { causedBy: { orderId: m.id } });
    }
  }
}

function action(ctx: TurnCtx, f: string, m: Order) {
  const s = ctx.state;
  if (m.kind === 'STRIKE') {
    const contact = (ctx.truthContacts[f] ?? []).find((c) => c.id === m.targetRef);
    const unit = contact?.truthUnitId ? s.units[contact.truthUnitId] : undefined;
    const infra = s.infrastructure[m.targetRef]; const base = s.bases[m.targetRef];
    const victim = unit?.factionId ?? base?.factionId ?? infra?.owners.find((o) => o !== f);
    const zoneId = unit?.zoneId ?? base?.zoneId ?? infra?.zoneId;
    if (!zoneId) return;
    const n = Object.values(m.munitions).reduce((a, b) => a + b, 0);
    for (const [mun, q] of Object.entries(m.munitions)) {
      let left = q;
      for (const id of m.unitIds) { const take = Math.min(left, s.units[id].loadout[mun] ?? 0); if (take) { ctx.emit('MUNITION_EXPENDED', f, { factionId: f, unitId: id, munitionId: mun, qty: take }, { visibility: [f] }); left -= take; } }
    }
    ctx.spend(f, -(PARAMS.sortieCost.STRIKE + Object.entries(m.munitions).reduce((a, [k, q]) => a + (ctx.catalog.munitions[k]?.cost ?? 1) * q, 0)), 'operations', m.id, `Strike su ${m.targetRef}`);
    if (victim) ctx.relate(f, victim, -25, 25, `strike su ${m.targetRef}`, { incident: true });
    Object.values(s.crises).filter((c) => c.zoneIds.includes(zoneId)).forEach((c) => ctx.escalate(c.id, 2, `strike di ${f} su ${m.targetRef}`));
    const player = ctx.campaign.playerFaction;
    const defenders = Object.values(s.units).filter((u) => u.factionId === victim && u.zoneId === zoneId && u.status !== 'destroyed').map((u) => u.id);
    if ((f === player || victim === player) && victim && (n >= ctx.campaign.config.cmoThreshold.missileSalvo || unit)) {
      openEngagement(ctx, zoneId, [{ factionId: f, unitIds: m.unitIds }, { factionId: victim, unitIds: defenders.length ? defenders : unit ? [unit.id] : [] }], { missiles: n, orderId: m.id, objective: `Strike su ${m.targetRef}` });
      return;
    }
    const sam = Object.values(s.units).filter((u) => u.factionId === victim && u.zoneId === zoneId && (u.type === 'sam_battery' || (u.currentTask as { kind?: string } | null)?.kind === 'AIR_DEFENSE')).length;
    const r = ctx.rng.chance(`strike ${f} su ${m.targetRef} (${n} vettori)`, Math.min(0.9, 0.35 + n * 0.06 - Math.min(0.4, sam * 0.1)));
    if (!r.ok) { ctx.emit('RANDOM_EVENT', 'world', { eventId: 'STRIKE_FAILED', text: `Strike su ${m.targetRef} intercettato o fallito`, zoneId }, { causedBy: { orderId: m.id, rollId: r.roll.id } }); return; }
    if (infra) ctx.emit('INFRA_STATUS', f, { infraId: infra.id, status: n >= 4 ? 'offline' : 'degraded', cause: `strike di ${f}` }, { causedBy: { orderId: m.id, rollId: r.roll.id } });
    else if (unit) ctx.emit('UNIT_DAMAGED', f, { unitId: unit.id, damage: unit.damage + 30 + ctx.rng.int(0, 30), countLoss: unit.domain === 'air' ? 2 : 0 }, { causedBy: { orderId: m.id, rollId: r.roll.id } });
    else if (base) ctx.emit('RANDOM_EVENT', 'world', { eventId: 'BASE_HIT', text: `Base ${base.name} colpita`, zoneId }, { causedBy: { orderId: m.id, rollId: r.roll.id } });
    return;
  }
  if (m.kind === 'SOF_OP') {
    const sof = m.unitIds.map((id) => s.units[id]);
    const readiness = sof.reduce((a, u) => a + u.readiness, 0) / Math.max(1, sof.length);
    const r = ctx.rng.roll(`operazione SOF ${f}: ${m.objective}`, '2d6', { modifiers: [{ name: 'prontezza', value: Math.round((readiness - 60) / 15) }], outcome: (t) => (t >= 8 ? 'success' : 'failure') });
    ctx.spend(f, -PARAMS.sortieCost.SOF_OP, 'operations', m.id, `Operazione SOF in ${m.zoneId}`);
    sof.forEach((u) => ctx.emit('UNIT_MOVED', f, { unitId: u.id, location: s.zones[m.zoneId].center, zoneId: m.zoneId, status: 'deployed' }, { visibility: [f] }));
    const success = r.outcome === 'success';
    ctx.emit('SOF_RESULT', f, { success, objective: m.objective, zoneId: m.zoneId }, { visibility: m.deniability === 'covert' ? [f] : 'public', causedBy: { orderId: m.id, rollId: r.id } });
    const infraHit = Object.values(s.infrastructure).find((i) => m.objective.includes(i.id));
    if (success && infraHit) ctx.emit('INFRA_STATUS', f, { infraId: infraHit.id, status: 'degraded', cause: 'sabotaggio' }, { visibility: m.deniability === 'covert' ? [f] : 'public', causedBy: { orderId: m.id } });
    if (!success) sof.forEach((u) => ctx.emit('UNIT_DAMAGED', 'world', { unitId: u.id, damage: u.damage + 30 }, { visibility: [f] }));
    if (m.deniability === 'covert' && ctx.rng.chance(`attribuzione SOF ${f}`, success ? 0.2 : 0.5).ok) {
      const owners = [...new Set(Object.values(s.units).filter((u) => u.zoneId === m.zoneId && u.factionId !== f).map((u) => u.factionId))];
      ctx.emit('RANDOM_EVENT', 'world', { eventId: 'SOF_EXPOSED', text: `Operazione clandestina attribuita a ${f} in ${s.zones[m.zoneId].name}`, zoneId: m.zoneId });
      owners.forEach((o) => ctx.relate(f, o, -10, 10, 'operazione clandestina scoperta', { incident: true }));
    }
    return;
  }
  if (m.kind === 'CYBER_OP') {
    const att = s.factions[f]; const def = s.factions[m.target];
    ctx.spend(f, -PARAMS.sortieCost.CYBER_OP, 'intel', m.id, `Operazione cyber contro ${m.target}`);
    if (m.effect === 'defense_hardening') { ctx.emit('FACTION_CHANGED', f, { factionId: f, patch: { cyber: { ...att.cyber, defense: Math.min(10, att.cyber.defense + 1) } } }, { visibility: [f] }); return; }
    const a = ctx.rng.roll(`cyber ${f} → ${m.target} (attacco)`, 'd10', { modifiers: [{ name: 'offense', value: att.cyber.offense }] });
    const d = ctx.rng.roll(`cyber ${f} → ${m.target} (difesa)`, 'd10', { modifiers: [{ name: 'defense', value: def.cyber.defense }] });
    const success = a.total > d.total;
    const payload: Record<string, unknown> = { success, effect: m.effect, target: m.target, targetRef: m.targetRef };
    if (success && m.effect === 'espionage') payload.intel = { posture: def.posture, budget: def.budget.discretionary, stability: def.stability };
    ctx.emit('CYBER_EFFECT', f, payload, { visibility: [f], causedBy: { orderId: m.id, rollId: a.id } });
    if (success && m.effect === 'disruption') {
      if (s.infrastructure[m.targetRef]) ctx.emit('INFRA_STATUS', f, { infraId: m.targetRef, status: 'degraded', cause: 'attacco cyber' }, { visibility: 'public' });
      else ctx.emit('FACTION_CHANGED', f, { factionId: m.target, delta: { stability: -3 } }, { visibility: [f, m.target] });
    }
    if (ctx.rng.chance(`attribuzione cyber ${f}`, m.effect === 'disruption' ? 0.5 : 0.25).ok) {
      ctx.emit('CYBER_EFFECT', m.target, { attributedTo: f, effect: m.effect }, { targets: [f] });
      ctx.relate(f, m.target, -10, 10, 'attacco cyber attribuito', { incident: true });
    }
  }
}
