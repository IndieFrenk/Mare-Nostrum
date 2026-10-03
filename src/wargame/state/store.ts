import type { LlmStatus, Campaign, CatalogView, CountryView, DiplomacyOverview, DiploCatalogRow, DiploLetter, FactionKnowledge, FC, GameEvent, LedgerEntry, NationDetail, NationSummary, OrdersBody, Overview, PendingCmo, TurnNarrative, Validation, VoteView } from '../api-client';

export type MapMode = 'politica' | 'diplomazia' | 'tensione' | 'crisi' | 'allineamento' | 'opinione' | 'trattati' | 'voto';

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
  /** lettere visibili al giocatore, tutti i turni */
  letters: DiploLetter[];
  /** id delle lettere ricevute già lette (per campagna, in localStorage) */
  lettersSeen: string[];
  layers: Record<string, FC>;
  selectedUnitId: string | null;
  /** selezione multipla (stile grand strategy); selectedUnitId è la prima */
  selection: string[];
  mapMode: MapMode;
  /** CD, tensione mondiale, ultimatum, trattati dell'Italia e opinione verso/di tutti gli Stati (GET /diplomacy/overview) */
  diplo: DiplomacyOverview | null;
  /** scheda diplomatica del paese selezionato (opinione nei due sensi, trattati, azioni con costo, accettazione stimata) */
  countryDiplo: CountryView | null;
  /** votazioni pubbliche recenti (le ultime 20, dalla più nuova) e quella mostrata nella modalità mappa «voto» */
  votes: VoteView[];
  voteId: string | null;
  /** modalità «opinione»: `out` = l'opinione dell'Italia verso gli Stati, `in` = la fascia di ogni Stato verso l'Italia */
  opinionDir: 'out' | 'in';
  /** reazioni internazionali dei turni recenti (eventi INTERNATIONAL_REACTIONS, pubblici), caricate all'apertura del pannello */
  reactions: { turn: number; event: GameEvent }[] | null;
  globe: boolean;
  drawer: string | null;
  /** attore selezionato: id di fazione se lo Stato è una fazione, altrimenti l'ISO3 (scheda paese in sola lettura) */
  country: string | null;
  /** registro dei 197 Stati (dati statici, caricati una volta) e schede complete già lette per ISO3 */
  nations: NationSummary[];
  nationDetail: Record<string, NationDetail>;
  /** catalogo delle azioni diplomatiche (costi in CD, ricariche, effetti): dati statici, caricati una volta */
  diploCatalog: DiploCatalogRow[];
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
  /** stato dei modelli (pallino nella barra in alto), aggiornato ogni 60 s e prima di ▶ */
  llm: LlmStatus | null;
  /** esito dell'ultima «Interpreta»: nomi riconosciuti e ordini nati dalle posture */
  parseNote: string | null;
}

export const emptyDraft = (): OrdersBody => ({ military: [], diplomacy: [], procurement: [], statements: [] });

type Listener = (s: UiState) => void;
const listeners = new Set<Listener>();

export const state: UiState = {
  campaignId: null, campaign: null, knowledge: null, overview: null, narrative: null, previous: null, ledger: [], catalog: null, events: [], cmo: [], letters: [], lettersSeen: [],
  layers: {}, selectedUnitId: null, selection: [], mapMode: 'politica', diplo: null, countryDiplo: null, votes: [], voteId: null, opinionDir: 'out', reactions: null, globe: true, drawer: 'briefing', country: null, nations: [], nationDetail: {}, diploCatalog: [], stack: null, draft: emptyDraft(), validation: null, submitted: false, progress: [], busy: false, running: null, error: null, llm: null, parseNote: null,
};

export function set(patch: Partial<UiState>) {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

export const subscribe = (l: Listener) => { listeners.add(l); return () => listeners.delete(l); };

let seq = 0;
export const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
