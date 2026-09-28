/**
 * Migrazioni dei file del DB: ogni file ha `schemaVersion`; in lettura si applicano i passi fino alla versione corrente.
 * Per un cambio di schema: incrementa CURRENT e aggiungi `STEPS[vecchia]` che trasforma il dato alla versione successiva.
 */
import type { WorldState } from '../../schemas/index.js';
import { loadScenario } from '../../engine/scenario.js';

export const CURRENT = 1;
const STEPS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  let d = data as Record<string, unknown>;
  let v = typeof d.schemaVersion === 'number' ? d.schemaVersion : CURRENT;
  while (v < CURRENT) { d = STEPS[v]!(d); v++; d.schemaVersion = v; }
  if (v > CURRENT) throw new Error(`schemaVersion ${v} più recente del server (${CURRENT})`);
  return d as T;
}

const leaders = new Map<string, Record<string, { leaderTitle: string; capital: string }>>();
/**
 * Campagne create prima delle lettere: le fazioni non hanno `leaderTitle` e `capital` (lo schema li legge come '') e le lettere
 * dicevano «Il Capo di Stato (Turchia)». In lettura si riempiono i campi mancanti dallo scenario (`world.json`), solo in memoria:
 * i file salvati non si riscrivono (lo stato corrente si salva comunque a fine fase, già completo).
 */
export function fillLeaders(s: WorldState, scenarioId: string): WorldState {
  const missing = Object.values(s.factions).filter((f) => !f.leaderTitle || !f.capital);
  if (!missing.length) return s;
  let ref = leaders.get(scenarioId);
  if (!ref) {
    try { ref = Object.fromEntries(Object.values(loadScenario(scenarioId).world.factions).map((f) => [f.id, { leaderTitle: f.leaderTitle, capital: f.capital }])); }
    catch { ref = {}; }
    leaders.set(scenarioId, ref);
  }
  for (const f of missing) {
    const d = ref[f.id];
    if (!d) continue;
    if (!f.leaderTitle) f.leaderTitle = d.leaderTitle;
    if (!f.capital) f.capital = d.capital;
  }
  return s;
}
