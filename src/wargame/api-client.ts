import type { AfterActionReport, AgentDecision, Campaign, CatalogItem, CmoPackage, DiceRoll, DiploLetter, FactionKnowledge, LetterTone, GameEvent, LedgerEntry, OrdersBody, PendingDelivery, Relation, TurnNarrative, WorldState } from '../../wargame-server/src/schemas/index';

export type * from '../../wargame-server/src/schemas/index';

const BASE = `${import.meta.env.VITE_WARGAME_API ?? 'http://127.0.0.1:8787'}/api/wg`;

export class ApiError extends Error { constructor(public code: string, message: string, public details?: unknown) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(data?.error?.code ?? String(res.status), data?.error?.message ?? res.statusText, data?.error?.details);
  return data as T;
}

export interface Validation { valid: boolean; errors: string[]; risks: string[]; estCost: number }
export interface Overview { campaign: Campaign; indicators: WorldState['globalIndicators']; relations: Record<string, Relation>; pendingDeliveries: PendingDelivery[]; pendingCmo: string[]; infrastructure: { id: string; name: string; type: string; status: string; flowShareIta?: number }[] }
export interface CatalogView { budget: number; items: (CatalogItem & { available: boolean })[]; bases: { id: string; name: string }[]; deliveries: PendingDelivery[] }
export interface PendingCmo { id: string; turn: number; zoneId: string; scale: string; cmoPackage: CmoPackage }
export interface Postmortem { turn: number; decisions: AgentDecision[]; rolls: DiceRoll[]; events: GameEvent[]; state: WorldState; branches: { id: string; name: string; parent: Campaign['parent'] }[] }
export type FC = GeoJSON.FeatureCollection;
export interface LetterDraft { target: string; inReplyTo?: string; subject: string; body: string; tone: LetterTone; source: 'ai' | 'template'; model: string; errors: string[] }

const c = (id: string) => `/campaigns/${encodeURIComponent(id)}`;
export const api = {
  scenarios: () => req<{ id: string; name: string }[]>('GET', '/scenarios'),
  campaigns: () => req<{ id: string; name: string; parent: Campaign['parent'] }[]>('GET', '/campaigns'),
  create: (b: { scenarioId: string; name: string; seed?: string; debugGodView?: boolean; cmoOnRequest?: boolean; turnLength?: 'week' | 'month' }) => req<Campaign>('POST', '/campaigns', b),
  configure: (id: string, b: { turnLength?: 'week' | 'month'; cmoOnRequest?: boolean }) => req<Campaign>('POST', `${c(id)}/config`, b),
  campaign: (id: string) => req<Campaign>('GET', c(id)),
  overview: (id: string) => req<Overview>('GET', `${c(id)}/overview`),
  knowledge: (id: string) => req<FactionKnowledge>('GET', `${c(id)}/knowledge`),
  narrative: (id: string, turn: number) => req<TurnNarrative | { turn: number; briefing: null; news: [] }>('GET', `${c(id)}/narrative/${turn}`),
  ledger: (id: string) => req<LedgerEntry[]>('GET', `${c(id)}/ledger`),
  catalog: (id: string) => req<CatalogView>('GET', `${c(id)}/catalog`),
  events: (id: string, turn: number) => req<GameEvent[]>('GET', `${c(id)}/events?turn=${turn}`),
  parse: (id: string, text: string) => req<{ orders: OrdersBody; ambiguities: string[]; validation: Validation }>('POST', `${c(id)}/orders/parse`, { text }),
  validate: (id: string, o: OrdersBody) => req<Validation>('POST', `${c(id)}/orders/validate`, o),
  submit: (id: string, o: OrdersBody) => req<{ validation: Validation }>('POST', `${c(id)}/orders`, o),
  letters: (id: string, turn?: number) => req<DiploLetter[]>('GET', `${c(id)}/letters${turn === undefined ? '' : `?turn=${turn}`}`),
  draftLetter: (id: string, b: { target: string; gist: string; tone: LetterTone; inReplyTo?: string }) => req<LetterDraft>('POST', `${c(id)}/letters/draft`, b),
  advance: (id: string) => req<Campaign>('POST', `${c(id)}/advance`),
  status: (id: string) => req<{ running: boolean; op: string | null; since: number | null; turn: number; phase: string }>('GET', `${c(id)}/status`),
  cmo: (id: string) => req<PendingCmo[]>('GET', `${c(id)}/cmo`),
  cmoUrl: (id: string, engagementId: string, format: 'txt' | 'json') => `${BASE}${c(id)}/cmo?format=${format}&engagementId=${encodeURIComponent(engagementId)}`,
  aar: (id: string, engagementId: string, body: AfterActionReport | { autoResolve: true }) => req<unknown>('POST', `${c(id)}/cmo/${encodeURIComponent(engagementId)}/aar`, body),
  layer: (id: string, name: string, unitId?: string) => req<FC>('GET', `${c(id)}/layers/${name}.geojson${unitId ? `?unitId=${encodeURIComponent(unitId)}` : ''}`),
  fork: (id: string, fromTurn: number) => req<Campaign>('POST', `${c(id)}/fork`, { fromTurn }),
  end: (id: string) => req<Campaign>('POST', `${c(id)}/end`),
  postmortem: (id: string, turn: number) => req<Postmortem>('GET', `${c(id)}/postmortem?turn=${turn}`),
  stream: (id: string, onMsg: (m: Record<string, unknown>) => void) => {
    const es = new EventSource(`${BASE}${c(id)}/stream`);
    es.onmessage = (e) => onMsg(JSON.parse(e.data));
    return () => es.close();
  },
};
