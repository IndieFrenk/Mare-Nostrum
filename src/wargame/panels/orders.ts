import type { DiploAction, DiploCatalogRow, Order } from '../api-client';
import { parseText, submitDraft, validateDraft } from '../actions';
import { h, meur, select } from '../dom';
import { newId, set, state, type UiState } from '../state/store';

const KINDS = ['PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'MOVE', 'ESCORT', 'BLOCKADE', 'EXCLUSION_ZONE', 'AIR_DEFENSE', 'STRIKE', 'ISR', 'SOF_OP', 'CYBER_OP', 'EVACUATION', 'REPAIR', 'RETURN_TO_BASE', 'STAND_DOWN'];
const ROE = ['WEAPONS_HOLD', 'WEAPONS_TIGHT', 'WEAPONS_FREE'];
/** azioni con un modulo semplice (un destinatario e un testo): le altre (accordi, accordi energetici, risposte) restano alla Console in linguaggio naturale */
const DIPLO = ['DEMARCHE', 'THREAT', 'REASSURANCE', 'BACKCHANNEL', 'SANCTION', 'LIFT_SANCTION', 'AID', 'IMPROVE_RELATIONS', 'STOP_IMPROVE', 'RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO', 'ULTIMATUM', 'MEDIATE', 'RESOLUTION'];
const FORUMS = [['UNGA', 'Assemblea generale ONU'], ['UNSC', 'Consiglio di sicurezza ONU'], ['EU_COUNCIL', 'Consiglio UE'], ['NATO', 'NATO'], ['ARAB_LEAGUE', 'Lega Araba'], ['AU', 'Unione Africana']] as [string, string][];
const TOPICS = ['aggression', 'sanctions', 'humanitarian', 'maritime', 'nonproliferation', 'other'];

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
  if (kind === 'RESOLUTION') return { id, kind, forum: val(f, 'dforum') as 'UNGA', subject: message, topic: val(f, 'dtopic') as 'other', ...(target ? { target } : {}) };
  if (kind === 'ULTIMATUM') return { id, kind, target, demand: message, deadlineTurns: Math.max(1, Math.min(4, Number(val(f, 'dturns') || 2))) };
  if (kind === 'MEDIATE') return { id, kind, crisisId: val(f, 'dcrisis'), parties: [target, val(f, 'dtarget2')] };
  if (['IMPROVE_RELATIONS', 'STOP_IMPROVE', 'RECALL_AMBASSADOR', 'EXPEL_DIPLOMATS', 'BREAK_RELATIONS', 'RESTORE_RELATIONS', 'ARMS_EMBARGO', 'LIFT_ARMS_EMBARGO'].includes(kind)) return { id, kind: kind as 'STOP_IMPROVE', target };
  if (kind === 'SANCTION' || kind === 'LIFT_SANCTION') return { id, kind, target, scope: message };
  if (kind === 'AID') return { id, kind, target, amount: Number(val(f, 'damount') || 10), type: 'economic' };
  if (kind === 'BACKCHANNEL') return { id, kind, target, message };
  return { id, kind: kind as 'DEMARCHE', target, message, visibility: 'public' };
}

/** «Démarche (1 CD)»: il nome e il costo dal catalogo del server (per le azioni a costo variabile il minimo) */
const costLabel = (cat: DiploCatalogRow[], kind: string) => { const r = cat.find((x) => x.kind === kind); if (!r) return kind; const c = r.cost ?? Math.min(...Object.values(r.costBy ?? { x: 0 })); return `${r.label} (${r.cost === null ? 'da ' : ''}${c} CD${r.cooldown > 1 ? `, ricarica ${r.cooldown}` : ''})`; };

const describe = (o: { kind: string } & Record<string, unknown>) => o.kind === 'LETTER' ? `✉ LETTERA a ${o.target} «${o.subject}» (${o.visibility === 'public' ? 'pubblica' : 'riservata'})` : `${o.kind} ${['unitIds', 'assetIds'].map((k) => (o[k] as string[] | undefined)?.join(',')).filter(Boolean).join(' ')} ${o.zoneId ?? o.to ?? o.targetRef ?? o.target ?? o.itemId ?? ''} ${o.roe ?? ''}`;

/** CD della bozza: costi dal catalogo (per le azioni a costo variabile il costo più basso: la cifra esatta la dà «Valida») */
function draftCost(s: UiState): number {
  let n = 0;
  for (const d of s.draft.diplomacy) { const r = s.diploCatalog.find((x) => x.kind === d.kind); if (r) n += r.cost ?? (d.kind === 'RESOLUTION' ? r.costBy?.[(d as { forum: string }).forum] : d.kind === 'PROPOSE_AGREEMENT' ? r.costBy?.[(d as { agreement: { type: string } }).agreement.type] : undefined) ?? 0; else if (d.kind === 'LETTER') n += 1; }
  return n;
}

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
  const text = h('textarea', { rows: 2, placeholder: 'Es.: Manda la Bergamini a pattugliare il Canale di Sicilia e chiedi alla Tunisia più controlli' });
  const phaseOk = s.campaign?.phase === 'PLAYER_ORDERS';
  return h('div', {},
    phaseOk ? null : h('p', { class: 'wg-warn' }, `Fase ${s.campaign?.phase}: ordini non modificabili.`),
    h('h4', {}, 'Direttiva in linguaggio naturale'),
    text, h('button', { onclick: () => text.value.trim() && parseText(text.value) }, 'Interpreta → bozza'),
    s.parseNote ? h('p', { class: 'wg-dim', style: 'white-space:pre-line' }, s.parseNote) : null,
    h('h4', {}, 'Ordine militare'),
    h('form', { onsubmit: add, class: 'wg-form' },
      select('kind', KINDS), select('zone', zones), select('roe', ROE, 'WEAPONS_TIGHT'),
      h('select', { name: 'units', multiple: true, size: 5 }, units.map((u) => h('option', { value: u.id, selected: u.id === s.selectedUnitId }, `${u.name} [${u.zoneId}, ${u.status}]`))),
      select('target', [['', '— bersaglio/oggetto —'], ...targets]), select('munition', munitions), h('input', { name: 'qty', type: 'number', min: 1, value: 4 }),
      select('asset', k.ownFaction.isrAssets.map((a) => [a.id, `${a.id} (${a.type})`] as [string, string])), select('faction', factions), select('effect', ['espionage', 'disruption', 'defense_hardening']),
      h('input', { name: 'text', placeholder: 'Obiettivo SOF' }), h('button', { type: 'submit' }, 'Aggiungi')),
    h('h4', {}, 'Azione diplomatica'),
    h('p', { class: 'wg-dim' }, 'Le lettere ai capi di Stato si scrivono nel pannello ✉ Lettere ed entrano qui nella bozza.'),
    k.diplomacy ? h('p', { class: 'wg-dim' }, `Capitale diplomatico: ${k.diplomacy.capital} CD (+${k.diplomacy.rent} a settimana) · bozza ${draftCost(s)} CD`) : null,
    h('form', { onsubmit: addDiplo, class: 'wg-form' }, select('dkind', DIPLO.map((x) => [x, costLabel(s.diploCatalog, x)] as [string, string])), select('dtarget', [['', '— destinatario —'], ...factions]), select('dtarget2', [['', '— seconda parte (mediazione) —'], ...factions]),
      select('dforum', FORUMS, 'UNGA'), select('dtopic', TOPICS, 'other'), select('dcrisis', k.knownCrises.map((c) => [c.id, c.title] as [string, string])),
      h('input', { name: 'dtext', placeholder: 'Messaggio / oggetto / richiesta (ultimatum)' }), h('input', { name: 'dturns', type: 'number', min: 1, max: 4, placeholder: 'Turni (ultimatum)' }), h('input', { name: 'damount', type: 'number', placeholder: 'M€ (aiuti)' }), h('button', { type: 'submit' }, 'Aggiungi')),
    h('h4', {}, 'Bozza'),
    h('ul', { class: 'wg-draft' },
      d.military.map((o) => h('li', {}, describe(o as never), h('button', { onclick: () => remove('military', o.id) }, '×'))),
      d.diplomacy.map((o) => h('li', {}, describe(o as never), o.kind === 'LETTER' ? h('button', { title: 'Apri nel pannello Lettere', onclick: () => set({ drawer: 'letters' }) }, '✉') : null, h('button', { onclick: () => remove('diplomacy', o.id) }, '×'))),
      d.procurement.map((o) => h('li', {}, `ACQUISTO ${o.qty}× ${o.itemId}`, h('button', { onclick: () => remove('procurement', o.id) }, '×')))),
    h('div', { class: 'wg-row' }, h('button', { onclick: validateDraft }, 'Valida'), h('button', { onclick: submitDraft, disabled: !phaseOk }, s.submitted ? 'Inviati ✓' : 'Invia ordini')),
    s.validation ? h('div', { class: 'wg-card' },
      h('p', {}, s.validation.valid ? 'Ordini validi.' : 'Ordini non validi.', ` Costo stimato ${meur(s.validation.estCost)}.`),
      s.validation.capitalCost ? h('p', { class: 'wg-dim' }, `Capitale diplomatico: ${s.validation.capitalCost} CD in bozza su ${k.diplomacy?.capital ?? '?'} disponibili.`) : null,
      ...(s.validation.acceptance ?? []).map((a) => h('details', { class: 'wg-dim' }, h('summary', {}, `${a.type} → ${a.target}: ${a.accept ? 'accetterebbe' : 'rifiuterebbe'} (punteggio ${a.score})`),
        h('ul', {}, a.reasons.map((r) => h('li', {}, `${r.value > 0 ? '+' : ''}${r.value} ${r.label}`))))),
      s.validation.errors.length ? h('ul', { class: 'wg-err' }, s.validation.errors.map((e) => h('li', {}, e))) : null,
      s.validation.risks.length ? h('ul', { class: 'wg-warn' }, s.validation.risks.map((e) => h('li', {}, e))) : null) : null);
}
