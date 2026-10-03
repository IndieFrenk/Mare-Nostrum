import type { Agreement, TieStatus, Ultimatum } from './world.js';

/**
 * Viste di sola lettura della diplomazia per l'interfaccia (`GET /campaigns/:id/diplomacy/overview`, `/diplomacy/country/:actor`,
 * `/institutions/votes`, docs/wargame/DIPLOMAZIA.md §12). Solo tipi: i dati vengono dalla Knowledge dell'Italia o sono pubblici (nebbia §5.6).
 */
export interface Reason { label: string; value: number }
/** Un modificatore d'opinione con i turni che mancano alla fine (`null` = non scade: permanente o finché la causa è attiva). */
export interface ModifierView { label: string; value: number; turnsLeft: number | null }
/** Fasce con cui si vede l'opinione degli altri verso di sé: 0 ostile … 4 stretta (indice in `OPINION_BANDS`). */
export type BandIndex = 0 | 1 | 2 | 3 | 4;

export interface AgreementView { id: string; type: Agreement['type']; parties: string[]; status: Agreement['status']; startTurn: number; endTurn: number | null }
export interface UltimatumView extends Pick<Ultimatum, 'id' | 'from' | 'to' | 'demand' | 'deadlineTurn' | 'status' | 'legitimateUntil'> { turnsLeft: number | null }

/** Quattro fasce della tensione mondiale (§6). */
export interface TensionBandView { index: 0 | 1 | 2 | 3; label: string; from: number; to: number; effect: string }

export interface DiplomacyOverview {
  turn: number;
  capital: { value: number; rent: number; weeks: number; improvingSlots: number; improving: { target: string; since: number }[]; coerciveCost: number };
  tension: { value: number; band: TensionBandView; bands: TensionBandView[]; from: number | null; causes: Reason[] };
  ultimatums: UltimatumView[];
  /** i trattati dell'Italia (in vigore o proposti): le linee della modalità mappa «Trattati» quando non c'è un paese selezionato */
  agreements: AgreementView[];
  /**
   * Opinione dell'Italia verso ogni Stato (`out`, valore: la sua riga) e degli Stati verso l'Italia (`in`, solo fascia: l'indice in `bands`; il
   * numero esatto solo con un accordo di intelligence, in `exact`). Chiavi: id dell'attore (fazione o ISO3). Mai le coppie tra terzi.
   */
  opinion: { bands: readonly string[]; /** soglie tra le fasce (4 valori): sotto la prima ostile, sopra l'ultima stretta */ thresholds: readonly number[]; out: Record<string, number>; in: Record<string, BandIndex>; exact: Record<string, number> };
}

export interface ActionRow {
  kind: string; /** sede (RESOLUTION) o tipo di trattato (PROPOSE_AGREEMENT) */ variant?: string; label: string;
  cost: number; coercive: boolean; effects: string;
  /** primo turno in cui si può ripetere, se in ricarica */
  cooldownUntil: number | null;
  available: boolean; errors: string[];
}
export interface ProposalRow extends ActionRow {
  /** come risponderebbe il destinatario a questa proposta: una **stima** (l'opinione esatta degli altri verso l'Italia non è nota senza intelligence) */
  accept: boolean; score: number; reasons: Reason[]; exact: boolean;
}

export interface CountryView {
  actor: string; iso2?: string; iso3?: string; name: string; isFaction: boolean; self: boolean;
  opinion: {
    out: { value: number; band: BandIndex; base: Reason[]; modifiers: ModifierView[] };
    in: { band: BandIndex; exact?: { value: number; base: Reason[]; modifiers: ModifierView[] }; /** solo le etichette degli atti pubblici (mai i valori) */ known: { label: string; turnsLeft: number | null }[] };
  };
  tension: number;
  ties: TieStatus | null; embargo: { toThem: boolean; toUs: boolean }; improving: { since: number } | null;
  agreements: (AgreementView & { shared: boolean })[];
  memberships: { id: string; nameIt: string; shared: boolean }[];
  actions: ActionRow[]; proposals: ProposalRow[];
}

export interface VoteView {
  id: string; turn: number; date: string | null; forum: string; institutionId: string; subject: string; topic: string;
  proposer: string; target: string | null; passed: boolean; rule: string; vetoes: string[];
  /** ISO3 per esito; chi non compare non vota (assente, osservatore o non membro) */
  yes: string[]; no: string[]; abstain: string[];
}
