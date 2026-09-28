// Partita automatica attraverso l'API HTTP, come farebbe la UI: N turni con ordini del giocatore (pattuglie, diplomazia,
// acquisti, dichiarazioni, una lettera ogni 2 turni a TUR/LBY_GNU/EGY), ingaggi CMO risolti in automatico, controlli di coerenza
// e statistiche degli agenti (anche lettere: inviate, ricevute, risposte arrivate, iniziative IA, lettere-modello).
// Uso: npm run playtest -- --turns 10 [--base http://127.0.0.1:8787] [--name playtest] [--minor-every 2 --reflect-every 3]
// Report: stampa a video e JSON in <WARGAME_DATA_DIR>/../playtest/<id>.json
import { mkdirSync, writeFileSync } from 'node:fs';
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
console.log(`cadenza: ${JSON.stringify(c.config.agentCadence)} · modelli: ${JSON.stringify(Object.fromEntries(Object.entries(c.config.llm).map(([k, v]) => [k, (v as J).model])))}`);

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
  const firstTry = decisions.filter((d) => d.model !== 'dottrina' && !d.validation.fallbackUsed && d.validation.repairAttempts === 0).length;
  const repaired = decisions.filter((d) => d.validation.repairAttempts > 0 && !d.validation.fallbackUsed).length;
  const orderCount = decisions.reduce((n, d) => n + d.orders.military.length + d.orders.diplomacy.length + d.orders.procurement.length + d.orders.statements.length, 0);
  const done = await call('GET', `/campaigns/${c.id}/narrative/${t}`);
  if (!done.debriefing) problem(t, 'debriefing mancante');
  const fallbackNarr = [done.briefing, done.debriefing].filter((x) => x && x.sections.every((s: J) => /Nessuna variazione rilevante|^$/.test(s.body) || x.factsRef.length === 0)).length;
  const events = await call('GET', `/campaigns/${c.id}/events?turn=${t}`);
  const s = pm.state as J;
  const ita = s.factions.ITA;
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
    replies: replies.map((r) => `${r.to}: ${r.reply ? 'sì' : 'no'}`), aiInitiative: aiLetters.filter((l) => l.kind === 'initiative').length, aiReplies: aiLetters.filter((l) => l.kind === 'reply').length,
    template: aiLetters.filter((l) => l.source === 'template').map((l) => `${l.actionId}: ${(l.errors as string[]).join('; ').slice(0, 120)}`),
  };
  const row = {
    turn: t, minutes: +((Date.now() - tt) / 60_000).toFixed(1), decisions: decisions.length, firstTry, repaired, fallback: fallback.length, doctrine, byModel, fallbackDetail: fallback,
    aiOrders: orderCount, rejectedOrders: rejected, cmo, events: (events as unknown as J[]).length, news: done.news?.length ?? 0, narrativeFallback: fallbackNarr,
    letters: letterRow,
    foed: ita.budget.discretionary, stability: ita.stability, crises: Object.fromEntries(Object.entries(s.crises as Record<string, J>).map(([id, cr]) => [id, cr.escalation])),
  };
  turns.push(row);
  console.log(`  ${row.minutes} min · decisioni IA ok al 1° colpo ${firstTry}, riparate ${repaired}, fallback ${fallback.length}, dottrina ${doctrine} · ordini IA ${orderCount} (rifiutati ${rejected}) · CMO ${cmo} · notizie ${row.news} · FOED ${Math.round(ita.budget.discretionary)} · crisi ${JSON.stringify(row.crises)}`);
  if (fallback.length) console.log(`  fallback: ${fallback.join(' | ')}`);
  console.log(`  lettere · inviate ${letterRow.sent.length}, ricevute ${letterRow.received.length}, risposte attese ${replies.length} (arrivate ${replies.filter((r) => r.reply).length}) · iniziative IA ${letterRow.aiInitiative} · lettere-modello ${letterRow.template.length}`);
  for (const x of [...letterRow.sent.map((l) => `→ ${l}`), ...letterRow.received.map((l) => `← ${l}`)]) console.log(`    ✉ ${x}`);
  if (letterRow.template.length) console.log(`  lettere-modello: ${letterRow.template.join(' | ')}`);
}
const report = { campaign: c.id, totalMinutes: +((Date.now() - t0) / 60_000).toFixed(1), cadence: c.config.agentCadence, turns, problems };
const out = path.join(path.dirname(config.dataDir), 'playtest', `${c.id}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\nFINE: ${turns.length} turni in ${report.totalMinutes} min · problemi: ${problems.length}\nreport ${out}`);
