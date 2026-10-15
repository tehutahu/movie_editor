import { expect, it } from "vitest";
import { readProjectRequest } from "./projectHttp";
import { MAX_PROJECT_JSON_BYTES } from "./editor/projectDocument";
it("rejects invalid JSON, scalar JSON and oversized streamed requests", async () => {
  for (const body of ["{broken", "[]", "1", '"string"'])
    await expect(
      readProjectRequest(new Request("http://local", { method: "POST", body })),
    ).rejects.toThrow();
  await expect(
    readProjectRequest(
      new Request("http://local", {
        method: "POST",
        body: " ".repeat(MAX_PROJECT_JSON_BYTES + 1),
      }),
    ),
  ).rejects.toThrow(/サイズ/);
});
