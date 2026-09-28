import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { z, type ZodType } from 'zod';
import * as S from '../schemas/index.js';
import { migrate } from './migrations/index.js';
import type { AgentDecision, AgentMemory, Campaign, Contact, DiceRoll, DiploLetter, FactionKnowledge, FactionOrders, GameEvent, LedgerEntry, LlmCall, TurnNarrative, WorldState } from '../schemas/index.js';

const pad = (n: number) => String(n).padStart(4, '0');

/** Interfaccia astratta: il motore dipende solo da questa (swap futuro verso SQLite). */
export interface Store {
  listCampaigns(): Promise<{ id: string; name: string; parent: Campaign['parent'] }[]>;
  getCampaign(id: string): Promise<Campaign>;
  saveCampaign(c: Campaign): Promise<void>;
  getState(id: string, turn?: number): Promise<WorldState>;
  saveState(id: string, s: WorldState, snapshotTurn?: number): Promise<void>;
  getEvents(id: string, turn: number): Promise<GameEvent[]>;
  appendEvents(id: string, turn: number, e: GameEvent[]): Promise<void>;
  appendRolls(id: string, turn: number, r: DiceRoll[]): Promise<void>;
  getRolls(id: string, turn: number): Promise<DiceRoll[]>;
  appendLedger(id: string, e: LedgerEntry[]): Promise<void>;
  getLedger(id: string): Promise<LedgerEntry[]>;
  getKnowledge(id: string, faction: string, turn: number): Promise<FactionKnowledge | null>;
  saveKnowledge(id: string, k: FactionKnowledge): Promise<void>;
  getOrders(id: string, turn: number, faction: string): Promise<FactionOrders | null>;
  saveOrders(id: string, o: FactionOrders): Promise<void>;
  getDecision(id: string, turn: number, faction: string): Promise<AgentDecision | null>;
  saveDecision(id: string, d: AgentDecision): Promise<void>;
  getMemory(id: string, faction: string): Promise<AgentMemory | null>;
  saveMemory(id: string, m: AgentMemory): Promise<void>;
  getNarrative(id: string, turn: number): Promise<TurnNarrative | null>;
  saveNarrative(id: string, id2: number, n: TurnNarrative): Promise<void>;
  appendLlmCalls(id: string, turn: number, c: LlmCall[]): Promise<void>;
  getLetters(id: string, turn: number): Promise<DiploLetter[]>;
  appendLetters(id: string, turn: number, l: DiploLetter[]): Promise<void>;
  withLock<T>(id: string, fn: () => Promise<T>, op?: string): Promise<T>;
  /** Chi tiene il lock della campagna (questo processo o un altro ancora vivo), o null. */
  lockInfo(id: string): Promise<LockInfo | null>;
  fork(id: string, fromTurn: number, newId: string): Promise<Campaign>;
}

export interface LockInfo { op: string; since: number; pid: number }
export class LockError extends Error {
  code = 'CAMPAIGN_LOCKED';
  constructor(message: string, public details?: LockInfo) { super(message); }
}

const LOCK_OPS: Record<string, string> = { turno: 'un turno è in corso', cmo: 'si sta registrando un ingaggio CMO', config: 'si sta cambiando la configurazione' };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });

export class JsonStore implements Store {
  constructor(readonly root: string) {}

  dir(id: string, ...p: string[]) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`id campagna non valido: ${id}`);
    return path.join(this.root, id, ...p);
  }

  private async write(file: string, data: unknown, schema?: ZodType) {
    if (schema) schema.parse(data);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, file);
  }

  private async read<T>(file: string, schema: ZodType<T>): Promise<T | null> {
    if (!existsSync(file)) return null;
    return schema.parse(migrate(JSON.parse(await fs.readFile(file, 'utf8'))));
  }

  private async append(file: string, rows: unknown[], schema: ZodType) {
    if (!rows.length) return;
    rows.forEach((r) => schema.parse(r));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  private async readLines<T>(file: string, schema: ZodType<T>): Promise<T[]> {
    if (!existsSync(file)) return [];
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => schema.parse(migrate(JSON.parse(l))));
  }

  private must<T>(v: T | null, what: string): T {
    if (v === null) throw Object.assign(new Error(`${what} non trovato`), { code: 'NOT_FOUND' });
    return v;
  }

  async listCampaigns() {
    const idx = await this.read(path.join(this.root, 'index.json'), S.Campaign.pick({ id: true, name: true, parent: true }).array());
    return idx ?? [];
  }

  async getCampaign(id: string) { return this.must(await this.read(this.dir(id, 'campaign.json'), S.Campaign), `campagna ${id}`); }

  async saveCampaign(c: Campaign) {
    await this.write(this.dir(c.id, 'campaign.json'), c, S.Campaign);
    const idx = (await this.listCampaigns()).filter((x) => x.id !== c.id);
    idx.push({ id: c.id, name: c.name, parent: c.parent });
    await this.write(path.join(this.root, 'index.json'), idx);
  }

  async getState(id: string, turn?: number) {
    const f = turn === undefined ? this.dir(id, 'state', 'current.json') : this.dir(id, 'state', `turn-${pad(turn)}.json`);
    return this.must(await this.read(f, S.WorldState), `stato ${id}/${turn ?? 'current'}`);
  }

  async saveState(id: string, s: WorldState, snapshotTurn?: number) {
    await this.write(this.dir(id, 'state', 'current.json'), s, S.WorldState);
    if (snapshotTurn !== undefined) await this.write(this.dir(id, 'state', `turn-${pad(snapshotTurn)}.json`), s);
  }

  getEvents(id: string, turn: number) { return this.readLines(this.dir(id, 'events', `turn-${pad(turn)}.jsonl`), S.GameEvent); }
  appendEvents(id: string, turn: number, e: GameEvent[]) { return this.append(this.dir(id, 'events', `turn-${pad(turn)}.jsonl`), e, S.GameEvent); }
  getRolls(id: string, turn: number) { return this.readLines(this.dir(id, 'rolls', `turn-${pad(turn)}.jsonl`), S.DiceRoll); }
  appendRolls(id: string, turn: number, r: DiceRoll[]) { return this.append(this.dir(id, 'rolls', `turn-${pad(turn)}.jsonl`), r, S.DiceRoll); }
  getLedger(id: string) { return this.readLines(this.dir(id, 'ledger.jsonl'), S.LedgerEntry); }
  appendLedger(id: string, e: LedgerEntry[]) { return this.append(this.dir(id, 'ledger.jsonl'), e, S.LedgerEntry); }
  getKnowledge(id: string, f: string, turn: number) { return this.read(this.dir(id, 'knowledge', f, `turn-${pad(turn)}.json`), S.FactionKnowledge); }
  saveKnowledge(id: string, k: FactionKnowledge) { return this.write(this.dir(id, 'knowledge', k.factionId, `turn-${pad(k.turn)}.json`), k, S.FactionKnowledge); }
  getOrders(id: string, turn: number, f: string) { return this.read(this.dir(id, 'orders', `turn-${pad(turn)}`, `${f}.json`), S.FactionOrders); }
  saveOrders(id: string, o: FactionOrders) { return this.write(this.dir(id, 'orders', `turn-${pad(o.turn)}`, `${o.factionId}.json`), o, S.FactionOrders); }
  getDecision(id: string, turn: number, f: string) { return this.read(this.dir(id, 'decisions', `turn-${pad(turn)}`, `${f}.json`), S.AgentDecision); }
  saveDecision(id: string, d: AgentDecision) { return this.write(this.dir(id, 'decisions', `turn-${pad(d.turn)}`, `${d.factionId}.json`), d, S.AgentDecision); }
  getMemory(id: string, f: string) { return this.read(this.dir(id, 'memory', `${f}.json`), S.AgentMemory); }
  async saveMemory(id: string, m: AgentMemory) {
    await this.write(this.dir(id, 'memory', `${m.factionId}.json`), m, S.AgentMemory);
    await this.write(this.dir(id, 'memory', 'history', `${m.factionId}-turn-${pad(m.updatedTurn)}.json`), m);
  }
  getNarrative(id: string, turn: number) { return this.read(this.dir(id, 'narrative', `turn-${pad(turn)}.json`), S.TurnNarrative); }
  saveNarrative(id: string, turn: number, n: TurnNarrative) { return this.write(this.dir(id, 'narrative', `turn-${pad(turn)}.json`), n, S.TurnNarrative); }
  appendLlmCalls(id: string, turn: number, c: LlmCall[]) { return this.append(this.dir(id, 'llm-log', `turn-${pad(turn)}.jsonl`), c, S.LlmCall); }
  /** Lettere tra capi di Stato consegnate nel turno (tutte: la visibilità la filtrano knowledge e API). */
  getLetters(id: string, turn: number) { return this.readLines(this.dir(id, 'letters', `turn-${pad(turn)}.jsonl`), S.DiploLetter); }
  appendLetters(id: string, turn: number, l: DiploLetter[]) { return this.append(this.dir(id, 'letters', `turn-${pad(turn)}.jsonl`), l, S.DiploLetter); }

  /** Verità dei contatti (solo motore, mai esposta via API). */
  async saveTruthContacts(id: string, turn: number, c: Record<string, Contact[]>) { await this.write(this.dir(id, 'truth', `turn-${pad(turn)}.json`), c); }
  async getTruthContacts(id: string, turn: number): Promise<Record<string, Contact[]>> {
    return (await this.read(this.dir(id, 'truth', `turn-${pad(turn)}.json`), z.record(z.string(), S.Contact.array()))) ?? {};
  }

  async getCmo(id: string, turn: number, engagementId: string) {
    return this.read(this.dir(id, 'cmo', `turn-${pad(turn)}`, `${engagementId}.json`), z.record(z.string(), z.unknown()));
  }

  async saveCmo(id: string, turn: number, engagementId: string, data: unknown) {
    await this.write(this.dir(id, 'cmo', `turn-${pad(turn)}`, `${engagementId}.json`), data);
  }

  /** Lock tenuti da questo processo: un secondo withLock sulla stessa campagna fallisce subito. */
  private held = new Map<string, LockInfo>();

  /**
   * Lock di campagna su file (`.lock`), valido per tutta l'operazione anche se dura molti minuti (turni con LLM veri):
   * chi lo tiene lo rinnova ogni 20 s. È considerato abbandonato solo se il processo che lo tiene è morto
   * o ha smesso di rinnovarlo da più di `staleMs`.
   */
  async withLock<T>(id: string, fn: () => Promise<T>, op = 'turno', staleMs = 90_000): Promise<T> {
    const busy = (h: LockInfo) => new LockError(`Campagna occupata: ${LOCK_OPS[h.op] ?? h.op} (dalle ${hhmm(h.since)}). Attendi che finisca.`, h);
    const mine = this.held.get(id);
    if (mine) throw busy(mine);
    const lock = this.dir(id, '.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    const info: LockInfo = { op, since: Date.now(), pid: process.pid };
    const body = () => JSON.stringify({ ...info, at: Date.now() });
    try {
      await fs.writeFile(lock, body(), { flag: 'wx' });
    } catch {
      const other = JSON.parse(await fs.readFile(lock, 'utf8').catch(() => '{"at":0}')) as Partial<LockInfo> & { at: number };
      const alive = other.pid !== undefined && other.pid !== process.pid && pidAlive(other.pid);
      if (alive && Date.now() - other.at < staleMs) throw busy({ op: other.op ?? 'turno', since: other.since ?? other.at, pid: other.pid! });
      await fs.writeFile(lock, body()); // abbandonato (processo morto, riavvio del server o rinnovo fermo)
    }
    this.held.set(id, info);
    const beat = setInterval(() => { fs.writeFile(lock, body()).catch(() => {}); }, 20_000);
    beat.unref();
    try { return await fn(); } finally {
      clearInterval(beat);
      this.held.delete(id);
      await fs.rm(lock, { force: true });
    }
  }

  async lockInfo(id: string): Promise<LockInfo | null> {
    const mine = this.held.get(id);
    if (mine) return mine;
    const other = JSON.parse(await fs.readFile(this.dir(id, '.lock'), 'utf8').catch(() => 'null')) as (Partial<LockInfo> & { at: number }) | null;
    if (!other?.pid || other.pid === process.pid || !pidAlive(other.pid) || Date.now() - other.at >= 90_000) return null;
    return { op: other.op ?? 'turno', since: other.since ?? other.at, pid: other.pid };
  }

  /** Copia i file fino a fromTurn (snapshot di chiusura) e riparte dall'apertura di fromTurn+1. */
  async fork(id: string, fromTurn: number, newId: string): Promise<Campaign> {
    const src = await this.getCampaign(id);
    const snap = await this.getState(id, fromTurn);
    const keep = (name: string) => { const m = name.match(/turn-(\d{4})/); return !m || Number(m[1]) <= fromTurn; };
    const copy = async (from: string, to: string) => {
      for (const e of await fs.readdir(from, { withFileTypes: true })) {
        if (e.name === '.lock' || e.name === 'campaign.json' || e.name === 'current.json' || !keep(e.name)) continue;
        const a = path.join(from, e.name); const b = path.join(to, e.name);
        if (e.isDirectory()) { await fs.mkdir(b, { recursive: true }); await copy(a, b); }
        else await fs.copyFile(a, b);
      }
    };
    await fs.mkdir(this.dir(newId), { recursive: true });
    await copy(this.dir(id), this.dir(newId));
    await fs.rm(this.dir(newId, 'memory'), { recursive: true, force: true }).catch(() => {});
    const srcHist = this.dir(id, 'memory', 'history');
    if (existsSync(srcHist)) {
      const latest = new Map<string, string>();
      for (const f of (await fs.readdir(srcHist)).sort()) if (keep(f)) latest.set(f.replace(/-turn-\d+\.json$/, ''), f);
      for (const f of latest.values()) {
        const m = await this.read(path.join(srcHist, f), S.AgentMemory);
        if (m) await this.saveMemory(newId, m);
      }
    }
    const ledger = (await this.getLedger(newId)).filter((l) => l.turn <= fromTurn);
    await fs.rm(this.dir(newId, 'ledger.jsonl'), { force: true });
    await this.appendLedger(newId, ledger);
    await this.write(this.dir(newId, 'state', 'current.json'), snap);
    const now = new Date().toISOString();
    const c: Campaign = { ...src, id: newId, name: `${src.name} (ramo T${fromTurn})`, createdAt: now, updatedAt: now,
      currentTurn: fromTurn, phase: 'CLOSED', date: snap.date, parent: { campaignId: id, turn: fromTurn }, status: 'active',
      rngCursor: snap.rngCursor };
    await this.saveCampaign(c);
    return c;
  }
}
