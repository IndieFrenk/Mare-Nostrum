import type { Engagement, FactionOrders, GameEvent, LetterTone, WorldState } from '../schemas/index.js';
import { LETTER_LIMITS } from '../schemas/index.js';
import { diploActs } from './opinion.js';
import { PARAMS } from './params.js';

/**
 * Inneschi deterministici delle lettere IA di iniziativa: i modelli piccoli compilano di rado `letterIntents`, quindi il motore
 * fa scrivere una fazione quando nel turno precedente è successo qualcosa che una cancelleria vera non lascerebbe senza lettera.
 * Funzione pura sui dati del turno precedente (eventi, ordini, stati di chiusura): il replay la ricalcola identica.
 */
export type LetterTriggerKind = 'threat' | 'blockade' | 'sanction' | 'engagement' | 'tension' | 'agreement';
export interface LetterTrigger { factionId: string; to: string; kind: LetterTriggerKind; tone: LetterTone; gist: string }

export interface TriggerInput {
  /** stato attuale (fazioni, zone): chi può scrivere e i nomi da citare */
  state: WorldState;
  /** fazioni IA che possono scrivere */
  writers: string[];
  /** eventi e ordini del turno precedente */
  prevEvents: GameEvent[];
  prevOrders: FactionOrders[];
  /** stato a fine turno precedente e a fine del turno prima ancora (per la variazione di tensione); null al primo turno */
  prevState: WorldState | null;
  prevPrevState: WorldState | null;
}

/** Priorità dentro la stessa fazione: prima ciò che la fazione ha subito, poi gli accordi, poi la tensione. */
const RANK: Record<LetterTriggerKind, number> = { engagement: 0, threat: 1, blockade: 2, sanction: 3, agreement: 4, tension: 5 };

export function letterTriggers(i: TriggerInput): LetterTrigger[] {
  const s = i.state;
  const writers = new Set(i.writers);
  const name = (f: string) => s.factions[f]?.name ?? f;
  const zone = (z: string) => s.zones[z]?.name ?? z;
  const ok = (from: string, to: string) => from !== to && writers.has(from) && !!s.factions[to] && s.factions[to]!.kind !== 'bloc';
  const out: LetterTrigger[] = [];
  const add = (factionId: string, to: string, kind: LetterTriggerKind, tone: LetterTone, gist: string) => {
    if (ok(factionId, to)) out.push({ factionId, to, kind, tone, gist: gist.slice(0, LETTER_LIMITS.gist) });
  };

  // minacce e sanzioni ricevute (dagli ordini del turno precedente)
  for (const o of i.prevOrders) for (const d of o.diplomacy) {
    if (d.kind === 'THREAT') add(d.target, o.factionId, 'threat', 'firm', `Rispondere con fermezza alla minaccia ricevuta da ${name(o.factionId)}: le minacce non cambiano la posizione del nostro Governo, che resta aperto al dialogo.`);
    if (d.kind === 'SANCTION') add(d.target, o.factionId, 'sanction', 'firm', `Protestare contro le sanzioni decise da ${name(o.factionId)} e chiederne la revoca: danneggiano i rapporti tra i due Paesi.`);
  }
  // blocco navale: l'atto colpisce chi aveva unità nella zona (nota scritta da adjudication.ts, mai propagata)
  for (const act of diploActs(i.prevEvents)) {
    if (!act.note.startsWith('BLOCKADE in ')) continue;
    const z = act.note.slice('BLOCKADE in '.length);
    add(act.b, act.a, 'blockade', 'firm', `Protestare contro il blocco navale di ${name(act.a)} in ${zone(z)} e chiedere la libertà di navigazione.`);
  }
  for (const e of i.prevEvents) {
    const p = e.payload as Record<string, unknown>;
    // ingaggio: ogni parte scrive alle altre
    if (e.type === 'ENGAGEMENT_OPENED') {
      const eng = p.engagement as Engagement;
      for (const a of eng.sides) for (const b of eng.sides) if (a.factionId !== b.factionId)
        add(a.factionId, b.factionId, 'engagement', 'firm', `Chiedere conto dello scontro con le forze di ${name(b.factionId)} in ${zone(eng.zoneId)} ed evitare che si ripeta.`);
    }
    // accordo appena accettato: la fazione che l'ha accettato scrive alla controparte (chi l'ha proposto, o la prima altra parte)
    if (e.type === 'AGREEMENT_CHANGED' && (p.agreement as { status?: string })?.status === 'active' && e.actor && writers.has(e.actor)) {
      const ag = p.agreement as { id: string; type: string; parties: string[] };
      const other = ag.parties.find((x) => x !== e.actor && ok(e.actor, x));
      if (other) add(e.actor, other, 'agreement', 'cordial', `Confermare l'impegno del nostro Governo sull'accordo (${ag.type}) appena accettato con ${name(other)} e proporne l'attuazione.`);
    }
  }
  // tensione salita di almeno PARAMS.letterTriggers.tensionJump punti in un turno
  if (i.prevState && i.prevPrevState) {
    for (const a of [...writers].sort()) for (const [b, rel] of Object.entries(i.prevState.relations[a] ?? {}).sort(([x], [y]) => x.localeCompare(y))) {
      const before = i.prevPrevState.relations[a]?.[b]?.tension;
      if (before !== undefined && rel.tension - before >= PARAMS.letterTriggers.tensionJump)
        add(a, b, 'tension', 'formal', `La tensione con ${name(b)} è salita bruscamente: chiarire le intenzioni dei due Governi ed evitare un'escalation.`);
    }
  }
  // una lettera per coppia (la ragione più grave), ordine stabile
  const seen = new Set<string>();
  return out.sort((x, y) => x.factionId.localeCompare(y.factionId) || RANK[x.kind] - RANK[y.kind] || x.to.localeCompare(y.to))
    .filter((t) => { const k = `${t.factionId}>${t.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
