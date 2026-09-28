import { h } from '../dom';
import type { UiState } from '../state/store';

const heat = (v: number, max: number, invert = false) => {
  const t = Math.max(-1, Math.min(1, v / max)) * (invert ? -1 : 1);
  return `background: ${t >= 0 ? `rgba(60,190,120,${t * 0.6})` : `rgba(230,70,70,${-t * 0.6})`}`;
};

export function diplomacyPanel(s: UiState) {
  const rel = s.overview?.relations ?? {};
  const k = s.knowledge;
  return h('div', {},
    h('p', { class: 'wg-dim' }, 'Le azioni diplomatiche si compongono nella Console Ordini.'),
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Italia ↔'), h('th', {}, 'Fiducia'), h('th', {}, 'Tensione'), h('th', {}, 'Ultimo incidente')),
      Object.entries(rel).sort((a, b) => b[1].tension - a[1].tension).map(([f, r]) => h('tr', {}, h('td', {}, f), h('td', { style: heat(r.trust, 100) }, r.trust), h('td', { style: heat(r.tension - 30, 70, true) }, r.tension), h('td', {}, r.lastIncidentTurn === null ? '—' : `T${r.lastIncidentTurn}`)))),
    h('h4', {}, 'Accordi noti'),
    h('ul', {}, (k?.knownAgreements ?? []).map((a) => h('li', {}, `${a.id} · ${a.type} · ${a.parties.join('/')} · ${a.status} — ${a.terms}`))),
    h('h4', {}, 'Messaggi ricevuti'),
    h('ul', {}, (k?.inbox ?? []).map((m) => h('li', {}, `[${m.channel}] ${m.from}: ${m.text}`))));
}
