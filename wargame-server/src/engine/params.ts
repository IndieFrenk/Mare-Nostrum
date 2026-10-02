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
  /**
   * Opinione asimmetrica (engine/opinion.ts, docs/wargame/DIPLOMAZIA.md §5): opinion(A→B) = clamp(base(A,B) + Σ modificatori(A→B), ±100).
   * Valori ragionati da tarare con `npm run balance` e con i test di plausibilità (test/opinion-plausibility.test.ts).
   */
  opinion: {
    /**
     * Base statica, funzione pura dei dati del mondo (scenarios/_world). Ogni componente è un «motivo» leggibile. Tarata su tutte le
     * coppie (197 × 196): media +1,9, deviazione 14; solo 14 coppie su 38.612 arrivano a ±100 (le inimicizie più estreme); le coppie
     * di riferimento di test/opinion-plausibility.test.ts restano sul segno atteso. I pesi sono più bassi di quelli indicativi del §5.1
     * perché con alleanza 25 + unione 15 + allineamento 25 + coppia storica 45 anche le coppie amiche toccavano il tetto +100, dove un
     * modificatore dinamico (−40 per uno strike) non avrebbe più effetto.
     */
    base: {
      /** istituzione con difesa collettiva in comune (NATO, CSTO, CCG, Alleanza del Sahel): conta una volta */
      alliance: 20,
      /** stessa unione (UE) / stessa organizzazione regionale (Lega Araba, UA, ASEAN, OSA, Commonwealth, CoE…): una volta ciascuna */
      union: 10, regional: 4,
      /** blocchi contrapposti (un membro per parte): penalità */
      opposedBlocs: [['NATO', 'CSTO']] as const, opposed: -10,
      /**
       * Vicinanza di allineamento e di voto ONU: distanza D 0–1 = media pesata (idealWeight per il punto ideale) di (distanza tra i tre
       * poli)/2 e (distanza dei punti ideali)/2; il contributo va da +range (D = 0) a −range (D ≥ center + span), 0 a D = center. Con
       * center 0,3 una coppia scelta a caso (D ≈ 0,2) riceve un piccolo premio e solo le coppie davvero lontane (USA–Iran) pagano.
       */
      alignment: { range: 20, center: 0.3, span: 0.4, idealWeight: 0.6 },
      /** Somiglianza di regime dalla distanza tra i punteggi di democrazia (0–10): +range a 0, 0 a `center`, −range da center + span */
      regime: { range: 6, center: 2, span: 4 },
      /** Dipendenza commerciale di A da B: quota di B tra i primi partner di A × perShare (in punti per punto percentuale), tetto max */
      trade: { perShare: 0.4, max: 12 },
    },
    /**
     * Modificatori dinamici (§5.2): etichetta, valore di riferimento e decadimento per settimana (si scala sulla durata del turno:
     * mese = 4 settimane). `value` è il riferimento per le azioni nuove (settore 09); `relate()` usa il valore passato da chi chiama
     * (già tarato: fiducia −6 per una minaccia, −25 per uno strike…). `sticky` = un solo modificatore per coppia che si accumula fino a
     * `cap`; `mutual` = entrambe le parti vedono peggio (o meglio) l'altra (scontri, accordi).
     */
    modifiers: {
      threat: { label: 'Minaccia formale', value: -10, decayPerWeek: 1 },
      statement_threat: { label: 'Dichiarazione minacciosa', value: -3, decayPerWeek: 1 },
      statement_conciliatory: { label: 'Dichiarazione conciliante', value: 2, decayPerWeek: 1 },
      demarche: { label: 'Démarche', value: -3, decayPerWeek: 0.5 },
      reassurance: { label: 'Rassicurazione', value: 3, decayPerWeek: 0.5 },
      backchannel: { label: 'Canale riservato', value: 2, decayPerWeek: 0.5 },
      letter: { label: 'Lettera', value: 0, decayPerWeek: 0.5 },
      sanction: { label: 'Sanzioni in vigore', value: -20, decayPerWeek: 0, sticky: true, cap: -40 },
      sanction_lifted: { label: 'Sanzioni revocate', value: -10, decayPerWeek: 0.5 },
      aid: { label: 'Aiuto', value: 10, decayPerWeek: 0.5 },
      agreement: { label: 'Accordo accettato', value: 8, decayPerWeek: 0.5, mutual: true },
      agreement_rejected: { label: 'Proposta respinta', value: -4, decayPerWeek: 0.5 },
      blockade: { label: 'Blocco navale subito', value: -5, decayPerWeek: 0.5 },
      show_of_force: { label: 'Dimostrazione di forza', value: -2, decayPerWeek: 0.5 },
      strike: { label: 'Strike subito', value: -40, decayPerWeek: 0.5 },
      clash: { label: 'Scontro armato', value: -40, decayPerWeek: 0.5, mutual: true },
      incident: { label: 'Incidente', value: -3, decayPerWeek: 1, mutual: true },
      sof: { label: 'Operazione clandestina scoperta', value: -10, decayPerWeek: 0.5 },
      cyber: { label: 'Attacco cyber attribuito', value: -10, decayPerWeek: 0.5 },
      /** permanenti: l'opinione dello scenario rispetto alla base, e quella delle campagne precedenti alla migrazione */
      situation: { label: 'Situazione 2026', value: 0, decayPerWeek: 0 },
      history: { label: 'Storia recente', value: 0, decayPerWeek: 0 },
      /** reazione dei terzi e voti (settori 09–10) */
      vote_against: { label: 'Voto contrario in un\'istituzione', value: -3, decayPerWeek: 1 },
      condemnation: { label: 'Condanna pubblica', value: -5, decayPerWeek: 1 },
      support: { label: 'Sostegno pubblico', value: 5, decayPerWeek: 1 },
      treaty: { label: 'Trattato attivo', value: 10, decayPerWeek: 0 },
      treaty_violated: { label: 'Trattato violato', value: -30, decayPerWeek: 0.5 },
      improve: { label: 'Migliorare le relazioni', value: 2, decayPerWeek: 0 },
    } as Record<string, { label: string; value: number; decayPerWeek: number; sticky?: boolean; cap?: number; mutual?: boolean }>,
    /** un modificatore con |valore| sotto questa soglia si toglie */
    epsilon: 0.05,
    /** settimane per turno: scala il decadimento */
    weeksPerTurn: { week: 1, month: 4 },
    /** Fasce con cui si vede l'opinione degli altri verso di sé: ostile < −50 ≤ fredda < −15 ≤ neutra < 15 ≤ cordiale < 50 ≤ stretta */
    bands: [-50, -15, 15, 50] as const,
    /**
     * Tensione di coppia (simmetrica): il fondo è il maggiore tra la tensione strutturale della coppia (predefinita 20, come la matrice
     * dello scenario) e `perCrisisLevel` × l'escalation della crisi più grave che le coinvolge entrambe (a 10/10 → 30). Dopo un
     * incidente torna al fondo di `decayPerWeek` punti a settimana: prima restava per sempre e la tensione di coppia saliva a ogni
     * incidente fino ai massimi (ingaggi ostili da tensione ≥ 70).
     */
    tension: { default: 20, perCrisisLevel: 3, decayPerWeek: 0.5 },
  },
  /**
   * Tensione mondiale 0–100 (engine/world-tension.ts, §6). A fine turno si avvicina di `relax` al valore dato dalle crisi
   * (base + perMaxEscalation × escalation massima + perMeanEscalation × media: con RED_SEA a 5 e le altre a 2–4 → ≈ 30, la fascia «normale»)
   * e ogni incidente del turno aggiunge la sua quota: scende da sola senza incidenti e non resta mai a 100 (il massimo di regime è 63).
   * Gli effetti sugli indicatori sono piccoli e proporzionali alla variazione.
   */
  worldTension: {
    base: 8, perMaxEscalation: 3.5, perMeanEscalation: 1.5, relax: 0.3,
    incident: { engagement: 3, strike: 6, blockade: 2, threat: 1, ultimatum: 5 },
    /** tetto all'aumento in un solo turno per incidenti */
    maxIncidentBoost: 15,
    indicators: { brentPerPoint: 0.06, ttfPerPoint: 0.1, shippingPerPoint: 0.15 },
  },
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
     *  nascono solo dal giocatore (0 in 5 turni nel primo playtest); a 5 (il Mar Rosso parte da lì) gli scontri erano ~30 per
     *  partita di 20 turni, con flotte intere distrutte. */
    coerceFrom: 6,
    /** Ritiro: al massimo tanti ritiri per turno dalle zone dove la fazione ha forze ma nessuna regola le chiede più (le unità
     *  impegnate in una zona non si spostano da sole: senza ritiro restano lì finché non si logorano). */
    maxWithdrawals: 2,
    /** Alleato: accordo di difesa in comune (NATO, UE, bilaterali) o fiducia ≥ allyTrust. Avversario (unico bersaglio cyber):
     *  fiducia ≤ adversaryTrust e tensione ≥ adversaryTension. */
    allyTrust: 40, adversaryTrust: -20, adversaryTension: 50,
    /** Alleato stretto: accordo di difesa con al massimo 3 parti o fiducia ≥ closeAllyTrust. Solo loro sostengono un alleato dopo
     *  un atto senza zona (sanzioni, minacce, cyber): con tutta la NATO e l'UE una sanzione alla Francia portava 10 rassicurazioni
     *  a turno (56 in 10 turni nel playtest). Per un atto in una zona sostiene chi ha interesse in quella zona. */
    closeAllyTrust: 60,
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
