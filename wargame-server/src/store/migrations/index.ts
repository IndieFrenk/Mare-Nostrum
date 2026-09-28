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

type Ref = Pick<WorldState['factions'][string], 'name' | 'leaderTitle' | 'capital' | 'policy'>;
const refs = new Map<string, Record<string, Ref>>();
/**
 * Campagne create prima di alcuni campi delle fazioni, riempiti in lettura dallo scenario (`world.json`), solo in memoria: i file
 * salvati non si riscrivono (lo stato corrente si salva comunque a fine fase, già completo).
 * - `leaderTitle` e `capital` (prima delle lettere: dicevano «Il Capo di Stato (Turchia)»);
 * - `policy`, il profilo del decisore a regole (prima di WARGAME_FACTION_MODE): senza, la fazione userebbe il profilo di ripiego;
 * - `name`: il nome non cambia mai in partita, vale quello dello scenario (es. «Libia (LNA, Bengasi)» invece del nome di una persona).
 */
export function fillFromScenario(s: WorldState, scenarioId: string): WorldState {
  let ref = refs.get(scenarioId);
  if (!ref) {
    try { ref = Object.fromEntries(Object.values(loadScenario(scenarioId).world.factions).map((f) => [f.id, { name: f.name, leaderTitle: f.leaderTitle, capital: f.capital, policy: f.policy }])); }
    catch { ref = {}; }
    refs.set(scenarioId, ref);
  }
  for (const f of Object.values(s.factions)) {
    const d = ref[f.id];
    if (!d) continue;
    if (!f.leaderTitle) f.leaderTitle = d.leaderTitle;
    if (!f.capital) f.capital = d.capital;
    if (!f.policy && d.policy) f.policy = structuredClone(d.policy);
    if (d.name && f.name !== d.name) f.name = d.name;
  }
  return s;
}
