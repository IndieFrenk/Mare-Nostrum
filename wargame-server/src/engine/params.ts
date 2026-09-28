/** Tutti i parametri di risoluzione (sezione 8.4). */
export const PARAMS = {
  hoursPerTurn: { week: 168, month: 720 },
  opCostMultiplier: { week: 1, month: 4 },
  sortieCost: { STRIKE: 4, ISR: 1, SOF_OP: 3, CYBER_OP: 2 },
  speedKts: { slow: 12, cruise: 18, flank: 28 },
  usage: { deployedHours: 120, wearThreshold: 1500, breakdownChance: 0.15 },
  readiness: { decayDeployed: 4, recoverAtBase: 8, recoverRepair: 20, min: 10 },
  repair: { damagePerTurn: 35, costPerPoint: 0.6 },
  industrialAvailability: 0.8,
  industrialPenaltyRepeat: 0.2,
  detection: { base: 0.25, sigWeight: 0.7, subsurfacePenalty: 0.25, emconPenalty: 0.5, taskingBonus: 0.25, max: 0.95 },
  errorKm: { radar: 8, sonar: 15, esm: 25, eo: 3, sar: 5, sigint: 30, humint: 60, osint: 80, ais: 1 },
  engagement: { tensionForHostile: 70, incidentChance: 0.25 },
  randomEventChance: 0.35,
  /** Un evento casuale alza una crisi con probabilità 1 − escalation / randomEventSaturation (a 5 → 58%, a 9 → 25%): la
   *  probabilità degli eventi cresce già con la tensione della zona (= escalation × 10) e senza saturazione il ciclo
   *  escalation → tensione → eventi → escalation portava le crisi a 10/10 da sole. L'evento resta (notizie, indicatori). */
  randomEventSaturation: 12,
  crisisDriftUp: 11, crisisDriftDown: 3,
  /** operazioni cyber per fazione e per turno (i modelli piccoli ne ordinavano decine: nessuna unità da impegnare) */
  maxCyberOpsPerTurn: 2,
  /** SPEC «accordi e de-escalation la riducono»: probabilità base di −1 per una crisi senza incidenti nel turno
   *  precedente, moltiplicata per (1 + calma), calma = 1 − tensione media tra le fazioni coinvolte / 100 */
  crisisCoolChance: 0.25,
  /** Tetto alla salita di una crisi dovuta agli ordini (blocchi, strike, ingaggi) per turno: con le posture le fazioni IA
   *  mandano molte più SHOW_OF_FORCE e BLOCKADE e le crisi arrivavano a 10/10 in pochi turni (3–4 su 5 in mock). Le singole
   *  azioni continuano a contare per tensioni e relazioni; qui si limita solo il loro effetto cumulato sulla crisi. */
  crisisOrderCapPerTurn: 1,
  /** Probabilità di raffreddamento in più, nel turno dopo, per ogni azione distensiva tra due fazioni coinvolte nella crisi
   *  (REASSURANCE, BACKCHANNEL, lettera cordiale/conciliante, accordo accettato), fino a `detenteMaxActions` azioni; vale anche
   *  se nel turno precedente la crisi è salita, così la diplomazia pesa davvero. */
  detenteCoolBonus: 0.15,
  detenteMaxActions: 3,
  /** Pressione migratoria (bersaglio verso cui l'indicatore si muove a metà ogni turno): base + escalation SAHEL_MIG × perLevel,
   *  meno `perAgreement` per ogni accordo migratorio attivo. Con 20 + 8 × escalation restava fissa a 100 appena la crisi
   *  arrivava a 10 (e le ondate casuali +8 la tenevano lì); ora il massimo di regime è 75 e le ondate rientrano. */
  migration: { base: 15, perLevel: 6, perAgreement: 10 },
  /** riduzione dell'escalation quando entra in vigore un accordo pertinente */
  agreementDeescalation: { ceasefire: 2, migration: 1, energy: 1 },
  diplo: { propagation: 0.3 },
  energy: { ttfPerLostShare: 120, stabilityPerLostShare: 25, penaltyPerLostShare: 60 },
  aarPlausibility: { victory: 0.75, draw: 0.55, defeat: 0.35 },
  autoResolveUncertainty: 0.3,
  /** posture per zona (engine/stances.ts): unità per livello di intensità (indice 1–3), prontezza minima, soglia di logoramento */
  stances: { unitsByIntensity: [0, 1, 3, 5], minReadiness: 50, wornReadiness: 35 },
  /** inneschi delle lettere IA di iniziativa (engine/letter-triggers.ts): salto di tensione in un turno che fa scrivere una fazione */
  letterTriggers: { tensionJump: 10 },
  /** Console Ordini (engine/parse-review.ts): fiducia da cui una fazione conta come alleata negli avvisi sulle azioni ostili */
  parser: { allyTrust: 40 },
  /** Decisore a regole delle fazioni non giocate dall'umano (engine/policy.ts). */
  policy: {
    /** Punteggio di base per regola, nell'ordine di priorità della spec: se due regole chiedono la stessa zona o lo stesso
     *  destinatario vince la più importante (la linea rossa prima della minaccia, la minaccia prima della crisi…). */
    score: { red_line: 100, threat: 80, crisis: 50, detente: 50, objective: 35, ally: 30, routine: 10 },
    /** Aggressività da cui si risponde alle minacce con la forza (SHOW_OF_FORCE nella zona dell'atto, altrimenti SANCTION):
     *  sotto, DEMARCHE o BACKCHANNEL. La risposta di forza esce con probabilità = aggressività (tiro registrato): senza, due
     *  profili aggressivi si rispondono a vicenda per sempre (sanzione → sanzione → …). */
    forceAt: 0.5,
    /** Risposte agli atti subiti per turno: una per aggressore, prima le più gravi. */
    maxThreatResponses: 2,
    /** Gravità degli atti subiti: livello di minaccia (1–5) nel registro e ordine delle risposte. */
    severity: { strike: 5, engagement: 4, blockade: 3, threat: 3, sanction: 2, cyber: 2, sof: 2 },
    /** Una crisi chiede una postura da questa escalation in su, nelle zone con almeno questo interesse (le altre non contano). */
    crisisMin: 3, minInterest: 0.3,
    /** Distensione: i profili con aggressività < detenteBelow, in una crisi che li coinvolge con escalation ≥ detenteFrom +
     *  riskTolerance × detenteSpan (rischio 0 → 5, rischio 1 → 8), non aggiungono forze (solo un pattugliamento leggero) e
     *  cercano la parte con cui sono più in tensione: REASSURANCE (fiducia ≥ 0) o BACKCHANNEL, da ceasefireAt una tregua. */
    detenteBelow: 0.5, detenteFrom: 5, detenteSpan: 3, ceasefireAt: 8,
    /** Coercizione, il rovescio della distensione: da questa escalation i profili aggressivi (≥ forceAt) coinvolti nella crisi fanno
     *  una dimostrazione di forza invece della sola presenza. Senza, nessuna fazione a regole esercita pressione e gli ingaggi
     *  nascono solo dal giocatore (0 in 5 turni nel primo playtest). */
    coerceFrom: 5,
    /** Ritiro: al massimo tanti ritiri per turno dalle zone dove la fazione ha forze ma nessuna regola le chiede più (le unità
     *  impegnate in una zona non si spostano da sole: senza ritiro restano lì finché non si logorano). */
    maxWithdrawals: 2,
    /** Alleato: accordo di difesa in comune (NATO, UE, bilaterali) o fiducia ≥ allyTrust. Avversario (unico bersaglio cyber):
     *  fiducia ≤ adversaryTrust e tensione ≥ adversaryTension. */
    allyTrust: 40, adversaryTrust: -20, adversaryTension: 50,
    /** Cyber: al massimo un'operazione per turno dalle regole; disruption invece di espionage solo con aggressività e tensione
     *  verso il bersaglio almeno così (il resto è spionaggio, il meno ostile). */
    cyberDisruption: { aggressiveness: 0.6, tension: 80 },
    /** Azioni diplomatiche per turno (le risposte agli accordi proposti non contano): più di così è rumore, non politica. */
    maxDiplomacy: 3,
    /** Un accordo proposto alla fazione si accetta con fiducia verso chi lo propone ≥ acceptTrust; tregue e accordi migratori
     *  anche sotto, se lo stile non è assertive. */
    acceptTrust: 10,
  },
} as const;
