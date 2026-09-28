// Genera geo/zones.geojson e geo/control.geojson ritagliando i poligoni di massima sulla linea di costa reale (1:50m),
// e src/wargame/assets/countries.geojson (confini 1:50m con codice ISO3) per la mappa della variante wargame.
// Uso: npm run geo:build [-- scenario]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc, { type MultiPolygon, type Polygon } from 'polygon-clipping';
import { feature as topoFeature } from 'topojson-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '..', 'public', 'data');
const dir = path.join(root, 'scenarios', process.argv[2] ?? 'med-2026');
const src = JSON.parse(readFileSync(path.join(dir, 'geo-src.json'), 'utf8'));
// ISO3 per nome, dal geojson a bassa risoluzione che ha i codici
const isoByName: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(path.join(dataDir, 'countries.geojson'), 'utf8')).features.map((f: any) => [f.properties.name, f.properties['ISO3166-1-Alpha-3']]));
const topo = JSON.parse(readFileSync(path.join(dataDir, 'countries-50m.json'), 'utf8'));
const countries = (topoFeature(topo, topo.objects.countries) as unknown as { features: { properties: Record<string, string>; geometry: { type: string; coordinates: any } | null }[] }).features
  .filter((f) => f.geometry).map((f) => ({ ...f, properties: { name: f.properties.name!, 'ISO3166-1-Alpha-3': isoByName[f.properties.name!] ?? '' } })) as { properties: Record<string, string>; geometry: { type: string; coordinates: any } }[];
const zonesOld = JSON.parse(readFileSync(path.join(dir, 'geo', 'zones.geojson'), 'utf8'));
const names: Record<string, string> = Object.fromEntries(zonesOld.features.map((f: any) => [f.id, f.properties.name]));

const asMulti = (g: { type: string; coordinates: any }): MultiPolygon => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const ring = (pts: [number, number][]): Polygon => [[...pts, pts[0]!]];
const land = pc.union(...countries.map((c) => asMulti(c.geometry)));
const country = (iso: string) => pc.union(...countries.filter((c) => c.properties['ISO3166-1-Alpha-3'] === iso).map((c) => asMulti(c.geometry)));
const round = (m: MultiPolygon) => m.map((p) => p.map((r) => r.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)])));
const round2 = (m: MultiPolygon) => m.map((p) => p.map((r) => r.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)])));
writeFileSync(path.join(root, '..', 'src', 'wargame', 'assets', 'countries.geojson'), JSON.stringify({ type: 'FeatureCollection', features: countries.map((f) => ({ type: 'Feature', properties: f.properties, geometry: { type: 'MultiPolygon', coordinates: round2(asMulti(f.geometry)) } })) }));
const feature = (id: string, props: Record<string, unknown>, m: MultiPolygon) => ({ type: 'Feature', id, properties: { id, ...props }, geometry: { type: 'MultiPolygon', coordinates: round(m) } });

const features = [
  ...Object.entries(src.sea as Record<string, [number, number][]>).map(([id, pts]) => feature(id, { name: names[id] ?? id, terrain: 'sea' }, pc.difference(ring(pts), land))),
  ...Object.entries(src.land as Record<string, any>).map(([id, def]) => feature(id, { name: names[id] ?? id, terrain: 'land' }, Array.isArray(def) ? pc.intersection(ring(def), land) : pc.union(...(def.countries ?? [def.country]).map(country)))),
];
writeFileSync(path.join(dir, 'geo', 'zones.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
const control = Object.entries(src.control as Record<string, { clipTo: string; outline: [number, number][] }>).map(([f, d]) => feature(f, { faction: f }, pc.intersection(ring(d.outline), country(d.clipTo))));
writeFileSync(path.join(dir, 'geo', 'control.geojson'), JSON.stringify({ type: 'FeatureCollection', features: control }));
console.log(`zone: ${features.length}, aree di controllo: ${control.length}`);
