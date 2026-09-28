import type { DiploAction, Order } from '../api-client';
import { parseText, submitDraft, validateDraft } from '../actions';
import { h, meur, select } from '../dom';
import { newId, set, state, type UiState } from '../state/store';

const KINDS = ['PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'MOVE', 'ESCORT', 'BLOCKADE', 'EXCLUSION_ZONE', 'AIR_DEFENSE', 'STRIKE', 'ISR', 'SOF_OP', 'CYBER_OP', 'EVACUATION', 'REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN'];
const ROE = ['WEAPONS_HOLD', 'WEAPONS_TIGHT', 'WEAPONS_FREE'];
const DIPLO = ['DEMARCHE', 'THREAT', 'REASSURANCE', 'BACKCHANNEL', 'SANCTION', 'LIFT_SANCTION', 'NATO_ART4', 'EU_COUNCIL', 'UNSC_DRAFT', 'AID'];

const val = (f: HTMLFormElement, n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';

function buildOrder(f: HTMLFormElement): Order {
  const id = newId('m'); const kind = val(f, 'kind'); const zoneId = val(f, 'zone'); const roe = val(f, 'roe') as Order extends { roe: infer R } ? R : never;
  const unitIds = [...(f.elements.namedItem('units') as HTMLSelectElement).selectedOptions].map((o) => o.value);
  const target = val(f, 'target');
  switch (kind) {
    case 'MOVE': return { id, kind, unitIds, to: zoneId, speed: 'cruise' };
    case 'ESCORT': return { id, kind, unitIds, protect: target, roe };
    case 'STRIKE': return { id, kind, unitIds, targetRef: target, munitions: { [val(f, 'munition')]: Number(val(f, 'qty') || 1) }, roe };
    case 'ISR': return { id, kind, assetIds: [val(f, 'asset')], zoneId };
    case 'SOF_OP': return { id, kind, unitIds, objective: val(f, 'text') || 'ricognizione', zoneId, deniability: 'covert' };
    case 'CYBER_OP': return { id, kind, target: val(f, 'faction'), targetRef: target, effect: (val(f, 'effect') || 'espionage') as 'espionage' };
    case 'EVACUATION': return { id, kind, unitIds, zoneId };
    case 'REPAIR': case 'RETURN_TO_BASE': case 'STAND_DOWN': return { id, kind, unitIds };
    case 'AIR_DEFENSE': return { id, kind, unitIds, zoneId, alert: 'high' };
    default: return { id, kind: kind as 'PATROL', unitIds, zoneId, roe };
  }
}

function buildDiplo(f: HTMLFormElement): DiploAction {
  const id = newId('d'); const kind = val(f, 'dkind'); const target = val(f, 'dtarget'); const message = val(f, 'dtext') || '—';
  if (kind === 'NATO_ART4' || kind === 'EU_COUNCIL' || kind === 'UNSC_DRAFT') return { id, kind, subject: message };
  if (kind === 'SANCTION' || kind === 'LIFT_SANCTION') return { id, kind, target, scope: message };
  if (kind === 'AID') return { id, kind, target, amount: Number(val(f, 'damount') || 10), type: 'economic' };
  if (kind === 'BACKCHANNEL') return { id, kind, target, message };
  return { id, kind: kind as 'DEMARCHE', target, message, visibility: 'public' };
}

const describe = (o: { kind: string } & Record<string, unknown>) => `${o.kind} ${['unitIds', 'assetIds'].map((k) => (o[k] as string[] | undefined)?.join(',')).filter(Boolean).join(' ')} ${o.zoneId ?? o.to ?? o.targetRef ?? o.target ?? o.itemId ?? ''} ${o.roe ?? ''}`;

export function ordersPanel(s: UiState) {
  const k = s.knowledge;
  if (!k) return h('p', {}, '…');
  const zones = (s.layers.zones?.features ?? []).map((f) => String(f.id));
  const units = k.ownUnits.filter((u) => u.status !== 'destroyed');
  const targets = [...k.contacts.map((c) => [c.id, `${c.id} ${c.classification}`] as [string, string]), ...(s.overview?.infrastructure ?? []).map((i) => [i.id, i.name] as [string, string])];
  const munitions = [...new Set(units.flatMap((u) => Object.keys(u.loadout)))];
  const factions = Object.keys(k.beliefs);
  const d = s.draft;
  const add = (e: Event) => { e.preventDefault(); set({ draft: { ...state.draft, military: [...state.draft.military, buildOrder(e.target as HTMLFormElement)] }, validation: null, submitted: false }); };
  const addDiplo = (e: Event) => { e.preventDefault(); set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, buildDiplo(e.target as HTMLFormElement)] }, validation: null, submitted: false }); };
  const remove = (key: 'military' | 'diplomacy' | 'procurement' | 'statements', id: string) => set({ draft: { ...state.draft, [key]: (state.draft[key] as { id: string }[]).filter((x) => x.id !== id) }, validation: null, submitted: false });
  const text = h('textarea', { rows: 2, placeholder: 'Es.: Pattugliare CANALE_SICILIA con ITA-F592 e ITA-P430' });
  const phaseOk = s.campaign?.phase === 'PLAYER_ORDERS';
  return h('div', {},
    phaseOk ? null : h('p', { class: 'wg-warn' }, `Fase ${s.campaign?.phase}: ordini non modificabili.`),
    h('h4', {}, 'Direttiva in linguaggio naturale'),
    text, h('button', { onclick: () => text.value.trim() && parseText(text.value) }, 'Interpreta → bozza'),
    h('h4', {}, 'Ordine militare'),
    h('form', { onsubmit: add, class: 'wg-form' },
      select('kind', KINDS), select('zone', zones), select('roe', ROE, 'WEAPONS_TIGHT'),
      h('select', { name: 'units', multiple: true, size: 5 }, units.map((u) => h('option', { value: u.id, selected: u.id === s.selectedUnitId }, `${u.name} [${u.zoneId}, ${u.status}]`))),
      select('target', [['', '— bersaglio/oggetto —'], ...targets]), select('munition', munitions), h('input', { name: 'qty', type: 'number', min: 1, value: 4 }),
      select('asset', k.ownFaction.isrAssets.map((a) => [a.id, `${a.id} (${a.type})`] as [string, string])), select('faction', factions), select('effect', ['espionage', 'disruption', 'defense_hardening']),
      h('input', { name: 'text', placeholder: 'Obiettivo SOF' }), h('button', { type: 'submit' }, 'Aggiungi')),
    h('h4', {}, 'Azione diplomatica'),
    h('form', { onsubmit: addDiplo, class: 'wg-form' }, select('dkind', DIPLO), select('dtarget', factions), h('input', { name: 'dtext', placeholder: 'Messaggio / oggetto' }), h('input', { name: 'damount', type: 'number', placeholder: 'M€ (aiuti)' }), h('button', { type: 'submit' }, 'Aggiungi')),
    h('h4', {}, 'Bozza'),
    h('ul', { class: 'wg-draft' },
      d.military.map((o) => h('li', {}, describe(o as never), h('button', { onclick: () => remove('military', o.id) }, '×'))),
      d.diplomacy.map((o) => h('li', {}, describe(o as never), h('button', { onclick: () => remove('diplomacy', o.id) }, '×'))),
      d.procurement.map((o) => h('li', {}, `ACQUISTO ${o.qty}× ${o.itemId}`, h('button', { onclick: () => remove('procurement', o.id) }, '×')))),
    h('div', { class: 'wg-row' }, h('button', { onclick: validateDraft }, 'Valida'), h('button', { onclick: submitDraft, disabled: !phaseOk }, s.submitted ? 'Inviati ✓' : 'Invia ordini')),
    s.validation ? h('div', { class: 'wg-card' },
      h('p', {}, s.validation.valid ? 'Ordini validi.' : 'Ordini non validi.', ` Costo stimato ${meur(s.validation.estCost)}.`),
      s.validation.errors.length ? h('ul', { class: 'wg-err' }, s.validation.errors.map((e) => h('li', {}, e))) : null,
      s.validation.risks.length ? h('ul', { class: 'wg-warn' }, s.validation.risks.map((e) => h('li', {}, e))) : null) : null);
}
