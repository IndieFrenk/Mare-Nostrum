import type { AgentMemory, FactionKnowledge } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';

/** Azioni lecite per una fazione, derivate SOLO dalla sua Knowledge e dal catalogo pubblico. */
export function legalActions(k: FactionKnowledge, sc: Scenario) {
  const f = k.ownFaction;
  return {
    budgetMEur: f.budget.discretionary,
    units: k.ownUnits.filter((u) => u.status !== 'destroyed').map((u) => ({ id: u.id, name: u.name, type: u.type, zoneId: u.zoneId, status: u.status, readiness: u.readiness, count: u.count, loadout: u.loadout })),
    isrAssets: f.isrAssets.map((a) => ({ id: a.id, type: a.type, coverage: a.coverage })),
    zones: Object.keys(sc.world.zones),
    ownBases: Object.values(sc.world.bases).filter((b) => b.factionId === f.id).map((b) => b.id),
    strikeTargets: { contacts: k.contacts.map((c) => c.id), infrastructure: Object.keys(sc.world.infrastructure) },
    procurement: sc.catalog.items.filter((i) => i.leadTimeTurns !== null && i.cost <= f.budget.discretionary).map((i) => ({ id: i.id, name: i.name, cost: i.cost })),
    pendingAgreements: k.knownAgreements.filter((a) => a.status === 'proposed' && a.parties.includes(f.id)).map((a) => a.id),
    factions: Object.keys(k.beliefs),
    orderKinds: ['MOVE', 'PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'ESCORT', 'BLOCKADE', 'EXCLUSION_ZONE', 'STRIKE', 'ISR', 'SOF_OP', 'CYBER_OP', 'AIR_DEFENSE', 'REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN', 'EVACUATION'],
    diploKinds: ['DEMARCHE', 'THREAT', 'REASSURANCE', 'PROPOSE_AGREEMENT', 'RESPOND_AGREEMENT', 'SANCTION', 'LIFT_SANCTION', 'BACKCHANNEL', 'NATO_ART4', 'EU_COUNCIL', 'UNSC_DRAFT', 'ENERGY_DEAL', 'AID'],
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
  };
}

export const memoryText = (m: AgentMemory) => JSON.stringify({ goals: m.strategicGoals, commitments: m.commitments.slice(-8), grievances: m.grievances.slice(-8), lessons: m.lessons, relationshipNotes: m.relationshipNotes, summary: m.rollingSummary });
