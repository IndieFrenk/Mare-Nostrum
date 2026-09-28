import { z } from 'zod';
import type { AgentDecision, DecisionOutput as DecisionOutputT, FactionOrders, OrdersBody } from '../schemas/index.js';
import { DecisionOutput } from '../schemas/index.js';
import type { DecideInput } from '../engine/turn-machine.js';
import { validateOrders } from '../engine/validators.js';
import { legalActions, memoryText, situation } from './context-builder.js';
import type { LlmCall } from '../schemas/index.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

const DECISION_SCHEMA = z.toJSONSchema(DecisionOutput, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

/** Id univoci e prefissati: gli LLM spesso ripetono "o1". */
function normalize(o: OrdersBody, factionId: string, turn: number): OrdersBody {
  let n = 0;
  const id = () => `${factionId}-${turn}-${++n}`;
  return {
    military: o.military.map((x) => ({ ...x, id: id() })), diplomacy: o.diplomacy.map((x) => ({ ...x, id: id() })),
    procurement: o.procurement.map((x) => ({ ...x, id: id() })), statements: o.statements.map((x) => ({ ...x, id: id() })),
  };
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
  const check = (d: DecisionOutputT) => validateOrders(i.state, i.scenario.catalog, i.factionId, normalize(d.orders, i.factionId, k.turn), refs, i.campaign.turnLength).errors;
  const r = await callStructured(provider, log, { turn: k.turn, factionId: i.factionId }, {
    role, ...cfg,
    system: template('faction', { factionName: f.name, factionId: f.id, date: i.campaign.date, profile: i.profile }),
    user: template('faction-user', { turn: String(k.turn), date: i.campaign.date, situation: JSON.stringify(situation(k)), memory: memoryText(i.memory), legal: JSON.stringify(legal) }),
    schemaName: 'AgentDecision', jsonSchema: DECISION_SCHEMA,
    meta: { factionId: i.factionId, turn: k.turn, seed: i.campaign.seed, legal, situation: situation(k), posture: f.posture },
  }, DecisionOutput, check);
  const out = r.value;
  const orders: FactionOrders = { schemaVersion: 1, factionId: i.factionId, turn: k.turn, source: out ? 'ai' : 'fallback_doctrine', ...(out ? normalize(out.orders, i.factionId, k.turn) : doctrineOrders(i)) };
  return {
    schemaVersion: 1, id: `DEC-${k.turn}-${i.factionId}`, factionId: i.factionId, turn: k.turn, model: r.model, role, promptHash: r.promptHash,
    knowledgeRef: `knowledge/${i.factionId}/turn-${String(k.turn).padStart(4, '0')}.json`, memoryRef: `memory/${i.factionId}.json@${i.memory.updatedTurn}`,
    situationAssessment: out?.situationAssessment ?? 'Fallback dottrinale: nessuna decisione valida dal modello.',
    threats: out?.threats ?? [], optionsConsidered: out?.optionsConsidered ?? [], privateIntent: out?.privateIntent ?? 'mantenere la postura',
    orders, confidence: out?.confidence ?? 0.2,
    validation: { valid: !!out, errors: r.errors, repairAttempts: r.repairAttempts, fallbackUsed: !out },
    usage: r.usage,
  };
}
