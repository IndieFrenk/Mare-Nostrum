import { z } from 'zod';

/**
 * Registro di tutti gli Stati del mondo (scenarios/_world/*.json, comuni a tutti gli scenari). Sono dati statici dello
 * scenario: non entrano nel WorldState né negli snapshot (docs/wargame/DIPLOMAZIA.md §4).
 */

/** ISO 3166-1 alpha-3; per il Kosovo si usa il codice di uso comune XKX (è quello del geojson della mappa). */
export const Iso3 = z.string().regex(/^[A-Z]{3}$/);

export const Region = z.enum(['Africa', 'Americas', 'Asia', 'Europe', 'Oceania']);
export const Government = z.enum(['democracy', 'hybrid', 'authoritarian', 'absolute_monarchy', 'theocracy', 'military', 'transitional']);
export const NuclearStatus = z.enum(['none', 'latent', 'declared', 'nato_sharing']);
export const EnergyRole = z.enum(['exporter', 'importer', 'mixed']);

/** Peso dei tre poli (Occidente, Cina, Russia), 0–1 con somma ≤ 1: il resto è non allineamento. */
export const Alignment = z.object({
  west: z.number().min(0).max(1), china: z.number().min(0).max(1), russia: z.number().min(0).max(1),
}).refine((a) => a.west + a.china + a.russia <= 1.0001, { message: 'la somma dei poli supera 1' });

export const TradePartner = z.object({ iso3: Iso3, share: z.number().min(0).max(1) });

export const Nation = z.object({
  iso3: Iso3, iso2: z.string().regex(/^[A-Z]{2}$/), nameIt: z.string().min(2), capital: z.string().min(2),
  /** solo la carica («Il Presidente della Repubblica del Kenya»), mai il nome di una persona */
  leaderTitle: z.string().min(5),
  /** classificazione ONU M49 */
  region: Region, subregion: z.string(),
  government: Government,
  /** 0–10, scala tipo Democracy Index */
  democracyScore: z.number().min(0).max(10),
  /** milioni di abitanti */
  population: z.number().min(0),
  /** miliardi di dollari correnti */
  gdpUsdB: z.number().min(0),
  /** spesa militare, miliardi di dollari */
  milexUsdB: z.number().min(0),
  /** militari in servizio attivo, migliaia */
  activePersonnelK: z.number().min(0),
  nuclear: NuclearStatus,
  alignment: Alignment,
  /**
   * Punto ideale nelle votazioni dell'Assemblea generale, normalizzato su −1 (ordine liberale occidentale) … +1 (blocco
   * Cina/Russia e revisionisti). Assente se non stimabile. I dati reali (Voeten et al.) non sono scaricabili a runtime:
   * i valori del registro sono stime ragionate (vedi `confidence.unIdealPoint`).
   */
  unIdealPoint: z.number().min(-1).max(1).optional(),
  /** `oil` e `gas`: peso 0–1 della risorsa (quota dell'export per chi esporta, dipendenza dall'import per chi importa) */
  energy: z.object({ role: EnergyRole, oil: z.number().min(0).max(1), gas: z.number().min(0).max(1) }),
  /** fino a 5 partner, quota sul commercio totale del paese */
  topTrade: z.array(TradePartner).max(5),
  /** id delle istituzioni di institutions.json (derivato da `members`) */
  memberships: z.array(z.string()),
  /** fazione dello scenario med-2026 che governa questo Stato (DZA ↔ ALG, LBY ↔ LBY_GNU); assente per gli altri */
  factionId: z.string().optional(),
  /** fonte per campo (es. `population: «Banca Mondiale 2024»` oppure `«stima»`) */
  sources: z.record(z.string(), z.string()),
  /** affidabilità 0–1 per campo: i valori stimati a mano stanno sotto 0,7 */
  confidence: z.record(z.string(), z.number().min(0).max(1)),
});

export const InstitutionKind = z.enum(['alliance', 'union', 'regional', 'economic', 'security', 'un']);
/** `unsc` = 15 membri, veto dei permanenti (`leaders`); `qmv` = maggioranza qualificata (UE: 55% degli Stati, 65% della popolazione) */
export const DecisionRule = z.enum(['consensus', 'unanimity', 'majority', 'qmv', 'unsc']);
export const InstitutionEffect = z.enum(['collective_defense', 'common_sanctions', 'single_market', 'veto_members', 'non_binding', 'energy_quotas', 'joint_command']);

export const Institution = z.object({
  id: z.string().min(2), name: z.string(), nameIt: z.string(),
  kind: InstitutionKind,
  /** ISO3 dei membri con diritto di voto */
  members: z.array(Iso3).min(1),
  /** osservatori senza voto (Santa Sede e Palestina all'ONU) */
  observers: z.array(Iso3).default([]),
  /** Stati guida: permanenti con veto nel CdS, grandi del blocco altrove */
  leaders: z.array(Iso3).default([]),
  decision: DecisionRule,
  /** 0–1: quanto i membri votano insieme */
  cohesion: z.number().min(0).max(1),
  effects: z.array(InstitutionEffect),
  /** mandato per i seggi a rotazione (CdS: «2025–26», «2026–27») */
  terms: z.record(Iso3, z.string()).optional(),
  notes: z.string().optional(),
});

/**
 * Coppie con una storia nota. **Direzionali**: `[a, b, valore, etichetta]` è l'opinione di base di `a` verso `b`
 * (−100…+100); le relazioni simmetriche compaiono nei due sensi, quelle asimmetriche con valori diversi.
 */
export const HistoricPair = z.tuple([Iso3, Iso3, z.number().min(-100).max(100), z.string().min(3)]);

export const NationsFile = z.object({ schemaVersion: z.literal(1), asOf: z.string(), nations: z.array(Nation) });
export const InstitutionsFile = z.object({ schemaVersion: z.literal(1), asOf: z.string(), institutions: z.array(Institution) });
export const PairsFile = z.object({ schemaVersion: z.literal(1), pairs: z.array(HistoricPair) });

/** Riga compatta dell'elenco `GET /api/wg/nations` (mappa, modalità Allineamento, ricerca). */
export const NationSummary = z.object({
  iso3: Iso3, nameIt: z.string(), region: Region, government: Government, population: z.number(), gdpUsdB: z.number(),
  nuclear: NuclearStatus, alignment: Alignment, factionId: z.string().optional(),
});

export type Iso3 = z.infer<typeof Iso3>;
export type Region = z.infer<typeof Region>;
export type Government = z.infer<typeof Government>;
export type Alignment = z.infer<typeof Alignment>;
export type Nation = z.infer<typeof Nation>;
export type Institution = z.infer<typeof Institution>;
export type HistoricPair = z.infer<typeof HistoricPair>;
export type NationSummary = z.infer<typeof NationSummary>;
