import { mkdir, readFile, readdir, rename, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JOBS_ROOT, UPLOADS_ROOT } from "@/lib/paths";
import { parseProjectDocument, type ProjectDocument } from "@/lib/editor/projectDocument";
import { assertStorageId } from "@/lib/validation";

export const DEFAULT_MAX_UPLOAD_COUNT = 20;
export const DEFAULT_MAX_JOB_COUNT = 50;
function maxCount(name: string, fallback: number) {
  const value = process.env[name];
  const n = value === undefined || value === "" ? fallback : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
export const maxUploadCount = () => maxCount("MAX_UPLOAD_COUNT", DEFAULT_MAX_UPLOAD_COUNT);
export const maxJobCount = () => maxCount("MAX_JOB_COUNT", DEFAULT_MAX_JOB_COUNT);
export class StorageRetentionError extends Error {
  constructor(message: string, public readonly status = 507) { super(message); }
}
export const RETENTION_NOTICE = "保存件数が上限に達しています。必要な素材は削除しません。不要なタブで「編集終了・素材解放」を実行してください。終了を確認できないタブや保護情報のない既存素材が残る場合、新規保存を拒否します。";

type Entry = {
  kind: "uploads" | "jobs"; owners: string[]; active: boolean;
  unknown: boolean; dependencies: string[];
};
export type SavedProject = { id: string; createdAt: string; requestDigest: string; document: ProjectDocument };
export type Registry = { projects?: Record<string, SavedProject>; version: 1; sessions: Record<string, { closed: boolean }>; entries: Record<string, Entry> };
export type StorageReservation = { id: string; kind: Entry["kind"]; active?: boolean; dependencies?: string[]; transient?: boolean };
// Next route bundles and HMR share this lock. One Next process owns a local
// storage root. A filesystem lock also fails closed if a second process races
// or a previous process crashed during a retention transaction.
const globalState = globalThis as typeof globalThis & { __movieRetentionLocks?: Map<string, Promise<unknown>> };
const locks = globalState.__movieRetentionLocks ??= new Map();
function usesBlobStorage() { return process.env.STORAGE_DRIVER?.toLowerCase() === "blob" || Boolean(process.env.BLOB_READ_WRITE_TOKEN); }
function registryPath() { return path.join(path.dirname(UPLOADS_ROOT), "retention.json"); }
function validId(id: string) { return assertStorageId("storageId", id); }
async function load(): Promise<Registry> {
  try {
    const raw = JSON.parse(await readFile(registryPath(), "utf8")) as Registry;
    if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions) || !raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) throw new Error();
    for (const [id, session] of Object.entries(raw.sessions)) {
      validId(id); if (typeof session?.closed !== "boolean") throw new Error();
    }
    for (const [id, e] of Object.entries(raw.entries)) {
      validId(id);
      if (!e || !["uploads", "jobs"].includes(e.kind) || typeof e.active !== "boolean" || typeof e.unknown !== "boolean" || !Array.isArray(e.owners) || !Array.isArray(e.dependencies)) throw new Error();
      for (const owner of e.owners) { validId(owner); if (!raw.sessions[owner] || raw.sessions[owner].closed) throw new Error(); }
      e.dependencies.forEach(validId);
    }
    if (raw.projects !== undefined && (!raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects))) throw new Error();
    for (const [id, revision] of Object.entries(raw.projects ?? {})) {
      validId(id); if (revision.id !== id || typeof revision.requestDigest !== "string") throw new Error();
      revision.document = parseProjectDocument(revision.document);
    }
    return raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {}, entries: {} };
    throw new StorageRetentionError("保護情報を読み取れません。削除・新規保存を停止しました。運用者が storage/retention.json を確認してください。", 503);
  }
}
export async function saveRetentionRegistry(registry: Registry) {
  const tmp = `${registryPath()}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(registryPath()), { recursive: true });
    const file = await open(tmp, "wx");
    try { await file.writeFile(JSON.stringify(registry), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(tmp, registryPath());
    const dir = await open(path.dirname(registryPath()), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new StorageRetentionError("保護情報を保存できません。新規保存・素材解放を中止しました。", 503);
  }
}

export function retentionTransaction<T>(fn: (r: Registry) => Promise<T>): Promise<T> {
  const key = registryPath();
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const lock = `${key}.lock`;
    let acquired = false;
    try {
      await mkdir(path.dirname(key), { recursive: true });
      try { await mkdir(lock); acquired = true; }
      catch { throw new StorageRetentionError("保護情報がロックされています。削除・新規保存を停止しました。継続する場合は運用者が他の処理の終了を確認してください。", 503); }
      return await fn(await load());
    } finally { if (acquired) await rm(lock, { recursive: true }); }
  });
  locks.set(key, next);
  return next;
}
export async function listStorageDirsSortedByMtimeAsc(root: string) {
  try {
    const rows = [];
    for (const name of await readdir(root)) {
      try { validId(name); } catch { continue; }
      const absPath = path.join(root, name);
      try {
        const info = await stat(absPath);
        if (info.isDirectory()) rows.push({ id: name, absPath, mtimeMs: info.mtimeMs });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return rows.sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new StorageRetentionError("ストレージ一覧を確認できません。削除・新規保存を停止しました。", 503);
  }
}
function openSession(r: Registry, sessionId: string) {
  validId(sessionId);
  if (r.sessions[sessionId]?.closed) throw new StorageRetentionError("この編集セッションは終了しています。ページを再読み込みしてください。", 409);
  r.sessions[sessionId] ??= { closed: false };
}
async function collect(r: Registry, keepIds: readonly string[] = []) {
  const protectedIds = new Set(keepIds);
  for (const revision of Object.values(r.projects ?? {})) for (const asset of revision.document.project.assets) protectedIds.add(asset.media.id);
  for (const [id, e] of Object.entries(r.entries)) {
    if (e.unknown || e.active || e.owners.length) protectedIds.add(id);
    if (e.active) e.dependencies.forEach(id => protectedIds.add(id));
  }
  const removed = { uploadsRemoved: [] as string[], jobsRemoved: [] as string[] };
  for (const kind of ["uploads", "jobs"] as const) {
    for (const row of await listStorageDirsSortedByMtimeAsc(kind === "uploads" ? UPLOADS_ROOT : JOBS_ROOT)) {
      // Missing/old ownership is uncertainty, never evidence of unreferenced data.
      const entry = r.entries[row.id];
      if (!entry || entry.kind !== kind || protectedIds.has(row.id)) continue;
      await rm(row.absPath, { recursive: true });
      removed[kind === "uploads" ? "uploadsRemoved" : "jobsRemoved"].push(row.id);
      delete r.entries[row.id];
    }
  }
  const remaining = new Set((await Promise.all([listStorageDirsSortedByMtimeAsc(UPLOADS_ROOT), listStorageDirsSortedByMtimeAsc(JOBS_ROOT)])).flat().map(row => row.id));
  for (const [id, e] of Object.entries(r.entries)) {
    if (!remaining.has(id) && !e.active && !e.unknown && !e.owners.length && !protectedIds.has(id)) delete r.entries[id];
  }
  return removed;
}
async function counts(r: Registry) {
  const [uploads, jobs] = await Promise.all([listStorageDirsSortedByMtimeAsc(UPLOADS_ROOT), listStorageDirsSortedByMtimeAsc(JOBS_ROOT)]);
  const uploadIds = new Set(uploads.map(row => row.id)), jobIds = new Set(jobs.map(row => row.id));
  for (const [id, e] of Object.entries(r.entries)) (e.kind === "uploads" ? uploadIds : jobIds).add(id);
  return { uploadsCount: uploadIds.size, jobsCount: jobIds.size };
}
export function storageRetentionStatus() {
  return retentionTransaction(async r => {
    const count = await counts(r);
    return { ...count, ...(count.uploadsCount >= maxUploadCount() || count.jobsCount >= maxJobCount() ? { warning: RETENTION_NOTICE } : {}) };
  });
}
export function reserveStorage(resources: StorageReservation[], sessionId?: string) {
  return retentionTransaction(async r => {
    if (sessionId) openSession(r, sessionId);
    for (const resource of resources) { validId(resource.id); resource.dependencies?.forEach(validId); }
    await collect(r);
    const count = await counts(r);
    const uploads = resources.filter(x => x.kind === "uploads").length;
    const jobs = resources.length - uploads;
    if ((uploads && count.uploadsCount + uploads > maxUploadCount()) || (jobs && count.jobsCount + jobs > maxJobCount())) {
      await saveRetentionRegistry(r);
      throw new StorageRetentionError(RETENTION_NOTICE);
    }
    for (const resource of resources) {
      if (r.entries[resource.id]) throw new StorageRetentionError("保存IDが重複しています。", 409);
      r.entries[resource.id] = { kind: resource.kind, owners: sessionId ? [sessionId] : [], active: resource.active ?? false,
        unknown: (!sessionId && !resource.transient) || (resource.kind === "uploads" && usesBlobStorage()), dependencies: resource.dependencies ?? [] };
    }
    await saveRetentionRegistry(r);
  });
}
export function protectStorageSession(sessionId: string, keepIds: readonly string[]) {
  return retentionTransaction(async r => {
    openSession(r, sessionId);
    for (const id of keepIds) {
      validId(id);
      const entry = r.entries[id];
      if (entry && !entry.owners.includes(sessionId)) entry.owners.push(sessionId);
    }
    // Additive by design: out-of-order updates cannot unpin an Undo/Redo source.
    await saveRetentionRegistry(r);
  });
}
export function releaseStorageSession(sessionId: string) {
  return retentionTransaction(async r => {
    validId(sessionId); r.sessions[sessionId] = { closed: true };
    for (const entry of Object.values(r.entries)) entry.owners = entry.owners.filter(owner => owner !== sessionId);
    // Persist the explicit release before any deletion; never expire a tab.
    await saveRetentionRegistry(r); const result = await collect(r); await saveRetentionRegistry(r); return result;
  });
}
export function finishStorageJob(id: string) {
  return retentionTransaction(async r => { if (r.entries[id]) r.entries[id].active = false; await saveRetentionRegistry(r); });
}
export function cancelStorageReservations(ids: readonly string[]) {
  return retentionTransaction(async r => {
    // Only the failed request's newly allocated IDs may be discarded.
    for (const id of ids) {
      const entry = r.entries[id];
      if (!entry) continue;
      entry.active = false;
      // A failed put/probe does not prove that the Blob original was removed.
      // Keep even unwritten reservations until an operator can verify them.
      entry.unknown = entry.kind === "uploads" && usesBlobStorage();
      entry.owners = [];
    }
    await saveRetentionRegistry(r); await collect(r); await saveRetentionRegistry(r);
  });
}
export function pruneAllStorage(keepIds: readonly string[]) {
  return retentionTransaction(async r => { keepIds.forEach(validId); const result = await collect(r, keepIds); await saveRetentionRegistry(r); const count = await counts(r);
    return { ...result, ...(count.uploadsCount >= maxUploadCount() || count.jobsCount >= maxJobCount() ? { warning: RETENTION_NOTICE } : {}) }; });
}
export async function pruneUploadStorage(keepIds: readonly string[] = []) { return { removedIds: (await pruneAllStorage(keepIds)).uploadsRemoved }; }
export async function pruneJobsStorage(keepIds: readonly string[] = []) { return { removedIds: (await pruneAllStorage(keepIds)).jobsRemoved }; }

/** Caller holds the same lock used by collection; file validation must run here too. */
export function retainProjectSession(r: Registry, sessionId: string, resources: { id: string; kind: "uploads" | "jobs" }[]) {
  openSession(r, sessionId);
  for (const { id, kind } of resources) {
    validId(id);
    const entry = r.entries[id] ??= { kind, owners: [], active: false, unknown: true, dependencies: [] };
    if (entry.kind !== kind) throw new StorageRetentionError("素材参照が競合しています。", 409);
    if (!entry.owners.includes(sessionId)) entry.owners.push(sessionId);
  }
}
