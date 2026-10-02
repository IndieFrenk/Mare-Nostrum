import { describe, expect, it } from 'vitest';
import { baseOpinion, opinionBand } from '../src/engine/opinion.js';
import { worldData } from '../src/engine/world-data.js';

/**
 * Plausibilità della base dell'opinione (docs/wargame/DIPLOMAZIA.md §13): 40 coppie di riferimento con il segno atteso, la
 * correlazione con la somiglianza del voto ONU e la forma della distribuzione. Se un dato del registro le contraddice si corregge il
 * dato (con la fonte), non il test. Gli id sono quelli degli attori: l'id della fazione per i paesi dello scenario (ALG, LBY_GNU), l'ISO3 per gli altri.
 */
const REFS: [string, string, '>' | '<', number][] = [
  // le coppie del documento di progetto
  ['USA', 'ISR', '>', 40], ['IRN', 'ISR', '<', -60], ['IND', 'PAK', '<', -30], ['FRA', 'DEU', '>', 40], ['GRC', 'TUR', '<', 0],
  ['KOR', 'PRK', '<', -40], ['CHN', 'RUS', '>', 20], ['MAR', 'ALG', '<', -20],
  // guerre e rivalità, nei due sensi dove l'asimmetria è nota
  ['UKR', 'RUS', '<', -60], ['RUS', 'UKR', '<', -40], ['ISR', 'IRN', '<', -60], ['PAK', 'IND', '<', -30], ['PRK', 'KOR', '<', -50],
  ['ARM', 'AZE', '<', -30], ['AZE', 'ARM', '<', -30], ['CHN', 'TWN', '<', -30], ['TWN', 'CHN', '<', -30], ['JPN', 'CHN', '<', -15],
  ['PHL', 'CHN', '<', -15], ['IND', 'CHN', '<', -10], ['SAU', 'IRN', '<', -10], ['TUR', 'ISR', '<', -20],
  ['ISR', 'TUR', '<', -10], ['POL', 'RUS', '<', -40], ['DEU', 'RUS', '<', -20], ['ITA', 'RUS', '<', -10],
  ['USA', 'CHN', '<', -20], ['CHN', 'USA', '<', -20], ['USA', 'IRN', '<', -50], ['IRN', 'USA', '<', -50],
  // amicizie e alleanze
  ['USA', 'GBR', '>', 40], ['GBR', 'USA', '>', 40], ['DEU', 'FRA', '>', 40], ['ITA', 'FRA', '>', 30], ['ITA', 'DEU', '>', 30],
  ['ITA', 'USA', '>', 30], ['TUR', 'AZE', '>', 30], ['USA', 'TWN', '>', 20], ['PAK', 'CHN', '>', 30], ['NOR', 'SWE', '>', 30],
];

describe('plausibilità della base dell\'opinione', () => {
  it('40 coppie di riferimento hanno il segno atteso', () => {
    expect(REFS).toHaveLength(40);
    for (const [a, b, op, v] of REFS) {
      const x = baseOpinion(a, b).value;
      expect(op === '>' ? x > v : x < v, `${a}→${b} = ${x} (atteso ${op} ${v}): ${baseOpinion(a, b).reasons.map((r) => `${r.label} ${r.value}`).join('; ')}`).toBe(true);
    }
  });

  it('ogni valore ha i suoi motivi e la somma dei motivi è il valore', () => {
    for (const [a, b] of REFS) {
      const r = baseOpinion(a, b);
      expect(r.reasons.length, `${a}→${b}`).toBeGreaterThan(0);
      expect(Math.round(r.reasons.reduce((n, x) => n + x.value, 0) * 10) / 10).toBe(r.value);
      for (const x of r.reasons) expect(x.label.length).toBeGreaterThan(3);
    }
    // le inimicizie e le alleanze si spiegano: la storia della coppia e l'alleanza compaiono tra i motivi
    expect(baseOpinion('IND', 'PAK').reasons.some((x) => x.label.includes('Kashmir'))).toBe(true);
    expect(baseOpinion('FRA', 'DEU').reasons.some((x) => x.label.startsWith('Alleanza difensiva') && x.label.includes('NATO'))).toBe(true);
    expect(baseOpinion('FRA', 'DEU').reasons.some((x) => x.label.startsWith('Stessa unione'))).toBe(true);
    expect(baseOpinion('ITA', 'RUS').reasons.some((x) => x.label.startsWith('Blocchi contrapposti'))).toBe(true); // NATO contro CSTO
  });

  it('asimmetria dei dati: la dipendenza commerciale conta per chi dipende', () => {
    // il Kenya ha la Cina tra i primi partner (15%), la Cina non ha il Kenya tra i suoi
    const kc = baseOpinion('KEN', 'CHN'); const ck = baseOpinion('CHN', 'KEN');
    expect(kc.reasons.some((x) => x.label === 'Dipendenza commerciale')).toBe(true);
    expect(ck.reasons.some((x) => x.label === 'Dipendenza commerciale')).toBe(false);
    // coppie storiche asimmetriche
    expect(baseOpinion('LBN', 'ISR').value).toBeLessThan(baseOpinion('ISR', 'LBN').value);
  });

  it('distribuzione sulle 38.612 coppie: media vicina a zero, quasi nessuna saturazione, correlazione col voto ONU ≥ 0,5', () => {
    const w = worldData();
    const vals: number[] = []; const x: number[] = []; const y: number[] = [];
    for (const a of w.nations) for (const b of w.nations) {
      if (a.iso3 === b.iso3) continue;
      const v = baseOpinion(w.actorOf(a.iso3), w.actorOf(b.iso3)).value;
      vals.push(v);
      if (a.unIdealPoint !== undefined && b.unIdealPoint !== undefined) { x.push(v); y.push(-Math.abs(a.unIdealPoint - b.unIdealPoint)); }
    }
    expect(vals).toHaveLength(197 * 196);
    const mean = vals.reduce((p, q) => p + q, 0) / vals.length;
    expect(mean).toBeGreaterThan(-5); expect(mean).toBeLessThan(8);
    expect(vals.filter((v) => Math.abs(v) >= 100).length / vals.length).toBeLessThan(0.002);
    const mx = x.reduce((p, q) => p + q, 0) / x.length; const my = y.reduce((p, q) => p + q, 0) / y.length;
    let cov = 0; let vx = 0; let vy = 0;
    x.forEach((v, i) => { cov += (v - mx) * (y[i]! - my); vx += (v - mx) ** 2; vy += (y[i]! - my) ** 2; });
    const corr = cov / Math.sqrt(vx * vy);
    expect(corr).toBeGreaterThanOrEqual(0.5);
    console.log(`correlazione base ↔ somiglianza di unIdealPoint: ${corr.toFixed(2)} (${x.length} coppie); media ${mean.toFixed(1)}`);
  });

  it('gli attori senza ISO3 (blocchi, LNA) e gli sconosciuti valgono 0; la base è in cache e deterministica', () => {
    expect(baseOpinion('NATO', 'ITA')).toEqual({ value: 0, reasons: [] });
    expect(baseOpinion('LBY_LNA', 'TUR').value).toBe(0);
    expect(baseOpinion('ITA', 'ITA').value).toBe(0);
    expect(baseOpinion('ITA', 'FRA')).toBe(baseOpinion('ITA', 'FRA'));
  });

  it('le fasce con cui si vede l\'opinione degli altri', () => {
    expect([-80, -50.1, -49.9, -15.1, -14.9, 0, 14.9, 15, 49.9, 50, 100].map(opinionBand)).toEqual(['ostile', 'ostile', 'fredda', 'fredda', 'neutra', 'neutra', 'neutra', 'cordiale', 'cordiale', 'stretta', 'stretta']);
  });
});
