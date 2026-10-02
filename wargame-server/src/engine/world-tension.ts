import type { GameEvent } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { decayModifiers, decayTension, diploActs, weeksOfTurn } from './opinion.js';
import { PARAMS } from './params.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * OPEN: passo di decadimento della diplomazia. I modificatori d'opinione vanno verso 0 (decayPerWeek × settimane del turno; il mese vale
 * 4 settimane) e quelli scaduti si tolgono con **un solo evento aggregato** (OPINION_DECAYED); la tensione di coppia torna verso il
 * fondo (un TENSION_CHANGED per turno). Sono eventi interni del motore: non visibili a nessuna fazione (i modificatori privati
 * non devono trapelare dagli id).
 */
export function decayDiplomacy(ctx: TurnCtx) {
  const d = ctx.state.diplomacy;
  if (!d) return;
  const weeks = weeksOfTurn(ctx.campaign.turnLength);
  const ch = decayModifiers(d.modifiers, ctx.turn, weeks);
  if (ch.changed.length || ch.removed.length) ctx.emit('OPINION_DECAYED', 'world', ch as unknown as Record<string, unknown>, { visibility: [] });
  const t = decayTension(ctx.state, weeks);
  if (t.length) ctx.emit('TENSION_CHANGED', 'world', { decay: true, weeks, changes: t }, { visibility: [] });
}

/**
 * Tensione mondiale 0–100 (docs/wargame/DIPLOMAZIA.md §6), a fine turno: si avvicina di `relax` al valore dato dalle crisi (base +
 * escalation massima e media) e ogni incidente del turno (scontri, strike, blocchi, minacce) aggiunge la sua quota, con un tetto.
 * Senza incidenti scende da sola; non resta a 100 perché il valore di regime delle crisi arriva al massimo a 63. Un solo evento
 * WORLD_TENSION_CHANGED con le cause; gli indicatori (Brent, TTF, rischio navale) si muovono poco e in proporzione alla variazione.
 * `turnEvents`: tutti gli eventi del turno (anche quelli già salvati da fasi precedenti).
 */
export function updateWorldTension(ctx: TurnCtx, turnEvents: GameEvent[]) {
  const s = ctx.state; const P = PARAMS.worldTension;
  const live = Object.values(s.crises).filter((c) => c.status !== 'resolved');
  const esc = live.map((c) => c.escalation);
  const max = esc.length ? Math.max(...esc) : 0;
  const mean = esc.length ? esc.reduce((a, b) => a + b, 0) / esc.length : 0;
  const target = clamp(P.base + P.perMaxEscalation * max + P.perMeanEscalation * mean, 0, 100);
  const from = s.globalIndicators.worldTension;
  const toCrises = (target - from) * P.relax;

  const acts = diploActs(turnEvents.filter((e) => e.turn === ctx.turn));
  const count = (re: RegExp) => acts.filter((x) => re.test(x.note)).length;
  const incidents: { label: string; n: number; each: number }[] = [
    { label: 'scontri armati', n: turnEvents.filter((e) => e.turn === ctx.turn && e.type === 'ENGAGEMENT_OPENED').length, each: P.incident.engagement },
    { label: 'strike', n: count(/^strike su /), each: P.incident.strike },
    { label: 'blocchi navali', n: count(/^(BLOCKADE|EXCLUSION_ZONE) in /), each: P.incident.blockade },
    { label: 'minacce', n: count(/^(minaccia:|lettera \(threatening\))/), each: P.incident.threat },
  ].filter((x) => x.n > 0);
  const boost = Math.min(P.maxIncidentBoost, incidents.reduce((a, x) => a + x.n * x.each, 0));
  const to = r1(clamp(from + toCrises + boost, 0, 100));
  if (Math.abs(to - from) < 0.05) return;
  ctx.emit('WORLD_TENSION_CHANGED', 'world', {
    from, to,
    causes: [
      { label: `crisi (massima ${max}/10, media ${r1(mean)}): valore di regime ${r1(target)}`, value: r1(toCrises) },
      ...incidents.map((x) => ({ label: `${x.label} (${x.n})`, value: r1(x.n * x.each) })),
      ...(boost < incidents.reduce((a, x) => a + x.n * x.each, 0) ? [{ label: 'tetto agli incidenti del turno', value: r1(boost - incidents.reduce((a, x) => a + x.n * x.each, 0)) }] : []),
    ],
  });
  const d = to - from; const I = P.indicators;
  ctx.emit('INDICATORS_CHANGED', 'world', { delta: { brentUsd: r1(d * I.brentPerPoint), ttfEurMwh: r1(d * I.ttfPerPoint), medShippingRisk: r1(d * I.shippingPerPoint) }, cause: 'tensione mondiale' });
}
