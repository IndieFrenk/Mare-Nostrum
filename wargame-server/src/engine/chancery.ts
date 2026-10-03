import type { ChanceryPosition, ChanceryStatement, Reaction, WorldState } from '../schemas/index.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

/**
 * Cancellerie (docs/wargame/DIPLOMAZIA.md §11): le frasi con cui gli Stati commentano un atto grave. Qui sta tutto ciò che decide il **motore**: quali
 * 6–8 Stati parlano (i più rilevanti: membri del Consiglio di sicurezza, vicini, alleati delle parti) e la **posizione** di ciascuno (condanna, sostegno,
 * silenzio), presa dalla reazione già calcolata dall'IA mondiale. Il ruolo chancery scrive solo il testo; le frasi-modello valgono quando non c'è budget
 * o la frase del modello non passa i controlli (≤ 30 parole, nessun numero inventato, nessun nome di persona).
 */

export interface ChanceryState { iso: string; name: string; position: ChanceryPosition; /** perché è tra i più rilevanti (per il prompt) */ role: string[] }

const nameOf = (s: WorldState, actor: string) => s.factions[actor]?.name ?? worldData().nation(actor)?.nameIt ?? actor;
export const actorOfIso = (iso: string) => worldData().actorOf(iso);

/** Gli atti gravi in italiano (con l'articolo), per le frasi-modello e i titoli. */
export const EVENT_NOUN: Record<string, string> = {
  strike: "l'attacco", engagement: 'lo scontro armato', blockade: 'il blocco navale', ultimatum: "l'ultimatum", sanction: 'le sanzioni', multilateral_sanction: 'le sanzioni multilaterali',
  break: 'la rottura delle relazioni diplomatiche', embargo: "l'embargo sulle armi", cyber: "l'attacco cyber", covert: "l'operazione clandestina",
};

/**
 * I 6–8 Stati che parlano su una reazione, in ordine di rilevanza (a parità per ISO3): tra chi ha una posizione nella reazione (le tre liste), conta essere
 * membro del Consiglio di sicurezza (i permanenti di più), vicino a una delle parti (stessa sottoregione del registro: non ci sono i confini), alleato di
 * una delle parti (stessa alleanza o trattato di difesa attivo), partner commerciale importante, e la popolazione per le parità. Se la reazione ha tutte e
 * tre le posizioni, almeno una voce per posizione (sostituisce le meno rilevanti): il registro delle frasi non è mai a senso unico.
 */
export function pickStates(s: WorldState, r: Pick<Reaction, 'actor' | 'victim' | 'condemn' | 'support' | 'silent'>): ChanceryState[] {
  const w = worldData(); const C = PARAMS.chancery; const W = C.weights;
  const position = new Map<string, ChanceryPosition>([...r.condemn.map((x) => [x, 'condemn'] as const), ...r.support.map((x) => [x, 'support'] as const), ...r.silent.map((x) => [x, 'silence'] as const)]);
  const unsc = w.institution('UNSC');
  const parties = [r.actor, r.victim].map((p) => ({ p, iso: w.isoOf(p), n: w.isoOf(p) ? w.nation(w.isoOf(p)!) : undefined }));
  const alliances = w.institutions.filter((i) => i.effects.includes('collective_defense'));
  const defense = Object.values(s.agreements).filter((a) => a.status === 'active' && (a.type === 'defense' || a.type === 'defense_cooperation'));
  const rows = [...position.keys()].map((iso) => {
    const n = w.nation(iso); const actor = w.actorOf(iso);
    if (!n) return null;
    const role: string[] = []; let score = 0;
    if (unsc?.members.includes(iso)) { score += W.unsc; role.push('membro del Consiglio di sicurezza'); if (unsc.leaders.includes(iso)) { score += W.permanent; role.push('membro permanente'); } }
    for (const { p, n: pn } of parties) {
      if (pn && pn.subregion === n.subregion) { score += W.neighbour; role.push(`vicino di ${nameOf(s, p)}`); }
      const allied = alliances.some((a) => a.members.includes(iso) && pn && a.members.includes(pn.iso3)) || defense.some((a) => a.parties.includes(actor) && a.parties.includes(p));
      if (allied) { score += W.ally; role.push(`alleato di ${nameOf(s, p)}`); }
      if (pn && (pn.topTrade.some((t) => t.iso3 === iso && t.share >= 0.1) || n.topTrade.some((t) => t.iso3 === pn.iso3 && t.share >= 0.1))) { score += W.trade; role.push(`partner commerciale di ${nameOf(s, p)}`); }
    }
    score += W.population * Math.log10(1 + n.population);
    return { iso, score, role: [...new Set(role)], position: position.get(iso)!, name: nameOf(s, actor) };
  }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.score - a.score || a.iso.localeCompare(b.iso));
  const take = Math.min(C.maxStates, rows.length);
  const chosen = rows.slice(0, take);
  // almeno una voce per ogni posizione presente nella reazione: al posto delle meno rilevanti tra quelle in eccesso
  for (const pos of ['condemn', 'support', 'silence'] as const) {
    if (chosen.some((x) => x.position === pos)) continue;
    const best = rows.find((x) => x.position === pos);
    if (!best) continue;
    const counts = (p: ChanceryPosition) => chosen.filter((x) => x.position === p).length;
    const victim = [...chosen].reverse().find((x) => counts(x.position) > 1);
    if (victim) chosen.splice(chosen.indexOf(victim), 1, best);
  }
  return chosen.sort((a, b) => b.score - a.score || a.iso.localeCompare(b.iso)).map(({ iso, name, position: pos, role }) => ({ iso, name, position: pos, role }));
}

/** Frase-modello di una posizione (nessuna cifra, nessun nome di persona): la stessa per lo stesso Stato, atto e posizione. */
export function templateStatement(st: Pick<ChanceryState, 'name' | 'position'>, ev: { kind: string; actorName: string; victimName: string }): string {
  const noun = EVENT_NOUN[ev.kind] ?? "l'accaduto";
  switch (st.position) {
    case 'condemn': return `${st.name} condanna ${noun} di ${ev.actorName} contro ${ev.victimName} e chiede il pieno rispetto del diritto internazionale.`;
    case 'support': return `${st.name} comprende le ragioni di ${ev.actorName} dopo ${noun} e invita tutte le parti alla moderazione.`;
    default: return `${st.name} segue con attenzione gli sviluppi dopo ${noun} e per ora non rilascia commenti.`;
  }
}

// ——— controlli sul testo ———

/** Parole che non sono nomi di persona: Stati, fazioni, istituzioni, zone e alcune parole di uso diplomatico. Costruito una volta dal registro. */
let vocab: Set<string> | null = null;
export function chanceryVocabulary(s: WorldState): ReadonlySet<string> {
  if (!vocab) {
    const w = worldData(); const out = new Set<string>();
    const add = (t: string) => t.split(/[^\p{L}'’]+/u).filter((x) => x.length > 1).forEach((x) => out.add(x.toLowerCase()));
    for (const n of w.nations) { add(n.nameIt); add(n.capital); }
    for (const i of w.institutions) { add(i.nameIt); add(i.name); }
    for (const t of ['Consiglio', 'Sicurezza', 'Nazioni', 'Unite', 'Assemblea', 'Generale', 'Unione', 'Europea', 'Governo', 'Presidente', 'Repubblica', 'Ministero', 'Esteri', 'Mediterraneo', 'Mar', 'Rosso', 'Nero', 'Oriente', 'Medio', 'Nord', 'Sud', 'Africa', 'Europa', 'Asia', 'Occidente', 'Stato', 'Stati', 'Uniti', 'Santa', 'Sede', 'Corte', 'Palazzo']) out.add(t.toLowerCase());
    vocab = out;
  }
  for (const f of Object.values(s.factions)) f.name.split(/[^\p{L}'’]+/u).filter((x) => x.length > 1).forEach((x) => vocab!.add(x.toLowerCase()));
  return vocab;
}

const TITLES = new Set(['presidente', 'ministro', 'premier', 'cancelliere', 're', 'regina', 'emiro', 'segretario', 'ambasciatore', 'generale', 'leader', 'primo', 'sceicco', 'sultano', 'ayatollah', 'senatore', 'onorevole', 'sig.', 'signor', 'signora', 'dottor', 'dott.']);

/**
 * Nomi propri di persona nel testo: una carica seguita da una parola maiuscola che non è un'entità nota («il Presidente Macron»), o due parole maiuscole
 * consecutive sconosciute («Vladimir Putin»). I capi di Stato si indicano solo con la carica («il Presidente della Repubblica», «il Governo»).
 */
export function personNames(text: string, known: ReadonlySet<string>): string[] {
  const tokens = [...text.matchAll(/[\p{L}][\p{L}'’.-]*/gu)].map((m) => m[0]!);
  const cap = (t: string) => /^\p{Lu}[\p{Ll}'’-]{2,}$/u.test(t) && !known.has(t.toLowerCase());
  const found = new Set<string>();
  tokens.forEach((t, i) => {
    if (!cap(t)) return;
    if (i > 0 && TITLES.has(tokens[i - 1]!.toLowerCase())) found.add(t);
    else if (i > 0 && cap(tokens[i - 1]!)) { found.add(tokens[i - 1]!); found.add(t); }
  });
  return [...found];
}

export const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** Frasi nel registro dell'evento: la lista `{iso, position, text}` che va nel payload di INTERNATIONAL_REACTIONS. */
export const statementsOf = (all: ChanceryStatement[], eventId: string) => all.filter((x) => x.eventId === eventId).map(({ iso, position, text, source }) => ({ iso, position, text, source }));
