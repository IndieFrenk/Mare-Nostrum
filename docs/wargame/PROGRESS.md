# PROGRESS

## Fatto
- **Fase 0** — Import di WorldMonitor, `RECON.md`, `SPEC.md`, `CLAUDE.md`.
- **Fasi 1–4** — `wargame-server/`: schemi Zod + `schemas-json/`, `JsonStore` (scritture atomiche, lock, snapshot, fork), RNG mulberry32 con cursore e log dei tiri, scenario `med-2026`, motore event-sourced, agenti (OmniRoute/mock/replay), API Fastify + SSE + GeoJSON, CLI `sim`. 23 test Vitest verdi.
- **Fase 5** — `wargame.html` + `src/wargame/` (mappa MapLibre, simboli `milsymbol`, 11 pannelli, SSE). Typecheck root pulito; biome e safe-html ok.
- **Fase 6** — Coda CMO (pacchetto .txt/.json, form AAR, risoluzione automatica), fork dai turni chiusi, post-mortem con decisioni, tiri e rami.
- **Fase 7** — `e2e-wargame/turn.spec.ts` (un turno con mock, verifica che non ci siano richieste esterne), `docs/wargame/README.md`, `npm run wargame:all`.
- **Interfaccia grand strategy** (richiesta successiva): mappa a tutto schermo con globo 3D (MapLibre `globe`, commutabile in mappa piana), paesi colorati per fazione da `public/data/countries.geojson` (nessuna tile esterna), modalità mappa politica/diplomazia/tensione/crisi, barra risorse, menu a icone con pannelli sovrapposti, avvisi, scheda paese con azioni diplomatiche rapide, pedine NATO impilate per vicinanza, selezione multipla e ordine di pattugliamento col tasto destro (linea tratteggiata sul piano).
- **Coste e revisione della spec**: zone marittime ritagliate sulla linea di costa reale (1:50m) con `npm --prefix wargame-server run geo:build` da `scenarios/med-2026/geo-src.json`; Sahel = Mali+Niger+Ciad+Burkina; area LNA ritagliata sulla Libia (`geo/control.geojson`). Colmate le lacune rispetto al prompt: penalità per minacce non mantenute, obiettivi per fazione valutati a fine turno, eventi `CONTACT_DETECTED`/`CONTACT_LOST`/`UNIT_DESTROYED`, perdite nemiche confermate via ISR dopo l'AAR, durata del turno modificabile in corsa, CMO su richiesta del giocatore, migrazioni dello store, errori via SSE, export CMO .json lato server, `build:wargame`, `wargame:smoke-llm` con report per ruolo, configurazione OmniRoute (`.env`, `llm:check`, override per ruolo anche in corsa). 28 test backend + e2e verdi.
- **Lettere diplomatiche tra capi di Stato**: azione `LETTER` nello schema unico degli ordini, archivio `letters/turn-N.jsonl`, evento `LETTER_SENT`, effetti per tono in `engine/diplomacy.ts` (minacciosa = minaccia da verificare, pubblica = anche `STATEMENT`), `FactionKnowledge.letters`; ruolo agente `diplomat` (una lettera per chiamata, prompt corti, `maxLength` nello schema, controllo dei numeri, 1 repair e lettera-modello); risposte alle lettere del giocatore nel turno dopo e iniziative da `letterIntents` con tetto `agentCadence.lettersPerTurn`; replay dalle decisioni; API `GET /letters` e `POST /letters/draft`; pannello ✉ Lettere; playtest con lettere e test «lettera» in `bench:models`. 47 test backend verdi.

## Decisioni
- Ogni mutazione dello stato è un `GameEvent` applicato da `engine/reducer.ts`: `state(N) = snapshot(N-1) + events(N)` (test dedicato).
- Aggiunti campi/tipi (ammessi dalla spec): `WorldState.rngCursor`, `Faction.crossedRedLines`, `Base.zoneId`, `Infrastructure.zoneId`, `Zone.center`, `Contact.zoneId`, `CatalogItem.platformClassId`, eventi `UNIT_CREATED`, `FACTION_CHANGED`, `INDICATORS_CHANGED`, `TURN_ADVANCED`, `TURN_CLOSED`, `STATEMENT`.
- Verità dei contatti salvata a parte in `truth/turn-N.json` (solo motore; serve a STRIKE/CMO dopo una pausa).
- `memory/history/{F}-turn-N.json` versiona la memoria per fork e replay.
- Munizioni "lead time 0–1": consegna al turno successivo se il tiro di disponibilità industriale riesce, altrimenti +1 turno; penalità per ordini ripetuti.
- `Unit.currentTask` tipizzato come record generico (evita un ciclo tra schemi).
- Ordini del giocatore mancanti ad `advance` → ordini vuoti (source `human`).
- Zone con `terrain` (sea/land): le unità navali non possono essere mandate in zone terrestri.
- Eventi casuali: al massimo una variazione per crisi per turno.
- Mappa solo MapLibre (niente deck.gl nella variante): i layer funzionano identici su globo e mappa piana.
- Frontend: nessuna modifica a `src/main.ts`/`vite.config.ts`; la variante ha un config Vite dedicato (`vite.wargame.config.ts`, dev e build in `dist-wargame/`).
- Confini 1:50m per la mappa in `src/wargame/assets/countries.geojson` (generato; ~430 kB gzip), non in `public/` per non pesare sul sito upstream.
- Lettere: il motore sceglie chi scrive a chi (risposte sempre, iniziative con tetto, prima le maggiori e poi per id), l'LLM scrive solo testo e tono; le lettere IA sono azioni `LETTER` negli ordini della fazione, così passano dallo stesso validatore del giocatore e il replay le rilegge. Le lettere IA sono riservate; ai blocchi (NATO, UE) non si scrive. Il tono chiesto dalla decisione (o dal giocatore) prevale su quello proposto dal modello. `Campaign.config.llm.diplomat` è facoltativo (campagne vecchie → `faction_major`).
- Rotta extra `POST /campaigns/:id/end` e `GET /campaigns/:id/overview` (indicatori, relazioni ITA, consegne).

## Debiti tecnici
- Lettere: il controllo «niente nomi di persone reali» è affidato al prompt (nessun elenco di nomi da confrontare); le non lette sono ricordate solo nel browser (localStorage).
- Bilanciamento: con il mock le crisi tendono a salire; da tarare con partite reali.
- Il layer di mappa non è registrato nel catalogo layer di World Monitor (entry isolata, vedi RECON).
- Modello di combattimento volutamente semplice (salve 2d6); parametri in `engine/params.ts`.
