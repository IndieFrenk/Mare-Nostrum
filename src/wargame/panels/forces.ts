import { selectUnit } from '../actions';
import { h, meur, select } from '../dom';
import { newId, set, state, type UiState } from '../state/store';

let filter = { domain: 'all', status: 'all' };

export function oobPanel(s: UiState, flyTo: (lon: number, lat: number) => void) {
  const units = (s.knowledge?.ownUnits ?? []).filter((u) => (filter.domain === 'all' || u.domain === filter.domain) && (filter.status === 'all' || u.status === filter.status));
  const onFilter = (k: keyof typeof filter) => (e: Event) => { filter = { ...filter, [k]: (e.target as HTMLSelectElement).value }; set({}); };
  return h('div', {},
    h('div', { class: 'wg-row' }, select('domain', ['all', 'sea', 'subsurface', 'air', 'land'], filter.domain, { onchange: onFilter('domain') }), select('status', ['all', 'ready', 'deployed', 'transit', 'maintenance', 'damaged', 'destroyed'], filter.status, { onchange: onFilter('status') })),
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Unità'), h('th', {}, 'Zona'), h('th', {}, 'Stato'), h('th', {}, 'Pront.'), h('th', {}, 'Danno'), h('th', {}, 'Ordine')),
      units.map((u) => h('tr', { class: u.id === s.selectedUnitId ? 'sel' : '', onclick: () => { void selectUnit(u.id); flyTo(u.location.lon, u.location.lat); } },
        h('td', { title: Object.entries(u.loadout).map(([k, v]) => `${k}×${v}`).join(', ') }, u.name, u.count > 1 ? ` (${u.count})` : ''), h('td', {}, u.zoneId), h('td', { class: `st-${u.status}` }, u.status),
        h('td', {}, `${u.readiness}%`), h('td', {}, u.damage ? `${u.damage}%` : '—'), h('td', {}, (u.currentTask as { kind?: string } | null)?.kind ?? '—')))));
}

function sparkline(points: number[]) {
  if (points.length < 2) return null;
  const max = Math.max(...points); const min = Math.min(...points); const w = 280; const hgt = 50;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${hgt - ((p - min) / Math.max(1, max - min)) * hgt}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('class', 'wg-spark');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', d); svg.appendChild(pl);
  return svg;
}

export function foedPanel(s: UiState) {
  const bal = s.knowledge?.ownFaction.budget.discretionary ?? 0;
  const byTurn = new Map<number, number>();
  for (const l of s.ledger) byTurn.set(l.turn, l.balanceAfter);
  const turn = s.campaign?.currentTurn ?? 0;
  const recent = s.ledger.filter((l) => l.turn >= turn - 1).reverse();
  return h('div', {},
    h('div', { class: 'wg-big' }, meur(bal)),
    s.validation ? h('p', {}, `Costo stimato bozza ordini: ${meur(s.validation.estCost)} → saldo previsto ${meur(bal - s.validation.estCost)}`) : h('p', { class: 'wg-dim' }, 'Valida la bozza ordini per stimarne il costo.'),
    sparkline([...byTurn.values()]),
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'T'), h('th', {}, 'Categoria'), h('th', {}, 'Importo'), h('th', {}, 'Saldo'), h('th', {}, 'Nota')),
      recent.map((l) => h('tr', {}, h('td', {}, l.turn), h('td', {}, l.category), h('td', { class: l.amount < 0 ? 'neg' : 'pos' }, meur(l.amount)), h('td', {}, meur(l.balanceAfter)), h('td', {}, l.note)))));
}

export function procurementPanel(s: UiState) {
  const cat = s.catalog;
  if (!cat) return h('p', {}, '…');
  const base = h('select', {}, cat.bases.map((b) => h('option', { value: b.id }, b.name)));
  const turn = s.campaign?.currentTurn ?? 0;
  const cart = state.draft.procurement;
  return h('div', {},
    h('div', { class: 'wg-row' }, h('span', {}, 'Destinazione:'), base),
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Articolo'), h('th', {}, 'Lotto'), h('th', {}, 'Costo'), h('th', {}, 'Lead time'), h('th', {})),
      cat.items.map((i) => h('tr', { class: i.available ? '' : 'wg-dim' }, h('td', {}, i.name), h('td', {}, i.lotSize ?? 1), h('td', {}, meur(i.cost)), h('td', {}, i.leadTimeTurns === null ? 'non rimpiazzabile' : `${i.leadTimeTurns} turni`),
        h('td', {}, i.available ? h('button', { onclick: () => set({ draft: { ...state.draft, procurement: [...cart, { id: newId('p'), itemId: i.id, qty: 1, destinationBaseId: base.value }] }, validation: null }) }, '+') : null)))),
    h('h4', {}, `Carrello (${cart.length})`),
    h('ul', {}, cart.map((p) => h('li', {}, `${p.qty}× ${cat.items.find((i) => i.id === p.itemId)?.name} → ${p.destinationBaseId} `, h('button', { onclick: () => set({ draft: { ...state.draft, procurement: cart.filter((x) => x !== p) } }) }, '×')))),
    h('h4', {}, 'Consegne in arrivo'),
    h('ul', {}, cat.deliveries.map((d) => h('li', {}, `${d.qty}× ${cat.items.find((i) => i.id === d.itemId)?.name} — tra ${Math.max(0, d.deliveryTurn - turn)} turni (${meur(d.totalCost)})`))));
}
