import type { Contact, Unit } from '../schemas/index.js';
import type { TurnCtx } from './context.js';
import { distanceKm, jitter } from './geo.js';
import { PARAMS } from './params.js';
import { hashString } from './rng.js';

type Source = Contact['sources'][number];
interface Sensor { quality: number; source: Source; asw: boolean }

const TYPE_LABEL: Record<Unit['type'], string> = {
  carrier: 'portaerei', lhd: 'nave anfibia', destroyer: 'cacciatorpediniere', frigate: 'fregata', opv: 'pattugliatore', submarine: 'sottomarino',
  fighter_sqn: 'velivoli da caccia', strike_sqn: 'velivoli d\'attacco', aew: 'velivolo AEW', mpa: 'pattugliatore marittimo', drone_flight: 'droni',
  sam_battery: 'sistema SAM', ground_bn: 'forze terrestri', sof_team: 'forze speciali', tanker: 'nave logistica', transport: 'trasporto',
};
const DOMAIN_LABEL: Record<Unit['domain'], string> = { sea: 'superficie', subsurface: 'subacqueo', air: 'aereo', land: 'terrestre', space: 'spaziale', cyber: 'cyber' };
const ISR_SOURCE: Record<string, Source> = { SAR_SAT: 'sar', EO_SAT: 'eo', AEW: 'radar', MPA: 'radar', MALE_DRONE: 'eo', SIGINT: 'sigint', HUMINT_NET: 'humint', OTH_RADAR: 'radar' };

export const contactId = (observer: string, unitId: string) => `C-${hashString(`${observer}:${unitId}`).toString(36).slice(0, 6).toUpperCase()}`;

/** INTEL: per ogni fazione, sensori/ISR vs firme → contatti degradati (con verità solo lato motore). */
export function runDetection(ctx: TurnCtx, previous: Record<string, Contact[]>) {
  const s = ctx.state;
  const D = PARAMS.detection;
  const units = Object.values(s.units).filter((u) => u.status !== 'destroyed' && u.count > 0);
  for (const f of Object.values(s.factions)) {
    if (f.kind === 'bloc') continue;
    const own = units.filter((u) => u.factionId === f.id);
    const prev = new Map((previous[f.id] ?? []).map((c) => [c.id, c]));
    const out: Contact[] = [];
    for (const target of units) {
      if (target.factionId === f.id) continue;
      const sensors: Sensor[] = [];
      for (const o of own) {
        if (o.zoneId !== target.zoneId && distanceKm(o.location, target.location) > Math.max(...o.sensors.map((x) => x.rangeKm), 0)) continue;
        for (const x of o.sensors) sensors.push({ quality: x.quality * (o.readiness / 100), source: x.type === 'sonar' ? 'sonar' : x.type === 'esm' ? 'sigint' : x.type === 'eo' ? 'eo' : 'radar', asw: x.type === 'sonar' || o.type === 'mpa' });
      }
      for (const a of f.isrAssets) {
        if (!a.coverage.includes(target.zoneId)) continue;
        sensors.push({ quality: a.quality + (a.tasking === target.zoneId ? D.taskingBonus : 0), source: ISR_SOURCE[a.type], asw: a.type === 'MPA' });
      }
      if (!sensors.length) continue;
      const sub = target.domain === 'subsurface';
      const usable = sub ? sensors.filter((x) => x.asw || x.source === 'humint') : sensors;
      if (!usable.length) continue;
      const best = usable.reduce((a, b) => (b.quality > a.quality ? b : a));
      const sig = sub ? target.signature.acoustic : target.domain === 'land' ? target.signature.ir : target.signature.radar;
      const atBase = target.status === 'ready' || target.status === 'maintenance';
      let p = best.quality * (D.base + (sig / 10) * D.sigWeight) + (atBase ? 0.25 : 0);
      if (sub) p *= D.subsurfacePenalty;
      if (target.signature.emcon && best.source === 'sigint') p *= D.emconPenalty;
      p = Math.min(D.max, p);
      if (p < 0.03) continue;
      const r = ctx.rng.chance(`rilevamento ${f.id} → ${target.id} via ${best.source}`, p);
      if (!r.ok) continue;
      const confidence = +Math.min(0.95, 0.25 + best.quality * 0.6 * (sources(usable).length > 1 ? 1.2 : 1)).toFixed(2);
      const errorKm = Math.round(PARAMS.errorKm[best.source] * (1.4 - confidence));
      const id = contactId(f.id, target.id);
      const label = TYPE_LABEL[target.type];
      out.push({
        id, firstSeenTurn: prev.get(id)?.firstSeenTurn ?? ctx.turn, lastSeenTurn: ctx.turn, domain: target.domain,
        classification: confidence >= 0.75 ? `probabile ${label} (${ctx.catalog.classes[target.classId]?.name ?? target.classId})` : confidence >= 0.45 ? `possibile ${label}` : `contatto ${DOMAIN_LABEL[target.domain]} sconosciuto`,
        estFaction: confidence >= 0.5 ? target.factionId : 'unknown', confidence,
        location: jitter(target.location, errorKm, ctx.rng.next(), ctx.rng.next()), errorKm,
        estCount: target.count > 1 ? [Math.max(1, target.count - 4), target.count + 4] : undefined,
        sources: sources(usable), zoneId: target.zoneId, truthUnitId: target.id,
      });
    }
    ctx.truthContacts[f.id] = out;
  }
}

const sources = (xs: Sensor[]) => [...new Set(xs.map((x) => x.source))];
