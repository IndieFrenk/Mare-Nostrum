import type { AfterActionReport, CmoPackage, Engagement } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { hashString } from './rng.js';
import { PARAMS } from './params.js';
import { resolveSalvo } from './combat.js';

/** Pacchetto per CMO: forze proprie esatte, nemico solo come stima dalla Knowledge del giocatore. */
export function buildCmoPackage(ctx: TurnCtx, eng: Engagement, objective?: string): CmoPackage {
  const player = ctx.campaign.playerFaction;
  const own = eng.sides.find((s) => s.factionId === player)!;
  const zone = ctx.state.zones[eng.zoneId];
  const contacts = (ctx.truthContacts[player] ?? []).filter((c) => c.zoneId === eng.zoneId);
  const groups = new Map<string, { n: number; conf: number; est: [number, number] }>();
  for (const c of contacts) {
    const g = groups.get(c.classification) ?? { n: 0, conf: 0, est: [0, 0] };
    groups.set(c.classification, { n: g.n + 1, conf: Math.max(g.conf, c.confidence), est: [g.est[0] + (c.estCount?.[0] ?? 1), g.est[1] + (c.estCount?.[1] ?? 1)] });
  }
  const w = hashString(`${zone.weatherSeed}:${ctx.turn}`);
  const roe = own.unitIds.map((id) => (ctx.state.units[id].currentTask as { roe?: CmoPackage['roe'] } | null)?.roe).find(Boolean) ?? 'WEAPONS_TIGHT';
  return {
    engagementId: eng.id, headline: 'RISOLUZIONE SU CMO RICHIESTA',
    playerForces: own.unitIds.map((id) => { const u = ctx.state.units[id]; return { unitId: u.id, name: u.name, classId: u.classId, loadout: { ...u.loadout }, readiness: u.readiness }; }),
    enemyOobEstimate: [...groups].map(([classification, g]) => ({ classification, estCount: g.est, confidence: g.conf, notes: `${g.n} tracce correlate` })),
    environment: {
      date: ctx.state.date, timeWindowUtc: `${String(w % 24).padStart(2, '0')}:00-${String((w + 6) % 24).padStart(2, '0')}:00`,
      seaState: zone.seaState + (w % 3), visibilityKm: 10 + (w % 30), wind: `${(w % 8) * 45}° ${5 + (w % 25)} kt`, clouds: ['sereno', 'poco nuvoloso', 'coperto', 'pioggia'][w % 4], ducting: w % 5 === 0,
    },
    roe, objectives: [objective ?? `Controllo di ${zone.name}`], constraints: ['Evitare danni collaterali a traffico civile', 'Nessun attacco a territorio non autorizzato'],
    suggestedScenarioArea: { center: eng.location, radiusKm: 150 },
  };
}

/** Applica l'AAR: perdite proprie come dichiarate; perdite nemiche riconciliate con tiro di plausibilità. */
export function applyAar(ctx: TurnCtx, engagementId: string, aar: AfterActionReport) {
  const eng = ctx.state.engagements[engagementId];
  const player = ctx.campaign.playerFaction;
  const vis = { visibility: [player] as string[] };
  for (const l of aar.ownLosses) {
    const u = ctx.state.units[l.unitId];
    if (!u || u.factionId !== player) continue;
    ctx.emit('UNIT_DAMAGED', 'world', { unitId: u.id, damage: l.damage, countLoss: l.aircraftLost ?? 0, status: l.newStatus }, vis);
  }
  for (const [m, qty] of Object.entries(aar.munitionsExpended)) {
    let left = qty;
    for (const id of eng.sides.find((s) => s.factionId === player)!.unitIds) {
      const have = ctx.state.units[id].loadout[m] ?? 0;
      const take = Math.min(have, left);
      if (take > 0) { ctx.emit('MUNITION_EXPENDED', player, { factionId: player, unitId: id, munitionId: m, qty: take }, vis); left -= take; }
    }
    if (left > 0) ctx.emit('MUNITION_EXPENDED', player, { factionId: player, munitionId: m, qty: left }, vis);
    const cost = (ctx.catalog.munitions[m]?.cost ?? 1) * qty;
    ctx.spend(player, -cost, 'operations', engagementId, `Munizioni impiegate: ${qty}× ${m}`);
  }
  const enemyIds = eng.sides.filter((s) => s.factionId !== player).flatMap((s) => s.unitIds);
  const p = PARAMS.aarPlausibility[aar.outcome];
  for (const claim of aar.enemyClaims) {
    const alive = enemyIds.filter((id) => ctx.state.units[id].status !== 'destroyed');
    if (!alive.length) break;
    const t = ctx.state.units[alive.find((id) => claim.classification.toLowerCase().includes(ctx.state.units[id].type)) ?? alive[0]];
    const r = ctx.rng.chance(`riconciliazione AAR: ${claim.classification} ${claim.result}`, p);
    if (claim.result === 'withdrew') { ctx.emit('UNIT_MOVED', t.factionId, { unitId: t.id, location: ctx.state.bases[t.homeBaseId].location, zoneId: ctx.state.bases[t.homeBaseId].zoneId, status: 'ready' }, { visibility: [t.factionId] }); continue; }
    const damage = r.ok ? (claim.result === 'destroyed' ? 100 : Math.max(t.damage, 50)) : Math.min(99, t.damage + 25);
    ctx.emit('UNIT_DAMAGED', player, { unitId: t.id, damage, countLoss: t.domain === 'air' && claim.result === 'destroyed' ? 1 : 0 }, { visibility: [t.factionId], causedBy: { rollId: r.roll.id } });
  }
  ctx.emit('ENGAGEMENT_RESOLVED', 'world', { engagementId, patch: { status: 'resolved', aar } }, { targets: eng.sides.map((s) => s.factionId) });
}

export function autoResolveMajor(ctx: TurnCtx, engagementId: string) {
  ctx.emit('ENGAGEMENT_RESOLVED', 'world', { engagementId, patch: { resolution: 'auto' } }, { visibility: [ctx.campaign.playerFaction] });
  resolveSalvo(ctx, engagementId, PARAMS.autoResolveUncertainty);
}

export function cmoText(p: CmoPackage): string {
  return [
    `=== ${p.headline} — ${p.engagementId} ===`,
    `Data: ${p.environment.date}  Finestra: ${p.environment.timeWindowUtc} UTC  ROE: ${p.roe}`,
    `Area: ${p.suggestedScenarioArea.center.lat}N ${p.suggestedScenarioArea.center.lon}E, raggio ${p.suggestedScenarioArea.radiusKm} km`,
    `Meteo: mare forza ${p.environment.seaState}, visibilità ${p.environment.visibilityKm} km, vento ${p.environment.wind}, ${p.environment.clouds}${p.environment.ducting ? ', ducting' : ''}`,
    '', 'FORZE PROPRIE:', ...p.playerForces.map((f) => `- ${f.name} [${f.classId}] prontezza ${f.readiness}% · ${Object.entries(f.loadout).map(([k, v]) => `${k}×${v}`).join(', ')}`),
    '', 'STIMA OOB OSTILE:', ...p.enemyOobEstimate.map((e) => `- ${e.classification}: ${e.estCount[0]}-${e.estCount[1]} (confidenza ${Math.round(e.confidence * 100)}%) ${e.notes}`),
    '', 'OBIETTIVI:', ...p.objectives.map((o) => `- ${o}`), 'VINCOLI:', ...p.constraints.map((c) => `- ${c}`),
  ].join('\n');
}
