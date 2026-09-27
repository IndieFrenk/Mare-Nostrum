import type { ProcurementOrder } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { PARAMS } from './params.js';
import { makeUnit } from './scenario.js';

export function placeOrder(ctx: TurnCtx, factionId: string, po: ProcurementOrder, repeatIndex: number) {
  const item = ctx.catalog.items.find((i) => i.id === po.itemId);
  if (!item || item.leadTimeTurns === null) return;
  const totalCost = item.cost * po.qty;
  let lead = item.leadTimeTurns;
  let rollId: string | undefined;
  if (item.kind === 'munition_lot') {
    const p = PARAMS.industrialAvailability - PARAMS.industrialPenaltyRepeat * repeatIndex;
    const r = ctx.rng.chance(`disponibilità industriale ${item.name} (${factionId})`, p);
    rollId = r.roll.id;
    if (!r.ok) lead += 1;
  }
  const delivery = { id: `D-${ctx.turn}-${po.id}-${factionId}`, factionId, itemId: item.id, qty: po.qty, orderedTurn: ctx.turn, deliveryTurn: ctx.turn + lead, totalCost, destinationBaseId: po.destinationBaseId };
  ctx.spend(factionId, -totalCost, 'procurement', delivery.id, `${po.qty}× ${item.name}`);
  ctx.emit('PROCUREMENT_ORDERED', factionId, { delivery }, { visibility: [factionId], causedBy: { orderId: po.id, rollId } });
}

export function deliver(ctx: TurnCtx) {
  for (const d of [...ctx.state.pendingDeliveries].filter((x) => x.deliveryTurn <= ctx.turn)) {
    const item = ctx.catalog.items.find((i) => i.id === d.itemId)!;
    if (item.kind === 'munition_lot') {
      ctx.emit('DELIVERY_ARRIVED', d.factionId, { deliveryId: d.id, factionId: d.factionId, munitionId: item.munitionId, qty: (item.lotSize ?? 1) * d.qty }, { visibility: [d.factionId] });
      continue;
    }
    ctx.emit('DELIVERY_ARRIVED', d.factionId, { deliveryId: d.id, factionId: d.factionId }, { visibility: [d.factionId] });
    const cls = ctx.catalog.classes[item.platformClassId!];
    const squadron = Object.values(ctx.state.units).find((u) => u.factionId === d.factionId && u.classId === item.platformClassId && u.status !== 'destroyed' && cls.domain === 'air');
    if (squadron) {
      ctx.emit('UNIT_STATUS', d.factionId, { unitId: squadron.id, patch: { count: squadron.count + d.qty } }, { visibility: [d.factionId] });
    } else {
      const base = ctx.state.bases[d.destinationBaseId];
      const unit = makeUnit(cls, { id: `${d.factionId}-${item.id}-${d.id.slice(-6)}`, factionId: d.factionId, name: `${item.name} (nuova consegna)`, classId: item.platformClassId!, count: d.qty, homeBaseId: base.id }, base.location, base.zoneId);
      ctx.emit('UNIT_CREATED', d.factionId, { unit }, { visibility: [d.factionId] });
    }
  }
}
