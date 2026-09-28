import { h, pct } from '../dom';
import type { UiState } from '../state/store';

const doc = (d: { title: string; sections: { heading: string; body: string }[] } | undefined | null) =>
  d ? [h('h3', {}, d.title), ...d.sections.map((s) => h('section', {}, h('h4', {}, s.heading), h('p', {}, s.body || '—')))] : [h('p', { class: 'wg-dim' }, 'Non disponibile.')];

export function briefingPanel(s: UiState) {
  return h('div', {}, doc(s.narrative?.briefing), s.previous?.debriefing ? [h('hr'), doc(s.previous.debriefing)] : null);
}

export function intelPanel(s: UiState) {
  const reports = s.knowledge?.intelReports ?? [];
  return h('div', {}, reports.length ? reports.map((r) => h('article', { class: 'wg-card' },
    h('div', { class: 'wg-row' }, h('span', { class: `wg-badge rel-${r.reliability[0]}` }, r.reliability), h('span', { class: 'wg-dim' }, `${r.classification} · ${r.source}`)),
    h('h4', {}, r.title), h('p', {}, r.body))) : h('p', { class: 'wg-dim' }, 'Nessun report.'),
  h('h4', {}, 'Stime sulle altre potenze'),
  h('table', { class: 'wg-table' }, h('tr', {}, h('th', {}, 'Fazione'), h('th', {}, 'Postura stimata'), h('th', {}, 'Intento'), h('th', {}, 'Conf.')),
    Object.entries(s.knowledge?.beliefs ?? {}).map(([f, b]) => h('tr', {}, h('td', {}, f), h('td', {}, `${b.estPosture}/5`), h('td', {}, b.estIntent), h('td', {}, pct(b.confidence))))));
}

export function newsPanel(s: UiState) {
  const news = [...(s.previous?.news ?? []), ...(s.knowledge?.publicNews ?? [])].filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i);
  return h('div', {}, news.length ? news.map((n) => h('article', { class: 'wg-card' },
    h('div', { class: 'wg-row' }, h('strong', {}, n.outlet), h('span', { class: 'wg-dim' }, `${n.outletFaction} · bias ${n.bias > 0 ? '+' : ''}${n.bias} · T${n.turn}`)),
    h('h4', {}, n.headline), h('p', {}, n.body))) : h('p', { class: 'wg-dim' }, 'Nessuna notizia.'));
}

export function crisesPanel(s: UiState) {
  const g = s.overview?.indicators;
  return h('div', {},
    (s.knowledge?.knownCrises ?? []).sort((a, b) => b.escalation - a.escalation).map((c) => h('div', { class: 'wg-card' },
      h('div', { class: 'wg-row' }, h('strong', {}, c.title), h('span', {}, `${c.escalation}/10 · ${c.status}`)),
      h('div', { class: 'wg-ladder' }, Array.from({ length: 10 }, (_, i) => h('span', { class: i < c.escalation ? `on l${Math.min(3, Math.floor(i / 3.4))}` : '' }))),
      h('p', { class: 'wg-dim' }, `Zone: ${c.zoneIds.join(', ')} · Attori: ${c.involved.join(', ')}`),
      c.history.length ? h('ul', { class: 'wg-dim' }, c.history.map((x) => h('li', {}, `T${x.turn} ${x.delta > 0 ? '+' : ''}${x.delta}: ${x.cause}`))) : null)),
    g ? h('div', { class: 'wg-card' }, h('h4', {}, 'Indicatori'), h('p', {}, `Brent ${g.brentUsd} $ · TTF ${g.ttfEurMwh} €/MWh · Rischio navigazione ${g.medShippingRisk}/100 · Pressione migratoria ${g.migrationPressure}/100`),
      h('ul', {}, (s.overview?.infrastructure ?? []).filter((i) => i.status !== 'operational').map((i) => h('li', {}, `${i.name}: ${i.status}`)))) : null);
}
