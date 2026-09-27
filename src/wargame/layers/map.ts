import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import ms from 'milsymbol';
import { FALLBACK_DARK_STYLE } from '@/config/basemap';
import type { UiState } from '../state/store';

type Rgba = [number, number, number, number];
type Props = Record<string, any>;

/** APP-6/MIL-STD-2525C (lettere) per le unità proprie. */
const SIDC: Record<string, string> = {
  carrier: 'SFSPCLCV-------', lhd: 'SFSPCALA-------', destroyer: 'SFSPCLDD-------', frigate: 'SFSPCLFF-------', opv: 'SFSPCP---------',
  submarine: 'SFUPS----------', fighter_sqn: 'SFAPMFF--------', strike_sqn: 'SFAPMFA--------', aew: 'SFAPMFRW-------', mpa: 'SFAPMFP--------',
  drone_flight: 'SFAPMFQ--------', sam_battery: 'SFGPUCDM-------', ground_bn: 'SFGPUCI--------', sof_team: 'SFGPUCIS-------', tanker: 'SFSPNR---------', transport: 'SFSPNS---------',
};
const STATUS_COLOR: Record<string, string> = { ready: '#6fb6ff', deployed: '#4be08a', transit: '#f2d24b', maintenance: '#b0b0b0', damaged: '#ff8a3d', destroyed: '#555' };
const icons = new Map<string, { url: string; width: number; height: number; anchorY: number }>();

function icon(type: string, status: string) {
  const key = `${type}:${status}`;
  if (!icons.has(key)) {
    const sym = new ms.Symbol(SIDC[type] ?? 'SFGP-----------', { size: 22, fillColor: STATUS_COLOR[status] ?? '#6fb6ff' });
    const { width, height } = sym.getSize();
    icons.set(key, { url: sym.toDataURL(), width, height, anchorY: height / 2 });
  }
  return icons.get(key)!;
}

const escalationColor = (e: number): Rgba => [Math.min(255, 60 + e * 20), Math.max(40, 200 - e * 18), 60, 40 + e * 10];
const infraColor = (s: string): Rgba => (s === 'offline' ? [255, 60, 60, 230] : s === 'degraded' ? [255, 170, 40, 230] : [80, 200, 255, 200]);
const factionColor = (f: string): Rgba => (f === 'unknown' ? [220, 220, 220, 255] : ['RUS', 'IRN'].includes(f) ? [255, 70, 70, 255] : ['USA', 'FRA', 'GBR', 'GRC'].includes(f) ? [120, 170, 255, 255] : [255, 200, 70, 255]);

export class WarMap {
  readonly map: maplibregl.Map;
  private overlay = new MapboxOverlay({ interleaved: false, layers: [] });

  constructor(container: HTMLElement, private onSelect: (unitId: string) => void) {
    this.map = new maplibregl.Map({ container, style: FALLBACK_DARK_STYLE, center: [18, 36], zoom: 4.2, attributionControl: { compact: true } });
    this.map.addControl(this.overlay as unknown as maplibregl.IControl);
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  }

  flyTo(lon: number, lat: number) { this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 6) }); }

  render(s: UiState) {
    const L = s.layers;
    const fc = (n: string) => L[n] ?? { type: 'FeatureCollection' as const, features: [] };
    this.overlay.setProps({
      getTooltip: ({ object, layer }: { object?: { properties?: Props }; layer?: { id: string } | null }) => {
        const p = object?.properties;
        if (!p || !layer) return null;
        if (layer.id === 'units') return `${p.name}\n${p.status} · prontezza ${p.readiness}%${p.count > 1 ? ` · ${p.count} velivoli` : ''}${p.task ? `\nordine: ${p.task}` : ''}`;
        if (layer.id === 'contacts') return `${p.classification}\n${p.estFaction} · confidenza ${Math.round(p.confidence * 100)}% · ±${p.errorKm} km\nfonti: ${(p.sources as string[]).join(', ')}`;
        if (layer.id === 'crises') return `${p.name}\n${p.crises}\nescalation ${p.escalation}/10`;
        if (layer.id === 'infrastructure') return `${p.name}\n${p.status}`;
        return null;
      },
      layers: [
        new GeoJsonLayer({ id: 'crises', data: fc('crises'), filled: true, stroked: true, pickable: true, getFillColor: (f: { properties: Props }) => escalationColor(f.properties.escalation), getLineColor: [255, 120, 80, 160], lineWidthMinPixels: 1 }),
        new GeoJsonLayer({ id: 'lanes', data: fc('lanes'), stroked: true, filled: false, getLineColor: [180, 180, 200, 90], lineWidthMinPixels: 1 }),
        new GeoJsonLayer({ id: 'infrastructure', data: fc('infrastructure'), pickable: true, pointType: 'circle', getLineColor: (f: { properties: Props }) => infraColor(f.properties.status), getFillColor: (f: { properties: Props }) => infraColor(f.properties.status), lineWidthMinPixels: 2, pointRadiusMinPixels: 4 }),
        new GeoJsonLayer({ id: 'ranges', data: fc('ranges'), filled: true, getFillColor: (f: { properties: Props }) => (f.properties.kind === 'weapon' ? [255, 90, 90, 25] : [90, 200, 255, 20]), getLineColor: (f: { properties: Props }) => (f.properties.kind === 'weapon' ? [255, 90, 90, 180] : [90, 200, 255, 160]), lineWidthMinPixels: 1 }),
        new ScatterplotLayer({ id: 'contacts', data: fc('contacts').features, pickable: true, stroked: true, filled: true, radiusUnits: 'meters',
          getPosition: (f: GeoJSON.Feature<GeoJSON.Point>) => f.geometry.coordinates as [number, number], getRadius: (f: { properties: Props }) => Math.max(2000, f.properties.errorKm * 1000),
          getFillColor: (f: { properties: Props }) => { const c = factionColor(f.properties.estFaction); return [c[0], c[1], c[2], 25 + 60 * f.properties.confidence] as Rgba; },
          getLineColor: (f: { properties: Props }) => { const c = factionColor(f.properties.estFaction); return [c[0], c[1], c[2], 80 + 175 * f.properties.confidence] as Rgba; }, lineWidthMinPixels: 1, radiusMinPixels: 3 }),
        new IconLayer({ id: 'units', data: fc('units').features, pickable: true, sizeUnits: 'pixels', getSize: 26,
          getPosition: (f: GeoJSON.Feature<GeoJSON.Point>) => f.geometry.coordinates as [number, number], getIcon: (f: { properties: Props }) => ({ id: `${f.properties.type}:${f.properties.status}`, ...icon(f.properties.type, f.properties.status) }),
          onClick: ({ object }: { object?: { properties: Props } }) => { if (object) this.onSelect(object.properties.id); } }),
      ],
    });
  }
}
