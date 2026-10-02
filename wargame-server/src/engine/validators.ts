import type { FactionOrders, OrdersBody, WorldState } from '../schemas/index.js';
import type { Catalog } from './scenario.js';
import { PARAMS } from './params.js';
import { LETTER_LIMITS } from '../schemas/index.js';
import { acceptance, type AcceptanceResult } from './acceptance.js';
import { DIPLO_CATALOG, actionCost, checkAction, cooldownKeys, isActor, targetsOf } from './diplo-actions.js';

/** `acceptance`: per ogni proposta di trattato, come risponderebbe ogni destinatario (punteggio e motivi, engine/acceptance.ts): il dry-run del §8. */
export interface Validation { valid: boolean; errors: string[]; risks: string[]; estCost: number; acceptance?: (AcceptanceResult & { actionId: string; type: string })[]; capitalCost?: number }

/** Validazione unica per umano e IA: proprietà, disponibilità, budget, compatibilità. */
export function validateOrders(s: WorldState, catalog: Catalog, factionId: string, o: OrdersBody | FactionOrders, knownRefs: Set<string> = new Set(), turnLength: 'week' | 'month' = 'week'): Validation {
  const errors: string[] = []; const risks: string[] = [];
  const f = s.factions[factionId];
  if (!f) return { valid: false, errors: [`fazione sconosciuta ${factionId}`], risks, estCost: 0 };
  let cost = 0;
  const used = new Set<string>();
  const usedAssets = new Set<string>();
  let cyberOps = 0;
  // l'errore porta l'id dell'ordine: così un ordine con una zona inventata si può scartare da solo
  let current = '';
  const zoneOk = (z: string) => !!s.zones[z] || (errors.push(`${current}: zona sconosciuta: ${z}`), false);
  const mult = PARAMS.opCostMultiplier[turnLength];
  for (const ord of o.military) {
    current = ord.id;
    const unitIds = 'unitIds' in ord ? ord.unitIds : [];
    for (const id of unitIds) {
      const u = s.units[id];
      if (!u || u.factionId !== factionId) { errors.push(`${ord.id}: unità ${id} non disponibile`); continue; }
      if (u.status === 'destroyed') errors.push(`${ord.id}: ${u.name} è distrutta`);
      if (used.has(id)) errors.push(`${ord.id}: ${u.name} assegnata a più ordini`);
      used.add(id);
      if (u.readiness < 40 && !['REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN'].includes(ord.kind)) risks.push(`${u.name}: prontezza ${u.readiness}%`);
      if (u.status === 'ready' && !['REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN'].includes(ord.kind)) cost += u.opCostPerTurn * mult;
    }
    const dest = 'zoneId' in ord ? ord.zoneId : ord.kind === 'MOVE' && typeof ord.to === 'string' ? ord.to : null;
    if (dest && s.zones[dest]?.terrain === 'land' && unitIds.some((id) => ['sea', 'subsurface'].includes(s.units[id]?.domain ?? '')))
      errors.push(`${ord.id}: ${dest} è una zona terrestre, non raggiungibile da unità navali`);
    switch (ord.kind) {
      case 'MOVE': if (typeof ord.to === 'string') zoneOk(ord.to); break;
      case 'PATROL': case 'PRESENCE': case 'SHOW_OF_FORCE': case 'BLOCKADE': case 'EXCLUSION_ZONE': case 'AIR_DEFENSE': case 'EVACUATION':
        if (zoneOk(ord.zoneId) && 'roe' in ord && ord.roe === 'WEAPONS_FREE' && s.zones[ord.zoneId].tension >= 40) risks.push(`${ord.id}: WEAPONS_FREE in zona ad alta tensione, ingaggio probabile`);
        if (ord.kind === 'BLOCKADE' || ord.kind === 'EXCLUSION_ZONE') risks.push(`${ord.id}: ${ord.kind} farà salire l'escalation`);
        break;
      case 'STRIKE': {
        if (!s.infrastructure[ord.targetRef] && !s.bases[ord.targetRef] && !knownRefs.has(ord.targetRef)) errors.push(`${ord.id}: bersaglio ${ord.targetRef} sconosciuto`);
        for (const [m, q] of Object.entries(ord.munitions)) {
          const have = ord.unitIds.reduce((a, id) => a + (s.units[id]?.loadout[m] ?? 0), 0);
          if (have < q) errors.push(`${ord.id}: ${m} insufficienti (${have}/${q})`);
          cost += (catalog.munitions[m]?.cost ?? 1) * q;
        }
        cost += PARAMS.sortieCost.STRIKE;
        risks.push(`${ord.id}: strike, escalation e ritorsione probabili`);
        break;
      }
      case 'ISR':
        for (const a of ord.assetIds) {
          if (!f.isrAssets.some((x) => x.id === a)) errors.push(`${ord.id}: asset ISR ${a} non disponibile`);
          else if (usedAssets.has(a)) errors.push(`${ord.id}: asset ISR ${a} già impiegato in questo turno`);
          usedAssets.add(a);
        }
        zoneOk(ord.zoneId); cost += PARAMS.sortieCost.ISR * ord.assetIds.length; break;
      case 'SOF_OP': zoneOk(ord.zoneId); cost += PARAMS.sortieCost.SOF_OP; if (ord.unitIds.some((id) => s.units[id]?.type !== 'sof_team')) errors.push(`${ord.id}: SOF_OP richiede unità sof_team`); break;
      case 'CYBER_OP': if (!s.factions[ord.target]) errors.push(`${ord.id}: bersaglio ${ord.target} non è una fazione`); else if (ord.target === factionId) errors.push(`${ord.id}: un'operazione cyber non può colpire la propria fazione`); if (++cyberOps > PARAMS.maxCyberOpsPerTurn) errors.push(`${ord.id}: al massimo ${PARAMS.maxCyberOpsPerTurn} operazioni cyber per turno`); cost += PARAMS.sortieCost.CYBER_OP; break;
      case 'ESCORT': if (!s.units[ord.protect] && !s.infrastructure[ord.protect] && !/^convoglio/i.test(ord.protect)) errors.push(`${ord.id}: oggetto da scortare sconosciuto`); break;
      default: break;
    }
  }
  const ordersOfItem = new Map<string, number>();
  for (const p of o.procurement) {
    const item = catalog.items.find((i) => i.id === p.itemId);
    if (!item) { errors.push(`${p.id}: articolo ${p.itemId} inesistente`); continue; }
    if (item.leadTimeTurns === null) errors.push(`${p.id}: ${item.name} non rimpiazzabile nel breve termine`);
    const b = s.bases[p.destinationBaseId];
    if (!b || b.factionId !== factionId) errors.push(`${p.id}: base di destinazione ${p.destinationBaseId} non valida`);
    ordersOfItem.set(item.id, (ordersOfItem.get(item.id) ?? 0) + 1);
    if ((ordersOfItem.get(item.id) ?? 0) > 1) risks.push(`${p.id}: ordini ripetuti su ${item.name} riducono la disponibilità industriale`);
    cost += item.cost * p.qty;
  }
  let letters = 0;
  let cdSpent = 0;
  const verdicts: NonNullable<Validation['acceptance']> = [];
  const seenKeys = new Set<string>();
  for (const d of o.diplomacy) {
    // il destinatario è una fazione o uno Stato del registro (ISO3), mai una zona come CANALE_SICILIA, e non la fazione stessa
    for (const t of new Set(targetsOf(d))) {
      if (!isActor(s, t)) errors.push(`${d.id}: destinatario ${t} sconosciuto (non è una fazione)`);
      else if (t === factionId && d.kind !== 'LETTER' && d.kind !== 'MEDIATE' && !(d.kind === 'PROPOSE_AGREEMENT' && !d.target.includes(factionId))) errors.push(`${d.id}: ${d.kind} non può essere rivolto alla propria fazione`);
      else if (!s.factions[t] && ['LETTER', 'ENERGY_DEAL', 'AID'].includes(d.kind)) errors.push(`${d.id}: ${d.kind} si rivolge solo a una fazione (${t} è uno Stato senza fazione)`);
    }
    // catalogo (§7): ricarica, rapporti, prerequisiti e capitale diplomatico (somma dei costi della bozza)
    for (const e of checkAction(s, factionId, d)) errors.push(`${d.id}: ${e}`);
    for (const k of cooldownKeys(factionId, d)) { if (seenKeys.has(k)) errors.push(`${d.id}: ${DIPLO_CATALOG[d.kind].label} ripetuta nella stessa bozza`); seenKeys.add(k); }
    const cd = actionCost(s, factionId, d);
    cdSpent += cd;
    if (cd && cdSpent > (s.diplomacy?.capital[factionId] ?? 0) + 1e-9) errors.push(`${d.id}: capitale diplomatico insufficiente (${Math.round(cdSpent * 10) / 10} CD in bozza, ${Math.round((s.diplomacy?.capital[factionId] ?? 0) * 10) / 10} disponibili)`);
    if (d.kind === 'PROPOSE_AGREEMENT') {
      const parties = [...new Set([factionId, ...d.target, ...d.agreement.parties])];
      for (const t of d.target.filter((x) => x !== factionId && isActor(s, x))) verdicts.push({ actionId: d.id, type: d.agreement.type, ...acceptance(s, t, { type: d.agreement.type, parties }, factionId) });
    }
    if (d.kind === 'LETTER') {
      letters++;
      if (d.target === factionId) errors.push(`${d.id}: una lettera non può essere indirizzata a sé stessi`);
      else if (s.factions[d.target]?.kind === 'bloc') errors.push(`${d.id}: ${d.target} non ha un capo di Stato a cui scrivere`);
      if (!d.subject.trim()) errors.push(`${d.id}: oggetto della lettera vuoto`);
      if (d.subject.length > LETTER_LIMITS.subject) errors.push(`${d.id}: oggetto oltre ${LETTER_LIMITS.subject} caratteri (${d.subject.length})`);
      if (!d.body.trim()) errors.push(`${d.id}: testo della lettera vuoto`);
      if (d.body.length > LETTER_LIMITS.body) errors.push(`${d.id}: testo oltre ${LETTER_LIMITS.body} caratteri (${d.body.length})`);
    }
    if (d.kind === 'AID') cost += d.amount;
    if (d.kind === 'RESPOND_AGREEMENT' && !s.agreements[d.agreementId]?.parties.includes(factionId)) errors.push(`${d.id}: accordo ${d.agreementId} non pertinente`);
    if (d.kind === 'ENERGY_DEAL' && !s.infrastructure[d.infrastructureId]) errors.push(`${d.id}: infrastruttura ${d.infrastructureId} sconosciuta`);
  }
  if (f.controller === 'human' && letters > LETTER_LIMITS.perTurnHuman) errors.push(`al massimo ${LETTER_LIMITS.perTurnHuman} lettere per turno (${letters} in bozza)`);
  cost = Math.round(cost * 10) / 10;
  if (cost > f.budget.discretionary) errors.push(`costo stimato ${cost} M€ oltre il budget disponibile ${f.budget.discretionary} M€`);
  return { valid: errors.length === 0, errors, risks, estCost: cost, ...(verdicts.length ? { acceptance: verdicts } : {}), ...(cdSpent ? { capitalCost: Math.round(cdSpent * 10) / 10 } : {}) };
}
