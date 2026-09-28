import { api, ApiError } from './api-client';
import { emptyDraft, set, state } from './state/store';

const LAYERS = ['units', 'contacts', 'crises', 'infrastructure', 'lanes', 'zones', 'control'];
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
    set({ error: `${err.code === 'CAMPAIGN_LOCKED' ? '' : `${err.code ?? 'ERRORE'}: `}${err.message}${Array.isArray((err.details as { errors?: string[] })?.errors) ? ` — ${(err.details as { errors: string[] }).errors.join('; ')}` : ''}` });
  } finally { set({ busy: false }); }
}

export const openCampaign = (id: string) => guarded(async () => {
  remember(id);
  closeStream?.();
  closeStream = api.stream(id, (m) => {
    if (m.done) { void checkRunning().then((r) => { if (!r && !state.busy) void refresh(); }); return; }
    const line = m.agent ? `${m.agent}: ${m.status}` : m.phase ? `Turno ${m.turn} · ${m.phase}` : null;
    if (line) set({ progress: [...state.progress.slice(-30), line] });
  });
  set({ campaignId: id, draft: emptyDraft(), validation: null, submitted: false, progress: [], running: null });
  await refresh();
  await checkRunning();
});

let watchTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Chiede al server se sulla campagna c'è un'operazione in corso (es. un turno partito prima di ricaricare la pagina)
 * e, se sì, la segue ogni 5 s fino alla fine, poi ricarica lo stato. Restituisce true se è ancora in corso.
 */
export async function checkRunning(): Promise<boolean> {
  const id = state.campaignId;
  if (!id) return false;
  const st = await api.status(id).catch(() => null);
  if (st?.running) {
    set({ running: { op: st.op ?? 'turno', since: st.since ?? Date.now() } });
    if (!watchTimer) watchTimer = setTimeout(async () => {
      watchTimer = null;
      if (state.campaignId === id && !(await checkRunning())) await refresh().catch(() => {});
    }, 5000);
    return true;
  }
  if (state.running) set({ running: null });
  return false;
}

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
  const alive = new Set(knowledge.ownUnits.filter((u) => u.status !== 'destroyed').map((u) => u.id));
  state.selection = state.selection.filter((x) => alive.has(x));
  state.selectedUnitId = state.selection[0] ?? null;
  if (state.selectedUnitId) layerMap.ranges = await api.layer(id, 'ranges', state.selectedUnitId);
  set({ campaign, knowledge, overview, narrative: narrative.briefing ? narrative : null, previous: previous?.briefing ? previous : null, ledger, catalog, events, cmo, layers: layerMap });
}

export const createCampaign = (name: string, seed: string, opts: { debugGodView: boolean; cmoOnRequest: boolean; turnLength: 'week' | 'month' }) => guarded(async () => {
  const c = await api.create({ scenarioId: 'med-2026', name, seed: seed || undefined, ...opts });
  await openCampaign(c.id);
});

/** Seleziona un'unità; con `add` la aggiunge/toglie dalla selezione multipla. */
export const selectUnit = (unitId: string | null, add = false) => guarded(async () => {
  const selection = !unitId ? [] : add ? (state.selection.includes(unitId) ? state.selection.filter((x) => x !== unitId) : [...state.selection, unitId]) : [unitId];
  unitId = selection[0] ?? null;
  set({ selection, selectedUnitId: unitId, layers: { ...state.layers, ranges: unitId && state.campaignId ? await api.layer(state.campaignId, 'ranges', unitId) : { type: 'FeatureCollection', features: [] } } });
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
  if (await checkRunning()) return; // già in corso (altra scheda o prima di ricaricare): lo seguiamo e basta
  if (state.campaign?.phase === 'PLAYER_ORDERS' && !state.submitted) await api.submit(id, state.draft);
  set({ running: { op: 'turno', since: Date.now() }, progress: [] });
  try {
    await api.advance(id);
  } catch (e) {
    // risposta persa (timeout, rete) o turno già partito: il server va avanti da solo, la UI lo segue
    if (await checkRunning()) return;
    throw e;
  } finally {
    if (!watchTimer) set({ running: null });
  }
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

export const configure = (patch: { turnLength?: 'week' | 'month'; cmoOnRequest?: boolean }) => guarded(async () => { set({ campaign: await api.configure(state.campaignId!, patch) }); });
