import type { Base, DecisionOutput, DiploAction, FactionKnowledge, FactionPolicy, Incident, Infrastructure, LetterTone, Order, PolicyRule, Rationale, RedLine, Stance, Zone, ZoneStance } from '../schemas/index.js';
import { LETTER_LIMITS, POLICY_RULES } from '../schemas/index.js';
import { PARAMS } from './params.js';
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
}

type Hostile = keyof typeof PARAMS.policy.severity;
const HOSTILE = Object.keys(PARAMS.policy.severity) as Hostile[];
const isHostile = (x: Incident): x is Incident & { kind: Hostile } => (HOSTILE as string[]).includes(x.kind);
const severity = (x: Incident) => (isHostile(x) ? PARAMS.policy.severity[x.kind] : 0);

/** l'atto nelle frasi: «Risposta alla minaccia», «dopo le sanzioni» */
const ACT: Record<Hostile, { a: string; noun: string }> = {
  threat: { a: 'alla minaccia', noun: 'la minaccia' }, sanction: { a: 'alle sanzioni', noun: 'le sanzioni' },
  blockade: { a: 'al blocco navale', noun: 'il blocco navale' }, engagement: { a: 'allo scontro', noun: 'lo scontro' },
  strike: { a: 'allo strike', noun: 'lo strike' }, cyber: { a: "all'attacco cyber", noun: "l'attacco cyber" },
  sof: { a: "all'operazione clandestina", noun: "l'operazione clandestina" },
};
const STANCE_IT: Record<Stance, string> = {
  patrol: 'pattugliamento', presence: 'presenza', show_of_force: 'dimostrazione di forza', escort_shipping: 'scorta al traffico',
  blockade: 'blocco', air_defense: 'difesa aerea', withdraw: 'ritiro',
};
type DiploKind = 'DEMARCHE' | 'THREAT' | 'REASSURANCE' | 'BACKCHANNEL' | 'SANCTION' | 'PROPOSE_AGREEMENT' | 'UNSC_DRAFT';
const DIPLO_IT: Record<DiploKind, string> = {
  DEMARCHE: 'démarche', THREAT: 'minaccia formale', REASSURANCE: 'rassicurazione', BACKCHANNEL: 'canale riservato',
  SANCTION: 'sanzioni', PROPOSE_AGREEMENT: 'proposta di tregua', UNSC_DRAFT: 'bozza di risoluzione al Consiglio di sicurezza',
};
const RISK: Record<string, number> = {
  show_of_force: 0.5, presence: 0.3, patrol: 0.2, escort_shipping: 0.2, SANCTION: 0.5, THREAT: 0.6, DEMARCHE: 0.2,
  REASSURANCE: 0.1, BACKCHANNEL: 0.1, PROPOSE_AGREEMENT: 0.1, UNSC_DRAFT: 0.2, CYBER_OP: 0.4,
};
const ruleRank = (r: PolicyRule) => POLICY_RULES.indexOf(r);

interface Cand { score: number; rule: PolicyRule; text: string }
interface StanceCand extends Cand { zoneId: string; stance: Exclude<Stance, 'withdraw'>; intensity: 1 | 2 | 3 }
interface DiploCand extends Cand { key: string; kind: DiploKind; target: string }
interface LetterCand { to: string; gist: string; tone: LetterTone; score: number }

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
  const interest = (z: string) => p.zoneInterests[z] ?? 0;
  const rel = (x: string) => k.ownRelations[x] ?? { trust: 0, tension: 20 };
  /** le altre fazioni che conosce (i blocchi non ricevono lettere né azioni bilaterali) */
  const others = new Set(Object.keys(k.beliefs));
  const defense = k.knownAgreements.filter((a) => a.type === 'defense' && a.status === 'active' && a.parties.includes(me));
  const isAlly = (x: string) => x !== me && (defense.some((a) => a.parties.includes(x)) || rel(x).trust >= P.allyTrust);
  const live = k.ownUnits.filter((u) => u.status !== 'destroyed');
  const canDeploy = live.length > 0 && p.maxStancesPerTurn > 0;
  const aggressive = p.aggressiveness >= P.forceAt;
  const soft = p.diplomacyStyle === 'conciliatory';
  const known = new Map(k.knownCrises.map((c) => [c.id, c]));
  /** zona d'interesse più alta tra quelle date (a parità, per id); null se nessuna esiste */
  const best = (zones: Iterable<string>) => [...new Set(zones)].filter((z) => i.geo.zones[z]).sort((a, b) => interest(b) - interest(a) || a.localeCompare(b))[0] ?? null;
  const topZone = (sea = false) => best(Object.keys(p.zoneInterests).filter((z) => interest(z) > 0 && (!sea || i.geo.zones[z]?.terrain !== 'land')));
  /** dove conta un'altra fazione: zone delle sue basi e delle crisi note che la coinvolgono */
  const zoneOf = (x: string) => best([...Object.values(i.geo.bases).filter((b) => b.factionId === x).map((b) => b.zoneId), ...k.knownCrises.filter((c) => c.involved.includes(x)).flatMap((c) => c.zoneIds)]);

  const stances: StanceCand[] = []; const diplo: DiploCand[] = []; const letters: LetterCand[] = [];
  const responses: { action: DiploAction; text: string }[] = []; const military: Order[] = [];
  const extra: Rationale[] = [];
  const threats: DecisionOutput['threats'] = [];
  const addStance = (c: StanceCand) => { if (canDeploy && i.geo.zones[c.zoneId]) stances.push(c); };
  const addDiplo = (kind: DiploKind, target: string, c: Cand) => { if (kind === 'UNSC_DRAFT' || others.has(target)) diplo.push({ ...c, kind, target, key: kind === 'UNSC_DRAFT' ? 'UNSC' : target }); };
  const addLetter = (to: string, tone: LetterTone, gist: string, score: number) => { if (others.has(to)) letters.push({ to, tone, gist: gist.slice(0, LETTER_LIMITS.gist), score }); };
  const soften = (target: string): DiploKind => (soft || rel(target).trust < 0 ? 'BACKCHANNEL' : 'REASSURANCE');

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
    const dk = r.diplo && (r.target || r.diplo === 'UNSC_DRAFT') ? r.diplo : null;
    const parts = [st ? `${STANCE_IT[st]} in ${r.zoneId} (intensità 3)` : '', dk ? `${DIPLO_IT[dk]}${r.target && dk !== 'UNSC_DRAFT' ? ` a ${r.target}` : ''}` : ''].filter(Boolean);
    const c: Cand = { score: P.score.red_line, rule: 'red_line', text: `Linea rossa «${rl.text}» superata (${rl.response}): ${parts.join(' e ') || 'nessuna forza disponibile'}` };
    if (st) addStance({ ...c, zoneId: r.zoneId!, stance: st, intensity: 3 });
    if (dk) addDiplo(dk, dk === 'UNSC_DRAFT' ? 'UNSC' : r.target!, c);
    if (!st && !dk) extra.push({ rule: c.rule, text: c.text });
    if (r.target) addLetter(r.target, 'firm', `Avvertire ${nm(r.target)} che il nostro Governo considera superata una linea rossa («${rl.text}») e ne trarrà le conseguenze.`, P.score.red_line);
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
    if (force && x.zoneId && canDeploy && i.geo.zones[x.zoneId]) addStance({ zoneId: x.zoneId, stance: 'show_of_force', intensity: x.kind === 'engagement' || x.kind === 'strike' ? 3 : 2, score, rule: 'threat', text: `Risposta ${act.a} di ${x.from}${where}: dimostrazione di forza` });
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
    for (const z of zones) {
      const w = interest(z);
      if (detente) { addStance({ zoneId: z, stance: 'patrol', intensity: 1, score: P.score.detente, rule: 'detente', text: `Crisi ${c.id} a ${c.escalation}/10 in ${z}: distensione, solo pattugliamento leggero` }); continue; }
      const intensity = clamp3(Math.ceil((c.escalation / 10) * w * 3));
      const stance = involved ? 'presence' : 'patrol';
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
      const kind = soften(other);
      addDiplo(kind, other, { score, rule: 'objective', text: say(`${DIPLO_IT[kind]} a ${other}`) });
      addLetter(other, soft ? 'conciliatory' : 'cordial', `Rafforzare la fiducia tra i nostri Governi e proporre a ${nm(other)} una cooperazione concreta sulle questioni di comune interesse.`, score);
    }
  }

  // 6) alleati sotto pressione (atto ostile di una fazione non alleata): scorta al traffico nella zona o rassicurazione
  const pressured = new Map<string, Incident>();
  for (const x of k.incidents) {
    if (x.to === me || x.from === me || !isHostile(x) || !others.has(x.to) || !isAlly(x.to) || isAlly(x.from)) continue;
    const cur = pressured.get(x.to);
    if (!cur || severity(x) > severity(cur)) pressured.set(x.to, x);
  }
  const ally = [...pressured.values()].sort((a, b) => severity(b) - severity(a) || a.to.localeCompare(b.to))[0];
  if (ally) {
    const act = ACT[ally.kind as Hostile]; const z = ally.zoneId;
    if (z && canDeploy && i.geo.zones[z] && i.geo.zones[z]!.terrain !== 'land' && interest(z) >= P.minInterest)
      addStance({ zoneId: z, stance: 'escort_shipping', intensity: 1, score: P.score.ally, rule: 'ally', text: `Sostegno a ${ally.to} dopo ${act.noun} di ${ally.from} in ${z}: scorta al traffico` });
    else addDiplo('REASSURANCE', ally.to, { score: P.score.ally, rule: 'ally', text: `Sostegno a ${ally.to} dopo ${act.noun} di ${ally.from}: rassicurazione` });
  }

  // 7) cyber: solo verso avversari (mai alleati), con probabilità cyberPropensity × offense / 10, un'operazione al turno
  const adversaries = [...others].filter((x) => !isAlly(x) && rel(x).trust <= P.adversaryTrust && rel(x).tension >= P.adversaryTension)
    .sort((a, b) => (rel(a).trust - rel(a).tension) - (rel(b).trust - rel(b).tension) || a.localeCompare(b));
  const target = adversaries[0];
  if (target && p.cyberPropensity > 0 && f.cyber.offense > 0 && f.budget.discretionary >= PARAMS.sortieCost.CYBER_OP) {
    const r = rel(target);
    if (i.rng.chance(`regole ${me}: operazione cyber contro ${target}`, Math.min(1, (p.cyberPropensity * f.cyber.offense) / 10)).ok) {
      const effect = p.aggressiveness >= P.cyberDisruption.aggressiveness && r.tension >= P.cyberDisruption.tension ? 'disruption' : 'espionage';
      military.push({ id: '', kind: 'CYBER_OP', target, targetRef: 'reti governative', effect });
      extra.push({ rule: 'cyber', text: `Operazione cyber (${effect}) contro ${target}: avversario, fiducia ${r.trust}, tensione ${r.tension}` });
    }
  }

  // accordi proposti alla fazione da altri: si accetta con fiducia sufficiente (tregue e migrazione anche sotto, se non assertiva)
  for (const a of k.knownAgreements.filter((x) => x.status === 'proposed' && x.parties.includes(me) && x.parties[0] !== me).sort((x, y) => x.id.localeCompare(y.id))) {
    const from = a.parties[0]!; const t = rel(from).trust;
    const accept = t >= P.acceptTrust || ((a.type === 'ceasefire' || a.type === 'migration') && p.diplomacyStyle !== 'assertive');
    responses.push({ action: { id: '', kind: 'RESPOND_AGREEMENT', agreementId: a.id, response: accept ? 'accept' : 'reject' }, text: `Accordo ${a.id} (${a.type}) proposto da ${from}: ${accept ? 'accettato' : 'respinto'} (fiducia ${t})` });
  }

  // routine: nessuna postura da altre regole → pattugliamento leggero della zona di maggiore interesse
  if (!stances.length && canDeploy) {
    const z = topZone(true) ?? topZone();
    if (z) addStance({ zoneId: z, stance: 'patrol', intensity: 1, score: P.score.routine, rule: 'routine', text: `Pattugliamento di routine in ${z} (zona di maggiore interesse)` });
  }

  // scelta: una postura per zona e un'azione per destinatario (vince il punteggio più alto), nei tetti del profilo
  const oneEach = <T extends Cand>(list: T[], key: (c: T) => string) => {
    const m = new Map<string, T>();
    for (const c of list) { const cur = m.get(key(c)); if (!cur || c.score > cur.score) m.set(key(c), c); }
    return [...m.values()].sort((a, b) => byScore(a, b) || key(a).localeCompare(key(b)));
  };
  const rankedStances = oneEach(stances, (c) => c.zoneId);
  const chosenStances = rankedStances.slice(0, p.maxStancesPerTurn);
  // le altre regole che chiedevano la stessa postura nella stessa zona: soddisfatte dalla scelta (intensità massima), citate nelle motivazioni
  const joined = chosenStances.flatMap((c) => {
    const same = stances.filter((x) => x !== c && x.zoneId === c.zoneId && x.stance === c.stance);
    const n = clamp3(Math.max(c.intensity, ...same.map((x) => x.intensity)));
    if (n !== c.intensity) { c.intensity = n; c.text = c.text.replace(/intensità \d/, `intensità ${n}`); }
    return same.filter((x, j) => same.findIndex((y) => y.text === x.text) === j && x.text !== c.text);
  });
  const rankedDiplo = oneEach(diplo, (c) => c.key);
  const chosenDiplo = rankedDiplo.slice(0, P.maxDiplomacy);
  // una lettera per destinatario (la ragione più forte), al massimo due: il tetto per fazione e per turno lo applica il motore
  const chosenLetters = [...letters].sort((a, b) => b.score - a.score || a.to.localeCompare(b.to))
    .filter((l, j, all) => all.findIndex((x) => x.to === l.to) === j).slice(0, 2);

  const zoneStances: ZoneStance[] = chosenStances.map((c) => ({ zoneId: c.zoneId, stance: c.stance, intensity: c.intensity }));
  const diplomacy: DiploAction[] = [...chosenDiplo.map((c) => diploAction(c.kind, c.target)), ...responses.map((r) => r.action)];
  const rationale: Rationale[] = [
    ...chosenStances, ...joined, ...chosenDiplo, ...extra, ...responses.map((r) => ({ rule: 'agreement' as const, text: r.text })),
  ].map((c) => ({ rule: c.rule, text: c.text })).sort((a, b) => ruleRank(a.rule) - ruleRank(b.rule));
  const optionsConsidered = [
    ...rankedStances.map((c, j) => ({ label: `${c.rule}: ${STANCE_IT[c.stance]} in ${c.zoneId}`, summary: c.text, expectedGain: +(c.score / 100).toFixed(2), risk: RISK[c.stance] ?? 0.2, chosen: j < p.maxStancesPerTurn })),
    ...rankedDiplo.map((c, j) => ({ label: `${c.rule}: ${DIPLO_IT[c.kind]} a ${c.target}`, summary: c.text, expectedGain: +(c.score / 100).toFixed(2), risk: RISK[c.kind] ?? 0.2, chosen: j < P.maxDiplomacy })),
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
      target = c?.involved.filter((x) => x !== me && others.has(x)).sort((a, b) => rel(a).trust - rel(b).trust || a.localeCompare(b))[0] ?? null;
    } else if (t?.fn === 'infra') zoneId = i.geo.infrastructure[t.args[0]!]?.zoneId ?? null;
    else if (t?.fn === 'relation') { target = other(t.args[0] === me ? t.args[1] : t.args[0]); zoneId = target ? zoneOf(target) : null; }
    else if (t?.fn === 'faction') { zoneId = zoneOf(t.args[0]!); target = null; }
    zoneId ??= topZone();
    let stance: StanceCand['stance'] | null = null; let diplo: DiploKind | null = null;
    if (/sanzion/.test(txt)) diplo = 'SANCTION';
    if (/consiglio di sicurezza|\bonu\b|nazioni unite/.test(txt)) diplo = 'UNSC_DRAFT';
    if (/minacc/.test(txt)) { diplo = 'THREAT'; stance = 'show_of_force'; }
    if (/strike|attacc|militar|mobilitaz|naval/.test(txt)) stance = 'show_of_force';
    if (/rinforz|schier|contingent/.test(txt)) stance ??= 'presence';
    if (!stance && !diplo) stance = 'presence';
    if ((diplo === 'THREAT' || diplo === 'SANCTION') && !target) diplo = null;
    return { stance, diplo, zoneId, target };
  }

  /** Azione diplomatica con testo da modello di frase (niente LLM). */
  function diploAction(kind: DiploKind, target: string): DiploAction {
    const who = nm(target);
    switch (kind) {
      case 'DEMARCHE': return { id: '', kind, target, message: `Il Governo protesta formalmente con ${who} e chiede spiegazioni sulle azioni del turno precedente.`, visibility: 'public' };
      case 'THREAT': return { id: '', kind, target, message: `Il Governo avverte ${who}: ogni ulteriore azione ostile avrà una risposta adeguata.`, visibility: 'public' };
      case 'REASSURANCE': return { id: '', kind, target, message: `Il Governo conferma a ${who} la volontà di cooperare e di evitare ogni escalation.`, visibility: 'public' };
      case 'BACKCHANNEL': return { id: '', kind, target, message: `Proposta riservata a ${who}: aprire un canale diretto per abbassare la tensione.` };
      case 'SANCTION': return { id: '', kind, target, scope: 'misure economiche mirate' };
      case 'PROPOSE_AGREEMENT': return { id: '', kind, target: [target], agreement: { type: 'ceasefire', parties: [me, target], terms: `Tregua e canale militare diretto tra ${nm(me)} e ${who}`, endTurn: null, visibility: 'public' } };
      case 'UNSC_DRAFT': return { id: '', kind, subject: `Richiesta di ${nm(me)} al Consiglio di sicurezza dopo il superamento di una linea rossa` };
    }
  }
}
