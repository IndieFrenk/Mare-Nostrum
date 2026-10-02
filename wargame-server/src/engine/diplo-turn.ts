import type { TurnCtx } from './context.js';
import { weeklyRent } from './diplo-actions.js';
import { weeksOfTurn } from './opinion.js';
import { PARAMS } from './params.js';

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Fazioni con un capitale diplomatico: tutte tranne i blocchi (NATO, UE) che non agiscono da sole. */
export const capitalHolders = (ctx: TurnCtx) => Object.values(ctx.state.factions).filter((f) => f.kind !== 'bloc').map((f) => f.id).sort();

/** Spesa di CD di un'azione (con `causedBy` dell'ordine). Non scende sotto zero: il validatore ha già controllato che bastasse. */
export function spendCapital(ctx: TurnCtx, factionId: string, amount: number, note: string, orderId?: string) {
  if (!amount) return;
  const have = ctx.state.diplomacy?.capital[factionId] ?? 0;
  const delta = -Math.min(have, amount);
  if (!delta) return;
  ctx.emit('CAPITAL_CHANGED', factionId, { deltas: { [factionId]: r1(delta) }, note }, { visibility: [factionId], ...(orderId ? { causedBy: { orderId } } : {}) });
}

/**
 * OPEN: passo diplomatico del turno (dopo il decadimento dell'opinione).
 * 1. Rendita di CD (settimane del turno × rendita a settimana), **un evento** per tutte le fazioni.
 * 2. «Migliorare le relazioni» in corso: 1 CD a turno e +2 all'opinione del destinatario (tetto +30); senza CD si interrompe.
 * 3. Ultimatum scaduti: «soddisfatto» (il destinatario ha cercato la distensione) o `expired` (dà legittimità alla forza, tensione mondiale +5).
 * 4. Pulizia: ricariche finite, risoluzioni scadute, ultimatum chiusi da tempo.
 */
export function diplomaticTurn(ctx: TurnCtx) {
  const s = ctx.state;
  const P = PARAMS.diplo;
  const weeks = weeksOfTurn(ctx.campaign.turnLength);
  const deltas: Record<string, number> = {};
  for (const f of capitalHolders(ctx)) {
    const have = s.diplomacy?.capital[f];
    // una campagna già in corso senza capitale (migrata dopo) parte con la dotazione iniziale, non da zero
    const gain = (have === undefined ? P.capital.initialWeeks * weeklyRent(s, f) : 0) + weeklyRent(s, f) * weeks;
    const room = P.capital.cap - (have ?? 0);
    if (gain > 0 && room > 0) deltas[f] = r1(Math.min(gain, room));
  }
  if (Object.keys(deltas).length) ctx.emit('CAPITAL_CHANGED', 'world', { deltas, rent: true, weeks }, { visibility: [] });

  for (const i of [...(s.diplomacy?.improving ?? [])].sort((a, b) => `${a.actor}|${a.target}`.localeCompare(`${b.actor}|${b.target}`))) {
    if (i.since >= ctx.turn) continue; // appena avviata: il primo +2 e il primo CD sono già stati dati dall'azione
    if ((s.diplomacy?.capital[i.actor] ?? 0) < P.improve.costPerTurn) {
      ctx.emit('DIPLOMACY_CHANGED', i.actor, { change: { op: 'improve_stop', actor: i.actor, target: i.target }, reason: 'capitale diplomatico esaurito' }, { visibility: [i.actor], targets: [i.target] });
      continue;
    }
    spendCapital(ctx, i.actor, P.improve.costPerTurn, `migliorare le relazioni con ${i.target}`);
    ctx.relate(i.actor, i.target, P.improve.perTurn, 0, `migliorare le relazioni con ${i.target}`, { propagate: false, detente: true });
  }

  const d = s.diplomacy;
  if (!d) return;
  for (const u of d.ultimatums.filter((x) => x.status === 'pending' && x.deadlineTurn <= ctx.turn).sort((a, b) => a.id.localeCompare(b.id))) {
    if (u.answered) {
      ctx.emit('ULTIMATUM_MET', u.to, { ultimatumId: u.id, from: u.from, to: u.to }, { targets: [u.from], visibility: 'public' });
      ctx.relate(u.to, u.from, 0, P.ultimatum.metTension, `ultimatum soddisfatto (${u.id})`, { propagate: false, detente: true });
    } else {
      ctx.emit('ULTIMATUM_EXPIRED', u.from, { ultimatumId: u.id, from: u.from, to: u.to, demand: u.demand, legitimateUntil: ctx.turn + P.legitimacy.ultimatumTurns }, { targets: [u.to], visibility: 'public' });
    }
  }
  // pulizia di ciò che non serve più (così lo stato non cresce senza limite)
  const stale = Object.entries(d.cooldowns).filter(([, until]) => until <= ctx.turn).map(([k]) => k);
  if (stale.length) ctx.emit('DIPLOMACY_CHANGED', 'world', { change: { op: 'cooldown_prune', keys: stale } }, { visibility: [] });
  const oldRes = d.resolutions.filter((r) => r.expiresTurn <= ctx.turn).map((r) => r.id);
  if (oldRes.length) ctx.emit('DIPLOMACY_CHANGED', 'world', { change: { op: 'resolution_prune', ids: oldRes } }, { visibility: [] });
  const oldUlt = d.ultimatums.filter((u) => u.status !== 'pending' && (u.legitimateUntil ?? u.deadlineTurn) + 1 < ctx.turn).map((u) => u.id);
  if (oldUlt.length) ctx.emit('DIPLOMACY_CHANGED', 'world', { change: { op: 'ultimatum_prune', ids: oldUlt } }, { visibility: [] });
}
