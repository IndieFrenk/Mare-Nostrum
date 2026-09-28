import { z } from 'zod';
import { LETTER_LIMITS, LetterTone, type AgentMemory, type FactionKnowledge, type LlmCall } from '../schemas/index.js';
import { roleConfig, type LetterJob, type LetterResult } from '../engine/turn-machine.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured, numbersNotInFacts } from './repair.js';

/** Uscita del ruolo diplomat: solo testo e tono; destinatario, visibilità ed effetti li decide il motore. */
export const LetterOut = z.object({
  subject: z.string().min(1).max(LETTER_LIMITS.subject),
  body: z.string().min(1).max(LETTER_LIMITS.body),
  tone: LetterTone,
});
// maxLength resta nello schema inviato al modello (keepLengths): con Ollama/llama.cpp la grammatica ferma i testi troppo lunghi
const LETTER_SCHEMA = z.toJSONSchema(LetterOut, { io: 'input' }) as Record<string, unknown>;

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
/** «2026-03-09» → «9 marzo 2026» */
export function italianDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Situazione compatta del mittente (solo la sua Knowledge): è anche l'elenco dei numeri che la lettera può citare. */
export function letterSituation(k: FactionKnowledge, to: string) {
  return JSON.stringify({
    crisi: k.knownCrises.map((c) => ({ titolo: c.title, escalation: c.escalation, attori: c.involved })),
    accordiCon: k.knownAgreements.filter((a) => a.parties.includes(to)).map((a) => ({ tipo: a.type, stato: a.status, termini: a.terms })),
    stimaDelDestinatario: k.beliefs[to] ? { intento: k.beliefs[to].estIntent } : null,
    lettereRecenti: k.letters.filter((l) => l.from === to || l.to === to).slice(-3).map((l) => ({ da: l.from, oggetto: l.subject, tono: l.tone })),
  });
}

const memoryFor = (m: AgentMemory | null, to: string) => m ? JSON.stringify({
  nota: m.relationshipNotes[to] ?? null,
  impegni: m.commitments.filter((c) => c.to === to).slice(-3).map((c) => c.promise),
  torti: m.grievances.filter((g) => g.against === to).slice(-3).map((g) => g.text),
  riassunto: m.rollingSummary.slice(-600),
}) : 'nessuna';

const profileShort = (p: string) => p.split('\n').filter((l) => /^(Interessi|Dottrina|Linee rosse|Stile):/.test(l)).join('\n') || p.slice(0, 600);

/** «Risposta: …» senza raddoppiare il prefisso nelle catene di risposte. */
export const replySubject = (subject: string) => `Risposta: ${subject.replace(/^(Risposta:\s*)+/i, '')}`.slice(0, LETTER_LIMITS.subject);

/** Lettera-modello breve e cortese, senza numeri: usata se il modello fallisce o inventa numeri. */
export function templateLetter(job: Pick<LetterJob, 'toTitle' | 'replyTo'>): { subject: string; body: string; tone: 'formal' } {
  // «Il Presidente della Repubblica di Turchia» → «Signor Presidente»
  const salutation = `Signor ${job.toTitle.replace(/^(Il|La) /, '').split(/ (?:del|della|dell'|degli|dei) ?/)[0]}`;
  const body = job.replyTo
    ? `${salutation},\nho ricevuto la Sua lettera e La ringrazio per averla voluta indirizzare direttamente a me. Il mio Governo ne sta esaminando i contenuti con la massima attenzione e resta disponibile a proseguire il dialogo per le vie diplomatiche.\nVoglia accogliere i sensi della mia più alta considerazione.`
    : `${salutation},\ndesidero confermarLe la disponibilità del mio Governo a mantenere aperto un canale di dialogo diretto sulle questioni di comune interesse nel Mediterraneo.\nVoglia accogliere i sensi della mia più alta considerazione.`;
  const subject = job.replyTo ? replySubject(job.replyTo.subject) : 'Dialogo sulle questioni di comune interesse';
  return { subject, body, tone: 'formal' };
}

/** Una lettera per chiamata (modelli piccoli): 1 repair, poi la lettera-modello. */
export async function writeLetter(provider: LlmProvider, log: LlmCall[], job: LetterJob): Promise<LetterResult> {
  const k = job.knowledge;
  const situation = letterSituation(k, job.to);
  const replyTo = job.replyTo ? `da ${job.replyTo.fromTitle}, oggetto "${job.replyTo.subject}", tono ${job.replyTo.tone}:\n${job.replyTo.body}` : 'nessuna';
  // numeri ammessi: la situazione del mittente, la lettera ricevuta, la data; per le bozze del giocatore anche la sua traccia
  const facts = [situation, replyTo, job.date, italianDate(job.date), ...(job.kind === 'draft' && job.gist ? [job.gist] : [])];
  const r = await callStructured(provider, log, { turn: k.turn, factionId: job.factionId }, {
    role: 'diplomat', ...roleConfig(job.campaign, 'diplomat'),
    system: template('letter', { fromTitle: job.fromTitle, factionName: k.ownFaction.name, toTitle: job.toTitle, profile: profileShort(job.profile) }),
    user: template('letter-user', {
      date: italianDate(job.date), toTitle: job.toTitle, to: job.to,
      relation: job.relation ? `fiducia ${job.relation.trust}, tensione ${job.relation.tension}` : 'non nota',
      memory: memoryFor(job.memory, job.to), intent: job.intent || 'non specificato', replyTo, gist: job.gist || 'a tua scelta, coerente con l\'intento', tone: job.tone ?? 'a tua scelta', situation,
    }),
    schemaName: 'Letter', jsonSchema: LETTER_SCHEMA, keepLengths: true,
    meta: { kind: job.kind, factionId: job.factionId, to: job.to, turn: k.turn, seed: job.campaign.seed, fromTitle: job.fromTitle, toTitle: job.toTitle, replySubject: job.replyTo?.subject, gist: job.gist, tone: job.tone },
  }, LetterOut, (v) => {
    const bad = numbersNotInFacts(`${v.subject}\n${v.body}`, facts);
    return bad.length ? [`numeri non presenti nella situazione del mittente: ${bad.join(', ')}`] : [];
  }, 1);
  if (!r.value) return { ...templateLetter(job), source: 'template', model: 'template', errors: r.errors };
  // il tono richiesto (intento della fazione o scelta del giocatore) prevale: è quello che il motore applica
  return { subject: r.value.subject.trim(), body: r.value.body.trim(), tone: job.tone ?? r.value.tone, source: 'ai', model: r.model, errors: [] };
}
