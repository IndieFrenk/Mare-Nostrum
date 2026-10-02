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
  /** «Trattato attivo»: opinione reciproca finché l'accordo è in vigore (tolta se scade o è violato) */
  treaty: { opinion: 10, violatedOpinion: -30, violatedCredibility: -3 },
  diplo: {
    propagation: 0.3,
    /**
     * Capitale diplomatico (CD, §7): una rendita per turno dalla potenza. Rendita a settimana = max(minima, log10(PIL in mld $) − 0,35 +
     * 2 se membro permanente del CdS) × credibilità/60 (tra 0,5 e 1,5): con la credibilità iniziale (60) Italia ≈ 3,0, USA ≈ 6,1, Cina ≈ 5,9,
     * Germania ≈ 3,3, Turchia ≈ 2,8, Malta ≈ 1,0. Il turno mensile vale 4 settimane. Tetto di accumulo 100; si parte da 4 settimane di rendita.
     * Gli attori non statali (LNA) hanno una rendita fissa.
     */
    capital: { gdpOffset: -0.35, permanentSeat: 2, minRent: 0.5, nonStateRent: 0.8, credibilityRef: 60, credibilityMin: 0.5, credibilityMax: 1.5, cap: 100, initialWeeks: 4 },
    /** «Migliorare le relazioni»: slot (2–4) secondo la rendita a settimana (≥ 5 → 4, ≥ 3 → 3), +2 a turno fino a +30, 1 CD a turno */
    improve: { slotsByRent: [[5, 4], [3, 3]] as const, defaultSlots: 2, perTurn: 2, max: 30, costPerTurn: 1 },
    /**
     * Legittimità (§7): un blocco o una zona di esclusione senza risoluzione approvata, ultimatum scaduto o tensione mondiale ≥ `worldTension`
     * costa CD e credibilità e un modificatore presso le democrazie terze. Risoluzione e ultimatum scaduto valgono per un certo numero di turni.
     * Con tensione mondiale < `lowTension` le azioni coercitive delle democrazie (democrazia ≥ democracyScore) costano il doppio e danno −opinione
     * con le altre democrazie (§6).
     */
    legitimacy: { cd: 4, credibility: 2, opinion: -3, resolutionTurns: 8, ultimatumTurns: 6, worldTension: 50, lowTension: 25, democracyScore: 6 },
    /** Ultimatum: la tensione mondiale sale di `PARAMS.worldTension.incident.ultimatum` alla scadenza; il destinatario che ha cercato la distensione entro la scadenza lo «soddisfa» */
    ultimatum: { tension: 10, opinion: -5, metTension: -5, minTension: 30 },
    /** Scala dei rapporti diplomatici: valore dell'opinione del destinatario verso chi la sale, e tensione */
    ties: { recall: { opinion: -8, tension: 8 }, expel: { opinion: -12, tension: 12 }, break: { opinion: -25, tension: 15 }, restore: { opinion: 4, tension: -10 } },
    embargo: { opinion: -6, tension: 5, lift: 2 },
    mediation: { escalation: -1, opinion: 3, credibility: 1, minOpinion: 0 },
  },
  /**
   * Accettazione di una proposta di trattato (engine/acceptance.ts, §8): deterministica, accetta con punteggio ≥ 0. Il punteggio è la
   * somma di motivi leggibili. Taratura: un partner cordiale (opinione 40) accetta una cooperazione di difesa (≈ +20); uno neutro accetta
   * un accordo commerciale (≈ +1) ma non una garanzia (−9) senza un nemico comune (+12 per rivale, tetto 24) o una tensione mondiale alta.
   */
  acceptance: {
    offset: -5,
    baseByType: { ceasefire: 8, migration: 4, energy: 2, trade: 4, non_aggression: 0, arms_sale: -2, intel_sharing: -8, basing: -12, military_access: -10, defense_cooperation: -6, defense: -10, guarantee: -4, secret: -6 } as Record<string, number>,
    opinionWeight: 0.5,
    alignmentRange: 10,
    commonThreat: { perRival: 12, max: 24, opinion: -25 },
    tradeWeight: 0.3, tradeMax: 8,
    worldTension: { mid: 5, high: 8, highTrade: -4, low: -3 },
    sharedInstitution: 2, sharedInstitutionMax: 6,
    conflict: -12,
    smallPower: { ratio: 5, bonus: 8, big: -4 },
    credibility: { ref: 50, perPoint: 0.1, max: 5 },
    recentlyRejected: -12, rejectedTurns: 3,
    /** tregua: ogni punto di escalation della crisi che coinvolge entrambe le parti */
    ceasefirePerEscalation: 1.5,
  },
  /**
   * Votazioni (engine/institutions.ts, §9): il voto di uno Stato è un punteggio deterministico, somma di motivi: opinione verso il proponente,
   * opinione verso il bersaglio (chi lo apprezza non lo condanna), distanza sull'asse del voto ONU (più vicino al proponente che al bersaglio),
   * coesione del blocco (alleanza condivisa con il bersaglio o con il proponente × coesione dell'istituzione) e tema (una norma di base più
   * una componente «occidentale»: le sanzioni dividono, l'umanitario unisce). Sì sopra `yesAt`, no sotto `noAt`, in mezzo astensione (la banda
   * è asimmetrica: votare no a una condanna costa più che astenersi). Tarato sul riferimento di marzo 2022 (141 sì, 5 no, 35 astenuti):
   * una condanna in AG di un'aggressione russa deve dare tra 120 e 160 sì e al massimo 15 no (test/unga-calibration.test.ts).
   */
  votes: {
    weights: { proposer: 0.4, target: 0.3, ideal: 0.4, bloc: 0.5 },
    yesAt: 0.15, noAt: -0.4,
    /** tema → [norma di base, componente occidentale]: punteggio += base + occidentale × (−punto ideale dello Stato) */
    topics: { aggression: [0.3, 0.15], sanctions: [-0.1, 0.45], humanitarian: [0.5, 0], maritime: [0.25, 0.1], nonproliferation: [0.15, 0.3], other: [0, 0] } as Record<string, [number, number]>,
    /** UE: maggioranza qualificata (55% degli Stati e 65% della popolazione) per i temi non di politica estera; unanimità per gli altri */
    qmv: { states: 0.55, population: 0.65 },
    qmvTopics: ['humanitarian', 'other'] as string[],
    /** CdS: voti favorevoli necessari (su 15); un membro permanente pone il veto solo con un punteggio ≤ vetoAt (di norma il bersaglio e i suoi alleati più stretti), altrimenti si astiene (la Cina sulle risoluzioni sull'Ucraina) */
    unscYes: 9, vetoAt: -0.7,
    /** effetti: chi vota contro vede peggio il proponente (al massimo `maxModifiers` Stati, i più popolosi), il proponente guadagna o perde credibilità */
    againstOpinion: -3, maxModifiers: 20, credibilityPassed: 3, credibilityFailed: -2, condemnation: -5, condemnationTension: 3,
  },
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
      /** azioni del settore 09: `improve` è uno per coppia (si accumula +2 a turno fino a +30, decade solo dopo STOP_IMPROVE) */
      improve: { label: 'Migliorare le relazioni', value: 2, decayPerWeek: 0, sticky: true, cap: 30 },
      recall: { label: 'Ambasciatore richiamato', value: -8, decayPerWeek: 0.5 },
      expel: { label: 'Diplomatici espulsi', value: -12, decayPerWeek: 0.5 },
      break_ties: { label: 'Relazioni diplomatiche rotte', value: -25, decayPerWeek: 0.5 },
      restore: { label: 'Relazioni ripristinate', value: 4, decayPerWeek: 0.5 },
      embargo: { label: 'Embargo sulle armi subito', value: -6, decayPerWeek: 0.5 },
      embargo_lifted: { label: 'Embargo revocato', value: 2, decayPerWeek: 0.5 },
      ultimatum: { label: 'Ultimatum', value: -5, decayPerWeek: 1 },
      mediation: { label: 'Mediazione apprezzata', value: 3, decayPerWeek: 0.5 },
      illegitimate: { label: 'Uso della forza senza mandato', value: -3, decayPerWeek: 1 },
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
  /**
   * IA mondiale (engine/world-ai.ts, docs/wargame/DIPLOMAZIA.md §10): gli Stati senza fazione reagiscono agli eventi pubblici gravi del turno
   * precedente, adeguano le sanzioni di blocco e, a turno sfalsato, compiono una sola azione dell'agenda lenta. Tutto a regole, senza LLM.
   */
  worldAi: {
    /** gravità degli atti pubblici (da `diploActs` e dagli eventi): da `reactionSeverity` in su gli Stati reagiscono */
    severity: { strike: 5, engagement: 4, ultimatum: 4, multilateral_sanction: 4, break: 4, blockade: 3, sanction: 3, embargo: 3, cyber: 3, covert: 3 },
    reactionSeverity: 3,
    /** al massimo tanti eventi gravi per turno (i più gravi), per tenere leggero il registro */
    maxReactedEvents: 6,
    /**
     * Reazione = punteggio di simpatia verso la vittima rispetto all'attore: `opinione` × (op. verso la vittima − op. verso l'attore)/100 +
     * `ideal` × (distanza dall'attore − distanza dalla vittima)/2 sull'asse del voto ONU + `bloc` × (coesione dei blocchi in comune con la vittima
     * − con l'attore). ≥ `threshold` condanna l'attore, ≤ −`threshold` lo sostiene, in mezzo silenzio. Con 0,25 un membro dell'UE condanna uno strike
     * russo su un partner UE e i membri della CSTO no (test/ia-mondiale).
     */
    reaction: { weights: { opinion: 0.5, ideal: 0.4, bloc: 0.5 }, threshold: 0.25, opinion: 3, maxModifiersPerEvent: 12, modifiedEvents: 3 },
    /** sanzioni di blocco: chi ha votato sì a sanzioni approvate le adotta con probabilità = coesione dell'istituzione; valore (sticky, come le sanzioni) */
    blockSanctions: { opinion: -15, maxAdopters: 40, stability: { perAdopters: 10, max: 6 } },
    /** agenda lenta: uno Stato agisce quando (indice + turno) % every == 0; tetto globale di azioni a turno, priorità a quelle verso le fazioni e il giocatore */
    agenda: {
      every: 4, maxActionsPerTurn: 20,
      /** opinione sotto la quale un rivale dopo un atto ostile è «da richiamare», e probabilità (tiro registrato) */
      rival: -30, recallChance: 0.5, recallSeverity: 4,
      /** soglie: commercio da proporre con opinione ≥ tradeFrom; miglioramento delle relazioni sotto improveBelow */
      tradeFrom: 10, improveBelow: 55, maxTrade: 2,
      /** modificatori recenti negativi (turni) che contano come «opinione in calo» verso chi li ha causati */
      decliningWithin: 2, decliningMin: -3,
      /** peso del partner prioritario: commercio (per punto percentuale), blocco in comune, allineamento, essere una fazione, essere il giocatore */
      partner: { perTradePoint: 0.5, perSharedBloc: 10, alignment: 15, faction: 5, player: 5 },
      /** priorità del tipo di azione nell'ordinamento sotto tetto (più alto = prima), prima delle azioni verso fazioni e giocatore */
      priority: { RECALL_AMBASSADOR: 4, REASSURANCE: 3, PROPOSE_AGREEMENT: 2, IMPROVE_RELATIONS: 1 } as Record<string, number>,
    },
    /** lettere di uno Stato del mondo al giocatore: solo come risposta o per un innesco forte, dentro `lettersPerTurn` */
    letters: { maxPerTurn: 1 },
  },
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
    severity: { strike: 5, engagement: 4, blockade: 3, threat: 3, ultimatum: 4, sanction: 2, cyber: 2, sof: 2 },
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
    /** Alleato: accordo di difesa in comune (NATO, UE, bilaterali) o **opinione** ≥ allyOpinion. Avversario (unico bersaglio cyber):
     *  opinione ≤ adversaryOpinion e tensione ≥ adversaryTension. Soglie tarate sulla distribuzione dell'opinione (non più sul `trust` della matrice
     *  di prima): sulle 26 coppie di ogni fazione dello scenario med-2026, opinione ≥ 40 dà 0–13 alleati (mediana 7: NATO, UE e i partner storici
     *  con +20 di alleanza e +10 di unione nella base), ≥ 60 dà 0–5, e «opinione ≤ −20 con tensione ≥ 50» dà 0–5 avversari (IRN 4, ISR 5,
     *  USA 3, ITA 1). Con soglie più basse (30 / −10) quasi ogni fazione avrebbe più di 15 alleati e la rassicurazione dell'alleato sotto
     *  pressione (regola 6) scatterebbe a ogni atto. */
    allyTrust: 40, adversaryTrust: -20, adversaryTension: 50,
    /** Alleato stretto: accordo di difesa con al massimo 3 parti o opinione ≥ closeAllyOpinion. Solo loro sostengono un alleato dopo
     *  un atto senza zona (sanzioni, minacce, cyber): con tutta la NATO e l'UE una sanzione alla Francia portava 10 rassicurazioni
     *  a turno (56 in 10 turni nel playtest). Per un atto in una zona sostiene chi ha interesse in quella zona. */
    closeAllyTrust: 60,
    /** Cyber: al massimo un'operazione per turno dalle regole; disruption invece di espionage solo con aggressività e tensione
     *  verso il bersaglio almeno così (il resto è spionaggio, il meno ostile). */
    cyberDisruption: { aggressiveness: 0.6, tension: 80 },
    /** Azioni diplomatiche per turno (le risposte agli accordi proposti non contano): più di così è rumore, non politica. */
    maxDiplomacy: 3,
    /** Un accordo proposto alla fazione lo accetta o respinge acceptance() (engine/acceptance.ts); i motivi vanno nella motivazione.
     *  Relazioni: «migliorare le relazioni» con un partner di trattato con opinione < improveBelow (e un obiettivo di relazione sotto
     *  improveBelow + 30), fine quando ≥ improveStopAt; ripristino dei rapporti ridotti con opinione ≥ restoreAt e tensione < restoreTension. */
    improveBelow: 25, improveStopAt: 60, restoreAt: 0, restoreTension: 40,
  },
} as const;
