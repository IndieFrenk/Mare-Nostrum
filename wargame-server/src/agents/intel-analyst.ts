import { z } from 'zod';
import type { Campaign, FactionKnowledge, IntelReport, LlmCall } from '../schemas/index.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured, numbersNotInFacts } from './repair.js';

const Out = z.object({ reports: z.array(z.object({ title: z.string(), body: z.string(), relatedContacts: z.array(z.string()).default([]) })).max(5) });
const SOURCE_GRADE: Record<string, string> = { sar: 'B', eo: 'B', radar: 'B', sonar: 'C', sigint: 'C', ais: 'C', humint: 'D', osint: 'E' };

/** Codice Admiralty: lettera dalla fonte, cifra dalla confidenza. Calcolato dal codice, non dal modello. */
export function reliability(source: string, confidence: number): IntelReport['reliability'] {
  const n = confidence >= 0.8 ? 2 : confidence >= 0.6 ? 3 : confidence >= 0.4 ? 4 : 5;
  return `${SOURCE_GRADE[source] ?? 'F'}${n}`;
}

export async function analyze(provider: LlmProvider, log: LlmCall[], c: Campaign, k: FactionKnowledge): Promise<IntelReport[]> {
  const contacts = [...k.contacts].sort((a, b) => b.confidence - a.confidence).slice(0, 12)
    .map((x) => ({ id: x.id, classification: x.classification, estFaction: x.estFaction, zoneId: x.zoneId, confidence: x.confidence, errorKm: x.errorKm, sources: x.sources }));
  if (!contacts.length) return [];
  const r = await callStructured(provider, log, { turn: k.turn }, {
    role: 'intel_analyst', ...c.config.llm.intel_analyst,
    system: template('intel', {}), user: JSON.stringify(contacts),
    schemaName: 'IntelReports', jsonSchema: z.toJSONSchema(Out) as Record<string, unknown>, meta: { contacts },
  }, Out, (o) => {
    const bad = numbersNotInFacts(JSON.stringify(o.reports.map((x) => [x.title, x.body])), [JSON.stringify(contacts)]);
    const unknown = o.reports.flatMap((x) => x.relatedContacts).filter((id) => !contacts.some((c) => c.id === id));
    return [...(bad.length ? [`numeri non presenti nei dati: ${bad.join(', ')}`] : []), ...unknown.map((u) => `contatto sconosciuto ${u}`)];
  });
  const reports = r.value?.reports ?? contacts.slice(0, 3).map((x) => ({ title: `${x.classification} in ${x.zoneId}`, body: `Traccia ${x.id} attribuita a ${x.estFaction}, errore stimato ${x.errorKm} km.`, relatedContacts: [x.id] }));
  return reports.map((rep, i) => {
    const main = contacts.find((x) => x.id === rep.relatedContacts[0]) ?? contacts[0];
    return { id: `IR-${k.turn}-${i + 1}`, turn: k.turn, source: main.sources[0], reliability: reliability(main.sources[0], main.confidence), classification: main.confidence >= 0.7 ? 'NS' : 'NR', title: rep.title, body: rep.body, relatedContacts: rep.relatedContacts, factsRef: rep.relatedContacts };
  });
}
