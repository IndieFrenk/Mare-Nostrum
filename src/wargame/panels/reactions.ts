import { loadReactions } from '../actions';
import { h } from '../dom';
import { NAMES } from '../layers/factions';
import type { UiState } from '../state/store';

/** l'atto grave in italiano, come lo dice il motore (engine/chancery.ts EVENT_NOUN) */
const NOUN: Record<string, string> = {
  strike: 'attacco', engagement: 'scontro armato', blockade: 'blocco navale', ultimatum: 'ultimatum', sanction: 'sanzioni', multilateral_sanction: 'sanzioni multilaterali',
  break: 'rottura delle relazioni', embargo: 'embargo sulle armi', cyber: 'attacco cyber', covert: 'operazione clandestina', block_sanctions: 'sanzioni di blocco',
};
const POSITION: Record<string, string> = { condemn: 'condanna', support: 'sostiene', silence: 'tace' };
const TOP = 6;

interface Reaction {
  eventRef: string; kind: string; actor: string; victim: string; severity?: number; zoneId?: string;
  condemn?: string[]; support?: string[]; silent?: string[]; adopters?: string[]; holdouts?: string[];
  statements?: { iso: string; position: string; text: string }[];
}

/**
 * Pannello «Reazioni internazionali»: per ogni atto grave degli ultimi turni chi condanna, chi sostiene e chi tace, con le frasi delle cancellerie
 * se ci sono (le scrive il ruolo chancery sulla posizione scelta dal motore) o, altrimenti, un testo deterministico fatto dai soli numeri del motore.
 * Si legge dagli eventi pubblici INTERNATIONAL_REACTIONS; senza eventi non è un errore.
 */
export function reactionsPanel(s: UiState) {
  if (s.reactions === null) { void loadReactions(); return h('p', { class: 'wg-dim' }, 'Caricamento…'); }
  if (!s.reactions.length) return h('div', {}, h('p', { class: 'wg-dim' }, 'Nessuna reazione registrata.'), h('p', { class: 'wg-dim' }, 'Compaiono dopo un atto grave: scontri, strike, blocchi, ultimatum scaduti, sanzioni.'));
  const pop = (iso: string) => s.nations.find((n) => n.iso3 === iso)?.population ?? 0;
  const nation = (iso: string) => s.nations.find((n) => n.iso3 === iso)?.nameIt ?? iso;
  const actor = (a: string) => (a === 'world' ? 'il mondo' : NAMES[a] ?? s.nations.find((n) => (n.factionId ?? n.iso3) === a)?.nameIt ?? a);
  /** i più popolosi per primi, a parità per codice: «Francia, Germania e altri 12 Stati» */
  const list = (isos: string[]) => {
    const top = [...isos].sort((a, b) => pop(b) - pop(a) || a.localeCompare(b)).slice(0, TOP).map(nation);
    return `${top.join(', ')}${isos.length > TOP ? ` e altri ${isos.length - TOP}` : ''}`;
  };
  const line = (label: string, isos?: string[]) => (isos?.length ? h('p', {}, h('b', {}, `${label} (${isos.length}): `), list(isos)) : null);
  const rows = [...s.reactions].sort((a, b) => b.turn - a.turn || ((b.event.payload as unknown as Reaction).severity ?? 0) - ((a.event.payload as unknown as Reaction).severity ?? 0));
  return h('div', {}, rows.map(({ turn, event }) => {
    const r = event.payload as unknown as Reaction;
    const noun = NOUN[r.kind] ?? 'atto grave';
    const say = r.statements ?? [];
    return h('div', { class: 'wg-card' },
      h('h4', {}, `T${turn} · ${noun[0]!.toUpperCase()}${noun.slice(1)}: ${actor(r.actor)} contro ${actor(r.victim)}${r.severity !== undefined ? ` · gravità ${r.severity}` : ''}`),
      r.kind === 'block_sanctions'
        ? [line('Adottano le sanzioni', r.adopters), line('Resistono', r.holdouts)]
        : [line('Condannano', r.condemn), line('Sostengono', r.support), line('Tacciono', r.silent)],
      say.length ? h('ul', {}, say.map((x) => h('li', {}, h('b', {}, `${nation(x.iso)} (${POSITION[x.position] ?? x.position}): `), `«${x.text}»`)))
        : h('p', { class: 'wg-dim' }, 'Nessuna dichiarazione delle cancellerie: restano le posizioni calcolate dal motore.'));
  }));
}
