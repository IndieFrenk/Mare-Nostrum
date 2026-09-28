import { describe, expect, it } from 'vitest';
import type { GameEvent, LlmCall } from '../src/schemas/index.js';
import type { LlmProvider, LlmRequest } from '../src/agents/llm-client.js';
import { writeNews } from '../src/agents/gm-narrator.js';
import { numbersNotInFacts } from '../src/agents/repair.js';
import { makeEngine } from './helpers.js';

/** Modello finto: risponde sempre con lo stesso testo e conta le chiamate. */
const fixed = (payload: unknown): LlmProvider & { calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return { name: 'finto', calls, async complete(req) { calls.push(req); return { text: JSON.stringify(payload), usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 0, model: 'finto' }; } };
};

describe('notizie: un numero inventato non cancella tutto il turno', () => {
  const ev = (seq: number, type: GameEvent['type'], payload: Record<string, unknown>): GameEvent =>
    ({ id: `E4-${seq}`, turn: 4, seq, phase: 'DEBRIEF', type, actor: 'world', targets: [], payload, visibility: 'public', causedBy: null });
  const events = [ev(12, 'CRISIS_CHANGED', { crisisId: 'RED_SEA', delta: 1, cause: 'attacco a un mercantile' }), ev(15, 'RANDOM_EVENT', { eventId: 'X', text: 'Sbarchi a Lampedusa', zoneId: 'CANALE_SICILIA' })];

  it('5 notizie di cui una con un numero inventato → ne restano 4, senza repair, e lo scarto è nel registro', async () => {
    const news = [
      { outlet: 'ANSA', headline: 'Mar Rosso, sale la tensione', body: 'Nuovo attacco a un mercantile (E4-12).', eventIds: ['E4-12'] },
      { outlet: 'TRT', headline: 'Sbarchi a Lampedusa', body: 'Arrivati 438 migranti in una notte.', eventIds: ['E4-15'] },
      { outlet: 'RT', headline: 'Crisi nel Mar Rosso', body: 'La crisi sale di 1 livello.', eventIds: ['E4-12'] },
      { outlet: 'CNN', headline: 'Lampedusa', body: 'Sbarchi nel Canale di Sicilia.', eventIds: ['E4-15'] },
      { outlet: 'Xinhua', headline: 'Mediterraneo', body: 'Rotte sotto pressione, riferimento E4-99.', eventIds: [] },
    ];
    const p = fixed({ news });
    const log: LlmCall[] = [];
    const c = { config: { llm: { gm_narrator: { model: 'finto', temperature: 0, maxTokens: 100, timeoutMs: 1000 } } } } as never;
    const out = await writeNews(p, log, c, 4, events);
    expect(out).toHaveLength(4);
    expect(out.map((n) => n.headline)).not.toContain('Sbarchi a Lampedusa');
    expect(out.map((n) => n.id)).toEqual(['N4-1', 'N4-2', 'N4-3', 'N4-4']);
    expect(p.calls).toHaveLength(1);
    expect(log[0]).toMatchObject({ ok: true });
    expect(log[0]!.error).toContain('438');
  });

  it('se tutte le notizie hanno numeri inventati si chiede il repair', async () => {
    const p = fixed({ news: [{ outlet: 'ANSA', headline: 'Sbarchi', body: 'Arrivati 438 migranti.', eventIds: [] }] });
    const log: LlmCall[] = [];
    const c = { config: { llm: { gm_narrator: { model: 'finto', temperature: 0, maxTokens: 100, timeoutMs: 1000 } } } } as never;
    expect(await writeNews(p, log, c, 4, events)).toEqual([]);
    expect(p.calls.length).toBe(3);
    expect(log.every((l) => !l.ok)).toBe(true);
  });

  it('gli id degli eventi citati nel testo non contano come numeri', () => {
    expect(numbersNotInFacts('Vedi E4-12 ed E4-99.', ['nessun numero'])).toEqual([]);
    expect(numbersNotInFacts('Arrivati 438 migranti (E4-12)', ['{"delta":1}'])).toEqual(['438']);
  });

  it('con il mock il turno ha le sue notizie', async () => {
    const e = makeEngine();
    const c = await e.createCampaign({ scenarioId: 'med-2026', name: 'n', seed: 'notizie' });
    await e.advance(c.id);
    expect((await e.store.getNarrative(c.id, 1))!.news.length).toBeGreaterThan(0);
  }, 30_000);
});
