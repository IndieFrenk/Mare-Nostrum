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
  crisisDriftUp: 11, crisisDriftDown: 3,
  /** operazioni cyber per fazione e per turno (i modelli piccoli ne ordinavano decine: nessuna unità da impegnare) */
  maxCyberOpsPerTurn: 2,
  /** SPEC «accordi e de-escalation la riducono»: probabilità base di −1 per una crisi senza incidenti nel turno
   *  precedente, moltiplicata per (1 + calma), calma = 1 − tensione media tra le fazioni coinvolte / 100 */
  crisisCoolChance: 0.25,
  /** riduzione dell'escalation quando entra in vigore un accordo pertinente */
  agreementDeescalation: { ceasefire: 2, migration: 1, energy: 1 },
  diplo: { propagation: 0.3 },
  energy: { ttfPerLostShare: 120, stabilityPerLostShare: 25, penaltyPerLostShare: 60 },
  aarPlausibility: { victory: 0.75, draw: 0.55, defeat: 0.35 },
  autoResolveUncertainty: 0.3,
  /** posture per zona (engine/stances.ts): unità per livello di intensità (indice 1–3), prontezza minima, soglia di logoramento */
  stances: { unitsByIntensity: [0, 1, 3, 5], minReadiness: 50, wornReadiness: 35 },
} as const;
