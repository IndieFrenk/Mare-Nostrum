# Mare Nostrum

**Wargame geopolitico a turni sul Mediterraneo allargato, anno 2026. Tu sei l'Italia.**

Mare Nostrum è un gioco di strategia in cui il giocatore guida l'Autorità Nazionale di Comando italiana (Presidente del Consiglio e Ministro della Difesa) in una regione dove si incrociano la Russia, la Turchia, la Cina, gli Stati Uniti, le due Libie, Israele e l'Iran. Si gioca di deterrenza, diplomazia, intelligence, energia e rotte commerciali, non di micro-gestione. Gli altri Stati non sono scriptati a mano: decidono con un motore a regole deterministico, e dei modelli linguistici (locali o in cloud, a scelta) si limitano a scrivere lettere, notizie e briefing.

È una **simulazione di fantasia costruita su dati pubblici e stime**: non è uno strumento di previsione né di analisi operativa.

> **Stato del progetto:** in sviluppo attivo. Il motore, l'interfaccia e il sistema diplomatico a 197 Stati sono completi e coperti da oltre 360 test; lo scenario disponibile è uno solo (`med-2026`).

![Scheda di uno Stato del mondo con i motivi dell'opinione](docs/wargame/img/scheda-paese.png)

---

## Indice

- [Idee di progetto](#idee-di-progetto)
- [Cosa si può fare nel gioco](#cosa-si-può-fare-nel-gioco)
- [Lo scenario `med-2026`](#lo-scenario-med-2026)
- [Come decidono gli Stati](#come-decidono-gli-stati)
- [Il sistema diplomatico](#il-sistema-diplomatico)
- [Il ruolo degli LLM](#il-ruolo-degli-llm)
- [Architettura](#architettura)
- [Avvio rapido](#avvio-rapido)
- [Giocare con modelli reali](#giocare-con-modelli-reali)
- [Comandi](#comandi)
- [Organizzazione del repository](#organizzazione-del-repository)
- [Documentazione](#documentazione)
- [Crediti e licenza](#crediti-e-licenza)

---

## Idee di progetto

Le regole d'oro del progetto (dettagliate in [`docs/wargame/SPEC.md`](docs/wargame/SPEC.md)) spiegano quasi ogni scelta di codice:

1. **Il motore deterministico è l'unica fonte di verità.** Bilanci, posizioni, scorte, danni, tiri di dado: solo codice. Un LLM non scrive mai lo stato; al massimo *propone* ordini strutturati che il motore valida ed esegue.
2. **Nebbia di guerra strutturale.** Agenti e interfaccia ricevono soltanto la `FactionKnowledge` della propria fazione, mai lo stato del mondo. Di come gli altri Stati ci vedono si conosce la *fascia* (ostile, fredda, neutra, cordiale, stretta), il numero esatto solo con un accordo di intelligence.
3. **Tutto è registrato.** Ogni decisione, ogni tiro di dado, ogni chiamata a un modello finisce nel database. Una campagna si può rigiocare e ramificare da qualsiasi turno.
4. **Riproducibilità.** L'RNG ha un seme per campagna e il *replay* rilegge le decisioni salvate **senza chiamare nessun modello**; per le fazioni a regole le decisioni vengono ricalcolate e confrontate con quelle registrate (`REPLAY_DIVERGENT` se una non torna).
5. **Stesso schema di ordini per umano e IA.** `FactionOrders` è identico per il giocatore e per gli agenti: stessa validazione, stessa esecuzione.
6. **I narratori non inventano numeri.** Un validatore scarta i testi che contengono cifre assenti dai fatti forniti dal motore.
7. **Il gioco funziona anche con zero chiamate a modelli.** Ogni ruolo ha un testo deterministico di ripiego.
8. **I capi di Stato si indicano solo con la carica** («Il Re del Marocco», «L'Emiro del Qatar»), mai con il nome di una persona reale.

## Cosa si può fare nel gioco

Il turno (settimanale, configurabile per campagna) segue un ciclo fisso: **Briefing → Direttive del giocatore → Decisioni degli altri Stati e risoluzione → eventuale ingaggio da risolvere con CMO → Debriefing**.

| Area | In pratica |
|---|---|
| **Console Ordini** | Scrivi una direttiva in italiano libero («Manda la Bergamini a pattugliare il Canale di Sicilia e chiedi alla Tunisia più controlli»). Un LLM la traduce in ordini strutturati, il motore riconosce navi, mari e paesi per nome, ti avvisa se l'azione è ostile verso un alleato, e tu la rivedi prima di inviarla. In alternativa c'è il costruttore manuale. |
| **Forze e posture** | Le unità hanno prontezza, usura e compiti che proseguono da un turno all'altro. Per le fazioni IA basta dire *dove* e *come* (pattugliare, presenza, dimostrazione di forza, scorta, blocco, difesa aerea, ritiro): è il motore a scegliere *quali* unità. |
| **Economia** | Fondo Operazioni & Emergenze Difesa (FOED) iniziale di 3.200 M€, costi operativi, acquisti con tempi di consegna. |
| **Crisi** | Cinque crisi con scala di escalation 0–10, eventi casuali da tabelle, penalità per le minacce non mantenute e per le linee rosse superate. |
| **Diplomazia** | Capitale diplomatico, 22 azioni con costo e ricarica, trattati, ultimatum, mediazioni, risoluzioni in ONU/UE/NATO, lettere tra capi di Stato (vedi sotto). |
| **Intelligence** | Contatti con errore e confidenza, tracce radar, SIGINT, ISR; informazioni precise richiedono mezzi dedicati. |
| **Operazioni cyber** | Disponibili verso le fazioni straniere; la Console non le aggiunge mai se non le chiedi. |
| **Ingaggi maggiori** | Quando uno scontro supera la soglia, il gioco prepara un pacchetto da giocare su **Command: Modern Operations** (CMO) e rilegge l'After Action Report; in alternativa c'è la risoluzione automatica. |
| **Post-mortem e fork** | Decisioni, tiri, motivazioni delle fazioni a regole e rami della campagna sono consultabili; si può ripartire da un turno chiuso. |

L'interfaccia è in stile *grand strategy*: globo 3D (commutabile in mappa piana), nessuna tile esterna, pedine NATO impilate per vicinanza, selezione multipla e ordini col tasto destro. Le modalità mappa sono politica, diplomazia, tensione, crisi, **allineamento**, **opinione**, **trattati** e **voto**.

![Modalità mappa Opinione](docs/wargame/img/modalita-opinione.png)

## Lo scenario `med-2026`

Parte il 2 marzo 2026 (turno settimanale) con: **13 zone** (mari e terre) ritagliate sulla linea di costa reale, **49 basi**, **14 infrastrutture** (gasdotti, cavi sottomarini, terminali), **110 unità** da fonti pubbliche e **5 crisi** (Libia offshore, Mar Rosso, Mediterraneo orientale, migrazioni dal Sahel, cavi sottomarini).

**Fazioni** (25 Stati più i blocchi NATO e UE):

- *Giocatore:* Italia.
- *Grandi potenze:* Stati Uniti, Francia, Turchia, Russia, Cina.
- *Attori regionali:* Regno Unito, Grecia, Egitto, Israele, Algeria, Tunisia, Libia (GNU, Tripoli), Libia (LNA, Bengasi), Iran.
- *Paesi «scripted», sempre a regole:* Spagna, Marocco, Malta, Cipro, Libano, Siria, Giordania, Arabia Saudita, Emirati Arabi Uniti, Qatar, Germania. Hanno unità solo dove pesano nel Mediterraneo allargato; Cipro, Libano, Siria e Giordania agiscono con la sola diplomazia.

Oltre alle fazioni, un registro di **197 Stati** (193 ONU più Santa Sede, Palestina, Taiwan e Kosovo) e **32 istituzioni** (NATO, UE, Assemblea e Consiglio di sicurezza ONU 2026 con i 15 membri, Lega Araba, CCG, SCO, BRICS, CSTO, OPEC+, G7, G20…) rende l'intero mondo parte del gioco. Sono dati statici, non entrano negli snapshot e a runtime il gioco non usa la rete. **Attenzione:** i numeri sono stime a mano di ordine di grandezza (2024) con affidabilità dichiarata; punto ideale ONU e allineamento sono giudizi ragionati, non misure.

## Come decidono gli Stati

Le fazioni non giocate da te usano il **decisore a regole** (`engine/policy.ts`), predefinito:

- ogni fazione ha un profilo numerico (aggressività, tolleranza al rischio, propensione cyber, stile diplomatico, interessi per zona) e un insieme di regole a punteggio: unità logorate a casa, risposta alle **linee rosse** superate, reazione agli atti subiti, crisi con coercione o distensione, obiettivi, alleati, accordi, routine, ritiro;
- ogni mossa porta una **motivazione leggibile** («Risposta alla minaccia di TUR in EGEO: dimostrazione di forza»), visibile nel post-mortem;
- la casualità arriva solo dal dado registrato del motore: stesso seme, stesse decisioni;
- un turno con i modelli locali scende da 4–5 minuti a circa uno, e aggiungere uno Stato non lo allunga.

La vecchia modalità, in cui un LLM decide per ogni fazione, resta disponibile con `WARGAME_FACTION_MODE=llm` per confronti.

**Tre livelli di intelligenza** per un mondo da 197 Stati:

| Livello | Chi | Come |
|---|---|---|
| A | Grandi potenze | Regole, più una *direttiva* strategica facoltativa proposta da un LLM a rotazione (una potenza per turno) e **limitata dal motore**. |
| B | Attori regionali | Regole. |
| C | Gli Stati del mondo (169 su 197 senza fazione) | Regole guidate dagli eventi pubblici del turno precedente, con agenda sfalsata: reagiscono agli atti gravi, votano, adottano sanzioni di blocco, trattano. Circa 0,3 s per turno. |

## Il sistema diplomatico

Ispirato alla grand strategy, ma con numeri sempre spiegati:

- **Opinione asimmetrica.** `opinione(A→B)` = base statica (alleanze, blocchi, vicinanza di voto ONU, regime, commercio, storia della coppia) + modificatori che decadono nel tempo. Un'azione di A verso B cambia come *B vede A*. Ogni numero ha l'elenco dei suoi motivi, come il tooltip di HOI4 («+20 Alleanza difensiva in comune», «−8 Minaccia formale, ancora 8 turni»). Memorizzazione sparsa: mai la matrice 197×197.
- **Tensione di coppia e tensione mondiale** (0–100, in quattro fasce), con effetti su Brent, TTF e rischio navale.
- **Capitale diplomatico (CD).** Rendita per turno e catalogo di 22 azioni con costo, ricarica e prerequisiti: miglioramento delle relazioni (con slot), richiamo dell'ambasciatore → espulsione → rottura → ripristino, embarghi sulle armi, ultimatum con scadenza, mediazione, risoluzioni.
- **Trattati** (non aggressione, garanzia, accesso militare, commercio, energia, migrazioni…) con effetti reali nel motore.
- **Accettazione deterministica, con i motivi visibili prima dell'invio**: per ogni proposta la scheda paese mostra «Accetterebbe: sì/no (punteggio)». È una stima, perché l'opinione dell'altro è nota solo a fasce.
- **Istituzioni e votazioni** con le regole di ciascuna sede. L'Assemblea generale è tarata sul voto di marzo 2022 (143 sì, 6 no, 44 astenuti nel modello); ONU, UE e NATO hanno regole proprie, e agire senza mandato costa in **legittimità**.
- **Lettere tra capi di Stato**, con tono (cordiale, formale, conciliante, ferma, minacciosa) ed effetti decisi dal motore: una minaccia senza seguito entro due turni costa credibilità, una lettera pubblica finisce nelle notizie. Il testo lo scrive un LLM («consigliere»), che non può inventare numeri.
- **Interfaccia diplomatica**: scheda paese uguale per tutti i 197 Stati, modalità mappa Opinione/Trattati/Voto, pannelli Stati, Istituzioni e Reazioni internazionali, barra con CD e tensione mondiale.

![Modalità mappa Voto](docs/wargame/img/modalita-voto.png)

Il piano completo, diviso in sei settori, è in [`docs/wargame/DIPLOMAZIA.md`](docs/wargame/DIPLOMAZIA.md).

## Il ruolo degli LLM

Gli LLM **scrivono e interpretano; non decidono gli esiti.**

| Ruolo | Che cosa fa |
|---|---|
| `ORDER_PARSER` | Traduce la direttiva del giocatore in ordini, con controlli dopo l'LLM (avvisi su azioni ostili verso alleati, cyber non richiesto, movimento senza unità). |
| `GM_NARRATOR`, `INTEL_ANALYST` | Notizie e briefing, con validatore dei numeri. |
| `DIPLOMAT` | Lettere e risposte tra capi di Stato. |
| `STRATEGIST` | Una direttiva strategica per una grande potenza a turno; il motore la limita. |
| `CHANCERY` | Le frasi di 6–8 Stati per ogni atto grave; la posizione è scelta dal motore. |
| `FACTION_*`, `REFLECTION` | Solo nella modalità `llm`. |

**Budget delle chiamate** (`agents/budget.ts`): tutte le chiamate passano da una coda a priorità con tetto per turno (`LLM_BUDGET_CALLS`), limiti al minuto e al giorno per modello, ripiego sul modello successivo su errore 429 e cache per prompt. Finito il budget, ogni ruolo usa il suo testo deterministico. **Profili di provider** in `wargame-server/llm-profiles/`: `locale` (Ollama), `gemini` (Google AI Studio) e `omniroute`. Le chiavi stanno **solo** nel file `.env`, mai nei profili.

Con modelli piccoli locali (Qwen 3.5 4B e 9B su una scheda da 8 GB) il progetto ha affrontato i problemi tipici: JSON incompleti, id di unità inventati, numeri allucinati. Le contromisure (posture per zona, riconoscimento dei nomi prima dell'LLM, completamento deterministico, riparazione del JSON, validatori) sono documentate in `docs/wargame/` e misurate dal banco `bench:models`.

## Architettura

```
┌─────────────────────── FRONTEND (variante «wargame» di World Monitor) ───────────────────────┐
│  MapLibre (globo / mappa piana) · milsymbol · pannelli: Briefing, Intel, OOB, FOED, Acquisti,│
│  Diplomazia, Stati, Istituzioni, Lettere, Crisi, Console Ordini, Coda CMO, Post-mortem       │
│  src/wargame/  ──── HTTP/JSON + SSE ───┐                                                     │
└────────────────────────────────────────┼─────────────────────────────────────────────────────┘
                                         ▼
┌──────────────────────────── wargame-server (Node + TypeScript + Fastify) ────────────────────┐
│  api/       REST + SSE + layer GeoJSON                                                       │
│  engine/    macchina del turno · economia · movimento · rilevamento (nebbia) · aggiudicazione│
│             combattimento · opinione · diplomazia · istituzioni · IA mondiale · crisi · CMO  │
│  agents/    orchestratore · budget · profili di provider · parser · narratore · lettere · …  │
│  store/     database JSON event-sourced su file (lock, snapshot, fork, migrazioni)           │
│  schemas/   Zod = unica fonte dei tipi (con export JSON Schema)                              │
│  scenarios/ med-2026 (zone, basi, unità, fazioni) + _world (197 Stati, istituzioni, coppie)  │
└────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                         ▼
                 Endpoint LLM compatibile OpenAI (facoltativo): Ollama · Gemini · OmniRoute
```

Scelte tecniche:

- **Event sourcing.** Ogni mutazione è un `GameEvent` applicato dal `reducer`: `stato(N) = snapshot(N−1) + eventi(N)`.
- **Database JSON su file**, senza dipendenze esterne: leggibile a mano, versionabile, diffabile tra rami. Dietro un'interfaccia `Store`, per poter passare in futuro a SQLite.
- **Zod** come unica fonte dei tipi; i JSON Schema si esportano con `schemas:export`.
- **Stack:** Node 24, TypeScript strict, Fastify, Zod, Vitest; frontend Vite + MapLibre, nessun framework nuovo.

Il database di una campagna sta in `wargame-server/data/campaigns/<id>/` (ignorato da git).

## Avvio rapido

Servono **Node 24** (vedi `.nvmrc`) e Git. Per il primo avvio **non serve nessun modello**.

```bash
git clone https://github.com/IndieFrenk/Mare-Nostrum.git
cd Mare-Nostrum

nvm use                              # Node 24
npm ci --ignore-scripts              # dipendenze del frontend
npm --prefix wargame-server install  # dipendenze del server di gioco

WARGAME_MOCK=1 npm run wargame:all   # server su :8787 + frontend su :5173
```

Apri <http://localhost:5173/wargame.html>. Con `WARGAME_MOCK=1` gli agenti sono finti e deterministici, e non parte alcuna chiamata di rete.

1. **Crea** una campagna.
2. Leggi il **Briefing**, poi apri la **Console Ordini** e scrivi una direttiva; premi *Interpreta* e poi *Valida* (oppure usa il costruttore).
3. Premi **▶ Esegui turno**. Se un ingaggio supera la soglia CMO, apri la **Coda CMO**: scarica il pacchetto, gioca su CMO e compila l'AAR, oppure scegli *Risoluzione automatica*.

Una simulazione senza interfaccia: `npm run wargame:sim -- --turns 5 --mock`.

## Giocare con modelli reali

Copia `wargame-server/.env.example` in `wargame-server/.env` e scegli **un** profilo:

```bash
# Ollama locale (qwen3.5 4B / 9B, ragionamento spento)
LLM_PROFILE=locale

# oppure Google AI Studio (Gemini 2.5 Flash / Flash-Lite, ognuno ripiego dell'altro)
# LLM_PROFILE=gemini
# GEMINI_API_KEY=...

# oppure un endpoint OmniRoute con le combo wargame-strong / wargame-light
# LLM_PROFILE=omniroute
# LLM_BASE_URL=http://localhost:20128/v1

LLM_BUDGET_CALLS=10    # chiamate al modello per turno (0 = nessuna, si gioca con i testi deterministici)
```

Con Ollama imposta `OLLAMA_CONTEXT_LENGTH=8192` e scarica i modelli (`qwen3.5:4b`, `qwen3.5:9b`). Con i modelli locali serve una scheda video da circa 8 GB. Verifica la configurazione con `npm run wargame:llm-check`: un pallino verde, giallo o rosso accanto a ▶ indica lo stato dei modelli e, se sono irraggiungibili, il turno non parte a vuoto (risposta 503) a meno di `WARGAME_ALLOW_OFFLINE=1`.

> **Privacy:** nei piani gratuiti di alcuni provider cloud i dati inviati possono essere usati per addestrare i modelli. Il motore invia solo testo di gioco, ma verifica le condizioni del tuo provider.

## Comandi

| Comando | Cosa fa |
|---|---|
| `npm run wargame:all` | Server di gioco e frontend insieme |
| `npm run wargame:server` | Solo l'API, su `:8787` (`WARGAME_DATA_DIR` per il database) |
| `npm run dev:wargame` | Solo il frontend, su `/wargame.html` |
| `npm run build:wargame` | Build statica in `dist-wargame/` |
| `npm --prefix wargame-server test` | Test del motore, degli agenti e dell'API (Vitest) |
| `npm --prefix wargame-server run typecheck` | Controllo dei tipi |
| `npm run test:e2e:wargame` | Test end-to-end Playwright di un turno (con mock) |
| `npm run wargame:sim -- --turns 5 --mock` | Simulazione senza interfaccia (`--mode rules\|llm`) |
| `npm run wargame:sim -- --replay <id>` | Replay da `decisions/` e verifica del determinismo |
| `npm --prefix wargame-server run playtest -- --turns 6` | Partita automatica via API con report dei problemi |
| `npm --prefix wargame-server run balance -- --seeds 10 --turns 20` | Bilanciamento su più semi (crisi, ordini, ingaggi, lettere, tempi) |
| `npm --prefix wargame-server run bench:models -- <campagna>` | Banco dei modelli e dei profili (parser, fazioni, strategist, chancery…) |
| `npm run wargame:llm-check` | Prova ogni modello configurato, ripieghi compresi |
| `npm --prefix wargame-server run geo:build` | Rigenera zone marittime e confini da `geo-src.json` |
| `npm --prefix wargame-server run world:build` | Rigenera i 197 Stati, le istituzioni e le coppie storiche |
| `npm --prefix wargame-server run schemas:export` | Esporta i JSON Schema |

## Organizzazione del repository

Questo repository nasce come derivazione di **World Monitor** (vedi [Crediti](#crediti-e-licenza)) e ne conserva l'albero. Il codice di Mare Nostrum sta in pochi percorsi; il resto è codice di origine, intatto.

| Percorso | Contenuto |
|---|---|
| `wargame-server/` | **Backend del gioco**: motore, agenti, API, store, schemi, scenari, test |
| `wargame-server/scenarios/med-2026/` | Scenario: `world.json`, `catalog.json`, `event-tables.json`, `names.json`, `factions/*.md`, `geo/*.geojson` |
| `wargame-server/scenarios/_world/` | Registro dei 197 Stati, delle istituzioni e delle coppie storiche |
| `wargame-server/llm-profiles/` | Profili di provider (`locale`, `gemini`, `omniroute`) |
| `src/wargame/` | **Interfaccia del gioco**: mappa, layer, pannelli, stato UI |
| `wargame.html`, `vite.wargame.config.ts` | Punto d'ingresso e configurazione Vite della variante |
| `e2e-wargame/`, `playwright.wargame.config.ts` | Test end-to-end |
| `scripts/wargame-all.mjs` | Avvia server e frontend insieme |
| `docs/wargame/` | Specifica, piano della diplomazia, stato lavori, guida all'uso |
| `CLAUDE.md` | Regole di lavoro del progetto, lette dagli assistenti di programmazione |
| *tutto il resto* | Codice di World Monitor (`api/`, `server/`, `src/` fuori da `wargame/`, `convex/`, `src-tauri/`, …) |

Per aggiungere una fazione o uno scenario vedi le sezioni «Nuovo profilo fazione» e «Nuovo scenario» in [`docs/wargame/README.md`](docs/wargame/README.md).

## Documentazione

- [`docs/wargame/README.md`](docs/wargame/README.md): guida all'uso, ogni meccanica spiegata in dettaglio (con i parametri).
- [`docs/wargame/SPEC.md`](docs/wargame/SPEC.md): specifica originale, architettura e schemi.
- [`docs/wargame/DIPLOMAZIA.md`](docs/wargame/DIPLOMAZIA.md): piano del sistema di rapporti tra Stati, in sei settori.
- [`docs/wargame/PROGRESS.md`](docs/wargame/PROGRESS.md): cronologia dei lavori, misure e decisioni di progetto.
- [`docs/wargame/AGENTS.md`](docs/wargame/AGENTS.md): progettazione dei prompt degli agenti.
- [`docs/wargame/RECON.md`](docs/wargame/RECON.md): analisi di World Monitor e punti di innesto.
- [`CLAUDE.md`](CLAUDE.md): comandi e regole d'oro in sintesi.

## Crediti e licenza

Mare Nostrum è costruito su **[World Monitor](https://github.com/koala73/worldmonitor)** di koala73 e dei suoi collaboratori: la mappa, il sistema di varianti e l'impianto dell'interfaccia derivano da quel progetto, il cui README originale è conservato in [`README.world-monitor.md`](README.world-monitor.md). Altri componenti riusati: [MapLibre GL](https://maplibre.org/), [milsymbol](https://github.com/spatialillusions/milsymbol) per la simbologia militare NATO, Fastify e Zod.
Il progetto è distribuito con la licenza **GNU Affero General Public License v3.0** (AGPL-3.0), la stessa del progetto da cui deriva: vedi [`LICENSE`](LICENSE). Se ospiti una versione modificata come servizio di rete, l'AGPL richiede di rendere disponibile il codice sorgente agli utenti di quel servizio.

Il gioco può integrarsi, facoltativamente, con *Command: Modern Operations* (Matrix Games / Slitherine), software commerciale di terzi: non è incluso né redistribuito e non è necessario per giocare.
