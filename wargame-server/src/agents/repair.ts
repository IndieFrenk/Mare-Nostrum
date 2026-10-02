import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import type { LlmCall } from '../schemas/index.js';
import { extractJson, LlmSkipped, type LlmProvider, type LlmRequest } from './llm-client.js';
import { template } from './prompts.js';

export interface CallResult<T> {
  value: T | null; errors: string[]; repairAttempts: number; usage: { promptTokens: number; completionTokens: number; latencyMs: number }; model: string; promptHash: string;
  /** la chiamata non è stata fatta (budget, limite di richieste, tutti i modelli in 429): il ruolo usa il suo testo deterministico, nessun repair */
  skipped?: LlmSkipped['reason'];
}

export const promptHash = (r: Pick<LlmRequest, 'system' | 'user'>) => createHash('sha256').update(r.system + '\n' + r.user).digest('hex').slice(0, 16);

/**
 * Chiamata strutturata: parse → Zod → regole; fino a 2 tentativi di repair; null se fallisce (→ fallback).
 * `check` può anche segnalare con `warn` ciò che ha scartato senza bocciare la risposta: finisce nel registro della chiamata.
 */
export async function callStructured<T>(provider: LlmProvider, log: LlmCall[], ctx: { turn: number; factionId?: string }, req: LlmRequest, schema: ZodType<T>, check: (v: T, warn: (w: string) => void) => string[] = () => [], maxRepairs = 2): Promise<CallResult<T>> {
  const usage = { promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  let current = req; let errors: string[] = []; let model = req.model;
  const hash = promptHash(req);
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    let text = '';
    try {
      const res = await provider.complete(current);
      text = res.text; model = res.model;
      usage.promptTokens += res.usage.promptTokens; usage.completionTokens += res.usage.completionTokens; usage.latencyMs += res.latencyMs;
      const parsed = schema.safeParse(extractJson(text));
      const warnings: string[] = [];
      errors = parsed.success ? check(parsed.data, (w) => warnings.push(w)) : parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
      const note = errors.length ? errors.join('; ') : warnings.length ? `scartato: ${warnings.join('; ')}` : '';
      log.push({ id: `L${ctx.turn}-${log.length}-${current.role}`, turn: ctx.turn, role: current.role, factionId: ctx.factionId, model, promptHash: promptHash(current), request: { system: current.system, user: current.user }, response: text, ok: !errors.length, error: note || undefined, tokens: { in: res.usage.promptTokens, out: res.usage.completionTokens }, latencyMs: res.latencyMs, ...(res.cached ? { cached: true } : {}) });
      if (parsed.success && !errors.length) return { value: parsed.data, errors: [], repairAttempts: attempt, usage, model, promptHash: hash };
      provider.reject?.(current); // la risposta (anche in cache) non è valida: la prossima richiesta uguale la rifà
    } catch (e) {
      // chiamata non fatta (budget, limiti, 429 su tutti i modelli): niente repair, il ruolo passa al suo testo deterministico
      if (e instanceof LlmSkipped) return { value: null, errors: [`chiamata LLM non fatta: ${e.message}`], repairAttempts: attempt, usage, model, promptHash: hash, skipped: e.reason };
      errors = [String((e as Error).message ?? e)];
      if (text) provider.reject?.(current); // risposta non JSON: non resta in cache
      log.push({ id: `L${ctx.turn}-${log.length}-${current.role}`, turn: ctx.turn, role: current.role, factionId: ctx.factionId, model, promptHash: promptHash(current), request: { system: current.system, user: current.user }, response: text, ok: false, error: errors[0], tokens: { in: 0, out: 0 }, latencyMs: 0 });
    }
    current = { ...req, role: 'repair', system: template('repair', {}), user: template('repair-user', { schema: JSON.stringify(req.jsonSchema), output: text.slice(0, 6000), errors: errors.join('\n') }), meta: { ...req.meta, repairOf: req.role, errors } };
  }
  return { value: null, errors, repairAttempts: maxRepairs, usage, model, promptHash: hash };
}

/** Il narratore non inventa numeri: ogni cifra del testo deve comparire nei fatti. */
export function numbersNotInFacts(text: string, facts: string[]): string[] {
  const norm = (n: string) => n.replace(',', '.').replace(/\.0+$/, '');
  // i riferimenti ai fatti (F3-2, F3-E1, D3-4) e agli eventi (E3-12) non sono cifre inventate: il modello li cita spesso nel testo
  text = text.replace(/\b[FDE]\d+-[A-Z0-9_-]+\b/g, ' ');
  const allowed = new Set(facts.join(' ').match(/\d+(?:[.,]\d+)?/g)?.map(norm) ?? []);
  return [...new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(norm).filter((n) => !allowed.has(n)))];
}
