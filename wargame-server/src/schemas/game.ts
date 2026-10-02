import { z } from 'zod';
import { AgentRole, Agreement, Crisis, Domain, Faction, FactionId, LatLon, Reliability, TieStatus, Turn, Ultimatum, Unit, Visibility, ZoneId } from './world.js';
import { DiploAction, FactionOrders, OrdersBody, STANCES, ZoneStance } from './orders.js';

/** Fasce con cui si vede l'opinione degli altri verso di sé (docs/wargame/DIPLOMAZIA.md §5.6); le soglie sono in PARAMS.opinion.bands. */
export const OPINION_BANDS = ['ostile', 'fredda', 'neutra', 'cordiale', 'stretta'] as const;
export type OpinionBand = (typeof OPINION_BANDS)[number];

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
    llm: z.object({
      faction_major: LlmRoleConfig, faction_minor: LlmRoleConfig, gm_narrator: LlmRoleConfig, intel_analyst: LlmRoleConfig,
      order_parser: LlmRoleConfig, reflection: LlmRoleConfig, repair: LlmRoleConfig,
      /** facoltativo: le campagne create prima delle lettere usano il modello di faction_major */
      diplomat: LlmRoleConfig.optional(),
    }), maxConcurrentAgents: z.number().int().min(1),
    /**
     * chi decide le mosse delle fazioni non umane: `rules` = decisore a regole del motore (engine/policy.ts), `llm` = agenti LLM
     * per le fazioni con controller «ai». Si sceglie alla creazione (WARGAME_FACTION_MODE); assente nelle campagne vecchie
     * (vale WARGAME_FACTION_MODE del server).
     */
    factionMode: z.enum(['rules', 'llm']).optional(),
    /** il giocatore chiede CMO per ogni ingaggio che lo coinvolge, anche minore */
    cmoOnRequest: z.boolean().default(false),
    /**
     * Risparmio di chiamate LLM: le fazioni minori decidono con l'IA un turno ogni `minorEvery` (0 = mai, solo dottrina;
     * sfalsate tra loro) e ogni fazione aggiorna la memoria con l'IA un turno ogni `reflectEvery` (negli altri turni
     * un riassunto senza IA). 1/1 = tutto con l'IA a ogni turno.
     */
    agentCadence: z.object({
      minorEvery: z.number().int().min(0), reflectEvery: z.number().int().min(1),
      /** lettere IA «di iniziativa» per turno (le risposte alle lettere del giocatore non contano: una per fazione, sempre) */
      lettersPerTurn: z.number().int().min(0).default(3),
    }).default({ minorEvery: 1, reflectEvery: 1, lettersPerTurn: 3 }),
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
export const LetterTone = z.enum(['cordial', 'formal', 'firm', 'threatening', 'conciliatory']);
/** Lettera formale tra capi di Stato (indicati solo con la carica): salvata in letters/turn-N.jsonl. */
export const DiploLetter = z.object({
  id: z.string(), turn: Turn, date: z.string(), from: FactionId, to: FactionId,
  fromTitle: z.string(), toTitle: z.string(), place: z.string(),
  subject: z.string(), body: z.string(), tone: LetterTone, visibility: z.enum(['private', 'public']),
  inReplyTo: z.string().optional(),
  /** human = scritta (o rivista) dal giocatore; ai = scritta da un LLM; template = lettera-modello di ripiego */
  source: z.enum(['human', 'ai', 'template']), model: z.string().optional(),
});
export const NewsItem = z.object({ id: z.string(), turn: Turn, outlet: z.string(), outletFaction: FactionId, bias: z.number(), headline: z.string(), body: z.string(), zoneId: ZoneId.optional(), factsRef: z.array(z.string()) });

/**
 * Atto ostile o di pressione che la fazione ha visto nel turno precedente (eventi a lei visibili): minacce, sanzioni, blocchi,
 * scontri, strike, cyber e SOF attribuiti, dimostrazioni di forza, linee rosse superate. Lo usa il decisore a regole.
 */
export const INCIDENT_KINDS = ['threat', 'sanction', 'blockade', 'engagement', 'strike', 'cyber', 'sof', 'show_of_force', 'red_line', 'ultimatum'] as const;
export const Incident = z.object({
  turn: Turn, kind: z.enum(INCIDENT_KINDS), from: FactionId, to: FactionId,
  zoneId: ZoneId.optional(),
  /** id della linea rossa (red_line) o dell'ordine che ha causato l'atto */
  ref: z.string().optional(),
  /** per red_line: testo e risposta scritta della linea rossa (li vede anche il garante di chi l'ha vista superare) */
  text: z.string().optional(), response: z.string().optional(),
});

export const FactionKnowledge = z.object({
  schemaVersion: z.literal(1), factionId: FactionId, turn: Turn,
  ownUnits: z.array(Unit), ownFaction: Faction,
  contacts: z.array(Contact.omit({ truthUnitId: true }).strict()),
  intelReports: z.array(IntelReport),
  beliefs: z.record(FactionId, z.object({ estPosture: z.number(), estIntent: z.string(), confidence: z.number() })),
  knownCrises: z.array(Crisis), knownAgreements: z.array(Agreement),
  inbox: z.array(DiploMessage), publicNews: z.array(NewsItem),
  /** lettere ricevute e inviate negli ultimi 3 turni (solo quelle visibili alla fazione) */
  letters: z.array(DiploLetter).default([]),
  /** atti ostili o di pressione visti nel turno precedente (prima quelli che riguardano la fazione) */
  incidents: z.array(Incident).default([]),
  /** capitale diplomatico, ricariche, rapporti e ultimatum della fazione (la sua parte: mai quella degli altri) */
  diplomacy: z.object({
    capital: z.number(), rent: z.number(), improvingSlots: z.number().int(),
    /** 2 per le democrazie con tensione mondiale bassa (le azioni coercitive costano il doppio), altrimenti 1 */
    coerciveCost: z.number().default(1),
    improving: z.array(z.object({ target: FactionId, since: Turn })).default([]),
    /** «azione|destinatario» → primo turno in cui si può ripetere (solo ricariche ancora attive) */
    cooldowns: z.record(z.string(), z.number()).default({}),
    /** altra fazione → stato dei rapporti diplomatici con lei (richiamo, espulsione, rottura) */
    ties: z.record(FactionId, TieStatus).default({}),
    ultimatums: z.array(Ultimatum).default([]),
    embargoes: z.array(z.string()).default([]),
    /** proposte di trattato ricevute, con come risponderebbe il decisore a regole (punteggio e motivi di `acceptance`): suggerimento per il giocatore */
    proposals: z.array(z.object({ agreementId: z.string(), from: FactionId, type: z.string(), score: z.number(), accept: z.boolean(), reasons: z.array(z.object({ label: z.string(), value: z.number() })) })).default([]),
  }).optional(),
  /**
   * Come il mondo ha reagito (settore 10): le reazioni pubbliche degli Stati agli atti gravi di cui la fazione è attore o vittima, e le votazioni delle
   * istituzioni che la riguardano (proponente o bersaglio), del turno precedente. Solo conteggi e i cinque più popolosi: gli elenchi interi stanno
   * negli eventi pubblici.
   */
  world: z.object({
    reactions: z.array(z.object({ turn: Turn, eventId: z.string(), kind: z.string(), actor: FactionId, victim: FactionId, condemn: z.number().int(), support: z.number().int(), silent: z.number().int(), topCondemners: z.array(z.string()).default([]), topSupporters: z.array(z.string()).default([]) })).default([]),
    votes: z.array(z.object({ turn: Turn, forum: z.string(), subject: z.string(), proposer: FactionId, target: FactionId.optional(), passed: z.boolean(), yes: z.number().int(), no: z.number().int(), abstain: z.number().int() })).default([]),
  }).optional(),
  /**
   * L'opinione della fazione verso le altre (la sua riga: `trust` = opinionOf(lei → altra)) e la tensione di coppia. `opinionOfMe` è
   * come le altre la vedono, solo a fasce (ostile · fredda · neutra · cordiale · stretta); il numero esatto (`opinionOfMeExact`) solo
   * con un accordo di intelligence. Le coppie tra terzi non ci sono: si vedono solo dagli atti pubblici.
   */
  ownRelations: z.record(FactionId, z.object({ trust: z.number(), tension: z.number(), opinionOfMe: z.enum(OPINION_BANDS).optional(), opinionOfMeExact: z.number().optional() })).default({}),
});

export const EventType = z.enum(['UNIT_MOVED', 'UNIT_STATUS', 'CONTACT_DETECTED', 'CONTACT_LOST', 'ENGAGEMENT_OPENED', 'ENGAGEMENT_RESOLVED',
  'UNIT_DAMAGED', 'UNIT_DESTROYED', 'UNIT_CREATED', 'MUNITION_EXPENDED', 'DELIVERY_ARRIVED', 'PROCUREMENT_ORDERED',
  'BUDGET_CHANGED', 'RELATION_CHANGED', 'AGREEMENT_CHANGED', 'CRISIS_CHANGED', 'CYBER_EFFECT', 'SOF_RESULT', 'DIPLO_MESSAGE',
  'INFRA_STATUS', 'RANDOM_EVENT', 'RED_LINE_CROSSED', 'FACTION_CHANGED', 'INDICATORS_CHANGED', 'TURN_ADVANCED', 'TURN_CLOSED', 'STATEMENT', 'LETTER_SENT',
  // diplomazia asimmetrica (RELATION_CHANGED resta leggibile per le campagne vecchie e il replay, ma non si emette più)
  'OPINION_MODIFIER', 'OPINION_DECAYED', 'TENSION_CHANGED', 'WORLD_TENSION_CHANGED',
  // capitale diplomatico, stato dei rapporti, ultimatum e votazioni delle istituzioni (settore 09)
  'CAPITAL_CHANGED', 'DIPLOMACY_CHANGED', 'ULTIMATUM_MET', 'ULTIMATUM_EXPIRED', 'INSTITUTION_VOTE',
  // IA mondiale (settore 10): reazioni degli Stati a un evento grave (un evento aggregato) e sanzioni di blocco
  'INTERNATIONAL_REACTIONS']);
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

/**
 * Direttiva strategica (docs/wargame/DIPLOMAZIA.md §11): intenzioni di una potenza per i prossimi turni. Oggi il decisore a regole riceve sempre
 * quella deterministica (nessuna priorità, nessun effetto); il settore 11 la farà proporre a un LLM. Con tetti: è il motore a limitarla.
 */
export const DIRECTIVE_KINDS = ['improve', 'court', 'deter', 'isolate', 'contain'] as const;
export const Directive = z.object({
  horizonTurns: z.number().int().min(3).max(6),
  priorities: z.array(z.object({ kind: z.enum(DIRECTIVE_KINDS), target: FactionId, weight: z.number().min(0).max(1) })).max(4).default([]),
  zoneInterestDelta: z.record(ZoneId, z.number().min(-0.2).max(0.2)).refine((o) => Object.keys(o).length <= 3, 'al massimo 3 zone').default({}),
  seekAgreements: z.array(z.object({ type: Agreement.shape.type, with: FactionId })).max(2).default([]),
  avoid: z.array(FactionId).max(2).default([]),
  rationale: z.string().max(420).default(''),
});

/** Atti gravi del turno che gli Stati del mondo vedono (engine/world-digest.ts) e a cui reagiscono. */
export const GRAVE_KINDS = ['strike', 'engagement', 'blockade', 'ultimatum', 'sanction', 'multilateral_sanction', 'break', 'embargo', 'cyber', 'covert'] as const;
export const GraveEvent = z.object({
  id: z.string(), kind: z.enum(GRAVE_KINDS), a: z.string(), b: z.string(), severity: z.number(), turn: Turn, zoneId: ZoneId.optional(), text: z.string(),
});
/** Reazione di tutti gli Stati a un evento grave: tre elenchi di ISO3 e i modificatori (aggregati, con un tetto) che ne derivano. */
export const Reaction = z.object({
  eventId: z.string(), kind: z.enum(GRAVE_KINDS), actor: z.string(), victim: z.string(), severity: z.number(), zoneId: ZoneId.optional(),
  /** contro chi ha compiuto l'atto · con lui · in silenzio */
  condemn: z.array(z.string()), support: z.array(z.string()), silent: z.array(z.string()),
  modifiers: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string(), value: z.number() })),
});
/** Una votazione che gli Stati del mondo conoscono (la decisione di un'istituzione: pubblica) */
export const DigestVote = z.object({
  id: z.string(), turn: Turn, forum: z.string(), institutionId: z.string(), proposer: z.string(), target: z.string().optional(), topic: z.string(), subject: z.string(),
  passed: z.boolean(), yes: z.array(z.string()), no: z.array(z.string()), abstain: z.array(z.string()),
});
export const WorldRationale = z.object({ rule: z.enum(['reaction', 'block_sanction', 'agenda', 'letter', 'cap']), actor: z.string().optional(), text: z.string() });
/** Le decisioni del livello C di un turno: un solo file per turno (`decisions/turn-N/_world.json`), mai uno per Stato. */
export const WorldDecision = z.object({
  schemaVersion: z.literal(1), turn: Turn,
  digest: z.object({ events: z.array(GraveEvent), votes: z.array(DigestVote) }),
  /** azioni dell'agenda lenta e lettere: `actor` è l'ISO3 dello Stato (non ha CD: l'agenda è a tetto) */
  actions: z.array(z.object({ actor: z.string(), action: DiploAction })),
  reactions: z.array(Reaction),
  /** sanzioni di blocco: gli Stati che si adeguano a una risoluzione con sanzioni e quelli che no */
  blockSanctions: z.array(z.object({ voteId: z.string(), target: z.string(), adopters: z.array(z.string()), holdouts: z.array(z.string()) })).default([]),
  rationale: z.array(WorldRationale),
  /** lettere scritte nel turno dagli Stati del mondo al giocatore */
  letters: z.array(z.object({ actionId: z.string(), actor: z.string(), to: z.string(), kind: z.enum(['reply', 'initiative']), trigger: z.string().optional(), inReplyTo: z.string().optional(), source: z.enum(['ai', 'template']), model: z.string(), errors: z.array(z.string()) })).default([]),
  /** quanti Stati toccava all'agenda, quante azioni candidate e quante tagliate dal tetto globale */
  stats: z.object({ eligible: z.number().int(), candidates: z.number().int(), capped: z.number().int() }),
});

/** Regole del decisore a regole (engine/policy.ts), in ordine di priorità: servono alle motivazioni e alle statistiche. */
export const POLICY_RULES = ['worn', 'red_line', 'threat', 'crisis', 'detente', 'objective', 'ally', 'relations', 'cyber', 'agreement', 'routine', 'withdraw'] as const;
export const Rationale = z.object({ rule: z.enum(POLICY_RULES), text: z.string() });

export const DecisionOutput = z.object({
  situationAssessment: z.string(),
  threats: z.array(z.object({ factionId: FactionId, level: z.number(), rationale: z.string() })).default([]),
  optionsConsidered: z.array(z.object({ label: z.string(), summary: z.string(), expectedGain: z.number(), risk: z.number(), chosen: z.boolean() })).default([]),
  privateIntent: z.string(),
  /** posture per zona (modo principale per le IA di usare le forze): il motore le traduce in ordini militari (engine/stances.ts) */
  zoneStances: z.array(ZoneStance).default([]),
  orders: OrdersBody,
  confidence: z.number().min(0).max(1),
  /** lettere che la fazione vuole scrivere (max 1 per le minori, 2 per le maggiori): il testo lo scrive poi il ruolo diplomat */
  letterIntents: z.array(z.object({ to: FactionId, gist: z.string(), tone: LetterTone })).default([]),
  /** motivazioni brevi in italiano del decisore a regole, una per scelta (costruite da modelli di frase, senza LLM); vuoto per l'LLM */
  rationale: z.array(Rationale).default([]),
});
export const AgentDecision = DecisionOutput.omit({ orders: true }).extend({
  schemaVersion: z.literal(1), id: z.string(), factionId: FactionId, turn: Turn,
  model: z.string(), role: AgentRole, promptHash: z.string(), knowledgeRef: z.string(), memoryRef: z.string(),
  orders: FactionOrders,
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()), repairAttempts: z.number(), fallbackUsed: z.boolean() }),
  /** da dove viene ogni ordine militare generato dal motore: una postura per zona o il rientro delle unità logorate ('worn') */
  stanceOrders: z.array(z.object({ orderId: z.string(), stance: z.enum([...STANCES, 'worn']), zoneId: ZoneId.nullable() })).default([]),
  /** direttiva strategica che ha guidato la decisione (facoltativa: oggi sempre la deterministica, cioè nessuna) */
  directive: Directive.optional(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), latencyMs: z.number() }),
  /** lettere scritte nel turno (risposte e iniziative): il testo è negli ordini (azioni LETTER), qui l'esito della scrittura */
  letters: z.array(z.object({
    actionId: z.string(), to: FactionId, kind: z.enum(['reply', 'initiative']), inReplyTo: z.string().optional(),
    /** iniziativa innescata dal motore (minaccia, blocco, sanzione, ingaggio, tensione, accordo) invece che da letterIntents */
    trigger: z.enum(['threat', 'blockade', 'sanction', 'engagement', 'tension', 'agreement']).optional(),
    source: z.enum(['ai', 'template']), model: z.string(), errors: z.array(z.string()),
  })).default([]),
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
export type LetterTone = z.infer<typeof LetterTone>;
export type DiploLetter = z.infer<typeof DiploLetter>;
export type FactionKnowledge = z.infer<typeof FactionKnowledge>;
export type EventType = z.infer<typeof EventType>;
export type GameEvent = z.infer<typeof GameEvent>;
export type DiceRoll = z.infer<typeof DiceRoll>;
export type DecisionOutput = z.infer<typeof DecisionOutput>;
export type Incident = z.infer<typeof Incident>;
export type Rationale = z.infer<typeof Rationale>;
export type PolicyRule = (typeof POLICY_RULES)[number];
export type AgentDecision = z.infer<typeof AgentDecision>;
export type Directive = z.infer<typeof Directive>;
export type GraveEvent = z.infer<typeof GraveEvent>;
export type Reaction = z.infer<typeof Reaction>;
export type DigestVote = z.infer<typeof DigestVote>;
export type WorldDecision = z.infer<typeof WorldDecision>;
export type AgentMemory = z.infer<typeof AgentMemory>;
export type LlmCall = z.infer<typeof LlmCall>;
export type NarrativeDoc = z.infer<typeof NarrativeDoc>;
export type TurnNarrative = z.infer<typeof TurnNarrative>;
