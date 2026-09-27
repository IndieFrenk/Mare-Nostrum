import type { Agreement, Crisis, Engagement, Faction, GameEvent, PendingDelivery, Unit, WorldState } from '../schemas/index.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Unico punto in cui lo stato viene mutato: state(N) = snapshot(N-1) + reduce(events(N)). */
export function applyEvent(s: WorldState, e: GameEvent): void {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'TURN_ADVANCED': s.turn = p.turn; s.date = p.date; break;
    case 'TURN_CLOSED': s.rngCursor = p.rngCursor; break;
    case 'UNIT_MOVED': Object.assign(s.units[p.unitId], { location: p.location, zoneId: p.zoneId }, p.status ? { status: p.status } : {}); break;
    case 'UNIT_STATUS': Object.assign(s.units[p.unitId], p.patch as Partial<Unit>); break;
    case 'UNIT_CREATED': s.units[(p.unit as Unit).id] = p.unit as Unit; break;
    case 'UNIT_DAMAGED': {
      const u = s.units[p.unitId];
      u.damage = clamp(p.damage, 0, 100);
      u.count = Math.max(0, u.count - (p.countLoss ?? 0));
      u.status = p.status ?? (u.damage >= 100 || u.count === 0 ? 'destroyed' : u.damage > 0 ? 'damaged' : u.status);
      break;
    }
    case 'UNIT_DESTROYED': Object.assign(s.units[p.unitId], { status: 'destroyed', damage: 100 }); break;
    case 'MUNITION_EXPENDED': {
      const bag = p.unitId ? s.units[p.unitId].loadout : s.factions[p.factionId].stocks;
      bag[p.munitionId] = Math.max(0, (bag[p.munitionId] ?? 0) - p.qty);
      break;
    }
    case 'PROCUREMENT_ORDERED': s.pendingDeliveries.push(p.delivery as PendingDelivery); break;
    case 'DELIVERY_ARRIVED': {
      s.pendingDeliveries = s.pendingDeliveries.filter((d) => d.id !== p.deliveryId);
      if (p.munitionId) { const st = s.factions[p.factionId].stocks; st[p.munitionId] = (st[p.munitionId] ?? 0) + p.qty; }
      break;
    }
    case 'BUDGET_CHANGED': { const b = s.factions[p.factionId].budget; b.discretionary = r1(b.discretionary + p.delta); break; }
    case 'RELATION_CHANGED': {
      for (const [a, b] of [[p.a, p.b], [p.b, p.a]]) {
        const rel = s.relations[a]?.[b];
        if (!rel) continue;
        rel.trust = clamp(r1(rel.trust + (p.trust ?? 0)), -100, 100);
        rel.tension = clamp(r1(rel.tension + (p.tension ?? 0)), 0, 100);
        if (p.incident) rel.lastIncidentTurn = e.turn;
        if (p.note) rel.notes = [...rel.notes.slice(-4), p.note];
      }
      break;
    }
    case 'AGREEMENT_CHANGED': s.agreements[(p.agreement as Agreement).id] = p.agreement as Agreement; break;
    case 'CRISIS_CHANGED': {
      const c: Crisis = p.crisis ?? s.crises[p.crisisId];
      c.escalation = clamp(r1(c.escalation + (p.delta ?? 0)), 0, 10);
      c.status = p.status ?? (c.escalation === 0 ? 'resolved' : c.escalation >= 4 ? 'active' : c.status === 'frozen' ? 'frozen' : 'latent');
      if (p.delta) c.history.push({ turn: e.turn, delta: p.delta, cause: p.cause });
      s.crises[c.id] = c;
      for (const z of c.zoneIds) if (s.zones[z]) s.zones[z].tension = Math.max(...Object.values(s.crises).filter((k) => k.zoneIds.includes(z)).map((k) => k.escalation * 10), 10);
      break;
    }
    case 'INFRA_STATUS': s.infrastructure[p.infraId].status = p.status; break;
    case 'FACTION_CHANGED': {
      const f = s.factions[p.factionId];
      for (const [k, v] of Object.entries(p.delta ?? {})) (f as any)[k] = clamp(r1((f as any)[k] + (v as number)), k === 'posture' ? 1 : 0, k === 'posture' ? 5 : k === 'cyber' ? 10 : 100);
      Object.assign(f, p.patch as Partial<Faction> ?? {});
      break;
    }
    case 'INDICATORS_CHANGED': {
      const g = s.globalIndicators as Record<string, number>;
      for (const [k, v] of Object.entries(p.delta ?? {})) g[k] = clamp(r1(g[k] + (v as number)), 0, k.endsWith('Usd') || k.endsWith('Mwh') ? 1000 : 100);
      Object.assign(g, p.set ?? {});
      break;
    }
    case 'ENGAGEMENT_OPENED': s.engagements[(p.engagement as Engagement).id] = p.engagement as Engagement; break;
    case 'ENGAGEMENT_RESOLVED': Object.assign(s.engagements[p.engagementId], p.patch); break;
    default: break; // eventi informativi (contatti, messaggi, SOF, cyber, casuali): nessuna mutazione diretta
  }
}

export function rebuild(snapshot: WorldState, events: GameEvent[]): WorldState {
  const s = structuredClone(snapshot);
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) applyEvent(s, e);
  return s;
}
