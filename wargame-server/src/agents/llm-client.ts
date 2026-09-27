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

/** Client OpenAI-compatible (OmniRoute): json_schema se supportato, altrimenti json_object; 2 retry con backoff. */
export class OpenAiCompatProvider implements LlmProvider {
  name = 'openai-compat';
  private jsonSchemaUnsupported = false;
  constructor(readonly baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:20128/v1', readonly apiKey = process.env.LLM_API_KEY) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      const t0 = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify({
            model: req.model, temperature: req.temperature, max_tokens: req.maxTokens,
            messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
            response_format: this.jsonSchemaUnsupported ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: false } },
          }),
        });
        if (res.status === 400 && !this.jsonSchemaUnsupported) { this.jsonSchemaUnsupported = true; attempt--; continue; }
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const j = (await res.json()) as { model?: string; choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        return { text: j.choices[0]?.message.content ?? '', usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 }, latencyMs: Date.now() - t0, model: j.model ?? req.model };
      } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }
}
