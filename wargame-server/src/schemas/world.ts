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
export const AgentRole = z.enum(['faction_major', 'faction_minor', 'gm_narrator', 'intel_analyst', 'order_parser', 'reflection', 'repair', 'diplomat', 'strategist', 'chancery']);

export const Objective = z.object({ id: z.string(), text: z.string(), priority: z.union([z.literal(1), z.literal(2), z.literal(3)]), metric: z.string(), progress: z.number() });
export const RedLine = z.object({ id: z.string(), text: z.string(), trigger: z.string(), response: z.string() });
export const IsrAsset = z.object({
  id: z.string(),
  type: z.enum(['SAR_SAT', 'EO_SAT', 'AEW', 'MPA', 'MALE_DRONE', 'SIGINT', 'HUMINT_NET', 'OTH_RADAR']),
  coverage: z.array(ZoneId), revisitTurns: z.number().int().min(1), quality: z.number().min(0).max(1), tasking: ZoneId.nullable(),
});

/**
 * Profilo numerico del decisore a regole (engine/policy.ts) delle fazioni non giocate dall'umano: stesso profilo per tutte,
 * valori diversi. Ricavato da factions/*.md (stile, dottrina, propensione al rischio), obiettivi, linee rosse e basi.
 */
export const FactionPolicy = z.object({
  /** 0–1, propensione alla forza: da PARAMS.policy.forceAt in su risponde alle minacce con SHOW_OF_FORCE o SANCTION, sotto con DEMARCHE o BACKCHANNEL */
  aggressiveness: z.number().min(0).max(1),
  /** 0–1, escalation sopportata: alza la soglia da cui i profili poco aggressivi cercano la distensione in una crisi */
  riskTolerance: z.number().min(0).max(1),
  /** 0–1, propensione al cyber: probabilità per turno = cyberPropensity × cyber.offense / 10, solo verso avversari */
  cyberPropensity: z.number().min(0).max(1),
  /** conciliatory → BACKCHANNEL e lettere concilianti; formal → DEMARCHE e lettere formali; assertive → azioni e lettere più dure */
  diplomacyStyle: z.enum(['conciliatory', 'formal', 'assertive']),
  /** interesse 0–1 per zona (le zone assenti valgono 0): pesa crisi, obiettivi, alleati e il pattugliamento di routine */
  zoneInterests: z.record(ZoneId, z.number().min(0).max(1)),
  /** posture per zona al massimo per turno (0–4, come il tetto delle decisioni LLM) */
  maxStancesPerTurn: z.number().int().min(0).max(4),
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
  /** carica del capo di Stato/governo (mai un nome di persona), per intestazione e firma delle lettere */
  leaderTitle: z.string().default(''),
  /** città da cui si scrivono le lettere (es. «Roma, 9 marzo 2026») */
  capital: z.string().default(''),
  /** profilo del decisore a regole (assente per il giocatore e i blocchi; le campagne vecchie lo prendono dallo scenario in lettura) */
  policy: FactionPolicy.optional(),
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

/**
 * Modificatore dell'opinione (docs/wargame/DIPLOMAZIA.md §5.2): `opinion(from→to)` = base + Σ modificatori(from→to). Un'azione di A
 * verso B crea un modificatore su `opinion(B→A)`, cioè su come B vede A. `value` è il valore corrente (si riduce verso 0 con il
 * decadimento, un evento OPINION_DECAYED per turno); `decayPerWeek` 0 = finché dura la causa.
 */
export const OpinionModifier = z.object({
  id: z.string(), from: FactionId, to: FactionId,
  /** chiave della tabella PARAMS.opinion.modifiers («threat», «sanction», «history»…) */
  kind: z.string(), label: z.string(),
  value: z.number(), decayPerWeek: z.number().min(0).default(0),
  /** valore assoluto sotto cui non scende finché la causa è attiva (senza `expiresTurn`) */
  floor: z.number().optional(),
  expiresTurn: Turn.optional(),
  /** ordine, accordo o evento che l'ha causato */
  causeRef: z.string(),
  visibility: Visibility.default('public'),
  /** turno in cui è nato (per «i turni che mancano» nella scheda paese) */
  turn: Turn.default(0),
});
/**
 * Stato sparso della diplomazia: mai la matrice completa (con 197 Stati sarebbero ~39.000 coppie per snapshot).
 * - `modifiers`: tutti i modificatori d'opinione vivi;
 * - `tension`: tensione di coppia (simmetrica) solo per le coppie diverse dal fondo, chiave «A|B» con A < B;
 * - `tensionBase`: tensione strutturale delle coppie diverse dal predefinito (dallo scenario): il fondo verso cui la tensione torna.
 * La tensione mondiale sta in `globalIndicators.worldTension`. Gli altri campi del §5.5 (capitale, ricariche, ultimatum) arrivano col settore 09.
 */
/** Ultimatum con scadenza: alla scadenza `met` (il destinatario ha cercato la distensione) o `expired` (dà legittimità alla forza, tensione mondiale +5). */
export const Ultimatum = z.object({
  id: z.string(), from: FactionId, to: FactionId, demand: z.string(), issuedTurn: Turn, deadlineTurn: Turn,
  status: z.enum(['pending', 'met', 'expired']),
  /** il destinatario ha cercato la distensione (rassicurazione, canale riservato, lettera conciliante, accordo accettato) prima della scadenza */
  answered: z.boolean().optional(),
  /** per `expired`: fino a questo turno le azioni di forza di `from` contro `to` non pagano il costo di legittimità */
  legitimateUntil: Turn.optional(),
});
/** Risoluzione approvata da un'istituzione (dà legittimità a blocchi e zone di esclusione contro `target` finché non scade). */
export const Resolution = z.object({
  id: z.string(), forum: z.string(), institutionId: z.string(), subject: z.string(), topic: z.string(),
  proposer: FactionId, target: FactionId.optional(), turn: Turn, expiresTurn: Turn,
});
export const TieStatus = z.enum(['recalled', 'expelled', 'broken']);
export const Diplomacy = z.object({
  modifiers: z.array(OpinionModifier).default([]),
  tension: z.record(z.string(), z.number()).default({}),
  tensionBase: z.record(z.string(), z.number()).default({}),
  /** capitale diplomatico (CD) delle fazioni, tra 0 e il tetto (PARAMS.diplo.capital.cap): una rendita per turno, si spende nelle azioni */
  capital: z.record(FactionId, z.number()).default({}),
  /** ricariche per destinatario: chiave «attore|azione|destinatario» (o «rej|proponente|destinatario|tipo» per le proposte respinte) → primo turno in cui si può ripetere */
  cooldowns: z.record(z.string(), z.number()).default({}),
  /** «Migliorare le relazioni» in corso: ogni turno costa 1 CD e alza di 2 l'opinione di `target` verso `actor`, fino a +30 */
  improving: z.array(z.object({ actor: FactionId, target: FactionId, since: Turn })).default([]),
  ultimatums: z.array(Ultimatum).default([]),
  /** stato dei rapporti diplomatici di una coppia (chiave «A|B»): ambasciatore richiamato, diplomatici espulsi, relazioni rotte */
  ties: z.record(z.string(), TieStatus).default({}),
  /** embarghi sulle armi, «da>a» */
  embargoes: z.array(z.string()).default([]),
  resolutions: z.array(Resolution).default([]),
});

export const Agreement = z.object({
  id: z.string(),
  /**
   * Tipi nuovi (docs/wargame/DIPLOMAZIA.md §7): `non_aggression` (violato da un atto di forza tra le parti), `guarantee` (parties[0] è il garante,
   * le altre sono garantite: il garante risponde alle linee rosse del garantito), `military_access` (parties[0] concede l'accesso alle proprie zone),
   * `defense_cooperation` (cooperazione di difesa: conta come alleanza stretta se a ≤ 3 parti) e `trade`.
   */
  type: z.enum(['defense', 'energy', 'basing', 'migration', 'ceasefire', 'arms_sale', 'intel_sharing', 'secret', 'non_aggression', 'guarantee', 'military_access', 'defense_cooperation', 'trade']),
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
  globalIndicators: z.object({
    brentUsd: z.number(), ttfEurMwh: z.number(), medShippingRisk: z.number(), migrationPressure: z.number(),
    /** tensione mondiale 0–100 (engine/world-tension.ts): rende più facili o più costose le azioni gravi (docs/wargame/DIPLOMAZIA.md §6) */
    worldTension: z.number().default(30),
  }),
  /** opinione asimmetrica e tensione di coppia; assente nelle campagne precedenti (si riempie in lettura, store/migrations) */
  diplomacy: Diplomacy.optional(),
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
export type FactionPolicy = z.infer<typeof FactionPolicy>;
export type RedLine = z.infer<typeof RedLine>;
export type Unit = z.infer<typeof Unit>;
export type UnitType = z.infer<typeof UnitType>;
export type Base = z.infer<typeof Base>;
export type Infrastructure = z.infer<typeof Infrastructure>;
export type Zone = z.infer<typeof Zone>;
export type Relation = z.infer<typeof Relation>;
export type OpinionModifier = z.infer<typeof OpinionModifier>;
export type Diplomacy = z.infer<typeof Diplomacy>;
export type Ultimatum = z.infer<typeof Ultimatum>;
export type Resolution = z.infer<typeof Resolution>;
export type TieStatus = z.infer<typeof TieStatus>;
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
