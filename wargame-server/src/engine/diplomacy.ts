import type { Agreement, DiploAction, DiploLetter, LetterAction, LetterTone, PublicStatement, WorldState } from '../schemas/index.js';
import { acceptance, rejKey, type AcceptanceResult } from './acceptance.js';
import type { TurnCtx } from './context.js';
import { deescalateByAgreement } from './crises.js';
import { DIPLO_CATALOG, actionCost, cooldownsAfter, legacyForumOf } from './diplo-actions.js';
import { spendCapital } from './diplo-turn.js';
import { resolveResolution } from './institutions.js';
import { PARAMS } from './params.js';
import { worldData } from './world-data.js';

function message(ctx: TurnCtx, from: string, to: string, text: string, channel: 'official' | 'backchannel', actionRef: string) {
  if (!ctx.state.factions[to]) return; // gli Stati del mondo non hanno una casella di posta: rispondono con acceptance() o con la loro agenda
  ctx.emit('DIPLO_MESSAGE', from, { message: { id: `M-${ctx.turn}-${actionRef}-${to}`, turn: ctx.turn, from, to, channel, text, actionRef } },
    { targets: [to], visibility: channel === 'backchannel' ? [from, to] : 'public' });
}

/**
 * Effetti deterministici del tono di una lettera (trust, tension), più lievi delle azioni formali corrispondenti:
 * conciliante ≈ REASSURANCE, ferma ≈ DEMARCHE, minacciosa ≈ THREAT (e come THREAT registra una minaccia da verificare).
 */
export const LETTER_TONE_EFFECTS: Record<LetterTone, { trust: number; tension: number }> = {
  cordial: { trust: 2, tension: -2 },
  conciliatory: { trust: 3, tension: -4 },
  formal: { trust: 1, tension: -1 },
  firm: { trust: -1, tension: 2 },
  threatening: { trust: -5, tension: 8 },
};

/**
 * Apertura di una lettera dalla carica del destinatario: «Il Presidente della Repubblica di Turchia» → «Signor Presidente»,
 * i sovrani con il titolo d'uso: «Il Re del Marocco» → «Maestà», «L'Emiro del Qatar» → «Altezza».
 */
export function salutation(title: string): string {
  const role = title.replace(/^(Il|La|L') ?/, '').split(/ (?:del|della|dell'|degli|dei|di) ?/)[0]!.trim();
  if (/^Re\b/.test(role)) return 'Maestà';
  if (/^(Emiro|Principe)\b/.test(role)) return 'Altezza';
  return `Signor ${role}`;
}

/** Carica e città di una fazione per intestazione e firma (mai nomi di persona). */
export function leaderOf(s: WorldState, f: string) {
  const x = s.factions[f];
  // gli Stati del mondo (senza fazione) hanno la carica e la capitale dal registro
  const n = x ? undefined : worldData().nation(f);
  return { title: x?.leaderTitle || n?.leaderTitle || `Il Capo di Stato (${x?.name ?? n?.nameIt ?? f})`, capital: x?.capital || n?.capital || x?.name || f };
}

/** La lettera come viene archiviata: intestazioni dal mondo, fonte dall'ordine. */
export function letterRecord(ctx: TurnCtx, actor: string, a: LetterAction): DiploLetter {
  const from = leaderOf(ctx.state, actor); const to = leaderOf(ctx.state, a.target);
  const source = actor === ctx.campaign.playerFaction ? 'human' : a.model === 'template' ? 'template' : 'ai';
  return {
    id: `LT${ctx.turn}-${actor}-${a.id.replace(`${actor}-${ctx.turn}-`, '')}`, turn: ctx.turn, date: ctx.state.date, from: actor, to: a.target,
    fromTitle: from.title, toTitle: to.title, place: from.capital, subject: a.subject.trim(), body: a.body.trim(), tone: a.tone, visibility: a.visibility,
    ...(a.inReplyTo ? { inReplyTo: a.inReplyTo } : {}), source, ...(source !== 'human' && a.model ? { model: a.model } : {}),
  };
}

function resolveLetter(ctx: TurnCtx, actor: string, a: LetterAction) {
  const letter = letterRecord(ctx, actor, a);
  const visibility = a.visibility === 'public' ? 'public' as const : [actor, a.target];
  const cause = { causedBy: { orderId: a.id } };
  ctx.emit('LETTER_SENT', actor, { letter }, { targets: [a.target], visibility, ...cause });
  const fx = LETTER_TONE_EFFECTS[a.tone];
  ctx.relate(actor, a.target, fx.trust, fx.tension, `lettera (${a.tone}): ${letter.subject}`, { propagate: a.tone === 'threatening', visibility, detente: a.tone === 'cordial' || a.tone === 'conciliatory' });
  if (a.tone === 'threatening') ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 }, pendingThreat: { target: a.target, turn: ctx.turn } }, { visibility, ...cause });
  if (a.visibility === 'public') ctx.emit('STATEMENT', actor, { text: letter.subject, tone: a.tone, audience: a.target, letterId: letter.id }, cause);
}

/** «Trattato attivo» (+10, permanente finché l'accordo è in vigore): ogni parte verso il proponente e il proponente verso ognuna. */
function treatyModifiers(ctx: TurnCtx, ag: Agreement) {
  const [proposer, ...others] = ag.parties;
  // tra due Stati del mondo (nessuna fazione) il trattato è nel registro degli accordi ma non pesa sull'opinione: lo stato resterebbe a crescere di centinaia di modificatori
  if (!ctx.state.factions[proposer!] && !others.some((o) => ctx.state.factions[o])) return;
  const def = PARAMS.opinion.modifiers.treaty!;
  for (const o of others.slice(0, 8)) {
    if (!proposer || o === proposer) continue;
    for (const [from, to] of [[o, proposer], [proposer, o]] as const) {
      const modifier = { id: `treaty:${ag.id}:${from}<${to}`, from, to, kind: 'treaty', label: def.label, value: PARAMS.treaty.opinion, decayPerWeek: 0, causeRef: ag.id, visibility: ag.visibility === 'public' ? 'public' as const : ag.parties, turn: ctx.turn };
      ctx.emit('OPINION_MODIFIER', from, { modifier }, { targets: [to], visibility: modifier.visibility });
    }
  }
}

/** Un accordo non aggressione violato da un atto di forza tra le parti: lo stato passa a `violated`, chi lo subisce lo vede, la credibilità scende. */
export function violateTreaties(ctx: TurnCtx, aggressor: string, victim: string, why: string) {
  for (const ag of Object.values(ctx.state.agreements).filter((x) => x.status === 'active' && x.type === 'non_aggression' && x.parties.includes(aggressor) && x.parties.includes(victim)).sort((a, b) => a.id.localeCompare(b.id))) {
    ctx.emit('AGREEMENT_CHANGED', aggressor, { agreement: { ...ag, status: 'violated' }, violatedBy: aggressor, why }, { targets: ag.parties, visibility: ag.visibility });
    ctx.relate(aggressor, victim, PARAMS.treaty.violatedOpinion, 5, `trattato violato: ${ag.id} (${why})`, { propagate: false });
    ctx.emit('FACTION_CHANGED', aggressor, { factionId: aggressor, delta: { credibility: PARAMS.treaty.violatedCredibility } }, { visibility: 'public' });
  }
}

const TIE_STEPS = {
  RECALL_AMBASSADOR: { status: 'recalled', note: "richiamo dell'ambasciatore", ...PARAMS.diplo.ties.recall },
  EXPEL_DIPLOMATS: { status: 'expelled', note: 'espulsione di diplomatici', ...PARAMS.diplo.ties.expel },
  BREAK_RELATIONS: { status: 'broken', note: 'rottura delle relazioni', ...PARAMS.diplo.ties.break },
} as const;

export function resolveDiplomacy(ctx: TurnCtx, actor: string, a: DiploAction) {
  const s = ctx.state;
  const cause = { causedBy: { orderId: a.id } };
  // costo in CD e ricarica: valgono per ogni azione del catalogo (il validatore ha già controllato che il capitale basti)
  spendCapital(ctx, actor, actionCost(s, actor, a), DIPLO_CATALOG[a.kind].label, a.id);
  // (gli Stati del mondo non hanno ricariche: agiscono a turni sfalsati e un trattato non si ripropone mentre c'è)
  const cds = s.factions[actor] ? cooldownsAfter(s, actor, a) : {};
  if (Object.keys(cds).length) ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'cooldown', keys: cds } }, { visibility: [actor], ...cause });
  switch (a.kind) {
    case 'LETTER': resolveLetter(ctx, actor, a); break;
    case 'DEMARCHE': ctx.relate(actor, a.target, -2, 3, `démarche: ${a.message}`, { propagate: false }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'THREAT':
      ctx.relate(actor, a.target, -6, 10, `minaccia: ${a.message}`);
      ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 }, pendingThreat: { target: a.target, turn: ctx.turn } }, cause);
      message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'REASSURANCE': ctx.relate(actor, a.target, 3, -5, 'rassicurazione', { propagate: false, detente: true }); message(ctx, actor, a.target, a.message, 'official', a.id); break;
    case 'BACKCHANNEL': ctx.relate(actor, a.target, 2, -2, 'canale riservato', { propagate: false, visibility: [actor, a.target], detente: true }); message(ctx, actor, a.target, a.message, 'backchannel', a.id); break;
    case 'IMPROVE_RELATIONS':
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'improve_start', actor, target: a.target } }, { targets: [a.target], visibility: [actor], ...cause });
      ctx.relate(actor, a.target, PARAMS.diplo.improve.perTurn, 0, `migliorare le relazioni con ${a.target}`, { propagate: false, detente: true });
      break;
    case 'STOP_IMPROVE': {
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'improve_stop', actor, target: a.target } }, { targets: [a.target], visibility: [actor], ...cause });
      // il vantaggio accumulato non sparisce: da ora decade (0,5 a settimana)
      const m = (s.diplomacy?.modifiers ?? []).find((x) => x.kind === 'improve' && x.from === a.target && x.to === actor);
      if (m) ctx.emit('OPINION_MODIFIER', actor, { modifier: { ...m, decayPerWeek: 0.5 } }, { targets: [a.target], visibility: m.visibility, ...cause });
      break;
    }
    case 'RECALL_AMBASSADOR': case 'EXPEL_DIPLOMATS': case 'BREAK_RELATIONS': {
      const st = TIE_STEPS[a.kind];
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'tie', a: actor, b: a.target, status: st.status } }, { targets: [a.target], ...cause });
      ctx.relate(actor, a.target, st.opinion, st.tension, st.note);
      if (a.kind === 'BREAK_RELATIONS') for (const [x, y] of [[actor, a.target], [a.target, actor]] as const) if (s.diplomacy?.improving.some((i) => i.actor === x && i.target === y)) ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'improve_stop', actor: x, target: y } }, { visibility: [x, y] });
      break;
    }
    case 'RESTORE_RELATIONS':
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'tie', a: actor, b: a.target, status: null } }, { targets: [a.target], ...cause });
      ctx.relate(actor, a.target, PARAMS.diplo.ties.restore.opinion, PARAMS.diplo.ties.restore.tension, 'ripristino delle relazioni', { propagate: false, detente: true });
      break;
    case 'ARMS_EMBARGO':
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'embargo_add', key: `${actor}>${a.target}` } }, { targets: [a.target], ...cause });
      ctx.relate(actor, a.target, PARAMS.diplo.embargo.opinion, PARAMS.diplo.embargo.tension, `embargo sulle armi: ${a.target}`);
      break;
    case 'LIFT_ARMS_EMBARGO':
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'embargo_remove', key: `${actor}>${a.target}` } }, { targets: [a.target], ...cause });
      ctx.relate(actor, a.target, PARAMS.diplo.embargo.lift, 0, `revoca embargo sulle armi: ${a.target}`, { propagate: false, detente: true });
      break;
    case 'ULTIMATUM': {
      const ultimatum = { id: `ULT-${ctx.turn}-${actor}-${a.id}`, from: actor, to: a.target, demand: a.demand, issuedTurn: ctx.turn, deadlineTurn: ctx.turn + a.deadlineTurns, status: 'pending' as const };
      ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'ultimatum_add', ultimatum } }, { targets: [a.target], ...cause });
      ctx.relate(actor, a.target, PARAMS.diplo.ultimatum.opinion, PARAMS.diplo.ultimatum.tension, `ultimatum: ${a.demand}`);
      message(ctx, actor, a.target, `Ultimatum (scadenza al turno ${ultimatum.deadlineTurn}): ${a.demand}`, 'official', a.id);
      break;
    }
    case 'MEDIATE': {
      const M = PARAMS.diplo.mediation;
      ctx.escalate(a.crisisId, M.escalation, `mediazione di ${actor}`);
      for (const p of a.parties) ctx.relate(actor, p, M.opinion, 0, `mediazione in ${a.crisisId}`, { propagate: false, detente: true });
      ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: M.credibility } }, cause);
      break;
    }
    case 'RESOLUTION': resolveResolution(ctx, actor, { id: a.id, forum: a.forum, subject: a.subject, topic: a.topic, ...(a.target ? { target: a.target } : {}) }); break;
    case 'NATO_ART4': case 'EU_COUNCIL': case 'UNSC_DRAFT': resolveResolution(ctx, actor, { id: a.id, forum: legacyForumOf(a.kind) as 'NATO' | 'EU_COUNCIL' | 'UNSC', subject: a.subject, topic: 'other' }); break;
    case 'PROPOSE_AGREEMENT': {
      const parties = [...new Set([actor, ...a.target, ...a.agreement.parties])];
      const base = { ...a.agreement, id: `AG-${ctx.turn}-${actor}-${a.id}`, parties, startTurn: ctx.turn };
      // gli Stati del mondo rispondono subito (acceptance, deterministica), le fazioni nel turno dopo
      const world = a.target.filter((t) => t !== actor && !s.factions[t]);
      const verdicts: AcceptanceResult[] = world.map((t) => acceptance(s, t, { type: base.type, parties }, actor));
      const refused = verdicts.filter((v) => !v.accept);
      const factionsToAsk = a.target.filter((t) => t !== actor && s.factions[t]);
      const status = refused.length ? 'expired' as const : world.length && !factionsToAsk.length ? 'active' as const : 'proposed' as const;
      const agreement: Agreement = { ...base, status };
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement, ...(verdicts.length ? { acceptance: verdicts } : {}) }, { targets: a.target, visibility: agreement.visibility === 'public' ? 'public' : agreement.parties, ...cause });
      for (const t of factionsToAsk) message(ctx, actor, t, `Proposta di accordo ${agreement.type}: ${agreement.terms} [${agreement.id}]`, agreement.visibility === 'public' ? 'official' : 'backchannel', a.id);
      // tra due Stati del mondo (nessuna fazione) la risposta non pesa sull'opinione: nessuno la osserva e lo stato crescerebbe di centinaia di modificatori
      const observed = !!s.factions[actor] || verdicts.some((v) => !!s.factions[v.target]) || factionsToAsk.length > 0;
      for (const v of verdicts) {
        if (observed) ctx.relate(v.target, actor, v.accept ? 8 : -4, v.accept ? -5 : 2, `risposta ad accordo ${agreement.id}: ${v.accept ? 'accept' : 'reject'}`, { propagate: false, detente: v.accept });
        if (!v.accept) ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'cooldown', keys: { [rejKey(actor, v.target, agreement.type)]: ctx.turn + PARAMS.acceptance.rejectedTurns } } }, { visibility: [actor, v.target], ...cause });
      }
      if (status === 'active') { treatyModifiers(ctx, agreement); deescalateByAgreement(ctx, agreement); }
      break;
    }
    case 'RESPOND_AGREEMENT': {
      const ag = s.agreements[a.agreementId];
      if (!ag || !ag.parties.includes(actor) || ag.status !== 'proposed') break;
      const status = a.response === 'accept' ? 'active' : a.response === 'reject' ? 'expired' : 'proposed';
      const next: Agreement = { ...ag, status, terms: a.counterTerms ?? ag.terms };
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement: next }, { targets: ag.parties, visibility: ag.visibility, ...cause });
      for (const p of ag.parties) if (p !== actor) ctx.relate(actor, p, a.response === 'accept' ? 8 : a.response === 'reject' ? -4 : 0, a.response === 'accept' ? -5 : 2, `risposta ad accordo ${ag.id}: ${a.response}`, { propagate: false, detente: a.response === 'accept' });
      if (a.response === 'reject' && ag.parties[0]) ctx.emit('DIPLOMACY_CHANGED', actor, { change: { op: 'cooldown', keys: { [rejKey(ag.parties[0], actor, ag.type)]: ctx.turn + PARAMS.acceptance.rejectedTurns } } }, { visibility: [actor, ag.parties[0]], ...cause });
      if (status === 'active') { treatyModifiers(ctx, next); deescalateByAgreement(ctx, next); }
      break;
    }
    case 'SANCTION':
    case 'LIFT_SANCTION': {
      const k = a.kind === 'SANCTION' ? 1 : -0.5;
      ctx.relate(actor, a.target, -15 * k, 10 * k, `${a.kind === 'SANCTION' ? 'sanzioni' : 'revoca sanzioni'}: ${a.scope}`);
      if (s.factions[a.target]) ctx.emit('FACTION_CHANGED', actor, { factionId: a.target, delta: { stability: -2 * k } }, cause);
      break;
    }
    case 'ENERGY_DEAL': {
      const agreement = { id: `AG-${ctx.turn}-${actor}-${a.id}`, type: 'energy' as const, parties: [actor, a.target], terms: `${a.infrastructureId}: ${a.terms}`, startTurn: ctx.turn, endTurn: null, visibility: 'public' as const, status: 'proposed' as const };
      ctx.emit('AGREEMENT_CHANGED', actor, { agreement }, { targets: [a.target], ...cause });
      message(ctx, actor, a.target, `Proposta energetica su ${a.infrastructureId}: ${a.terms} [${agreement.id}]`, 'official', a.id);
      break;
    }
    case 'AID': {
      ctx.spend(actor, -a.amount, 'diplomacy', a.id, `Aiuto ${a.type} a ${a.target}`);
      if (s.factions[a.target].kind !== 'bloc') ctx.spend(a.target, a.amount, 'income', a.id, `Aiuto ${a.type} da ${actor}`);
      ctx.relate(actor, a.target, Math.min(15, a.amount / 10), -3, `aiuto ${a.type}`, { propagate: false });
      break;
    }
  }
}

export function resolveStatement(ctx: TurnCtx, actor: string, st: PublicStatement) {
  ctx.emit('STATEMENT', actor, { text: st.text, tone: st.tone, audience: st.audience }, { causedBy: { orderId: st.id } });
  const target = ctx.state.factions[st.audience] ? st.audience : null;
  if (st.tone === 'threatening') {
    ctx.emit('FACTION_CHANGED', actor, { factionId: actor, delta: { credibility: 1 } });
    if (target) ctx.relate(actor, target, -3, 3, 'dichiarazione minacciosa', { propagate: false });
  } else if (st.tone === 'conciliatory' && target) ctx.relate(actor, target, 2, -2, 'dichiarazione conciliante', { propagate: false });
}
