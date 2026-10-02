import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogItem, WorldState, type Crisis, type Relation, type Unit } from '../schemas/index.js';
import { initialCapital } from './diplo-actions.js';
import { initialDiplomacy } from './opinion.js';

export const SCENARIOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scenarios');

export interface UnitClass {
  name: string; type: Unit['type']; domain: Unit['domain']; sig: [number, number, number];
  sensors: [Unit['sensors'][number]['type'], number, number][]; op: number; atk: number; def: number; loadout: Record<string, number>;
}
export interface Catalog {
  munitions: Record<string, { name: string; role: 'aa' | 'sam' | 'asm' | 'land' | 'torp'; cost: number }>;
  classes: Record<string, UnitClass>;
  items: CatalogItem[];
}
export interface EventRow { id: string; weight: number; minTension: number; text: string; zones: string[]; crisis?: [string, number]; crisisAny?: number; infra?: [string, string]; indicators?: Record<string, number> }
export interface Scenario {
  id: string; name: string; startDate: string; turnLength: 'week' | 'month';
  catalog: Catalog; world: WorldState; events: EventRow[]; profiles: Record<string, string>; geo: Record<string, unknown>;
  /** alias italiani di zone e fazioni (names.json, facoltativo) per riconoscere i nomi nelle direttive del giocatore */
  names: ScenarioNames;
}
export interface ScenarioNames { zones: Record<string, string[]>; factions: Record<string, string[]>; /** alias delle unità per id (le proprie, per chi scrive) */ units: Record<string, string[]> }

const cache = new Map<string, Scenario>();
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

export function listScenarios() {
  return readdirSync(SCENARIOS_DIR).filter((d) => existsSync(path.join(SCENARIOS_DIR, d, 'scenario.json')))
    .map((d) => { const s = readJson(path.join(SCENARIOS_DIR, d, 'scenario.json')); return { id: s.id, name: s.name, startDate: s.startDate }; });
}

export function makeUnit(cls: UnitClass, u: { id: string; factionId: string; name: string; classId: string; count: number; homeBaseId: string }, loc: Unit['location'], zoneId: string): Unit {
  return {
    ...u, type: cls.type, domain: cls.domain, location: loc, zoneId, status: 'ready', readiness: 85, damage: 0, usageHours: 0,
    loadout: { ...cls.loadout }, signature: { radar: cls.sig[0], acoustic: cls.sig[1], ir: cls.sig[2], emcon: false },
    sensors: cls.sensors.map(([type, rangeKm, quality]) => ({ type, rangeKm, quality })), currentTask: null, opCostPerTurn: cls.op,
  };
}

/** Carica lo scenario idratando le unità compatte di world.json con le classi del catalogo. */
export function loadScenario(id: string): Scenario {
  const hit = cache.get(id);
  if (hit) return structuredClone(hit);
  const dir = path.join(SCENARIOS_DIR, id);
  const meta = readJson(path.join(dir, 'scenario.json'));
  const catalog: Catalog = readJson(path.join(dir, 'catalog.json'));
  catalog.items = catalog.items.map((i) => CatalogItem.parse(i));
  const raw = readJson(path.join(dir, 'world.json'));
  const bases = Object.fromEntries(raw.bases.map((b: { id: string }) => [b.id, b]));
  const zones = Object.fromEntries(raw.zones.map((z: { id: string }) => [z.id, z]));
  const units: Record<string, Unit> = {};
  for (const u of raw.units) {
    const cls = catalog.classes[u.classId];
    if (!cls) throw new Error(`classe mancante: ${u.classId}`);
    const base = bases[u.homeBaseId];
    const zoneId = u.zoneId ?? base.zoneId;
    const loc = u.zoneId ? zones[u.zoneId].center : base.location;
    units[u.id] = { ...makeUnit(cls, u, loc, zoneId), status: u.status ?? 'ready', readiness: u.readiness ?? 85, ...(u.estimated ? { estimated: true } : {}) };
  }
  const ids: string[] = raw.factions.map((f: { id: string }) => f.id);
  const relations: Record<string, Record<string, Relation>> = {};
  for (const a of ids) {
    relations[a] = {};
    for (const b of ids) if (a !== b) relations[a][b] = { ...raw.relations.default, tradeDependency: 0.1, lastIncidentTurn: null, notes: [] };
  }
  for (const [a, b, trust, tension] of raw.relations.pairs) {
    relations[a][b] = { ...relations[a][b], trust, tension };
    relations[b][a] = { ...relations[b][a], trust, tension };
  }
  const crises: Record<string, Crisis> = Object.fromEntries(raw.crises.map((c: Crisis) => [c.id, { ...c, status: c.escalation >= 4 ? 'active' : 'latent', startedTurn: 0, history: [] }]));
  const world = WorldState.parse({
    schemaVersion: 1, turn: 0, date: meta.startDate, rngCursor: 0,
    factions: Object.fromEntries(raw.factions.map((f: { id: string }) => [f.id, f])), units, bases,
    infrastructure: Object.fromEntries(raw.infrastructure.map((i: { id: string }) => [i.id, i])), zones,
    relations, crises, agreements: Object.fromEntries(raw.agreements.map((a: { id: string }) => [a.id, a])),
    pendingDeliveries: [], engagements: {}, globalIndicators: meta.globalIndicators,
  });
  for (const c of Object.values(world.crises)) for (const z of c.zoneIds) world.zones[z].tension = Math.max(world.zones[z].tension, c.escalation * 10);
  // opinione asimmetrica: le coppie dello scenario (fiducia, tensione) diventano modificatori «Situazione 2026» rispetto alla base dei dati
  // del mondo; fiducia e tensione tra fazioni restano come valori derivati (opinionOf, tensione di coppia)
  initialDiplomacy(world, raw.relations.pairs);
  initialCapital(world);
  const profiles = Object.fromEntries(readdirSync(path.join(dir, 'factions')).map((f) => [f.replace(/\.md$/, ''), readFileSync(path.join(dir, 'factions', f), 'utf8')]));
  const geo = Object.fromEntries(readdirSync(path.join(dir, 'geo')).map((f) => [f.replace(/\.geojson$/, ''), readJson(path.join(dir, 'geo', f))]));
  const namesFile = path.join(dir, 'names.json');
  const names: ScenarioNames = existsSync(namesFile) ? (({ zones = {}, factions = {}, units = {} }) => ({ zones, factions, units }))(readJson(namesFile)) : { zones: {}, factions: {}, units: {} };
  const sc: Scenario = { id, name: meta.name, startDate: meta.startDate, turnLength: meta.turnLength, catalog, world, events: readJson(path.join(dir, 'event-tables.json')).default, profiles, geo, names };
  cache.set(id, sc);
  return structuredClone(sc);
}
