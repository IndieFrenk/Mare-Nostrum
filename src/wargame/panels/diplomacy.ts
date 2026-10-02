import { h } from '../dom';
import type { FactionKnowledge } from '../api-client';
import type { UiState } from '../state/store';

const heat = (v: number, max: number, invert = false) => {
  const t = Math.max(-1, Math.min(1, v / max)) * (invert ? -1 : 1);
  return `background: ${t >= 0 ? `rgba(60,190,120,${t * 0.6})` : `rgba(230,70,70,${-t * 0.6})`}`;
};

const TIE = { recalled: 'ambasciatore richiamato', expelled: 'diplomatici espulsi', broken: 'relazioni rotte' } as const;

/** Capitale diplomatico, miglioramenti in corso, ricariche, rapporti ridotti, ultimatum ed embarghi della fazione, e come risponderebbe il decisore alle proposte ricevute. */
function registry(d: NonNullable<FactionKnowledge['diplomacy']>) {
  const cooldowns = Object.entries(d.cooldowns).sort(([a], [b]) => a.localeCompare(b));
  return h('div', { class: 'wg-card' },
    h('p', {}, h('b', {}, `Capitale diplomatico ${d.capital} CD`), ` (+${d.rent} a settimana · slot «migliorare le relazioni» ${d.improving.length}/${d.improvingSlots})`),
    d.improving.length ? h('p', { class: 'wg-dim' }, `Miglioramenti in corso: ${d.improving.map((x) => `${x.target} (dal T${x.since})`).join(', ')}`) : null,
    Object.keys(d.ties).length ? h('p', { class: 'wg-warn' }, `Rapporti ridotti: ${Object.entries(d.ties).map(([f, st]) => `${f} — ${TIE[st]}`).join(', ')}`) : null,
    d.ultimatums.length ? h('ul', {}, d.ultimatums.map((u) => h('li', {}, `Ultimatum ${u.from} → ${u.to}: «${u.demand}» · scadenza T${u.deadlineTurn} · ${u.status === 'pending' ? 'in corso' : u.status === 'met' ? 'soddisfatto' : `scaduto (legittimità fino al T${u.legitimateUntil ?? '?'})`}`))) : null,
    d.embargoes.length ? h('p', { class: 'wg-dim' }, `Embarghi sulle armi: ${d.embargoes.map((x) => x.replace('>', ' → ')).join(', ')}`) : null,
    cooldowns.length ? h('p', { class: 'wg-dim' }, `In ricarica: ${cooldowns.map(([k, until]) => `${k.replace('|', ' → ')} (T${until})`).join(', ')}`) : null,
    d.proposals.length ? h('div', {}, h('h4', {}, 'Proposte ricevute'), d.proposals.map((p) => h('details', {}, h('summary', {}, `${p.agreementId} · ${p.type} da ${p.from}: il decisore ${p.accept ? 'accetterebbe' : 'rifiuterebbe'} (punteggio ${p.score})`), h('ul', {}, p.reasons.map((r) => h('li', {}, `${r.value > 0 ? '+' : ''}${r.value} ${r.label}`)))))) : null);
}

export function diplomacyPanel(s: UiState) {
  const rel = s.overview?.relations ?? {};
  const k = s.knowledge;
  return h('div', {},
    h('p', { class: 'wg-dim' }, 'Le azioni diplomatiche si compongono nella Console Ordini.'),
    k?.diplomacy ? registry(k.diplomacy) : null,
    h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Italia ↔'), h('th', {}, 'Fiducia'), h('th', {}, 'Tensione'), h('th', {}, 'Ultimo incidente')),
      Object.entries(rel).sort((a, b) => b[1].tension - a[1].tension).map(([f, r]) => h('tr', {}, h('td', {}, f), h('td', { style: heat(r.trust, 100) }, r.trust), h('td', { style: heat(r.tension - 30, 70, true) }, r.tension), h('td', {}, r.lastIncidentTurn === null ? '—' : `T${r.lastIncidentTurn}`)))),
    h('h4', {}, 'Accordi noti'),
    h('ul', {}, (k?.knownAgreements ?? []).map((a) => h('li', {}, `${a.id} · ${a.type} · ${a.parties.join('/')} · ${a.status} — ${a.terms}`))),
    h('h4', {}, 'Messaggi ricevuti'),
    h('ul', {}, (k?.inbox ?? []).map((m) => h('li', {}, `[${m.channel}] ${m.from}: ${m.text}`))));
}
