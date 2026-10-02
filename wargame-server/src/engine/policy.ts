import type { Agreement, Base, DecisionOutput, Directive, DiploAction, FactionKnowledge, FactionPolicy, Incident, Infrastructure, LetterTone, Order, PolicyRule, Rationale, RedLine, Stance, Zone, ZoneStance } from '../schemas/index.js';
import { LETTER_LIMITS, POLICY_RULES } from '../schemas/index.js';
import { DIPLO_CATALOG, cooldownKeys, forumMember } from './diplo-actions.js';
import { PARAMS } from './params.js';
import { taskZone } from './movement.js';
import { candidates } from './stances.js';
import type { Rng } from './rng.js';

/**
 * Decisore a regole delle fazioni non giocate dall'umano: niente LLM per le mosse. Restituisce lo stesso `DecisionOutput`
 * delle decisioni LLM (posture per zona, diplomazia, cyber, intenzioni di lettera), che poi passa dallo stesso traduttore delle
 * posture, dallo stesso validatore e dallo stesso registro (agents/faction-agent.ts → decisionPipeline).
 *
 * - Nebbia di guerra: legge solo la `FactionKnowledge` della fazione (unità proprie, crisi note, accordi visibili, atti visti
 *   nel turno precedente, la propria riga delle relazioni) e la geografia pubblica dello scenario (zone, basi, infrastrutture).
 * - Casualità solo dal dado registrato del motore (`rng`, i tiri finiscono in rolls/): stesso seed → stesse decisioni.
 * - Regole a punteggio in ordine stabile (PARAMS.policy): linee rosse, atti subiti, crisi nelle zone d'interesse (o distensione),
 *   obiettivi non raggiunti, alleati sotto pressione, cyber verso avversari, risposte agli accordi proposti, pattugliamento di
 *   routine. Le unità logorate e danneggiate le rimanda a casa il traduttore delle posture.
 * - Ogni scelta ha una motivazione breve in italiano (`rationale`) costruita da modelli di frase.
 */
export interface PolicyInput {
  knowledge: FactionKnowledge;
  /** geografia pubblica dello scenario: mai unità, relazioni o crisi della verità di terra */
  geo: { zones: Record<string, Zone>; bases: Record<string, Base>; infrastructure: Record<string, Infrastructure> };
  /** dado registrato del motore (ctx.rng) */
  rng: Rng;
  /** nomi pubblici delle fazioni, per le tracce delle lettere */
  names?: Record<string, string>;
  /**
   * Direttiva strategica (docs/wargame/DIPLOMAZIA.md §11), facoltativa: oggi il motore non ne passa mai una (= nessun effetto). Il settore 11 la farà
   * proporre a un LLM; qui diventa un bonus di punteggio sulle azioni verso i bersagli delle priorità, un malus verso chi si evita, uno scarto
   * dell'interesse per zona e candidati per gli accordi cercati.
   */
  directive?: Directive;
}

type Hostile = keyof typeof PARAMS.policy.severity;
const HOSTILE = Object.keys(PARAMS.policy.severity) as Hostile[];
const isHostile = (x: Incident): x is Incident & { kind: Hostile } => (HOSTILE as string[]).includes(x.kind);
const severity = (x: Incident) => (isHostile(x) ? PARAMS.policy.severity[x.kind] : 0);

/** l'atto nelle frasi: «Risposta alla minaccia», «dopo le sanzioni» */
const ACT: Record<Hostile, { a: string; noun: string }> = {
  threat: { a: 'alla minaccia', noun: 'la minaccia' }, sanction: { a: 'alle sanzioni', noun: 'le sanzioni' },
  blockade: { a: 'al blocco navale', noun: 'il blocco navale' }, engagement: { a: 'allo scontro', noun: 'lo scontro' },
  strike: { a: 'allo strike', noun: 'lo strike' }, ultimatum: { a: "all'ultimatum", noun: "l'ultimatum" }, cyber: { a: "all'attacco cyber", noun: "l'attacco cyber" },
  sof: { a: "all'operazione clandestina", noun: "l'operazione clandestina" },
};
const STANCE_IT: Record<Stance, string> = {
  patrol: 'pattugliamento', presence: 'presenza', show_of_force: 'dimostrazione di forza', escort_shipping: 'scorta al traffico',
  blockade: 'blocco', air_defense: 'difesa aerea', withdraw: 'ritiro',
};
type DiploKind = 'DEMARCHE' | 'THREAT' | 'REASSURANCE' | 'BACKCHANNEL' | 'SANCTION' | 'PROPOSE_AGREEMENT' | 'RESOLUTION'
  | 'RECALL_AMBASSADOR' | 'RESTORE_RELATIONS' | 'IMPROVE_RELATIONS' | 'STOP_IMPROVE' | 'ULTIMATUM';
const DIPLO_IT: Record<DiploKind, string> = {
  DEMARCHE: 'démarche', THREAT: 'minaccia formale', REASSURANCE: 'rassicurazione', BACKCHANNEL: 'canale riservato',
  SANCTION: 'sanzioni', PROPOSE_AGREEMENT: 'proposta di tregua', RESOLUTION: 'risoluzione in un\'istituzione',
  RECALL_AMBASSADOR: "richiamo dell'ambasciatore", RESTORE_RELATIONS: 'ripristino delle relazioni', IMPROVE_RELATIONS: 'miglioramento delle relazioni',
  STOP_IMPROVE: 'fine del miglioramento delle relazioni', ULTIMATUM: 'ultimatum',
};
const RISK: Record<string, number> = {
  show_of_force: 0.5, presence: 0.3, patrol: 0.2, escort_shipping: 0.2, SANCTION: 0.5, THREAT: 0.6, DEMARCHE: 0.2,
  REASSURANCE: 0.1, BACKCHANNEL: 0.1, PROPOSE_AGREEMENT: 0.1, RESOLUTION: 0.2, CYBER_OP: 0.4, RECALL_AMBASSADOR: 0.4, ULTIMATUM: 0.7,
  RESTORE_RELATIONS: 0.1, IMPROVE_RELATIONS: 0.1, STOP_IMPROVE: 0.1,
};
const ruleRank = (r: PolicyRule) => POLICY_RULES.indexOf(r);
/** posture di ripiego se le unità della fazione non possono fare quella scelta (la prima è la scelta stessa) */
const FALLBACK: Record<Exclude<Stance, 'withdraw'>, Exclude<Stance, 'withdraw'>[]> = {
  show_of_force: ['show_of_force', 'presence', 'patrol'], presence: ['presence', 'patrol'], patrol: ['patrol'],
  escort_shipping: ['escort_shipping', 'patrol'], blockade: ['blockade', 'show_of_force', 'patrol'], air_defense: ['air_defense', 'patrol'],
};

interface Cand { score: number; rule: PolicyRule; text: string }
interface StanceCand extends Cand { zoneId: string; stance: Exclude<Stance, 'withdraw'>; intensity: 1 | 2 | 3 }
/** `target` può mancare solo per una RESOLUTION senza bersaglio (la sede e il tema stanno nei campi propri) */
interface DiploCand extends Cand { key: string; kind: DiploKind; target: string; forum?: 'UNSC' | 'UNGA'; demand?: string; agreementType?: Agreement['type'] }
interface LetterCand { to: string; gist: string; tone: LetterTone; score: number }

/** le azioni che ogni tipo di priorità della direttiva favorisce */
const DIRECTIVE_ACTIONS: Record<Directive['priorities'][number]['kind'], DiploKind[]> = {
  improve: ['IMPROVE_RELATIONS', 'REASSURANCE', 'BACKCHANNEL'], court: ['REASSURANCE', 'PROPOSE_AGREEMENT', 'IMPROVE_RELATIONS'],
  deter: ['THREAT', 'DEMARCHE', 'ULTIMATUM'], isolate: ['SANCTION', 'RECALL_AMBASSADOR'], contain: ['THREAT', 'SANCTION', 'RECALL_AMBASSADOR'],
};

const clamp3 = (n: number) => Math.max(1, Math.min(3, n)) as 1 | 2 | 3;
const byScore = <T extends Cand>(a: T, b: T) => b.score - a.score || ruleRank(a.rule) - ruleRank(b.rule);

/** Profilo di ripiego (fazione senza `policy`): prudente, interessata alle zone delle proprie basi. */
export function defaultPolicy(factionId: string, bases: Record<string, Base>): FactionPolicy {
  const zones = [...new Set(Object.values(bases).filter((b) => b.factionId === factionId).map((b) => b.zoneId))].sort();
  return { aggressiveness: 0.3, riskTolerance: 0.3, cyberPropensity: 0.1, diplomacyStyle: 'formal', zoneInterests: Object.fromEntries(zones.map((z) => [z, 0.8])), maxStancesPerTurn: 2 };
}

/** Primo termine di una condizione della mini-DSL (engine/conditions.ts): funzione, argomenti, operatore. */
function firstTerm(expr: string): { fn: string; args: string[]; op: string } | null {
  const t = expr.split(/&&|\|\|/)[0]!.trim();
  const m = /^(\w+)\(([^)]*)\)[\w.]*\s*(>=|<=|==|!=|>|<)\s*(.+)$/.exec(t);
  return m ? { fn: m[1]!, args: m[2]!.split(',').map((x) => x.trim()), op: m[3]! } : null;
}
/** numero a destra dell'operatore (per `units(F, Z) >= N`) */
const rhs = (expr: string) => Number(/(?:>=|<=|==|!=|>|<)\s*(\d+)/.exec(expr.split(/&&|\|\|/)[0]!)?.[1] ?? 1);

export function decideByRules(i: PolicyInput): DecisionOutput {
  const k = i.knowledge;
  const me = k.factionId;
  const f = k.ownFaction;
  const P = PARAMS.policy;
  const p = f.policy ?? defaultPolicy(me, i.geo.bases);
  const nm = (x: string) => i.names?.[x] ?? x;
  const zoneName = (z: string) => i.geo.zones[z]?.name ?? z;
  const dir = i.directive;
  const interest = (z: string) => Math.max(0, (p.zoneInterests[z] ?? 0) + (dir?.zoneInterestDelta[z] ?? 0));
  /** zone con un interesse del profilo o ritoccato dalla direttiva */
  const interestZones = () => [...new Set([...Object.keys(p.zoneInterests), ...Object.keys(dir?.zoneInterestDelta ?? {})])];
  const rel = (x: string) => k.ownRelations[x] ?? { trust: 0, tension: 20 };
  /** opinione della fazione verso x (`opinionOf(lei → x)`, il campo `trust` della Knowledge è questo valore: −100…+100) */
  const opinion = (x: string) => rel(x).trust;
  /** le altre fazioni che conosce (i blocchi non ricevono lettere né azioni bilaterali) */
  const others = new Set(Object.keys(k.beliefs));
  const defense = k.knownAgreements.filter((a) => a.type === 'defense' && a.status === 'active' && a.parties.includes(me));
  const isAlly = (x: string) => x !== me && (defense.some((a) => a.parties.includes(x)) || opinion(x) >= P.allyOpinion);
  const live = k.ownUnits.filter((u) => u.status !== 'destroyed');
  const canDeploy = live.length > 0 && p.maxStancesPerTurn > 0;
  const aggressive = p.aggressiveness >= P.forceAt;
  const soft = p.diplomacyStyle === 'conciliatory';
  const known = new Map(k.knownCrises.map((c) => [c.id, c]));
  /** zona d'interesse più alta tra quelle date (a parità, per id); null se nessuna esiste */
  const best = (zones: Iterable<string>) => [...new Set(zones)].filter((z) => i.geo.zones[z]).sort((a, b) => interest(b) - interest(a) || a.localeCompare(b))[0] ?? null;
  const topZone = (sea = false) => best(interestZones().filter((z) => interest(z) > 0 && (!sea || i.geo.zones[z]?.terrain !== 'land')));
  /** dove conta un'altra fazione: zone delle sue basi e delle crisi note che la coinvolgono */
  const zoneOf = (x: string) => best([...Object.values(i.geo.bases).filter((b) => b.factionId === x).map((b) => b.zoneId), ...k.knownCrises.filter((c) => c.involved.includes(x)).flatMap((c) => c.zoneIds)]);

  const stances: StanceCand[] = []; const diplo: DiploCand[] = []; const letters: LetterCand[] = [];
  const responses: { action: DiploAction; text: string }[] = []; const military: Order[] = [];
  const extra: Rationale[] = [];
  const threats: DecisionOutput['threats'] = [];
  const addStance = (c: StanceCand) => { if (canDeploy && i.geo.zones[c.zoneId]) stances.push(c); };
  /** la sede delle risoluzioni: il Consiglio di sicurezza per i suoi membri, per gli altri l'Assemblea generale */
  const forumOf = forumMember(me, 'UNSC') ? 'UNSC' as const : 'UNGA' as const;
  /** bonus (o malus) di una direttiva su un'azione verso un bersaglio: le priorità favoriscono le azioni del loro tipo, `avoid` le frena */
  const dirBonus = (kind: DiploKind, target: string) => {
    if (!dir) return 0;
    const fav = dir.priorities.filter((x) => x.target === target && DIRECTIVE_ACTIONS[x.kind].includes(kind)).reduce((n, x) => n + x.weight, 0);
    return Math.round(fav * P.directive.bonus) - (dir.avoid.includes(target) && kind !== 'REASSURANCE' && kind !== 'BACKCHANNEL' ? P.directive.avoid : 0);
  };
  const addDiplo = (kind: DiploKind, target: string, c0: Cand, extra: { demand?: string; agreementType?: Agreement['type'] } = {}) => {
    const bonus = dirBonus(kind, target);
    const c: Cand = bonus ? { ...c0, score: c0.score + bonus, text: `${c0.text} [direttiva ${bonus > 0 ? '+' : ''}${bonus}]` } : c0;
    if (kind === 'RESOLUTION' || others.has(target)) diplo.push({ ...c, kind, target, key: kind === 'RESOLUTION' ? `RES:${forumOf}` : `${kind === 'STOP_IMPROVE' || kind === 'IMPROVE_RELATIONS' ? 'IMP' : 'ACT'}:${target}`, ...(kind === 'RESOLUTION' ? { forum: forumOf } : {}), ...extra });
  };
  const dip = k.diplomacy;
  const capital = dip?.capital ?? Infinity;
  const slotsFree = dip ? dip.improvingSlots - dip.improving.length : 0;
  const addLetter = (to: string, tone: LetterTone, gist: string, score: number) => { if (others.has(to)) letters.push({ to, tone, gist: gist.slice(0, LETTER_LIMITS.gist), score }); };
  const soften = (target: string): DiploKind => (soft || opinion(target) < 0 ? 'BACKCHANNEL' : 'REASSURANCE');

  // 1) unità logorate e danneggiate: rientro e riparazione li ordina il traduttore delle posture; qui solo la motivazione
  const worn = live.filter((u) => (u.status === 'deployed' || u.status === 'transit') && u.readiness < PARAMS.stances.wornReadiness).length;
  const damaged = live.filter((u) => u.status === 'damaged').length;
  if (worn || damaged) extra.push({ rule: 'worn', text: [worn ? `rientro alla base di ${worn} unità logorate` : '', damaged ? `riparazione di ${damaged} unità danneggiate` : ''].filter(Boolean).join(' e ').replace(/^./, (c) => c.toUpperCase()) });

  // 2) linee rosse superate nel turno precedente: la risposta scritta nel profilo, mappata su posture e azioni
  const crossed: RedLine[] = [];
  for (const x of k.incidents) {
    const rl = x.kind === 'red_line' && x.to === me ? f.redLines.find((r) => r.id === x.ref) : undefined;
    if (!rl || crossed.includes(rl)) continue;
    crossed.push(rl);
    const r = redLineResponse(rl);
    const st = r.stance && r.zoneId && canDeploy ? r.stance : null;
    const dk = r.diplo && (r.target || r.diplo === 'RESOLUTION') ? r.diplo : null;
    const parts = [st ? `${STANCE_IT[st]} in ${r.zoneId} (intensità 3)` : '', dk ? `${DIPLO_IT[dk]}${r.target && dk !== 'RESOLUTION' ? ` a ${r.target}` : ''}` : ''].filter(Boolean);
    const c: Cand = { score: P.score.red_line, rule: 'red_line', text: `Linea rossa «${rl.text}» superata (${rl.response}): ${parts.join(' e ') || 'nessuna forza disponibile'}` };
    if (st) addStance({ ...c, zoneId: r.zoneId!, stance: st, intensity: 3 });
    if (dk) addDiplo(dk, dk === 'RESOLUTION' ? (r.target ?? '') : r.target!, c, dk === 'ULTIMATUM' ? { demand: `Cessare ogni azione che ha superato la linea rossa «${rl.text}»` } : {});
    if (!st && !dk) extra.push({ rule: c.rule, text: c.text });
    if (r.target) addLetter(r.target, 'firm', `Avvertire ${nm(r.target)} che il nostro Governo considera superata una linea rossa («${rl.text}») e ne trarrà le conseguenze.`, P.score.red_line);
  }

  // 2b) garanzia: se un garantito (trattato `guarantee`, io sono il garante) ha visto superata una sua linea rossa rispondo accanto a lui:
  //     rassicurazione e, se ha un teatro e posso, una presenza nella zona della linea rossa
  const guaranteed = new Set(k.knownAgreements.filter((a) => a.type === 'guarantee' && a.status === 'active' && a.parties[0] === me).flatMap((a) => a.parties.slice(1)));
  const backed = new Set<string>();
  for (const x of k.incidents) {
    if (x.kind !== 'red_line' || x.to === me || !guaranteed.has(x.to) || backed.has(x.to)) continue;
    backed.add(x.to);
    const c: Cand = { score: P.score.red_line - 5, rule: 'red_line', text: `Garanzia a ${x.to}: linea rossa «${x.text ?? ''}» superata${x.response ? ` (${x.response})` : ''}: rassicurazione${x.zoneId && canDeploy && interest(x.zoneId) >= P.minInterest ? ` e presenza in ${x.zoneId}` : ''}` };
    addDiplo('REASSURANCE', x.to, c);
    if (x.zoneId && interest(x.zoneId) >= P.minInterest) addStance({ ...c, zoneId: x.zoneId, stance: 'presence', intensity: 2 });
  }

  // 3) atti ostili subiti nel turno precedente: risposta proporzionata al profilo, sempre una lettera ferma
  const suffered = new Map<string, Incident>();
  for (const x of k.incidents) {
    if (x.to !== me || x.from === me || !isHostile(x)) continue;
    const cur = suffered.get(x.from);
    if (!cur || severity(x) > severity(cur) || (severity(x) === severity(cur) && !cur.zoneId && x.zoneId)) suffered.set(x.from, x);
  }
  const ranked = [...suffered.values()].sort((a, b) => severity(b) - severity(a) || a.from.localeCompare(b.from)).slice(0, P.maxThreatResponses);
  for (const x of ranked) {
    const act = ACT[x.kind as Hostile]; const where = x.zoneId ? ` in ${x.zoneId}` : '';
    const sev = severity(x);
    threats.push({ factionId: x.from, level: sev, rationale: `${act.noun.replace(/^./, (c) => c.toUpperCase())} di ${x.from}${where} nel turno precedente` });
    // la risposta di forza esce con probabilità = aggressività (tiro registrato): smorza le spirali sanzione → sanzione
    const force = aggressive && i.rng.chance(`regole ${me}: risposta di forza a ${x.from}`, p.aggressiveness).ok;
    const score = P.score.threat + sev;
    if (force && x.zoneId && canDeploy && i.geo.zones[x.zoneId]) addStance({ zoneId: x.zoneId, stance: 'show_of_force', intensity: x.kind === 'strike' ? 3 : 2, score, rule: 'threat', text: `Risposta ${act.a} di ${x.from}${where}: dimostrazione di forza` });
    // la scala diplomatica: prima si richiama l'ambasciatore, con i rapporti già ridotti si passa alle sanzioni
    else if (force && !isAlly(x.from) && !dip?.ties[x.from] && dip) addDiplo('RECALL_AMBASSADOR', x.from, { score, rule: 'threat', text: `Risposta ${act.a} di ${x.from}${where}: richiamo dell'ambasciatore (primo gradino prima delle sanzioni)` });
    else if (force && !isAlly(x.from)) addDiplo('SANCTION', x.from, { score, rule: 'threat', text: `Risposta ${act.a} di ${x.from}${where}: sanzioni` });
    else { const kind = soft ? 'BACKCHANNEL' : 'DEMARCHE'; addDiplo(kind, x.from, { score, rule: 'threat', text: `Risposta ${act.a} di ${x.from}${where}: ${DIPLO_IT[kind]}` }); }
    addLetter(x.from, 'firm', `Rispondere con fermezza a ${act.noun} di ${nm(x.from)}${x.zoneId ? ` in ${zoneName(x.zoneId)}` : ''}: il nostro Governo non accetta pressioni e chiede di tornare al dialogo.`, score);
  }

  // 4) crisi nelle zone d'interesse: pattugliamento o presenza con intensità da escalation × interesse; sopra la soglia i
  //    profili poco aggressivi coinvolti non aggiungono forze e cercano la distensione
  const crises = k.knownCrises.filter((c) => c.status !== 'resolved' && c.status !== 'frozen' && c.escalation >= P.crisisMin)
    .sort((a, b) => b.escalation - a.escalation || a.id.localeCompare(b.id));
  for (const c of crises) {
    const zones = c.zoneIds.filter((z) => i.geo.zones[z] && interest(z) >= P.minInterest).sort((a, b) => interest(b) - interest(a) || a.localeCompare(b));
    if (!zones.length) continue;
    const involved = c.involved.includes(me);
    const detente = involved && p.aggressiveness < P.detenteBelow && c.escalation >= P.detenteFrom + p.riskTolerance * P.detenteSpan;
    const coerce = involved && aggressive && c.escalation >= P.coerceFrom;
    for (const z of zones) {
      const w = interest(z);
      if (detente) { addStance({ zoneId: z, stance: 'patrol', intensity: 1, score: P.score.detente, rule: 'detente', text: `Crisi ${c.id} a ${c.escalation}/10 in ${z}: distensione, solo pattugliamento leggero` }); continue; }
      const intensity = clamp3(Math.ceil((c.escalation / 10) * w * 3));
      const stance = coerce ? 'show_of_force' : involved ? 'presence' : 'patrol';
      addStance({ zoneId: z, stance, intensity, score: P.score.crisis + Math.round(20 * (c.escalation / 10) * w), rule: 'crisis', text: `Crisi ${c.id} a ${c.escalation}/10 in ${z} (interesse ${w}): ${STANCE_IT[stance]}, intensità ${intensity}` });
    }
    if (!detente) continue;
    const counterpart = c.involved.filter((x) => x !== me && others.has(x)).sort((a, b) => rel(b).tension - rel(a).tension || a.localeCompare(b))[0];
    if (!counterpart) continue;
    const ceasefire = c.escalation >= P.ceasefireAt && !k.knownAgreements.some((a) => a.type === 'ceasefire' && (a.status === 'proposed' || a.status === 'active') && a.parties.includes(me) && a.parties.includes(counterpart));
    const kind: DiploKind = ceasefire ? 'PROPOSE_AGREEMENT' : soften(counterpart);
    const score = P.score.detente + c.escalation;
    addDiplo(kind, counterpart, { score, rule: 'detente', text: `Crisi ${c.id} a ${c.escalation}/10: distensione con ${counterpart} (${DIPLO_IT[kind]})` });
    addLetter(counterpart, 'conciliatory', `Proporre a ${nm(counterpart)} di abbassare la tensione nella crisi «${c.title}» e di aprire un canale di dialogo diretto tra i due Governi.`, score);
  }

  // 5) obiettivi non raggiunti all'ultima verifica (progress < 0,5): postura nella zona che li riguarda o azione verso chi li riguarda
  for (const o of [...f.objectives].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    if (o.progress >= 0.5) continue;
    const t = firstTerm(o.metric);
    if (!t) continue;
    const score = P.score.objective + (4 - o.priority) * 5;
    const say = (what: string) => `Obiettivo «${o.text}» non raggiunto: ${what}`;
    const stance = (zoneId: string | null, st: StanceCand['stance'], intensity: 1 | 2 | 3) => { if (zoneId) addStance({ zoneId, stance: st, intensity, score, rule: 'objective', text: say(`${STANCE_IT[st]} in ${zoneId}`) }); };
    const crisisZone = (id: string) => (known.get(id) ? best(known.get(id)!.zoneIds) : null);
    if (t.fn === 'units' && t.args[0] === me) stance(t.args[1] ?? null, 'presence', clamp3(rhs(o.metric) >= 4 ? 3 : rhs(o.metric) >= 2 ? 2 : 1));
    else if (t.fn === 'units') stance(t.args[1] ?? null, 'patrol', 1);
    else if (t.fn === 'crisis' && (t.op === '<' || t.op === '<=')) stance(crisisZone(t.args[0]!), 'patrol', 1);
    else if (t.fn === 'crisis') stance(crisisZone(t.args[0]!), aggressive ? 'show_of_force' : 'presence', aggressive ? 2 : 1);
    else if (t.fn === 'infra') { const z = i.geo.infrastructure[t.args[0]!]?.zoneId ?? null; stance(z, z && i.geo.zones[z]?.terrain !== 'land' ? 'escort_shipping' : 'patrol', 1); }
    else if (t.fn === 'faction' && t.args[0] !== me) stance(zoneOf(t.args[0]!), 'presence', 1);
    else if (t.fn === 'indicator' && t.args[0] === 'medShippingRisk') stance(topZone(true), 'escort_shipping', 1);
    else if (t.fn === 'indicator' && t.args[0] === 'migrationPressure') stance(best(k.knownCrises.filter((c) => c.type === 'migration').flatMap((c) => c.zoneIds).filter((z) => interest(z) > 0)) ?? topZone(true), 'patrol', 1);
    else if (t.fn === 'relation') {
      const other = t.args[0] === me ? t.args[1]! : t.args[0]!;
      // un obiettivo di relazione è un lavoro continuo: se c'è uno slot e il capitale, si migliora la relazione (costa 1 CD a turno)
      const kind: DiploKind = slotsFree > 0 && !dip?.improving.some((x) => x.target === other) && opinion(other) < P.improveBelow + 30 ? 'IMPROVE_RELATIONS' : soften(other);
      addDiplo(kind, other, { score, rule: 'objective', text: say(`${DIPLO_IT[kind]} a ${other}`) });
      addLetter(other, soft ? 'conciliatory' : 'cordial', `Rafforzare l'opinione reciproca tra i nostri Governi e proporre a ${nm(other)} una cooperazione concreta sulle questioni di comune interesse.`, score);
    }
  }

  // 5b) relazioni: partner di un trattato in vigore che si allontanano (opinione sotto improveBelow, senza tensione alta) → migliorare le
  //     relazioni (uno slot libero alla volta); relazioni già raggiunte (opinione ≥ improveStopAt) → liberare lo slot; rapporti ridotti
  //     (richiamo, espulsione, rottura) con opinione tornata sopra restoreAt e tensione bassa → ripristino
  if (dip) {
    for (const x of dip.improving) if (opinion(x.target) >= P.improveStopAt) addDiplo('STOP_IMPROVE', x.target, { score: P.score.routine, rule: 'relations', text: `Relazioni con ${x.target} consolidate (opinione ${Math.round(opinion(x.target))}): libero lo slot` });
    const partners = [...new Set(k.knownAgreements.filter((a) => a.status === 'active' && a.type !== 'secret' && a.parties.includes(me)).flatMap((a) => a.parties))]
      .filter((x) => x !== me && others.has(x) && !dip.improving.some((y) => y.target === x) && !dip.ties[x] && opinion(x) < P.improveBelow && rel(x).tension < P.adversaryTension)
      .sort((a, b) => opinion(a) - opinion(b) || a.localeCompare(b));
    if (slotsFree > 0 && partners[0] && !diplo.some((c) => c.kind === 'IMPROVE_RELATIONS' && c.target === partners[0]))
      addDiplo('IMPROVE_RELATIONS', partners[0], { score: P.score.routine + 5, rule: 'relations', text: `Partner ${partners[0]} con opinione bassa (${Math.round(opinion(partners[0]!))}): migliorare le relazioni` });
    for (const [x, st] of Object.entries(dip.ties).sort(([a], [b]) => a.localeCompare(b)))
      if (others.has(x) && opinion(x) >= P.restoreAt && rel(x).tension < P.restoreTension)
        addDiplo('RESTORE_RELATIONS', x, { score: P.score.detente, rule: 'detente', text: `Rapporti con ${x} ridotti (${st}) ma opinione tornata a ${Math.round(opinion(x))}: ripristino delle relazioni` });
  }

  // 5c) direttiva: gli accordi che cerca (candidati con un bonus, come ogni altra azione; ricarica e capitale li filtra la scelta)
  for (const sk of dir?.seekAgreements ?? []) {
    if (!others.has(sk.with) || k.knownAgreements.some((a) => a.type === sk.type && a.status !== 'expired' && a.parties.includes(me) && a.parties.includes(sk.with))) continue;
    addDiplo('PROPOSE_AGREEMENT', sk.with, { score: P.score.objective + 10, rule: 'objective', text: `Direttiva: cercare un accordo ${sk.type} con ${nm(sk.with)}` }, { agreementType: sk.type });
  }

  // 5d) isolamento internazionale (IA mondiale): se un atto della fazione ha avuto la condanna di molti Stati o un'istituzione l'ha condannata,
  //     i profili prudenti (sotto `detenteBelow`) cercano la distensione con la vittima (o con chi ha proposto la condanna) e migliorano le relazioni
  //     con il più popoloso tra chi la condanna
  const wv = k.world;
  if (wv && p.aggressiveness < P.detenteBelow) {
    const condemned = wv.reactions.filter((r) => r.actor === me && r.condemn >= P.isolation.minStates && r.condemn / Math.max(1, r.condemn + r.support + r.silent) >= P.isolation.share);
    const voted = wv.votes.filter((v) => v.target === me && v.passed);
    if (condemned.length || voted.length) {
      const counterpart = [...condemned.map((r) => r.victim), ...voted.map((v) => v.proposer)].find((x) => x !== me && others.has(x));
      const why = condemned.length ? `Condannata da ${condemned[0]!.condemn} Stati dopo ${condemned[0]!.kind} su ${nm(condemned[0]!.victim)}` : `Condannata in ${voted[0]!.forum} (${voted[0]!.yes} sì, ${voted[0]!.no} no)`;
      if (counterpart) {
        const kind = soften(counterpart);
        const score = P.score.detente + P.isolation.bonus;
        addDiplo(kind, counterpart, { score, rule: 'detente', text: `${why}: distensione con ${nm(counterpart)} (${DIPLO_IT[kind]})` });
        addLetter(counterpart, 'conciliatory', `Spiegare a ${nm(counterpart)} la posizione del nostro Governo dopo la condanna internazionale e proporre un canale di dialogo diretto.`, score);
      }
      const critic = condemned.flatMap((r) => r.topCondemners).find((x) => others.has(x) && x !== counterpart);
      if (critic && slotsFree > 0 && !dip?.improving.some((x) => x.target === critic)) addDiplo('IMPROVE_RELATIONS', critic, { score: P.score.detente + P.isolation.bonus - 2, rule: 'detente', text: `${why}: migliorare le relazioni con ${nm(critic)}, tra i critici più influenti` });
    }
  }

  // 6) alleati sotto pressione (atto ostile di una fazione non alleata): scorta al traffico nella zona o rassicurazione
  const closeAlly = (x: string) => defense.some((a) => a.parties.length <= 3 && a.parties.includes(x)) || opinion(x) >= P.closeAllyOpinion;
  const pressured = new Map<string, Incident>();
  for (const x of k.incidents) {
    if (x.to === me || x.from === me || !isHostile(x) || !others.has(x.to) || !isAlly(x.to) || isAlly(x.from)) continue;
    // atto in una zona: lo sostiene chi ha interesse lì; senza zona (sanzioni, minacce, cyber) solo un alleato stretto
    if (x.zoneId ? interest(x.zoneId) < P.minInterest : !closeAlly(x.to)) continue;
    const cur = pressured.get(x.to);
    if (!cur || severity(x) > severity(cur)) pressured.set(x.to, x);
  }
  const ally = [...pressured.values()].sort((a, b) => severity(b) - severity(a) || a.to.localeCompare(b.to))[0];
  /** rassicurazione all'alleato: subito, o se la scorta non entra tra le posture scelte */
  const reassureAlly = () => addDiplo('REASSURANCE', ally!.to, { score: P.score.ally, rule: 'ally', text: `Sostegno a ${ally!.to} dopo ${ACT[ally!.kind as Hostile].noun} di ${ally!.from}: rassicurazione` });
  let allyEscort: StanceCand | null = null;
  if (ally) {
    const z = ally.zoneId;
    if (z && canDeploy && i.geo.zones[z] && i.geo.zones[z]!.terrain !== 'land' && interest(z) >= P.minInterest) {
      allyEscort = { zoneId: z, stance: 'escort_shipping', intensity: 1, score: P.score.ally, rule: 'ally', text: `Sostegno a ${ally.to} dopo ${ACT[ally.kind as Hostile].noun} di ${ally.from} in ${z}: scorta al traffico` };
      addStance(allyEscort);
    } else reassureAlly();
  }

  // 7) cyber: solo verso avversari (mai alleati), con probabilità cyberPropensity × offense / 10, un'operazione al turno
  const adversaries = [...others].filter((x) => !isAlly(x) && opinion(x) <= P.adversaryOpinion && rel(x).tension >= P.adversaryTension)
    .sort((a, b) => (opinion(a) - rel(a).tension) - (opinion(b) - rel(b).tension) || a.localeCompare(b));
  const target = adversaries[0];
  if (target && p.cyberPropensity > 0 && f.cyber.offense > 0 && f.budget.discretionary >= PARAMS.sortieCost.CYBER_OP) {
    const r = rel(target);
    if (i.rng.chance(`regole ${me}: operazione cyber contro ${target}`, Math.min(1, (p.cyberPropensity * f.cyber.offense) / 10)).ok) {
      const effect = p.aggressiveness >= P.cyberDisruption.aggressiveness && r.tension >= P.cyberDisruption.tension ? 'disruption' : 'espionage';
      military.push({ id: '', kind: 'CYBER_OP', target, targetRef: 'reti governative', effect });
      extra.push({ rule: 'cyber', text: `Operazione cyber (${effect}) contro ${target}: avversario, opinione ${r.trust}, tensione ${r.tension}` });
    }
  }

  // accordi proposti alla fazione da altri: risponde acceptance() (engine/acceptance.ts, deterministica: punteggio ≥ 0 accetta), con i motivi
  for (const pr of dip?.proposals ?? []) {
    const why = [...pr.reasons].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 2).map((r) => `${r.label} ${r.value > 0 ? '+' : ''}${r.value}`).join('; ');
    responses.push({ action: { id: '', kind: 'RESPOND_AGREEMENT', agreementId: pr.agreementId, response: pr.accept ? 'accept' : 'reject' }, text: `Accordo ${pr.agreementId} (${pr.type}) proposto da ${pr.from}: ${pr.accept ? 'accettato' : 'respinto'} (punteggio ${pr.score}: ${why})` });
  }

  // routine: pattugliamento leggero della zona di maggiore interesse non ancora coperta da un'altra regola (punteggio più basso:
  // entra solo se resta posto nel tetto del profilo)
  if (canDeploy) {
    const covered = new Set(stances.map((c) => c.zoneId));
    const z = best(interestZones().filter((x) => interest(x) >= P.minInterest && !covered.has(x) && i.geo.zones[x]?.terrain !== 'land'));
    if (z) addStance({ zoneId: z, stance: 'patrol', intensity: 1, score: P.score.routine, rule: 'routine', text: `Pattugliamento di routine in ${z} (zona d'interesse ${interest(z)})` });
  }

  // scelta: una postura per zona e un'azione per destinatario (vince il punteggio più alto), nei tetti del profilo
  const oneEach = <T extends Cand>(list: T[], key: (c: T) => string) => {
    const m = new Map<string, T>();
    for (const c of list) { const cur = m.get(key(c)); if (!cur || c.score > cur.score) m.set(key(c), c); }
    return [...m.values()].sort((a, b) => byScore(a, b) || key(a).localeCompare(key(b)));
  };
  const rankedStances = oneEach(stances, (c) => c.zoneId);
  // si sceglie solo ciò che le proprie unità possono fare: se per la postura non c'è nessuna unità adatta si ripiega su una
  // meno impegnativa (dimostrazione di forza → presenza → pattugliamento), altrimenti la zona lascia il posto alla successiva
  const chosenStances: StanceCand[] = [];
  for (const c of rankedStances) {
    if (chosenStances.length >= p.maxStancesPerTurn) break;
    const zone = i.geo.zones[c.zoneId]!;
    const st = FALLBACK[c.stance].find((x) => candidates(live, zone, x, new Set(), i.geo.zones).length > 0);
    if (!st) continue;
    if (st !== c.stance) { c.text = `${c.text} (${STANCE_IT[st]}: nessuna unità adatta a ${STANCE_IT[c.stance]})`; c.stance = st; }
    chosenStances.push(c);
  }
  // le altre regole che chiedevano la stessa postura nella stessa zona: soddisfatte dalla scelta (intensità massima), citate nelle motivazioni
  const joined = chosenStances.flatMap((c) => {
    const same = stances.filter((x) => x !== c && x.zoneId === c.zoneId && x.stance === c.stance);
    const n = clamp3(Math.max(c.intensity, ...same.map((x) => x.intensity)));
    if (n !== c.intensity) { c.intensity = n; c.text = c.text.replace(/intensità \d/, `intensità ${n}`); }
    return same.filter((x, j) => same.findIndex((y) => y.text === x.text) === j && x.text !== c.text);
  });
  if (allyEscort && !chosenStances.includes(allyEscort)) reassureAlly();
  const rankedDiplo = oneEach(diplo, (c) => c.key);
  // il capitale diplomatico: si sceglie nell'ordine del punteggio ciò che si può pagare, non in ricarica, con i rapporti che lo permettono
  const chosenDiplo: DiploCand[] = []; let left = capital;
  const unaffordable: DiploCand[] = [];
  for (const c of rankedDiplo) {
    if (chosenDiplo.length >= P.maxDiplomacy) break;
    const a = diploAction(c);
    const why = notReady(a, c);
    if (why) { if (why === 'capitale') unaffordable.push(c); continue; }
    left -= costOf(a);
    chosenDiplo.push(c);
  }
  for (const c of unaffordable.slice(0, 1)) extra.push({ rule: c.rule, text: `Rinuncia a ${DIPLO_IT[c.kind]}${c.target ? ` verso ${c.target}` : ''}: capitale diplomatico ${Math.round(capital * 10) / 10} CD, ne servono ${costOf(diploAction(c))}` });
  // una lettera per destinatario (la ragione più forte), al massimo due: il tetto per fazione e per turno lo applica il motore
  const chosenLetters = [...letters].sort((a, b) => b.score - a.score || a.to.localeCompare(b.to))
    .filter((l, j, all) => all.findIndex((x) => x.to === l.to) === j).slice(0, 2);

  // ritiro: zone dove la fazione ha forze impegnate che nessuna regola chiede più (prima quelle di minore interesse)
  const wanted = new Set(rankedStances.map((c) => c.zoneId));
  const deployedIn = [...new Set(live.filter((u) => u.status === 'deployed' || u.status === 'transit').map((u) => taskZone({ zones: i.geo.zones, units: {}, infrastructure: i.geo.infrastructure }, u.currentTask) ?? (u.currentTask ? u.zoneId : null)).filter((z): z is string => !!z && !!i.geo.zones[z]))];
  const withdrawals = canDeploy ? deployedIn.filter((z) => !wanted.has(z)).sort((a, b) => interest(a) - interest(b) || a.localeCompare(b)).slice(0, P.maxWithdrawals) : [];
  const zoneStances: ZoneStance[] = [
    ...chosenStances.map((c) => ({ zoneId: c.zoneId, stance: c.stance, intensity: c.intensity })),
    ...withdrawals.map((z) => ({ zoneId: z, stance: 'withdraw' as const, intensity: 1 as const })),
  ];
  extra.push(...withdrawals.map((z) => ({ rule: 'withdraw' as const, text: `Ritiro da ${z}: nessuna crisi, obiettivo o minaccia che chieda di restarci` })));
  const diplomacy: DiploAction[] = [...chosenDiplo.map((c) => diploAction(c)), ...responses.map((r) => r.action)];
  const rationale: Rationale[] = [
    ...chosenStances, ...joined, ...chosenDiplo, ...extra, ...responses.map((r) => ({ rule: 'agreement' as const, text: r.text })),
  ].map((c) => ({ rule: c.rule, text: c.text })).sort((a, b) => ruleRank(a.rule) - ruleRank(b.rule));
  // ogni decisione ha almeno una motivazione, anche quando non c'è niente da fare
  if (!rationale.length) rationale.push({ rule: 'routine', text: 'Nessuna azione: nessuna minaccia, crisi, obiettivo o accordo che chieda di agire' });
  const optionsConsidered = [
    ...rankedStances.map((c) => ({ label: `${c.rule}: ${STANCE_IT[c.stance]} in ${c.zoneId}`, summary: c.text, expectedGain: +(c.score / 100).toFixed(2), risk: RISK[c.stance] ?? 0.2, chosen: chosenStances.includes(c) })),
    ...rankedDiplo.map((c) => ({ label: `${c.rule}: ${DIPLO_IT[c.kind]}${c.target ? ` a ${c.target}` : ''}`, summary: c.text, expectedGain: +(c.score / 100).toFixed(2), risk: RISK[c.kind] ?? 0.2, chosen: chosenDiplo.includes(c) })),
  ].slice(0, 8);

  const hot = crises.filter((c) => c.zoneIds.some((z) => interest(z) >= P.minInterest)).map((c) => `${c.id} ${c.escalation}/10`);
  const assessment = [
    hot.length ? `Crisi nelle zone d'interesse: ${hot.join(', ')}.` : 'Nessuna crisi rilevante nelle zone d\'interesse.',
    ranked.length ? `Atti ostili subiti: ${ranked.map((x) => `${ACT[x.kind as Hostile].noun} di ${x.from}`).join(', ')}.` : 'Nessun atto ostile subito nel turno precedente.',
    crossed.length ? `Linee rosse superate: ${crossed.map((r) => r.id).join(', ')}.` : '',
  ].filter(Boolean).join(' ');

  return {
    situationAssessment: assessment,
    threats, optionsConsidered,
    privateIntent: rationale.filter((r) => r.rule !== 'worn').map((r) => r.text).slice(0, 3).join('; ').slice(0, 400) || 'Mantenere la postura.',
    zoneStances,
    orders: { military, diplomacy, procurement: [], statements: [] },
    confidence: 0.8,
    letterIntents: chosenLetters.map((l) => ({ to: l.to, gist: l.gist, tone: l.tone })),
    rationale,
  };

  /** Risposta scritta nella linea rossa → postura e azione; zona e bersaglio dalla condizione della linea rossa. */
  function redLineResponse(rl: RedLine): { stance: StanceCand['stance'] | null; diplo: DiploKind | null; zoneId: string | null; target: string | null } {
    const txt = rl.response.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const t = firstTerm(rl.trigger);
    const other = (x: string | undefined) => (x && x !== me && others.has(x) ? x : null);
    let zoneId: string | null = null; let target: string | null = null;
    if (t?.fn === 'units') { zoneId = i.geo.zones[t.args[1]!] ? t.args[1]! : null; target = other(t.args[0]); }
    else if (t?.fn === 'crisis') {
      const c = known.get(t.args[0]!);
      zoneId = c ? best(c.zoneIds) : null;
      target = c?.involved.filter((x) => x !== me && others.has(x)).sort((a, b) => opinion(a) - opinion(b) || a.localeCompare(b))[0] ?? null;
    } else if (t?.fn === 'infra') zoneId = i.geo.infrastructure[t.args[0]!]?.zoneId ?? null;
    else if (t?.fn === 'relation') { target = other(t.args[0] === me ? t.args[1] : t.args[0]); zoneId = target ? zoneOf(target) : null; }
    else if (t?.fn === 'faction') { zoneId = zoneOf(t.args[0]!); target = null; }
    zoneId ??= topZone();
    let stance: StanceCand['stance'] | null = null; let diplo: DiploKind | null = null;
    if (/sanzion/.test(txt)) diplo = 'SANCTION';
    if (/consiglio di sicurezza|\bonu\b|nazioni unite/.test(txt)) diplo = 'RESOLUTION';
    if (/minacc/.test(txt)) { diplo = 'THREAT'; stance = 'show_of_force'; }
    // l'ultimatum solo se la linea rossa lo scrive come risposta (mai di iniziativa)
    if (/ultimatum/.test(txt)) diplo = 'ULTIMATUM';
    if (/strike|attacc|militar|mobilitaz|naval/.test(txt)) stance = 'show_of_force';
    if (/rinforz|schier|contingent/.test(txt)) stance ??= 'presence';
    if (!stance && !diplo) stance = 'presence';
    if ((diplo === 'THREAT' || diplo === 'SANCTION' || diplo === 'ULTIMATUM') && !target) diplo = null;
    return { stance, diplo, zoneId, target };
  }

  /** Azione diplomatica con testo da modello di frase (niente LLM). */
  function diploAction(c: DiploCand): DiploAction {
    const { kind, target } = c;
    const who = nm(target);
    switch (kind) {
      case 'DEMARCHE': return { id: '', kind, target, message: `Il Governo protesta formalmente con ${who} e chiede spiegazioni sulle azioni del turno precedente.`, visibility: 'public' };
      case 'THREAT': return { id: '', kind, target, message: `Il Governo avverte ${who}: ogni ulteriore azione ostile avrà una risposta adeguata.`, visibility: 'public' };
      case 'REASSURANCE': return { id: '', kind, target, message: `Il Governo conferma a ${who} la volontà di cooperare e di evitare ogni escalation.`, visibility: 'public' };
      case 'BACKCHANNEL': return { id: '', kind, target, message: `Proposta riservata a ${who}: aprire un canale diretto per abbassare la tensione.` };
      case 'SANCTION': return { id: '', kind, target, scope: 'misure economiche mirate' };
      case 'PROPOSE_AGREEMENT': {
        const type = c.agreementType ?? 'ceasefire';
        return { id: '', kind, target: [target], agreement: { type, parties: [me, target], terms: type === 'ceasefire' ? `Tregua e canale militare diretto tra ${nm(me)} e ${who}` : `Accordo (${type}) tra ${nm(me)} e ${who}`, endTurn: null, visibility: 'public' } };
      }
      case 'RESOLUTION': return { id: '', kind, forum: c.forum ?? forumOf, subject: `Richiesta di ${nm(me)} dopo il superamento di una linea rossa`, topic: 'aggression', ...(target ? { target } : {}) };
      case 'ULTIMATUM': return { id: '', kind, target, demand: c.demand ?? 'Cessare le azioni ostili', deadlineTurns: 2 };
      case 'RECALL_AMBASSADOR': case 'RESTORE_RELATIONS': case 'IMPROVE_RELATIONS': case 'STOP_IMPROVE': return { id: '', kind, target };
    }
  }

  /** Costo in CD di un'azione per questa fazione: il catalogo, con il raddoppio delle azioni coercitive per le democrazie a tensione bassa. */
  function costOf(a: DiploAction): number {
    const spec = DIPLO_CATALOG[a.kind];
    return (typeof spec.cost === 'function' ? spec.cost(a) : spec.cost) * (spec.coercive ? dip?.coerciveCost ?? 1 : 1);
  }

  /** Perché un'azione non si può fare adesso (`capitale`, `ricarica`, `rapporti`, `slot`, `prerequisito`), altrimenti null. */
  function notReady(a: DiploAction, c: DiploCand): string | null {
    if (!dip) return null;
    if (costOf(a) > left + 1e-9) return 'capitale';
    if (cooldownKeys(me, a).some((key) => (dip.cooldowns[key.slice(me.length + 1)] ?? 0) > k.turn)) return 'ricarica';
    if (c.target && dip.ties[c.target] === 'broken' && !['RESTORE_RELATIONS', 'THREAT', 'SANCTION', 'ULTIMATUM', 'RESOLUTION'].includes(a.kind)) return 'rapporti';
    if (a.kind === 'ULTIMATUM' && rel(c.target).tension < PARAMS.diplo.ultimatum.minTension) return 'prerequisito';
    if (a.kind === 'RECALL_AMBASSADOR' && dip.ties[c.target]) return 'prerequisito';
    if (a.kind === 'IMPROVE_RELATIONS' && slotsFree <= 0) return 'slot';
    if (a.kind === 'RESOLUTION' && !forumMember(me, a.forum)) return 'prerequisito';
    return null;
  }
}
