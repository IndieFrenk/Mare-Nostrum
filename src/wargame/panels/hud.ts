import type { Order } from '../api-client';
import { selectUnit } from '../actions';
import { h } from '../dom';
import { newId, set, state, type UiState } from '../state/store';

export function meter(label: string, v: number, lo: number, hi: number) {
  const t = (v - lo) / (hi - lo);
  return h('div', { class: 'wg-meter' }, h('span', {}, `${label} ${v}`), h('b', { style: `width:${Math.round(t * 100)}%` }));
}

/** Ordine rapido: tasto destro su una zona con unità selezionate. */
export function orderToZone(zoneId: string) {
  const s = state;
  if (s.campaign?.phase !== 'PLAYER_ORDERS') return set({ error: 'Gli ordini si danno nella fase PLAYER_ORDERS.' });
  if (!s.selection.length) return;
  const zone = s.layers.zones?.features.find((f) => f.id === zoneId);
  const units = (s.knowledge?.ownUnits ?? []).filter((u) => s.selection.includes(u.id));
  const land = zone?.properties?.terrain === 'land';
  const ok = units.filter((u) => !(land && (u.domain === 'sea' || u.domain === 'subsurface')));
  if (!ok.length) return set({ error: `${zoneId}: zona terrestre, le unità navali non possono raggiungerla.` });
  const ids = ok.map((u) => u.id);
  const order: Order = ok.every((u) => u.domain === 'land') ? { id: newId('m'), kind: 'MOVE', unitIds: ids, to: zoneId, speed: 'cruise' } : { id: newId('m'), kind: 'PATROL', unitIds: ids, zoneId, roe: 'WEAPONS_TIGHT' };
  const military = s.draft.military.map((o) => ('unitIds' in o ? { ...o, unitIds: o.unitIds.filter((x) => !ids.includes(x)) } : o)).filter((o) => !('unitIds' in o) || o.unitIds.length);
  set({ draft: { ...s.draft, military: [...military, order] }, validation: null, submitted: false, error: null });
}

function quick(kind: 'RETURN_TO_BASE' | 'REPAIR' | 'STAND_DOWN') {
  const ids = state.selection;
  const military = state.draft.military.map((o) => ('unitIds' in o ? { ...o, unitIds: o.unitIds.filter((x) => !ids.includes(x)) } : o)).filter((o) => !('unitIds' in o) || o.unitIds.length);
  set({ draft: { ...state.draft, military: [...military, { id: newId('m'), kind, unitIds: ids }] }, validation: null, submitted: false });
}

/** Riquadro in basso a sinistra: pila aperta o unità selezionate, con ordini rapidi. */
export function selectionCard(s: UiState) {
  const stack = s.stack;
  const units = s.knowledge?.ownUnits ?? [];
  const list = stack ?? s.selection;
  if (!list.length) return null;
  const planned = new Map(s.draft.military.flatMap((o) => ('unitIds' in o ? o.unitIds.map((id) => [id, `${o.kind}${'zoneId' in o ? ` → ${o.zoneId}` : ''}`] as [string, string]) : [])));
  return h('div', { class: 'wg-float wg-selection' },
    h('header', {}, stack ? `Pila (${list.length})` : `Selezione (${list.length})`, h('button', { onclick: () => { set({ stack: null }); void selectUnit(null); } }, '×')),
    h('ul', {}, list.map((id) => units.find((u) => u.id === id)).filter(Boolean).map((u) => h('li', { class: s.selection.includes(u!.id) ? 'sel' : '', onclick: (e: Event) => selectUnit(u!.id, (e as MouseEvent).shiftKey) },
      h('span', {}, u!.name, u!.count > 1 ? ` (${u!.count})` : ''), h('span', { class: `st-${u!.status}` }, `${u!.status} ${u!.readiness}%`), h('em', {}, planned.get(u!.id) ?? (u!.currentTask as { kind?: string } | null)?.kind ?? '')))),
    s.selection.length ? [
      h('p', { class: 'wg-dim' }, 'Tasto destro su una zona di mare: pattugliamento. Maiusc+clic: selezione multipla.'),
      h('div', { class: 'wg-actions' }, h('button', { onclick: () => quick('RETURN_TO_BASE') }, 'Rientro'), h('button', { onclick: () => quick('REPAIR') }, 'Riparazione'), h('button', { onclick: () => quick('STAND_DOWN') }, 'Stand down')),
    ] : null);
}
