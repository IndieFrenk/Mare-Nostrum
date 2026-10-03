import { describe, expect, it } from 'vitest';
import { runVote } from '../src/engine/institutions.js';
import { loadScenario } from '../src/engine/scenario.js';
import { worldData } from '../src/engine/world-data.js';

/**
 * Test di realismo (docs/wargame/DIPLOMAZIA.md §9): una risoluzione dell'Assemblea generale che condanna l'aggressione di un membro permanente
 * contro uno Stato europeo deve dare un esito vicino a quello di marzo 2022 (ES-11/1: 141 sì, 5 no, 35 astenuti). Se un dato del registro
 * (punto ideale, opinione) porta fuori dalla forbice si corregge il dato o il peso nel voto (PARAMS.votes), non il test.
 */
describe('calibrazione del voto dell\'Assemblea generale (marzo 2022)', () => {
  const s = loadScenario('med-2026').world;

  it('condanna di un\'aggressione russa: sì tra 120 e 160, no ≤ 15, qualunque sia il proponente occidentale', () => {
    for (const proposer of ['ITA', 'FRA', 'USA', 'GBR', 'DEU', 'GRC']) {
      const r = runVote(s, 'UNGA', { proposer, target: 'RUS', topic: 'aggression' });
      expect(r.yes.length, `${proposer}: ${r.summary}`).toBeGreaterThanOrEqual(120);
      expect(r.yes.length, `${proposer}: ${r.summary}`).toBeLessThanOrEqual(160);
      expect(r.no.length, `${proposer}: ${r.summary}`).toBeLessThanOrEqual(15);
      expect(r.passed).toBe(true);
    }
    const ref = runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' });
    console.log(`AG, condanna dell'aggressione russa (proponente ITA): ${ref.summary} — riferimento marzo 2022: 141 sì, 5 no, 35 astenuti`);
  });

  it('i no sono gli alleati della Russia e dello stesso fronte; Cina e India si astengono o votano sì, non no', () => {
    const r = runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' });
    expect(r.no).toEqual(expect.arrayContaining(['RUS', 'BLR', 'PRK']));
    expect(r.no).not.toContain('CHN'); expect(r.no).not.toContain('IND');
    expect(r.abstain).toContain('CHN');
    // i membri della NATO e dell'UE votano sì
    for (const iso of [...worldData().institution('NATO')!.members, ...worldData().institution('EU')!.members]) expect(r.yes, iso).toContain(iso);
  });

  it('una risoluzione del CdS con lo stesso testo → veto russo', () => {
    for (const proposer of ['FRA', 'GBR', 'USA']) {
      const r = runVote(s, 'UNSC', { proposer, target: 'RUS', topic: 'aggression' });
      expect(r.vetoes, proposer).toContain('RUS'); expect(r.passed, proposer).toBe(false);
    }
  });

  it('i temi cambiano l\'esito come nella realtà: l\'umanitario unisce, le sanzioni dividono', () => {
    const agg = runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'aggression' }).yes.length;
    const sanc = runVote(s, 'UNGA', { proposer: 'ITA', target: 'RUS', topic: 'sanctions' }).yes.length;
    const hum = runVote(s, 'UNGA', { proposer: 'ITA', topic: 'humanitarian' }).yes.length;
    expect(sanc).toBeLessThan(agg); expect(sanc).toBeGreaterThan(40);
    expect(hum).toBeGreaterThan(agg);
  });
});
