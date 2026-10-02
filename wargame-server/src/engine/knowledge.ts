import type { Contact, DiploLetter, DiploMessage, FactionKnowledge, GameEvent, Incident, IntelReport, NewsItem, WorldState } from '../schemas/index.js';
import { diploActs, opinionBand, opinionOf, tensionOf } from './opinion.js';
import { hashString } from './rng.js';

const INTENT = ['guerra aperta', 'confronto armato limitato', 'coercizione', 'competizione', 'cooperazione'];

/** Rimuove ogni riferimento alla verità di terra prima che il contatto lasci il motore. */
export function stripContact({ truthUnitId: _t, ...c }: Contact): Omit<Contact, 'truthUnitId'> {
  return c;
}

export const letterVisibleTo = (l: DiploLetter, f: string) => l.visibility === 'public' || l.from === f || l.to === f;

const visibleTo = (e: GameEvent, f: string) => e.visibility === 'public' || e.visibility.includes(f) || e.actor === f;
/** nota della relazione (scritta da diplomacy.ts, adjudication.ts, combat.ts) → tipo di atto; le propagazioni agli alleati no */
const NOTE_KINDS: [RegExp, Incident['kind']][] = [
  [/^minaccia:/, 'threat'], [/^lettera \(threatening\)/, 'threat'], [/^dichiarazione minacciosa/, 'threat'], [/^sanzioni:/, 'sanction'],
  [/^(BLOCKADE|EXCLUSION_ZONE) in /, 'blockade'], [/^dimostrazione di forza in /, 'show_of_force'], [/^scontro in /, 'engagement'],
  [/^strike su /, 'strike'], [/^attacco cyber attribuito/, 'cyber'], [/^operazione clandestina scoperta/, 'sof'],
];
/** incidenti per fazione nella conoscenza: tutti quelli che la riguardano, più i più recenti tra gli altri */
const MAX_OTHER_INCIDENTS = 40;

/**
 * Atti ostili o di pressione del turno precedente che la fazione ha VISTO (eventi a lei visibili, come la sua inbox): minacce,
 * sanzioni, blocchi, scontri (per entrambe le parti), strike, cyber e SOF attribuiti, dimostrazioni di forza, linee rosse superate.
 * Niente verità di terra: un'operazione coperta non attribuita o un canale riservato tra altri non ci sono.
 */
export function incidentsFrom(events: GameEvent[], factionId: string): Incident[] {
  const out: Incident[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  // gli atti diplomatici (nuovi OPINION_MODIFIER/TENSION_CHANGED o vecchi RELATION_CHANGED) con la loro nota: uno per evento
  const acts = new Map(diploActs(sorted).map((x) => [x.event.id, x]));
  for (const e of sorted) {
    if (!visibleTo(e, factionId)) continue;
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'RED_LINE_CROSSED' && e.actor === factionId) { out.push({ turn: e.turn, kind: 'red_line', from: e.actor, to: e.actor, ref: String(p.redLineId) }); continue; }
    const act = acts.get(e.id);
    if (!act) continue;
    const kind = NOTE_KINDS.find(([re]) => re.test(act.note))?.[1];
    if (!kind) continue;
    const zoneId = / in ([A-Z_]+)$/.exec(act.note)?.[1];
    const ref = e.causedBy?.orderId;
    const one = (from: string, to: string): Incident => ({ turn: e.turn, kind, from, to, ...(zoneId && kind !== 'threat' ? { zoneId } : {}), ...(ref ? { ref } : {}) });
    out.push(one(act.a, act.b));
    // uno scontro lo subiscono entrambe le parti
    if (kind === 'engagement') out.push(one(act.b, act.a));
  }
  const seen = new Set<string>();
  const unique = out.filter((x) => { const key = `${x.kind}|${x.from}|${x.to}|${x.zoneId ?? ''}|${x.ref ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const mine = unique.filter((x) => x.from === factionId || x.to === factionId);
  return [...mine, ...unique.filter((x) => x.from !== factionId && x.to !== factionId).slice(-MAX_OTHER_INCIDENTS)];
}

export function buildKnowledge(s: WorldState, factionId: string, contacts: Contact[], extra: { inbox: DiploMessage[]; news: NewsItem[]; reports?: IntelReport[]; letters?: DiploLetter[]; prevEvents?: GameEvent[] }): FactionKnowledge {
  const f = s.factions[factionId];
  const beliefs: FactionKnowledge['beliefs'] = {};
  for (const o of Object.values(s.factions)) {
    if (o.id === factionId || o.kind === 'bloc') continue;
    const noise = (hashString(`${factionId}:${o.id}:${s.turn}`) % 3) - 1;
    const est = Math.max(1, Math.min(5, o.posture + noise));
    beliefs[o.id] = { estPosture: est, estIntent: INTENT[est - 1], confidence: noise === 0 ? 0.6 : 0.4 };
  }
  return {
    schemaVersion: 1, factionId, turn: s.turn,
    ownUnits: Object.values(s.units).filter((u) => u.factionId === factionId),
    ownFaction: f,
    contacts: contacts.map(stripContact),
    intelReports: extra.reports ?? [],
    beliefs,
    knownCrises: Object.values(s.crises).filter((c) => c.status !== 'latent' || c.involved.includes(factionId))
      .map((c) => ({ ...c, escalation: Math.round(c.escalation), history: c.history.slice(-3) })),
    knownAgreements: Object.values(s.agreements).filter((a) => a.visibility === 'public' || a.visibility.includes(factionId) || a.parties.includes(factionId)),
    inbox: extra.inbox.filter((m) => m.to === factionId),
    publicNews: extra.news,
    letters: (extra.letters ?? []).filter((l) => letterVisibleTo(l, factionId) && l.turn >= s.turn - 3),
    incidents: incidentsFrom(extra.prevEvents ?? [], factionId),
    ownRelations: ownRelations(s, factionId),
  };
}

/**
 * La riga della fazione: la sua opinione degli altri (`trust` = opinionOf(lei → altra)) e la tensione di coppia. Come le altre
 * vedono lei si dà solo a fasce; il numero esatto solo con un accordo di intelligence attivo tra le due. Le coppie tra terzi non ci sono.
 */
export function ownRelations(s: WorldState, f: string): FactionKnowledge['ownRelations'] {
  const intel = Object.values(s.agreements).filter((a) => a.status === 'active' && a.type === 'intel_sharing' && a.parties.includes(f));
  return Object.fromEntries(Object.keys(s.relations[f] ?? {}).sort((a, b) => a.localeCompare(b)).map((b) => {
    const theirs = opinionOf(s, b, f).value;
    return [b, {
      trust: opinionOf(s, f, b).value, tension: Math.round(tensionOf(s, f, b) * 10) / 10, opinionOfMe: opinionBand(theirs),
      ...(intel.some((a) => a.parties.includes(b)) ? { opinionOfMeExact: theirs } : {}),
    }];
  }));
}
