import type { LatLon, WorldState } from '../schemas/index.js';

export function distanceKm(a: LatLon, b: LatLon): number {
  const R = 6371; const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r; const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lerp(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: +(a.lat + (b.lat - a.lat) * t).toFixed(3), lon: +(a.lon + (b.lon - a.lon) * t).toFixed(3) };
}

export function nearestZone(s: WorldState, p: LatLon, terrain?: 'sea' | 'land'): string {
  const zs = Object.values(s.zones).filter((z) => !terrain || z.terrain === terrain);
  return zs.reduce((best, z) => (distanceKm(p, z.center) < distanceKm(p, best.center) ? z : best), zs[0]).id;
}

/** Sposta un punto di `km` lungo una direzione casuale data da `u` ∈ [0,1). */
export function jitter(p: LatLon, km: number, u: number, v: number): LatLon {
  const d = km * v; const ang = u * 2 * Math.PI;
  return { lat: +(p.lat + (d / 111) * Math.cos(ang)).toFixed(3), lon: +(p.lon + (d / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(ang)).toFixed(3) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
