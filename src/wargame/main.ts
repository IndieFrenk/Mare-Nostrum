// Mare Nostrum — entry della variante "wargame" (AGPL-3.0, fork di World Monitor).
// Non importa src/main.ts né alcun servizio dati upstream: l'unica sorgente è wargame-server.
import './wargame.css';
import { api } from './api-client';
import { createCampaign, leaveCampaign, openCampaign, rememberedCampaign, runTurn, selectUnit } from './actions';
import { h, meur } from './dom';
import { WarMap } from './layers/map';
import { set, state, subscribe, type UiState } from './state/store';
import { WARGAME_VARIANT } from './variant';

const root = document.getElementById('wg-app')!;
let tab = 'briefing';
let map: WarMap | null = null;
const mapEl = h('div', { id: 'wg-map' });
const sideEl = h('aside', { id: 'wg-side' });
const topEl = h('header', { id: 'wg-top' });

function topbar(s: UiState) {
  const c = s.campaign!;
  const f = s.knowledge?.ownFaction;
  const canRun = c.status === 'active' && (c.phase === 'PLAYER_ORDERS' || c.phase === 'CLOSED' || (c.phase === 'CMO_PENDING' && !s.cmo.length));
  return [
    h('strong', {}, 'MARE NOSTRUM'), h('span', {}, c.name),
    h('span', { class: 'wg-pill' }, `T${c.currentTurn} · ${c.date}`), h('span', { class: `wg-pill ph-${c.phase}` }, c.phase),
    f ? h('span', { class: 'wg-pill' }, `FOED ${meur(f.budget.discretionary)} · stabilità ${f.stability} · credibilità ${f.credibility}`) : null,
    h('button', { class: 'wg-primary', disabled: !canRun || s.busy, onclick: runTurn }, s.busy ? 'Elaborazione…' : c.phase === 'CMO_PENDING' ? 'Prosegui' : 'Esegui turno'),
    h('span', { class: 'wg-progress' }, s.busy ? s.progress[s.progress.length - 1] ?? '' : ''),
    s.error ? h('span', { class: 'wg-err' }, s.error) : null,
    h('button', { onclick: leaveCampaign }, 'Campagne'),
  ];
}

function renderSide(s: UiState) {
  const panel = WARGAME_VARIANT.panels.find((p) => p.id === tab)!;
  const badge = (id: string) => (id === 'cmo' && s.cmo.length ? ` (${s.cmo.length})` : id === 'orders' && s.draft.military.length + s.draft.diplomacy.length + s.draft.procurement.length ? ` (${s.draft.military.length + s.draft.diplomacy.length + s.draft.procurement.length})` : '');
  sideEl.replaceChildren(
    h('nav', { class: 'wg-tabs' }, WARGAME_VARIANT.panels.map((p) => h('button', { class: p.id === tab ? 'on' : '', onclick: () => { tab = p.id; renderSide(state); } }, p.title + badge(p.id)))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-header' }, panel.title), h('div', { class: 'panel-content' }, panel.render(s, { flyTo: (lon, lat) => map?.flyTo(lon, lat), rerender: () => renderSide(state) }))),
  );
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

let lastLayers: unknown = null;
subscribe((s) => {
  if (!s.campaignId || !s.campaign) { if (!root.querySelector('#wg-lobby') || !s.campaignId) void lobby(); map = null; return; }
  if (!root.contains(mapEl)) {
    root.replaceChildren(topEl, h('main', { id: 'wg-main' }, mapEl, sideEl));
    map = new WarMap(mapEl, (id) => { tab = 'oob'; void selectUnit(id); });
  }
  topEl.replaceChildren(...topbar(s).filter((x): x is HTMLElement => !!x));
  if (s.layers !== lastLayers) { lastLayers = s.layers; map?.render(s); }
  const active = document.activeElement;
  if (!(active && sideEl.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && s.busy)) renderSide(s);
});

const initial = rememberedCampaign();
if (initial) void openCampaign(initial).then(() => { if (!state.campaign) set({ campaignId: null }); });
else void lobby();
