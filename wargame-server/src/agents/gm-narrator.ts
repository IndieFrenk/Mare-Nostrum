import { z } from 'zod';
import { BRIEFING_HEADINGS, type Campaign, type GameEvent, type LlmCall, type NarrativeDoc, type NewsItem, type TurnNarrative } from '../schemas/index.js';
import type { Fact } from '../engine/facts.js';
import type { LlmProvider } from './llm-client.js';
import { template } from './prompts.js';
import { callStructured, numbersNotInFacts } from './repair.js';

const Doc = z.object({ title: z.string(), sections: z.array(z.object({ heading: z.string(), body: z.string() })), factsRef: z.array(z.string()).default([]) });
const NewsOut = z.object({ news: z.array(z.object({ outlet: z.string(), headline: z.string(), body: z.string(), eventIds: z.array(z.string()).default([]) })) });
export const OUTLETS: Record<string, { faction: string; bias: number }> = {
  ANSA: { faction: 'ITA', bias: 0 }, 'Le Monde': { faction: 'FRA', bias: 0.1 }, CNN: { faction: 'USA', bias: 0.2 }, TRT: { faction: 'TUR', bias: -0.4 },
  RT: { faction: 'RUS', bias: -0.8 }, Xinhua: { faction: 'CHN', bias: -0.5 }, 'Al-Ahram': { faction: 'EGY', bias: -0.2 }, 'Al Jazeera': { faction: 'QAT', bias: -0.1 },
};

function fallbackDoc(title: string, facts: Fact[], headings: readonly string[]): NarrativeDoc {
  return { title, sections: headings.map((h) => ({ heading: h, body: facts.filter((f) => f.heading === h).map((f) => f.text).join(' ') || 'Nessuna variazione rilevante.' })), factsRef: facts.map((f) => f.id) };
}

async function narrate(provider: LlmProvider, log: LlmCall[], c: Campaign, turn: number, doc: string, title: string, facts: Fact[], headings: readonly string[]) {
  const texts = facts.map((f) => f.text);
  const r = await callStructured(provider, log, { turn }, {
    role: 'gm_narrator', ...c.config.llm.gm_narrator,
    system: template('narrator', { doc, headings: headings.join(', ') }), user: template('narrator-user', { facts: facts.map((f) => `[${f.id}] (${f.heading}) ${f.text}`).join('\n') }),
    schemaName: 'Narrative', jsonSchema: z.toJSONSchema(Doc) as Record<string, unknown>, meta: { kind: doc, facts, headings, title },
  }, Doc, (d) => {
    const bad = numbersNotInFacts(JSON.stringify([d.title, d.sections]), texts);
    return [...(bad.length ? [`numeri non presenti nei fatti: ${bad.join(', ')}`] : []), ...d.sections.filter((s) => !headings.includes(s.heading)).map((s) => `intestazione non ammessa: ${s.heading}`)];
  });
  return r.value ?? fallbackDoc(title, facts, headings);
}

export async function writeBriefing(provider: LlmProvider, log: LlmCall[], c: Campaign, turn: number, facts: Fact[]): Promise<TurnNarrative['briefing']> {
  const d = await narrate(provider, log, c, turn, 'il briefing di situazione', 'Briefing di situazione', facts, BRIEFING_HEADINGS);
  return { ...d, sections: BRIEFING_HEADINGS.map((h) => ({ heading: h, body: d.sections.find((s) => s.heading === h)?.body ?? '' })) };
}

export const DEBRIEF_HEADINGS = ['Operazioni', 'Economia', 'Diplomazia e crisi', 'Usura e perdite'] as const;
export const writeDebriefing = (provider: LlmProvider, log: LlmCall[], c: Campaign, turn: number, facts: Fact[]) =>
  narrate(provider, log, c, turn, 'il debriefing di fine turno', 'Debriefing', facts, DEBRIEF_HEADINGS);

export async function writeNews(provider: LlmProvider, log: LlmCall[], c: Campaign, turn: number, events: GameEvent[]): Promise<NewsItem[]> {
  const items = events.filter((e) => ['RANDOM_EVENT', 'ENGAGEMENT_OPENED', 'STATEMENT', 'CRISIS_CHANGED', 'INFRA_STATUS', 'CYBER_EFFECT', 'SOF_RESULT'].includes(e.type)).slice(0, 25)
    .map((e) => ({ id: e.id, type: e.type, actor: e.actor, text: JSON.stringify(e.payload).slice(0, 300) }));
  if (!items.length) return [];
  const r = await callStructured(provider, log, { turn }, {
    role: 'gm_narrator', ...c.config.llm.gm_narrator,
    system: template('news', { outlets: Object.keys(OUTLETS).join(', ') }), user: JSON.stringify(items),
    schemaName: 'News', jsonSchema: z.toJSONSchema(NewsOut) as Record<string, unknown>, meta: { kind: 'news', events: items },
  }, NewsOut, (o) => { const bad = numbersNotInFacts(JSON.stringify(o), items.map((i) => i.text + ' ' + i.id)); return bad.length ? [`numeri non presenti negli eventi: ${bad.join(', ')}`] : []; });
  return (r.value?.news ?? []).map((n, idx) => {
    const o = OUTLETS[n.outlet] ?? OUTLETS.ANSA;
    return { id: `N${turn}-${idx + 1}`, turn, outlet: OUTLETS[n.outlet] ? n.outlet : 'ANSA', outletFaction: o.faction, bias: o.bias, headline: n.headline, body: n.body, factsRef: n.eventIds };
  });
}
