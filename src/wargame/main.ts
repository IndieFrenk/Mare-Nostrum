// Mare Nostrum — entry della variante "wargame" (AGPL-3.0, fork di World Monitor).
// Non importa src/main.ts né alcun servizio dati upstream: l'unica sorgente è wargame-server.
import './wargame.css';
import { api } from './api-client';
import { createCampaign, leaveCampaign, openCampaign, rememberedCampaign, runTurn, selectUnit } from './actions';
import { h, meur } from './dom';
import { WarMap } from './layers/map';
import { countryCard, orderToZone, selectionCard } from './panels/hud';
import { set, state, subscribe, type UiState } from './state/store';
import { WARGAME_VARIANT } from './variant';

const root = document.getElementById('wg-app')!;
const ICONS: Record<string, string> = { briefing: '☰', orders: '✎', oob: '⚓', intel: '◉', news: '▤', crises: '⚠', diplomacy: '⚖', foed: '€', procurement: '⚙', cmo: '⚔', postmortem: '⌛' };
let map: WarMap | null = null;
const mapEl = h('div', { id: 'wg-map' });
const hud = h('div', { id: 'wg-hud' });

function topbar(s: UiState) {
  const c = s.campaign!;
  const f = s.knowledge?.ownFaction;
  const g = s.overview?.indicators;
  const canRun = c.status === 'active' && (c.phase === 'PLAYER_ORDERS' || c.phase === 'CLOSED' || (c.phase === 'CMO_PENDING' && !s.cmo.length));
  const res = (label: string, value: string, title: string) => h('div', { class: 'wg-res', title }, h('small', {}, label), h('b', {}, value));
  return h('header', { id: 'wg-top' },
    h('button', { class: 'wg-flag', title: 'Italia', onclick: () => set({ country: 'ITA' }) }, 'ITA'),
    f ? [res('FOED', meur(f.budget.discretionary), 'Fondo Operazioni & Emergenze Difesa'), res('Stabilità', String(f.stability), 'Stabilità interna'), res('Credibilità', String(f.credibility), 'Credibilità militare e diplomatica')] : null,
    g ? [res('TTF', `${g.ttfEurMwh} €/MWh`, 'Prezzo gas'), res('Brent', `${g.brentUsd} $`, 'Prezzo petrolio'), res('Rotte', `${g.medShippingRisk}/100`, 'Rischio navigazione'), res('Migrazioni', `${g.migrationPressure}/100`, 'Pressione migratoria')] : null,
    h('div', { class: 'wg-spacer' }),
    h('div', { class: 'wg-date' }, h('b', {}, c.date), h('small', {}, `T${c.currentTurn} · ${c.phase}`)),
    h('button', { class: 'wg-play', disabled: !canRun || s.busy, onclick: runTurn, 'aria-label': c.phase === 'CMO_PENDING' ? 'Prosegui' : 'Esegui turno' }, s.busy ? '…' : '▶'),
  );
}

function alerts(s: UiState) {
  const items: [string, string, string][] = [];
  if (s.cmo.length) items.push(['cmo', `${s.cmo.length} ingaggi per CMO`, 'crit']);
  for (const c of s.knowledge?.knownCrises ?? []) if (c.escalation >= 7) items.push(['crises', `${c.title}: ${c.escalation}/10`, 'crit']);
  if (s.knowledge?.inbox.length) items.push(['diplomacy', `${s.knowledge.inbox.length} messaggi diplomatici`, 'info']);
  const pending = s.draft.military.length + s.draft.diplomacy.length + s.draft.procurement.length;
  if (s.campaign?.phase === 'PLAYER_ORDERS' && pending && !s.submitted) items.push(['orders', `${pending} ordini in bozza`, 'info']);
  if (s.overview?.pendingDeliveries.length) items.push(['procurement', `${s.overview.pendingDeliveries.length} consegne in arrivo`, 'info']);
  return h('div', { id: 'wg-alerts' }, items.map(([drawer, text, cls]) => h('button', { class: `wg-alert ${cls}`, onclick: () => set({ drawer }) }, text)));
}

function drawer(s: UiState) {
  const p = WARGAME_VARIANT.panels.find((x) => x.id === s.drawer);
  if (!p) return null;
  return h('div', { class: 'wg-float wg-drawer panel' },
    h('div', { class: 'panel-header' }, p.title, h('button', { onclick: () => set({ drawer: null }) }, '×')),
    h('div', { class: 'panel-content' }, p.render(s, { flyTo: (lon, lat) => map?.flyTo(lon, lat), rerender: () => set({}) })));
}

function render(s: UiState) {
  const parts: (Node | null)[] = [
    topbar(s),
    h('nav', { id: 'wg-menu' }, WARGAME_VARIANT.panels.map((p) => h('button', { class: p.id === s.drawer ? 'on' : '', title: p.title, 'aria-label': p.title, onclick: () => set({ drawer: s.drawer === p.id ? null : p.id }) }, ICONS[p.id] ?? '•'))),
    alerts(s),
    drawer(s),
    s.country ? countryCard(s, s.country) : null,
    selectionCard(s),
    h('div', { id: 'wg-modes' },
      (['politica', 'diplomazia', 'tensione', 'crisi'] as const).map((m) => h('button', { class: s.mapMode === m ? 'on' : '', onclick: () => set({ mapMode: m }) }, m)),
      h('button', { onclick: () => set({ globe: !s.globe }) }, s.globe ? 'Mappa piana' : 'Globo'),
      h('button', { onclick: leaveCampaign }, 'Campagne')),
    h('div', { id: 'wg-log' }, s.error ? h('span', { class: 'wg-err' }, s.error) : s.busy ? s.progress[s.progress.length - 1] ?? 'Elaborazione…' : ''),
  ];
  hud.replaceChildren(...parts.filter((x): x is Node => !!x));
}

async function lobby() {
  const list = await api.campaigns().catch(() => null);
  const name = h('input', { placeholder: 'Nome campagna', value: 'Mare Nostrum 2026' });
  const seed = h('input', { placeholder: 'Seed (opzionale)' });
  const debug = h('input', { type: 'checkbox' });
  root.replaceChildren(h('div', { id: 'wg-lobby', class: 'panel' },
    h('h1', {}, 'MARE NOSTRUM'), h('p', { class: 'wg-dim' }, 'Wargame geopolitico a turni · Mediterraneo allargato 2026 · Autorità Nazionale di Comando'),
    list === null ? h('p', { class: 'wg-err' }, 'wargame-server non raggiungibile: avvia `npm run wargame:server`.') : null,
    h('h3', {}, 'Nuova campagna'), h('div', { class: 'wg-row' }, name, seed, h('label', {}, debug, ' debug god view'), h('button', { class: 'wg-primary', onclick: () => createCampaign(name.value, seed.value, debug.checked) }, 'Crea')),
    state.error ? h('p', { class: 'wg-err' }, state.error) : null,
    list?.length ? [h('h3', {}, 'Campagne esistenti'), h('ul', {}, list.map((c) => h('li', {}, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void openCampaign(c.id); } }, c.name), c.parent ? ` (ramo di ${c.parent.campaignId} T${c.parent.turn})` : '')))] : null));
}

const MAP_KEYS = ['layers', 'knowledge', 'selection', 'draft', 'mapMode', 'globe', 'country', 'overview'] as const;
let last: Partial<UiState> = {};
subscribe((s) => {
  if (!s.campaignId || !s.campaign) { map?.map.remove(); map = null; void lobby(); return; }
  if (!map) {
    root.replaceChildren(mapEl, hud);
    map = new WarMap(mapEl, {
      selectUnit: (id, add) => { set({ stack: null }); void selectUnit(id, add); },
      openStack: (ids) => set({ stack: ids }),
      openCountry: (f) => set({ country: f }),
      orderToZone,
    });
  }
  if (MAP_KEYS.some((k) => s[k] !== last[k])) void map.render(s);
  last = Object.fromEntries(MAP_KEYS.map((k) => [k, s[k]]));
  const active = document.activeElement;
  if (!(active && hud.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && s.busy)) render(s);
});

const initial = rememberedCampaign();
if (initial) void openCampaign(initial).then(() => { if (!state.campaign) set({ campaignId: null }); });
else void lobby();
