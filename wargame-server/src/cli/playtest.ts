// Partita automatica attraverso l'API HTTP, come farebbe la UI: N turni con ordini del giocatore (pattuglie, diplomazia,
// acquisti, dichiarazioni, una lettera ogni 2 turni a TUR/LBY_GNU/EGY), ingaggi CMO risolti in automatico, controlli di coerenza
// e statistiche degli agenti (anche lettere: inviate, ricevute, risposte arrivate, iniziative IA e quante dagli inneschi del motore,
// lettere-modello; ordini IA
// alle unità, quanti dalle posture per zona, ingaggi del turno; unità IA impegnate in un compito; posture emesse/tradotte/senza unità).
// Per turno anche: tempo, chiamate LLM per ruolo (dal registro llm-log della campagna, se il server scrive nello stesso
// WARGAME_DATA_DIR), decisioni a regole e loro motivazioni più frequenti.
// Uso: npm run playtest -- --turns 10 [--base http://127.0.0.1:8787] [--name playtest] [--minor-every 2 --reflect-every 3]
// Report: stampa a video e JSON in <WARGAME_DATA_DIR>/../playtest/<id>.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.js';

const { values: a } = parseArgs({ options: { base: { type: 'string', default: `http://127.0.0.1:${config.port}` }, turns: { type: 'string', default: '10' }, name: { type: 'string', default: 'playtest' }, 'minor-every': { type: 'string' }, 'reflect-every': { type: 'string' }, campaign: { type: 'string' } } });
const API = `${a.base}/api/wg`;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, p: string, body?: unknown): Promise<J> {
  const r = await fetch(API + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45 * 60_000) });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(d).slice(0, 300)}`), { status: r.status, body: d });
  return d as J;
}
/** ▶ che sopravvive ai limiti del client HTTP (fetch chiude dopo 5 min senza header): se la risposta si perde,
 *  segue il turno con /status finché il server ha finito, come fa la UI. */
async function advance(id: string): Promise<J> {
  try { return await call('POST', `/campaigns/${id}/advance`); } catch (e) {
    if ((e as { status?: number }).status) throw e;
    console.log(`  (risposta del ▶ persa: ${(e as Error).message}; seguo il turno con /status)`);
    for (;;) { await new Promise((r) => setTimeout(r, 10_000)); if (!(await call('GET', `/campaigns/${id}/status`)).running) return call('GET', `/campaigns/${id}`); }
  }
}
const problems: string[] = [];
const UNIT_KINDS = ['PATROL', 'PRESENCE', 'SHOW_OF_FORCE', 'ESCORT', 'BLOCKADE', 'AIR_DEFENSE', 'MOVE', 'RETURN_TO_BASE', 'REPAIR'];
const problem = (t: number, s: string) => { problems.push(`T${t}: ${s}`); console.log(`  ! ${s}`); };
const t0 = Date.now();
const mins = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

let c: J;
if (a.campaign) c = await call('GET', `/campaigns/${a.campaign}`);
else {
  console.log('Creo la campagna (primo briefing con gli agenti)…');
  const tc = Date.now();
  c = await call('POST', '/campaigns', { scenarioId: 'med-2026', name: a.name, seed: `${a.name}-${Date.now().toString(36)}`, debugGodView: true });
  console.log(`  campagna ${c.id} in ${mins(Date.now() - tc)}`);
}
if (a['minor-every'] || a['reflect-every']) {
  c = await call('POST', `/campaigns/${c.id}/config`, { agentCadence: { minorEvery: Number(a['minor-every'] ?? c.config.agentCadence?.minorEvery ?? 1), reflectEvery: Number(a['reflect-every'] ?? c.config.agentCadence?.reflectEvery ?? 1) } });
}
console.log(`fazioni: ${c.config.factionMode ?? 'modalità del server'} · cadenza: ${JSON.stringify(c.config.agentCadence)} · modelli: ${JSON.stringify(Object.fromEntries(Object.entries(c.config.llm).map(([k, v]) => [k, (v as J).model])))}`);

/** Chiamate LLM del turno per ruolo, dal registro della campagna (null se il server scrive altrove). */
function llmCalls(id: string, t: number): Record<string, number> | null {
  const f = path.join(config.dataDir, id, 'llm-log', `turn-${String(t).padStart(4, '0')}.jsonl`);
  if (!existsSync(path.join(config.dataDir, id))) return null;
  const out: Record<string, number> = {};
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const r = (JSON.parse(l) as J).role as string; out[r] = (out[r] ?? 0) + 1; }
  return out;
}
const add = (into: Record<string, number>, from: Record<string, number>) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; return into; };
const top = (m: Record<string, number>, n: number) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
const llmTotal: Record<string, number> = {}; const ruleTotal: Record<string, number> = {}; const textTotal: Record<string, number> = {};
const worldTextTotal: Record<string, number> = {}; const worldKindTotal: Record<string, number> = {}; const phaseTotal: Record<string, number> = {};
let llmSeen = false;

const turns: J[] = [];
const target = c.currentTurn + Number(a.turns) - 1;
while (c.currentTurn <= target && c.status === 'active') {
  const t = c.currentTurn;
  const tt = Date.now();
  console.log(`\n=== Turno ${t} (${c.date}) ===`);
  const k = await call('GET', `/campaigns/${c.id}/knowledge`);
  const cat = await call('GET', `/campaigns/${c.id}/catalog`);
  const narr = await call('GET', `/campaigns/${c.id}/narrative/${t}`);
  if (!narr.briefing) problem(t, 'briefing mancante');
  const ready = (k.ownUnits as J[]).filter((u) => u.status === 'ready' && u.readiness >= 50);
  const ships = ready.filter((u) => ['frigate', 'opv', 'destroyer'].includes(u.type));
  const worn = (k.ownUnits as J[]).filter((u) => u.status === 'deployed' && u.readiness < 35);
  const orders: J = { military: [], diplomacy: [], procurement: [], statements: [] };
  const zones = ['CANALE_SICILIA', 'IONIO', 'TIRRENO', 'MAR_LIBICO', 'MEDITERRANEO_ORIENTALE'];
  ships.slice(0, 2).forEach((s, i) => orders.military.push({ id: `p${i}`, kind: 'PATROL', unitIds: [s.id], zoneId: i === 0 ? s.zoneId : zones[t % zones.length], roe: 'WEAPONS_TIGHT' }));
  if (worn.length) orders.military.push({ id: 'rtb', kind: 'RETURN_TO_BASE', unitIds: worn.map((u) => u.id) });
  const isr = (k.ownFaction.isrAssets as J[])[0];
  if (isr) orders.military.push({ id: 'isr', kind: 'ISR', assetIds: [isr.id], zoneId: 'CANALE_SICILIA' });
  const diplo = [{ id: 'd1', kind: 'DEMARCHE', target: 'TUR', message: 'Chiediamo moderazione nel Mediterraneo orientale.', visibility: 'public' },
    { id: 'd2', kind: 'REASSURANCE', target: 'LBY_GNU', message: 'L\'Italia sostiene la stabilità e la cooperazione sulla migrazione.', visibility: ['LBY_GNU'] },
    { id: 'd3', kind: 'BACKCHANNEL', target: 'EGY', message: 'Proponiamo un coordinamento riservato sul Mar Rosso.' }];
  orders.diplomacy.push(diplo[t % diplo.length]);
  if (t % 3 === 0) { const it = (cat.items as J[]).filter((i) => i.available).sort((x, y) => x.cost - y.cost)[0]; if (it && cat.bases[0]) orders.procurement.push({ id: 'buy', itemId: it.id, qty: 1, destinationBaseId: cat.bases[0].id }); }
  if (t % 2 === 1) orders.statements.push({ id: 's1', audience: 'opinione pubblica', text: 'La Marina garantisce la sicurezza delle rotte.', tone: 'firm' });
  // lettera del giocatore ogni 2 turni (T1, T3, …), a turno a TUR, LBY_GNU, EGY: bozza del consigliere, poi una riga del giocatore
  let sentLetter: string | null = null;
  if (t % 2 === 1) {
    const to = ['TUR', 'LBY_GNU', 'EGY'][Math.floor(t / 2) % 3]!;
    const tones = ['firm', 'cordial', 'formal'] as const;
    const draft = await call('POST', `/campaigns/${c.id}/letters/draft`, { target: to, gist: 'Chiedere moderazione nelle aree di crisi e proporre un canale di dialogo diretto tra i due Governi.', tone: tones[Math.floor(t / 2) % 3] })
      .catch((e) => { problem(t, `bozza di lettera non riuscita: ${(e as Error).message}`); return null; });
    if (draft && draft.source === 'template') console.log(`  bozza per ${to}: lettera-modello (${(draft.errors as string[]).join('; ').slice(0, 120)})`);
    const body = draft ? `${draft.body}\nIl Governo italiano attende una Sua risposta.` : 'Signor Presidente,\nLe propongo un canale di dialogo diretto.';
    sentLetter = `pl${t}`;
    orders.diplomacy.push({ id: sentLetter, kind: 'LETTER', target: to, subject: draft?.subject ?? 'Proposta di dialogo', body: body.slice(0, 1800), tone: draft?.tone ?? 'formal', visibility: 'private' });
  }
  const v = await call('POST', `/campaigns/${c.id}/orders/validate`, orders);
  if (!v.valid) {
    problem(t, `ordini del giocatore non validi: ${v.errors.join('; ')}`);
    for (const key of ['military', 'diplomacy', 'procurement', 'statements']) orders[key] = (orders[key] as J[]).filter((o) => !v.errors.some((e: string) => e.startsWith(`${o.id}:`)));
  }
  await call('POST', `/campaigns/${c.id}/orders`, orders);
  // ▶ come la UI; nel frattempo lo stato deve dire «in corso» e un secondo ▶ deve essere rifiutato
  let finished = false;
  const adv = advance(c.id).finally(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 1500));
  const st = await call('GET', `/campaigns/${c.id}/status`);
  if (!finished) { // turno ancora in corso (con LLM veri): status e secondo ▶ vanno controllati
    if (!st.running) problem(t, 'status non dice «in corso» durante il turno');
    const second = await call('POST', `/campaigns/${c.id}/advance`).then(() => 'accettato', (e) => (e.status === 423 ? 'rifiutato' : `errore ${e.status}`));
    if (second !== 'rifiutato') problem(t, `secondo ▶ durante il turno: ${second}`);
  }
  c = await adv;
  let cmo = 0;
  while (c.phase === 'CMO_PENDING') {
    for (const e of await call('GET', `/campaigns/${c.id}/cmo`) as unknown as J[]) { await call('POST', `/campaigns/${c.id}/cmo/${encodeURIComponent(e.id)}/aar`, { autoResolve: true }); cmo++; }
    c = await advance(c.id);
  }
  if (c.currentTurn !== t + 1 || c.phase !== 'PLAYER_ORDERS') problem(t, `dopo il turno: T${c.currentTurn} ${c.phase}`);
  const pm = await call('GET', `/campaigns/${c.id}/postmortem?turn=${t}`);
  const decisions = pm.decisions as J[];
  const byModel: Record<string, number> = {};
  for (const d of decisions) byModel[d.model] = (byModel[d.model] ?? 0) + 1;
  const fallback = decisions.filter((d) => d.validation.fallbackUsed).map((d) => `${d.factionId}(${d.validation.errors.join('; ').slice(0, 120)})`);
  const doctrine = decisions.filter((d) => d.model === 'dottrina').length;
  const rules = decisions.filter((d) => d.model === 'regole');
  const firstTry = decisions.filter((d) => d.model !== 'dottrina' && d.model !== 'regole' && !d.validation.fallbackUsed && d.validation.repairAttempts === 0).length;
  // motivazioni delle decisioni a regole: per regola e per frase (senza i numeri, così si sommano le frasi uguali)
  const byRule: Record<string, number> = {}; const byText: Record<string, number> = {};
  for (const d of rules) for (const r of (d.rationale ?? []) as J[]) {
    byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
    const key = String(r.text).replace(/\d+(?:[.,]\d+)?/g, 'N');
    byText[key] = (byText[key] ?? 0) + 1;
  }
  add(ruleTotal, byRule); add(textTotal, byText);
  // IA mondiale (livello C): azioni per tipo, reazioni, motivazioni; e il tempo di ogni fase del motore (GET /timings)
  const world = (pm.world ?? null) as J | null;
  const worldKinds: Record<string, number> = {};
  for (const a of ((world?.actions ?? []) as J[])) worldKinds[a.action.kind] = (worldKinds[a.action.kind] ?? 0) + 1;
  const worldText: Record<string, number> = {};
  for (const r of ((world?.rationale ?? []) as J[])) { const key = `${r.rule}: ${String(r.text).replace(/\d+(?:[.,]\d+)?/g, 'N')}`; worldText[key] = (worldText[key] ?? 0) + 1; }
  add(worldTextTotal, worldText); add(worldKindTotal, worldKinds);
  const phaseMs: Record<string, number> = {};
  for (const x of (await call('GET', `/campaigns/${c.id}/timings`) as unknown as J[]).filter((x) => x.turn === t)) phaseMs[x.phase] = (phaseMs[x.phase] ?? 0) + x.ms;
  for (const [ph, ms] of Object.entries(phaseMs)) { phaseTotal[ph] = (phaseTotal[ph] ?? 0) + ms; }
  const aiAdjMs = (phaseMs.AI_DECISIONS ?? 0) + (phaseMs.ADJUDICATION ?? 0);
  if (aiAdjMs > 3000) problem(t, `AI_DECISIONS + ADJUDICATION ${aiAdjMs} ms (obiettivo ≤ 3000)`);
  const calls = llmCalls(c.id, t);
  if (calls) { llmSeen = true; add(llmTotal, calls); }
  const repaired = decisions.filter((d) => d.validation.repairAttempts > 0 && !d.validation.fallbackUsed).length;
  const orderCount = decisions.reduce((n, d) => n + d.orders.military.length + d.orders.diplomacy.length + d.orders.procurement.length + d.orders.statements.length, 0);
  // ordini militari IA che muovono unità vere, e quanti vengono dalle posture per zona (stanceOrders; 'worn' = rientro dei logorati)
  const unitOrders = decisions.flatMap((d) => (d.orders.military as J[]).filter((o) => UNIT_KINDS.includes(o.kind)));
  const stanceOrders = decisions.flatMap((d) => (d.stanceOrders ?? []) as J[]);
  const byKind: Record<string, number> = {};
  for (const o of unitOrders) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  const engagements = (pm.events as J[]).filter((e) => e.type === 'ENGAGEMENT_OPENED' && e.turn === t).length;
  // posture: emesse dalle decisioni, tradotte in almeno un ordine, senza unità (note del traduttore in validation.errors)
  const stanceNotes = decisions.flatMap((d) => (d.validation.errors as string[]).filter((x) => x.startsWith('postura — ')));
  const stances = {
    emitted: decisions.reduce((n, d) => n + ((d.zoneStances ?? []) as J[]).length, 0),
    translated: decisions.reduce((n, d) => n + new Set(((d.stanceOrders ?? []) as J[]).filter((x) => x.stance !== 'worn').map((x) => `${x.stance}@${x.zoneId}`)).size, 0),
    noUnits: stanceNotes.filter((x) => x.includes('nessuna unità')).length,
  };
  const done = await call('GET', `/campaigns/${c.id}/narrative/${t}`);
  if (!done.debriefing) problem(t, 'debriefing mancante');
  const fallbackNarr = [done.briefing, done.debriefing].filter((x) => x && x.sections.every((s: J) => /Nessuna variazione rilevante|^$/.test(s.body) || x.factsRef.length === 0)).length;
  const events = await call('GET', `/campaigns/${c.id}/events?turn=${t}`);
  const s = pm.state as J;
  const ita = s.factions.ITA;
  // unità IA fuori base con un compito in corso (continuano il compito del turno prima finché non rientrano o sono logorate)
  const aiIds = new Set(Object.values(s.factions as Record<string, J>).filter((f) => f.controller !== 'human' && f.kind !== 'bloc').map((f) => f.id));
  const busyUnits = Object.values(s.units as Record<string, J>).filter((u) => aiIds.has(u.factionId) && ['deployed', 'transit'].includes(u.status) && u.currentTask).length;
  if (ita.budget.discretionary < 0) problem(t, `FOED negativo: ${ita.budget.discretionary}`);
  for (const [id, cr] of Object.entries(s.crises as Record<string, J>)) if (cr.escalation < 0 || cr.escalation > 10) problem(t, `crisi ${id} fuori scala: ${cr.escalation}`);
  const rejected = (pm.events as J[]).filter((e) => e.type === 'ORDER_REJECTED').length;
  // lettere del turno visibili al giocatore; le risposte attese sono quelle alle lettere del giocatore del turno prima
  const letters = await call('GET', `/campaigns/${c.id}/letters?turn=${t}`) as unknown as J[];
  const previous = t > 1 ? (await call('GET', `/campaigns/${c.id}/letters?turn=${t - 1}`) as unknown as J[]).filter((l) => l.from === 'ITA') : [];
  const replies = previous.map((l) => ({ to: l.to, id: l.id, reply: letters.find((r) => r.inReplyTo === l.id && r.from === l.to) }));
  for (const r of replies.filter((x) => !x.reply)) problem(t, `lettera ${r.id} a ${r.to} senza risposta nel turno dopo`);
  if (sentLetter && !letters.some((l) => l.from === 'ITA' && l.id.endsWith(`-${sentLetter}`))) problem(t, `lettera del giocatore ${sentLetter} non consegnata`);
  const aiLetters = decisions.flatMap((d) => (d.letters ?? []) as J[]);
  const letterRow = {
    sent: letters.filter((l) => l.from === 'ITA').map((l) => `${l.to}: ${l.subject}`), received: letters.filter((l) => l.to === 'ITA').map((l) => `${l.from}${l.inReplyTo ? ' (risposta)' : ''}: ${l.subject}`),
    replies: replies.map((r) => `${r.to}: ${r.reply ? 'sì' : 'no'}`), aiInitiative: aiLetters.filter((l) => l.kind === 'initiative').length, aiTriggered: aiLetters.filter((l) => l.trigger).length, aiReplies: aiLetters.filter((l) => l.kind === 'reply').length,
    template: aiLetters.filter((l) => l.source === 'template').map((l) => `${l.actionId}: ${(l.errors as string[]).join('; ').slice(0, 120)}`),
  };
  const row = {
    turn: t, minutes: +((Date.now() - tt) / 60_000).toFixed(1), seconds: +((Date.now() - tt) / 1000).toFixed(1), decisions: decisions.length, rulesDecisions: rules.length,
    llmCalls: calls, rationaleByRule: byRule, topRationale: top(byText, 5), firstTry, repaired, fallback: fallback.length, doctrine, byModel, fallbackDetail: fallback,
    aiOrders: orderCount, rejectedOrders: rejected, cmo,
    unitOrders: { total: unitOrders.length, perFaction: +(unitOrders.length / Math.max(1, decisions.length)).toFixed(2), fromStances: stanceOrders.filter((x) => x.stance !== 'worn').length, worn: stanceOrders.filter((x) => x.stance === 'worn').length, byKind },
    engagements, busyUnits, stances, events: (events as unknown as J[]).length, news: done.news?.length ?? 0, narrativeFallback: fallbackNarr,
    letters: letterRow,
    world: world ? { actions: (world.actions as J[]).length, byKind: worldKinds, reactions: (world.reactions as J[]).length, stats: world.stats, letters: (world.letters as J[]).length, topRationale: top(worldText, 3) } : null, phaseMs,
    foed: ita.budget.discretionary, stability: ita.stability, crises: Object.fromEntries(Object.entries(s.crises as Record<string, J>).map(([id, cr]) => [id, cr.escalation])),
  };
  turns.push(row);
  console.log(`  ${row.seconds} s · decisioni a regole ${rules.length}, LLM ok al 1° colpo ${firstTry}, riparate ${repaired}, fallback ${fallback.length}, dottrina ${doctrine} · ordini IA ${orderCount} (rifiutati ${rejected}) · CMO ${cmo} · notizie ${row.news} · FOED ${Math.round(ita.budget.discretionary)} · crisi ${JSON.stringify(row.crises)}`);
  console.log(`  chiamate LLM ${calls ? `${Object.values(calls).reduce((a, b) => a + b, 0)} ${JSON.stringify(calls)}` : 'n/d (registro del server non leggibile da qui)'} · motivazioni ${JSON.stringify(byRule)}`);
  for (const [x, n] of row.topRationale) console.log(`    ${n}× ${x}`);
  console.log(`  ordini IA con unità ${unitOrders.length} (${row.unitOrders.perFaction} per fazione) · dalle posture ${row.unitOrders.fromStances} · rientri logorati ${row.unitOrders.worn} · ingaggi ${engagements} · ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`  unità IA impegnate ${busyUnits} · posture emesse ${stances.emitted} / tradotte ${stances.translated} / senza unità ${stances.noUnits}`);
  if (fallback.length) console.log(`  fallback: ${fallback.join(' | ')}`);
  if (world) console.log(`  fasi (ms): ${Object.entries(phaseMs).filter(([, ms]) => ms > 0).map(([ph, ms]) => `${ph} ${ms}`).join(' · ')} (AI_DECISIONS + ADJUDICATION ${aiAdjMs}) · livello C: ${(world.actions as J[]).length} azioni ${JSON.stringify(worldKinds)}, ${(world.reactions as J[]).length} reazioni, tocca a ${world.stats.eligible} Stati (${world.stats.candidates} candidate, ${world.stats.capped} oltre il tetto), lettere ${(world.letters as J[]).length}`);
  console.log(`  lettere · inviate ${letterRow.sent.length}, ricevute ${letterRow.received.length}, risposte attese ${replies.length} (arrivate ${replies.filter((r) => r.reply).length}) · iniziative IA ${letterRow.aiInitiative} (dagli inneschi del motore ${letterRow.aiTriggered}) · lettere-modello ${letterRow.template.length}`);
  for (const x of [...letterRow.sent.map((l) => `→ ${l}`), ...letterRow.received.map((l) => `← ${l}`)]) console.log(`    ✉ ${x}`);
  if (letterRow.template.length) console.log(`  lettere-modello: ${letterRow.template.join(' | ')}`);
}
const unitAvg = turns.reduce((a, r) => a + r.unitOrders.perFaction, 0) / Math.max(1, turns.length);
const fromT2 = turns.filter((r) => r.turn >= 2);
const initiativeAvg = fromT2.reduce((a, r) => a + r.letters.aiInitiative, 0) / Math.max(1, fromT2.length);
const report = { campaign: c.id, factionMode: c.config.factionMode ?? null, totalMinutes: +((Date.now() - t0) / 60_000).toFixed(1), secondsPerTurn: +(turns.reduce((a, r) => a + r.seconds, 0) / Math.max(1, turns.length)).toFixed(1),
  cadence: c.config.agentCadence, turns, problems,
  llmCallsByRole: llmSeen ? llmTotal : null, llmCallsPerTurn: llmSeen ? +(Object.values(llmTotal).reduce((a, b) => a + b, 0) / Math.max(1, turns.length)).toFixed(1) : null,
  rulesDecisions: turns.reduce((a, r) => a + r.rulesDecisions, 0), rationaleByRule: ruleTotal, topRationale: top(textTotal, 10),
  phaseMsPerTurn: Object.fromEntries(Object.entries(phaseTotal).map(([k, v]) => [k, Math.round(v / Math.max(1, turns.length))])), worldActionsPerTurn: +(Object.values(worldKindTotal).reduce((a, b) => a + b, 0) / Math.max(1, turns.length)).toFixed(1), worldActionsByKind: worldKindTotal, worldTopRationale: top(worldTextTotal, 5),
  unitOrdersPerFactionPerTurn: +unitAvg.toFixed(2), engagements: turns.reduce((a, r) => a + r.engagements, 0), aiInitiativesPerTurnFromT2: +initiativeAvg.toFixed(2) };
const out = path.join(path.dirname(config.dataDir), 'playtest', `${c.id}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\nFINE: ${turns.length} turni in ${report.totalMinutes} min (${report.secondsPerTurn} s per turno) · problemi: ${problems.length} · ordini IA con unità per fazione per turno ${report.unitOrdersPerFactionPerTurn} · ingaggi ${report.engagements} · iniziative IA per turno (dal T2) ${report.aiInitiativesPerTurnFromT2}`);
console.log(`chiamate LLM per turno: ${report.llmCallsPerTurn ?? 'n/d'} ${report.llmCallsByRole ? JSON.stringify(report.llmCallsByRole) : ''} · decisioni a regole ${report.rulesDecisions} · motivazioni per regola ${JSON.stringify(ruleTotal)}`);
for (const [x, n] of report.topRationale) console.log(`  ${n}× ${x}`);
console.log(`tempo per fase (ms per turno): ${JSON.stringify(report.phaseMsPerTurn)} · livello C: ${report.worldActionsPerTurn} azioni per turno ${JSON.stringify(report.worldActionsByKind)}`);
console.log('le 5 motivazioni più frequenti del livello C:');
for (const [x, n] of report.worldTopRationale) console.log(`  ${n}× ${x}`);
console.log(`report ${out}`);
