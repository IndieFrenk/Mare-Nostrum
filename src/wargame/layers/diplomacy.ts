/**
 * Modalità mappa della diplomazia (opinione, trattati, voto): palette, categorie dei trattati e geometria delle linee. I colori stanno in
 * `wargame.css` come variabili (`--wg-op-*`, `--wg-tr-*`, `--wg-vote-*`): scala divergente blu–arancio, leggibile anche da chi non distingue
 * il rosso dal verde; qui si leggono soltanto.
 */
import type { Agreement } from '../api-client';

/** Colore di una variabile CSS (un posto solo per le palette). */
export const cssColor = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';

export const OPINION_LABELS = ['ostile', 'fredda', 'neutra', 'cordiale', 'stretta'] as const;
/** Soglie tra le fasce finché la panoramica non è arrivata (le dà il server: `opinion.thresholds`). */
export const DEFAULT_THRESHOLDS = [-50, -15, 15, 50] as const;
/** Indice della fascia (0 ostile … 4 stretta): quante soglie il valore ha raggiunto. */
export const bandOf = (value: number, thresholds: readonly number[]): number => thresholds.filter((t) => value >= t).length;

/** Come si legge un trattato sulla mappa: categoria (colore) e tratto (pieno, tratteggiato, punteggiato). */
export const TREATY_CATS = [
  { id: 'defense', label: 'Difesa', dash: 'solid', types: ['defense', 'defense_cooperation'] },
  { id: 'guarantee', label: 'Garanzia', dash: 'solid', types: ['guarantee'] },
  { id: 'access', label: 'Accesso e basi', dash: 'dashed', types: ['military_access', 'basing'] },
  { id: 'trade', label: 'Commercio', dash: 'dashed', types: ['trade', 'arms_sale'] },
  { id: 'energy', label: 'Energia', dash: 'dotted', types: ['energy'] },
  { id: 'migration', label: 'Migrazioni', dash: 'dotted', types: ['migration'] },
  { id: 'other', label: 'Altri (non aggressione, tregua, intelligence)', dash: 'dotted', types: ['non_aggression', 'ceasefire', 'intel_sharing', 'secret'] },
] as const;
export type TreatyCat = (typeof TREATY_CATS)[number]['id'];
export const treatyCat = (type: Agreement['type']): TreatyCat => TREATY_CATS.find((c) => (c.types as readonly string[]).includes(type))?.id ?? 'other';

export const TREATY_TYPE_LABEL: Record<string, string> = {
  defense: 'Alleanza difensiva', defense_cooperation: 'Cooperazione di difesa', guarantee: 'Garanzia di sicurezza', military_access: 'Accesso militare', basing: 'Basi',
  trade: 'Accordo commerciale', arms_sale: 'Vendita di armi', energy: 'Accordo energetico', migration: 'Accordo migratorio', non_aggression: 'Patto di non aggressione',
  ceasefire: 'Cessate il fuoco', intel_sharing: 'Condivisione di intelligence', secret: 'Accordo riservato',
};

/** Sedi delle risoluzioni (engine/institutions.ts) col nome da mostrare. */
export const FORUM_NAME: Record<string, string> = { UNGA: 'Assemblea generale ONU', UNSC: 'Consiglio di sicurezza ONU', EU_COUNCIL: 'Consiglio UE', NATO: 'NATO', ARAB_LEAGUE: 'Lega Araba', AU: 'Unione Africana' };

/** Blocchi senza territorio: dove si ancorano le loro linee (Bruxelles). */
export const BLOC_POINT: Record<string, [number, number]> = { NATO: [4.4, 50.88], EU: [4.35, 50.85] };

type Pt = [number, number];

/** Centro di ogni Stato (ISO3) dal geojson dei confini: il centro del riquadro del poligono più grande (le isole lontane non spostano il punto). */
export function centroids(fc: GeoJSON.FeatureCollection): Map<string, Pt> {
  const out = new Map<string, Pt>();
  for (const f of fc.features) {
    const iso = f.properties?.['ISO3166-1-Alpha-3'];
    if (typeof iso !== 'string' || !/^[A-Z]{3}$/.test(iso)) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    let best: Pt | null = null; let area = -1;
    for (const p of polys) {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      for (const [x, y] of p[0] ?? []) { x0 = Math.min(x0, x!); x1 = Math.max(x1, x!); y0 = Math.min(y0, y!); y1 = Math.max(y1, y!); }
      const a = (x1 - x0) * (y1 - y0);
      if (a > area) { area = a; best = [(x0 + x1) / 2, (y0 + y1) / 2]; }
    }
    if (best) out.set(iso, best);
  }
  return out;
}

/** Arco di cerchio massimo tra due punti (la linea di un trattato sul globo non è una retta sulla carta). */
export function arc(a: Pt, b: Pt, n = 24): Pt[] {
  const rad = Math.PI / 180;
  const vec = ([lon, lat]: Pt) => [Math.cos(lat * rad) * Math.cos(lon * rad), Math.cos(lat * rad) * Math.sin(lon * rad), Math.sin(lat * rad)] as const;
  const [A, B] = [vec(a), vec(b)];
  const omega = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
  if (omega < 1e-6) return [a, b];
  const out: Pt[] = [];
  let prev = a[0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k1 = Math.sin((1 - t) * omega) / Math.sin(omega); const k2 = Math.sin(t * omega) / Math.sin(omega);
    const x = k1 * A[0] + k2 * B[0]; const y = k1 * A[1] + k2 * B[1]; const z = k1 * A[2] + k2 * B[2];
    let lon = Math.atan2(y, x) / rad;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    prev = lon;
    out.push([lon, Math.asin(Math.max(-1, Math.min(1, z))) / rad]);
  }
  return out;
}

/** Miscela due colori esadecimali (#rrggbb): `t` = 0 il primo, 1 il secondo. */
export function mixColor(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
