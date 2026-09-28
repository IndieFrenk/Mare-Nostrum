import type { FactionKnowledge, LatLon, WorldState } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';
import { GameError } from '../engine/turn-machine.js';

type FC = { type: 'FeatureCollection'; features: { type: 'Feature'; id?: string; properties: Record<string, unknown>; geometry: unknown }[] };
const pt = (p: LatLon) => ({ type: 'Point', coordinates: [p.lon, p.lat] });
const geo = (sc: Scenario, name: string) => structuredClone(sc.geo[name] as FC);

function circle(c: LatLon, km: number, n = 48) {
  const ring = Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c.lon + (km / (111 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(a), c.lat + (km / 111) * Math.cos(a)];
  });
  return { type: 'Polygon', coordinates: [ring] };
}
const WEAPON_KM: Record<string, number> = { METEOR: 150, ASTER30_B1NT: 120, ASTER15: 30, STORM_SHADOW: 550, TESEO_MK2E: 360, MARTE_ER: 100, BLACK_SHARK: 50, GBU_KIT: 25, IRIS_T: 25 };

/** Layer GeoJSON filtrati per la Knowledge del giocatore (mai verità di terra sulle forze altrui). */
export function layer(name: string, s: WorldState, k: FactionKnowledge, sc: Scenario, unitId?: string): FC {
  switch (name) {
    case 'units': return { type: 'FeatureCollection', features: k.ownUnits.filter((u) => u.status !== 'destroyed').map((u) => ({ type: 'Feature', id: u.id, properties: { id: u.id, name: u.name, type: u.type, domain: u.domain, status: u.status, readiness: u.readiness, count: u.count, classId: u.classId, task: (u.currentTask as { kind?: string } | null)?.kind ?? null }, geometry: pt(u.location) })) };
    case 'contacts': return { type: 'FeatureCollection', features: k.contacts.map((c) => ({ type: 'Feature', id: c.id, properties: { id: c.id, classification: c.classification, estFaction: c.estFaction, confidence: c.confidence, errorKm: c.errorKm, domain: c.domain, sources: c.sources }, geometry: pt(c.location) })) };
    case 'zones': { const fc = geo(sc, 'zones'); fc.features.forEach((f) => { const z = s.zones[f.id as string]; Object.assign(f.properties, { tension: z?.tension ?? 0, terrain: z?.terrain, center: z ? [z.center.lon, z.center.lat] : null }); }); return fc; }
    case 'crises': {
      const fc = geo(sc, 'zones');
      fc.features = fc.features.flatMap((f) => {
        const cs = k.knownCrises.filter((c) => c.zoneIds.includes(f.id as string));
        return cs.length ? [{ ...f, properties: { ...f.properties, escalation: Math.max(...cs.map((c) => c.escalation)), crises: cs.map((c) => c.title).join(' · ') } }] : [];
      });
      return fc;
    }
    case 'infrastructure': { const fc = geo(sc, 'infrastructure'); fc.features.forEach((f) => Object.assign(f.properties, { status: s.infrastructure[f.id as string]?.status })); return fc; }
    case 'lanes': return geo(sc, 'lanes');
    case 'control': return geo(sc, 'control');
    case 'ranges': {
      const u = k.ownUnits.find((x) => x.id === unitId);
      if (!u) return { type: 'FeatureCollection', features: [] };
      const sensor = Math.max(0, ...u.sensors.map((x) => x.rangeKm));
      const weapon = Math.max(0, ...Object.keys(u.loadout).map((m) => WEAPON_KM[m] ?? 0));
      return { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { kind: 'sensor', km: sensor }, geometry: circle(u.location, sensor) },
        ...(weapon ? [{ type: 'Feature' as const, properties: { kind: 'weapon', km: weapon }, geometry: circle(u.location, weapon) }] : []),
      ] };
    }
    default: throw new GameError('NOT_FOUND', `layer ${name} inesistente`);
  }
}
