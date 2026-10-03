import type { DiploAction, NationDetail, NationSummary, Order } from '../api-client';
import { selectUnit } from '../actions';
import { h, pct } from '../dom';
import { FACTIONS, NAMES, POLE_COLORS } from '../layers/factions';
import { composeTo } from './letters';
import { newId, set, state, type UiState } from '../state/store';

const POSTURE = ['', 'guerra aperta', 'confronto armato', 'coercizione', 'competizione', 'pace'];

function addDiplo(a: DiploAction) {
  set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, a] }, validation: null, submitted: false });
}

const GOVERNMENT: Record<string, string> = { democracy: 'democrazia', hybrid: 'regime ibrido', authoritarian: 'regime autoritario', absolute_monarchy: 'monarchia assoluta', theocracy: 'teocrazia', military: 'regime militare', transitional: 'fase di transizione' };
const NUCLEAR: Record<string, string> = { none: 'nessuna', latent: 'latente (potrebbe dotarsene)', declared: 'dichiarata', nato_sharing: 'ospita armi USA (condivisione NATO)' };
const num = (n: number, digits = 1) => n.toLocaleString('it-IT', { maximumFractionDigits: n >= 100 ? 0 : digits });

/** Barra dell'allineamento: Occidente, Cina, Russia e il resto (non allineato), con i valori in chiaro. */
function alignmentBar(a: NationSummary['alignment']) {
  const none = Math.max(0, 1 - a.west - a.china - a.russia);
  const seg = (k: keyof typeof POLE_COLORS, v: number, label: string) => v > 0.004 ? h('i', { style: `width:${(v * 100).toFixed(1)}%;background:${POLE_COLORS[k]}`, title: `${label} ${Math.round(v * 100)}%` }) : null;
  return h('div', {},
    h('div', { class: 'wg-align' }, seg('west', a.west, 'Occidente'), seg('china', a.china, 'Cina'), seg('russia', a.russia, 'Russia'), seg('none', none, 'Non allineato')),
    h('small', { class: 'wg-dim' }, `Occidente ${Math.round(a.west * 100)}% · Cina ${Math.round(a.china * 100)}% · Russia ${Math.round(a.russia * 100)}% · non allineato ${Math.round(none * 100)}%`));
}

/**
 * Scheda in sola lettura di uno Stato che non è una fazione (clic sulla mappa): dati del registro, allineamento, appartenenze e
 * partner commerciali. Sono dati pubblici e **stime**: la confidenza è nel registro (le azioni diplomatiche arrivano con la fase 12).
 */
export function nationCard(s: UiState, iso3: string) {
  const sum = s.nations.find((n) => n.iso3 === iso3);
  const d: NationDetail | undefined = s.nationDetail[iso3];
  const name = (iso: string) => s.nations.find((n) => n.iso3 === iso)?.nameIt ?? iso;
  const close = h('button', { onclick: () => set({ country: null }) }, '×');
  if (!sum) return h('div', { class: 'wg-float wg-country wg-nation' }, h('header', {}, iso3, close), h('p', { class: 'wg-dim' }, 'Stato non nel registro.'));
  const head = h('header', {}, h('i', { style: `background:${POLE_COLORS.none}` }), sum.nameIt.toUpperCase(), close);
  const row = (label: string, value: string) => h('div', { class: 'wg-row2' }, h('span', { class: 'wg-dim' }, label), h('span', {}, value));
  if (!d) return h('div', { class: 'wg-float wg-country wg-nation' }, head, alignmentBar(sum.alignment), h('p', { class: 'wg-dim' }, `${GOVERNMENT[sum.government]} · ${num(sum.population)} M abitanti · PIL ${num(sum.gdpUsdB, 0)} mld $`), h('p', { class: 'wg-dim' }, 'Caricamento della scheda…'));
  const conf = Object.values(d.confidence);
  const lo = Math.round(Math.min(...conf) * 100); const hi = Math.round(Math.max(...conf) * 100);
  return h('div', { class: 'wg-float wg-country wg-nation' }, head,
    h('div', { class: 'wg-nation-body' },
      row('Capitale', d.capital), row('Capo di Stato', d.leaderTitle), row('Governo', `${GOVERNMENT[d.government]} (democrazia ${d.democracyScore.toFixed(1)}/10)`),
      row('Popolazione', `${num(d.population)} M`), row('PIL', `${num(d.gdpUsdB, 0)} mld $`),
      row('Spesa militare', d.milexUsdB > 0 ? `${num(d.milexUsdB)} mld $${d.gdpUsdB > 0 ? ` (${(d.milexUsdB / d.gdpUsdB * 100).toFixed(1)}% del PIL)` : ''} · ${num(d.activePersonnelK)} mila militari` : '—'),
      row('Armi nucleari', NUCLEAR[d.nuclear] ?? d.nuclear)),
    h('h4', {}, 'Allineamento'), alignmentBar(d.alignment),
    d.topTrade.length ? [h('h4', {}, 'Primi partner commerciali'), h('p', {}, d.topTrade.map((t) => `${name(t.iso3)} ${Math.round(t.share * 100)}%`).join(' · '))] : null,
    d.institutions.length ? [h('h4', {}, 'Appartenenze'), h('p', {}, d.institutions.map((i) => h('span', { class: 'wg-chip', title: `${i.nameIt} · ${i.members} membri · decisione: ${i.decision}` }, i.id.replace(/_/g, ' ')))) ] : null,
    d.factionId ? null : h('p', { class: 'wg-dim' }, 'Stato del mondo senza forze in gioco: opinione, trattati e azioni arrivano con i prossimi settori.'),
    h('p', { class: 'wg-dim', title: Object.entries(d.sourceLegend).map(([k, v]) => `${k}: ${v}`).join('\n') }, `Dati stimati (affidabilità ${lo}–${hi}%): sono ordini di grandezza, non misure.`));
}

/** Scheda paese (clic su una nazione): relazioni, stime e azioni diplomatiche rapide; per gli Stati che non sono fazioni, scheda in sola lettura. */
export function countryCard(s: UiState, f: string) {
  if (!FACTIONS[f] && f !== 'ITA') return nationCard(s, f);
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
