import type { AgentRole, Campaign, LlmCounters, LlmTurnCounters, LlmUsage } from '../schemas/index.js';
import { factionModeDefault } from '../config.js';
import type { LlmCacheRow } from '../store/json-store.js';
import { LlmSkipped, RateLimitError, type LlmProvider, type LlmRequest, type LlmResponse } from './llm-client.js';
import { promptHash } from './repair.js';

/**
 * Gestore del budget delle chiamate LLM (docs/wargame/DIPLOMAZIA.md §11, docs/wargame/AGENTS.md «Budget»): tutte le chiamate dei ruoli passano di qui.
 * - budget per turno (`LLM_BUDGET_CALLS`, predefinito 10; 0 = nessuna chiamata, solo testi deterministici) con una coda a priorità P0–P5:
 *   fuori budget cadono per prime le priorità basse e il ruolo usa il suo testo deterministico (lettera-modello, notizie dai fatti…);
 * - limite di richieste al minuto e al giorno (finestra scorrevole, `LLM_RPM`/`LLM_RPD`) per modello: si aspetta (fino a `maxWaitMs`) o si passa al
 *   modello successivo del profilo; su HTTP 429 si legge `Retry-After`, il modello va in pausa e la richiesta passa al successivo senza perdere il turno;
 * - cache per `promptHash` nella campagna (stessa richiesta = stessa risposta, anche dopo un riavvio);
 * - contatori per turno e per giorno nel registro (`llm-usage.json`) e in `GET /api/wg/llm/status`.
 * Non decide mai un esito di gioco: dice solo se una chiamata si fa e a quale modello.
 */

/** 0 Console Ordini e briefing · 1 lettere con il giocatore · 2 notizie · 3 direttive · 4 reazioni delle cancellerie · 5 lettere tra IA */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5;
export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3, 4, 5];
export const PRIORITY_LABEL: Record<Priority, string> = { 0: 'Console Ordini e briefing', 1: 'lettere con il giocatore', 2: 'notizie', 3: 'direttive', 4: 'reazioni delle cancellerie', 5: 'lettere tra IA' };

// ——— orologio e finestre scorrevoli ———

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
/** Orologio finto per i test: `sleep` avanza il tempo senza aspettare. */
export class ManualClock implements Clock {
  constructor(public t = 0) {}
  now() { return this.t; }
  async sleep(ms: number) { this.t += ms; }
  advance(ms: number) { this.t += ms; }
}

/** Finestra scorrevole: al massimo `limit` richieste negli ultimi `windowMs`. `limit` 0 (o non finito) = nessun limite. */
export class SlidingWindow {
  private hits: number[] = [];
  constructor(readonly limit: number, readonly windowMs: number) {}
  get unlimited() { return !(this.limit > 0) || !Number.isFinite(this.limit); }
  private prune(now: number) { while (this.hits.length && this.hits[0]! <= now - this.windowMs) this.hits.shift(); }
  /** millisecondi da aspettare perché ci sia posto (0 = si può subito) */
  waitMs(now: number): number {
    if (this.unlimited) return 0;
    this.prune(now);
    return this.hits.length < this.limit ? 0 : Math.max(1, this.hits[this.hits.length - this.limit]! + this.windowMs - now);
  }
  take(now: number) { if (!this.unlimited) this.hits.push(now); }
  count(now: number) { this.prune(now); return this.hits.length; }
}

/** Limiti di un modello: richieste al minuto e al giorno. */
export class RateLimiter {
  readonly rpm: SlidingWindow; readonly rpd: SlidingWindow;
  constructor(rpm: number, rpd: number) { this.rpm = new SlidingWindow(rpm, 60_000); this.rpd = new SlidingWindow(rpd, 86_400_000); }
  /** quanto aspettare e perché (`daily`: il limite del giorno, che non conviene aspettare) */
  check(now: number): { wait: number; daily: boolean } {
    const d = this.rpd.waitMs(now);
    return d > 0 ? { wait: d, daily: true } : { wait: this.rpm.waitMs(now), daily: false };
  }
  take(now: number) { this.rpm.take(now); this.rpd.take(now); }
}

/**
 * Una richiesta di priorità `p` si ammette se, contando le chiamate già fatte e quelle di priorità più alta che il motore ha dichiarato di
 * volere più avanti nel turno (`expected`), c'è ancora posto: le priorità basse lasciano il loro spazio a quelle alte.
 */
export function allowCall(used: number, limit: number, expected: readonly number[], p: Priority): boolean {
  const reserved = expected.slice(0, p).reduce((a, b) => a + b, 0);
  return used + 1 + reserved <= limit;
}

// ——— instradamento: modelli e profili ———

/** Un modello raggiungibile: il provider HTTP, il modello (null = quello della richiesta) e i suoi limiti (0 = nessun limite). */
export interface Endpoint { key: string; label: string; provider: LlmProvider; model: string | null; rpm: number; rpd: number }
/** Dove va una chiamata: per ruolo, l'elenco ordinato dei modelli (il primo è il principale, gli altri il ripiego). */
export interface Routing {
  name: string; baseUrl: string;
  endpointsFor(role: AgentRole, requestedModel: string): Endpoint[];
  all(): Endpoint[];
}
export function singleRouting(provider: LlmProvider, o: { name?: string; baseUrl?: string; rpm?: number; rpd?: number } = {}): Routing {
  const ep: Endpoint = { key: o.baseUrl ?? provider.name, label: provider.name, provider, model: null, rpm: o.rpm ?? 0, rpd: o.rpd ?? 0 };
  return { name: o.name ?? 'predefinito', baseUrl: o.baseUrl ?? '', endpointsFor: () => [ep], all: () => [ep] };
}

// ——— contatori ———

export const emptyCounters = (): LlmCounters => ({ calls: 0, admitted: 0, tokensIn: 0, tokensOut: 0, rate429: 0, fallbacks: 0, skipped: 0, cacheHits: 0, errors: 0 });
export const emptyTurnCounters = (): LlmTurnCounters => ({ ...emptyCounters(), byRole: {}, skippedByPriority: {} });
export const emptyUsage = (): LlmUsage => ({ schemaVersion: 1, turns: {}, days: {} });

export interface UsageStore {
  getLlmUsage(id: string): Promise<LlmUsage | null>;
  saveLlmUsage(id: string, u: LlmUsage): Promise<void>;
  getLlmCache(id: string): Promise<LlmCacheRow[]>;
  appendLlmCache(id: string, rows: LlmCacheRow[]): Promise<void>;
}

export interface BudgetOptions {
  /** chiamate per turno: un numero esplicito (0 = nessuna, Infinity = senza tetto) o, se manca, `defaultCalls` nelle campagne a regole e nessun tetto in modalità llm */
  callsPerTurn?: number;
  /** tetto delle campagne a regole quando `callsPerTurn` non è impostato (predefinito 10) */
  defaultCalls?: number;
  /** attesa massima di un posto nel limite al minuto o di un modello in pausa dopo un 429 (predefinito 45 s): oltre, il ruolo usa il testo deterministico */
  maxWaitMs?: number;
  /** cache per promptHash (predefinito sì) */
  cache?: boolean;
  /** pausa di un modello dopo un 429 senza `Retry-After` (predefinito 30 s) */
  cooldownMs?: number;
  clock?: Clock;
}

interface Cached { text: string; model: string; tokens: { in: number; out: number } }
interface CampaignState { usage: LlmUsage; cache: Map<string, Cached>; books: Map<number, number[]>; chain: Promise<void> }

export interface BudgetStatus {
  profile: string; baseUrl: string;
  /** chiamate per turno (null = nessun tetto) */
  callsPerTurn: number | null; cache: boolean; maxWaitMs: number;
  endpoints: { key: string; model: string | null; rpm: number; rpd: number; inLastMinute: number; inLastDay: number; coolingMs: number }[];
  campaign: null | {
    id: string; callsPerTurn: number | null;
    /** i contatori dell'ultimo turno con chiamate (o del turno richiesto) e quante ne restano */
    turn: (LlmTurnCounters & { turn: number; remaining: number | null }) | null;
    today: LlmCounters; turns: Record<string, LlmTurnCounters>; days: Record<string, LlmCounters>;
  };
}

/** Parte di Campaign che serve al gestore (il resto non lo riguarda). */
type CampaignRef = Pick<Campaign, 'id'> & { config: Pick<Campaign['config'], 'factionMode'> };

export class LlmBudget {
  readonly clock: Clock;
  private store: UsageStore | null = null;
  private states = new Map<string, Promise<CampaignState>>();
  private limiters = new Map<string, RateLimiter>();
  private cooling = new Map<string, number>();

  constructor(readonly routing: Routing, readonly opts: BudgetOptions = {}) { this.clock = opts.clock ?? systemClock; }

  /** Senza limiti, senza cache: chi costruisce `LlmAgents` con un provider e basta (test, bench) vede le chiamate di sempre. */
  static unlimited(provider: LlmProvider) { return new LlmBudget(singleRouting(provider), { callsPerTurn: Infinity, cache: false }); }

  /** LLM_BUDGET_CALLS (0 = nessuna chiamata, «unlimited» = senza tetto); se manca: 10 nelle campagne a regole, nessun tetto in modalità llm. */
  static callsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const v = env.LLM_BUDGET_CALLS?.trim().toLowerCase();
    if (!v) return undefined;
    if (v === 'unlimited' || v === 'inf' || v === 'infinity') return Infinity;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined;
  }
  static fromEnv(routing: Routing, env: NodeJS.ProcessEnv = process.env, extra: BudgetOptions = {}) {
    const calls = LlmBudget.callsFromEnv(env);
    const wait = Number(env.LLM_MAX_WAIT_MS);
    return new LlmBudget(routing, { ...(calls !== undefined ? { callsPerTurn: calls } : {}), ...(Number.isFinite(wait) && env.LLM_MAX_WAIT_MS ? { maxWaitMs: wait } : {}), ...extra });
  }

  attach(store: UsageStore) { this.store = store; }
  get cacheOn() { return this.opts.cache !== false; }
  get maxWaitMs() { return this.opts.maxWaitMs ?? 45_000; }

  /** Tetto di chiamate del turno per questa campagna (Infinity = nessuno). */
  limitFor(c: CampaignRef): number {
    if (this.opts.callsPerTurn !== undefined) return this.opts.callsPerTurn;
    return (c.config.factionMode ?? factionModeDefault()) === 'rules' ? this.opts.defaultCalls ?? 10 : Infinity;
  }

  /** Provider «a budget» per una chiamata (o un gruppo di chiamate) di una data priorità in un turno: ciò che i ruoli ricevono al posto del provider vero. */
  view(c: CampaignRef, turn: number, priority: Priority): LlmProvider {
    return {
      name: 'budget',
      complete: (req) => this.run(c, turn, priority, req),
      reject: (req) => this.reject(c.id, req),
    };
  }

  // ——— stato per campagna ———

  private state(id: string): Promise<CampaignState> {
    let p = this.states.get(id);
    if (!p) {
      p = (async () => {
        const st = this.store;
        const usage = (await st?.getLlmUsage(id)) ?? emptyUsage();
        const cache = new Map<string, Cached>();
        for (const r of (await st?.getLlmCache(id)) ?? []) {
          if (r.drop) cache.delete(r.h);
          else if (r.text !== undefined) cache.set(r.h, { text: r.text, model: r.model ?? 'cache', tokens: r.tokens ?? { in: 0, out: 0 } });
        }
        return { usage, cache, books: new Map(), chain: Promise.resolve() } as CampaignState;
      })();
      this.states.set(id, p);
    }
    return p;
  }

  private dayKey() { return new Date(this.clock.now()).toISOString().slice(0, 10); }
  private turnC(st: CampaignState, turn: number): LlmTurnCounters { return (st.usage.turns[String(turn)] ??= emptyTurnCounters()); }
  private dayC(st: CampaignState): LlmCounters { return (st.usage.days[this.dayKey()] ??= emptyCounters()); }
  private book(st: CampaignState, turn: number): number[] { let b = st.books.get(turn); if (!b) { b = [0, 0, 0, 0, 0, 0]; st.books.set(turn, b); } return b; }
  /** scrive il registro (in coda: le scritture non si accavallano) */
  private persist(id: string, st: CampaignState, cacheRows: LlmCacheRow[] = []) {
    const store = this.store;
    if (!store) return;
    const snapshot = structuredClone(st.usage);
    st.chain = st.chain.then(async () => { await store.saveLlmUsage(id, snapshot); if (cacheRows.length) await store.appendLlmCache(id, cacheRows); }).catch(() => {});
  }
  /** aspetta le scritture in corso (fine turno, uscita dei comandi, test) */
  async settle() { await Promise.all([...this.states.values()].map(async (p) => (await p).chain)); }

  // ——— riserve e ammissione a gruppi ———

  /**
   * Il motore dichiara le chiamate che chiederà più avanti nel turno, per priorità: chi ha priorità più bassa lascia loro il posto
   * (es. prima delle lettere tra IA si riservano le reazioni delle cancellerie). Valori assoluti per le priorità indicate; ogni chiamata
   * di quella priorità consuma una riserva.
   */
  async expect(c: CampaignRef, turn: number, demand: Partial<Record<Priority, number>>) {
    const b = this.book(await this.state(c.id), turn);
    for (const [p, n] of Object.entries(demand)) b[Number(p)] = Math.max(0, Math.floor(n ?? 0));
  }

  /**
   * Coda a priorità per un gruppo di richieste che arrivano insieme (le lettere del turno): si ammettono per priorità crescente (a parità,
   * nell'ordine dato) finché c'è budget; le altre cadono e chi chiama usa il testo deterministico. Le richieste già in cache (`hash`) sono
   * gratis. Le ammesse riservano il loro posto, così le richieste di priorità più alta del gruppo non vengono scavalcate.
   */
  async admit(c: CampaignRef, turn: number, items: { priority: Priority; hash?: string }[]): Promise<boolean[]> {
    const st = await this.state(c.id); const tc = this.turnC(st, turn); const b = this.book(st, turn); const limit = this.limitFor(c);
    const ok = items.map(() => false);
    let used = tc.admitted;
    const order = items.map((_, i) => i).sort((a, z) => items[a]!.priority - items[z]!.priority || a - z);
    for (const i of order) {
      const it = items[i]!;
      if (this.cacheOn && it.hash && st.cache.has(it.hash)) { ok[i] = true; continue; }
      // le ammesse del gruppo contano già in `used` (e le loro riserve si scrivono solo alla fine, senza contarle due volte)
      if (allowCall(used, limit, b, it.priority)) { ok[i] = true; used++; }
      else this.noteSkip(st, turn, it.priority);
    }
    items.forEach((it, i) => { if (ok[i] && !(this.cacheOn && it.hash && st.cache.has(it.hash))) b[it.priority]!++; });
    this.persist(c.id, st);
    return ok;
  }

  private noteSkip(st: CampaignState, turn: number, p: Priority) {
    const tc = this.turnC(st, turn); const dc = this.dayC(st);
    tc.skipped++; dc.skipped++; tc.skippedByPriority[String(p)] = (tc.skippedByPriority[String(p)] ?? 0) + 1;
  }

  // ——— la chiamata ———

  /** Una richiesta: cache, budget del turno, limiti, modelli del profilo in ordine con il ripiego su 429. */
  async run(c: CampaignRef, turn: number, prio: Priority, req: LlmRequest): Promise<LlmResponse> {
    const st = await this.state(c.id);
    const hash = promptHash(req);
    const hit = this.cacheOn ? st.cache.get(hash) : undefined;
    if (hit) {
      this.turnC(st, turn).cacheHits++; this.dayC(st).cacheHits++;
      this.persist(c.id, st);
      return { text: hit.text, usage: { promptTokens: 0, completionTokens: 0 }, latencyMs: 0, model: hit.model, cached: true };
    }
    const tc = this.turnC(st, turn); const dc = this.dayC(st); const b = this.book(st, turn); const limit = this.limitFor(c);
    if (!allowCall(tc.admitted, limit, b, prio)) {
      this.noteSkip(st, turn, prio); this.persist(c.id, st);
      throw new LlmSkipped('budget', limit === 0 ? 'chiamate LLM disattivate (LLM_BUDGET_CALLS=0)' : `budget di ${limit} chiamate del turno ${turn} esaurito (priorità ${prio}: ${PRIORITY_LABEL[prio]})`);
    }
    tc.admitted++; dc.admitted++; b[prio] = Math.max(0, b[prio]! - 1);
    const sent = { n: 0 };
    try {
      const res = await this.dispatch(st, turn, req, sent);
      if (this.cacheOn) {
        const row: Cached = { text: res.text, model: res.model, tokens: { in: res.usage.promptTokens, out: res.usage.completionTokens } };
        st.cache.set(hash, row);
        this.persist(c.id, st, [{ h: hash, role: req.role, model: res.model, text: res.text, tokens: row.tokens }]);
      } else this.persist(c.id, st);
      return res;
    } catch (e) {
      if (e instanceof LlmSkipped) {
        // nessuna richiesta è partita: il posto nel budget non è stato usato
        if (!sent.n) { tc.admitted = Math.max(0, tc.admitted - 1); dc.admitted = Math.max(0, dc.admitted - 1); }
        this.noteSkip(st, turn, prio);
      } else { tc.errors++; dc.errors++; }
      this.persist(c.id, st);
      throw e;
    }
  }

  private limiter(key: string, ep: Endpoint): RateLimiter {
    let l = this.limiters.get(key);
    if (!l) { l = new RateLimiter(ep.rpm, ep.rpd); this.limiters.set(key, l); }
    return l;
  }

  /** I modelli del ruolo in ordine: salta chi è in pausa o al limite, passa al successivo su 429 o errore, aspetta (entro maxWaitMs) se nessuno è libero. */
  private async dispatch(st: CampaignState, turn: number, req: LlmRequest, sent: { n: number }): Promise<LlmResponse> {
    const chain = this.routing.endpointsFor(req.role, req.model);
    const tc = this.turnC(st, turn); const dc = this.dayC(st);
    let realErr: unknown; let saw429 = false; let sawLimit: 'rate' | 'daily' | null = null;
    for (let round = 0; round < 3; round++) {
      // il primo posto utile tra i modelli saltati (in pausa o al limite): quanto aspettare e se è il limite del giorno
      let next: { wait: number; daily: boolean } | null = null;
      const consider = (wait: number, daily: boolean) => { if (!next || wait < next.wait) next = { wait, daily }; };
      for (const [idx, ep] of chain.entries()) {
        const model = ep.model ?? req.model; const key = `${ep.key}|${model}`;
        const now = this.clock.now();
        const cool = (this.cooling.get(key) ?? 0) - now;
        if (cool > 0) { consider(cool, false); continue; }
        const lim = this.limiter(key, ep); const w = lim.check(now);
        if (w.wait > 0) { consider(w.wait, w.daily); continue; }
        lim.take(now); sent.n++; tc.calls++; dc.calls++;
        tc.byRole[req.role] = (tc.byRole[req.role] ?? 0) + 1;
        try {
          const res = await ep.provider.complete({ ...req, model });
          tc.tokensIn += res.usage.promptTokens; tc.tokensOut += res.usage.completionTokens; dc.tokensIn += res.usage.promptTokens; dc.tokensOut += res.usage.completionTokens;
          if (idx > 0) { tc.fallbacks++; dc.fallbacks++; }
          return res;
        } catch (e) {
          if (e instanceof RateLimitError) {
            saw429 = true; tc.rate429++; dc.rate429++;
            this.cooling.set(key, this.clock.now() + Math.min(e.retryAfterMs ?? this.opts.cooldownMs ?? 30_000, 600_000));
          } else { realErr = e; tc.errors++; dc.errors++; }
        }
      }
      const n = next as { wait: number; daily: boolean } | null;
      if (!n) break;
      sawLimit = n.daily ? 'daily' : 'rate';
      // il limite del giorno non si aspetta; quello al minuto e le pause dopo un 429 sì, se non sono troppo lontani
      if (n.daily || n.wait > this.maxWaitMs) break;
      await this.clock.sleep(n.wait + 1);
      sawLimit = null;
    }
    if (saw429) throw new LlmSkipped('429', 'tutti i modelli del profilo hanno risposto 429 o sono in pausa');
    if (sawLimit) throw new LlmSkipped(sawLimit, sawLimit === 'daily' ? 'limite di richieste al giorno raggiunto (LLM_RPD)' : `limite di richieste al minuto (LLM_RPM): attesa oltre ${Math.round(this.maxWaitMs / 1000)} s`);
    throw realErr ?? new Error(`nessun modello configurato per il ruolo ${req.role}`);
  }

  /** La risposta non è stata accettata dal validatore: via dalla cache, una nuova richiesta la chiederà di nuovo. */
  reject(campaignId: string, req: LlmRequest) {
    const p = this.states.get(campaignId);
    if (!p) return;
    const hash = promptHash(req);
    void p.then((st) => {
      if (!st.cache.delete(hash)) return;
      this.persist(campaignId, st, [{ h: hash, drop: true }]);
    });
  }

  // ——— stato per l'API ———

  async status(campaign?: CampaignRef & { currentTurn?: number }, turn?: number): Promise<BudgetStatus> {
    const now = this.clock.now();
    const out: BudgetStatus = {
      profile: this.routing.name, baseUrl: this.routing.baseUrl, cache: this.cacheOn, maxWaitMs: this.maxWaitMs,
      callsPerTurn: null,
      endpoints: this.routing.all().map((ep) => {
        // un endpoint senza modello fisso ha un limitatore per ogni modello richiesto: si sommano
        const keys = [...this.limiters.keys()].filter((k) => (ep.model ? k === `${ep.key}|${ep.model}` : k.startsWith(`${ep.key}|`)));
        const sum = (f: (l: RateLimiter) => number) => keys.reduce((a, k) => a + f(this.limiters.get(k)!), 0);
        return { key: ep.key, model: ep.model, rpm: ep.rpm, rpd: ep.rpd, inLastMinute: sum((l) => l.rpm.count(now)), inLastDay: sum((l) => l.rpd.count(now)), coolingMs: Math.max(0, ...keys.map((k) => (this.cooling.get(k) ?? 0) - now)) };
      }),
      campaign: null,
    };
    if (!campaign) { if (this.opts.callsPerTurn !== undefined) out.callsPerTurn = Number.isFinite(this.opts.callsPerTurn) ? this.opts.callsPerTurn : null; else out.callsPerTurn = this.opts.defaultCalls ?? 10; return out; }
    const limit = this.limitFor(campaign);
    out.callsPerTurn = Number.isFinite(limit) ? limit : null;
    const st = await this.state(campaign.id);
    const t = turn ?? campaign.currentTurn ?? Math.max(0, ...Object.keys(st.usage.turns).map(Number));
    const tc = st.usage.turns[String(t)];
    out.campaign = {
      id: campaign.id, callsPerTurn: out.callsPerTurn,
      turn: tc ? { ...tc, turn: t, remaining: Number.isFinite(limit) ? Math.max(0, limit - tc.admitted) : null } : null,
      today: st.usage.days[this.dayKey()] ?? emptyCounters(), turns: st.usage.turns, days: st.usage.days,
    };
    return out;
  }
}
