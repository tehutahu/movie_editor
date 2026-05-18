import path from "node:path";

export const STORAGE_ROOT = path.join(process.cwd(), "storage");
export const UPLOADS_ROOT = path.join(STORAGE_ROOT, "uploads");
export const JOBS_ROOT = path.join(STORAGE_ROOT, "jobs");
