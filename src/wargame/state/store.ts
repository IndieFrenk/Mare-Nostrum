import type { Campaign, CatalogView, FactionKnowledge, FC, GameEvent, LedgerEntry, OrdersBody, Overview, PendingCmo, TurnNarrative, Validation } from '../api-client';

export interface UiState {
  campaignId: string | null;
  campaign: Campaign | null;
  knowledge: FactionKnowledge | null;
  overview: Overview | null;
  narrative: TurnNarrative | null;
  previous: TurnNarrative | null;
  ledger: LedgerEntry[];
  catalog: CatalogView | null;
  events: GameEvent[];
  cmo: PendingCmo[];
  layers: Record<string, FC>;
  selectedUnitId: string | null;
  /** selezione multipla (stile grand strategy); selectedUnitId è la prima */
  selection: string[];
  mapMode: 'politica' | 'diplomazia' | 'tensione' | 'crisi';
  globe: boolean;
  drawer: string | null;
  country: string | null;
  /** pedina impilata aperta */
  stack: string[] | null;
  draft: OrdersBody;
  validation: Validation | null;
  submitted: boolean;
  progress: string[];
  busy: boolean;
  /** operazione in corso sul server (es. un turno con gli agenti LLM), anche partita prima di ricaricare la pagina */
  running: { op: string; since: number } | null;
  error: string | null;
}

export const emptyDraft = (): OrdersBody => ({ military: [], diplomacy: [], procurement: [], statements: [] });

type Listener = (s: UiState) => void;
const listeners = new Set<Listener>();

export const state: UiState = {
  campaignId: null, campaign: null, knowledge: null, overview: null, narrative: null, previous: null, ledger: [], catalog: null, events: [], cmo: [],
  layers: {}, selectedUnitId: null, selection: [], mapMode: 'politica', globe: true, drawer: 'briefing', country: null, stack: null, draft: emptyDraft(), validation: null, submitted: false, progress: [], busy: false, running: null, error: null,
};

export function set(patch: Partial<UiState>) {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

export const subscribe = (l: Listener) => { listeners.add(l); return () => listeners.delete(l); };

let seq = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
