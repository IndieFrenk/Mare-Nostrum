import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockLLMProvider } from '../src/agents/mock-provider.js';
import { loadWorldData, worldData } from '../src/engine/world-data.js';
import { listScenarios, SCENARIOS_DIR } from '../src/engine/scenario.js';
import { HistoricPair, InstitutionsFile, NationsFile, PairsFile } from '../src/schemas/nations.js';
import { buildWorld, applyWorldBank, parseNationRow, parseWorldBank, serializeWorld, validateWorld } from '../scripts/world-lib.js';
import { buildServer } from '../src/index.js';
import { tmp } from './helpers.js';

const WORLD = path.join(SCENARIOS_DIR, '_world');
const json = (f: string) => JSON.parse(readFileSync(path.join(WORLD, f), 'utf8'));
const factions: { id: string; kind: string; leaderTitle: string; capital: string }[] = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, 'med-2026', 'world.json'), 'utf8')).factions;

describe('registro degli Stati del mondo', () => {
  const nations = NationsFile.parse(json('nations.json')).nations;
  const institutions = InstitutionsFile.parse(json('institutions.json')).institutions;
  const pairs = PairsFile.parse(json('pairs.json')).pairs;
  const isos = new Set(nations.map((n) => n.iso3));

  it('lo schema valida i tre file: 197 Stati con ISO3 unici (193 ONU + Santa Sede, Palestina, Taiwan, Kosovo)', () => {
    expect(nations).toHaveLength(197);
    expect(isos.size).toBe(197);
    expect(new Set(nations.map((n) => n.iso2)).size).toBe(197);
    for (const extra of ['VAT', 'PSE', 'TWN', 'XKX']) expect(isos.has(extra)).toBe(true);
    const unga = institutions.find((i) => i.id === 'UNGA')!;
    expect(unga.members).toHaveLength(193);
    expect(unga.observers.sort()).toEqual(['PSE', 'VAT']);
    expect(nations.filter((n) => n.region === 'Africa')).toHaveLength(54);
  });

  it('ogni membro di un\'istituzione esiste; le guide sono membri; il CdS 2026 ha i 15 membri', () => {
    for (const i of institutions) {
      for (const m of [...i.members, ...i.observers, ...Object.keys(i.terms ?? {})]) expect(isos.has(m), `${i.id}: ${m}`).toBe(true);
      for (const l of i.leaders) expect(i.members, `${i.id}: guida ${l}`).toContain(l);
    }
    const unsc = institutions.find((i) => i.id === 'UNSC')!;
    expect(unsc.members).toHaveLength(15);
    expect([...unsc.leaders].sort()).toEqual(['CHN', 'FRA', 'GBR', 'RUS', 'USA']);
    expect(Object.keys(unsc.terms!).sort()).toEqual(['BHR', 'COD', 'COL', 'DNK', 'GRC', 'LBR', 'LVA', 'PAK', 'PAN', 'SOM']);
    expect(institutions.find((i) => i.id === 'NATO')!.members).toHaveLength(32);
    expect(institutions.find((i) => i.id === 'EU')!.members).toHaveLength(27);
    expect(institutions.find((i) => i.id === 'EU')!.decision).toBe('qmv');
    expect(institutions.find((i) => i.id === 'UNSC')!.decision).toBe('unsc');
    for (const n of nations) for (const m of n.memberships) expect(institutions.some((i) => i.id === m && i.members.includes(n.iso3))).toBe(true);
  });

  it('pairs.json: almeno 60 coppie, Stati esistenti, direzionali (i due sensi presenti)', () => {
    const unordered = new Set(pairs.map(([a, b]) => [a, b].sort().join('-')));
    expect(unordered.size).toBeGreaterThanOrEqual(60);
    for (const p of pairs) { HistoricPair.parse(p); expect(isos.has(p[0]) && isos.has(p[1])).toBe(true); expect(p[0]).not.toBe(p[1]); expect(p[3]).toMatch(/[a-z]/); }
    const dir = new Map(pairs.map(([a, b, v]) => [`${a}>${b}`, v]));
    for (const [a, b] of pairs) expect(dir.has(`${b}>${a}`), `${a}-${b}`).toBe(true);
    // asimmetrie note: Beirut vede Israele peggio di quanto Israele veda Beirut
    expect(dir.get('LBN>ISR')!).toBeLessThan(dir.get('ISR>LBN')!);
    expect(dir.get('UKR>RUS')!).toBeLessThan(dir.get('RUS>UKR')!);
  });

  it('nessun leaderTitle contiene un nome di persona: solo cariche e parole istituzionali o geografiche', () => {
    const ROLES = ['Presidente', 'Re', 'Regina', 'Emiro', 'Sultano', 'Primo Ministro', 'Cancelliere', 'Capo', 'Guida', 'Principe', 'Granduca', 'Governatore generale', 'Consiglio', 'Papa', 'Capitani Reggenti'];
    // parole maiuscole ammesse oltre ai toponimi dei nomi degli Stati (istituzioni e aggettivi di nazionalità)
    const ALLOWED = new Set(['Il', 'La', 'L', 'I', 'Lo', 'Presidente', 'Re', 'Regina', 'Emiro', 'Sultano', 'Primo', 'Ministro', 'Cancelliere', 'Capo', 'Guida', 'Principe', 'Granduca', 'Governatore', 'Consiglio', 'Papa', 'Capitani', 'Reggenti',
      'Affari', 'Algerina', 'America', 'Araba', 'Bolivariana', 'Ceca', 'Chiesa', 'Cinese', 'Commonwealth', 'Confederazione', 'Cooperativa', 'Ellenica', 'Emirato', 'Federale', 'Federati', 'Federativa', 'Federazione', 'Gabonese', 'Governo',
      'Hascemita', 'Islamica', 'Italiana', 'Libanese', 'Messicani', 'Ministri', 'Nazionale', 'Nazione', 'Orientale', 'Plurinazionale', 'Popolare', 'Portoghese', 'Presidenza', 'Principato', 'Russa', 'Siriana', 'Slovacca', 'Socialista', 'Stato',
      'Togolese', 'Tunisina', 'Unione', 'Unita', 'Unità', 'Repubblica', 'Regno', 'Stati', 'Democratica', 'Unito', 'Uniti', 'Arabi', 'Emirati', 'Isole']);
    const placeWords = new Set(nations.flatMap((n) => n.nameIt.match(/[A-ZÀ-Ú][\wÀ-ÿ'’-]*/g) ?? []));
    for (const n of nations) {
      expect(ROLES.some((r) => n.leaderTitle.replace(/^(Il|La|L'|I|Lo)\s*/, '').startsWith(r)), `${n.iso3}: «${n.leaderTitle}» non inizia con una carica`).toBe(true);
      for (const w of n.leaderTitle.match(/[A-ZÀ-Ú][\wÀ-ÿ'’-]*/g) ?? []) expect(ALLOWED.has(w) || ALLOWED.has(w.replace(/^L'/, '')) || placeWords.has(w), `${n.iso3}: «${w}» in «${n.leaderTitle}» non è una parola ammessa`).toBe(true);
    }
  });

  it('ogni fazione di tipo state ha la sua nazione, con carica e capitale coerenti; LBY_LNA non ha ISO3', () => {
    const w = worldData();
    for (const f of factions.filter((x) => x.kind === 'state')) {
      const iso = w.isoOf(f.id)!;
      expect(iso, f.id).toBeDefined();
      const n = w.nation(iso)!;
      expect(n.factionId).toBe(f.id);
      expect(w.actorOf(iso)).toBe(f.id);
      expect(n.leaderTitle).toBe(f.leaderTitle);
      expect(n.capital).toBe(f.capital);
    }
    expect(w.isoOf('ALG')).toBe('DZA');
    expect(w.isoOf('LBY_GNU')).toBe('LBY');
    expect(w.isoOf('LBY_LNA')).toBeUndefined();
    expect(w.isoOf('NATO')).toBeUndefined();
    expect(w.actorOf('KEN')).toBe('KEN');
    expect(nations.filter((n) => n.factionId)).toHaveLength(factions.filter((x) => x.kind === 'state').length);
  });

  it('valori plausibili: tutti i valori stimati a mano hanno confidence < 0,7 e una fonte nella legenda', () => {
    const legend = NationsFile.parse(json('nations.json')).sourceLegend;
    for (const n of nations) {
      expect(n.alignment.west + n.alignment.china + n.alignment.russia).toBeLessThanOrEqual(1.0001);
      expect(n.topTrade.length).toBeLessThanOrEqual(5);
      for (const f of ['population', 'gdpUsdB', 'milexUsdB', 'activePersonnelK', 'alignment', 'energy', 'topTrade']) {
        expect(n.confidence[f], `${n.iso3}.${f}`).toBeLessThan(0.7);
        expect(legend[n.sources[f]!] ?? legend[n.sources[f]!.split(':')[0]!], `${n.iso3}.${f}`).toBeDefined();
      }
    }
    const sum = (k: 'population' | 'gdpUsdB' | 'milexUsdB') => nations.reduce((a, n) => a + n[k], 0);
    expect(sum('population')).toBeGreaterThan(7500); // ≈ 8 miliardi
    expect(sum('gdpUsdB')).toBeGreaterThan(100_000);
    expect(sum('milexUsdB')).toBeGreaterThan(2400);
    expect(nations.find((n) => n.iso3 === 'USA')!.alignment.west).toBe(1);
  });

  it('world-data è deterministico: due caricamenti danno gli stessi indici; il registro condiviso è lo stesso', () => {
    const a = loadWorldData(); const b = loadWorldData();
    expect(JSON.stringify(a.summaries())).toBe(JSON.stringify(b.summaries()));
    expect(a.membersOf('NATO')).toEqual(b.membersOf('NATO'));
    expect(a.membersOf('NATO')).toEqual([...a.membersOf('NATO')].sort());
    expect(a.membersOf('NESSUNA')).toEqual([]);
    expect(a.byRegion('Europe').map((n) => n.iso3)).toEqual(b.byRegion('Europe').map((n) => n.iso3));
    expect(a.nations.map((n) => n.iso3)).toEqual([...isos].sort());
    expect(a.pairValue('IND', 'PAK')!.value).toBeLessThan(0);
    expect(a.pairValue('IND', 'BRA')).toBeUndefined();
    expect(worldData()).toBe(worldData());
  });

  it('i file nel repo coincidono con quelli che world:build genera dalle sorgenti (offline)', () => {
    const w = buildWorld(factions);
    validateWorld(w, factions);
    const out = serializeWorld(w);
    for (const [f, text] of Object.entries(out)) expect(readFileSync(path.join(WORLD, f), 'utf8'), `${f} non aggiornato: npm --prefix wargame-server run world:build -- --offline`).toBe(text);
    expect(JSON.stringify(serializeWorld(buildWorld(factions)))).toBe(JSON.stringify(out));
  });

  it('world:build: una riga con colonne sbagliate o un partner inesistente è un errore', () => {
    expect(() => parseNationRow('ITA|IT|Italia', 'prova')).toThrow(/17 colonne/);
    const w = buildWorld(factions);
    w.nations.find((n) => n.iso3 === 'ITA')!.topTrade[0]!.iso3 = 'ZZZ';
    expect(() => validateWorld(w, factions)).toThrow(/partner commerciale inesistente/);
  });

  it('Banca Mondiale: la risposta dell\'API si legge e sovrascrive popolazione e PIL con fonte e confidence 0,9', () => {
    const fixture = [{ page: 1 }, [
      { countryiso3code: 'ITA', value: 58_940_425, date: '2023' }, { countryiso3code: 'KEN', value: null, date: '2023' }, { countryiso3code: '', value: 5, date: '2023' },
    ]];
    const pop = parseWorldBank(fixture);
    expect([...pop.keys()]).toEqual(['ITA']);
    expect(parseWorldBank({ message: 'errore' }).size).toBe(0);
    const w = buildWorld(factions);
    applyWorldBank(w.nations, pop, new Map([['ITA', { value: 2_372_775_000_000, date: '2023' }]]));
    const ita = w.nations.find((n) => n.iso3 === 'ITA')!;
    expect(ita.population).toBe(58.94);
    expect(ita.gdpUsdB).toBe(2372.78);
    expect(ita.sources.population).toBe('WB:SP.POP.TOTL:2023');
    expect(ita.confidence.population).toBe(0.9);
    expect(w.nations.find((n) => n.iso3 === 'KEN')!.confidence.population).toBeLessThan(0.7);
    validateWorld(w, factions);
  });

  it('le nazioni non sono nello scenario né negli snapshot, e _world non è uno scenario', () => {
    expect(listScenarios().map((s) => s.id)).toEqual(['med-2026']);
    const world = JSON.parse(readFileSync(path.join(SCENARIOS_DIR, 'med-2026', 'world.json'), 'utf8'));
    expect(world.nations).toBeUndefined();
  });
});

describe('API /nations', () => {
  it('elenco compatto e scheda completa con le istituzioni; 404 per uno Stato sconosciuto', async () => {
    const { app } = await buildServer({ dataDir: tmp(), provider: new MockLLMProvider() });
    const get = (url: string) => app.inject({ method: 'GET', url: `/api/wg${url}` });
    const list = (await get('/nations')).json();
    expect(list).toHaveLength(197);
    expect(list[0]).toHaveProperty('alignment');
    expect(list.find((n: { iso3: string }) => n.iso3 === 'KEN').factionId).toBeUndefined();
    expect(JSON.stringify(list).length).toBeLessThan(60_000);
    const ita = (await get('/nations/ITA')).json();
    expect(ita.nameIt).toBe('Italia');
    expect(ita.factionId).toBe('ITA');
    expect(ita.institutions.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(['NATO', 'EU', 'G7', 'UNGA']));
    expect(ita.pairs.some((p: { with: string }) => p.with === 'FRA')).toBe(true);
    expect(ita.sourceLegend.stima).toBeDefined();
    expect((await get('/nations/dza')).json().factionId).toBe('ALG');
    const missing = await get('/nations/ZZZ');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });
});
