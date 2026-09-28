import type { AfterActionReport, PendingCmo } from '../api-client';
import { api } from '../api-client';
import { configure, endCampaign, forkFrom, resolveCmo } from '../actions';
import { h, pct, select } from '../dom';
import type { UiState } from '../state/store';

function aarForm(s: UiState, e: PendingCmo) {
  const lossRows = h('div', {});
  const munRows = h('div', {});
  const claimRows = h('div', {});
  const addLoss = () => lossRows.append(h('div', { class: 'wg-row loss' }, select('unit', e.cmoPackage.playerForces.map((f) => [f.unitId, f.name] as [string, string])), select('status', ['damaged', 'destroyed', 'deployed']), h('input', { name: 'damage', type: 'number', min: 0, max: 100, value: 30 }), h('input', { name: 'lost', type: 'number', min: 0, value: 0, title: 'velivoli persi' })));
  const addMun = () => munRows.append(h('div', { class: 'wg-row mun' }, select('m', [...new Set(e.cmoPackage.playerForces.flatMap((f) => Object.keys(f.loadout)))]), h('input', { name: 'q', type: 'number', min: 1, value: 2 })));
  const addClaim = () => claimRows.append(h('div', { class: 'wg-row claim' }, select('c', e.cmoPackage.enemyOobEstimate.map((x) => x.classification).concat('contatto non identificato')), select('r', ['damaged', 'destroyed', 'withdrew'])));
  const outcome = select('outcome', ['victory', 'draw', 'defeat'], 'draw');
  const notes = h('input', { placeholder: 'Note' });
  const q = (root: Element, sel: string, n: string) => [...root.querySelectorAll(sel)].map((r) => (r.querySelector(`[name=${n}]`) as HTMLInputElement).value);
  const submit = () => {
    const units = q(lossRows, '.loss', 'unit'); const st = q(lossRows, '.loss', 'status'); const dmg = q(lossRows, '.loss', 'damage'); const lost = q(lossRows, '.loss', 'lost');
    const ms = q(munRows, '.mun', 'm'); const qs = q(munRows, '.mun', 'q');
    const cs = q(claimRows, '.claim', 'c'); const rs = q(claimRows, '.claim', 'r');
    const aar: AfterActionReport = {
      submittedAt: new Date().toISOString(), outcome: outcome.value as AfterActionReport['outcome'], notes: notes.value,
      ownLosses: units.map((u, i) => ({ unitId: u, newStatus: st[i] as 'damaged', damage: Number(dmg[i]), aircraftLost: Number(lost[i]) || undefined })),
      munitionsExpended: Object.fromEntries(ms.map((m, i) => [m, Number(qs[i])])),
      enemyClaims: cs.map((c, i) => ({ classification: c, result: rs[i] as 'damaged' })),
    };
    void resolveCmo(e.id, aar);
  };
  return h('div', { class: 'wg-card' }, h('h4', {}, 'After Action Report'),
    h('div', {}, h('strong', {}, 'Perdite proprie '), h('button', { onclick: addLoss }, '+')), lossRows,
    h('div', {}, h('strong', {}, 'Munizioni impiegate '), h('button', { onclick: addMun }, '+')), munRows,
    h('div', {}, h('strong', {}, 'Esiti dichiarati sul nemico '), h('button', { onclick: addClaim }, '+')), claimRows,
    h('div', { class: 'wg-row' }, outcome, notes),
    h('div', { class: 'wg-row' }, h('button', { onclick: submit, disabled: s.busy }, 'Invia AAR'), h('button', { onclick: () => resolveCmo(e.id, { autoResolve: true }), disabled: s.busy }, 'Risoluzione automatica (incertezza +)')));
}

export function cmoPanel(s: UiState) {
  const toggle = h('label', { class: 'wg-row' }, h('input', { type: 'checkbox', checked: !!s.campaign?.config.cmoOnRequest, onchange: (e: Event) => configure({ cmoOnRequest: (e.target as HTMLInputElement).checked }) }), 'Risolvi su CMO anche gli ingaggi minori che coinvolgono l\'Italia');
  const confirmed = (s.events ?? []).filter((e) => e.type === 'ENGAGEMENT_RESOLVED' && (e.payload as { patch?: { enemyLossesConfirmed?: unknown } }).patch?.enemyLossesConfirmed);
  const header = [toggle, confirmed.length ? h('div', { class: 'wg-card' }, h('h4', {}, 'Conferme ISR sulle perdite nemiche'), h('ul', {}, confirmed.map((e) => h('li', {}, `${(e.payload as { engagementId: string }).engagementId}: ${((e.payload as { patch: { enemyLossesConfirmed: { classification: string; status: string }[] } }).patch.enemyLossesConfirmed).map((x) => `${x.classification} → ${x.status}`).join('; ') || 'nessuna conferma'}`)))) : null];
  if (!s.cmo.length) return h('div', {}, header, h('p', { class: 'wg-dim' }, 'Nessun ingaggio in attesa di CMO.'));
  return h('div', {}, header, s.cmo.map((e) => {
    const p = e.cmoPackage;
    return h('div', {},
      h('h3', { class: 'wg-warn' }, `${p.headline} — ${e.id}`),
      h('p', {}, `${e.zoneId} · ROE ${p.roe} · finestra ${p.environment.timeWindowUtc} UTC · mare ${p.environment.seaState} · vis. ${p.environment.visibilityKm} km · ${p.environment.clouds}`),
      h('h4', {}, 'Forze proprie'), h('ul', {}, p.playerForces.map((f) => h('li', {}, `${f.name} (${f.readiness}%): ${Object.entries(f.loadout).map(([k, v]) => `${k}×${v}`).join(', ')}`))),
      h('h4', {}, 'Stima OOB ostile'), h('ul', {}, p.enemyOobEstimate.map((x) => h('li', {}, `${x.classification}: ${x.estCount[0]}–${x.estCount[1]} (conf. ${pct(x.confidence)}) ${x.notes}`))),
      h('div', { class: 'wg-row' }, h('a', { href: api.cmoUrl(s.campaignId!, e.id, 'txt'), download: `${e.id}.txt` }, 'Scarica .txt'), h('a', { href: api.cmoUrl(s.campaignId!, e.id, 'json'), download: `${e.id}.json` }, 'Scarica .json')),
      aarForm(s, e));
  }));
}

let pm: { turn: number; data: Awaited<ReturnType<typeof api.postmortem>> | null; error?: string } = { turn: 1, data: null };

export function postmortemPanel(s: UiState, rerender: () => void) {
  const c = s.campaign;
  if (!c) return h('p', {}, '…');
  const allowed = c.status === 'ended' || c.config.debugGodView;
  const load = async (t: number) => { try { pm = { turn: t, data: await api.postmortem(c.id, t) }; } catch (e) { pm = { turn: t, data: null, error: (e as Error).message }; } rerender(); };
  const turns = Array.from({ length: c.currentTurn }, (_, i) => String(i + 1));
  return h('div', {},
    h('div', { class: 'wg-row' },
      h('span', {}, 'Ramifica dal turno chiuso:'), select('fork', turns.slice(0, -1).length ? turns.slice(0, -1) : ['1'], undefined, { id: 'wg-fork' }),
      h('button', { onclick: () => forkFrom(Number((document.getElementById('wg-fork') as HTMLSelectElement).value)) }, 'Crea ramo'),
      c.status === 'active' ? h('button', { onclick: () => confirm('Concludere la campagna? Si sbloccherà il post-mortem.') && endCampaign() }, 'Concludi campagna') : h('span', { class: 'wg-dim' }, 'Campagna conclusa')),
    allowed ? h('div', {}, h('div', { class: 'wg-row' }, select('pmturn', turns, String(pm.turn), { onchange: (e: Event) => load(Number((e.target as HTMLSelectElement).value)) }), h('button', { onclick: () => load(pm.turn) }, 'Carica')),
      pm.error ? h('p', { class: 'wg-err' }, pm.error) : null,
      pm.data ? [
        h('h4', {}, 'Rami'), h('ul', {}, pm.data.branches.map((b) => h('li', {}, `${b.name}${b.parent ? ` ← ${b.parent.campaignId} T${b.parent.turn}` : ''}`))),
        ...pm.data.decisions.map((d) => h('details', { class: 'wg-card' }, h('summary', {}, `${d.factionId} · ${d.model} · conf. ${pct(d.confidence)}${d.validation.fallbackUsed ? ' · FALLBACK' : ''}`),
          h('p', {}, d.situationAssessment), h('p', {}, h('strong', {}, 'Intento privato: '), d.privateIntent),
          h('ul', {}, d.optionsConsidered.map((o) => h('li', {}, `${o.chosen ? '✔ ' : ''}${o.label}: ${o.summary} (guadagno ${o.expectedGain}, rischio ${o.risk})`))),
          h('p', { class: 'wg-dim' }, `${d.orders.military.length} ordini militari, ${d.orders.diplomacy.length} diplomatici, ${d.orders.procurement.length} acquisti · token ${d.usage.promptTokens}+${d.usage.completionTokens}`))),
        h('details', {}, h('summary', {}, `Tiri di dado (${pm.data.rolls.length})`), h('ul', { class: 'wg-dim' }, pm.data.rolls.slice(0, 300).map((r) => h('li', {}, `${r.id} ${r.purpose}: ${r.formula} → ${r.total.toFixed(2)} ${r.outcome}`)))),
      ] : null) : h('p', { class: 'wg-dim' }, 'Post-mortem disponibile a campagna conclusa o con debugGodView.'));
}
