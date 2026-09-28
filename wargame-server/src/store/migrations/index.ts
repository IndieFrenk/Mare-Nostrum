/**
 * Migrazioni dei file del DB: ogni file ha `schemaVersion`; in lettura si applicano i passi fino alla versione corrente.
 * Per un cambio di schema: incrementa CURRENT e aggiungi `STEPS[vecchia]` che trasforma il dato alla versione successiva.
 */
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
