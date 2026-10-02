import { z } from 'zod';
import type { ChanceryStatement, LlmCall } from '../schemas/index.js';
import { PARAMS } from '../engine/params.js';
import { personNames, templateStatement, wordCount } from '../engine/chancery.js';
import { roleConfig, type ChanceryJob, type ChanceryResult } from '../engine/turn-machine.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured, numbersNotInFacts } from './repair.js';

/**
 * Ruolo chancery (§11): UNA chiamata per atto grave scrive le frasi dei 6–8 Stati scelti dal motore. L'LLM scrive solo il testo: Stati e posizioni sono del
 * motore (anche se il modello scrive un'altra posizione, vale quella del motore). Ogni frase è controllata: ≤ 30 parole, nessun numero che non sia nel
 * fatto, nessun nome di persona; se non passa, o il modello non l'ha scritta, vale la frase-modello della posizione. Senza budget: tutte frasi-modello.
 */
const Out = z.object({ statements: z.array(z.object({ iso: z.string(), position: z.string().optional(), text: z.string() })).default([]) });
const SCHEMA = z.toJSONSchema(z.object({ statements: z.array(z.object({ iso: z.string().max(3), position: z.enum(['condemn', 'support', 'silence']), text: z.string().max(260) })).max(PARAMS.chancery.maxStates) }), { io: 'input' }) as Record<string, unknown>;

/** Prompt e fatti ammessi (uguali nel gioco e nel banco dei modelli). */
export function chanceryPrompt(job: Pick<ChanceryJob, 'event' | 'states' | 'actorName' | 'victimName' | 'turn'> & { campaign: { date: string } }) {
  const e = job.event;
  return {
    system: template('chancery', {}),
    user: template('chancery-user', {
      kind: e.kind, turn: String(job.turn), date: job.campaign.date, actor: job.actorName, victim: job.victimName, zone: e.zoneId ? ` (zona ${e.zoneId})` : '', text: e.text,
      states: job.states.map((s) => `${s.iso} · ${s.name} · ${s.position}${s.role.length ? ` · ${s.role.slice(0, 3).join(', ')}` : ''}`).join('\n'),
    }),
    facts: [e.text, e.id],
  };
}

/** Controlli di una frase: dice perché non passa (lista vuota = passa). */
export function statementErrors(text: string, facts: string[], vocabulary: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const n = wordCount(text);
  if (!text.trim()) return ['frase vuota'];
  if (n > PARAMS.chancery.maxWords) out.push(`${n} parole (massimo ${PARAMS.chancery.maxWords})`);
  const nums = numbersNotInFacts(text, facts);
  if (nums.length) out.push(`numeri non presenti nel fatto: ${nums.join(', ')}`);
  const names = personNames(text, vocabulary);
  if (names.length) out.push(`nomi di persona (solo la carica): ${names.join(', ')}`);
  return out;
}

/** Le frasi dell'atto: dal modello dove passano i controlli, dal modello di frase negli altri casi; posizioni sempre quelle del motore. */
export function assembleStatements(job: Pick<ChanceryJob, 'event' | 'states' | 'actorName' | 'victimName' | 'vocabulary'>, proposed: { iso: string; text: string }[] | null, facts: string[]): { statements: ChanceryStatement[]; errors: string[] } {
  const errors: string[] = [];
  const byIso = new Map<string, string>();
  for (const p of proposed ?? []) if (!byIso.has(p.iso.toUpperCase())) byIso.set(p.iso.toUpperCase(), p.text.trim());
  const statements = job.states.map((st): ChanceryStatement => {
    const text = byIso.get(st.iso);
    const why = text === undefined ? [proposed ? 'frase mancante' : ''].filter(Boolean) : statementErrors(text, facts, job.vocabulary);
    if (text !== undefined && !why.length) return { eventId: job.event.id, iso: st.iso, position: st.position, text, source: 'ai' };
    if (why.length) errors.push(`${st.iso}: ${why.join('; ')}`);
    return { eventId: job.event.id, iso: st.iso, position: st.position, text: templateStatement(st, { kind: job.event.kind, actorName: job.actorName, victimName: job.victimName }), source: 'template' };
  });
  return { statements, errors };
}

/** Una chiamata per atto grave; senza risposta valida (o senza budget) tutte le frasi sono frasi-modello. */
export async function writeStatements(provider: LlmProvider, log: LlmCall[], job: ChanceryJob): Promise<ChanceryResult> {
  const { system, user, facts } = chanceryPrompt(job);
  const r = await callStructured(provider, log, { turn: job.turn }, {
    role: 'chancery', ...roleConfig(job.campaign, 'chancery'), system, user,
    schemaName: 'Statements', jsonSchema: SCHEMA, keepLengths: true,
    meta: { turn: job.turn, seed: job.campaign.seed, event: job.event, states: job.states, actorName: job.actorName, victimName: job.victimName },
  }, Out, (v) => {
    // risposta da rifare solo se nessuna frase è utilizzabile (il resto lo sistema il motore con le frasi-modello)
    const known = new Set(job.states.map((s) => s.iso));
    const usable = v.statements.filter((x) => known.has(x.iso.toUpperCase()));
    return usable.length ? [] : [`nessuna frase per gli Stati dell'elenco (${[...known].join(', ')})`];
  }, 1);
  const { statements, errors } = assembleStatements(job, r.value?.statements ?? null, facts);
  const ai = statements.filter((s) => s.source === 'ai').length;
  return {
    eventId: job.event.id, statements, source: ai === 0 ? 'template' : ai === statements.length ? 'ai' : 'mixed',
    model: ai ? r.model : 'template', errors: r.value ? errors : r.errors,
  };
}
