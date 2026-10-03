import { z } from 'zod';
import { Directive, type LlmCall } from '../schemas/index.js';
import { isEmptyDirective, limitDirective } from '../engine/directive.js';
import type { StrategistJob, StrategistResult } from '../engine/turn-machine.js';
import { roleConfig } from '../engine/turn-machine.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured } from './repair.js';

/**
 * Ruolo strategist (§11): una direttiva strategica per una grande potenza, ogni 3–6 turni. Il modello scrive intenzioni; qui si legge la risposta
 * con larghezza (valori fuori scala non la bocciano: li limita il motore) e si chiede UN repair solo se non resta niente di valido. Poi il motore
 * (engine/directive.ts) limita e il decisore a regole applica. Senza risposta valida: nessuna direttiva, effetto nullo.
 */
const Proposal = z.object({
  horizonTurns: z.number().default(4),
  priorities: z.array(z.object({ kind: z.string(), target: z.string(), weight: z.number().default(0.5) })).default([]),
  zoneInterestDelta: z.record(z.string(), z.number()).default({}),
  seekAgreements: z.array(z.object({ type: z.string(), with: z.string() })).default([]),
  avoid: z.array(z.string()).default([]),
  rationale: z.string().default(''),
});

/** Lo schema inviato al modello: i tetti dello schema `Directive` (maxItems, maxLength) e al massimo 3 zone (maxProperties, che Zod non esprime). */
export const DIRECTIVE_SCHEMA = (() => {
  const s = z.toJSONSchema(Directive, { io: 'input' }) as unknown as { properties: Record<string, Record<string, unknown>> };
  s.properties.zoneInterestDelta!.maxProperties = 3;
  return s as unknown as Record<string, unknown>;
})();

export async function writeDirective(provider: LlmProvider, log: LlmCall[], job: StrategistJob): Promise<StrategistResult> {
  const k = job.knowledge;
  const system = template('strategist', { factionName: k.ownFaction.name, factionId: job.factionId, profile: job.profile });
  const user = template('strategist-user', { turn: String(job.turn), date: job.campaign.date, context: job.context.text });
  const before = log.length;
  const r = await callStructured(provider, log, { turn: job.turn, factionId: job.factionId }, {
    role: 'strategist', ...roleConfig(job.campaign, 'strategist'), system, user,
    schemaName: 'Directive', jsonSchema: DIRECTIVE_SCHEMA, keepLengths: true,
    // il mock costruisce la direttiva da qui: le righe d'opinione e le zone che il motore ha messo nel contesto
    meta: { factionId: job.factionId, turn: job.turn, seed: job.campaign.seed, targets: job.context.targets, rows: job.context.rows, zones: job.context.zones },
  }, Proposal, (v) => {
    // risposta strutturalmente valida ma tutta da scartare (id inventati): si chiede il repair, con i motivi
    const l = limitDirective(v, job.limit);
    const had = v.priorities.length + v.seekAgreements.length + v.avoid.length + Object.keys(v.zoneInterestDelta).length;
    return had && isEmptyDirective(l.directive) ? [`nessuna voce valida: ${l.notes.slice(0, 4).join('; ')}. Usa solo gli id e le zone della SITUAZIONE.`] : [];
  }, 1);
  const mine = log.slice(before);
  const last = mine.filter((c) => c.ok).at(-1) ?? mine.at(-1);
  return {
    proposed: r.value, source: r.value ? 'llm' : 'none', model: r.value ? r.model : 'nessuna', promptHash: r.promptHash,
    request: { system, user }, response: last ? String(last.response) : null, errors: r.errors, usage: r.usage,
  };
}
