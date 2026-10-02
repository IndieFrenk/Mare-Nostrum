import type { DiploAction, WorldState } from '../schemas/index.js';
import { RESOLUTION_FORUMS } from '../schemas/index.js';
import { emptyDiplomacy, opinionOf, pairKey, tensionOf } from './opinion.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Catalogo delle azioni diplomatiche (docs/wargame/DIPLOMAZIA.md §7): una tabella sola, letta dal validatore, dal decisore a regole,
 * dalla Console Ordini e dall'interfaccia. Per ogni azione: costo in capitale diplomatico (CD), ricarica in turni per destinatario,
 * prerequisiti (opinione, rapporti, istituzione, tensione mondiale) ed effetti (si eseguono in engine/diplomacy.ts).
 * Stesso schema e stesse regole per l'umano, le fazioni IA e (le azioni che possono) gli Stati del mondo.
 */
export type DiploKind = DiploAction['kind'];

export interface ActionSpec {
  label: string;
  /** costo in CD (fisso, o per tipo di trattato / sede della risoluzione) */
  cost: number | ((a: DiploAction) => number);
  /** turni prima di ripetere l'azione verso lo stesso destinatario (1 = una volta a turno, 2 = a turni alterni; 0 = nessun limite) */
  cooldown: number;
  /** azione di forza o di pressione: raddoppia il costo alle democrazie con tensione mondiale bassa (§6) */
  coercive?: boolean;
  /** `actor`: una fazione o uno Stato del mondo (ISO3); `faction`: solo una fazione; `none`: nessun destinatario */
  targets: 'actor' | 'faction' | 'none';
  /** cosa fa, in una riga (documentazione e interfaccia) */
  effects: string;
}

export const AGREEMENT_COST: Record<string, number> = { ceasefire: 2, migration: 3, energy: 3, trade: 3, non_aggression: 3, arms_sale: 4, intel_sharing: 4, defense_cooperation: 5, defense: 6, guarantee: 5, military_access: 5, basing: 5, secret: 3 };
export const FORUM_COST: Record<string, number> = { UNSC: 8, UNGA: 6, EU_COUNCIL: 5, NATO: 5, ARAB_LEAGUE: 4, AU: 4 };
const legacyForum = { NATO_ART4: 'NATO', EU_COUNCIL: 'EU_COUNCIL', UNSC_DRAFT: 'UNSC' } as const;

export const DIPLO_CATALOG: Record<DiploKind, ActionSpec> = {
  DEMARCHE: { label: 'Démarche', cost: 1, cooldown: 1, targets: 'actor', effects: 'opinione del destinatario −2 (decade), tensione +3' },
  THREAT: { label: 'Minaccia', cost: 3, cooldown: 2, coercive: true, targets: 'actor', effects: 'opinione −6, tensione +10, alleati del destinatario 30%; minaccia da verificare (credibilità)' },
  REASSURANCE: { label: 'Rassicurazione', cost: 1, cooldown: 1, targets: 'actor', effects: 'opinione +3, tensione −5; raffredda le crisi comuni' },
  BACKCHANNEL: { label: 'Canale riservato', cost: 1, cooldown: 1, targets: 'actor', effects: 'opinione +2, tensione −2, riservato; raffredda le crisi comuni' },
  LETTER: { label: 'Lettera', cost: 1, cooldown: 0, targets: 'faction', effects: 'dal tono: da +3 (conciliante) a −5 (minacciosa); una minacciosa è una minaccia da verificare' },
  IMPROVE_RELATIONS: { label: 'Migliorare le relazioni', cost: 1, cooldown: 0, targets: 'actor', effects: 'continuativa: 1 CD a turno, +2 a turno all\'opinione del destinatario fino a +30; occupa uno slot (2–4 secondo la potenza)' },
  STOP_IMPROVE: { label: 'Smettere di migliorare le relazioni', cost: 0, cooldown: 0, targets: 'actor', effects: 'libera lo slot; il vantaggio accumulato decade di 0,5 a settimana' },
  PROPOSE_AGREEMENT: { label: 'Proposta di trattato', cost: (a) => (a.kind === 'PROPOSE_AGREEMENT' ? AGREEMENT_COST[a.agreement.type] ?? 3 : 3), cooldown: 2, targets: 'actor', effects: 'gli Stati del mondo rispondono subito con acceptance(), le fazioni nel turno dopo; le accettate danno «Trattato attivo» +10' },
  RESPOND_AGREEMENT: { label: 'Risposta a un trattato', cost: 0, cooldown: 0, targets: 'none', effects: 'accetta, respinge o controproposta' },
  SANCTION: { label: 'Sanzioni', cost: 6, cooldown: 3, coercive: true, targets: 'actor', effects: 'opinione −15 (si accumula, tetto −40), tensione +10, stabilità del destinatario −2' },
  LIFT_SANCTION: { label: 'Revoca delle sanzioni', cost: 1, cooldown: 1, targets: 'actor', effects: 'le sanzioni diventano un residuo che decade' },
  ENERGY_DEAL: { label: 'Accordo energetico', cost: 2, cooldown: 2, targets: 'faction', effects: 'proposta di accordo sull\'infrastruttura indicata' },
  AID: { label: 'Aiuto economico o militare', cost: 2, cooldown: 1, targets: 'faction', effects: 'opinione fino a +15 (importo / 10), costo in M€; l\'aiuto militare è vietato da un embargo sulle armi' },
  RECALL_AMBASSADOR: { label: 'Richiamo dell\'ambasciatore', cost: 4, cooldown: 4, coercive: true, targets: 'actor', effects: 'primo gradino della scala: opinione −8, tensione +8' },
  EXPEL_DIPLOMATS: { label: 'Espulsione di diplomatici', cost: 6, cooldown: 6, coercive: true, targets: 'actor', effects: 'opinione −12, tensione +12; richiede un\'opinione ≤ −10 o l\'ambasciatore già richiamato' },
  BREAK_RELATIONS: { label: 'Rottura delle relazioni', cost: 10, cooldown: 8, coercive: true, targets: 'actor', effects: 'opinione −25, tensione +15; chiude i canali (restano minaccia, sanzioni, ultimatum, risoluzioni, ripristino); richiede un\'opinione ≤ −30 o diplomatici espulsi' },
  RESTORE_RELATIONS: { label: 'Ripristino delle relazioni', cost: 5, cooldown: 4, targets: 'actor', effects: 'riapre i canali: opinione +4, tensione −10' },
  ARMS_EMBARGO: { label: 'Embargo sulle armi', cost: 5, cooldown: 3, coercive: true, targets: 'actor', effects: 'vieta aiuti militari e vendite di armi verso il destinatario; opinione −6, tensione +5' },
  LIFT_ARMS_EMBARGO: { label: 'Revoca dell\'embargo sulle armi', cost: 1, cooldown: 1, targets: 'actor', effects: 'toglie l\'embargo; opinione +2' },
  ULTIMATUM: { label: 'Ultimatum', cost: 8, cooldown: 6, coercive: true, targets: 'actor', effects: 'opinione −5, tensione +10; scadenza di 1–4 turni: scaduto dà legittimità alla forza contro il destinatario (6 turni) e alza di 5 la tensione mondiale, soddisfatto (il destinatario cerca la distensione) no' },
  MEDIATE: { label: 'Mediazione in una crisi', cost: 4, cooldown: 3, targets: 'none', effects: 'solo un terzo con opinione ≥ 0 verso entrambe le parti: la crisi scende di 1, le parti apprezzano il mediatore' },
  RESOLUTION: { label: 'Risoluzione', cost: (a) => (a.kind === 'RESOLUTION' ? FORUM_COST[a.forum] ?? 5 : 5), cooldown: 2, targets: 'none', effects: 'votazione dell\'istituzione con le sue regole (CdS: veto; AG: maggioranza; UE: unanimità o QMV; NATO: consenso); se approvata dà legittimità' },
  NATO_ART4: { label: 'Consultazioni NATO (art. 4)', cost: FORUM_COST.NATO!, cooldown: 2, targets: 'none', effects: 'alias di RESOLUTION con sede NATO' },
  EU_COUNCIL: { label: 'Consiglio europeo', cost: FORUM_COST.EU_COUNCIL!, cooldown: 2, targets: 'none', effects: 'alias di RESOLUTION con sede Consiglio UE' },
  UNSC_DRAFT: { label: 'Bozza al Consiglio di sicurezza', cost: FORUM_COST.UNSC!, cooldown: 2, targets: 'none', effects: 'alias di RESOLUTION con sede CdS' },
};

/** Gli alias in lettura delle risoluzioni → la sede. */
export const legacyForumOf = (kind: string) => (legacyForum as Record<string, string>)[kind];

/** Azioni che il rapporto «rotto» non blocca (le ostili e quelle che riaprono la strada). */
const ALLOWED_WHEN_BROKEN = new Set<DiploKind>(['RESTORE_RELATIONS', 'THREAT', 'SANCTION', 'ARMS_EMBARGO', 'ULTIMATUM', 'RESOLUTION', 'NATO_ART4', 'EU_COUNCIL', 'UNSC_DRAFT', 'MEDIATE', 'RESPOND_AGREEMENT', 'LIFT_SANCTION', 'LIFT_ARMS_EMBARGO', 'STOP_IMPROVE']);

// ——— destinatari, ricariche, costi ———

/** Gli id che l'azione prende di mira (per ricarica, rapporti e prerequisiti): destinatari, parti dell'accordo, sede, crisi. */
export function targetsOf(a: DiploAction): string[] {
  switch (a.kind) {
    case 'PROPOSE_AGREEMENT': return [...new Set([...a.target, ...a.agreement.parties])];
    case 'MEDIATE': return a.parties;
    case 'RESOLUTION': return a.target ? [a.target] : [];
    case 'RESPOND_AGREEMENT': case 'NATO_ART4': case 'EU_COUNCIL': case 'UNSC_DRAFT': return [];
    default: return [a.target];
  }
}

/** Chiave della ricarica: azione verso un destinatario; la mediazione per crisi, la risoluzione per sede. */
export function cooldownKeys(actor: string, a: DiploAction): string[] {
  if (a.kind === 'MEDIATE') return [`${actor}|MEDIATE|${a.crisisId}`];
  if (a.kind === 'RESOLUTION') return [`${actor}|RESOLUTION|${a.forum}`];
  if (a.kind === 'NATO_ART4' || a.kind === 'EU_COUNCIL' || a.kind === 'UNSC_DRAFT') return [`${actor}|RESOLUTION|${legacyForumOf(a.kind)}`];
  if (a.kind === 'PROPOSE_AGREEMENT') return a.target.filter((t) => t !== actor).map((t) => `${actor}|PROPOSE_AGREEMENT:${a.agreement.type}|${t}`);
  if (a.kind === 'RESPOND_AGREEMENT') return [];
  return targetsOf(a).filter((t) => t !== actor).map((t) => `${actor}|${a.kind}|${t}`);
}

export function isDemocracy(s: WorldState, actor: string): boolean {
  const w = worldData();
  const iso = w.isoOf(actor);
  const n = iso ? w.nation(iso) : undefined;
  return !!n && (n.government === 'democracy' || n.democracyScore >= PARAMS.diplo.legitimacy.democracyScore);
}

/** Costo in CD di un'azione per chi la fa: raddoppia per una democrazia che compie un atto coercitivo con tensione mondiale bassa (§6). */
export function actionCost(s: WorldState, actor: string, a: DiploAction): number {
  const spec = DIPLO_CATALOG[a.kind];
  const base = typeof spec.cost === 'function' ? spec.cost(a) : spec.cost;
  const low = s.globalIndicators.worldTension < PARAMS.diplo.legitimacy.lowTension;
  return spec.coercive && low && isDemocracy(s, actor) ? base * 2 : base;
}

/** Primo turno in cui l'azione si può ripetere (0 se libera). */
export function cooldownUntil(s: WorldState, actor: string, a: DiploAction): number {
  const cds = s.diplomacy?.cooldowns ?? {};
  return Math.max(0, ...cooldownKeys(actor, a).map((k) => cds[k] ?? 0));
}

/**
 * Le chiavi di ricarica dopo l'uso di un'azione (le scrive il motore) e il turno da cui l'azione si può ripetere: usata al turno T con
 * ricarica N, di nuovo da T+N (ricarica 1 = una volta a turno). Ricarica 0: nessuna chiave (le lettere, la risposta a un trattato).
 */
export function cooldownsAfter(s: WorldState, actor: string, a: DiploAction): Record<string, number> {
  const n = DIPLO_CATALOG[a.kind].cooldown;
  return n > 0 ? Object.fromEntries(cooldownKeys(actor, a).map((k) => [k, s.turn + n])) : {};
}

/** Rendita di CD a settimana e slot di «migliorare le relazioni» (2–4) della fazione. */
export function weeklyRent(s: WorldState, actor: string): number {
  const P = PARAMS.diplo.capital;
  const f = s.factions[actor];
  const w = worldData();
  const iso = w.isoOf(actor);
  const n = iso ? w.nation(iso) : undefined;
  if (!f || f.kind === 'bloc') return 0;
  if (!n) return P.nonStateRent;
  const seat = (w.institution('UNSC')?.leaders ?? []).includes(n.iso3) ? P.permanentSeat : 0;
  const cred = Math.min(P.credibilityMax, Math.max(P.credibilityMin, f.credibility / P.credibilityRef));
  return Math.round(Math.max(P.minRent, Math.log10(Math.max(1, n.gdpUsdB)) + P.gdpOffset + seat) * cred * 100) / 100;
}
/** Capitale di partenza: `initialWeeks` settimane di rendita per ogni fazione che agisce (non i blocchi). Solo chi non ce l'ha ancora. */
export function initialCapital(s: WorldState) {
  const d = (s.diplomacy ??= emptyDiplomacy());
  for (const f of Object.values(s.factions).sort((a, b) => a.id.localeCompare(b.id))) {
    if (f.kind === 'bloc' || d.capital[f.id] !== undefined) continue;
    d.capital[f.id] = Math.min(PARAMS.diplo.capital.cap, Math.round(weeklyRent(s, f.id) * PARAMS.diplo.capital.initialWeeks * 10) / 10);
  }
}
export function improveSlots(s: WorldState, actor: string): number {
  const rent = weeklyRent(s, actor);
  return PARAMS.diplo.improve.slotsByRent.find(([min]) => rent >= min)?.[1] ?? PARAMS.diplo.improve.defaultSlots;
}

// ——— prerequisiti ———

/** Un id è un attore valido: una fazione o uno Stato del registro senza fazione (ISO3). */
export function isActor(s: WorldState, id: string): boolean {
  if (s.factions[id]) return true;
  const n = worldData().nation(id);
  return !!n && !n.factionId;
}
/** L'attore ha un ISO3 e quindi può sedere nelle istituzioni. */
export const isoOfActor = (id: string) => worldData().isoOf(id);

export function tieOf(s: WorldState, a: string, b: string) { return s.diplomacy?.ties[pairKey(a, b)]; }

/** Appartenenza di un attore alla sede di una risoluzione. */
export function forumMember(actor: string, forum: string): boolean {
  const w = worldData();
  const iso = w.isoOf(actor);
  const inst = w.institution(forum === 'EU_COUNCIL' ? 'EU' : forum);
  return !!iso && !!inst && inst.members.includes(iso);
}

/**
 * Errori di prerequisito di un'azione (vuoto = ammessa): ricarica, rapporti diplomatici, opinione, slot, appartenenza all'istituzione,
 * embarghi. Il costo in CD e la ripetizione nella stessa bozza li controlla il validatore (che somma i costi).
 */
export function checkAction(s: WorldState, actor: string, a: DiploAction): string[] {
  const errs: string[] = [];
  const spec = DIPLO_CATALOG[a.kind];
  const until = cooldownUntil(s, actor, a);
  if (until > s.turn) errs.push(`${spec.label}: in ricarica fino al turno ${until}`);
  const d = s.diplomacy;
  const op = (x: string, y: string) => opinionOf(s, x, y).value;
  const t = 'target' in a && typeof a.target === 'string' ? a.target : undefined;
  if (t && t !== actor && !ALLOWED_WHEN_BROKEN.has(a.kind) && tieOf(s, actor, t) === 'broken') errs.push(`${spec.label}: relazioni diplomatiche con ${t} interrotte (serve RESTORE_RELATIONS)`);
  switch (a.kind) {
    case 'IMPROVE_RELATIONS': {
      const mine = (d?.improving ?? []).filter((x) => x.actor === actor);
      if (mine.some((x) => x.target === a.target)) errs.push(`già in corso con ${a.target}`);
      else if (mine.length >= improveSlots(s, actor)) errs.push(`slot esauriti (${mine.length}/${improveSlots(s, actor)}): serve STOP_IMPROVE`);
      break;
    }
    case 'STOP_IMPROVE': if (!(d?.improving ?? []).some((x) => x.actor === actor && x.target === a.target)) errs.push(`nessun miglioramento in corso con ${a.target}`); break;
    case 'EXPEL_DIPLOMATS': if (op(actor, a.target) > -10 && tieOf(s, actor, a.target) !== 'recalled') errs.push(`serve un'opinione ≤ −10 di ${a.target} o l'ambasciatore già richiamato (ora ${op(actor, a.target)})`); break;
    case 'BREAK_RELATIONS': {
      const tie = tieOf(s, actor, a.target);
      if (tie === 'broken') errs.push('relazioni già interrotte');
      else if (op(actor, a.target) > -30 && tie !== 'expelled' && tie !== 'recalled') errs.push(`serve un'opinione ≤ −30 di ${a.target} o i diplomatici già espulsi (ora ${op(actor, a.target)})`);
      break;
    }
    case 'RECALL_AMBASSADOR': if (tieOf(s, actor, a.target)) errs.push(`rapporti già a un gradino superiore (${tieOf(s, actor, a.target)})`); break;
    case 'RESTORE_RELATIONS': if (!tieOf(s, actor, a.target)) errs.push(`le relazioni con ${a.target} non sono state ridotte`); break;
    case 'ARMS_EMBARGO': if ((d?.embargoes ?? []).includes(`${actor}>${a.target}`)) errs.push(`embargo già in vigore su ${a.target}`); break;
    case 'LIFT_ARMS_EMBARGO': if (!(d?.embargoes ?? []).includes(`${actor}>${a.target}`)) errs.push(`nessun embargo su ${a.target}`); break;
    case 'ULTIMATUM': {
      if (tensionOf(s, actor, a.target) < 30) errs.push(`serve una tensione con ${a.target} di almeno 30 (ora ${Math.round(tensionOf(s, actor, a.target))})`);
      if ((d?.ultimatums ?? []).some((u) => u.from === actor && u.to === a.target && u.status === 'pending')) errs.push(`ultimatum a ${a.target} già in corso`);
      break;
    }
    case 'MEDIATE': {
      const c = s.crises[a.crisisId];
      if (!c || c.status === 'resolved') errs.push(`crisi ${a.crisisId} sconosciuta o risolta`);
      else if (!a.parties.every((p) => c.involved.includes(p))) errs.push(`le parti devono essere coinvolte in ${a.crisisId} (${c.involved.join(', ')})`);
      if (a.parties.includes(actor)) errs.push('chi media non può essere una delle parti');
      for (const p of a.parties) if (isActor(s, p) && op(actor, p) < PARAMS.diplo.mediation.minOpinion) errs.push(`serve un'opinione ≥ 0 verso ${p} (ora ${op(actor, p)})`);
      break;
    }
    case 'RESOLUTION': case 'NATO_ART4': case 'EU_COUNCIL': case 'UNSC_DRAFT': {
      const forum = a.kind === 'RESOLUTION' ? a.forum : legacyForumOf(a.kind)!;
      if (!(RESOLUTION_FORUMS as readonly string[]).includes(forum)) errs.push(`sede sconosciuta ${forum}`);
      else if (!forumMember(actor, forum)) errs.push(`${actor} non è membro della sede ${forum}`);
      break;
    }
    case 'AID': if (a.type === 'military' && (d?.embargoes ?? []).includes(`${actor}>${a.target}`)) errs.push(`embargo sulle armi verso ${a.target}`); break;
    case 'PROPOSE_AGREEMENT': if (a.agreement.type === 'arms_sale' && a.target.some((x) => (d?.embargoes ?? []).includes(`${actor}>${x}`))) errs.push('embargo sulle armi verso una delle parti'); break;
    default: break;
  }
  return errs;
}

/** Riga del catalogo per un attore: costo, ricarica, disponibilità e motivi (per la Console Ordini e l'interfaccia). */
export function actionInfo(s: WorldState, actor: string, a: DiploAction) {
  const cost = actionCost(s, actor, a);
  const until = cooldownUntil(s, actor, a);
  const errors = checkAction(s, actor, a);
  const capital = s.diplomacy?.capital[actor] ?? 0;
  if (cost > capital) errors.push(`capitale diplomatico insufficiente (${cost} CD necessari, ${Math.round(capital * 10) / 10} disponibili)`);
  return { kind: a.kind, label: DIPLO_CATALOG[a.kind].label, cost, cooldownUntil: until > s.turn ? until : null, available: errors.length === 0, errors };
}

/**
 * Il catalogo come lo legge l'interfaccia (`GET /diplomacy/catalog`): una riga per azione ordinabile, con costo (o costo per tipo di trattato /
 * per sede), ricarica, se è coercitiva e cosa fa. Gli alias in lettura delle risoluzioni e la lettera (ha il suo pannello) non ci sono.
 */
export function diploCatalogView() {
  return (Object.entries(DIPLO_CATALOG) as [DiploKind, ActionSpec][]).filter(([k]) => !['NATO_ART4', 'EU_COUNCIL', 'UNSC_DRAFT', 'LETTER'].includes(k)).map(([kind, s]) => ({
    kind, label: s.label, cost: typeof s.cost === 'number' ? s.cost : null,
    ...(kind === 'PROPOSE_AGREEMENT' ? { costBy: AGREEMENT_COST } : kind === 'RESOLUTION' ? { costBy: FORUM_COST } : {}),
    cooldown: s.cooldown, coercive: !!s.coercive, targets: s.targets, effects: s.effects,
  }));
}
