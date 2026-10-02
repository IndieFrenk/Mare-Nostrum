# SPEC — Mare Nostrum (sezioni 1–12 del prompt originale)

## 1. REGOLE D'ORO DELL'ARCHITETTURA

1. **Il motore deterministico è l'unica fonte di verità.** Bilancio, OOB, posizioni, scorte, danni, consegne, tiri di dado: solo codice. Gli LLM non scrivono mai lo stato: propongono ordini strutturati che il motore valida ed esegue.
2. **Fog of war strutturale.** Ogni agente (e l'interfaccia del giocatore) riceve solo la `FactionKnowledge` della propria fazione, mai il `WorldState`. La vista "god" esiste solo con flag di debug o a campagna conclusa.
3. **Tutto è registrato.** Ogni scelta di ogni agente (input, valutazione, opzioni considerate, ordini, modello, token) e ogni tiro di dado finiscono nel database JSON. Una campagna è rigiocabile e ramificabile da qualsiasi turno.
4. **Riproducibilità.** RNG con seed per campagna. Le risposte LLM sono salvate: il replay rilegge le decisioni salvate invece di richiamare il modello.
5. **Stesso schema ordini per umano e IA.** `FactionOrders` è identico per il giocatore e per gli agenti: stessa validazione, stessa esecuzione.
6. **I narratori non inventano numeri.** Il GM narratore riceve una lista di fatti numerici dal motore; un validatore rifiuta testi che contengono cifre non presenti nei fatti.

---

## 2. CONCEPT DI GIOCO (riassunto dal design originale)

- **Giocatore:** Autorità Nazionale di Comando dell'Italia (Presidente del Consiglio / Ministro della Difesa).
- **Focus:** relazioni interstatali, deterrenza, intelligence, energia (infrastrutture ENI, gasdotti, cavi), rotte commerciali, credibilità militare. Niente politica interna micro-gestita (solo un indicatore astratto di stabilità).
- **Tono:** realistico, tecnico, pragmatico, spietato. Testi di gioco in italiano.
- **Turno:** settimanale o mensile (configurabile per campagna, può cambiare in crisi acuta).
- **Ciclo del turno:** Briefing → Direttive del giocatore → Decisioni IA e risoluzione macro (dadi virtuali, cyber, forze speciali, scaramucce) → Eventuale ingaggio maggiore da risolvere su **Command: Modern Operations (CMO)** con pacchetto OOB stimato / meteo / RoE e rientro dell'After Action Report → Debriefing (economia, diplomazia, usura).
- **Economia:** Fondo Operazioni & Emergenze Difesa (FOED) iniziale 3.200 M€. Ogni sortita/schieramento consuma quote operative. Acquisti con lead time in turni (catalogo in sezione 8.3).
- **Fog of war:** mai OOB esatti nemici; solo tracce radar, stime, SAR degradate, SIGINT. Informazioni precise richiedono ISR (droni, Cosmo-SkyMed, ricognizione).

---

## 3. ARCHITETTURA GENERALE

```
┌──────────────────────── FRONTEND (fork WorldMonitor, variante "wargame") ───────────────────────┐
│  Mappa globe.gl / deck.gl  ·  Pannelli: Briefing, Intel Feed, OOB, FOED, Procurement,           │
│  Diplomazia, Crisi, Console Ordini, Coda CMO, Turno, Post-mortem/Replay                          │
│  src/wargame/api-client.ts  ──HTTP/JSON + SSE──┐                                                 │
└────────────────────────────────────────────────┼─────────────────────────────────────────────────┘
                                                 ▼
┌──────────────────────────────── wargame-server (Node + TS + Fastify) ───────────────────────────┐
│  api/        REST + SSE + GeoJSON layers                                                         │
│  engine/     turn state machine · economy · procurement · movement · detection (fog) ·          │
│              adjudication · diplomacy · crises · attrition · cmo · rng                           │
│  agents/     orchestrator · faction-agent (×N) · gm-narrator · intel-analyst · order-parser ·   │
│              reflection (memoria) · validator/repair · llm-client (OpenAI-compatible)           │
│  store/      JSON database event-sourced (file system), lock, snapshot, fork                     │
│  schemas/    Zod = unica fonte dei tipi → export JSON Schema                                    │
│  scenarios/  med-2026: world.json, factions/*.md, catalog.json, event-tables.json, geo/*.geojson │
└──────────────────────────────────────┬──────────────────────────────────────────────────────────┘
                                       ▼
                 OmniRoute (http://localhost:20128/v1, OpenAI-compatible)
                 ├─ modelli locali (Ollama / llama.cpp / vLLM)
                 └─ provider remoti opzionali con fallback
```

Scelte tecnologiche (motivate, non cambiarle senza annotarlo in PROGRESS.md):
- **Backend:** Node (versione da `.nvmrc`), TypeScript strict, Fastify, Zod (+ `zod-to-json-schema`), Vitest. Nessun database esterno: file JSON/JSONL con scritture atomiche.
- **Perché JSON su file:** leggibile a mano, versionabile, diffabile tra rami, requisito esplicito del progetto. Astrarre dietro un'interfaccia `Store` per poter passare in futuro a SQLite senza toccare il motore.
- **LLM:** un solo client OpenAI-compatible puntato a OmniRoute; ogni ruolo agente ha un alias di modello configurabile.
- **Frontend:** riusa la macchina di varianti di WorldMonitor; niente framework nuovi. Simbologia militare con `milsymbol` (MIT) per le unità.

---

## 4. STRUTTURA DELLA REPO (target)

```
worldmonitor/                         # fork
├─ src/
│  └─ wargame/                        # NUOVO: tutto il codice UI del gioco
│     ├─ api-client.ts                # client REST/SSE tipizzato (tipi importati da wargame-server/schemas)
│     ├─ variant.ts                   # registrazione variante "wargame"
│     ├─ layers/                      # layer mappa: units, contacts, crises, infrastructure, lanes, ranges
│     ├─ panels/                      # pannelli di gioco (vedi sezione 10)
│     └─ state/                       # store UI (stato turno, selezione unità, bozza ordini)
├─ wargame-server/                    # NUOVO: backend del gioco (package separato o workspace npm)
│  ├─ package.json
│  ├─ src/
│  │  ├─ index.ts                     # bootstrap Fastify
│  │  ├─ config.ts                    # env + config campagna
│  │  ├─ schemas/                     # Zod: campaign, world, faction, unit, orders, knowledge, events, decisions, ...
│  │  ├─ store/                       # JsonStore, lock, atomicWrite, snapshot, fork
│  │  ├─ engine/
│  │  │  ├─ rng.ts                    # PRNG con seed (es. mulberry32/PCG) + notazione dadi "2d6+1" + log dei tiri
│  │  │  ├─ turn-machine.ts           # fasi del turno (sezione 6)
│  │  │  ├─ economy.ts                # FOED, ledger, costi operativi, upkeep
│  │  │  ├─ procurement.ts            # ordini d'acquisto, lead time, consegne
│  │  │  ├─ movement.ts               # spostamenti per zona/coordinate, tempi di transito
│  │  │  ├─ detection.ts              # sensori vs firme → contatti con errore/confidenza
│  │  │  ├─ knowledge.ts              # costruzione FactionKnowledge
│  │  │  ├─ adjudication.ts           # risoluzione ordini, conflitti, scaramucce
│  │  │  ├─ combat.ts                 # risoluzione astratta minori + soglia per CMO
│  │  │  ├─ diplomacy.ts              # matrice relazioni, accordi, sanzioni
│  │  │  ├─ crises.ts                 # scala di escalation 0–10, eventi casuali da tabelle
│  │  │  ├─ attrition.ts              # usura, prontezza, manutenzione, riparazioni
│  │  │  ├─ cmo.ts                    # pacchetto ingaggio + applicazione AAR
│  │  │  └─ validators.ts             # validazione ordini (budget, disponibilità, raggio, compatibilità)
│  │  ├─ agents/
│  │  │  ├─ llm-client.ts             # OpenAI-compatible, retry, timeout, structured output
│  │  │  ├─ mock-provider.ts          # risposte deterministiche per test
│  │  │  ├─ orchestrator.ts           # esegue gli agenti di fazione in parallelo con limite di concorrenza
│  │  │  ├─ context-builder.ts        # prompt per fazione da Knowledge + Memory + azioni lecite
│  │  │  ├─ faction-agent.ts
│  │  │  ├─ gm-narrator.ts
│  │  │  ├─ intel-analyst.ts
│  │  │  ├─ order-parser.ts           # testo libero del giocatore → FactionOrders (da confermare)
│  │  │  ├─ reflection.ts             # aggiornamento memoria a fine turno
│  │  │  ├─ repair.ts                 # correzione JSON non valido (max 2 tentativi) → fallback dottrinale
│  │  │  └─ prompts/*.md              # template dei prompt
│  │  ├─ api/                         # route Fastify (sezione 9)
│  │  └─ cli/sim.ts                   # simulazione headless: `npm run wargame:sim -- --turns 5 --mock`
│  ├─ scenarios/med-2026/             # scenario iniziale (sezione 8)
│  ├─ data/campaigns/                 # database runtime (gitignored)
│  └─ test/
└─ docs/wargame/                      # SPEC.md, RECON.md, PROGRESS.md, AGENTS.md (prompt design), README
```

---

## 5. DATABASE JSON (event-sourced, su file)

### 5.1 Layout su disco

```
wargame-server/data/campaigns/{campaignId}/
├─ campaign.json                          # Campaign (metadati, seed, turno/fase correnti, config, parent)
├─ state/
│  ├─ current.json                        # WorldState verità di terra (turno corrente)
│  └─ turn-{NNNN}.json                    # snapshot immutabile a chiusura di ogni turno
├─ knowledge/{factionId}/turn-{NNNN}.json # FactionKnowledge (ciò che la fazione sa)
├─ events/turn-{NNNN}.jsonl               # GameEvent append-only (una riga = un evento)
├─ rolls/turn-{NNNN}.jsonl                # DiceRoll append-only (trasparenza dei dadi)
├─ orders/turn-{NNNN}/{factionId}.json    # FactionOrders definitivi (umano e IA)
├─ decisions/turn-{NNNN}/{factionId}.json # AgentDecision: il "path" dell'IA
├─ memory/{factionId}.json                # AgentMemory (aggiornata a fine turno, versionata con 'turn')
├─ narrative/turn-{NNNN}.json             # Briefing, Debriefing, NewsItem simulati
├─ cmo/turn-{NNNN}/{engagementId}.json    # CmoPackage + AAR
├─ ledger.jsonl                           # LedgerEntry FOED e bilanci di tutte le fazioni
└─ llm-log/turn-{NNNN}.jsonl              # LlmCall grezze (prompt hash, risposta, token, latenza, errori)
```

### 5.2 Regole dello store
- Scritture atomiche: scrivi `*.tmp` e poi `rename`. Lock per campagna (file `.lock` con PID + timeout) durante `advance`.
- Ogni file ha `schemaVersion`. Validazione Zod in lettura e scrittura; migrazioni in `store/migrations/`.
- `state/current.json` deve essere sempre ricostruibile: `snapshot(turn N) + reduce(events turn N+1)`. Scrivi un test che lo verifica.
- **Fork/ramificazione:** `POST /fork {fromTurn}` crea una nuova campagna copiando i file fino a `fromTurn`, con `parent: {campaignId, turn}`. Serve per esplorare "cosa sarebbe successo se".
- **Replay:** `wargame:sim --replay {campaignId}` rigioca usando `decisions/` salvate (nessuna chiamata LLM) e deve produrre stati identici (test di determinismo).
- Indice leggero `data/campaigns/index.json` per la lista campagne.

---

## 6. CICLO DEL TURNO (macchina a stati)

```
OPEN → INTEL → BRIEFING → PLAYER_ORDERS → AI_DECISIONS → ADJUDICATION ─┬─→ DEBRIEF → CLOSED → (turno+1) OPEN
                                                                         └─→ CMO_PENDING ──(AAR)──┘
```

| Fase | Cosa fa | Chi |
|---|---|---|
| OPEN | Consegne in arrivo, upkeep, recupero prontezza, evoluzione crisi, eventi casuali da tabelle (seed) | Motore |
| INTEL | Modello di rilevamento: sensori/ISR di ogni fazione vs firme delle unità → contatti con errore e confidenza → `FactionKnowledge` per ogni fazione | Motore |
| BRIEFING | Briefing di situazione per l'Italia (solo dalla sua Knowledge) + report intelligence con affidabilità NATO (A–F/1–6) | GM narratore + analista intel |
| PLAYER_ORDERS | Il giocatore compone ordini (strutturati o testo libero → parser → conferma). `validate` in dry-run mostra costi, errori, rischi | UI + validatori |
| AI_DECISIONS | Ogni fazione IA riceve Knowledge + Memory + azioni lecite e restituisce un `AgentDecision`; validazione Zod + regole, repair max 2, poi fallback dottrinale | Agenti di fazione |
| ADJUDICATION | Esecuzione simultanea degli ordini: movimento, interazioni, cyber, SOF, diplomazia, scaramucce minori risolte con tiri registrati. Ingaggi sopra soglia → `Engagement` con `resolution: "cmo"` | Motore |
| CMO_PENDING | Pausa finché il giocatore non carica l'AAR per ogni ingaggio maggiore | UI |
| DEBRIEF | Ledger, relazioni, usura, crisi; debriefing narrativo; feed di notizie simulate per fazione; riflessione degli agenti → memoria | Motore + GM + reflection |
| CLOSED | Snapshot, avanzamento data | Motore |

**Soglia CMO** (configurabile): un ingaggio è "maggiore" se coinvolge ≥1 unità navale maggiore o ≥4 velivoli per parte, oppure uno strike missilistico con ≥8 vettori, oppure se il giocatore lo richiede. Il giocatore può scegliere "risoluzione automatica" anche per un ingaggio maggiore (con penalità di incertezza).

---

## 7. SCHEMA DATI TOTALE

Implementa questi tipi come **schemi Zod** in `wargame-server/src/schemas/` (i tipi TS si derivano con `z.infer`), esporta anche i JSON Schema in `wargame-server/schemas-json/` (script `npm run schemas:export`) e condividi i tipi con il frontend. I nomi dei campi sono vincolanti; puoi aggiungere campi, non rimuoverli.

### 7.1 Primitivi e identificatori
```ts
type FactionId = string;   // "ITA","FRA","USA","GBR","DEU","GRC","ESP","TUR","RUS","CHN","EGY","ISR","IRN","ALG","TUN","LBY_GNU","LBY_LNA","NATO","EU","WAGNER_AC" ...
type UnitId = string; type ContactId = string; type CrisisId = string; type EngagementId = string;
type Turn = number;        // 0 = setup
type MEur = number;        // milioni di euro, 1 decimale
type LatLon = { lat: number; lon: number };
type ZoneId = string;      // es. "CANALE_SICILIA", "MAR_LIBICO", "EGEO", "MEDITERRANEO_ORIENTALE", "MAR_ROSSO", "ADRIATICO"
type Visibility = "public" | FactionId[];           // chi può vedere un evento/messaggio
type Reliability = `${"A"|"B"|"C"|"D"|"E"|"F"}${1|2|3|4|5|6}`; // codice NATO Admiralty
```

### 7.2 Campagna
```ts
interface Campaign {
  schemaVersion: 1;
  id: string; name: string; scenarioId: string;
  seed: string; rngCursor: number;                  // posizione nel flusso RNG
  createdAt: string; updatedAt: string;
  currentTurn: Turn; phase: TurnPhase;
  date: string;                                     // data in-game ISO
  turnLength: "week" | "month";
  playerFaction: "ITA";
  parent: { campaignId: string; turn: Turn } | null;
  status: "active" | "ended";
  config: {
    fogLevel: "realistic" | "relaxed" | "none";
    debugGodView: boolean;
    cmoThreshold: { majorShips: number; aircraftPerSide: number; missileSalvo: number };
    llm: Record<AgentRole, { model: string; temperature: number; maxTokens: number; timeoutMs: number }>;
    maxConcurrentAgents: number;
  };
}
type TurnPhase = "OPEN"|"INTEL"|"BRIEFING"|"PLAYER_ORDERS"|"AI_DECISIONS"|"ADJUDICATION"|"CMO_PENDING"|"DEBRIEF"|"CLOSED";
type AgentRole = "faction_major" | "faction_minor" | "gm_narrator" | "intel_analyst" | "order_parser" | "reflection" | "repair";
```

### 7.3 Stato del mondo (verità di terra)
```ts
interface WorldState {
  schemaVersion: 1; turn: Turn; date: string;
  factions: Record<FactionId, Faction>;
  units: Record<UnitId, Unit>;
  bases: Record<string, Base>;
  infrastructure: Record<string, Infrastructure>;
  zones: Record<ZoneId, Zone>;
  relations: RelationMatrix;
  crises: Record<CrisisId, Crisis>;
  agreements: Record<string, Agreement>;
  pendingDeliveries: PendingDelivery[];
  engagements: Record<EngagementId, Engagement>;
  globalIndicators: { brentUsd: number; ttfEurMwh: number; medShippingRisk: number /*0-100*/; migrationPressure: number /*0-100*/ };
}

interface Faction {
  id: FactionId; name: string; kind: "state" | "bloc" | "nonstate";
  controller: "human" | "ai" | "scripted";
  agentRole: AgentRole | null;                      // faction_major per potenze, faction_minor per attori minori
  profileRef: string;                               // scenarios/med-2026/factions/{id}.md
  posture: 1 | 2 | 3 | 4 | 5;                       // 5 = pace, 1 = guerra aperta
  budget: { discretionary: MEur; perTurnIncome: MEur }; // per ITA discretionary = FOED
  stocks: Record<MunitionId, number>;               // magazzino nazionale non imbarcato
  stability: number;                                // 0-100 astratto (nessuna micro-gestione interna)
  credibility: number;                              // 0-100 credibilità militare/diplomatica
  objectives: Objective[];
  redLines: RedLine[];
  isrAssets: IsrAsset[];                            // satelliti, AEW, SIGINT, reti HUMINT
  cyber: { offense: number; defense: number };      // 0-10
  alliances: string[];                              // es. ["NATO","EU"]
}
interface Objective { id: string; text: string; priority: 1|2|3; metric: ConditionExpr; progress: number /*0-1*/ }
interface RedLine { id: string; text: string; trigger: ConditionExpr; response: string }
type ConditionExpr = string;                        // mini-DSL valutata dal motore, es. "crisis(LBY_OIL).escalation >= 6"

interface IsrAsset {
  id: string; type: "SAR_SAT" | "EO_SAT" | "AEW" | "MPA" | "MALE_DRONE" | "SIGINT" | "HUMINT_NET" | "OTH_RADAR";
  coverage: ZoneId[]; revisitTurns: number; quality: number /*0-1*/; tasking: ZoneId | null;
}

interface Unit {
  id: UnitId; factionId: FactionId; name: string;
  classId: string;                                  // chiave in catalog.json (es. "FREMM_BERGAMINI")
  type: "carrier"|"lhd"|"destroyer"|"frigate"|"opv"|"submarine"|"fighter_sqn"|"strike_sqn"|"aew"|"mpa"|"drone_flight"|"sam_battery"|"ground_bn"|"sof_team"|"tanker"|"transport";
  domain: "sea" | "subsurface" | "air" | "land" | "space" | "cyber";
  count: number;                                    // navi = 1; squadroni = n. velivoli disponibili
  homeBaseId: string;
  location: LatLon; zoneId: ZoneId;
  status: "ready" | "deployed" | "transit" | "maintenance" | "damaged" | "destroyed";
  readiness: number;                                // 0-100
  damage: number;                                   // 0-100
  usageHours: number;                               // accumulo usura
  loadout: Record<MunitionId, number>;
  signature: { radar: number; acoustic: number; ir: number; emcon: boolean }; // 0-10
  sensors: { type: "radar" | "sonar" | "esm" | "eo"; rangeKm: number; quality: number }[];
  currentTask: Order | null;
  opCostPerTurn: MEur;                              // quota operativa se schierata
}
type MunitionId = string;                           // es. "METEOR","ASTER30_B1NT","TESEO_MK2E","MARTE_ER","STORM_SHADOW","BLACK_SHARK","GBU_KIT","IRIS_T"

interface Base { id: string; name: string; factionId: FactionId; location: LatLon; type: "naval"|"air"|"joint"; capacity: number; damage: number }
interface Infrastructure {
  id: string; name: string; type: "pipeline" | "subsea_cable" | "lng_terminal" | "oil_field" | "gas_field" | "port" | "chokepoint";
  owners: FactionId[]; geometryRef: string;          // file geojson in scenarios/.../geo
  status: "operational" | "degraded" | "offline"; strategicValue: number /*0-10*/;
  flowShareIta?: number;                             // quota di approvvigionamento italiano 0-1
}
interface Zone { id: ZoneId; name: string; polygonRef: string; seaState: number; weatherSeed: number; controlledBy: FactionId | null; tension: number /*0-100*/ }
```

### 7.4 Relazioni, accordi, crisi
```ts
type RelationMatrix = Record<FactionId, Record<FactionId, Relation>>;
interface Relation { trust: number /*-100..100*/; tension: number /*0-100*/; tradeDependency: number /*0-1*/; lastIncidentTurn: Turn | null; notes: string[] }

interface Agreement {
  id: string; type: "defense" | "energy" | "basing" | "migration" | "ceasefire" | "arms_sale" | "intel_sharing" | "secret";
  parties: FactionId[]; terms: string; startTurn: Turn; endTurn: Turn | null;
  visibility: Visibility; status: "proposed" | "active" | "violated" | "expired";
}

interface Crisis {
  id: CrisisId; title: string; type: "maritime" | "energy" | "migration" | "hybrid" | "terror" | "civil_war" | "interstate";
  zoneIds: ZoneId[]; involved: FactionId[];
  escalation: number;                               // scala 0-10 (0 latente, 5 scontri limitati, 8 conflitto aperto regionale, 10 guerra maggiore)
  status: "latent" | "active" | "frozen" | "resolved";
  startedTurn: Turn; history: { turn: Turn; delta: number; cause: string }[];
}
```

### 7.5 Economia e procurement
```ts
interface LedgerEntry {
  turn: Turn; factionId: FactionId;
  category: "operations" | "procurement" | "repair" | "intel" | "diplomacy" | "income" | "penalty" | "other";
  amount: MEur;                                     // negativo = spesa
  balanceAfter: MEur; ref: string; note: string;
}
interface CatalogItem {                            // da scenarios/med-2026/catalog.json
  id: string; name: string; kind: "munition_lot" | "platform";
  lotSize?: number; munitionId?: MunitionId; cost: MEur;
  leadTimeTurns: number | null;                     // null = non rimpiazzabile nel breve termine
  repairCostRange?: [MEur, MEur]; compatibleWith?: string[]; // classId compatibili
}
interface PendingDelivery { id: string; factionId: FactionId; itemId: string; qty: number; orderedTurn: Turn; deliveryTurn: Turn; totalCost: MEur; destinationBaseId: string }
```

### 7.6 Ordini (schema unico umano/IA)
```ts
interface FactionOrders {
  schemaVersion: 1; factionId: FactionId; turn: Turn;
  source: "human" | "ai" | "fallback_doctrine" | "replay";
  military: Order[]; diplomacy: DiploAction[]; procurement: ProcurementOrder[]; statements: PublicStatement[];
}
type Order =
  | { id: string; kind: "MOVE"; unitIds: UnitId[]; to: ZoneId | LatLon; speed: "slow" | "cruise" | "flank" }
  | { id: string; kind: "PATROL" | "PRESENCE" | "SHOW_OF_FORCE"; unitIds: UnitId[]; zoneId: ZoneId; roe: Roe }
  | { id: string; kind: "ESCORT"; unitIds: UnitId[]; protect: UnitId | string /*convoglio/infrastruttura*/; roe: Roe }
  | { id: string; kind: "BLOCKADE" | "EXCLUSION_ZONE"; unitIds: UnitId[]; zoneId: ZoneId; roe: Roe }
  | { id: string; kind: "STRIKE"; unitIds: UnitId[]; targetRef: string; munitions: Record<MunitionId, number>; roe: Roe }
  | { id: string; kind: "ISR"; assetIds: string[]; zoneId: ZoneId }
  | { id: string; kind: "SOF_OP"; unitIds: UnitId[]; objective: string; zoneId: ZoneId; deniability: "overt" | "covert" }
  | { id: string; kind: "CYBER_OP"; target: FactionId; targetRef: string; effect: "espionage" | "disruption" | "defense_hardening" }
  | { id: string; kind: "AIR_DEFENSE"; unitIds: UnitId[]; zoneId: ZoneId; alert: "low" | "high" }
  | { id: string; kind: "REPAIR" | "RETURN_TO_BASE" | "STAND_DOWN"; unitIds: UnitId[] }
  | { id: string; kind: "EVACUATION"; unitIds: UnitId[]; zoneId: ZoneId };
type Roe = "WEAPONS_HOLD" | "WEAPONS_TIGHT" | "WEAPONS_FREE";

type DiploAction =
  | { id: string; kind: "DEMARCHE" | "THREAT" | "REASSURANCE"; target: FactionId; message: string; visibility: Visibility }
  | { id: string; kind: "PROPOSE_AGREEMENT"; target: FactionId[]; agreement: Omit<Agreement, "id" | "status" | "startTurn"> }
  | { id: string; kind: "RESPOND_AGREEMENT"; agreementId: string; response: "accept" | "reject" | "counter"; counterTerms?: string }
  | { id: string; kind: "SANCTION" | "LIFT_SANCTION"; target: FactionId; scope: string }
  | { id: string; kind: "BACKCHANNEL"; target: FactionId; message: string }
  | { id: string; kind: "NATO_ART4" | "EU_COUNCIL" | "UNSC_DRAFT"; subject: string }
  | { id: string; kind: "ENERGY_DEAL"; target: FactionId; infrastructureId: string; terms: string }
  | { id: string; kind: "AID"; target: FactionId; amount: MEur; type: "economic" | "military" }
  // settore 09 (DIPLOMAZIA.md §7): azioni con costo in capitale diplomatico; `target` può essere anche l'ISO3 di uno Stato senza fazione
  | { id: string; kind: "IMPROVE_RELATIONS" | "STOP_IMPROVE" | "RECALL_AMBASSADOR" | "EXPEL_DIPLOMATS" | "BREAK_RELATIONS" | "RESTORE_RELATIONS" | "ARMS_EMBARGO" | "LIFT_ARMS_EMBARGO"; target: FactionId }
  | { id: string; kind: "ULTIMATUM"; target: FactionId; demand: string; deadlineTurns: 1 | 2 | 3 | 4 }
  | { id: string; kind: "MEDIATE"; crisisId: string; parties: [FactionId, FactionId] }
  | { id: string; kind: "RESOLUTION"; forum: "UNSC" | "UNGA" | "EU_COUNCIL" | "NATO" | "ARAB_LEAGUE" | "AU"; subject: string; topic: "aggression" | "sanctions" | "humanitarian" | "maritime" | "nonproliferation" | "other"; target?: FactionId };
// NATO_ART4, EU_COUNCIL e UNSC_DRAFT (sopra) restano come alias in lettura di RESOLUTION con sede NATO, UE e CdS; Agreement.type ha in più
// "non_aggression" | "guarantee" | "military_access" | "defense_cooperation" | "trade".
interface ProcurementOrder { id: string; itemId: string; qty: number; destinationBaseId: string }
interface PublicStatement { id: string; audience: "domestic" | "international" | FactionId; text: string; tone: "conciliatory" | "firm" | "threatening" }
```

### 7.7 Conoscenza (fog of war)
```ts
interface FactionKnowledge {
  schemaVersion: 1; factionId: FactionId; turn: Turn;
  ownUnits: Unit[];                                 // completi
  ownFaction: Faction;
  contacts: Contact[];                              // tutto ciò che è stato rilevato, degradato
  intelReports: IntelReport[];
  beliefs: Record<FactionId, { estPosture: number; estIntent: string; confidence: number }>;
  knownCrises: Crisis[];                            // versione pubblica/percepita
  knownAgreements: Agreement[];                     // solo quelli visibili alla fazione
  inbox: DiploMessage[];                            // messaggi diplomatici ricevuti
  publicNews: NewsItem[];
}
interface Contact {
  id: ContactId; firstSeenTurn: Turn; lastSeenTurn: Turn;
  domain: Unit["domain"]; classification: string;   // "sconosciuto superficie", "probabile fregata classe Gorshkov" ...
  estFaction: FactionId | "unknown"; confidence: number; // 0-1
  location: LatLon; errorKm: number;                // ellisse d'errore semplificata
  estCount?: [number, number];                      // intervallo per formazioni/squadroni
  sources: ("radar" | "sar" | "eo" | "sigint" | "humint" | "ais" | "sonar" | "osint")[];
  truthUnitId?: UnitId;                             // SOLO nella verità di terra: mai serializzato verso agenti/UI (strip in knowledge.ts, test dedicato)
}
interface IntelReport {
  id: string; turn: Turn; source: Contact["sources"][number]; reliability: Reliability;
  classification: "NS" | "NR" | "NC" | "NS-SEGRETO";
  title: string; body: string;                      // testo prodotto dall'analista su fatti forniti dal motore
  relatedContacts: ContactId[]; factsRef: string[]; // id dei fatti motore usati (tracciabilità)
}
interface DiploMessage { id: string; turn: Turn; from: FactionId; to: FactionId; channel: "official" | "backchannel"; text: string; actionRef?: string }
interface NewsItem { id: string; turn: Turn; outlet: string; outletFaction: FactionId; bias: number /*-1..1*/; headline: string; body: string; zoneId?: ZoneId; factsRef: string[] }
```

### 7.8 Eventi, dadi, ingaggi
```ts
interface GameEvent {
  id: string; turn: Turn; seq: number; phase: TurnPhase;
  type: "UNIT_MOVED" | "UNIT_STATUS" | "CONTACT_DETECTED" | "CONTACT_LOST" | "ENGAGEMENT_OPENED" | "ENGAGEMENT_RESOLVED"
      | "UNIT_DAMAGED" | "UNIT_DESTROYED" | "MUNITION_EXPENDED" | "DELIVERY_ARRIVED" | "PROCUREMENT_ORDERED"
      | "BUDGET_CHANGED" | "RELATION_CHANGED" | "AGREEMENT_CHANGED" | "CRISIS_CHANGED" | "CYBER_EFFECT"
      | "SOF_RESULT" | "DIPLO_MESSAGE" | "INFRA_STATUS" | "RANDOM_EVENT" | "RED_LINE_CROSSED";
  actor: FactionId | "world"; targets: string[];
  payload: Record<string, unknown>;                 // schema per tipo (discriminated union in Zod)
  visibility: Visibility; causedBy: { orderId?: string; decisionId?: string; rollId?: string } | null;
}
interface DiceRoll {
  id: string; turn: Turn; rngIndex: number;
  purpose: string;                                  // "rilevamento FREMM F-590 vs contatto C-12"
  formula: string;                                  // "d100" | "2d6+2" | "p=0.35"
  modifiers: { name: string; value: number }[];
  raw: number[]; total: number; threshold?: number; outcome: "success" | "failure" | "critical_success" | "critical_failure" | string;
}
interface Engagement {
  id: EngagementId; turn: Turn; zoneId: ZoneId; location: LatLon;
  sides: { factionId: FactionId; unitIds: UnitId[] }[];
  scale: "minor" | "major"; resolution: "auto" | "cmo";
  status: "pending_cmo" | "resolved";
  cmoPackage?: CmoPackage; aar?: AfterActionReport; autoResult?: { rollIds: string[]; summary: string };
}
interface CmoPackage {
  engagementId: EngagementId; headline: "RISOLUZIONE SU CMO RICHIESTA";
  playerForces: { unitId: UnitId; name: string; classId: string; loadout: Record<MunitionId, number>; readiness: number }[];
  enemyOobEstimate: { classification: string; estCount: [number, number]; confidence: number; notes: string }[]; // da Knowledge, MAI verità
  environment: { date: string; timeWindowUtc: string; seaState: number; visibilityKm: number; wind: string; clouds: string; ducting: boolean };
  roe: Roe; objectives: string[]; constraints: string[]; suggestedScenarioArea: { center: LatLon; radiusKm: number };
}
interface AfterActionReport {
  submittedAt: string;
  ownLosses: { unitId: UnitId; newStatus: Unit["status"]; damage: number; aircraftLost?: number }[];
  munitionsExpended: Record<MunitionId, number>;
  enemyClaims: { classification: string; result: "destroyed" | "damaged" | "withdrew" }[];
  outcome: "victory" | "draw" | "defeat"; notes: string;
}
```
Nota: l'AAR contiene le perdite nemiche *dichiarate*; il motore le riconcilia con la verità di terra (le unità nemiche coinvolte ricevono gli esiti dichiarati se plausibili, altrimenti esito ridotto con tiro registrato) e produce `enemyLossesConfirmed` solo tramite ISR successivo.

### 7.9 Agenti: decisioni e memoria (il "path" dell'IA)
```ts
interface AgentDecision {
  schemaVersion: 1; id: string; factionId: FactionId; turn: Turn;
  model: string; role: AgentRole; promptHash: string; knowledgeRef: string; memoryRef: string;
  situationAssessment: string;                      // max ~150 parole
  threats: { factionId: FactionId; level: number; rationale: string }[];
  optionsConsidered: { label: string; summary: string; expectedGain: number; risk: number; chosen: boolean }[];
  privateIntent: string;                            // mai visibile ad altri durante la partita
  orders: FactionOrders;
  confidence: number;
  validation: { valid: boolean; errors: string[]; repairAttempts: number; fallbackUsed: boolean };
  usage: { promptTokens: number; completionTokens: number; latencyMs: number };
}
interface AgentMemory {
  schemaVersion: 1; factionId: FactionId; updatedTurn: Turn;
  strategicGoals: string[];                         // evolve lentamente
  commitments: { turn: Turn; to: FactionId; promise: string; kept: boolean | null }[];
  grievances: { turn: Turn; against: FactionId; text: string; weight: number }[];
  lessons: string[];                                // max 10, sostituzione FIFO per importanza
  relationshipNotes: Record<FactionId, string>;
  rollingSummary: string;                           // riassunto cumulativo ≤ 400 parole: controlla la lunghezza del contesto
}
interface LlmCall { id: string; turn: Turn; role: AgentRole; factionId?: FactionId; model: string; promptHash: string; request: unknown; response: unknown; ok: boolean; error?: string; tokens: { in: number; out: number }; latencyMs: number }
```

### 7.10 Narrativa
```ts
interface TurnNarrative {
  turn: Turn;
  briefing: { title: string; sections: { heading: "Quadro strategico" | "Tracce e movimenti" | "Allarmi intelligence" | "Energia e rotte" | "Stato FOED e prontezza"; body: string }[]; factsRef: string[] };
  debriefing?: { title: string; sections: { heading: string; body: string }[]; factsRef: string[] };
  news: NewsItem[];
}
```

---

## 8. SCENARIO INIZIALE `med-2026` E REGOLE DEL MOTORE

### 8.1 File dello scenario
```
scenarios/med-2026/
├─ scenario.json          # data iniziale, turnLength, fazioni attive, crisi iniziali, indicatori globali
├─ world.json             # WorldState turno 0 (unità, basi, infrastrutture, zone, relazioni)
├─ catalog.json           # classi di unità (firme, sensori, costi operativi) + catalogo acquisti 8.3
├─ event-tables.json      # tabelle eventi casuali pesate per zona/tensione
├─ factions/{ID}.md       # profilo agente: interessi, dottrina, linee rosse, stile decisionale, propensione al rischio
└─ geo/*.geojson          # zone marittime, gasdotti (TransMed, Greenstream, TAP), cavi, giacimenti, choke point
```
Fazioni minime: ITA (umano); IA maggiori: USA, FRA, TUR, RUS, CHN; IA minori: GRC, EGY, ISR, ALG, LBY_GNU, LBY_LNA, TUN, IRN. Blocchi NATO/EU come fazioni `scripted` che reagiscono a consultazioni (Art. 4, Consiglio UE) secondo regole di voto semplici basate sulle relazioni dei membri.
Crisi iniziali di esempio (latenti): sicurezza offshore Libia/ENI, instabilità Mar Rosso e rotte Suez, tensioni Egeo/Mediterraneo orientale, pressione migratoria dal Sahel, protezione cavi sottomarini.

### 8.2 OOB iniziale Italia (da `world.json`)
- **Marina:** Portaerei Cavour con gruppo imbarcato (F-35B, AV-8B+); LHD Trieste; 8 FREMM classe Bergamini; 3 PPA classe Thaon di Revel; 2 cacciatorpediniere classe Orizzonte (Andrea Doria, Caio Duilio); 4 sottomarini U212A classe Todaro; Reggimento San Marco.
- **Aeronautica:** 4 stormi Eurofighter (Trapani-Birgi, Grosseto, Gioia del Colle, Istrana); 2 gruppi F-35A/B (Amendola, Ghedi); 1 gruppo Tornado IDS/ECR (Ghedi, fine vita: readiness ridotta); 2 G550 CAEW (Pratica di Mare); flotta MQ-9 (Sigonella/Amendola); batterie SAMP/T.
- **Forze speciali / intelligence:** COFS (9° Col Moschin, GOI, 17° Stormo) come unità `sof_team`; reti AISE come `IsrAsset` HUMINT su Mediterraneo allargato, Golfo, Balcani; Cosmo-SkyMed come `SAR_SAT`.
- **FOED iniziale:** 3.200 M€.
Le forze delle altre fazioni sono stime plausibili, marcate nel file come `"estimated": true`, da rifinire a mano.

### 8.3 Catalogo acquisti (`catalog.json`, costi in M€)
| Item | Lotto | Costo | Lead time (turni) |
|---|---|---|---|
| MBDA Meteor | 10 | 25 | 0–1 |
| IRIS-T | 10 | 5 | 0–1 |
| Storm Shadow / SCALP | 4 | 12 | 0–1 |
| MBDA Marte ER | 8 | 16 | 0–1 |
| Teseo Mk2/E Evolver | 4 | 14 | 0–1 |
| Black Shark Advanced | 4 | 10 | 0–1 |
| Aster 30 B1/B1NT | 8 | 24 | 0–1 |
| Kit GBU GPS/Laser | 20 | 2 | 0–1 |
| F-35A (FACO Cameri) | 1 | 85 | 3 |
| F-35B | 1 | 110 | 3 |
| Eurofighter Tranche 4 | 1 | 105 | 2 |
| MQ-9B SeaGuardian/Reaper | 1 | 35 | 1 |
| Batteria SAMP/T NG | 1 | 350 | 3 |
| FREMM EVO | 1 | 650 | non rimpiazzabile (riparazione 30–100) |
| PPA Thaon di Revel | 1 | 480 | non rimpiazzabile |
| U212NFS | 1 | 520 | non rimpiazzabile |

Le munizioni con lead time "0–1": disponibili il turno successivo in base a un tiro di disponibilità industriale (probabilità configurabile, peggiora con ordini ripetuti nello stesso turno).

### 8.4 Regole di risoluzione (prima versione, tutte parametrizzate in `engine/params.ts`)
- **Costi operativi:** ogni unità `deployed`/`transit` consuma `opCostPerTurn` (scala per turno settimanale/mensile); sortite di strike/ISR aggiungono costo per missione. Upkeep di base escluso dal FOED (è bilancio ordinario).
- **Usura:** `usageHours` cresce con lo schieramento; oltre soglia la readiness cala e aumenta la probabilità di avaria; `REPAIR`/`STAND_DOWN` recupera readiness.
- **Rilevamento:** per ogni coppia (sensore/ISR, unità) nella stessa zona o in copertura: `p = f(qualità sensore, firma, EMCON, meteo, distanza)`; esito determina confidenza ed errore in km del contatto. Sottomarini quasi invisibili senza ASW dedicato. Tutti i tiri in `rolls/`.
- **Scaramucce minori:** modello probabilistico tipo Lanchester semplificato per salvo (attacco vs difesa di punto/area con Aster/SAM), esiti su danni 0–100. Ingaggi sopra soglia → CMO.
- **Cyber / SOF:** tiro contrapposto (offense attaccante vs defense bersaglio + modificatori) con effetti su infrastrutture, ISR nemico o raccolta intelligence; possibile attribuzione (tiro separato) che genera incidenti diplomatici.
- **Diplomazia:** ogni azione modifica `trust`/`tension` con effetti di propagazione agli alleati; dichiarazioni pubbliche influenzano `credibility`; minacce non mantenute riducono credibilità.
- **Escalation:** incidenti, perdite e linee rosse alzano l'escalation delle crisi; accordi e de-escalation la riducono. Ogni variazione ha una `cause`.
- **Energia:** infrastrutture `degraded/offline` fanno salire `ttfEurMwh` e generano penalità di stabilità/budget per chi dipende da esse (`flowShareIta`).

---

## 9. AGENTI LLM E BACKEND API

### 9.1 Client LLM (OmniRoute)
- `LLM_BASE_URL` (default `http://localhost:20128/v1`), `LLM_API_KEY` (opzionale), alias modelli per ruolo in config campagna (es. `faction_major` → modello più capace, `faction_minor`/`order_parser` → modello leggero).
- Output strutturato: usa `response_format: { type: "json_schema", ... }` se il modello lo supporta, altrimenti JSON mode + estrazione robusta del primo oggetto JSON. Validazione sempre con Zod.
- Timeout, 2 retry con backoff, log completo in `llm-log/`. Se tutto fallisce: `fallback_doctrine` (ordini minimi coerenti con la postura, generati dal motore).
- `MockLLMProvider`: risposte deterministiche derivate dal seed e dalla Knowledge; usato da test e da `--mock`.

### 9.2 Agenti
| Agente | Input | Output | Vincoli |
|---|---|---|---|
| **FactionAgent** (uno per fazione IA) | profilo `factions/{ID}.md`, `FactionKnowledge`, `AgentMemory`, elenco azioni lecite con costi e unità disponibili, inbox diplomatica | `AgentDecision` | Può usare solo unità/asset propri e item del catalogo che può permettersi; niente conoscenza oltre la Knowledge |
| **GMNarrator** | fatti del motore per l'Italia (lista `{id, testo, valori}`) | `TurnNarrative.briefing/debriefing` | Tono tecnico e spietato; ogni numero deve comparire nei fatti (validatore regex sui numeri) |
| **IntelAnalyst** | contatti e fatti rilevati per l'Italia | `IntelReport[]` | Linguaggio ambiguo coerente con la confidenza; codice di affidabilità derivato dalla qualità della fonte |
| **NewsWriter** (può coincidere col narratore) | eventi pubblici | `NewsItem[]` per testate di diverse fazioni, con bias | Sostituisce il feed notizie reale di WorldMonitor |
| **OrderParser** | testo libero del giocatore + Knowledge ITA | `FactionOrders` bozza + ambiguità da chiarire | Non esegue: la UI mostra la bozza per conferma |
| **Reflection** | decisione, esiti del turno visibili alla fazione, memoria precedente | `AgentMemory` aggiornata | Rispetta i limiti di lunghezza (rollingSummary ≤ 400 parole) |
| **Repair** | JSON non valido + errori Zod/regole | JSON corretto | Max 2 tentativi |

Template dei prompt in `agents/prompts/*.md`, con variabili `{{...}}`. Il prompt di fazione deve: dichiarare il ruolo (leadership dello Stato X nel 2026), gli interessi e le linee rosse dal profilo, il principio di realismo (niente mosse suicide o palesemente irrealistiche, preferenza per strumenti ibridi e diplomatici prima della forza), il formato JSON richiesto con esempio minimo. Documenta le scelte di prompt design in `docs/wargame/AGENTS.md`.

Orchestrazione: agenti di fazione in parallelo con `maxConcurrentAgents` (default 2 per non saturare un modello locale), ordine deterministico di scrittura dei risultati. Progressi emessi via SSE.

### 9.3 API REST (Fastify, prefisso `/api/wg`)
| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/scenarios` | scenari disponibili |
| GET/POST | `/campaigns` | lista / crea `{scenarioId, name, seed?, turnLength}` |
| GET | `/campaigns/:id` | `Campaign` |
| POST | `/campaigns/:id/fork` | `{fromTurn}` → nuova campagna ramificata |
| GET | `/campaigns/:id/knowledge` | `FactionKnowledge` ITA del turno corrente (mai verità di terra) |
| GET | `/campaigns/:id/narrative/:turn` | briefing/debriefing/news |
| GET | `/campaigns/:id/ledger?turn=` | voci FOED ITA |
| GET | `/campaigns/:id/catalog` | catalogo acquisti con disponibilità |
| POST | `/campaigns/:id/orders/parse` | `{text}` → bozza `FactionOrders` |
| POST | `/campaigns/:id/orders/validate` | dry-run: errori, costi previsti, rischi |
| POST | `/campaigns/:id/orders` | invio definitivo ordini ITA |
| POST | `/campaigns/:id/advance` | esegue le fasi fino a `CMO_PENDING` o `PLAYER_ORDERS` del turno successivo |
| GET | `/campaigns/:id/cmo` | ingaggi in attesa con `CmoPackage` (anche export `.txt`/`.json` scaricabile) |
| POST | `/campaigns/:id/cmo/:engagementId/aar` | invio AAR o `{autoResolve: true}` |
| GET | `/campaigns/:id/events?turn=` | eventi visibili all'Italia |
| GET | `/campaigns/:id/layers/:layer.geojson` | `units`, `contacts`, `crises`, `infrastructure`, `zones`, `lanes`, `ranges` (filtrati per Knowledge ITA) |
| GET | `/campaigns/:id/stream` | SSE: cambi di fase, "agente RUS in elaborazione", errori |
| GET | `/campaigns/:id/postmortem?turn=&faction=` | decisioni IA, tiri, verità di terra: **solo** se `status=ended` o `debugGodView=true` |

Errori con formato uniforme `{error: {code, message, details}}`. CORS limitato all'origine del frontend in dev.

---

## 10. FRONTEND: VARIANTE "wargame" DI WORLDMONITOR

Obiettivo: riusare shell, tema, motore mappa (globe.gl + deck.gl/MapLibre), sistema di pannelli e layout di WorldMonitor; sostituire tutte le sorgenti dati reali con il backend di gioco.

1. **Variante:** individua in Fase 0 come sono definite le varianti (world, tech, finance, energy, …) e aggiungi `wargame` con script `npm run dev:wargame`. Nella variante disattiva servizi e fetcher di dati reali (news, mercati, voli, CII, relay, cache remote, analytics). Nessuna chiamata di rete verso servizi esterni quando la variante è attiva, salvo tile della mappa di base. Aggiungi un test/verifica che lo controlla (es. intercettazione di `fetch` in e2e).
2. **Adapter:** `src/wargame/api-client.ts` è l'unico punto di accesso ai dati; tipi importati dagli schemi condivisi. Stato UI in `src/wargame/state/`.
3. **Layer mappa** (registrati nel catalogo layer esistente):
   - Unità proprie con simboli APP-6/MIL-STD-2525 (`milsymbol`), colore per stato, popup con readiness/loadout/ordine corrente.
   - Contatti con ellisse d'errore proporzionale a `errorKm` e opacità per `confidence`; etichetta con classificazione.
   - Zone di crisi colorate per escalation; infrastrutture energetiche e cavi con stato; choke point; raggi d'azione (armi/sensori) dell'unità selezionata.
4. **Pannelli** (riusa i componenti panel esistenti, testi in italiano):
   - **Briefing di Situazione** (narrativa del turno, sezioni fisse).
   - **Intel Feed** (IntelReport con codice affidabilità) e **Notizie simulate** (NewsItem per testata, al posto del feed reale).
   - **Ordine di Battaglia** (unità proprie, filtri per dominio/stato, selezione → mappa).
   - **FOED** (saldo, grafico andamento, ledger del turno, costo previsto della bozza ordini).
   - **Procurement** (catalogo, carrello, consegne in arrivo con countdown turni).
   - **Diplomazia** (heatmap trust/tension, accordi, inbox messaggi, composizione azioni).
   - **Crisi** (scala di escalation 0–10 per crisi, al posto del Country Instability Index).
   - **Console Ordini** (costruttore strutturato + campo testo libero → parse → bozza da confermare → validate → invio).
   - **Coda CMO** (pacchetto leggibile e scaricabile, form AAR, opzione risoluzione automatica).
   - **Controllo Turno** (data in-game, fase, pulsante "Esegui turno", avanzamento SSE per agente).
   - **Post-mortem / Replay** (visibile a fine campagna o in debug: timeline decisioni di ogni fazione con `situationAssessment`, `optionsConsidered`, `privateIntent`, tiri di dado; albero dei rami della campagna).
5. **Nessuna fuga di informazioni:** l'UI usa solo endpoint filtrati; il post-mortem è l'unica eccezione, protetta lato server.

---

## 11. PIANO A FASI E CRITERI DI ACCETTAZIONE

**Fase 0 — Ricognizione (nessuna modifica al codice esistente)**
Leggi README, ARCHITECTURE.md, AGENTS.md, CONCEPTS.md, package.json, vite config, sistema varianti, catalogo layer, registrazione pannelli, servizi dati e integrazione AI. Produci `docs/wargame/RECON.md` con: mappa dei moduli rilevanti, punti di aggancio per la variante, elenco dei servizi da disattivare, rischi, piano adattato. Crea SPEC.md, PROGRESS.md e il blocco in CLAUDE.md.
✅ RECON.md contiene percorsi di file reali e un piano per fasi 1–7 coerente con la repo.

**Fase 1 — Fondamenta backend**
Package `wargame-server`, schemi Zod completi (sezione 7) + export JSON Schema, `JsonStore` (atomic write, lock, snapshot, fork), RNG con seed e log dei tiri.
✅ Test: round-trip di ogni schema; scrittura concorrente bloccata dal lock; stessa sequenza RNG a parità di seed; fork copia fino al turno richiesto.

**Fase 2 — Scenario e motore**
`scenarios/med-2026` (dati sezione 8, stime marcate), macchina a stati del turno, economia, procurement, movimento, rilevamento/knowledge, adjudication, combattimento minore e soglia CMO, diplomazia, crisi, usura. CLI `npm run wargame:sim -- --turns 5 --mock`.
✅ 5 turni headless senza errori; ledger coerente (saldo = somma voci); nessun `truthUnitId` né unità nemiche esatte nella Knowledge ITA (test dedicato); ricostruzione `current = snapshot + events` verificata; consegne arrivano al turno corretto.

**Fase 3 — Agenti**
Client OpenAI-compatible verso OmniRoute, MockLLMProvider, context builder, FactionAgent, GMNarrator con validatore numeri, IntelAnalyst, NewsWriter, OrderParser, Reflection, Repair e fallback dottrinale, orchestrazione con concorrenza limitata, salvataggio `decisions/`, `memory/`, `llm-log/`.
✅ Con mock: ogni fazione IA produce un `AgentDecision` valido ogni turno; JSON invalido → repair → fallback testato; replay da `decisions/` produce stati identici (test di determinismo). Con OmniRoute reale: script `npm run wargame:smoke-llm` esegue 1 turno e riporta token/latenze.

**Fase 4 — API**
Tutte le route della sezione 9.3, SSE, GeoJSON layers, formato errori uniforme.
✅ Test di integrazione (Fastify inject) su ciclo completo: crea campagna → ordini → validate → advance → CMO → AAR → turno successivo; `postmortem` negato durante la partita.

**Fase 5 — Frontend**
Variante `wargame`, disattivazione dati reali, adapter, layer, pannelli della sezione 10.
✅ `npm run dev:wargame` + `npm run wargame:server` permettono di giocare un turno completo dall'interfaccia; nessuna richiesta di rete verso servizi esterni (esclusi tile mappa); typecheck pulito; le varianti esistenti continuano a compilare.

**Fase 6 — CMO, replay, fork, post-mortem**
Export pacchetto CMO (JSON + testo leggibile), form AAR con riconciliazione, UI fork/rami, pannello post-mortem.
✅ Un ingaggio maggiore mette la campagna in `CMO_PENDING`, l'AAR la sblocca e aggiorna perdite/munizioni/ledger; un fork dal turno N è giocabile indipendentemente.

**Fase 7 — Rifinitura**
Test e2e (Playwright, già presente nella repo) di un turno con mock, `docs/wargame/README.md` (installazione, OmniRoute, modelli consigliati per ruolo, come scrivere un nuovo profilo fazione o scenario), script `npm run wargame:all` che avvia server e frontend.
✅ Un nuovo utente segue il README e gioca il primo turno in meno di 10 minuti.

---

## 12. FUORI SCOPE (per ora)
Multigiocatore umano, politica interna dettagliata, integrazione automatica con CMO (niente scripting Lua: il flusso CMO è manuale via pacchetto/AAR), dati reali in tempo reale nella variante wargame, deploy cloud. Progetta però lo `Store` e il client LLM in modo che queste estensioni non richiedano di riscrivere il motore.

---

