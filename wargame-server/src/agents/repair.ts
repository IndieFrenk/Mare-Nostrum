import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import type { LlmCall } from '../schemas/index.js';
import { extractJson, type LlmProvider, type LlmRequest } from './llm-client.js';
import { template } from './prompts.js';

export interface CallResult<T> { value: T | null; errors: string[]; repairAttempts: number; usage: { promptTokens: number; completionTokens: number; latencyMs: number }; model: string; promptHash: string }

export const promptHash = (r: Pick<LlmRequest, 'system' | 'user'>) => createHash('sha256').update(r.system + '\n' + r.user).digest('hex').slice(0, 16);

/** Chiamata strutturata: parse → Zod → regole; fino a 2 tentativi di repair; null se fallisce (→ fallback). */
export async function callStructured<T>(provider: LlmProvider, log: LlmCall[], ctx: { turn: number; factionId?: string }, req: LlmRequest, schema: ZodType<T>, check: (v: T) => string[] = () => [], maxRepairs = 2): Promise<CallResult<T>> {
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
      errors = parsed.success ? check(parsed.data) : parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
      log.push({ id: `L${ctx.turn}-${log.length}-${current.role}`, turn: ctx.turn, role: current.role, factionId: ctx.factionId, model, promptHash: promptHash(current), request: { system: current.system, user: current.user }, response: text, ok: !errors.length, error: errors.join('; ') || undefined, tokens: { in: res.usage.promptTokens, out: res.usage.completionTokens }, latencyMs: res.latencyMs });
      if (parsed.success && !errors.length) return { value: parsed.data, errors: [], repairAttempts: attempt, usage, model, promptHash: hash };
    } catch (e) {
      errors = [String((e as Error).message ?? e)];
      log.push({ id: `L${ctx.turn}-${log.length}-${current.role}`, turn: ctx.turn, role: current.role, factionId: ctx.factionId, model, promptHash: promptHash(current), request: { system: current.system, user: current.user }, response: text, ok: false, error: errors[0], tokens: { in: 0, out: 0 }, latencyMs: 0 });
    }
    current = { ...req, role: 'repair', system: template('repair', {}), user: template('repair-user', { schema: JSON.stringify(req.jsonSchema), output: text.slice(0, 6000), errors: errors.join('\n') }), meta: { ...req.meta, repairOf: req.role, errors } };
  }
  return { value: null, errors, repairAttempts: maxRepairs, usage, model, promptHash: hash };
}

/** Il narratore non inventa numeri: ogni cifra del testo deve comparire nei fatti. */
export function numbersNotInFacts(text: string, facts: string[]): string[] {
  const norm = (n: string) => n.replace(',', '.').replace(/\.0+$/, '');
  // i riferimenti ai fatti (F3-2, F3-E1, D3-4) non sono cifre inventate: il modello li cita spesso nel testo
  text = text.replace(/\b[FD]\d+-[A-Z0-9_-]+\b/g, ' ');
  const allowed = new Set(facts.join(' ').match(/\d+(?:[.,]\d+)?/g)?.map(norm) ?? []);
  return [...new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map(norm).filter((n) => !allowed.has(n)))];
}
