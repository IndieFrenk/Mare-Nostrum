import { AgentMemory, type AgentDecision, type Campaign, type GameEvent, type LlmCall } from '../schemas/index.js';
import { z } from 'zod';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

const Out = AgentMemory.omit({ schemaVersion: true, factionId: true, updatedTurn: true }).extend({ lessons: z.array(z.string()) });

/** Molti modelli scrivono le note come oggetti ({trust, tension, note}): le riduciamo a una frase invece di scartare la memoria. */
export function noteText(v: unknown): unknown {
  if (typeof v === 'string' || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(noteText).filter((x) => typeof x === 'string' && x).join('; ');
  const o = v as Record<string, unknown>;
  const text = [o.note, o.notes, o.text, o.summary].map(noteText).find((x) => typeof x === 'string' && x);
  const nums = Object.entries(o).filter(([, x]) => typeof x === 'number').map(([k, x]) => `${k} ${x}`).join(', ');
  return [text, nums].filter(Boolean).join(' — ') || JSON.stringify(o).slice(0, 200);
}
const OutLenient = Out.extend({ relationshipNotes: z.record(z.string(), z.preprocess(noteText, z.string())) });

/** Limiti imposti dal codice: memoria compatta per controllare il contesto. */
export function clampMemory(m: AgentMemory): AgentMemory {
  const words = m.rollingSummary.split(/\s+/);
  return {
    ...m, strategicGoals: m.strategicGoals.slice(0, 6), commitments: m.commitments.slice(-20), grievances: m.grievances.slice(-20),
    lessons: m.lessons.slice(-10), rollingSummary: words.length > 400 ? words.slice(-400).join(' ') : m.rollingSummary,
  };
}

/** Aggiornamento della memoria senza IA (turni a cadenza ridotta): una riga nel riassunto, il resto invariato. */
export function quickMemory(memory: AgentMemory, decision: AgentDecision | null, turn: number): AgentMemory {
  const line = `T${turn}: ${decision?.privateIntent ?? 'nessuna decisione'}.`;
  return clampMemory({ ...memory, rollingSummary: `${memory.rollingSummary} ${line}`.trim(), updatedTurn: turn });
}

export async function reflect(provider: LlmProvider, log: LlmCall[], c: Campaign, i: { factionId: string; decision: AgentDecision | null; visibleEvents: GameEvent[]; memory: AgentMemory }): Promise<AgentMemory> {
  const turn = c.currentTurn;
  const events = i.visibleEvents.filter((e) => e.type !== 'UNIT_STATUS' && e.type !== 'BUDGET_CHANGED').slice(-40).map((e) => `${e.type} ${e.actor}→${e.targets.join(',')} ${JSON.stringify(e.payload).slice(0, 160)}`);
  const r = await callStructured(provider, log, { turn, factionId: i.factionId }, {
    role: 'reflection', ...c.config.llm.reflection,
    system: template('reflection', { factionId: i.factionId }),
    user: template('reflection-user', { memory: JSON.stringify(i.memory), decision: JSON.stringify(i.decision ? { assessment: i.decision.situationAssessment, intent: i.decision.privateIntent, orders: i.decision.orders } : null), events: events.join('\n') }),
    schemaName: 'AgentMemory', jsonSchema: z.toJSONSchema(Out, { io: 'input' }) as Record<string, unknown>, meta: { memory: i.memory, decision: i.decision, events, turn },
  }, OutLenient);
  const base = r.value ?? { ...i.memory, rollingSummary: `${i.memory.rollingSummary} T${turn}: ${i.decision?.privateIntent ?? 'nessuna decisione'}.`.trim() };
  return clampMemory({ ...i.memory, ...base, schemaVersion: 1, factionId: i.factionId, updatedTurn: turn });
}
