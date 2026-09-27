import { z } from 'zod';
import { AgentRole, Agreement, Crisis, Domain, Faction, FactionId, LatLon, Reliability, Turn, Unit, Visibility, ZoneId } from './world.js';
import { FactionOrders, OrdersBody } from './orders.js';

export const TurnPhase = z.enum(['OPEN', 'INTEL', 'BRIEFING', 'PLAYER_ORDERS', 'AI_DECISIONS', 'ADJUDICATION', 'CMO_PENDING', 'DEBRIEF', 'CLOSED']);
export const LlmRoleConfig = z.object({ model: z.string(), temperature: z.number(), maxTokens: z.number(), timeoutMs: z.number() });

export const Campaign = z.object({
  schemaVersion: z.literal(1), id: z.string(), name: z.string(), scenarioId: z.string(),
  seed: z.string(), rngCursor: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  currentTurn: Turn, phase: TurnPhase, date: z.string(), turnLength: z.enum(['week', 'month']),
  playerFaction: z.literal('ITA'),
  parent: z.object({ campaignId: z.string(), turn: Turn }).nullable(),
  status: z.enum(['active', 'ended']),
  config: z.object({
    fogLevel: z.enum(['realistic', 'relaxed', 'none']), debugGodView: z.boolean(),
    cmoThreshold: z.object({ majorShips: z.number(), aircraftPerSide: z.number(), missileSalvo: z.number() }),
    llm: z.record(AgentRole, LlmRoleConfig), maxConcurrentAgents: z.number().int().min(1),
  }),
});

const Source = z.enum(['radar', 'sar', 'eo', 'sigint', 'humint', 'ais', 'sonar', 'osint']);
export const Contact = z.object({
  id: z.string(), firstSeenTurn: Turn, lastSeenTurn: Turn, domain: Domain, classification: z.string(),
  estFaction: z.string(), confidence: z.number(), location: LatLon, errorKm: z.number(),
  estCount: z.tuple([z.number(), z.number()]).optional(), sources: z.array(Source),
  zoneId: ZoneId.optional(),
  truthUnitId: z.string().optional(),
});
export const IntelReport = z.object({
  id: z.string(), turn: Turn, source: Source, reliability: Reliability,
  classification: z.enum(['NS', 'NR', 'NC', 'NS-SEGRETO']), title: z.string(), body: z.string(),
  relatedContacts: z.array(z.string()), factsRef: z.array(z.string()),
});
export const DiploMessage = z.object({ id: z.string(), turn: Turn, from: FactionId, to: FactionId, channel: z.enum(['official', 'backchannel']), text: z.string(), actionRef: z.string().optional() });
export const NewsItem = z.object({ id: z.string(), turn: Turn, outlet: z.string(), outletFaction: FactionId, bias: z.number(), headline: z.string(), body: z.string(), zoneId: ZoneId.optional(), factsRef: z.array(z.string()) });

export const FactionKnowledge = z.object({
  schemaVersion: z.literal(1), factionId: FactionId, turn: Turn,
  ownUnits: z.array(Unit), ownFaction: Faction,
  contacts: z.array(Contact.omit({ truthUnitId: true }).strict()),
  intelReports: z.array(IntelReport),
  beliefs: z.record(FactionId, z.object({ estPosture: z.number(), estIntent: z.string(), confidence: z.number() })),
  knownCrises: z.array(Crisis), knownAgreements: z.array(Agreement),
  inbox: z.array(DiploMessage), publicNews: z.array(NewsItem),
});

export const EventType = z.enum(['UNIT_MOVED', 'UNIT_STATUS', 'CONTACT_DETECTED', 'CONTACT_LOST', 'ENGAGEMENT_OPENED', 'ENGAGEMENT_RESOLVED',
  'UNIT_DAMAGED', 'UNIT_DESTROYED', 'UNIT_CREATED', 'MUNITION_EXPENDED', 'DELIVERY_ARRIVED', 'PROCUREMENT_ORDERED',
  'BUDGET_CHANGED', 'RELATION_CHANGED', 'AGREEMENT_CHANGED', 'CRISIS_CHANGED', 'CYBER_EFFECT', 'SOF_RESULT', 'DIPLO_MESSAGE',
  'INFRA_STATUS', 'RANDOM_EVENT', 'RED_LINE_CROSSED', 'FACTION_CHANGED', 'INDICATORS_CHANGED', 'TURN_ADVANCED', 'TURN_CLOSED', 'STATEMENT']);
export const GameEvent = z.object({
  id: z.string(), turn: Turn, seq: z.number().int(), phase: TurnPhase, type: EventType,
  actor: z.string(), targets: z.array(z.string()), payload: z.record(z.string(), z.unknown()),
  visibility: Visibility,
  causedBy: z.object({ orderId: z.string().optional(), decisionId: z.string().optional(), rollId: z.string().optional() }).nullable(),
});
export const DiceRoll = z.object({
  id: z.string(), turn: Turn, rngIndex: z.number().int(), purpose: z.string(), formula: z.string(),
  modifiers: z.array(z.object({ name: z.string(), value: z.number() })),
  raw: z.array(z.number()), total: z.number(), threshold: z.number().optional(), outcome: z.string(),
});

export const DecisionOutput = z.object({
  situationAssessment: z.string(),
  threats: z.array(z.object({ factionId: FactionId, level: z.number(), rationale: z.string() })).default([]),
  optionsConsidered: z.array(z.object({ label: z.string(), summary: z.string(), expectedGain: z.number(), risk: z.number(), chosen: z.boolean() })).default([]),
  privateIntent: z.string(),
  orders: OrdersBody,
  confidence: z.number().min(0).max(1),
});
export const AgentDecision = DecisionOutput.omit({ orders: true }).extend({
  schemaVersion: z.literal(1), id: z.string(), factionId: FactionId, turn: Turn,
  model: z.string(), role: AgentRole, promptHash: z.string(), knowledgeRef: z.string(), memoryRef: z.string(),
  orders: FactionOrders,
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()), repairAttempts: z.number(), fallbackUsed: z.boolean() }),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), latencyMs: z.number() }),
});
export const AgentMemory = z.object({
  schemaVersion: z.literal(1), factionId: FactionId, updatedTurn: Turn,
  strategicGoals: z.array(z.string()),
  commitments: z.array(z.object({ turn: Turn, to: FactionId, promise: z.string(), kept: z.boolean().nullable() })),
  grievances: z.array(z.object({ turn: Turn, against: FactionId, text: z.string(), weight: z.number() })),
  lessons: z.array(z.string()).max(10),
  relationshipNotes: z.record(FactionId, z.string()),
  rollingSummary: z.string(),
});
export const LlmCall = z.object({
  id: z.string(), turn: Turn, role: AgentRole, factionId: FactionId.optional(), model: z.string(), promptHash: z.string(),
  request: z.unknown(), response: z.unknown(), ok: z.boolean(), error: z.string().optional(),
  tokens: z.object({ in: z.number(), out: z.number() }), latencyMs: z.number(),
});

const Section = z.object({ heading: z.string(), body: z.string() });
export const BRIEFING_HEADINGS = ['Quadro strategico', 'Tracce e movimenti', 'Allarmi intelligence', 'Energia e rotte', 'Stato FOED e prontezza'] as const;
export const NarrativeDoc = z.object({ title: z.string(), sections: z.array(Section), factsRef: z.array(z.string()) });
export const TurnNarrative = z.object({
  turn: Turn,
  briefing: NarrativeDoc.extend({ sections: z.array(Section.extend({ heading: z.enum(BRIEFING_HEADINGS) })) }),
  debriefing: NarrativeDoc.optional(),
  news: z.array(NewsItem),
});

export type TurnPhase = z.infer<typeof TurnPhase>;
export type Campaign = z.infer<typeof Campaign>;
export type Contact = z.infer<typeof Contact>;
export type IntelReport = z.infer<typeof IntelReport>;
export type DiploMessage = z.infer<typeof DiploMessage>;
export type NewsItem = z.infer<typeof NewsItem>;
export type FactionKnowledge = z.infer<typeof FactionKnowledge>;
export type EventType = z.infer<typeof EventType>;
export type GameEvent = z.infer<typeof GameEvent>;
export type DiceRoll = z.infer<typeof DiceRoll>;
export type DecisionOutput = z.infer<typeof DecisionOutput>;
export type AgentDecision = z.infer<typeof AgentDecision>;
export type AgentMemory = z.infer<typeof AgentMemory>;
export type LlmCall = z.infer<typeof LlmCall>;
export type NarrativeDoc = z.infer<typeof NarrativeDoc>;
export type TurnNarrative = z.infer<typeof TurnNarrative>;
