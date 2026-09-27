import { api, ApiError } from './api-client';
import { emptyDraft, set, state } from './state/store';

const LAYERS = ['units', 'contacts', 'crises', 'infrastructure', 'lanes', 'zones'];
let closeStream: (() => void) | null = null;

function remember(id: string | null) {
  try { if (id) localStorage.setItem('wg-campaign', id); else localStorage.removeItem('wg-campaign'); } catch { /* storage non disponibile */ }
}
export function rememberedCampaign(): string | null {
  try { return localStorage.getItem('wg-campaign'); } catch { return null; }
}

async function guarded(fn: () => Promise<void>) {
  set({ busy: true, error: null });
  try { await fn(); } catch (e) {
    const err = e as ApiError;
    set({ error: `${err.code ?? 'ERRORE'}: ${err.message}${Array.isArray((err.details as { errors?: string[] })?.errors) ? ` — ${(err.details as { errors: string[] }).errors.join('; ')}` : ''}` });
  } finally { set({ busy: false }); }
}

export const openCampaign = (id: string) => guarded(async () => {
  remember(id);
  closeStream?.();
  closeStream = api.stream(id, (m) => {
    const line = m.agent ? `${m.agent}: ${m.status}` : m.phase ? `Turno ${m.turn} · ${m.phase}` : null;
    if (line) set({ progress: [...state.progress.slice(-30), line] });
  });
  set({ campaignId: id, draft: emptyDraft(), validation: null, submitted: false, progress: [] });
  await refresh();
});

export async function refresh() {
  const id = state.campaignId;
  if (!id) return;
  const campaign = await api.campaign(id);
  const t = campaign.currentTurn;
  const [knowledge, overview, narrative, previous, ledger, catalog, events, cmo, ...layers] = await Promise.all([
    api.knowledge(id), api.overview(id), api.narrative(id, t), t > 1 ? api.narrative(id, t - 1) : Promise.resolve(null), api.ledger(id), api.catalog(id),
    api.events(id, Math.max(1, t - 1)), api.cmo(id), ...LAYERS.map((l) => api.layer(id, l)),
  ]);
  const layerMap = Object.fromEntries(LAYERS.map((l, i) => [l, layers[i]!]));
  if (state.selectedUnitId) layerMap.ranges = await api.layer(id, 'ranges', state.selectedUnitId);
  set({ campaign, knowledge, overview, narrative: narrative.briefing ? narrative : null, previous: previous?.briefing ? previous : null, ledger, catalog, events, cmo, layers: layerMap });
}

export const createCampaign = (name: string, seed: string, debugGodView: boolean) => guarded(async () => {
  const c = await api.create({ scenarioId: 'med-2026', name, seed: seed || undefined, debugGodView });
  await openCampaign(c.id);
});

export const selectUnit = (unitId: string | null) => guarded(async () => {
  set({ selectedUnitId: unitId, layers: { ...state.layers, ranges: unitId && state.campaignId ? await api.layer(state.campaignId, 'ranges', unitId) : { type: 'FeatureCollection', features: [] } } });
});

export const validateDraft = () => guarded(async () => { set({ validation: await api.validate(state.campaignId!, state.draft) }); });

export const parseText = (text: string) => guarded(async () => {
  const r = await api.parse(state.campaignId!, text);
  const d = state.draft;
  set({ draft: { military: [...d.military, ...r.orders.military], diplomacy: [...d.diplomacy, ...r.orders.diplomacy], procurement: [...d.procurement, ...r.orders.procurement], statements: [...d.statements, ...r.orders.statements] }, validation: r.validation, error: r.ambiguities.length ? `Da chiarire: ${r.ambiguities.join(' · ')}` : null });
});

export const submitDraft = () => guarded(async () => {
  const r = await api.submit(state.campaignId!, state.draft);
  set({ validation: r.validation, submitted: true });
});

/** Invia la bozza (se non già inviata) ed esegue le fasi fino al prossimo input del giocatore. */
export const runTurn = () => guarded(async () => {
  const id = state.campaignId!;
  if (state.campaign?.phase === 'PLAYER_ORDERS' && !state.submitted) await api.submit(id, state.draft);
  await api.advance(id);
  set({ draft: emptyDraft(), validation: null, submitted: false });
  await refresh();
});

export const resolveCmo = (engagementId: string, body: Parameters<typeof api.aar>[2]) => guarded(async () => {
  await api.aar(state.campaignId!, engagementId, body);
  await refresh();
});

export const forkFrom = (turn: number) => guarded(async () => { const c = await api.fork(state.campaignId!, turn); await openCampaign(c.id); });
export const endCampaign = () => guarded(async () => { await api.end(state.campaignId!); await refresh(); });
export const leaveCampaign = () => { remember(null); closeStream?.(); set({ campaignId: null, campaign: null }); };
