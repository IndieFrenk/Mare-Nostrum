import type { Agreement, Crisis, Engagement, Faction, GameEvent, OpinionModifier, PendingDelivery, Resolution, Ultimatum, Unit, WorldState } from '../schemas/index.js';
import { emptyDiplomacy, pairKey, setTension, syncPair, syncRelation, tensionOf } from './opinion.js';
import { PARAMS } from './params.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Nota e ultimo incidente di un atto diplomatico sulle relazioni tra fazioni (come faceva RELATION_CHANGED, per entrambe le direzioni). */
function noteAct(s: WorldState, act: { a: string; b: string; note?: string; incident?: boolean } | undefined, turn: number) {
  if (!act) return;
  for (const [x, y] of [[act.a, act.b], [act.b, act.a]] as const) {
    const rel = s.relations[x]?.[y];
    if (!rel) continue;
    if (act.incident) rel.lastIncidentTurn = turn;
    if (act.note) rel.notes = [...rel.notes.slice(-4), act.note];
  }
}

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
    case 'OPINION_MODIFIER': {
      // aggiunge o aggiorna (stesso id) un modificatore di opinion(from→to) e ricalcola il valore derivato tra le fazioni
      const d = (s.diplomacy ??= emptyDiplomacy());
      const m = p.modifier as OpinionModifier;
      const i = d.modifiers.findIndex((x) => x.id === m.id);
      if (i >= 0) d.modifiers[i] = m; else d.modifiers.push(m);
      syncRelation(s, m.from, m.to);
      noteAct(s, p.act, e.turn);
      break;
    }
    case 'OPINION_DECAYED': {
      // un solo evento per turno: valori nuovi dei modificatori che decadono e id di quelli che si tolgono
      const d = (s.diplomacy ??= emptyDiplomacy());
      const touched = new Set<string>();
      const gone = new Set<string>(p.removed ?? []);
      const next = new Map<string, number>(p.changed ?? []);
      for (const m of d.modifiers) if (gone.has(m.id) || next.has(m.id)) touched.add(`${m.from}>${m.to}`);
      d.modifiers = d.modifiers.filter((m) => !gone.has(m.id)).map((m) => (next.has(m.id) ? { ...m, value: next.get(m.id)! } : m));
      for (const t of touched) { const [a, b] = t.split('>') as [string, string]; syncRelation(s, a, b); }
      break;
    }
    case 'TENSION_CHANGED': {
      const d = (s.diplomacy ??= emptyDiplomacy());
      if (Array.isArray(p.changes)) {
        // ritorno al fondo (fase OPEN): `[chiave «A|B», nuovo valore | null]`; si ricalcolano dopo, il fondo non cambia durante il passo
        const keys: string[] = [];
        for (const [key, v] of p.changes as [string, number | null][]) { if (v === null) delete d.tension[key]; else d.tension[key] = v; keys.push(key); }
        for (const key of keys) { const [a, b] = key.split('|') as [string, string]; syncPair(s, a, b); }
      } else {
        setTension(s, p.a, p.b, tensionOf(s, p.a, p.b) + (p.delta ?? 0));
        syncPair(s, p.a, p.b);
        noteAct(s, p.act, e.turn);
      }
      break;
    }
    case 'CAPITAL_CHANGED': {
      // `deltas`: attore → variazione (la rendita del turno è un solo evento per tutte le fazioni; una spesa ne ha uno solo)
      const d = (s.diplomacy ??= emptyDiplomacy());
      for (const [f, delta] of Object.entries(p.deltas as Record<string, number>)) d.capital[f] = clamp(r1((d.capital[f] ?? 0) + delta), 0, PARAMS.diplo.capital.cap);
      break;
    }
    case 'DIPLOMACY_CHANGED': {
      // un solo tipo di evento per i registri della diplomazia (ricariche, miglioramenti, rapporti, embarghi, ultimatum, risoluzioni)
      const d = (s.diplomacy ??= emptyDiplomacy());
      const c = p.change as Record<string, any>;
      switch (c.op) {
        case 'cooldown': Object.assign(d.cooldowns, c.keys); break;
        case 'cooldown_prune': for (const k of c.keys as string[]) delete d.cooldowns[k]; break;
        case 'improve_start': d.improving.push({ actor: c.actor, target: c.target, since: e.turn }); break;
        case 'improve_stop': d.improving = d.improving.filter((x) => !(x.actor === c.actor && x.target === c.target)); break;
        case 'tie': if (c.status) d.ties[pairKey(c.a, c.b)] = c.status; else delete d.ties[pairKey(c.a, c.b)]; break;
        case 'embargo_add': if (!d.embargoes.includes(c.key)) d.embargoes.push(c.key); break;
        case 'embargo_remove': d.embargoes = d.embargoes.filter((x) => x !== c.key); break;
        case 'ultimatum_add': d.ultimatums.push(c.ultimatum as Ultimatum); break;
        case 'ultimatum_answered': for (const u of d.ultimatums) if (u.id === c.id) u.answered = true; break;
        case 'resolution_prune': d.resolutions = d.resolutions.filter((r) => !(c.ids as string[]).includes(r.id)); break;
        case 'ultimatum_prune': d.ultimatums = d.ultimatums.filter((u) => !(c.ids as string[]).includes(u.id)); break;
        default: break;
      }
      break;
    }
    case 'ULTIMATUM_MET': case 'ULTIMATUM_EXPIRED': {
      const d = (s.diplomacy ??= emptyDiplomacy());
      const u = d.ultimatums.find((x) => x.id === p.ultimatumId);
      if (u) Object.assign(u, e.type === 'ULTIMATUM_MET' ? { status: 'met' } : { status: 'expired', legitimateUntil: p.legitimateUntil });
      break;
    }
    case 'INSTITUTION_VOTE': {
      // l'esito di una votazione: se approvata e con effetti vincolanti dà una risoluzione che vale come mandato (legittimità)
      if (p.resolution) (s.diplomacy ??= emptyDiplomacy()).resolutions.push(p.resolution as Resolution);
      break;
    }
    case 'WORLD_TENSION_CHANGED': s.globalIndicators.worldTension = clamp(r1(p.to), 0, 100); break;
    // legacy: eventi delle campagne precedenti ai modificatori (non si emettono più); per le coppie tra fazioni si applica il delta diretto
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
    case 'AGREEMENT_CHANGED': {
      const ag = p.agreement as Agreement;
      s.agreements[ag.id] = ag;
      // il «Trattato attivo» vale finché l'accordo è in vigore: scaduto o violato, i suoi modificatori si tolgono
      if (ag.status === 'expired' || ag.status === 'violated') {
        const d = s.diplomacy;
        const gone = d?.modifiers.filter((m) => m.id.startsWith(`treaty:${ag.id}:`)) ?? [];
        if (d && gone.length) { d.modifiers = d.modifiers.filter((m) => !m.id.startsWith(`treaty:${ag.id}:`)); for (const m of gone) syncRelation(s, m.from, m.to); }
      }
      break;
    }
    case 'CRISIS_CHANGED': {
      const c: Crisis = p.crisis ?? s.crises[p.crisisId];
      c.escalation = clamp(r1(c.escalation + (p.delta ?? 0)), 0, 10);
      c.status = p.status ?? (c.escalation === 0 ? 'resolved' : c.escalation >= 4 ? 'active' : c.status === 'frozen' ? 'frozen' : 'latent');
      if (p.delta) c.history.push({ turn: e.turn, delta: p.delta, cause: p.cause });
      s.crises[c.id] = c;
      for (const z of c.zoneIds) if (s.zones[z]) s.zones[z].tension = Math.max(...Object.values(s.crises).filter((k) => k.zoneIds.includes(z)).map((k) => k.escalation * 10), 10);
      // il fondo della tensione di coppia dipende dalle crisi in comune: si ricalcola per le parti coinvolte
      for (let i = 0; i < c.involved.length; i++) for (let j = i + 1; j < c.involved.length; j++) syncPair(s, c.involved[i]!, c.involved[j]!);
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
