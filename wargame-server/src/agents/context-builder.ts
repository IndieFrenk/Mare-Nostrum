import type { AgentMemory, FactionKnowledge } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';
import { DIPLO_CATALOG } from '../engine/diplo-actions.js';
import { stanceForces } from '../engine/stances.js';

/** Azioni diplomatiche che un agente può ordinare (gli alias NATO_ART4, EU_COUNCIL e UNSC_DRAFT restano solo in lettura). */
const DIPLO_KINDS = ['DEMARCHE', 'THREAT', 'REASSURANCE', 'BACKCHANNEL', 'PROPOSE_AGREEMENT', 'RESPOND_AGREEMENT', 'SANCTION', 'LIFT_SANCTION', 'ENERGY_DEAL', 'AID', 'IMPROVE_RELATIONS', 'STOP_IMPROVE', 'RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO', 'ULTIMATUM', 'MEDIATE', 'RESOLUTION'] as const;
/** costo indicativo delle azioni il cui costo dipende dal tipo (trattato, sede): media del catalogo */
const DIPLO_FIXED: Partial<Record<(typeof DIPLO_KINDS)[number], number>> = { PROPOSE_AGREEMENT: 4, RESOLUTION: 5 };

/** Azioni lecite per una fazione, derivate SOLO dalla sua Knowledge e dal catalogo pubblico. */
export function legalActions(k: FactionKnowledge, sc: Scenario) {
  const f = k.ownFaction;
  return {
    budgetMEur: f.budget.discretionary,
    units: k.ownUnits.filter((u) => u.status !== 'destroyed').map((u) => ({ id: u.id, name: u.name, type: u.type, zoneId: u.zoneId, status: u.status, readiness: u.readiness, count: u.count, loadout: u.loadout })),
    isrAssets: f.isrAssets.map((a) => ({ id: a.id, type: a.type, coverage: a.coverage })),
    seaZones: Object.values(sc.world.zones).filter((z) => z.terrain === 'sea').map((z) => z.id),
    // per zoneStances: quante unità il motore può mandare in ogni zona di mare (conteggi, non id: li sceglie il motore)
    unitsPerSeaZone: stanceForces(k.ownUnits, sc.world.zones),
    landZones: Object.values(sc.world.zones).filter((z) => z.terrain === 'land').map((z) => z.id),
    ownBases: Object.values(sc.world.bases).filter((b) => b.factionId === f.id).map((b) => b.id),
    strikeTargets: { contacts: k.contacts.map((c) => c.id), infrastructure: Object.keys(sc.world.infrastructure) },
    procurement: sc.catalog.items.filter((i) => i.leadTimeTurns !== null && i.cost <= f.budget.discretionary).map((i) => ({ id: i.id, name: i.name, cost: i.cost })),
    pendingAgreements: k.knownAgreements.filter((a) => a.status === 'proposed' && a.parties.includes(f.id)).map((a) => a.id),
    factions: Object.keys(k.beliefs),
    // solo i tipi di ordine che la fazione può davvero eseguire: i modelli piccoli altrimenti inventano asset ISR o squadre SOF
    orderKinds: ['MOVE', 'PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'ESCORT', 'BLOCKADE', 'EXCLUSION_ZONE', 'STRIKE', 'ISR', 'SOF_OP', 'CYBER_OP', 'AIR_DEFENSE', 'REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN', 'EVACUATION']
      .filter((kind) => (kind !== 'ISR' || f.isrAssets.length > 0) && (kind !== 'SOF_OP' || k.ownUnits.some((u) => u.type === 'sof_team' && u.status !== 'destroyed'))),
    diploKinds: DIPLO_KINDS,
    // capitale diplomatico (CD): ogni azione ha un costo, molte una ricarica; il motore scarta ciò che non si può pagare
    capitaleDiplomatico: k.diplomacy?.capital ?? null,
    costiDiplomatici: Object.fromEntries(DIPLO_KINDS.map((kind) => {
      const c = DIPLO_CATALOG[kind].cost;
      return [kind, (typeof c === 'number' ? c : DIPLO_FIXED[kind] ?? 3) * (DIPLO_CATALOG[kind].coercive ? k.diplomacy?.coerciveCost ?? 1 : 1)];
    })),
    ricariche: k.diplomacy?.cooldowns ?? {},
    slotMiglioramento: k.diplomacy ? k.diplomacy.improvingSlots - k.diplomacy.improving.length : 0,
  };
}

export function situation(k: FactionKnowledge) {
  const f = k.ownFaction;
  return {
    fazione: { posture: f.posture, stability: f.stability, credibility: f.credibility, budgetMEur: f.budget.discretionary, redLines: f.redLines.map((r) => r.text), crossedRedLines: f.crossedRedLines },
    contatti: k.contacts.map((c) => ({ id: c.id, classification: c.classification, estFaction: c.estFaction, zoneId: c.zoneId, confidence: c.confidence })),
    crisi: k.knownCrises.map((c) => ({ id: c.id, title: c.title, escalation: c.escalation, zones: c.zoneIds })),
    accordi: k.knownAgreements.map((a) => ({ id: a.id, type: a.type, parties: a.parties, status: a.status })),
    stimeAltrui: k.beliefs, inbox: k.inbox.map((m) => ({ from: m.from, text: m.text, channel: m.channel })),
    notizie: k.publicNews.slice(0, 6).map((n) => `${n.outlet}: ${n.headline}`),
    // lettere ricevute nell'ultimo turno (il testo intero lo vede il consigliere che risponde)
    lettere: k.letters.filter((l) => l.to === k.factionId && l.turn >= k.turn - 1).map((l) => ({ da: l.from, oggetto: l.subject, tono: l.tone })),
  };
}

export const memoryText = (m: AgentMemory) => JSON.stringify({ goals: m.strategicGoals, commitments: m.commitments.slice(-8), grievances: m.grievances.slice(-8), lessons: m.lessons, relationshipNotes: m.relationshipNotes, summary: m.rollingSummary });
