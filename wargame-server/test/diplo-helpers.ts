import type { Agreement, Campaign, FactionOrders, WorldState } from '../src/schemas/index.js';
import { TurnCtx } from '../src/engine/context.js';
import { Rng } from '../src/engine/rng.js';
import { loadScenario } from '../src/engine/scenario.js';
import { validateOrders } from '../src/engine/validators.js';

/** Strumenti comuni dei test del settore 09 (capitale, catalogo, accettazione, legittimità, decisore a regole). */
export const sc = loadScenario('med-2026');
export const campaign = (turnLength: 'week' | 'month' = 'week'): Campaign => ({ turnLength, playerFaction: 'ITA', seed: 's', rngCursor: 0, phase: 'ADJUDICATION', currentTurn: 1 } as unknown as Campaign);
export function ctxOf(mutate?: (s: WorldState) => void, turnLength: 'week' | 'month' = 'week') {
  const s = structuredClone(sc.world);
  s.turn = 1;
  mutate?.(s);
  return new TurnCtx(s, campaign(turnLength), sc, new Rng('diplomazia', 0, 1), 0);
}
export const empty = { military: [], procurement: [], statements: [] };
export const validate = (s: WorldState, f: string, diplomacy: any[]) => validateOrders(s, sc.catalog, f, { ...empty, diplomacy });
export const capital = (s: WorldState, f: string) => s.diplomacy!.capital[f]!;
export const demarche = (id: string, target: string) => ({ id, kind: 'DEMARCHE' as const, target, message: 'x', visibility: 'public' as const });
export const threat = (id: string, target: string) => ({ id, kind: 'THREAT' as const, target, message: 'x', visibility: 'public' as const });
export const trade = (id: string, parties: string[], type: Agreement['type'] = 'trade') => ({ id, kind: 'PROPOSE_AGREEMENT' as const, target: parties.slice(1), agreement: { type, parties, terms: 'prova', endTurn: null, visibility: 'public' as const } });
export const agreement = (id: string, type: Agreement['type'], parties: string[], status: Agreement['status'] = 'active'): Agreement => ({ id, type, parties, terms: 'prova', startTurn: 0, endTurn: null, visibility: 'public', status });
export const orders = (factionId: string, diplomacy: any[], military: any[] = []): FactionOrders => ({ schemaVersion: 1, factionId, turn: 1, source: 'ai', military, diplomacy, procurement: [], statements: [] });

