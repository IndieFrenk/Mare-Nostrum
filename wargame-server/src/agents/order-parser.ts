import { z } from 'zod';
import { OrdersBody, type Campaign, type FactionKnowledge, type LlmCall } from '../schemas/index.js';
import type { Scenario } from '../engine/scenario.js';
import { legalActions } from './context-builder.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

const Out = z.object({ orders: OrdersBody, ambiguities: z.array(z.string()).default([]) });

export async function parseOrders(provider: LlmProvider, log: LlmCall[], c: Campaign, sc: Scenario, text: string, k: FactionKnowledge) {
  const legal = legalActions(k, sc);
  const r = await callStructured(provider, log, { turn: k.turn, factionId: k.factionId }, {
    role: 'order_parser', ...c.config.llm.order_parser,
    system: template('parser', {}), user: template('parser-user', { text, legal: JSON.stringify(legal) }),
    schemaName: 'ParsedOrders', jsonSchema: z.toJSONSchema(Out, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>, meta: { text, legal },
  }, Out);
  return r.value ?? { orders: { military: [], diplomacy: [], procurement: [], statements: [] }, ambiguities: ['Impossibile interpretare la direttiva: usare il costruttore strutturato.'] };
}
