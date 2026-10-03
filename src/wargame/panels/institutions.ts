import type { DiploAction, VoteView } from '../api-client';
import { loadNation } from '../actions';
import { h, select } from '../dom';
import { FORUM_NAME } from '../layers/diplomacy';
import { NAMES } from '../layers/factions';
import { newId, set, state, type UiState } from '../state/store';

const TOPICS: [string, string][] = [['aggression', 'aggressione'], ['sanctions', 'sanzioni'], ['humanitarian', 'umanitario'], ['maritime', 'marittimo'], ['nonproliferation', 'non proliferazione'], ['other', 'altro']];
/** sede della risoluzione → id dell'istituzione nel registro (per sapere se l'Italia ne è membro) */
const INSTITUTION_OF: Record<string, string> = { UNSC: 'UNSC', UNGA: 'UNGA', EU_COUNCIL: 'EU', NATO: 'NATO', ARAB_LEAGUE: 'ARAB_LEAGUE', AU: 'AU' };

const nameOf = (s: UiState, actor: string) => NAMES[actor] ?? s.nations.find((n) => (n.factionId ?? n.iso3) === actor || n.iso3 === actor)?.nameIt ?? actor;

/** Una votazione: titolo, esito, conteggi; aperta mostra regola, proponente, veti e il pulsante che la porta sulla mappa. */
function voteRow(s: UiState, v: VoteView) {
  const shown = s.mapMode === 'voto' && (s.voteId ?? s.votes[0]?.id) === v.id;
  return h('details', { class: 'wg-card' },
    h('summary', {}, `${v.date ?? `T${v.turn}`} · ${FORUM_NAME[v.forum] ?? v.forum} — «${v.subject}» → ${v.passed ? 'approvata' : 'respinta'}`),
    h('p', {}, `${v.yes.length} sì · ${v.no.length} no · ${v.abstain.length} astenuti`, v.vetoes.length ? ` · veto: ${v.vetoes.join(', ')}` : ''),
    h('p', { class: 'wg-dim' }, `Proposta di ${nameOf(s, v.proposer)}${v.target ? ` contro ${nameOf(s, v.target)}` : ''} (${v.topic}). Regola: ${v.rule}.`),
    h('button', { 'aria-pressed': String(shown), onclick: () => set({ mapMode: 'voto', voteId: v.id }) }, 'Mostra il voto sulla mappa'));
}

/** Modulo «Proponi risoluzione»: aggiunge l'azione RESOLUTION alla bozza (stesso schema degli ordini) e apre la Console Ordini; non la invia. */
function proposeForm(s: UiState) {
  if (!s.nationDetail.ITA) void loadNation('ITA');
  const member = new Set((s.nationDetail.ITA?.institutions ?? []).map((i) => i.id));
  const row = s.diploCatalog.find((c) => c.kind === 'RESOLUTION');
  const forums = Object.keys(FORUM_NAME);
  const known = !!s.nationDetail.ITA;
  const forum = select('forum', forums.map((f) => [f, `${FORUM_NAME[f]} — ${row?.costBy?.[f] ?? '?'} CD${known && !member.has(INSTITUTION_OF[f]!) ? ' (non membro)' : ''}`] as [string, string]), 'UNGA');
  const topic = select('topic', TOPICS, 'other');
  const subject = h('input', { name: 'subject', placeholder: 'Oggetto della risoluzione', 'aria-label': 'Oggetto della risoluzione' });
  const target = select('target', [['', '— nessun bersaglio —'], ...s.nations.map((n) => [n.factionId ?? n.iso3, n.nameIt] as [string, string]).sort((a, b) => a[1].localeCompare(b[1], 'it'))]);
  const phaseOk = s.campaign?.phase === 'PLAYER_ORDERS';
  const go = () => {
    const text = subject.value.trim();
    if (!text) { set({ error: 'Scrivi l\'oggetto della risoluzione.' }); return; }
    const a: DiploAction = { id: newId('d'), kind: 'RESOLUTION', forum: forum.value as 'UNGA', subject: text, topic: topic.value as 'other', ...(target.value ? { target: target.value } : {}) };
    set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, a] }, validation: null, submitted: false, error: null, drawer: 'orders' });
  };
  return h('div', { class: 'wg-card' }, h('h4', {}, 'Proponi una risoluzione'),
    h('div', { class: 'wg-form' }, forum, topic, target, subject),
    h('button', { class: 'wg-primary', disabled: !phaseOk, title: phaseOk ? undefined : `Gli ordini si danno nella fase PLAYER_ORDERS (ora ${s.campaign?.phase})`, onclick: go }, 'Proponi risoluzione'),
    h('p', { class: 'wg-dim' }, 'Va nella bozza degli ordini; il voto si tiene col turno. Il costo in CD è quello della sede; il Consiglio di sicurezza ha il veto dei permanenti.'));
}

/** Pannello Istituzioni: votazioni dell'ultimo turno e passate (le ultime 20), conteggi, regola, mappa del voto con un clic. */
export function institutionsPanel(s: UiState) {
  const t = s.campaign?.currentTurn ?? 0;
  const last = s.votes.filter((v) => v.turn >= t - 1);
  const older = s.votes.filter((v) => v.turn < t - 1);
  return h('div', {}, proposeForm(s),
    h('h4', {}, 'Votazioni dell\'ultimo turno'),
    last.length ? last.map((v) => voteRow(s, v)) : h('p', { class: 'wg-dim' }, 'Nessuna votazione nell\'ultimo turno.'),
    older.length ? [h('h4', {}, 'Votazioni passate'), older.map((v) => voteRow(s, v))] : null);
}
