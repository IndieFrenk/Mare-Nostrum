import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import { api, ApiError, type LetterAction, type LetterTone } from './api-client';
import { emptyDraft, set, state } from './state/store';

const LAYERS = ['units', 'contacts', 'crises', 'infrastructure', 'lanes', 'zones', 'control'];
let closeStream: (() => void) | null = null;

function remember(id: string | null) {
  if (id) safeStorageSet('wg-campaign', id); else safeStorageRemove('wg-campaign');
}
export function rememberedCampaign(): string | null {
  return safeStorageGet('wg-campaign');
}

async function guarded(fn: () => Promise<void>) {
  set({ busy: true, error: null });
  try { await fn(); } catch (e) {
    const err = e as ApiError;
    set({ error: `${err.code === 'CAMPAIGN_LOCKED' ? '' : `${err.code ?? 'ERRORE'}: `}${err.message}${Array.isArray((err.details as { errors?: string[] })?.errors) ? ` — ${(err.details as { errors: string[] }).errors.join('; ')}` : ''}` });
  } finally { set({ busy: false }); }
}

let llmTimer: ReturnType<typeof setInterval> | null = null;
/** Stato dei modelli per il pallino della barra in alto; `fresh` salta la cache di 30 s del server. */
export async function checkLlm(fresh = false) {
  const llm = await api.llmStatus(state.campaignId, fresh).catch(() => null);
  set({ llm });
  return llm;
}
/** true se ▶ va bloccato: modelli irraggiungibili e server che non gioca senza (WARGAME_ALLOW_OFFLINE non impostato) */
export const llmBlocked = (s = state) => !!s.llm && !s.llm.reachable && !s.llm.offlineAllowed;

export const openCampaign = (id: string) => guarded(async () => {
  remember(id);
  if (!llmTimer) llmTimer = setInterval(() => { if (state.campaignId) void checkLlm(); }, 60_000);
  void checkLlm();
  closeStream?.();
  closeStream = api.stream(id, (m) => {
    if (m.done) { void checkRunning().then((r) => { if (!r && !state.busy) void refresh(); }); return; }
    const line = m.agent ? `${m.agent}: ${m.status}` : m.phase ? `Turno ${m.turn} · ${m.phase}` : null;
    if (line) set({ progress: [...state.progress.slice(-30), line] });
  });
  set({ campaignId: id, draft: emptyDraft(), validation: null, submitted: false, progress: [], running: null, lettersSeen: seenLetters(id) });
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
  const [knowledge, overview, narrative, previous, ledger, catalog, events, cmo, letters, ...layers] = await Promise.all([
    api.knowledge(id), api.overview(id), api.narrative(id, t), t > 1 ? api.narrative(id, t - 1) : Promise.resolve(null), api.ledger(id), api.catalog(id),
    api.events(id, Math.max(1, t - 1)), api.cmo(id), api.letters(id), ...LAYERS.map((l) => api.layer(id, l)),
  ]);
  const layerMap = Object.fromEntries(LAYERS.map((l, i) => [l, layers[i]!]));
  const alive = new Set(knowledge.ownUnits.filter((u) => u.status !== 'destroyed').map((u) => u.id));
  state.selection = state.selection.filter((x) => alive.has(x));
  state.selectedUnitId = state.selection[0] ?? null;
  if (state.selectedUnitId) layerMap.ranges = await api.layer(id, 'ranges', state.selectedUnitId);
  set({ campaign, knowledge, overview, narrative: narrative.briefing ? narrative : null, previous: previous?.briefing ? previous : null, ledger, catalog, events, cmo, letters, layers: layerMap });
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
  let r: Awaited<ReturnType<typeof api.parse>>;
  try { r = await api.parse(state.campaignId!, text); } catch (e) { if ((e as ApiError).code === 'LLM_UNREACHABLE') void checkLlm(true); throw e; }
  const d = state.draft;
  const names = r.recognized.map((x) => `${x.alias} → ${x.id}`);
  const stances = r.stanceOrders.map((x) => `${x.stance}${x.zoneId ? ` in ${x.zoneId}` : ''}`);
  const parseNote = [names.length ? `Nomi riconosciuti: ${names.join(' · ')}` : '', stances.length ? `Unità scelte dallo stato maggiore per: ${stances.join(', ')}` : ''].filter(Boolean).join('\n') || null;
  set({ draft: { military: [...d.military, ...r.orders.military], diplomacy: [...d.diplomacy, ...r.orders.diplomacy], procurement: [...d.procurement, ...r.orders.procurement], statements: [...d.statements, ...r.orders.statements] }, validation: r.validation, parseNote, error: r.ambiguities.length ? `Da chiarire: ${r.ambiguities.join(' · ')}` : null });
});

export const submitDraft = () => guarded(async () => {
  const r = await api.submit(state.campaignId!, state.draft);
  set({ validation: r.validation, submitted: true });
});

/** Invia la bozza (se non già inviata) ed esegue le fasi fino al prossimo input del giocatore. */
export const runTurn = () => guarded(async () => {
  const id = state.campaignId!;
  if (await checkRunning()) return; // già in corso (altra scheda o prima di ricaricare): lo seguiamo e basta
  // modelli spenti: niente turno tutto in dottrina (il server lo rifiuterebbe comunque con 503)
  const llm = await checkLlm();
  if (llm && !llm.reachable && !llm.offlineAllowed) { set({ error: `I modelli non rispondono: accendi il PC con Ollama (${llm.baseUrl}${llm.error ? ` — ${llm.error}` : ''}).` }); return; }
  if (state.campaign?.phase === 'PLAYER_ORDERS' && !state.submitted) await api.submit(id, state.draft);
  set({ running: { op: 'turno', since: Date.now() }, progress: [] });
  try {
    await api.advance(id);
  } catch (e) {
    if ((e as ApiError).code === 'LLM_UNREACHABLE') { void checkLlm(true); throw e; }
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

// ——— lettere ———

function seenLetters(id: string): string[] {
  try { return JSON.parse(safeStorageGet(`wg-letters-seen-${id}`) ?? '[]') as string[]; } catch { return []; }
}
/** Segna come lette le lettere ricevute (solo in questo browser). */
export function markLettersSeen(ids: string[]) {
  const id = state.campaignId;
  if (!id || ids.every((x) => state.lettersSeen.includes(x))) return;
  const lettersSeen = [...new Set([...state.lettersSeen, ...ids])];
  safeStorageSet(`wg-letters-seen-${id}`, JSON.stringify(lettersSeen));
  set({ lettersSeen });
}
export const unreadLetters = () => state.letters.filter((l) => l.to === state.campaign?.playerFaction && !state.lettersSeen.includes(l.id));

/** Bozza scritta dall'LLM a nome dell'Italia (non cambia lo stato): torna al chiamante per la revisione. */
export async function draftLetter(b: { target: string; gist: string; tone: LetterTone; inReplyTo?: string }) {
  let out: Awaited<ReturnType<typeof api.draftLetter>> | null = null;
  await guarded(async () => { out = await api.draftLetter(state.campaignId!, b); });
  return out as Awaited<ReturnType<typeof api.draftLetter>> | null;
}

/** La lettera entra nella bozza degli ordini e parte col turno (validatore: al massimo 2 per turno). */
export function queueLetter(l: LetterAction) {
  set({ draft: { ...state.draft, diplomacy: [...state.draft.diplomacy, l] }, validation: null, submitted: false });
}
