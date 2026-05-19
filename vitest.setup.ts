import { afterEach } from "vitest";
import { clearJobStoreForTests } from "@/lib/jobs";

afterEach(() => {
  delete process.env.MAX_UPLOAD_BYTES;
  clearJobStoreForTests();
});
