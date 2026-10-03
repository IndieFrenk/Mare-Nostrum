import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import countriesUrl from '../assets/countries.geojson?url';
import ms from 'milsymbol';
import type { UiState } from '../state/store';
import { arc, BLOC_POINT, bandOf, centroids, cssColor, DEFAULT_THRESHOLDS, mixColor, TREATY_CATS, TREATY_TYPE_LABEL, treatyCat } from './diplomacy';
import { alignmentColor, EU_ISO, FACTIONS, MAP_LABELS, NAMES } from './factions';

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
  /** ISO3 → attore (id di fazione se lo Stato è una fazione, altrimenti l'ISO3) dal registro: gli Stati del registro sono cliccabili */
  private actorByIso = new Map<string, string>();
  private nationsRef: UiState['nations'] | null = null;
  /** attore → ISO3 (il contrario di actorByIso) e centro di ogni Stato (dal geojson dei confini, caricato solo per la modalità «trattati») */
  private isoByActor = new Map<string, string>();
  private centers: Map<string, [number, number]> | null = null;
  private layersRef: UiState['layers'] | null = null;
  private globeRef: boolean | null = null;

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
    for (const id of ['control', 'zones', 'crises', 'lanes', 'infrastructure', 'contacts', 'contactAreas', 'ranges', 'plans', 'treaties']) m.addSource(id, { type: 'geojson', data: EMPTY });
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
    // trattati (modalità «trattati»): il colore dice la categoria, il tratto (pieno, tratteggiato, punteggiato) il gruppo; i proposti sono più chiari
    const treatyColor = ['match', ['get', 'cat'], ...TREATY_CATS.flatMap((c) => [c.id, cssColor(`--wg-tr-${c.id}`)]), '#b8b8b0'];
    for (const [id, dash] of [['solid', undefined], ['dashed', [3, 2]], ['dotted', [0.6, 2]]] as const)
      m.addLayer({ id: `treaties-${id}`, type: 'line', source: 'treaties', filter: ['==', ['get', 'dash'], id], layout: { 'line-cap': 'butt' }, paint: { 'line-color': treatyColor as never, 'line-width': 2.6, 'line-opacity': ['match', ['get', 'status'], 'proposed', 0.5, 0.95] as never, ...(dash ? { 'line-dasharray': dash as never } : {}) } });
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
    for (const id of ['solid', 'dashed', 'dotted']) tip(`treaties-${id}`, (p) => String(p.text));

    m.on('click', (e) => {
      const area = m.queryRenderedFeatures(e.point, { layers: ['control-fill'] })[0]?.properties?.faction;
      if (area) return this.h.openCountry(String(area));
      const iso = m.queryRenderedFeatures(e.point, { layers: ['countries-fill'] })[0]?.properties?.['ISO3166-1-Alpha-3'];
      // fazione, oppure Stato del registro (scheda in sola lettura); i territori senza Stato (dipendenze, Antartide) non rispondono
      const f = Object.entries(FACTIONS).find(([, v]) => v.iso === iso)?.[0] ?? (iso ? this.actorByIso.get(String(iso)) : undefined) ?? null;
      this.h.openCountry(f);
    });
    m.on('mousemove', 'countries-fill', (e) => {
      const iso = e.features?.[0]?.properties?.['ISO3166-1-Alpha-3'];
      m.getCanvas().style.cursor = iso && (this.actorByIso.has(String(iso)) || Object.values(FACTIONS).some((v) => v.iso === iso)) ? 'pointer' : '';
    });
    m.on('mouseleave', 'countries-fill', () => { m.getCanvas().style.cursor = ''; });
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
    if (s.nations !== this.nationsRef) {
      this.nationsRef = s.nations;
      this.actorByIso = new Map(s.nations.map((n) => [n.iso3, n.factionId ?? n.iso3]));
      this.isoByActor = new Map(s.nations.map((n) => [n.factionId ?? n.iso3, n.iso3]));
    }
    const m = this.map;
    if (s.globe !== this.globeRef) { this.globeRef = s.globe; m.setProjection({ type: s.globe ? 'globe' : 'mercator' }); }
    const src = (id: string, data: FC) => (m.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    // i livelli di gioco si ricaricano solo se sono cambiati (la scheda di un paese o il cambio di modalità non li toccano)
    if (s.layers !== this.layersRef) {
      this.layersRef = s.layers;
      for (const id of ['control', 'zones', 'crises', 'lanes', 'infrastructure', 'contacts', 'ranges']) src(id, (s.layers[id] as FC) ?? EMPTY);
      src('contactAreas', { type: 'FeatureCollection', features: (s.layers.contacts?.features ?? []).map((f) => { const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]; return { type: 'Feature', properties: f.properties, geometry: circle(lon, lat, Math.max(3, f.properties!.errorKm)) }; }) });
    }
    this.renderPlans(s);
    this.renderTreaties(s);
    this.renderMode(s);
    this.renderUnits(s);
    this.renderLabels();
  }

  private renderMode(s: UiState) {
    const m = this.map;
    const rel = s.overview?.relations ?? {};
    const pairs = (value: (f: string) => string) => Object.entries(FACTIONS).filter(([, v]) => v.iso).flatMap(([f, v]) => [v.iso!, value(f)]);
    const heat = (v: number, lo: number, hi: number, c: [string, string, string]) => { const t = (v - lo) / (hi - lo); const i = t < 0.5 ? 0 : 1; const k = t < 0.5 ? t * 2 : (t - 0.5) * 2; return mixColor(c[i]!, c[i + 1]!, Math.max(0, Math.min(1, k))); };
    let value: (f: string) => string;
    let other = '#4a4a42';
    let isoPairs: string[] | null = null;
    if (s.mapMode === 'opinione' || s.mapMode === 'trattati' || s.mapMode === 'voto') ({ value, other, isoPairs } = this.diploColors(s));
    else if (s.mapMode === 'diplomazia') value = (f) => (f === 'ITA' ? '#3f8f4f' : rel[f] ? heat(rel[f]!.trust, -100, 100, ['#8c2323', '#6b6b5e', '#2f8f4f']) : other);
    else if (s.mapMode === 'tensione') value = (f) => (f === 'ITA' ? '#3f8f4f' : rel[f] ? heat(rel[f]!.tension, 0, 100, ['#3a5a3a', '#b08a2a', '#b02020']) : other);
    else if (s.mapMode === 'crisi') { value = () => '#3b3b36'; other = '#33332f'; }
    else if (s.mapMode === 'allineamento') {
      // tutti gli Stati del registro: polo prevalente (blu Occidente, oro Cina, rosso Russia, grigio non allineato), intensità per il valore
      const byFaction = new Map(s.nations.filter((n) => n.factionId).map((n) => [n.factionId!, n]));
      value = (f) => { const n = byFaction.get(f); return n ? alignmentColor(n.alignment) : other; };
      other = '#3c3c36';
      isoPairs = s.nations.flatMap((n) => [n.iso3, alignmentColor(n.alignment)]);
    } else value = factionColor;
    const arms = [...(isoPairs ?? pairs(value)), ...(s.mapMode === 'politica' ? [EU_ISO, '#586a82'] : [])];
    // `match` vuole almeno una coppia (la modalità «voto» senza votazioni non ne ha): senza, un colore solo
    const expr = arms.length ? ['match', ['get', 'ISO3166-1-Alpha-3'], ...arms, other] : other;
    m.setPaintProperty('countries-fill', 'fill-color', expr as never); // un'unica espressione `match` per tutti i 197 Stati, non un layer per paese
    m.setPaintProperty('control-fill', 'fill-color', ['match', ['get', 'faction'], ...Object.keys(FACTIONS).flatMap((f) => [f, value(f)]), other] as never);
    m.setPaintProperty('crises-fill', 'fill-opacity', s.mapMode === 'crisi' ? 0.45 : 0.18);
    m.setFilter('countries-sel', ['==', ['get', 'ISO3166-1-Alpha-3'], (s.country && (FACTIONS[s.country]?.iso ?? (this.actorByIso.has(s.country) ? s.country : null))) || '__none__']);
  }

  /** Gli accordi che la modalità «trattati» disegna: quelli dell'Italia, o del paese selezionato (dalla sua scheda). */
  private treatyView(s: UiState): { center: string; agreements: { type: string; parties: string[]; status: string }[] } {
    const me = s.campaign?.playerFaction ?? 'ITA';
    const center = s.country ?? me;
    if (center === me) return { center, agreements: s.diplo?.agreements ?? [] };
    return { center, agreements: s.countryDiplo?.actor === center ? s.countryDiplo.agreements : [] };
  }

  /** Colori per Stato nelle modalità della diplomazia: `isoPairs` per tutti gli Stati del registro, `value` per le aree di controllo delle fazioni. */
  private diploColors(s: UiState): { value: (f: string) => string; other: string; isoPairs: string[] } {
    const me = s.campaign?.playerFaction ?? 'ITA';
    const none = cssColor('--wg-none'); const self = cssColor('--wg-self');
    let colorOf: (actor: string) => string = () => none;
    let isoPairs: string[] | null = null;
    if (s.mapMode === 'opinione') {
      const d = s.diplo?.opinion;
      const band = (a: string) => !d ? null : s.opinionDir === 'out' ? (d.out[a] === undefined ? null : bandOf(d.out[a]!, d.thresholds ?? DEFAULT_THRESHOLDS)) : d.in[a] ?? null;
      colorOf = (a) => { if (a === me) return self; const b = band(a); return b === null ? none : cssColor(`--wg-op-${b}`); };
    } else if (s.mapMode === 'trattati') {
      const { center, agreements } = this.treatyView(s);
      const rank = (c: string) => TREATY_CATS.findIndex((x) => x.id === c);
      const best = new Map<string, string>();
      for (const a of agreements) for (const p of a.parties) {
        if (p === center) continue;
        const cat = treatyCat(a.type as never);
        if (!best.has(p) || rank(cat) < rank(best.get(p)!)) best.set(p, cat);
      }
      colorOf = (a) => a === center ? self : best.has(a) ? mixColor(none, cssColor(`--wg-tr-${best.get(a)}`), 0.6) : none;
    } else {
      const v = s.votes.find((x) => x.id === s.voteId) ?? s.votes[0];
      const byIso = new Map<string, string>();
      if (v) for (const [list, name] of [[v.abstain, 'abstain'], [v.no, 'no'], [v.yes, 'yes']] as const) for (const iso of list) byIso.set(iso, cssColor(`--wg-vote-${name}`));
      isoPairs = [...byIso].flat();
      colorOf = () => cssColor('--wg-vote-absent');
      return { value: colorOf, other: cssColor('--wg-vote-absent'), isoPairs };
    }
    return { value: colorOf, other: none, isoPairs: [...this.isoByActor].flatMap(([a, iso]) => [iso, colorOf(a)]) };
  }

  /** Linee dei trattati tra il paese al centro (l'Italia, o quello selezionato) e i suoi partner, ad arco di cerchio massimo. */
  private renderTreaties(s: UiState) {
    const src = this.map.getSource('treaties') as maplibregl.GeoJSONSource;
    if (s.mapMode !== 'trattati') { src.setData(EMPTY); return; }
    if (!this.centers) {
      // i confini sono un file locale (lo stesso della mappa): si leggono una volta per ricavare i centri
      void fetch(new URL(countriesUrl, window.location.href).href).then((r) => r.json()).then((fc: FC) => { this.centers = centroids(fc); if (this.last) this.renderTreaties(this.last); }).catch(() => { this.centers = new Map(); });
      src.setData(EMPTY);
      return;
    }
    const name = (a: string) => NAMES[a] ?? s.nations.find((n) => (n.factionId ?? n.iso3) === a)?.nameIt ?? a;
    const at = (a: string) => FACTIONS[a]?.label ?? BLOC_POINT[a] ?? (this.isoByActor.has(a) ? this.centers!.get(this.isoByActor.get(a)!) : undefined);
    const { center, agreements } = this.treatyView(s);
    const from = at(center);
    const features: GeoJSON.Feature[] = [];
    if (from) for (const a of agreements) for (const p of a.parties) {
      const to = p === center ? undefined : at(p);
      if (!to) continue;
      const cat = TREATY_CATS.find((c) => c.id === treatyCat(a.type as never))!;
      features.push({ type: 'Feature', properties: { cat: cat.id, dash: cat.dash, status: a.status, text: `${TREATY_TYPE_LABEL[a.type] ?? a.type}: ${name(center)} – ${name(p)}${a.status === 'proposed' ? ' (proposto)' : ''}` }, geometry: { type: 'LineString', coordinates: arc(from, to) } });
    }
    src.setData({ type: 'FeatureCollection', features });
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
