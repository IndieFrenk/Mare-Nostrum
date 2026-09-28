import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import countriesUrl from '../assets/countries.geojson?url';
import ms from 'milsymbol';
import type { UiState } from '../state/store';
import { EU_ISO, FACTIONS, MAP_LABELS, NAMES } from './factions';

type Props = Record<string, any>;
type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

/** APP-6/MIL-STD-2525C (lettere) per le unità proprie. */
const SIDC: Record<string, string> = {
  carrier: 'SFSPCLCV-------', lhd: 'SFSPCALA-------', destroyer: 'SFSPCLDD-------', frigate: 'SFSPCLFF-------', opv: 'SFSPCP---------',
  submarine: 'SFUPS----------', fighter_sqn: 'SFAPMFF--------', strike_sqn: 'SFAPMFA--------', aew: 'SFAPMFRW-------', mpa: 'SFAPMFP--------',
  drone_flight: 'SFAPMFQ--------', sam_battery: 'SFGPUCDM-------', ground_bn: 'SFGPUCI--------', sof_team: 'SFGPUCIS-------', tanker: 'SFSPNR---------', transport: 'SFSPNS---------',
};
const STATUS_COLOR: Record<string, string> = { ready: '#8fc4ff', deployed: '#6fe39a', transit: '#f2d24b', maintenance: '#b0b0b0', damaged: '#ff8a3d', destroyed: '#555' };
const icon = (type: string, status: string) => new ms.Symbol(SIDC[type] ?? 'SFGP-----------', { size: 20, fillColor: STATUS_COLOR[status] ?? '#8fc4ff' }).toDataURL();

function circle(lon: number, lat: number, km: number, n = 40): GeoJSON.Polygon {
  return { type: 'Polygon', coordinates: [Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * 2 * Math.PI; return [lon + (km / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (km / 111) * Math.cos(a)]; })] };
}
const factionColor = (f: string) => FACTIONS[f]?.color ?? '#d0d0d0';

export interface MapHandlers {
  selectUnit: (id: string, add: boolean) => void;
  openStack: (ids: string[]) => void;
  openCountry: (factionId: string | null) => void;
  orderToZone: (zoneId: string) => void;
}

/** Mappa a tutto schermo in stile grand strategy: globo 3D, paesi colorati per fazione, pedine sulle posizioni. */
export class WarMap {
  readonly map: maplibregl.Map;
  private ready: Promise<void>;
  private markers: maplibregl.Marker[] = [];
  private labels: maplibregl.Marker[] = [];
  private last: UiState | null = null;

  constructor(container: HTMLElement, private h: MapHandlers) {
    maplibregl.setWorkerUrl(maplibreWorkerUrl); // come DeckGLMap upstream: il worker non passa dall'optimizer di Vite
    this.map = new maplibregl.Map({
      container, center: [16, 36], zoom: 2.6, attributionControl: false, renderWorldCopies: false,
      style: { version: 8, projection: { type: 'globe' }, sources: {}, layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#16324a' } }] },
    });
    this.map.dragRotate.disable();
    if (import.meta.env.DEV) (window as unknown as { __wgMap: maplibregl.Map }).__wgMap = this.map;
    this.map.on('error', (e) => console.error('mappa:', e.error?.message ?? e));
    this.ready = new Promise((r) => this.map.on('load', () => { this.setup(); r(); }));
    this.map.on('zoomend', () => this.last && this.renderUnits(this.last));
    this.map.on('moveend', () => this.last && this.renderUnits(this.last));
  }

  private setup() {
    const m = this.map;
    // confini 1:50m generati da `npm --prefix wargame-server run geo:build`
    m.addSource('countries', { type: 'geojson', data: new URL(countriesUrl, window.location.href).href });
    for (const id of ['control', 'zones', 'crises', 'lanes', 'infrastructure', 'contacts', 'contactAreas', 'ranges', 'plans']) m.addSource(id, { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': '#4a4a42' } });
    m.addLayer({ id: 'control-fill', type: 'fill', source: 'control', paint: { 'fill-color': '#8f6a3a', 'fill-opacity': 0.9 } });
    m.addLayer({ id: 'control-line', type: 'line', source: 'control', paint: { 'line-color': '#101418', 'line-width': 0.7, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'countries-line', type: 'line', source: 'countries', paint: { 'line-color': '#101418', 'line-width': 0.7 } });
    m.addLayer({ id: 'countries-sel', type: 'line', source: 'countries', paint: { 'line-color': '#f5d77a', 'line-width': 2.2 }, filter: ['==', ['get', 'ISO3166-1-Alpha-3'], '__none__'] });
    m.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0 } });
    m.addLayer({ id: 'zones-line', type: 'line', source: 'zones', filter: ['==', ['get', 'terrain'], 'sea'], paint: { 'line-color': '#9cc3e4', 'line-opacity': 0.25, 'line-dasharray': [2, 3] } });
    m.addLayer({ id: 'crises-fill', type: 'fill', source: 'crises', paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'escalation'], 0, '#d8c24b', 5, '#ff8a3d', 10, '#ff2d2d'], 'fill-opacity': 0.18 } });
    m.addLayer({ id: 'crises-line', type: 'line', source: 'crises', paint: { 'line-color': ['interpolate', ['linear'], ['get', 'escalation'], 0, '#d8c24b', 10, '#ff2d2d'], 'line-width': 1.5 } });
    m.addLayer({ id: 'lanes', type: 'line', source: 'lanes', paint: { 'line-color': '#d9e6f2', 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [4, 3] } });
    const infraColor = ['match', ['get', 'status'], 'offline', '#ff3b3b', 'degraded', '#ffaa2a', '#46d1ff'];
    m.addLayer({ id: 'infra-line', type: 'line', source: 'infrastructure', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': infraColor as never, 'line-width': 2.2 } });
    m.addLayer({ id: 'infra-point', type: 'circle', source: 'infrastructure', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': infraColor as never, 'circle-radius': 4, 'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1 } });
    const cColor = ['match', ['get', 'estFaction'], ...Object.entries(FACTIONS).flatMap(([f, v]) => [f, v.color]), '#e6e6e6'];
    m.addLayer({ id: 'contact-area', type: 'fill', source: 'contactAreas', paint: { 'fill-color': cColor as never, 'fill-opacity': ['*', 0.35, ['get', 'confidence']] } });
    m.addLayer({ id: 'contact-edge', type: 'line', source: 'contactAreas', paint: { 'line-color': '#ff5d5d', 'line-opacity': ['get', 'confidence'], 'line-width': 1 } });
    m.addLayer({ id: 'contact-dot', type: 'circle', source: 'contacts', paint: { 'circle-color': '#ff5d5d', 'circle-radius': 3.5, 'circle-stroke-color': cColor as never, 'circle-stroke-width': 2, 'circle-opacity': ['get', 'confidence'] } });
    m.addLayer({ id: 'ranges-fill', type: 'fill', source: 'ranges', paint: { 'fill-color': ['match', ['get', 'kind'], 'weapon', '#ff5a5a', '#5ac8ff'], 'fill-opacity': 0.08 } });
    m.addLayer({ id: 'ranges-line', type: 'line', source: 'ranges', paint: { 'line-color': ['match', ['get', 'kind'], 'weapon', '#ff5a5a', '#5ac8ff'], 'line-width': 1 } });
    m.addLayer({ id: 'plans', type: 'line', source: 'plans', paint: { 'line-color': '#f5d77a', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'wg-tip' });
    const tip = (layer: string, text: (p: Props) => string) => {
      m.on('mousemove', layer, (e) => { const p = e.features?.[0]?.properties; if (p) popup.setLngLat(e.lngLat).setText(text(p)).addTo(m); });
      m.on('mouseleave', layer, () => popup.remove());
    };
    tip('contact-dot', (p) => `${p.classification} — ${p.estFaction}, confidenza ${Math.round(p.confidence * 100)}%, ±${p.errorKm} km`);
    tip('infra-point', (p) => `${p.name}: ${p.status}`);
    tip('infra-line', (p) => `${p.name}: ${p.status}`);
    tip('crises-fill', (p) => `${p.crises} — escalation ${p.escalation}/10`);

    m.on('click', (e) => {
      const area = m.queryRenderedFeatures(e.point, { layers: ['control-fill'] })[0]?.properties?.faction;
      if (area) return this.h.openCountry(String(area));
      const iso = m.queryRenderedFeatures(e.point, { layers: ['countries-fill'] })[0]?.properties?.['ISO3166-1-Alpha-3'];
      const f = Object.entries(FACTIONS).find(([, v]) => v.iso === iso)?.[0] ?? null;
      this.h.openCountry(f);
    });
    m.on('contextmenu', (e) => {
      e.preventDefault();
      const zone = m.queryRenderedFeatures(e.point, { layers: ['zones-fill'] })[0]?.properties?.id;
      if (zone) this.h.orderToZone(String(zone));
    });
  }

  flyTo(lon: number, lat: number) { this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 5) }); }

  async render(s: UiState) {
    await this.ready;
    this.last = s;
    const m = this.map;
    m.setProjection({ type: s.globe ? 'globe' : 'mercator' });
    const src = (id: string, data: FC) => (m.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    for (const id of ['control', 'zones', 'crises', 'lanes', 'infrastructure', 'contacts', 'ranges']) src(id, (s.layers[id] as FC) ?? EMPTY);
    src('contactAreas', { type: 'FeatureCollection', features: (s.layers.contacts?.features ?? []).map((f) => { const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]; return { type: 'Feature', properties: f.properties, geometry: circle(lon, lat, Math.max(3, f.properties!.errorKm)) }; }) });
    this.renderPlans(s);
    this.renderMode(s);
    this.renderUnits(s);
    this.renderLabels();
  }

  private renderMode(s: UiState) {
    const m = this.map;
    const rel = s.overview?.relations ?? {};
    const pairs = (value: (f: string) => string) => Object.entries(FACTIONS).filter(([, v]) => v.iso).flatMap(([f, v]) => [v.iso!, value(f)]);
    const heat = (v: number, lo: number, hi: number, c: [string, string, string]) => { const t = (v - lo) / (hi - lo); const i = t < 0.5 ? 0 : 1; const k = t < 0.5 ? t * 2 : (t - 0.5) * 2; return mix(c[i]!, c[i + 1]!, Math.max(0, Math.min(1, k))); };
    let value: (f: string) => string;
    let other = '#4a4a42';
    if (s.mapMode === 'diplomazia') value = (f) => (f === 'ITA' ? '#3f8f4f' : rel[f] ? heat(rel[f]!.trust, -100, 100, ['#8c2323', '#6b6b5e', '#2f8f4f']) : other);
    else if (s.mapMode === 'tensione') value = (f) => (f === 'ITA' ? '#3f8f4f' : rel[f] ? heat(rel[f]!.tension, 0, 100, ['#3a5a3a', '#b08a2a', '#b02020']) : other);
    else if (s.mapMode === 'crisi') { value = () => '#3b3b36'; other = '#33332f'; }
    else value = factionColor;
    const expr = ['match', ['get', 'ISO3166-1-Alpha-3'], ...pairs(value), ...(s.mapMode === 'politica' ? [EU_ISO, '#586a82'] : []), other];
    m.setPaintProperty('countries-fill', 'fill-color', expr as never);
    m.setPaintProperty('control-fill', 'fill-color', ['match', ['get', 'faction'], ...Object.keys(FACTIONS).flatMap((f) => [f, value(f)]), other] as never);
    m.setPaintProperty('crises-fill', 'fill-opacity', s.mapMode === 'crisi' ? 0.45 : 0.18);
    m.setFilter('countries-sel', ['==', ['get', 'ISO3166-1-Alpha-3'], (s.country && FACTIONS[s.country]?.iso) || '__none__']);
  }

  private renderPlans(s: UiState) {
    const units = new Map((s.knowledge?.ownUnits ?? []).map((u) => [u.id, u]));
    const centers = new Map((s.layers.zones?.features ?? []).map((f) => [String(f.id), f.properties!.center as [number, number]]));
    const features: GeoJSON.Feature[] = [];
    for (const o of s.draft.military) {
      const to = 'zoneId' in o ? centers.get(o.zoneId) : o.kind === 'MOVE' && typeof o.to === 'string' ? centers.get(o.to) : undefined;
      if (!to) continue;
      for (const id of 'unitIds' in o ? o.unitIds : []) { const u = units.get(id); if (u) features.push({ type: 'Feature', properties: { kind: o.kind }, geometry: { type: 'LineString', coordinates: [[u.location.lon, u.location.lat], to] } }); }
    }
    (this.map.getSource('plans') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** Pedine: le unità vicine sullo schermo si impilano in un'unica pedina con contatore (si separano zoomando). */
  private renderUnits(s: UiState) {
    this.markers.forEach((mk) => mk.remove());
    this.markers = [];
    const stacks: { x: number; y: number; units: NonNullable<UiState['knowledge']>['ownUnits'] }[] = [];
    for (const u of s.knowledge?.ownUnits ?? []) {
      if (u.status === 'destroyed') continue;
      const p = this.map.project([u.location.lon, u.location.lat]);
      const near = stacks.find((st) => Math.hypot(st.x - p.x, st.y - p.y) < 30);
      if (near) near.units.push(u); else stacks.push({ x: p.x, y: p.y, units: [u] });
    }
    for (const { units } of stacks) {
      const top = units.find((u) => u.status === 'deployed') ?? units[0]!;
      const selected = units.some((u) => s.selection.includes(u.id));
      const el = document.createElement('div');
      el.className = `wg-counter${selected ? ' sel' : ''}`;
      el.title = units.map((u) => `${u.name} — ${u.status}, ${u.readiness}%`).join('\n');
      const img = document.createElement('img');
      img.src = icon(top.type, top.status);
      img.alt = top.name;
      el.appendChild(img);
      if (units.length > 1) { const b = document.createElement('span'); b.textContent = String(units.length); el.appendChild(b); }
      el.addEventListener('click', (e) => { e.stopPropagation(); if (units.length > 1 && !e.shiftKey) this.h.openStack(units.map((u) => u.id)); else this.h.selectUnit(top.id, e.shiftKey); });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      this.markers.push(new maplibregl.Marker({ element: el }).setLngLat([top.location.lon, top.location.lat]).addTo(this.map));
    }
  }

  private renderLabels() {
    if (this.labels.length) return;
    for (const [f, v] of Object.entries(FACTIONS)) {
      const el = document.createElement('div');
      el.className = 'wg-country-label';
      el.textContent = (MAP_LABELS[f] ?? NAMES[f] ?? f).toUpperCase();
      this.labels.push(new maplibregl.Marker({ element: el }).setLngLat(v.label).addTo(this.map));
    }
  }
}

function mix(a: string, b: string, t: number) {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
