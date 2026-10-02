import type { WorldState } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { isDemocracy } from './diplo-actions.js';
import { spendCapital } from './diplo-turn.js';
import { PARAMS } from './params.js';

/**
 * Legittimità dell'uso della forza (docs/wargame/DIPLOMAZIA.md §7). Un blocco o una zona di esclusione contro altri paga un costo se
 * non c'è un **mandato**: una risoluzione approvata da un'istituzione (non scaduta, sul bersaglio o generale), un ultimatum scaduto verso
 * il bersaglio, oppure una tensione mondiale già ≥ 50 (in un mondo in crisi non fa notizia). Il costo: CD, credibilità e un
 * modificatore d'opinione presso i terzi. Le democrazie con tensione mondiale < 25 pagano il doppio in CD (§6).
 */
export interface Mandate { ok: boolean; why: string }

export function mandate(s: WorldState, actor: string, victims: string[]): Mandate {
  const L = PARAMS.diplo.legitimacy;
  const d = s.diplomacy;
  if (s.globalIndicators.worldTension >= L.worldTension) return { ok: true, why: `tensione mondiale ${Math.round(s.globalIndicators.worldTension)} ≥ ${L.worldTension}` };
  const res = (d?.resolutions ?? []).find((r) => r.expiresTurn > s.turn && r.topic !== 'humanitarian' && (!r.target || victims.includes(r.target)));
  if (res) return { ok: true, why: `risoluzione ${res.forum} ${res.id}` };
  const ult = (d?.ultimatums ?? []).find((u) => u.status === 'expired' && u.from === actor && victims.includes(u.to) && (u.legitimateUntil ?? 0) >= s.turn);
  if (ult) return { ok: true, why: `ultimatum scaduto ${ult.id}` };
  return { ok: false, why: 'nessuna risoluzione, ultimatum scaduto o tensione mondiale alta' };
}

/** Costo di legittimità di un blocco (o zona di esclusione) di `actor` contro le fazioni presenti: ritorna il mandato. */
export function legitimacyCost(ctx: TurnCtx, actor: string, victims: string[], where: string, orderId: string): Mandate {
  const s = ctx.state; const L = PARAMS.diplo.legitimacy;
  const m = mandate(s, actor, victims);
  if (m.ok || !victims.length) return m;
  const double = s.globalIndicators.worldTension < L.lowTension && isDemocracy(s, actor);
  spendCapital(ctx, actor, L.cd * (double ? 2 : 1), `uso della forza senza mandato in ${where}`, orderId);
  ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: -L.credibility }, note: `uso della forza senza mandato in ${where}` }, { causedBy: { orderId } });
  for (const third of Object.values(s.factions).filter((f) => f.kind !== 'bloc' && f.id !== actor && !victims.includes(f.id)).map((f) => f.id).sort())
    ctx.relate(actor, third, L.opinion, 0, `uso della forza senza mandato in ${where}`, { propagate: false });
  return m;
}
