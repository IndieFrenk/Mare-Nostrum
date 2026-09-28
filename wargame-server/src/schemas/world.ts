import { z } from 'zod';

export const FactionId = z.string().min(2);
export const ZoneId = z.string();
export const Turn = z.number().int().min(0);
export const MEur = z.number();
export const LatLon = z.object({ lat: z.number(), lon: z.number() });
export const Visibility = z.union([z.literal('public'), z.array(FactionId)]);
export const Reliability = z.string().regex(/^[A-F][1-6]$/);
export const Roe = z.enum(['WEAPONS_HOLD', 'WEAPONS_TIGHT', 'WEAPONS_FREE']);

export const UnitType = z.enum(['carrier', 'lhd', 'destroyer', 'frigate', 'opv', 'submarine', 'fighter_sqn', 'strike_sqn', 'aew', 'mpa', 'drone_flight', 'sam_battery', 'ground_bn', 'sof_team', 'tanker', 'transport']);
export const Domain = z.enum(['sea', 'subsurface', 'air', 'land', 'space', 'cyber']);
export const UnitStatus = z.enum(['ready', 'deployed', 'transit', 'maintenance', 'damaged', 'destroyed']);
export const AgentRole = z.enum(['faction_major', 'faction_minor', 'gm_narrator', 'intel_analyst', 'order_parser', 'reflection', 'repair']);

export const Objective = z.object({ id: z.string(), text: z.string(), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]), metric: z.string(), progress: z.number() });
export const RedLine = z.object({ id: z.string(), text: z.string(), trigger: z.string(), response: z.string() });
export const IsrAsset = z.object({
  id: z.string(),
  type: z.enum(['SAR_SAT', 'EO_SAT', 'AEW', 'MPA', 'MALE_DRONE', 'SIGINT', 'HUMINT_NET', 'OTH_RADAR']),
  coverage: z.array(ZoneId), revisitTurns: z.number().int().min(1), quality: z.number().min(0).max(1), tasking: ZoneId.nullable(),
});

export const Faction = z.object({
  id: FactionId, name: z.string(), kind: z.enum(['state', 'bloc', 'nonstate']),
  controller: z.enum(['human', 'ai', 'scripted']), agentRole: AgentRole.nullable(), profileRef: z.string(),
  posture: z.number().int().min(1).max(5),
  budget: z.object({ discretionary: MEur, perTurnIncome: MEur }),
  stocks: z.record(z.string(), z.number()),
  stability: z.number(), credibility: z.number(),
  objectives: z.array(Objective), redLines: z.array(RedLine), isrAssets: z.array(IsrAsset),
  cyber: z.object({ offense: z.number(), defense: z.number() }),
  alliances: z.array(z.string()),
  crossedRedLines: z.array(z.string()).default([]),
});

export const Sensor = z.object({ type: z.enum(['radar', 'sonar', 'esm', 'eo']), rangeKm: z.number(), quality: z.number() });
export const Signature = z.object({ radar: z.number(), acoustic: z.number(), ir: z.number(), emcon: z.boolean() });

// Order is declared in orders.ts; Unit.currentTask stays loose here to avoid a cycle.
export const Unit = z.object({
  id: z.string(), factionId: FactionId, name: z.string(), classId: z.string(),
  type: UnitType, domain: Domain, count: z.number().int().min(0),
  homeBaseId: z.string(), location: LatLon, zoneId: ZoneId,
  status: UnitStatus, readiness: z.number(), damage: z.number(), usageHours: z.number(),
  loadout: z.record(z.string(), z.number()), signature: Signature, sensors: z.array(Sensor),
  currentTask: z.record(z.string(), z.unknown()).nullable(),
  opCostPerTurn: MEur,
  estimated: z.boolean().optional(),
});

export const Base = z.object({ id: z.string(), name: z.string(), factionId: FactionId, location: LatLon, type: z.enum(['naval', 'air', 'joint']), capacity: z.number(), damage: z.number(), zoneId: ZoneId });
export const Infrastructure = z.object({
  id: z.string(), name: z.string(),
  type: z.enum(['pipeline', 'subsea_cable', 'lng_terminal', 'oil_field', 'gas_field', 'port', 'chokepoint']),
  owners: z.array(FactionId), geometryRef: z.string(), zoneId: ZoneId,
  status: z.enum(['operational', 'degraded', 'offline']), strategicValue: z.number(), flowShareIta: z.number().optional(),
});
export const Zone = z.object({ id: ZoneId, name: z.string(), terrain: z.enum(['sea', 'land']).default('sea'), polygonRef: z.string(), center: LatLon, seaState: z.number(), weatherSeed: z.number(), controlledBy: FactionId.nullable(), tension: z.number() });

export const Relation = z.object({ trust: z.number(), tension: z.number(), tradeDependency: z.number(), lastIncidentTurn: Turn.nullable(), notes: z.array(z.string()) });
export const RelationMatrix = z.record(FactionId, z.record(FactionId, Relation));

export const Agreement = z.object({
  id: z.string(), type: z.enum(['defense', 'energy', 'basing', 'migration', 'ceasefire', 'arms_sale', 'intel_sharing', 'secret']),
  parties: z.array(FactionId), terms: z.string(), startTurn: Turn, endTurn: Turn.nullable(),
  visibility: Visibility, status: z.enum(['proposed', 'active', 'violated', 'expired']),
});

export const Crisis = z.object({
  id: z.string(), title: z.string(), type: z.enum(['maritime', 'energy', 'migration', 'hybrid', 'terror', 'civil_war', 'interstate']),
  zoneIds: z.array(ZoneId), involved: z.array(FactionId), escalation: z.number().min(0).max(10),
  status: z.enum(['latent', 'active', 'frozen', 'resolved']), startedTurn: Turn,
  history: z.array(z.object({ turn: Turn, delta: z.number(), cause: z.string() })),
});

export const PendingDelivery = z.object({ id: z.string(), factionId: FactionId, itemId: z.string(), qty: z.number(), orderedTurn: Turn, deliveryTurn: Turn, totalCost: MEur, destinationBaseId: z.string() });

export const CmoPackage = z.object({
  engagementId: z.string(), headline: z.literal('RISOLUZIONE SU CMO RICHIESTA'),
  playerForces: z.array(z.object({ unitId: z.string(), name: z.string(), classId: z.string(), loadout: z.record(z.string(), z.number()), readiness: z.number() })),
  enemyOobEstimate: z.array(z.object({ classification: z.string(), estCount: z.tuple([z.number(), z.number()]), confidence: z.number(), notes: z.string() })),
  environment: z.object({ date: z.string(), timeWindowUtc: z.string(), seaState: z.number(), visibilityKm: z.number(), wind: z.string(), clouds: z.string(), ducting: z.boolean() }),
  roe: Roe, objectives: z.array(z.string()), constraints: z.array(z.string()),
  suggestedScenarioArea: z.object({ center: LatLon, radiusKm: z.number() }),
});
export const AfterActionReport = z.object({
  submittedAt: z.string(),
  ownLosses: z.array(z.object({ unitId: z.string(), newStatus: UnitStatus, damage: z.number(), aircraftLost: z.number().optional() })),
  munitionsExpended: z.record(z.string(), z.number()),
  enemyClaims: z.array(z.object({ classification: z.string(), result: z.enum(['destroyed', 'damaged', 'withdrew']) })),
  outcome: z.enum(['victory', 'draw', 'defeat']), notes: z.string(),
});
export const Engagement = z.object({
  id: z.string(), turn: Turn, zoneId: ZoneId, location: LatLon,
  sides: z.array(z.object({ factionId: FactionId, unitIds: z.array(z.string()) })),
  scale: z.enum(['minor', 'major']), resolution: z.enum(['auto', 'cmo']), status: z.enum(['pending_cmo', 'resolved']),
  cmoPackage: CmoPackage.optional(), aar: AfterActionReport.optional(),
  autoResult: z.object({ rollIds: z.array(z.string()), summary: z.string() }).optional(),
  enemyLossesConfirmed: z.array(z.object({ classification: z.string(), status: z.enum(['destroyed', 'damaged', 'intact']) })).optional(),
});

export const WorldState = z.object({
  schemaVersion: z.literal(1), turn: Turn, date: z.string(), rngCursor: z.number().int().default(0),
  factions: z.record(FactionId, Faction), units: z.record(z.string(), Unit), bases: z.record(z.string(), Base),
  infrastructure: z.record(z.string(), Infrastructure), zones: z.record(ZoneId, Zone), relations: RelationMatrix,
  crises: z.record(z.string(), Crisis), agreements: z.record(z.string(), Agreement),
  pendingDeliveries: z.array(PendingDelivery), engagements: z.record(z.string(), Engagement),
  globalIndicators: z.object({ brentUsd: z.number(), ttfEurMwh: z.number(), medShippingRisk: z.number(), migrationPressure: z.number() }),
});

export const LedgerEntry = z.object({
  turn: Turn, factionId: FactionId,
  category: z.enum(['operations', 'procurement', 'repair', 'intel', 'diplomacy', 'income', 'penalty', 'other']),
  amount: MEur, balanceAfter: MEur, ref: z.string(), note: z.string(),
});
export const CatalogItem = z.object({
  id: z.string(), name: z.string(), kind: z.enum(['munition_lot', 'platform']),
  lotSize: z.number().optional(), munitionId: z.string().optional(), cost: MEur,
  leadTimeTurns: z.number().nullable(), repairCostRange: z.tuple([z.number(), z.number()]).optional(),
  compatibleWith: z.array(z.string()).optional(), platformClassId: z.string().optional(),
});

export type FactionId = z.infer<typeof FactionId>;
export type LatLon = z.infer<typeof LatLon>;
export type Visibility = z.infer<typeof Visibility>;
export type Roe = z.infer<typeof Roe>;
export type AgentRole = z.infer<typeof AgentRole>;
export type Faction = z.infer<typeof Faction>;
export type Unit = z.infer<typeof Unit>;
export type Base = z.infer<typeof Base>;
export type Infrastructure = z.infer<typeof Infrastructure>;
export type Zone = z.infer<typeof Zone>;
export type Relation = z.infer<typeof Relation>;
export type Agreement = z.infer<typeof Agreement>;
export type Crisis = z.infer<typeof Crisis>;
export type PendingDelivery = z.infer<typeof PendingDelivery>;
export type CmoPackage = z.infer<typeof CmoPackage>;
export type AfterActionReport = z.infer<typeof AfterActionReport>;
export type Engagement = z.infer<typeof Engagement>;
export type WorldState = z.infer<typeof WorldState>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export type CatalogItem = z.infer<typeof CatalogItem>;
export type ZoneId = z.infer<typeof ZoneId>;
