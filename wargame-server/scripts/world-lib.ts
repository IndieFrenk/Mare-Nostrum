import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoricPair, Institution, InstitutionsFile, Nation, NationsFile, PairsFile, type Region } from '../src/schemas/nations.js';
import { INSTITUTIONS } from './world-src/institutions-src.js';
import { expandPairs } from './world-src/pairs-src.js';

/** Logica di `npm run world:build`: funzioni pure (testate in test/world-data.test.ts), la rete sta solo in build-world.ts. */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'world-src');
export const AS_OF = '2024 (stime a mano: vedi confidence)';
export const NATION_FILES = ['nations-africa.txt', 'nations-americas.txt', 'nations-asia.txt', 'nations-europe.txt', 'nations-oceania.txt', 'nations-other.txt'];

/** sottoregione M49: [continente, nome] */
export const SUBREGIONS: Record<string, [Region, string]> = {
  'AF-N': ['Africa', 'Northern Africa'], 'AF-W': ['Africa', 'Western Africa'], 'AF-M': ['Africa', 'Middle Africa'], 'AF-E': ['Africa', 'Eastern Africa'], 'AF-S': ['Africa', 'Southern Africa'],
  'AM-N': ['Americas', 'Northern America'], 'AM-C': ['Americas', 'Central America'], 'AM-K': ['Americas', 'Caribbean'], 'AM-S': ['Americas', 'South America'],
  'AS-C': ['Asia', 'Central Asia'], 'AS-E': ['Asia', 'Eastern Asia'], 'AS-SE': ['Asia', 'South-eastern Asia'], 'AS-S': ['Asia', 'Southern Asia'], 'AS-W': ['Asia', 'Western Asia'],
  'EU-E': ['Europe', 'Eastern Europe'], 'EU-N': ['Europe', 'Northern Europe'], 'EU-S': ['Europe', 'Southern Europe'], 'EU-W': ['Europe', 'Western Europe'],
  'OC-A': ['Oceania', 'Australia and New Zealand'], 'OC-M': ['Oceania', 'Melanesia'], 'OC-MI': ['Oceania', 'Micronesia'], 'OC-P': ['Oceania', 'Polynesia'],
};
const GOV = { dem: 'democracy', hyb: 'hybrid', aut: 'authoritarian', mon: 'absolute_monarchy', the: 'theocracy', mil: 'military', tra: 'transitional' } as const;
const NUC = { n: 'none', latent: 'latent', d: 'declared', nato_sharing: 'nato_sharing' } as const;
const ROLE = { x: 'exporter', i: 'importer', m: 'mixed' } as const;

/** Fazioni «state» dello scenario → ISO3 diverso dall'id (DZA ↔ ALG, LBY ↔ LBY_GNU; LBY_LNA è non statale e non ha ISO3). */
export const FACTION_ISO: Record<string, string> = { ALG: 'DZA', LBY_GNU: 'LBY' };

/** Legenda dei codici di `sources` (scritta nell'intestazione di nations.json). */
export const SOURCE_LEGEND: Record<string, string> = {
  stima: 'Stima a mano, ordine di grandezza 2024, non verificata sulla fonte: rigenerare con rete (confidence < 0,7)',
  'stima:SIPRI': 'Stima a mano di ordine di grandezza; riferimento SIPRI Military Expenditure Database (con citazione), non scaricato',
  'stima:IISS': 'Stima a mano di ordine di grandezza; riferimento IISS Military Balance, non consultato',
  giudizio: 'Giudizio ragionato (classificazione, voto all\'Assemblea generale, forniture militari, commercio): non una misura',
  WB: 'Banca Mondiale (CC BY 4.0), formato WB:<indicatore>:<anno>',
};
const SOURCES: Record<string, string> = {
  population: 'stima', gdpUsdB: 'stima', milexUsdB: 'stima:SIPRI', activePersonnelK: 'stima:IISS', democracyScore: 'giudizio', government: 'giudizio',
  alignment: 'giudizio', unIdealPoint: 'giudizio', energy: 'stima', topTrade: 'stima',
};
/** affidabilità iniziale per campo: tutte stime a mano, quindi sotto 0,7 */
const CONF: Record<string, number> = { population: 0.65, gdpUsdB: 0.6, milexUsdB: 0.55, activePersonnelK: 0.55, democracyScore: 0.6, government: 0.7, alignment: 0.5, unIdealPoint: 0.45, energy: 0.5, topTrade: 0.45 };
/** Stati con dati notoriamente opachi o in rapido cambiamento: −0,15 su tutti i campi stimati */
const LOW = new Set(['PRK', 'ERI', 'TKM', 'SOM', 'SYR', 'YEM', 'AFG', 'MMR', 'SSD', 'LBY', 'SDN', 'VEN', 'HTI', 'PSE', 'CUB', 'BDI', 'CAF', 'TCD', 'BGD']);

const num = (s: string, what: string, where: string) => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${where}: ${what} non numerico («${s}»)`);
  return n;
};

/** Una riga di nations-*.txt → Nation (17 colonne separate da «|»). */
export function parseNationRow(line: string, where: string): { nation: Nation; unMember: boolean } {
  const f = line.split('|').map((x) => x.trim());
  if (f.length !== 17) throw new Error(`${where}: servono 17 colonne, trovate ${f.length} («${line.slice(0, 40)}…»)`);
  const [iso3, iso2, nameIt, capital, leaderTitle, sub, gov, dem, pop, gdp, milex, pers, nuc, al, ideal, en, trade] = f as [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
  const sr = SUBREGIONS[sub];
  if (!sr) throw new Error(`${where}: sottoregione sconosciuta «${sub}»`);
  if (!(gov in GOV)) throw new Error(`${where}: governo sconosciuto «${gov}»`);
  if (!(nuc in NUC)) throw new Error(`${where}: stato nucleare sconosciuto «${nuc}»`);
  const [w, c, r] = al.split('/').map((x) => num(x, 'allineamento', where) / 100) as [number, number, number];
  const [role, oil, gas] = en.split(':') as [string, string, string];
  if (!(role in ROLE)) throw new Error(`${where}: ruolo energetico sconosciuto «${role}»`);
  const topTrade = trade.split(' ').filter(Boolean).map((t) => { const [i, s] = t.split(':'); return { iso3: i!, share: num(s!, 'quota commerciale', where) / 100 }; });
  const low = LOW.has(iso3);
  const conf = (k: string) => Math.max(0.2, Math.round((CONF[k]! - (low ? 0.15 : 0)) * 100) / 100);
  const hasIdeal = ideal !== '-';
  const nation: Nation = {
    iso3, iso2, nameIt, capital, leaderTitle, region: sr[0], subregion: sr[1], government: GOV[gov as keyof typeof GOV], democracyScore: num(dem, 'democrazia', where),
    population: num(pop, 'popolazione', where), gdpUsdB: num(gdp, 'PIL', where), milexUsdB: num(milex, 'spesa militare', where), activePersonnelK: num(pers, 'militari', where),
    nuclear: NUC[nuc as keyof typeof NUC], alignment: { west: w, china: c, russia: r },
    ...(hasIdeal ? { unIdealPoint: num(ideal, 'punto ideale', where) } : {}),
    energy: { role: ROLE[role as keyof typeof ROLE], oil: num(oil, 'petrolio', where) / 10, gas: num(gas, 'gas', where) / 10 }, topTrade, memberships: [],
    sources: Object.fromEntries(Object.entries(SOURCES).filter(([k]) => k !== 'unIdealPoint' || hasIdeal)),
    confidence: Object.fromEntries(Object.keys(CONF).filter((k) => k !== 'unIdealPoint' || hasIdeal).map((k) => [k, conf(k)])),
  };
  return { nation, unMember: !where.includes('nations-other') };
}

export function parseNationFile(name: string, text = readFileSync(path.join(SRC, name), 'utf8')) {
  return text.split('\n').map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => l && !l.startsWith('#')).map(({ l, i }) => parseNationRow(l, `${name}:${i + 1}`));
}

/** Risposta dell'API Banca Mondiale `[meta, [{countryiso3code, value, date}]]` → ISO3 → { value, date } (solo valori presenti). */
export function parseWorldBank(json: unknown): Map<string, { value: number; date: string }> {
  const rows = Array.isArray(json) ? json[1] : null;
  const out = new Map<string, { value: number; date: string }>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as { countryiso3code?: string; value?: number | null; date?: string }[]) {
    if (r.countryiso3code && /^[A-Z]{3}$/.test(r.countryiso3code) && typeof r.value === 'number' && r.value > 0) out.set(r.countryiso3code, { value: r.value, date: String(r.date ?? '') });
  }
  return out;
}

/** Sovrascrive popolazione e PIL con i dati Banca Mondiale dove ci sono (fonte e affidabilità 0,9). */
export function applyWorldBank(nations: Nation[], pop: Map<string, { value: number; date: string }>, gdp: Map<string, { value: number; date: string }>) {
  for (const n of nations) {
    const p = pop.get(n.iso3); const g = gdp.get(n.iso3);
    if (p) { n.population = Math.round(p.value / 1e3) / 1e3; n.sources.population = `WB:SP.POP.TOTL:${p.date}`; n.confidence.population = 0.9; }
    if (g) { n.gdpUsdB = Math.round(g.value / 1e7) / 1e2; n.sources.gdpUsdB = `WB:NY.GDP.MKTP.CD:${g.date}`; n.confidence.gdpUsdB = 0.9; }
  }
}

export interface World { nations: Nation[]; institutions: Institution[]; pairs: HistoricPair[] }

/** Costruisce i tre file da sorgenti e fazioni dello scenario (`factions`: id e kind), con la sola logica deterministica. */
export function buildWorld(factions: { id: string; kind: string }[]): World {
  const parsed = NATION_FILES.flatMap((f) => parseNationFile(f));
  const un = new Set(parsed.filter((p) => p.unMember).map((p) => p.nation.iso3));
  const nations = parsed.map((p) => p.nation).sort((a, b) => (a.iso3 < b.iso3 ? -1 : 1));
  const institutions: Institution[] = INSTITUTIONS.map((s) => Institution.parse({
    ...s, members: s.members === '@UN' ? [...un].sort() : s.members.split(' '), observers: s.observers?.split(' ') ?? [], leaders: s.leaders?.split(' ') ?? [],
  }));
  const byIso = new Map(nations.map((n) => [n.iso3, n]));
  for (const inst of institutions) for (const m of inst.members) byIso.get(m)?.memberships.push(inst.id);
  for (const f of factions) if (f.kind === 'state') { const n = byIso.get(FACTION_ISO[f.id] ?? f.id); if (n) n.factionId = f.id; }
  return { nations, institutions, pairs: expandPairs() };
}

/** Controlli incrociati oltre allo schema: 197 Stati, riferimenti esistenti, quote commerciali plausibili. Lancia con l'elenco degli errori. */
export function validateWorld(w: World, factions: { id: string; kind: string }[] = []) {
  const errs: string[] = [];
  const isos = new Set(w.nations.map((n) => n.iso3));
  if (w.nations.length !== 197) errs.push(`servono 197 Stati, trovati ${w.nations.length}`);
  if (isos.size !== w.nations.length) errs.push('ISO3 duplicati');
  if (new Set(w.nations.map((n) => n.iso2)).size !== w.nations.length) errs.push('ISO2 duplicati');
  for (const n of w.nations) {
    for (const t of n.topTrade) { if (!isos.has(t.iso3)) errs.push(`${n.iso3}: partner commerciale inesistente ${t.iso3}`); if (t.iso3 === n.iso3) errs.push(`${n.iso3}: partner se stesso`); }
    if (n.topTrade.reduce((a, t) => a + t.share, 0) > 1) errs.push(`${n.iso3}: quote commerciali oltre il 100%`);
    for (const m of n.memberships) if (!w.institutions.some((i) => i.id === m)) errs.push(`${n.iso3}: istituzione inesistente ${m}`);
    for (const [k, code] of Object.entries(n.sources)) if (!(code in SOURCE_LEGEND) && !(code.split(':')[0]! in SOURCE_LEGEND)) errs.push(`${n.iso3}: la fonte «${code}» di ${k} non è nella legenda`);
  }
  for (const i of w.institutions) {
    for (const m of [...i.members, ...i.observers, ...i.leaders, ...Object.keys(i.terms ?? {})]) if (!isos.has(m)) errs.push(`${i.id}: Stato inesistente ${m}`);
    for (const l of i.leaders) if (!i.members.includes(l)) errs.push(`${i.id}: la guida ${l} non è membro`);
  }
  const unsc = w.institutions.find((i) => i.id === 'UNSC');
  if (unsc?.members.length !== 15) errs.push('il CdS deve avere 15 membri');
  if (w.institutions.find((i) => i.id === 'UNGA')?.members.length !== 193) errs.push('l\'Assemblea generale deve avere 193 membri');
  for (const [a, b] of w.pairs) { if (!isos.has(a) || !isos.has(b)) errs.push(`coppia con Stato inesistente: ${a}-${b}`); if (a === b) errs.push(`coppia con se stesso: ${a}`); }
  for (const f of factions) if (f.kind === 'state' && !w.nations.some((n) => n.factionId === f.id)) errs.push(`la fazione ${f.id} non ha una nazione`);
  if (errs.length) throw new Error(`dati del mondo non validi:\n- ${errs.join('\n- ')}`);
  NationsFile.parse({ schemaVersion: 1, asOf: AS_OF, sourceLegend: SOURCE_LEGEND, nations: w.nations });
  InstitutionsFile.parse({ schemaVersion: 1, asOf: AS_OF, institutions: w.institutions });
  PairsFile.parse({ schemaVersion: 1, pairs: w.pairs });
}

/** Una riga per elemento: diff leggibili e dimensione contenuta. Output deterministico (nessuna data, ordine fisso). */
export function serializeWorld(w: World): { 'nations.json': string; 'institutions.json': string; 'pairs.json': string } {
  const lines = (head: string, key: string, items: unknown[]) => `{\n${head},\n "${key}": [\n${items.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n ]\n}\n`;
  return {
    'nations.json': lines(` "schemaVersion": 1,\n "asOf": ${JSON.stringify(AS_OF)},\n "sourceLegend": ${JSON.stringify(SOURCE_LEGEND)}`, 'nations', w.nations),
    'institutions.json': lines(` "schemaVersion": 1,\n "asOf": ${JSON.stringify(AS_OF)}`, 'institutions', w.institutions),
    'pairs.json': lines(' "schemaVersion": 1', 'pairs', w.pairs),
  };
}
