import { hashString } from '../engine/rng.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './llm-client.js';

type M = Record<string, any>;

/**
 * Provider deterministico per test e `--mock`: costruisce risposte valide dai `meta` strutturati.
 * `corrupt[role] = n` restituisce testo non-JSON alle prime n chiamate di quel ruolo (repair ignorato se `corruptRepair`).
 */
export class MockLLMProvider implements LlmProvider {
  name = 'mock';
  calls = 0;
  private seen: Record<string, number> = {};
  constructor(readonly opts: { corrupt?: Partial<Record<string, number>>; corruptRepair?: boolean } = {}) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const key = req.role === 'repair' ? `repair:${req.meta.repairOf}` : req.role;
    this.seen[key] = (this.seen[key] ?? 0) + 1;
    const corruptN = this.opts.corrupt?.[req.role] ?? 0;
    const broken = (req.role !== 'repair' && this.seen[key] <= corruptN) || (req.role === 'repair' && this.opts.corruptRepair);
    const body = broken ? 'Mi dispiace, ecco la risposta: {non json' : JSON.stringify(generate(req.role === 'repair' ? String(req.meta.repairOf) : req.role, req.meta));
    return { text: body, usage: { promptTokens: Math.ceil((req.system.length + req.user.length) / 4), completionTokens: Math.ceil(body.length / 4) }, latencyMs: 0, model: 'mock' };
  }
}

function generate(role: string, m: M): unknown {
  switch (role) {
    case 'faction_major': case 'faction_minor': return faction(m);
    case 'gm_narrator': return m.kind === 'news' ? news(m) : narrative(m);
    case 'intel_analyst': return { reports: (m.contacts as M[]).slice(0, 3).map((c) => ({ title: `${c.classification} in ${c.zoneId}`, body: `Traccia attribuita con riserva a ${c.estFaction}; fonti: ${c.sources.join(', ')}.`, relatedContacts: [c.id] })) };
    case 'order_parser': return parser(m);
    case 'reflection': return reflection(m);
    default: return {};
  }
}

function faction(m: M) {
  const h = hashString(`${m.seed}:${m.factionId}:${m.turn}`);
  const legal = m.legal as M;
  const crises = (m.situation.crisi as M[]).sort((a, b) => b.escalation - a.escalation);
  const zone = crises.flatMap((c) => c.zones as string[]).find((z) => legal.seaZones.includes(z)) ?? legal.seaZones[0];
  const ship = (legal.units as M[]).find((u) => u.status === 'ready' && ['frigate', 'destroyer', 'opv'].includes(u.type) && u.readiness >= 50);
  const tired = (legal.units as M[]).filter((u) => u.status === 'deployed' && u.readiness < 40).map((u) => u.id);
  const military: M[] = [];
  if (ship) military.push({ id: 'o1', kind: h % 5 === 0 ? 'SHOW_OF_FORCE' : 'PATROL', unitIds: [ship.id], zoneId: zone, roe: 'WEAPONS_TIGHT' });
  if (tired.length) military.push({ id: 'o2', kind: 'RETURN_TO_BASE', unitIds: tired });
  if (legal.isrAssets.length && h % 2 === 0) military.push({ id: 'o3', kind: 'ISR', assetIds: [legal.isrAssets[0].id], zoneId: zone });
  const others = legal.factions as string[];
  const target = others[h % Math.max(1, others.length)];
  const diplomacy: M[] = target ? [{ id: 'd1', kind: h % 3 === 0 ? 'DEMARCHE' : 'REASSURANCE', target, message: 'Richiamo alla moderazione nelle aree di crisi.', visibility: 'public' }] : [];
  for (const ag of legal.pendingAgreements as string[]) diplomacy.push({ id: `r-${ag}`, kind: 'RESPOND_AGREEMENT', agreementId: ag, response: h % 2 ? 'accept' : 'reject' });
  const lot = (legal.procurement as M[]).find((i) => i.id.startsWith('LOT_'));
  const procurement = lot && legal.ownBases.length && legal.budgetMEur > 300 && h % 3 === 1 ? [{ id: 'p1', itemId: lot.id, qty: 1, destinationBaseId: legal.ownBases[0] }] : [];
  return {
    situationAssessment: `Crisi prioritaria: ${crises[0]?.title ?? 'nessuna'}. Postura invariata, preferenza per presenza e diplomazia.`,
    threats: target ? [{ factionId: target, level: 1 + (h % 3), rationale: 'Attività nelle zone di interesse.' }] : [],
    optionsConsidered: [{ label: 'Presenza', summary: `Pattugliamento in ${zone}`, expectedGain: 0.4, risk: 0.2, chosen: true }, { label: 'Attesa', summary: 'Nessuna azione', expectedGain: 0.1, risk: 0.1, chosen: false }],
    privateIntent: `Consolidare la presenza in ${zone} senza escalation.`,
    orders: { military, diplomacy, procurement, statements: [] },
    confidence: 0.55,
  };
}

function narrative(m: M) {
  return { title: m.title, sections: (m.headings as string[]).map((heading) => ({ heading, body: (m.facts as M[]).filter((f) => f.heading === heading).map((f) => f.text).join(' ') || 'Nessuna variazione rilevante.' })), factsRef: (m.facts as M[]).map((f) => f.id) };
}

function news(m: M) {
  const outlets = ['ANSA', 'Le Monde', 'TRT', 'RT', 'Xinhua', 'CNN'];
  return { news: (m.events as M[]).slice(0, 6).map((e, i) => ({ outlet: outlets[i % outlets.length], headline: `${e.actor}: ${e.type.toLowerCase().replace(/_/g, ' ')}`, body: `Evento registrato: ${e.type}.`, eventIds: [e.id] })) };
}

function parser(m: M) {
  const text = String(m.text).toLowerCase();
  const legal = m.legal as M;
  const units = (legal.units as M[]).filter((u) => text.includes(u.id.toLowerCase()) || text.includes(String(u.name).toLowerCase().split(' (')[0]));
  const zone = [...legal.seaZones, ...legal.landZones].find((z) => text.includes(z.toLowerCase()) || text.includes(z.toLowerCase().replace(/_/g, ' ')));
  const military: M[] = [];
  const ambiguities: string[] = [];
  if (!units.length) ambiguities.push('Nessuna unità riconosciuta nella direttiva.');
  if (!zone) ambiguities.push('Nessuna zona riconosciuta nella direttiva.');
  if (units.length && zone) {
    const kind = /rientr/.test(text) ? 'RETURN_TO_BASE' : /scort/.test(text) ? 'PATROL' : /mostr|dimostr/.test(text) ? 'SHOW_OF_FORCE' : 'PATROL';
    military.push(kind === 'RETURN_TO_BASE' ? { id: 'p1', kind, unitIds: units.map((u) => u.id) } : { id: 'p1', kind, unitIds: units.map((u) => u.id), zoneId: zone, roe: /fuoco libero|weapons free/.test(text) ? 'WEAPONS_FREE' : 'WEAPONS_TIGHT' });
  }
  return { orders: { military, diplomacy: [], procurement: [], statements: [] }, ambiguities };
}

function reflection(m: M) {
  const mem = m.memory as M;
  const lesson = m.decision ? `T${m.turn}: ${m.decision.privateIntent}` : null;
  return { ...mem, lessons: lesson ? [...mem.lessons, lesson] : mem.lessons, rollingSummary: `${mem.rollingSummary} ${lesson ?? ''}`.trim() };
}
