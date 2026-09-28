// Banco di prova dei modelli per il wargame: rimanda richieste VERE (dal log LLM del turno 1 di una campagna) a ciascun
// modello e controlla la risposta con gli schemi Zod del gioco, col prompt attuale della fazione.
// Uso: npm run bench:models -- <cartella-campagna> <modello|combo>...   (config OmniRoute da wargame-server/.env)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import '../config.js';
import { AgentMemory, DecisionOutput, type LlmCall } from '../schemas/index.js';
import { extractJson, OpenAiCompatProvider } from '../agents/llm-client.js';
import { template } from '../agents/prompts.js';

const [dir, ...models] = process.argv.slice(2);
if (!dir || !models.length) { console.error('uso: bench:models -- <cartella-campagna> <modello>...'); process.exit(2); }
const calls = readFileSync(path.join(dir, 'llm-log/turn-0001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LlmCall);
const pick = (role: string) => {
  const c = calls.find((x) => x.role === role && x.factionId);
  if (!c) throw new Error(`nessuna chiamata ${role} nel log`);
  return { factionId: c.factionId!, ...(c.request as { system: string; user: string }) };
};
const major = pick('faction_major');
const refl = pick('reflection');
const newFormat = readFileSync(new URL('../agents/prompts/faction.md', import.meta.url), 'utf8').split('FORMATO')[1];
const ReflOut = AgentMemory.omit({ schemaVersion: true, factionId: true, updatedTurn: true }).extend({ lessons: z.array(z.string()) });
const tests: { nome: string; system: string; user: string; schema: ZodType; maxTokens: number }[] = [
  { nome: 'fazione', system: `${major.system.split('FORMATO')[0]}FORMATO${newFormat}`, user: major.user, schema: DecisionOutput, maxTokens: 3000 },
  { nome: 'riflessione', system: template('reflection', { factionId: refl.factionId }), user: refl.user, schema: ReflOut, maxTokens: 2000 },
];
const p = new OpenAiCompatProvider();
for (const model of models) {
  for (const t of tests) {
    const t0 = Date.now();
    const secs = () => String(Math.round((Date.now() - t0) / 1000)).padStart(4);
    try {
      const r = await p.complete({ role: 'faction_major', model, temperature: 0.4, maxTokens: t.maxTokens, timeoutMs: 150_000, system: t.system, user: t.user, schemaName: 'Bench', jsonSchema: z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>, meta: {} });
      let esito = 'OK';
      try {
        const v = t.schema.safeParse(extractJson(r.text));
        if (!v.success) esito = `${v.error.issues.length} errori: ${v.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' | ')}`;
      } catch { esito = `NO JSON: ${r.text.slice(0, 80).replace(/\n/g, ' ')}`; }
      console.log(`${model.padEnd(48)} ${t.nome.padEnd(12)} ${secs()}s  in ${r.usage.promptTokens} out ${r.usage.completionTokens}  ${esito.slice(0, 220)}`);
    } catch (e) {
      console.log(`${model.padEnd(48)} ${t.nome.padEnd(12)} ${secs()}s  ERRORE ${String((e as Error).message).slice(0, 160)}`);
    }
  }
}
