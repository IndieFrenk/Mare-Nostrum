import { z } from 'zod';
import { OrdersBody, STANCES, ZoneStance, type Campaign, type FactionKnowledge, type LlmCall } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';
import { buildLexicon, nameTable, recognize, type Recognition } from '../engine/names.js';
import type { ParsedDirective } from '../engine/parse-review.js';
import { legalActions } from './context-builder.js';
import { trimFormat } from './faction-agent.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

export const PARSER_MAX_STANCES = 4;
const Out = z.object({
  orders: OrdersBody,
  zoneStances: z.array(ZoneStance).max(PARSER_MAX_STANCES).default([]),
  ambiguities: z.array(z.string()).default([]),
});
export const PARSER_SCHEMA = z.toJSONSchema(Out, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
/** in lettura: posture sconosciute tolte, intensità riportata in 1–3 (come per le fazioni) */
export const ParsedLenient = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const d = raw as Record<string, unknown>;
  const zoneStances = Array.isArray(d.zoneStances) ? d.zoneStances
    .filter((x) => x && typeof x === 'object' && (STANCES as readonly string[]).includes((x as { stance?: string }).stance ?? ''))
    .map((x) => { const n = Number((x as { intensity?: unknown }).intensity); return { ...x, intensity: Number.isFinite(n) ? Math.max(1, Math.min(3, Math.round(n))) : 1 }; })
    .slice(0, PARSER_MAX_STANCES) : d.zoneStances;
  return { ...d, zoneStances };
}, Out);

/** Prompt del parser (uguale nel gioco e nel banco dei modelli): nomi già risolti nel testo e tabella nome → id. */
export function parserPrompt(k: FactionKnowledge, sc: Scenario, text: string): { system: string; user: string; legal: ReturnType<typeof legalActions>; recognition: Recognition } {
  const legal = legalActions(k, sc);
  const lex = buildLexicon(k.ownUnits, sc);
  const recognition = recognize(text, lex);
  return {
    legal, recognition,
    system: trimFormat(template('parser', {}), legal.orderKinds),
    user: template('parser-user', {
      text: recognition.text, legal: JSON.stringify(legal),
      unitNames: nameTable(lex, 'unit'), zoneNames: nameTable(lex, 'zone'), factionNames: nameTable(lex, 'faction'),
    }),
  };
}

/** Ambiguità dei nomi riconosciuti prima dell'LLM (es. «Libia» → governo di Tripoli o LNA). */
export const nameAmbiguities = (r: Recognition) => r.ambiguous.map((a) => `«${a.alias}» può indicare ${a.ids.join(' o ')}: specifica quale.`);

export async function parseOrders(provider: LlmProvider, log: LlmCall[], c: Campaign, sc: Scenario, text: string, k: FactionKnowledge): Promise<ParsedDirective> {
  const p = parserPrompt(k, sc, text);
  const r = await callStructured(provider, log, { turn: k.turn, factionId: k.factionId }, {
    role: 'order_parser', ...c.config.llm.order_parser,
    system: p.system, user: p.user,
    schemaName: 'ParsedOrders', jsonSchema: PARSER_SCHEMA, meta: { text: p.recognition.text, original: text, legal: p.legal, recognized: p.recognition.hits },
  }, ParsedLenient);
  const recognized = p.recognition.hits;
  if (!r.value) return { orders: { military: [], diplomacy: [], procurement: [], statements: [] }, zoneStances: [], ambiguities: ['Impossibile interpretare la direttiva: usare il costruttore strutturato.', ...nameAmbiguities(p.recognition)], recognized };
  return { ...r.value, ambiguities: [...r.value.ambiguities, ...nameAmbiguities(p.recognition)], recognized };
}
