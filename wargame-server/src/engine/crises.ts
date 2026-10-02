import type { GameEvent } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { evaluate } from './conditions.js';
import { diploActs } from './opinion.js';
import { PARAMS } from './params.js';

/** OPEN: deriva delle crisi con 2d6 ed eventi casuali pesati per zona/tensione. */
/** 1 = le fazioni coinvolte non hanno tensioni tra loro, 0 = tensione massima. */
function calm(ctx: TurnCtx, involved: string[]) {
  const t: number[] = [];
  for (const a of involved) for (const b of involved) if (a < b) { const r = ctx.state.relations[a]?.[b]; if (r) t.push(r.tension); }
  return t.length ? 1 - t.reduce((x, y) => x + y, 0) / t.length / 100 : 0.5;
}

/** Un accordo entrato in vigore raffredda le crisi pertinenti (tregua tra ≥2 coinvolti; migrazione/energia per le crisi di quel tipo). */
export function deescalateByAgreement(ctx: TurnCtx, ag: { id: string; type: string; parties: string[] }) {
  const d = (PARAMS.agreementDeescalation as Record<string, number>)[ag.type];
  if (!d) return;
  for (const c of Object.values(ctx.state.crises)) {
    if (c.status === 'resolved') continue;
    const inv = ag.parties.filter((p) => c.involved.includes(p)).length;
    if (ag.type === 'ceasefire' ? inv >= 2 : c.type === ag.type && inv >= 1) ctx.escalate(c.id, -d, `accordo ${ag.type} ${ag.id} in vigore`);
  }
}

/** Azioni distensive (atti diplomatici con `detente`) del turno precedente tra due fazioni coinvolte nella crisi. */
export function detenteActions(prevEvents: GameEvent[], involved: string[]) {
  return diploActs(prevEvents).filter((x) => x.detente && involved.includes(x.a) && involved.includes(x.b)).length;
}

/** Probabilità di raffreddamento di una crisi: base se il turno prima è stato quieto (× (1 + calma)) più il bonus delle azioni distensive. */
export function crisisCoolChance(quiet: boolean, calmness: number, detente: number) {
  const base = quiet ? PARAMS.crisisCoolChance * (1 + calmness) : 0;
  return Math.min(0.9, base + PARAMS.detenteCoolBonus * Math.min(detente, PARAMS.detenteMaxActions));
}

/** `prevEvents`: eventi del turno precedente (azioni distensive tra le parti di ogni crisi). */
export function evolveCrises(ctx: TurnCtx, prevEvents: GameEvent[] = []) {
  for (const c of Object.values(ctx.state.crises)) {
    if (c.status === 'resolved' || c.status === 'frozen') continue;
    const r = ctx.rng.roll(`deriva crisi ${c.id}`, '2d6');
    if (r.total >= PARAMS.crisisDriftUp) ctx.escalate(c.id, 1, 'deriva: deterioramento spontaneo');
    else if (r.total <= PARAMS.crisisDriftDown) ctx.escalate(c.id, -1, 'deriva: raffreddamento');
    // senza nuovi incidenti nel turno precedente la crisi tende a calmarsi, tanto più se le parti non sono in tensione;
    // la diplomazia tra le parti (azioni distensive del turno prima) aumenta la probabilità anche dopo un turno agitato
    const quiet = !c.history.some((h) => h.turn === ctx.turn - 1 && h.delta > 0);
    const detente = detenteActions(prevEvents, c.involved);
    const p = crisisCoolChance(quiet, calm(ctx, c.involved), detente);
    if (c.escalation > 0 && p > 0 && ctx.rng.chance(`raffreddamento ${c.id}`, p).ok) {
      ctx.escalate(c.id, -1, detente ? `diplomazia tra le parti (${detente} azioni distensive): raffreddamento` : 'nessun nuovo incidente: raffreddamento');
    }
  }
  const table = ctx.scenario.events;
  const touched = new Set<string>();
  const escalateOnce = (id: string, delta: number, cause: string) => {
    const c = ctx.state.crises[id];
    if (!c || touched.has(id)) return;
    touched.add(id);
    // saturazione: una crisi già grave non sale per ogni incidente (PARAMS.randomEventSaturation)
    if (delta > 0 && !ctx.rng.chance(`effetto su ${id}: ${cause}`, Math.max(0, 1 - c.escalation / PARAMS.randomEventSaturation)).ok) return;
    ctx.escalate(id, delta, cause);
  };
  for (const z of Object.values(ctx.state.zones)) {
    const rows = table.filter((e) => e.zones.includes(z.id) && e.minTension <= z.tension);
    if (!rows.length || !ctx.rng.chance(`evento casuale in ${z.id}`, PARAMS.randomEventChance * (0.5 + z.tension / 100)).ok) continue;
    const total = rows.reduce((a, e) => a + e.weight, 0);
    let x = ctx.rng.next() * total;
    const ev = rows.find((e) => (x -= e.weight) < 0) ?? rows[0];
    ctx.emit('RANDOM_EVENT', 'world', { eventId: ev.id, text: ev.text, zoneId: z.id }, { targets: [z.id] });
    if (ev.crisis) escalateOnce(ev.crisis[0], ev.crisis[1], ev.text);
    if (ev.crisisAny) for (const c of Object.values(ctx.state.crises).filter((c) => c.zoneIds.includes(z.id))) escalateOnce(c.id, ev.crisisAny, ev.text);
    if (ev.infra && ctx.state.infrastructure[ev.infra[0]]?.status === 'operational') ctx.emit('INFRA_STATUS', 'world', { infraId: ev.infra[0], status: ev.infra[1], cause: ev.text }, { targets: [ev.infra[0]] });
    if (ev.indicators) ctx.emit('INDICATORS_CHANGED', 'world', { delta: ev.indicators });
  }
}

/** Infrastrutture degradate tornano operative con il tempo (riparazioni civili). */
export function recoverInfrastructure(ctx: TurnCtx) {
  for (const i of Object.values(ctx.state.infrastructure)) {
    if (i.status === 'operational') continue;
    if (ctx.rng.chance(`ripristino ${i.id}`, i.status === 'degraded' ? 0.4 : 0.15).ok) ctx.emit('INFRA_STATUS', 'world', { infraId: i.id, status: i.status === 'offline' ? 'degraded' : 'operational', cause: 'riparazioni' }, { targets: [i.id] });
  }
}

export function checkRedLines(ctx: TurnCtx) {
  for (const f of Object.values(ctx.state.factions)) {
    for (const rl of f.redLines) {
      if (f.crossedRedLines.includes(rl.id) || !evaluate(ctx.state, rl.trigger)) continue;
      ctx.emit('RED_LINE_CROSSED', f.id, { redLineId: rl.id, text: rl.text, response: rl.response }, { visibility: [f.id] });
      ctx.emit('FACTION_CHANGED', f.id, { factionId: f.id, delta: { posture: -1 }, patch: { crossedRedLines: [...f.crossedRedLines, rl.id] } }, { visibility: [f.id] });
    }
  }
}
