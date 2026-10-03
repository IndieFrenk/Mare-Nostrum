import { h } from '../dom';
import { FORUM_NAME, OPINION_LABELS, TREATY_CATS } from '../layers/diplomacy';
import { NAMES } from '../layers/factions';
import { set, type UiState } from '../state/store';

const swatch = (color: string, label: string) => h('li', {}, h('i', { style: `background:${color}` }), label);
const short = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Legenda della modalità mappa (opinione, trattati, voto) con i suoi comandi: la direzione dell'opinione, il voto mostrato. I colori sono variabili CSS
 * (`--wg-op-*`, `--wg-tr-*`, `--wg-vote-*`): una scala divergente blu–arancio, leggibile anche da chi non distingue rosso e verde, e ogni voce ha il nome scritto.
 */
export function legend(s: UiState) {
  const box = (title: string, ...children: (Node | string | null)[]) => h('div', { id: 'wg-legend', class: 'wg-float', role: 'group', 'aria-label': `Legenda: ${title}` }, h('b', {}, title), ...children);
  if (s.mapMode === 'opinione') {
    const out = s.opinionDir === 'out';
    const dir = (value: 'out' | 'in', label: string) => h('button', { class: s.opinionDir === value ? 'on' : '', 'aria-pressed': String(s.opinionDir === value), onclick: () => set({ opinionDir: value }) }, label);
    return box('Opinione', h('div', { class: 'wg-seg' }, dir('out', 'Italia → Stati'), dir('in', 'Stati → Italia')),
      h('ul', { class: 'wg-sw' }, OPINION_LABELS.map((l, i) => swatch(`var(--wg-op-${i})`, l)), swatch('var(--wg-self)', 'Italia'), swatch('var(--wg-none)', 'nessun dato')),
      h('small', { class: 'wg-dim' }, out ? 'Come l\'Italia vede ogni Stato. Il valore (−100…+100) e i motivi sono nella scheda del paese.' : 'Come gli Stati vedono l\'Italia: solo la fascia. Il numero esatto serve un accordo di intelligence.'));
  }
  if (s.mapMode === 'trattati') {
    const me = s.campaign?.playerFaction ?? 'ITA';
    const center = s.country ?? me;
    const name = center === me ? 'Italia' : NAMES[center] ?? s.countryDiplo?.name ?? center;
    return box(`Trattati: ${name}`,
      h('ul', { class: 'wg-sw' }, TREATY_CATS.map((c) => h('li', {}, h('i', { class: 'wg-ln', style: `border-top:4px ${c.dash} var(--wg-tr-${c.id})` }), c.label))),
      h('small', { class: 'wg-dim' }, 'Linea chiara = proposto. Clic su un paese per vedere i suoi trattati visibili.'));
  }
  if (s.mapMode === 'voto') {
    const v = s.votes.find((x) => x.id === s.voteId) ?? s.votes[0];
    const pick = h('select', { 'aria-label': 'Votazione mostrata', onchange: (e: Event) => set({ voteId: (e.target as HTMLSelectElement).value }) },
      s.votes.map((x) => h('option', { value: x.id, selected: x.id === v?.id }, `${x.date ?? `T${x.turn}`} · ${x.forum} · ${short(x.subject, 36)}`)));
    return box('Voto', s.votes.length ? [pick,
      h('p', { class: 'wg-vote-title' }, v ? `«${short(v.subject, 90)}» — ${FORUM_NAME[v.forum] ?? v.forum}, ${v.date ?? `turno ${v.turn}`}: ${v.passed ? 'approvata' : 'respinta'}` : ''),
      h('small', { class: 'wg-dim' }, v ? `${v.yes.length} sì · ${v.no.length} no · ${v.abstain.length} astenuti${v.vetoes.length ? ` · veto: ${v.vetoes.join(', ')}` : ''} — ${v.rule}` : '')] as never
      : h('small', { class: 'wg-dim' }, 'Nessuna votazione ancora: si propone una risoluzione dal pannello Istituzioni.'),
    h('ul', { class: 'wg-sw' }, swatch('var(--wg-vote-yes)', 'sì'), swatch('var(--wg-vote-no)', 'no'), swatch('var(--wg-vote-abstain)', 'astenuto'), swatch('var(--wg-vote-absent)', 'assente')));
  }
  return null;
}
