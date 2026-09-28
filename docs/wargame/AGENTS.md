# Agenti LLM — scelte di prompt design

- **Un solo contratto**: il motore parla con `AgentsPort` (`engine/turn-machine.ts`). Implementazioni: `LlmAgents` (OmniRoute o mock) e `ReplayAgents` (rilegge `decisions/`, `narrative/`, `memory/history/`).
- **Input strutturati separati dal prompt**: ogni `LlmRequest` ha `system`/`user` (testo per il modello) e `meta` (dati per il mock). I modelli reali ignorano `meta`.
- **Contesto di fazione** (`context-builder.ts`): solo `FactionKnowledge` + memoria + azioni lecite (id unità/asset/zone/basi, articoli acquistabili, accordi pendenti). Lo `WorldState` passato all'agente serve solo alla validazione, mai al prompt.
- **Output**: `response_format: json_schema` (schema da Zod); su HTTP 400 il client passa a `json_object`. `extractJson` estrae il primo oggetto bilanciato.
- **Validazione a due livelli**: Zod + regole del motore (`validateOrders`). Gli errori tornano al ruolo `repair` (max 2), poi **fallback dottrinale** (`doctrineOrders`).
- **Id normalizzati** (`FAZ-turno-n`): i modelli ripetono spesso `o1`.
- **Narratori senza numeri inventati**: `numbersNotInFacts` confronta ogni cifra del testo con i fatti del motore; se fallisce anche il repair si usa un testo deterministico costruito dai fatti.
- **Affidabilità intel**: il codice Admiralty è calcolato dal codice (fonte → lettera, confidenza → cifra), non dal modello.
- **Memoria**: `reflection` propone, `clampMemory` impone i limiti (lezioni ≤10, riassunto ≤400 parole).
- **Concorrenza**: `maxConcurrentAgents` (default 2) per non saturare un modello locale; risultati scritti in ordine alfabetico di fazione.
- **Modelli per ruolo**: `LLM_MODEL` o `LLM_MODEL_<RUOLO>` (es. `LLM_MODEL_FACTION_MAJOR`) alla creazione della campagna, salvati in `campaign.config.llm`.
