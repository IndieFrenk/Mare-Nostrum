import { selectCountry } from '../actions';
import { h } from '../dom';
import { bandOf, DEFAULT_THRESHOLDS, OPINION_LABELS } from '../layers/diplomacy';
import type { UiState } from '../state/store';

/** testo cercato, tenuto fuori dall'interfaccia che si ridisegna a ogni cambio di stato */
let filter = '';

/**
 * Elenco dei 197 Stati con ricerca: apre la scheda paese anche da tastiera (la mappa si usa con il mouse). Accanto al nome, come l'Italia vede lo Stato
 * (fascia d'opinione, con il nome scritto) e come lui vede l'Italia.
 */
export function statesPanel(s: UiState) {
  const d = s.diplo?.opinion;
  const rows = [...s.nations].sort((a, b) => a.nameIt.localeCompare(b.nameIt, 'it'));
  const list = h('ul', { class: 'wg-states' });
  const fill = () => {
    const q = filter.trim().toLowerCase();
    const shown = rows.filter((n) => !q || n.nameIt.toLowerCase().includes(q) || n.iso3.toLowerCase() === q);
    list.replaceChildren(...shown.map((n) => {
      const actor = n.factionId ?? n.iso3;
      const out = d?.out[actor]; const inn = d?.in[actor];
      const band = out === undefined ? null : bandOf(out, d?.thresholds ?? DEFAULT_THRESHOLDS);
      return h('li', {}, h('button', { class: s.country === actor ? 'on' : '', onclick: () => selectCountry(actor), 'aria-label': `${n.nameIt}${band !== null ? `, l'Italia la vede ${OPINION_LABELS[band]}` : ''}` },
        h('span', {}, n.nameIt),
        band !== null ? h('small', {}, h('i', { style: `background:var(--wg-op-${band})` }), OPINION_LABELS[band], inn !== undefined ? ` ↔ ${OPINION_LABELS[inn]}` : '') : null));
    }));
    if (!shown.length) list.appendChild(h('li', { class: 'wg-dim' }, 'Nessuno Stato con questo nome.'));
  };
  const q = h('input', { type: 'search', placeholder: 'Cerca uno Stato…', 'aria-label': 'Cerca uno Stato', value: filter });
  q.addEventListener('input', () => { filter = q.value; fill(); });
  fill();
  return h('div', {}, q,
    h('p', { class: 'wg-dim' }, `${rows.length} Stati. Invio apre la scheda; accanto al nome: come l'Italia vede lo Stato ↔ come lui vede l'Italia (fasce).`), list);
}
