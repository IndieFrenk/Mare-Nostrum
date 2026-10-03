import { salutation } from '../engine/diplomacy.js';
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
    case 'diplomat': return letter(m);
    case 'strategist': return strategist(m);
    case 'chancery': return chancery(m);
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
  // un ordine preciso a una nave solo ogni tanto: le forze si muovono soprattutto con le posture per zona (come i modelli piccoli)
  if (ship && h % 4 === 0) military.push({ id: 'o1', kind: h % 5 === 0 ? 'SHOW_OF_FORCE' : 'PATROL', unitIds: [ship.id], zoneId: zone, roe: 'WEAPONS_TIGHT' });
  if (tired.length) military.push({ id: 'o2', kind: 'RETURN_TO_BASE', unitIds: tired });
  if (legal.isrAssets.length && h % 2 === 0) military.push({ id: 'o3', kind: 'ISR', assetIds: [legal.isrAssets[0].id], zoneId: zone });
  // posture per zona: una delle zone di crisi e la zona di mare dove la fazione ha più unità (difesa di casa)
  const usable = Object.keys((legal.unitsPerSeaZone ?? {}) as Record<string, number>);
  const crisisZones = [...new Set(crises.flatMap((c) => c.zones as string[]))].filter((z) => usable.includes(z)).slice(0, 3);
  const count = (z: string) => (legal.units as M[]).filter((u) => u.zoneId === z).length;
  const byUnits = [...usable].sort((a, b) => count(b) - count(a) || a.localeCompare(b));
  const kinds = ['patrol', 'presence', 'show_of_force', 'escort_shipping', 'air_defense'] as const;
  const zoneStances: M[] = [];
  if (usable.length) {
    const main = crisisZones.length ? crisisZones[h % crisisZones.length]! : byUnits[0]!;
    zoneStances.push({ zoneId: main, stance: h % 13 === 0 ? 'blockade' : kinds[h % kinds.length], intensity: 1 + (h % 3) });
    const home = byUnits.find((z) => z !== main && count(z) > 0);
    if (home) zoneStances.push({ zoneId: home, stance: (h >> 3) % 2 ? 'air_defense' : 'patrol', intensity: 1 });
    const deployedIn = (legal.units as M[]).find((u) => u.status === 'deployed' && u.zoneId !== main && u.zoneId !== home)?.zoneId;
    if (deployedIn && h % 7 === 0) zoneStances.push({ zoneId: deployedIn, stance: 'withdraw', intensity: 1 });
  }
  const others = legal.factions as string[];
  const target = others[h % Math.max(1, others.length)];
  const diplomacy: M[] = target ? [{ id: 'd1', kind: h % 3 === 0 ? 'DEMARCHE' : 'REASSURANCE', target, message: 'Richiamo alla moderazione nelle aree di crisi.', visibility: 'public' }] : [];
  // azioni del catalogo (settore 09), con il capitale che hanno: migliorare le relazioni ogni tanto, una risoluzione umanitaria all'AG più di rado
  const costs = (legal.costiDiplomatici ?? {}) as Record<string, number>;
  let cd = Number(legal.capitaleDiplomatico ?? 0) - (diplomacy.length ? 1 : 0);
  const partner = others[(h >> 2) % Math.max(1, others.length)];
  if (partner && partner !== target && h % 5 === 1 && Number(legal.slotMiglioramento ?? 0) > 0 && cd >= (costs.IMPROVE_RELATIONS ?? 1)) { diplomacy.push({ id: 'd2', kind: 'IMPROVE_RELATIONS', target: partner }); cd -= costs.IMPROVE_RELATIONS ?? 1; }
  if (h % 11 === 3 && cd >= (costs.RESOLUTION ?? 5)) diplomacy.push({ id: 'd3', kind: 'RESOLUTION', forum: 'UNGA', subject: 'Appello alla moderazione e al rispetto del diritto marittimo', topic: 'maritime' });
  for (const ag of legal.pendingAgreements as string[]) diplomacy.push({ id: `r-${ag}`, kind: 'RESPOND_AGREEMENT', agreementId: ag, response: h % 2 ? 'accept' : 'reject' });
  const lot = (legal.procurement as M[]).find((i) => i.id.startsWith('LOT_'));
  const procurement = lot && legal.ownBases.length && legal.budgetMEur > 300 && h % 3 === 1 ? [{ id: 'p1', itemId: lot.id, qty: 1, destinationBaseId: legal.ownBases[0] }] : [];
  // lettere di iniziativa: una fazione su tre, verso il bersaglio diplomatico del turno (deterministico)
  const tones = ['cordial', 'formal', 'firm', 'conciliatory'] as const;
  const letterIntents = target && h % 3 === 2 ? [{ to: target, gist: `La posizione del nostro Governo su ${crises[0]?.title ?? 'le crisi aperte'} resta invariata e proponiamo un canale di dialogo diretto.`, tone: tones[h % tones.length] }] : [];
  return {
    letterIntents,
    situationAssessment: `Crisi prioritaria: ${crises[0]?.title ?? 'nessuna'}. Postura invariata, preferenza per presenza e diplomazia.`,
    threats: target ? [{ factionId: target, level: 1 + (h % 3), rationale: 'Attività nelle zone di interesse.' }] : [],
    optionsConsidered: [{ label: 'Presenza', summary: `Pattugliamento in ${zone}`, expectedGain: 0.4, risk: 0.2, chosen: true }, { label: 'Attesa', summary: 'Nessuna azione', expectedGain: 0.1, risk: 0.1, chosen: false }],
    privateIntent: `Consolidare la presenza in ${zone} senza escalation.`,
    zoneStances,
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
  // il testo arriva con gli id già risolti tra parentesi quadre («Bergamini [ITA-F590]»)
  const units = (legal.units as M[]).filter((u) => text.includes(u.id.toLowerCase()) || text.includes(String(u.name).toLowerCase().split(' (')[0]));
  const zone = [...legal.seaZones, ...legal.landZones].find((z) => text.includes(z.toLowerCase()) || text.includes(z.toLowerCase().replace(/_/g, ' ')));
  const factions = ((m.recognized ?? []) as M[]).filter((h) => h.kind === 'faction' && h.id !== 'ITA').map((h) => h.id as string);
  const military: M[] = [];
  const diplomacy: M[] = [];
  const zoneStances: M[] = [];
  const ambiguities: string[] = [];
  const stance = /rientr/.test(text) ? 'withdraw' : /mostr|dimostr/.test(text) ? 'show_of_force' : /pattugl/.test(text) ? 'patrol' : /scort/.test(text) ? 'escort_shipping' : 'presence';
  // lo stesso errore di qwen3.5 4B/9B: anche con le unità nominate («Bergamini [ITA-F590]») nessun ordine con il loro id, solo
  // una postura nella zona (il motore mette per prime le unità nominate), e per il rientro alla base niente (JSON troncato:
  // completa il motore). Senza unità nominate: postura se il testo chiede forze in una zona.
  if (zone && stance !== 'withdraw' && (units.length || /presenza|pattugl|dimostr|scort/.test(text))) zoneStances.push({ zoneId: zone, stance, intensity: !units.length && /più|rafforz/.test(text) ? 2 : 1 });
  // azioni nuove del catalogo: il mock ne dà alcune (le altre le completa il motore, come per il cyber)
  const target1 = factions.length === 1 ? factions[0] : undefined;
  if (target1 && /richiam\w* l'ambasciatore/.test(text)) diplomacy.push({ id: 'd-recall', kind: 'RECALL_AMBASSADOR', target: target1 });
  if (target1 && /ultimatum/.test(text)) diplomacy.push({ id: 'd-ult', kind: 'ULTIMATUM', target: target1, demand: 'Ritirare le forze dalla zona contestata', deadlineTurns: Number(/entro (\d)/.exec(text)?.[1] ?? 2) });
  if (target1 && /migliora\w* (i rapporti|le relazioni)/.test(text)) diplomacy.push({ id: 'd-imp', kind: 'IMPROVE_RELATIONS', target: target1 });
  const dkind = /rassicur/.test(text) ? 'REASSURANCE' : /minacc/.test(text) ? 'THREAT' : /chied|sollecit|protest/.test(text) ? 'DEMARCHE' : null;
  if (dkind) for (const f of factions) diplomacy.push({ id: `d-${f}`, kind: dkind, target: f, message: 'Richiesta formale del Governo italiano.', visibility: 'public' });
  // aiuti: le frasi diplomatiche i modelli locali le sbagliano di rado; per il cyber nessuna CYBER_OP (la completa il motore)
  const amount = Number(/(\d+)\s*milion/.exec(text)?.[1] ?? 0);
  if (/aiut/.test(text) && amount) for (const f of factions) diplomacy.push({ id: `a-${f}`, kind: 'AID', target: f, amount, type: /militar/.test(text) ? 'military' : 'economic' });
  if (!military.length && !zoneStances.length && !diplomacy.length) {
    if (!units.length) ambiguities.push('Nessuna unità riconosciuta nella direttiva.');
    if (!zone) ambiguities.push('Nessuna zona riconosciuta nella direttiva.');
  }
  return { orders: { military, diplomacy, procurement: [], statements: [] }, zoneStances, ambiguities };
}

function reflection(m: M) {
  const mem = m.memory as M;
  const lesson = m.decision ? `T${m.turn}: ${m.decision.privateIntent}` : null;
  return { ...mem, lessons: lesson ? [...mem.lessons, lesson] : mem.lessons, rollingSummary: `${mem.rollingSummary} ${lesson ?? ''}`.trim() };
}

/** Lettera plausibile, senza cifre (i numeri li controlla il validatore) e deterministica. */
function letter(m: M) {
  const h = hashString(`${m.seed}:${m.factionId}:${m.to}:${m.turn}:${m.kind}`);
  const tone = m.tone ?? (['formal', 'cordial', 'firm', 'conciliatory'] as const)[h % 4];
  const hello = salutation(String(m.toTitle));
  const open = [`${hello},`, hello.startsWith('Signor') ? `Egregio ${hello},` : `${hello},`][h % 2];
  const core = m.replySubject
    ? `ho letto con attenzione la Sua lettera. ${tone === 'firm' ? 'Il mio Governo non può condividerne alcuni passaggi, ma' : 'Il mio Governo ne condivide lo spirito e'} resta disponibile a un confronto franco sulle questioni sollevate.`
    : `desidero farLe conoscere il pensiero del mio Governo. ${m.gist ?? 'La situazione nel Mediterraneo richiede prudenza da parte di tutti.'} Confido che i nostri Governi sapranno mantenere aperto il dialogo.`;
  const subject = m.replySubject ? `Risposta: ${String(m.replySubject).replace(/^(Risposta:\s*)+/i, '')}`.slice(0, 120) : ['Dialogo sulle questioni di comune interesse', 'Sicurezza del Mediterraneo', 'Cooperazione e stabilità regionale'][h % 3];
  return { subject, body: `${open}\n${core}\nVoglia accogliere i sensi della mia più alta considerazione.`, tone };
}

/**
 * Direttiva plausibile e deterministica dalle righe d'opinione che il motore ha messo nel contesto: pressione sul più ostile, avvicinamento al più
 * amichevole, a volte un accordo commerciale e un po' più di interesse per una zona. Solo id del contesto: il motore la accetta senza scarti.
 */
function strategist(m: M) {
  const h = hashString(`${m.seed}:${m.factionId}:${m.turn}:direttiva`);
  const rows = (m.rows as M[]).filter((r) => r.x !== m.factionId);
  const worst = [...rows].sort((a, b) => a.opinion - b.opinion || a.x.localeCompare(b.x))[0];
  const best = [...rows].sort((a, b) => b.opinion - a.opinion || a.x.localeCompare(b.x))[0];
  const priorities: M[] = [];
  if (worst && worst.opinion < 0) priorities.push({ kind: h % 2 ? 'deter' : 'contain', target: worst.x, weight: 0.5 });
  if (best && best.opinion > -20 && best.x !== worst?.x) priorities.push({ kind: h % 3 === 0 ? 'court' : 'improve', target: best.x, weight: 0.6 });
  const zones = (m.zones as string[]);
  return {
    horizonTurns: 3 + (h % 4),
    priorities,
    zoneInterestDelta: zones.length && h % 2 === 0 ? { [zones[h % zones.length]!]: 0.1 } : {},
    seekAgreements: best && best.opinion > 0 && h % 3 === 1 ? [{ type: 'trade', with: best.x }] : [],
    avoid: [],
    rationale: `Linea per i prossimi turni: ${worst && worst.opinion < 0 ? 'fermezza con i rivali' : 'distensione'} e rapporti più stretti con i partner.`,
  };
}

/** Frasi delle cancellerie dal contesto: una per Stato dell'elenco, con la posizione data dal motore, senza cifre né nomi di persone. */
function chancery(m: M) {
  const noun: Record<string, string> = { strike: "l'attacco", engagement: 'lo scontro armato', blockade: 'il blocco navale', ultimatum: "l'ultimatum", sanction: 'le sanzioni', multilateral_sanction: 'le sanzioni multilaterali', break: 'la rottura delle relazioni', embargo: "l'embargo sulle armi", cyber: "l'attacco cyber", covert: "l'operazione clandestina" };
  const n = noun[String(m.event.kind)] ?? "l'accaduto";
  return {
    statements: (m.states as M[]).map((s) => ({
      iso: s.iso, position: s.position,
      text: s.position === 'condemn' ? `${s.name} deplora ${n} di ${m.actorName} ai danni di ${m.victimName} e chiede il rispetto del diritto internazionale.`
        : s.position === 'support' ? `${s.name} sostiene la posizione di ${m.actorName} dopo ${n} e chiede moderazione a tutte le parti.`
        : `${s.name} osserva con cautela gli sviluppi dopo ${n} e invita al dialogo.`,
    })),
  };
}
