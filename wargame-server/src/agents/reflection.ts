import { AgentMemory, type AgentDecision, type Campaign, type GameEvent, type LlmCall } from '../schemas/index.js';
import { z } from 'zod';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

const Out = AgentMemory.omit({ schemaVersion: true, factionId: true, updatedTurn: true }).extend({ lessons: z.array(z.string()) });

/** Limiti imposti dal codice: memoria compatta per controllare il contesto. */
export function clampMemory(m: AgentMemory): AgentMemory {
  const words = m.rollingSummary.split(/\s+/);
  return {
    ...m, strategicGoals: m.strategicGoals.slice(0, 6), commitments: m.commitments.slice(-20), grievances: m.grievances.slice(-20),
    lessons: m.lessons.slice(-10), rollingSummary: words.length > 400 ? words.slice(-400).join(' ') : m.rollingSummary,
  };
}

export async function reflect(provider: LlmProvider, log: LlmCall[], c: Campaign, i: { factionId: string; decision: AgentDecision | null; visibleEvents: GameEvent[]; memory: AgentMemory }): Promise<AgentMemory> {
  const turn = c.currentTurn;
  const events = i.visibleEvents.filter((e) => e.type !== 'UNIT_STATUS' && e.type !== 'BUDGET_CHANGED').slice(-40).map((e) => `${e.type} ${e.actor}→${e.targets.join(',')} ${JSON.stringify(e.payload).slice(0, 160)}`);
  const r = await callStructured(provider, log, { turn, factionId: i.factionId }, {
    role: 'reflection', ...c.config.llm.reflection,
    system: template('reflection', { factionId: i.factionId }),
    user: template('reflection-user', { memory: JSON.stringify(i.memory), decision: JSON.stringify(i.decision ? { assessment: i.decision.situationAssessment, intent: i.decision.privateIntent, orders: i.decision.orders } : null), events: events.join('\n') }),
    schemaName: 'AgentMemory', jsonSchema: z.toJSONSchema(Out, { io: 'input' }) as Record<string, unknown>, meta: { memory: i.memory, decision: i.decision, events, turn },
  }, Out);
  const base = r.value ?? { ...i.memory, rollingSummary: `${i.memory.rollingSummary} T${turn}: ${i.decision?.privateIntent ?? 'nessuna decisione'}.`.trim() };
  return clampMemory({ ...i.memory, ...base, schemaVersion: 1, factionId: i.factionId, updatedTurn: turn });
}
