import { describe, expect, it } from "vitest";

import { createJobRecord } from "@/lib/jobs";
import { GET } from "./route";

describe("GET /api/jobs/[jobId]", () => {
  it("不正な jobId は 400", async () => {
    const res = await GET(new Request("http://test/jobs/not-uuid"), {
      params: Promise.resolve({ jobId: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("存在しない UUID は 404", async () => {
    const unknownId = "00000000-0000-4000-a000-000000000099";
    const res = await GET(new Request(`http://test/jobs/${unknownId}`), {
      params: Promise.resolve({ jobId: unknownId }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/見つかりません/);
  });

  it("ジョブがあれば 200 と項目を返す", async () => {
    const job = createJobRecord("restore");
    const res = await GET(new Request(`http://test/jobs/${job.id}`), {
      params: Promise.resolve({ jobId: job.id }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.jobId).toBe(job.id);
    expect(json.kind).toBe("restore");
    expect(json.status).toBe("pending");
  });
});
