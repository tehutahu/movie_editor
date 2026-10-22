import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";

const before = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
const after = "https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "movie-editor-ci-apt-"));
  dirs.push(dir);
  const mirror = path.join(dir, "mirrors");
  const network = path.join(dir, "network");
  writeFileSync(mirror, before);
  writeFileSync(path.join(dir, "sources"), "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n");
  return { mirror, network };
}
function run(mirror: string, network: string) {
  return spawnSync(process.execPath, ["scripts/configure-ci-apt.mjs", mirror, network, path.join(path.dirname(mirror), "sources")], { encoding: "utf8" });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("prefers official HTTPS without removing fallback mirrors and is idempotent", () => {
  const { mirror, network } = fixture();
  expect(run(mirror, network).status).toBe(0);
  expect(readFileSync(mirror, "utf8")).toBe(after);
  expect(readFileSync(network, "utf8")).toBe('Acquire::Retries "1";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n');
  expect(run(mirror, network).status).toBe(0);
  expect(readFileSync(mirror, "utf8")).toBe(after);
});

it("rejects unknown mirrors before writing either file", () => {
  const { mirror, network } = fixture();
  const unknown = before + "https://example.invalid/\tpriority:4\n";
  writeFileSync(mirror, unknown);
  expect(run(mirror, network).status).not.toBe(0);
  expect(readFileSync(mirror, "utf8")).toBe(unknown);
  expect(() => readFileSync(network)).toThrow();
});

it("rejects a source that does not use the runner mirror list", () => {
  const { mirror, network } = fixture();
  writeFileSync(path.join(path.dirname(mirror), "sources"), "URIs: https://archive.ubuntu.com/ubuntu/\n");
  expect(run(mirror, network).status).not.toBe(0);
  expect(readFileSync(mirror, "utf8")).toBe(before);
  expect(() => readFileSync(network)).toThrow();
});

it("preserves conflicting network configuration and the original mirrors", () => {
  const { mirror, network } = fixture();
  writeFileSync(network, "existing configuration\n");
  expect(run(mirror, network).status).not.toBe(0);
  expect(readFileSync(network, "utf8")).toBe("existing configuration\n");
  expect(readFileSync(mirror, "utf8")).toBe(before);
});

it.each(["mirror", "network"])("rejects a %s symlink without editing its target", (which) => {
  const { mirror, network } = fixture();
  const target = path.join(path.dirname(mirror), "target");
  writeFileSync(target, before);
  const link = which === "mirror" ? mirror : network;
  if (which === "mirror") rmSync(mirror);
  symlinkSync(target, link);
  expect(run(mirror, network).status).not.toBe(0);
  expect(readFileSync(target, "utf8")).toBe(before);
});
