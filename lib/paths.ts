import path from "node:path";

// Runtime storage is not a deployment asset; never bundle user media.
export const STORAGE_ROOT = path.resolve(/*turbopackIgnore: true*/ process.env.MOVIE_EDITOR_STORAGE_ROOT ?? path.join(process.cwd(), "storage"));
export const UPLOADS_ROOT = path.join(STORAGE_ROOT, "uploads");
export const JOBS_ROOT = path.join(STORAGE_ROOT, "jobs");
