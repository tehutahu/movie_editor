import { isMediaClip } from "./editor/types";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveAssetInputPath } from "@/lib/assetResolve";
import {
  parseProjectDocument,
  documentToProject,
  type ProjectDocument,
  type MediaReference,
} from "@/lib/editor/projectDocument";
import {
  retentionTransaction,
  saveRetentionRegistry,
  retainProjectSession,
  StorageRetentionError,
} from "@/lib/storageRetention";
import { assertStorageId, parseAllowedAssetExtension } from "@/lib/validation";
import { persistCompletedJobForProject } from "@/lib/jobs";
import { probeImage, probeVideo } from "@/lib/ffmpeg";
import { matchesMediaDimensions } from "@/lib/videoDimensions";

function requireLocal() {
  if (
    process.env.STORAGE_DRIVER?.toLowerCase() === "blob" ||
    process.env.BLOB_READ_WRITE_TOKEN
  )
    throw new StorageRetentionError(
      "プロジェクト保存・再開はローカルストレージのみ対応しています。",
      400,
    );
}
export class MissingProjectMediaError extends Error {
  constructor(
    public readonly missing: {
      assetId: string;
      displayName: string;
      sha256: string;
      size: number;
    }[],
  ) {
    super(
      "素材が見つからないか内容が一致しません。同じバイト列のファイルを再指定してください。",
    );
  }
}
async function mediaPath(media: MediaReference) {
  return resolveAssetInputPath(
    media.kind === "job" ? { id: media.id, sourceJobId: media.id } : media.id,
  );
}
export async function fingerprint(file: string) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("素材ファイルが不正です。");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), size: info.size };
}
async function validateMedia(doc: ProjectDocument, saving: boolean) {
  const missing: MissingProjectMediaError["missing"] = [];
  for (const asset of doc.project.assets) {
    const input = await mediaPath(asset.media);
    let actual;
    if (input) {
      try {
        actual = await fingerprint(input);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (
      !actual ||
      (!saving &&
        (actual.sha256 !== asset.media.sha256 ||
          actual.size !== asset.media.size))
    ) {
      missing.push({
        assetId: asset.id,
        displayName: asset.displayName,
        sha256: asset.media.sha256,
        size: asset.media.size,
      });
      continue;
    }
    if (parseAllowedAssetExtension(input!)?.kind !== asset.kind) {
      throw new Error("素材の種類が実ファイルと一致しません。");
    }
    if (saving) Object.assign(asset.media, actual);
    // Validate against real metadata too; imported JSON cannot extend a source interval.
    const meta =
      asset.kind === "image"
        ? { ...(await probeImage(input!)), durationSec: 0 }
        : await probeVideo(input!);
    if (
      !meta.hasVideo ||
      !matchesMediaDimensions(asset, meta) ||
      (asset.kind === "video" &&
        Math.abs(asset.sourceDurationSec! - meta.durationSec) > 1 / 30)
    ) {
      throw new Error("素材のメタデータが実ファイルと一致しません。");
    }
    if (
      asset.kind === "video" &&
      (!meta.hasVideo ||
        doc.project.clips.some((c) =>
          isMediaClip(c) && c.parts.some(
            (p) =>
              p.assetId === asset.id &&
              p.sourceOutSec > meta.durationSec + 1e-6,
          ),
        ))
    )
      throw new Error("素材の実際の長さ・形式と区間が一致しません。");
  }
  if (missing.length) throw new MissingProjectMediaError(missing);
  // Complete all validation before durable job writes. Never accept in-memory-only outputs.
  for (const id of new Set(
    doc.project.assets
      .filter((a) => a.media.kind === "job")
      .map((a) => a.media.id),
  )) {
    await persistCompletedJobForProject(id);
  }
}
export async function saveProject(id: string, raw: unknown) {
  requireLocal();
  assertStorageId("保存版ID", id);
  const doc = parseProjectDocument(raw);
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(doc))
    .digest("hex");
  return retentionTransaction(async (r) => {
    if (r.deletedProjects?.[id])
      throw new StorageRetentionError(
        "この保存版IDは削除済みです。新しい保存版として保存してください。",
        409,
      );
    r.projects ??= {};
    const existing = r.projects[id];
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new StorageRetentionError(
          "保存版IDが既存の内容と競合しています。",
          409,
        );
      return existing;
    }
    if (Object.keys(r.projects).length >= 50)
      throw new StorageRetentionError(
        "保存版は上限50件です。不要な保存版を明示削除してください。",
        507,
      );
    await validateMedia(doc, true);
    const persistedDocument = parseProjectDocument(doc);
    const revision = {
      id,
      createdAt: new Date().toISOString(),
      requestDigest,
      document: persistedDocument,
    };
    r.projects[id] = revision;
    // Manifest and all media pins commit in one atomic registry rename. Old revisions survive failures.
    await saveRetentionRegistry(r);
    return revision;
  });
}
export async function listProjects() {
  requireLocal();
  return retentionTransaction(async (r) =>
    Object.values(r.projects ?? {}).map(({ id, createdAt, document }) => ({
      id,
      createdAt,
      name: document.project.exportBaseName,
    })),
  );
}
export async function readProject(id: string) {
  requireLocal();
  assertStorageId("保存版ID", id);
  return retentionTransaction(async (r) => {
    const revision = r.projects?.[id];
    if (!revision)
      throw new StorageRetentionError("保存版が見つかりません。", 404);
    return revision.document;
  });
}
export async function deleteProject(id: string) {
  requireLocal();
  assertStorageId("保存版ID", id);
  return retentionTransaction(async (r) => {
    (r.deletedProjects ??= {})[id] = true;
    if (r.projects) delete r.projects[id];
    // Removing the manifest and its pins is atomic and idempotent; collection is separate.
    await saveRetentionRegistry(r);
  });
}
export async function loadProject(
  raw: unknown,
  sessionId: string,
  replacements: unknown = {},
) {
  requireLocal();
  assertStorageId("sessionId", sessionId);
  const doc = parseProjectDocument(raw);
  if (
    !replacements ||
    typeof replacements !== "object" ||
    Array.isArray(replacements)
  )
    throw new Error("再指定の形式が不正です。");
  const map = replacements as Record<string, unknown>;
  for (const id of Object.keys(map))
    if (!doc.project.assets.some((a) => a.id === id))
      throw new Error("未知の素材の再指定です。");
  return retentionTransaction(async (r) => {
    for (const asset of doc.project.assets) {
      if (map[asset.id] !== undefined)
        asset.media = {
          ...asset.media,
          kind: "upload",
          id: assertStorageId("再指定素材ID", String(map[asset.id])),
        };
    }
    // Existence, hashes, real intervals and durable session protection share the collector lock.
    await validateMedia(doc, false);
    retainProjectSession(
      r,
      sessionId,
      doc.project.assets.map((a) => ({
        id: a.media.id,
        kind: a.media.kind === "job" ? "jobs" : "uploads",
      })),
    );
    await saveRetentionRegistry(r);
    return { project: documentToProject(doc), document: doc };
  });
}
