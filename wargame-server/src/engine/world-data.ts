import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HistoricPair, InstitutionsFile, NationsFile, PairsFile, type Institution, type Nation, type NationSummary, type Region } from '../schemas/nations.js';
import { SCENARIOS_DIR } from './scenario.js';

/**
 * Dati statici del mondo (scenarios/_world/*.json, docs/wargame/DIPLOMAZIA.md §4): 197 Stati, istituzioni, coppie storiche.
 * Si caricano e si validano **una volta** all'avvio; niente di tutto questo entra nel WorldState né negli snapshot.
 * Tutto è deterministico: stessi file, stessi indici, stesso ordine (ISO3 crescente).
 */
export interface WorldData {
  readonly asOf: string;
  readonly sourceLegend: Record<string, string>;
  readonly nations: readonly Nation[];
  readonly institutions: readonly Institution[];
  readonly pairs: readonly HistoricPair[];
  nation(iso3: string): Nation | undefined;
  institution(id: string): Institution | undefined;
  /** id dell'attore per uno Stato: la fazione dello scenario se c'è (DZA → ALG, LBY → LBY_GNU), altrimenti l'ISO3 */
  actorOf(iso3: string): string;
  /** ISO3 di una fazione (ALG → DZA); undefined per blocchi e attori non statali (NATO, EU, LBY_LNA) */
  isoOf(actorId: string): string | undefined;
  /** ISO3 dei membri (con diritto di voto) di un'istituzione, in ordine crescente */
  membersOf(institutionId: string): string[];
  byRegion(region: Region): Nation[];
  /** valore storico dell'opinione di base di `a` verso `b` (0 se la coppia non ha una storia nota) */
  pairValue(a: string, b: string): { value: number; label: string } | undefined;
  summaries(): NationSummary[];
}

const readJson = (dir: string, file: string) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));

export function loadWorldData(dir = path.join(SCENARIOS_DIR, '_world')): WorldData {
  const nf = NationsFile.parse(readJson(dir, 'nations.json'));
  const inf = InstitutionsFile.parse(readJson(dir, 'institutions.json'));
  const pf = PairsFile.parse(readJson(dir, 'pairs.json'));
  const nations = [...nf.nations].sort((a, b) => (a.iso3 < b.iso3 ? -1 : 1));
  const byIso = new Map(nations.map((n) => [n.iso3, n]));
  if (byIso.size !== nations.length) throw new Error('nations.json: ISO3 duplicati');
  const institutions = [...inf.institutions].sort((a, b) => (a.id < b.id ? -1 : 1));
  const byInst = new Map(institutions.map((i) => [i.id, i]));
  const isoByFaction = new Map(nations.filter((n) => n.factionId).map((n) => [n.factionId!, n.iso3]));
  const regions = new Map<Region, Nation[]>();
  for (const n of nations) regions.set(n.region, [...(regions.get(n.region) ?? []), n]);
  const pairs = new Map(pf.pairs.map(([a, b, value, label]) => [`${a}>${b}`, { value, label }]));
  for (const [a, b] of pf.pairs) if (!byIso.has(a) || !byIso.has(b)) throw new Error(`pairs.json: Stato inesistente nella coppia ${a}-${b}`);
  for (const i of institutions) for (const m of [...i.members, ...i.observers]) if (!byIso.has(m)) throw new Error(`institutions.json: ${i.id} ha un membro inesistente (${m})`);

  return {
    asOf: nf.asOf, sourceLegend: nf.sourceLegend, nations, institutions, pairs: pf.pairs,
    nation: (iso3) => byIso.get(iso3),
    institution: (id) => byInst.get(id),
    actorOf: (iso3) => byIso.get(iso3)?.factionId ?? iso3,
    isoOf: (actorId) => isoByFaction.get(actorId) ?? (byIso.has(actorId) && !byIso.get(actorId)!.factionId ? actorId : undefined),
    membersOf: (id) => [...(byInst.get(id)?.members ?? [])].sort(),
    byRegion: (r) => [...(regions.get(r) ?? [])],
    pairValue: (a, b) => pairs.get(`${a}>${b}`),
    summaries: () => nations.map(({ iso3, nameIt, region, government, population, gdpUsdB, nuclear, alignment, factionId }) => ({ iso3, nameIt, region, government, population, gdpUsdB, nuclear, alignment, ...(factionId ? { factionId } : {}) })),
  };
}

let shared: WorldData | null = null;
/** Registro condiviso, caricato alla prima richiesta (all'avvio del server) e poi in memoria. */
export const worldData = (): WorldData => (shared ??= loadWorldData());
export const nation = (iso3: string) => worldData().nation(iso3);
export const actorOf = (iso3: string) => worldData().actorOf(iso3);
export const membersOf = (institutionId: string) => worldData().membersOf(institutionId);
