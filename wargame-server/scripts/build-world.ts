// Genera scenarios/_world/{nations,institutions,pairs}.json dalle sorgenti in scripts/world-src/ (stime a mano) e, se c'è rete,
// aggiorna popolazione e PIL dalla Banca Mondiale. Nel repo va l'istantanea già generata: a runtime il gioco non usa la rete.
// Uso: npm --prefix wargame-server run world:build [-- --offline] [-- --check] [-- --out <cartella>]
//   --offline  non interroga nessuna fonte (stesso output di una rete che non risponde)
//   --check    non scrive: confronta con i file su disco ed esce con 1 se sono diversi
// Non letti (di proposito): SIPRI (file Excel: servirebbe una dipendenza) e Wikidata (capitali e appartenenze sono già nelle sorgenti).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyWorldBank, buildWorld, parseWorldBank, serializeWorld, validateWorld } from './world-lib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : path.join(root, 'scenarios', '_world');
const factions: { id: string; kind: string }[] = JSON.parse(readFileSync(path.join(root, 'scenarios', 'med-2026', 'world.json'), 'utf8')).factions;

/** indicatore → ISO3 → ultimo valore disponibile (mrnev=1); `null` se la fonte non risponde */
async function worldBank(indicator: string) {
  try {
    const res = await fetch(`https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseWorldBank(await res.json());
  } catch (e) {
    console.warn(`Banca Mondiale ${indicator}: non raggiungibile (${(e as Error).message}), uso le stime delle sorgenti.`);
    return null;
  }
}

const world = buildWorld(factions);
if (!flag('offline')) {
  const [pop, gdp] = await Promise.all([worldBank('SP.POP.TOTL'), worldBank('NY.GDP.MKTP.CD')]);
  applyWorldBank(world.nations, pop ?? new Map(), gdp ?? new Map());
  console.log(`Banca Mondiale: popolazione ${pop ? pop.size : 0} paesi, PIL ${gdp ? gdp.size : 0} paesi`);
}
validateWorld(world, factions);
const files = serializeWorld(world);

if (flag('check')) {
  const diff = Object.entries(files).filter(([f, text]) => !existsSync(path.join(out, f)) || readFileSync(path.join(out, f), 'utf8') !== text).map(([f]) => f);
  if (diff.length) { console.error(`file diversi da quelli generati: ${diff.join(', ')}`); process.exit(1); }
  console.log('i file su disco coincidono con quelli generati');
} else {
  mkdirSync(out, { recursive: true });
  for (const [f, text] of Object.entries(files)) { writeFileSync(path.join(out, f), text); console.log(`${path.join(out, f)}: ${(text.length / 1024).toFixed(1)} kB`); }
  const low = world.nations.flatMap((n) => Object.entries(n.confidence).filter(([, v]) => v < 0.7).map(() => n.iso3));
  console.log(`${world.nations.length} Stati, ${world.institutions.length} istituzioni, ${world.pairs.length} righe di coppie; ${new Set(low).size} Stati con campi a confidence < 0,7`);
}
