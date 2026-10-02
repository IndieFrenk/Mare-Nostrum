import { z } from 'zod';
import { DiploActionNoLetter, Order, ProcurementOrder, PublicStatement, STANCES, ZoneStance, type Campaign, type FactionKnowledge, type LlmCall } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';
import { buildLexicon, nameTable, recognize, type Recognition } from '../engine/names.js';
import type { ParsedDirective } from '../engine/parse-review.js';
import { legalActions } from './context-builder.js';
import { trimFormat } from './faction-agent.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

/**
 * Tetti della risposta del parser: una direttiva chiede pochi ordini. Nello schema inviato (maxItems) fermano i modelli
 * locali che ripetono gli elementi finché finiscono i token (JSON troncato); in lettura le liste più lunghe si tagliano.
 */
export const PARSER_CAPS = { military: 4, diplomacy: 3, procurement: 2, statements: 1, zoneStances: 4, ambiguities: 3 } as const;
export const PARSER_MAX_STANCES = PARSER_CAPS.zoneStances;
/** maxItems delle liste annidate (id di unità, asset, destinatari…), per nome del campo */
const ITEMS: Record<string, number> = { ...PARSER_CAPS, unitIds: 5, assetIds: 2, target: 3, parties: 4, visibility: 4 };
/**
 * maxLength di OGNI stringa libera nello schema inviato (con `keepLengths`: la grammatica di Ollama/llama.cpp ferma il testo),
 * per nome del campo; gli altri (id di unità, zone, fazioni, articoli…) hanno `ids`. Scelti perché il caso peggiore dello
 * schema resti sotto `maxTokens` del ruolo order_parser (test in console-ordini.test.ts).
 */
export const PARSER_LENGTHS: Record<string, number> = {
  message: 160, ambiguities: 150, terms: 120, counterTerms: 120, text: 160, subject: 100, objective: 100, scope: 80,
  audience: 60, targetRef: 40, protect: 40, demand: 100, id: 12, ids: 24,
};
/** chiavi per le munizioni di uno STRIKE (record) */
const MAX_PROPERTIES = 3;

const Out = z.object({
  orders: z.object({
    military: z.array(Order).default([]), diplomacy: z.array(DiploActionNoLetter).default([]),
    procurement: z.array(ProcurementOrder).default([]), statements: z.array(PublicStatement).default([]),
  }),
  zoneStances: z.array(ZoneStance).max(PARSER_MAX_STANCES).default([]),
  ambiguities: z.array(z.string()).default([]),
});

/** Aggiunge maxItems/maxLength/maxProperties a ogni lista, stringa libera e record dello schema JSON (per nome del campo). */
function bounded(node: unknown, key = ''): unknown {
  if (Array.isArray(node)) return node.map((x) => bounded(x, key));
  if (!node || typeof node !== 'object') return node;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([name, child]) => [name, bounded(child, name)]));
    else if (['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties', 'propertyNames'].includes(k)) out[k] = bounded(v, key);
    else out[k] = v;
  }
  if (out.type === 'string' && out.enum === undefined && out.const === undefined) out.maxLength ??= PARSER_LENGTHS[key] ?? PARSER_LENGTHS.ids;
  if (out.type === 'array') out.maxItems ??= ITEMS[key] ?? 4;
  if (out.type === 'object' && out.additionalProperties && typeof out.additionalProperties === 'object') out.maxProperties ??= MAX_PROPERTIES;
  return out;
}
/** Schema inviato al modello: niente LETTER (le lettere hanno il loro pannello) e limiti su liste e testi. */
export const PARSER_SCHEMA = bounded(z.toJSONSchema(Out, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>;

/**
 * Lunghezza massima (caratteri) di un JSON compatto valido per lo schema: ogni lista piena, ogni testo al massimo, la
 * variante più lunga di ogni unione. Serve a scegliere limiti che stiano sotto il tetto di token del ruolo.
 */
export function maxJsonChars(node: unknown): number {
  const n = (node ?? {}) as Record<string, unknown>;
  if (n.const !== undefined) return JSON.stringify(n.const).length;
  if (Array.isArray(n.enum)) return Math.max(...n.enum.map((x) => JSON.stringify(x).length));
  const alt = (n.anyOf ?? n.oneOf) as unknown[] | undefined;
  if (alt) return Math.max(...alt.map(maxJsonChars));
  switch (n.type) {
    case 'string': return Number(n.maxLength ?? Infinity) + 2;
    case 'number': case 'integer': return 16;
    case 'boolean': return 5;
    case 'null': return 4;
    case 'array': return 2 + Number(n.maxItems ?? Infinity) * (maxJsonChars(n.items) + 1);
    case 'object': {
      const props = Object.entries((n.properties ?? {}) as Record<string, unknown>).reduce((a, [k, v]) => a + JSON.stringify(k).length + 1 + maxJsonChars(v) + 1, 0);
      const extra = n.additionalProperties && typeof n.additionalProperties === 'object'
        ? Number(n.maxProperties ?? Infinity) * (maxJsonChars(n.propertyNames ?? { type: 'string' }) + 1 + maxJsonChars(n.additionalProperties) + 1) : 0;
      return 2 + props + extra;
    }
    default: return Infinity;
  }
}

/** in lettura: liste tagliate ai tetti, niente lettere, posture sconosciute tolte, intensità riportata in 1–3 (come per le fazioni) */
const cap = (n: number) => (v: unknown) => (Array.isArray(v) ? v.slice(0, n) : v);
export const ParsedLenient = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const d = raw as Record<string, unknown>;
  const o = d.orders && typeof d.orders === 'object' ? d.orders as Record<string, unknown> : null;
  const diplomacy = Array.isArray(o?.diplomacy) ? o.diplomacy.filter((x) => (x as { kind?: string })?.kind !== 'LETTER') : o?.diplomacy;
  const zoneStances = Array.isArray(d.zoneStances) ? d.zoneStances
    .filter((x) => x && typeof x === 'object' && (STANCES as readonly string[]).includes((x as { stance?: string }).stance ?? ''))
    .map((x) => { const n = Number((x as { intensity?: unknown }).intensity); return { ...x, intensity: Number.isFinite(n) ? Math.max(1, Math.min(3, Math.round(n))) : 1 }; })
    .slice(0, PARSER_MAX_STANCES) : d.zoneStances;
  return { ...d, zoneStances, ambiguities: cap(PARSER_CAPS.ambiguities)(d.ambiguities),
    orders: o ? { ...o, military: cap(PARSER_CAPS.military)(o.military), diplomacy: cap(PARSER_CAPS.diplomacy)(diplomacy), procurement: cap(PARSER_CAPS.procurement)(o.procurement), statements: cap(PARSER_CAPS.statements)(o.statements) } : d.orders };
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
    schemaName: 'ParsedOrders', jsonSchema: PARSER_SCHEMA, keepLengths: true, meta: { text: p.recognition.text, original: text, legal: p.legal, recognized: p.recognition.hits },
  }, ParsedLenient);
  const recognized = p.recognition.hits;
  if (!r.value) return { orders: { military: [], diplomacy: [], procurement: [], statements: [] }, zoneStances: [], ambiguities: [r.skipped ? `Chiamate LLM non disponibili (${r.errors[0]?.replace(/^chiamata LLM non fatta: /, '') ?? r.skipped}): usare il costruttore strutturato.` : 'Impossibile interpretare la direttiva: usare il costruttore strutturato.', ...nameAmbiguities(p.recognition)], recognized };
  return { ...r.value, ambiguities: [...r.value.ambiguities, ...nameAmbiguities(p.recognition)], recognized };
}
