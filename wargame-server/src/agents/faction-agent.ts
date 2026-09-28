import { z } from 'zod';
import type { AgentDecision, DecisionOutput as DecisionOutputT, FactionOrders, OrdersBody } from '../schemas/index.js';
import { DecisionOutput, DiploAction, Order, ProcurementOrder, PublicStatement } from '../schemas/index.js';
import type { DecideInput } from '../engine/turn-machine.js';
import { validateOrders } from '../engine/validators.js';
import { legalActions, memoryText, situation } from './context-builder.js';
import type { LlmCall } from '../schemas/index.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

/** Tetti per turno: i modelli piccoli a volte ripetono ordini all'infinito finché finiscono i token (JSON troncato). */
export const ORDER_CAPS = { military: 8, diplomacy: 4, procurement: 3, statements: 2, threats: 5, options: 4 } as const;
// schema inviato al modello: maxItems ferma la generazione (grammatica di Ollama/llama.cpp)
const DecisionForModel = DecisionOutput.extend({
  threats: DecisionOutput.shape.threats.unwrap().max(ORDER_CAPS.threats).default([]),
  optionsConsidered: DecisionOutput.shape.optionsConsidered.unwrap().max(ORDER_CAPS.options).default([]),
  orders: z.object({
    military: z.array(Order).max(ORDER_CAPS.military).default([]), diplomacy: z.array(DiploAction).max(ORDER_CAPS.diplomacy).default([]),
    procurement: z.array(ProcurementOrder).max(ORDER_CAPS.procurement).default([]), statements: z.array(PublicStatement).max(ORDER_CAPS.statements).default([]),
  }),
});
const DECISION_SCHEMA = z.toJSONSchema(DecisionForModel, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
/** in lettura si tagliano le liste troppo lunghe invece di scartare la risposta (provider senza grammatica) */
const cap = (n: number) => (v: unknown) => (Array.isArray(v) ? v.slice(0, n) : v);
const DecisionLenient = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const d = raw as Record<string, unknown>; const o = (d.orders ?? {}) as Record<string, unknown>;
  return { ...d, threats: cap(ORDER_CAPS.threats)(d.threats), optionsConsidered: cap(ORDER_CAPS.options)(d.optionsConsidered),
    orders: { ...o, military: cap(ORDER_CAPS.military)(o.military), diplomacy: cap(ORDER_CAPS.diplomacy)(o.diplomacy), procurement: cap(ORDER_CAPS.procurement)(o.procurement), statements: cap(ORDER_CAPS.statements)(o.statements) } };
}, DecisionOutput);

/** Id univoci e prefissati: gli LLM spesso ripetono "o1". */
function normalize(o: OrdersBody, factionId: string, turn: number): OrdersBody {
  let n = 0;
  const id = () => `${factionId}-${turn}-${++n}`;
  return {
    military: o.military.map((x) => ({ ...x, id: id() })), diplomacy: o.diplomacy.map((x) => ({ ...x, id: id() })),
    procurement: o.procurement.map((x) => ({ ...x, id: id() })), statements: o.statements.map((x) => ({ ...x, id: id() })),
  };
}

/** Toglie dal FORMATO del prompt i tipi di ordine che la fazione non può usare (i modelli piccoli copiano gli esempi). */
export function trimFormat(system: string, kinds: string[]): string {
  return system.split('\n').filter((l) => { const m = l.match(/^- ([A-Z_]+)(?:,|:)/); return !m || !['ISR', 'SOF_OP'].includes(m[1]!) || kinds.includes(m[1]!); }).join('\n');
}

/** Fallback dottrinale: ordini minimi coerenti con la postura, generati senza LLM. */
export function doctrineOrders(i: DecideInput): OrdersBody {
  const k = i.knowledge;
  const ship = k.ownUnits.find((u) => u.status === 'ready' && (u.type === 'frigate' || u.type === 'opv' || u.type === 'destroyer') && u.readiness >= 50);
  const worn = k.ownUnits.filter((u) => u.status === 'deployed' && u.readiness < 35).map((u) => u.id);
  const military: OrdersBody['military'] = [];
  if (ship && k.ownFaction.posture <= 3) military.push({ id: 'd1', kind: 'PATROL', unitIds: [ship.id], zoneId: ship.zoneId, roe: 'WEAPONS_TIGHT' });
  if (worn.length) military.push({ id: 'd2', kind: 'RETURN_TO_BASE', unitIds: worn });
  return normalize({ military, diplomacy: [], procurement: [], statements: [] }, i.factionId, k.turn);
}

/** Decisione senza IA (cadenza ridotta): ordini di dottrina, marcata come tale nel post-mortem. */
export function doctrineDecision(i: DecideInput, reason: string): AgentDecision {
  const k = i.knowledge;
  const role = k.ownFaction.agentRole === 'faction_major' ? 'faction_major' : 'faction_minor';
  return {
    schemaVersion: 1, id: `DEC-${k.turn}-${i.factionId}`, factionId: i.factionId, turn: k.turn, model: 'dottrina', role, promptHash: '',
    knowledgeRef: `knowledge/${i.factionId}/turn-${String(k.turn).padStart(4, '0')}.json`, memoryRef: `memory/${i.factionId}.json@${i.memory.updatedTurn}`,
    situationAssessment: reason, threats: [], optionsConsidered: [], privateIntent: 'mantenere la postura',
    orders: { schemaVersion: 1, factionId: i.factionId, turn: k.turn, source: 'fallback_doctrine', ...doctrineOrders(i) }, confidence: 0.3,
    validation: { valid: true, errors: [], repairAttempts: 0, fallbackUsed: false },
    usage: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
  };
}

export async function decide(provider: LlmProvider, log: LlmCall[], i: DecideInput): Promise<AgentDecision> {
  const k = i.knowledge;
  const f = k.ownFaction;
  const role = f.agentRole === 'faction_major' ? 'faction_major' : 'faction_minor';
  const cfg = i.campaign.config.llm[role];
  const legal = legalActions(k, i.scenario);
  const refs = new Set(k.contacts.map((c) => c.id));
  // Gli ordini impossibili (unità/asset/zone inesistenti, unità già impegnata…) vengono scartati uno per uno, come farebbe
  // uno stato maggiore, invece di buttare l'intera decisione e chiedere un «repair» al modello: restano nel registro.
  const dropped: string[] = [];
  const check = (d: DecisionOutputT) => {
    const errorsOf = () => validateOrders(i.state, i.scenario.catalog, i.factionId, normalize(d.orders, i.factionId, k.turn), refs, i.campaign.turnLength).errors;
    for (let pass = 0; pass < 3; pass++) {
      const errs = errorsOf();
      if (!errs.length) return [];
      const norm = normalize(d.orders, i.factionId, k.turn);
      const bad = new Set(errs.map((e) => e.split(':')[0]));
      const keep = <T>(list: T[], ids: { id: string }[]) => list.filter((_, j) => !bad.has(ids[j]!.id));
      const next = { military: keep(d.orders.military, norm.military), diplomacy: keep(d.orders.diplomacy, norm.diplomacy), procurement: keep(d.orders.procurement, norm.procurement), statements: keep(d.orders.statements, norm.statements) };
      const removed = Object.values(d.orders).flat().length - Object.values(next).flat().length;
      if (!removed) return errs; // errori non legati a un ordine (es. budget): serve il repair
      dropped.push(...errs.filter((e) => bad.has(e.split(':')[0]!)));
      d.orders = next;
    }
    return errorsOf();
  };
  const r = await callStructured(provider, log, { turn: k.turn, factionId: i.factionId }, {
    role, ...cfg,
    system: trimFormat(template('faction', { factionName: f.name, factionId: f.id, date: i.campaign.date, profile: i.profile }), legal.orderKinds),
    user: template('faction-user', { turn: String(k.turn), date: i.campaign.date, situation: JSON.stringify(situation(k)), memory: memoryText(i.memory), legal: JSON.stringify(legal) }),
    schemaName: 'AgentDecision', jsonSchema: DECISION_SCHEMA,
    meta: { factionId: i.factionId, turn: k.turn, seed: i.campaign.seed, legal, situation: situation(k), posture: f.posture },
  }, DecisionLenient, check);
  const out = r.value;
  const orders: FactionOrders = { schemaVersion: 1, factionId: i.factionId, turn: k.turn, source: out ? 'ai' : 'fallback_doctrine', ...(out ? normalize(out.orders, i.factionId, k.turn) : doctrineOrders(i)) };
  return {
    schemaVersion: 1, id: `DEC-${k.turn}-${i.factionId}`, factionId: i.factionId, turn: k.turn, model: r.model, role, promptHash: r.promptHash,
    knowledgeRef: `knowledge/${i.factionId}/turn-${String(k.turn).padStart(4, '0')}.json`, memoryRef: `memory/${i.factionId}.json@${i.memory.updatedTurn}`,
    situationAssessment: out?.situationAssessment ?? 'Fallback dottrinale: nessuna decisione valida dal modello.',
    threats: out?.threats ?? [], optionsConsidered: out?.optionsConsidered ?? [], privateIntent: out?.privateIntent ?? 'mantenere la postura',
    orders, confidence: out?.confidence ?? 0.2,
    validation: { valid: !!out, errors: [...dropped.map((e) => `scartato — ${e}`), ...r.errors], repairAttempts: r.repairAttempts, fallbackUsed: !out },
    usage: r.usage,
  };
}
