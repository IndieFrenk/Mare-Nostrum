import type { DiploAction, Order } from '../api-client';
import { selectUnit } from '../actions';
import { h, pct } from '../dom';
import { FACTIONS, NAMES } from '../layers/factions';
import { composeTo } from './letters';
import { newId, set, state, type UiState } from '../state/store';

const POSTURE = ['', 'guerra aperta', 'confronto armato', 'coercizione', 'competizione', 'pace'];

function addDiplo(a: DiploAction) {
  set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, a] }, validation: null, submitted: false });
}

/** Scheda paese (clic su una nazione): relazioni, stime e azioni diplomatiche rapide. */
export function countryCard(s: UiState, f: string) {
  const rel = s.overview?.relations[f];
  const b = s.knowledge?.beliefs[f];
  const msg = h('input', { placeholder: 'Messaggio (facoltativo)' });
  const text = () => msg.value || 'Richiesta formale del Governo italiano.';
  const agreements = (s.knowledge?.knownAgreements ?? []).filter((a) => a.parties.includes(f));
  const contacts = (s.knowledge?.contacts ?? []).filter((c) => c.estFaction === f).length;
  if (f === 'ITA') {
    const k = s.knowledge!;
    return h('div', { class: 'wg-float wg-country' }, h('header', {}, h('i', { style: `background:${FACTIONS.ITA!.color}` }), 'ITALIA', h('button', { onclick: () => set({ country: null }) }, '×')),
      h('p', {}, `Postura ${k.ownFaction.posture}/5 · stabilità ${k.ownFaction.stability} · credibilità ${k.ownFaction.credibility}`),
      h('p', {}, `${k.ownUnits.filter((u) => u.status === 'deployed' || u.status === 'transit').length} unità schierate su ${k.ownUnits.length}`),
      h('h4', {}, 'Obiettivi nazionali'),
      h('div', { class: 'wg-meters' }, k.ownFaction.objectives.map((o) => meter(`P${o.priority} ${o.text}`, Math.round(o.progress * 100), 0, 100))),
      k.ownFaction.redLines.length ? h('p', { class: 'wg-dim' }, `Linee rosse: ${k.ownFaction.redLines.map((r) => r.text).join('; ')}`) : null);
  }
  const act = (kind: 'REASSURANCE' | 'DEMARCHE' | 'THREAT') => () => addDiplo({ id: newId('d'), kind, target: f, message: text(), visibility: 'public' });
  return h('div', { class: 'wg-float wg-country' },
    h('header', {}, h('i', { style: `background:${FACTIONS[f]?.color ?? '#888'}` }), (NAMES[f] ?? f).toUpperCase(), h('button', { onclick: () => set({ country: null }) }, '×')),
    rel ? h('div', { class: 'wg-meters' }, meter('Fiducia', rel.trust, -100, 100), meter('Tensione', rel.tension, 0, 100)) : null,
    b ? h('p', {}, `Postura stimata: ${POSTURE[b.estPosture]} (confidenza ${pct(b.confidence)})`) : null,
    h('p', { class: 'wg-dim' }, `${contacts} contatti attribuiti · ultimo incidente ${rel?.lastIncidentTurn ? `T${rel.lastIncidentTurn}` : '—'}`),
    agreements.length ? h('ul', { class: 'wg-dim' }, agreements.map((a) => h('li', {}, `${a.type}: ${a.terms} (${a.status})`))) : null,
    msg,
    h('div', { class: 'wg-actions' },
      h('button', { onclick: act('REASSURANCE') }, 'Rassicurare'), h('button', { onclick: act('DEMARCHE') }, 'Démarche'), h('button', { onclick: act('THREAT') }, 'Minacciare'), h('button', { onclick: () => composeTo(f), title: 'Lettera formale al capo di Stato' }, '✉ Lettera'),
      h('button', { onclick: () => addDiplo({ id: newId('d'), kind: 'BACKCHANNEL', target: f, message: text() }) }, 'Canale riservato'),
      h('button', { onclick: () => addDiplo({ id: newId('d'), kind: 'SANCTION', target: f, scope: text() }) }, 'Sanzioni'),
      h('button', { onclick: () => addDiplo({ id: newId('d'), kind: 'AID', target: f, amount: 50, type: 'economic' }) }, 'Aiuto 50 M€')),
    h('p', { class: 'wg-dim' }, 'Le azioni finiscono nella bozza ordini del turno.'));
}

function meter(label: string, v: number, lo: number, hi: number) {
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
