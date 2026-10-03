import type { LlmCounters, LlmTurnCounters } from '../schemas/index.js';

/**
 * Stato dei modelli: il PC con Ollama (o OmniRoute) risponde? Quali modelli configurati mancano?
 * Serve alla UI (pallino nella barra in alto) e al server, che rifiuta ▶ invece di giocare un turno tutto in dottrina.
 */

/** Stato del budget delle chiamate LLM (agents/budget.ts): profilo, tetto per turno, limiti per modello e contatori della campagna. */
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

export interface LlmStatus {
  reachable: boolean;
  /** 'mock': provider finto (WARGAME_MOCK=1 o test), nessuna rete */
  mode: 'llm' | 'mock';
  baseUrl: string;
  /** modello per ruolo agente (quelli della campagna, se indicata, altrimenti i predefiniti del server) */
  models: Record<string, string>;
  /** modelli configurati che il server non elenca in /models */
  missing: string[];
  /** modelli elencati dal server (null: /models non disponibile, si sa solo che risponde) */
  listed: string[] | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
  /** risultato dalla cache (30 s) */
  cached: boolean;
  /** true: con i modelli irraggiungibili il server rifiuta ▶ (503 LLM_UNREACHABLE) */
  enforced: boolean;
  /** WARGAME_ALLOW_OFFLINE=1: si gioca anche senza modelli (turni in dottrina) */
  offlineAllowed: boolean;
  /** chi decide le mosse delle fazioni (aggiunto dalla rotta /llm/status): in `rules` `models` elenca solo i ruoli che usano l'LLM */
  factionMode?: 'rules' | 'llm';
  /**
   * Budget delle chiamate (aggiunto dalla rotta /llm/status, settore 11): profilo, chiamate per turno, limiti per modello e, con `campaignId`, i
   * contatori della campagna — chiamate, token in/out, 429, ripieghi, chiamate saltate per budget — per turno e per giorno.
   */
  budget?: BudgetStatus;
}

export interface LlmStatusSource {
  enforced: boolean;
  status(models: Record<string, string>, fresh?: boolean): Promise<LlmStatus>;
}

interface Probe { reachable: boolean; listed: string[] | null; latencyMs: number | null; error: string | null; checkedAt: string }

/** Un modello configurato è presente se il server lo elenca (Ollama aggiunge «:latest» ai nomi senza tag, Google il prefisso «models/»). */
export const missingModels = (models: Record<string, string>, listed: string[] | null) =>
  listed === null ? [] : [...new Set(Object.values(models))].filter((m) => !listed.includes(m) && !listed.includes(`${m}:latest`) && !listed.includes(`models/${m}`)).sort();

/** Sonda di un endpoint OpenAI-compatible: GET {baseUrl}/models con timeout, risultato in cache per `ttlMs`. */
export class LlmStatusProbe implements LlmStatusSource {
  private last: { at: number; probe: Probe } | null = null;
  private inflight: Promise<Probe> | null = null;
  constructor(readonly baseUrl: string, readonly apiKey: string | undefined, readonly opts: { enforced: boolean; offlineAllowed: boolean; timeoutMs?: number; ttlMs?: number }) {}
  get enforced() { return this.opts.enforced; }

  async status(models: Record<string, string>, fresh = false): Promise<LlmStatus> {
    const ttl = this.opts.ttlMs ?? 30_000;
    const hit = !fresh && this.last && Date.now() - this.last.at < ttl ? this.last.probe : null;
    const p = hit ?? await (this.inflight ??= this.probe().finally(() => { this.inflight = null; }));
    return { ...p, mode: 'llm', baseUrl: this.baseUrl, models, missing: p.reachable ? missingModels(models, p.listed) : [], cached: !!hit, enforced: this.opts.enforced, offlineAllowed: this.opts.offlineAllowed };
  }

  private async probe(): Promise<Probe> {
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 3000);
    const done = (p: Omit<Probe, 'checkedAt' | 'latencyMs'>, latency = true): Probe => {
      const probe = { ...p, latencyMs: latency ? Date.now() - t0 : null, checkedAt: new Date().toISOString() };
      this.last = { at: Date.now(), probe };
      return probe;
    };
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/models`, { signal: ctl.signal, headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {} });
      // il server risponde ma non ha /models: raggiungibile, elenco sconosciuto
      if (res.status === 404 || res.status === 405) return done({ reachable: true, listed: null, error: null });
      if (!res.ok) return done({ reachable: false, listed: null, error: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (chiave LLM_API_KEY rifiutata)' : ''}` });
      const body = (await res.json().catch(() => null)) as { data?: { id?: string }[]; models?: { name?: string; model?: string }[] } | null;
      const listed = body?.data?.map((m) => m.id ?? '').filter(Boolean) ?? body?.models?.map((m) => m.name ?? m.model ?? '').filter(Boolean) ?? null;
      return done({ reachable: true, listed, error: null });
    } catch (e) {
      return done({ reachable: false, listed: null, error: networkError(e, this.opts.timeoutMs ?? 3000) }, false);
    } finally { clearTimeout(timer); }
  }
}

const CODES: Record<string, string> = { ECONNREFUSED: 'connessione rifiutata', ENOTFOUND: 'indirizzo sconosciuto', EHOSTUNREACH: 'host irraggiungibile', ETIMEDOUT: 'tempo scaduto', ECONNRESET: 'connessione interrotta' };
/** Causa leggibile di un errore di rete di fetch (undici la mette in `cause`, a volte dentro un AggregateError). */
function networkError(e: unknown, timeoutMs: number): string {
  const err = e as Error & { cause?: Error & { code?: string; errors?: { code?: string }[] } };
  if (err.name === 'AbortError') return `nessuna risposta in ${timeoutMs / 1000} s`;
  const code = err.cause?.code ?? err.cause?.errors?.find((x) => x.code)?.code;
  return code ? `${CODES[code] ?? 'errore di rete'} (${code})` : err.cause?.message ?? err.message;
}

/** Provider finto (mock/test): sempre raggiungibile, nessun controllo prima di ▶. */
export const mockStatus = (): LlmStatusSource => ({
  enforced: false,
  status: async (models) => ({ reachable: true, mode: 'mock', baseUrl: 'mock', models, missing: [], listed: null, latencyMs: 0, error: null, checkedAt: new Date().toISOString(), cached: false, enforced: false, offlineAllowed: true }),
});
