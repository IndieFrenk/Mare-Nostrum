import type { AgentRole } from '../schemas/index.js';

export interface LlmRequest {
  role: AgentRole; model: string; temperature: number; maxTokens: number; timeoutMs: number;
  system: string; user: string; schemaName: string; jsonSchema: Record<string, unknown>;
  /** input strutturati: ignorati dai modelli reali, usati dal MockLLMProvider */
  meta: Record<string, unknown>;
}
export interface LlmResponse { text: string; usage: { promptTokens: number; completionTokens: number }; latencyMs: number; model: string }
export interface LlmProvider { name: string; complete(req: LlmRequest): Promise<LlmResponse> }

/** Estrae il primo oggetto JSON bilanciato da un testo (gestisce fence e prosa attorno). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('nessun oggetto JSON nella risposta');
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('JSON troncato');
}

/**
 * Toglie dallo schema i vincoli che diversi provider rifiutano in response_format (es. Cohere: «non-supported
 * constraint minLength»). La risposta viene comunque validata con Zod, quindi i vincoli non si perdono.
 */
const UNSUPPORTED = new Set(['minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', '$schema']);
export function portableSchema(s: unknown, names = false): unknown {
  if (Array.isArray(s)) return s.map((x) => portableSchema(x));
  if (!s || typeof s !== 'object') return s;
  // dentro `properties`/`$defs` le chiavi sono nomi di campi (anche «format»): si tengono tutte
  return Object.fromEntries(Object.entries(s).filter(([k]) => names || !UNSUPPORTED.has(k))
    .map(([k, v]) => [k, portableSchema(v, !names && (k === 'properties' || k === '$defs' || k === 'definitions'))]));
}

/** Errore HTTP che non ha senso ripetere (modello inesistente, richiesta rifiutata). */
class FatalHttpError extends Error {}

/**
 * Client OpenAI-compatible (OmniRoute): json_schema se il modello lo supporta, altrimenti json_object; 2 retry con backoff.
 * Il passaggio a json_object è per modello (o combo) e solo quando l'errore parla davvero di response_format/json_schema:
 * un 400 per altri motivi (es. modello non disponibile) non deve spegnere json_schema per tutti.
 */
export class OpenAiCompatProvider implements LlmProvider {
  name = 'openai-compat';
  private jsonSchemaUnsupported = new Set<string>();
  /** LLM_EXTRA_BODY: campi aggiunti a ogni richiesta, in JSON (es. {"reasoning_effort":"none"} per spegnere il ragionamento). */
  private extra: Record<string, unknown> = (() => { try { return JSON.parse(process.env.LLM_EXTRA_BODY || '{}'); } catch { return {}; } })();
  /** LLM_RESPONSE_FORMAT=json_object salta del tutto json_schema (utile se i provider principali non lo accettano). */
  constructor(readonly baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1', readonly apiKey = process.env.LLM_API_KEY, readonly responseFormat = process.env.LLM_RESPONSE_FORMAT ?? 'json_schema') {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
      const plainJson = this.responseFormat === 'json_object' || this.jsonSchemaUnsupported.has(req.model);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({
            ...this.extra, model: req.model, temperature: req.temperature, max_tokens: req.maxTokens,
            messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
            response_format: plainJson ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: req.schemaName, schema: portableSchema(req.jsonSchema), strict: false } },
          }),
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          // 400 diretto o 502 di una combo che ha provato un provider incompatibile (es. Cohere: niente record/minLength)
          if ((res.status === 400 || res.status === 502) && !plainJson && /response_format|json_schema/i.test(body)) { this.jsonSchemaUnsupported.add(req.model); attempt--; continue; }
          const msg = `LLM HTTP ${res.status}: ${body}`;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new FatalHttpError(msg);
          throw new Error(msg);
        }
        const j = (await res.json()) as { model?: string; choices: { message: { content: unknown } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        // alcuni provider (via OmniRoute) restituiscono content già come oggetto JSON o come lista di parti
        const content = j.choices[0]?.message.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map((x) => (typeof x === 'string' ? x : (x as { text?: string })?.text ?? '')).join('')
          : content == null ? '' : JSON.stringify(content);
        return { text, usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 }, latencyMs: Date.now() - t0, model: j.model ?? req.model };
      } catch (e) {
        if (e instanceof FatalHttpError) throw e;
        lastErr = e;
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }
}
