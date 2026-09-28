import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/agents/llm-client.js';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { templateLetter } from '../src/agents/letter-writer.js';
import { runSim } from '../src/cli/sim.js';
import { salutation } from '../src/engine/diplomacy.js';
import { buildLexicon, recognize } from '../src/engine/names.js';
import { SCENARIOS_DIR, loadScenario } from '../src/engine/scenario.js';
import { makeEngine } from './helpers.js';

const NEW = ['ESP', 'MAR', 'MLT', 'CYP', 'LBN', 'SYR', 'JOR', 'SAU', 'ARE', 'QAT', 'DEU'];
/** paesi senza peso navale o aereo nel Mediterraneo: nessuna unità */
const NO_UNITS = ['CYP', 'LBN', 'SYR', 'JOR'];
const sc = loadScenario('med-2026');

describe('nuovi paesi', () => {
  it('stati «scripted» con profilo, carica, capitale, relazioni e scheda; unità solo dove pesano, nelle proprie basi', () => {
    for (const id of NEW) {
      const f = sc.world.factions[id]!;
      expect(f, id).toBeDefined();
      expect(f).toMatchObject({ kind: 'state', controller: 'scripted' });
      expect(f.policy, id).toBeDefined();
      expect(f.leaderTitle && f.capital, id).toBeTruthy();
      expect(existsSync(path.join(SCENARIOS_DIR, 'med-2026', f.profileRef)), id).toBe(true);
      const units = Object.values(sc.world.units).filter((u) => u.factionId === id);
      if (NO_UNITS.includes(id)) expect(units, id).toEqual([]);
      else {
        expect(units.length, id).toBeGreaterThan(0);
        expect(units.length, id).toBeLessThanOrEqual(4);
      }
      for (const u of units) expect(sc.world.bases[u.homeBaseId]?.factionId, u.id).toBe(id);
      // almeno una relazione diversa dal valore predefinito con un attore del gioco
      expect(Object.values(sc.world.relations[id]!).some((r) => r.trust !== 0 || r.tension !== 20), id).toBe(true);
    }
    // Spagna e Germania nella NATO, i membri UE nella clausola di mutua assistenza
    expect(sc.world.agreements['AG-NATO']!.parties).toEqual(expect.arrayContaining(['ESP', 'DEU']));
    expect(sc.world.agreements['AG-EU']!.parties).toEqual(expect.arrayContaining(['ESP', 'DEU', 'MLT', 'CYP']));
  });

  it('i capi si indicano solo con la carica: niente nomi di persona nelle fazioni', () => {
    expect(sc.world.factions.LBY_LNA!.name).toBe('Libia (LNA, Bengasi)');
    for (const f of Object.values(sc.world.factions)) expect(`${f.name} ${f.leaderTitle}`, f.id).not.toMatch(/Haftar/);
  });

  it('in modalità llm i paesi aggiunti decidono comunque a regole (non allungano il turno)', async () => {
    const asked = new Set<string>();
    class P extends MockLLMProvider { override async complete(r: LlmRequest) { if (String(r.role).startsWith('faction')) asked.add(String(r.meta.factionId)); return super.complete(r); } }
    const e = makeEngine(new P());
    const r = await runSim(e, await e.createCampaign({ scenarioId: 'med-2026', name: 'llm', seed: 'paesi-llm', config: { factionMode: 'llm' } }), 1);
    for (const id of NEW) {
      expect(asked.has(id), id).toBe(false);
      expect((await e.store.getDecision(r.campaign.id, 1, id))!.model, id).toBe('regole');
    }
    expect(asked.has('TUR')).toBe(true);
    expect((await e.store.getDecision(r.campaign.id, 1, 'TUR'))!.model).toBe('mock');
  }, 30_000);

  it('nomi italiani nella Console Ordini e apertura delle lettere con il titolo d\'uso', () => {
    const lex = buildLexicon([], sc);
    expect(recognize('Chiedi alla Spagna e agli Emirati di collaborare', lex).hits.map((h) => h.id)).toEqual(['ESP', 'ARE']);
    expect(recognize('Pattuglia le acque di Cipro e rassicura Cipro', lex).hits.map((h) => h.id)).toEqual(['MEDITERRANEO_ORIENTALE', 'CYP']);
    // alias delle unità da names.json per chi le possiede
    const lexEsp = buildLexicon(Object.values(sc.world.units).filter((u) => u.factionId === 'ESP'), sc);
    expect(recognize('Manda la Juan Carlos I nel Mediterraneo occidentale', lexEsp).hits.map((h) => h.id)).toEqual(['ESP-L61', 'MED_OCCIDENTALE']);
    expect(salutation('Il Presidente della Repubblica di Turchia')).toBe('Signor Presidente');
    expect(salutation('Il Re del Marocco')).toBe('Maestà');
    expect(salutation("L'Emiro del Qatar")).toBe('Altezza');
    expect(salutation('Il Cancelliere della Repubblica Federale di Germania')).toBe('Signor Cancelliere');
    expect(templateLetter({ toTitle: "L'Emiro del Qatar" }).body.startsWith('Altezza,')).toBe(true);
  });
});
