import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

// The hosted Ubuntu runner's signed repositories use this mirror list:
// https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh
// Keep its repositories and signature verification, but prefer the official
// HTTPS archive after repeated Azure downloads exhausted the CI job budget.
const [mirrorPath, networkPath, sourcesPath] = process.argv.slice(2);
if (!mirrorPath || !networkPath || !sourcesPath || process.argv.length !== 5) {
  throw new Error("Usage: configure-ci-apt.mjs MIRROR_LIST NETWORK_CONFIG UBUNTU_SOURCES");
}
if (!/^URIs: mirror\+file:\/etc\/apt\/apt-mirrors\.txt$/m.test(readFileSync(sourcesPath, "utf8"))) {
  throw new Error("Ubuntu sources do not reference the expected runner mirror list");
}
const azure = "http://azure.archive.ubuntu.com/ubuntu/";
const archive = "https://archive.ubuntu.com/ubuntu/";
const security = "https://security.ubuntu.com/ubuntu/";
const before = `${azure}\tpriority:1\n${archive}\tpriority:2\n${security}\tpriority:3\n`;
const after = `${archive}\tpriority:1\n${azure}\tpriority:2\n${security}\tpriority:3\n`;
if (!lstatSync(mirrorPath).isFile()) throw new Error("Mirror list must be a regular file");
const current = readFileSync(mirrorPath, "utf8");
if (current !== before && current !== after) throw new Error("Unknown runner mirror configuration");

// Use the runner's documented Acquire keys, also for Playwright's nested apt.
// https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt.sh
const network = 'Acquire::Retries "1";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n';
let exists = false;
try {
  const stat = lstatSync(networkPath);
  exists = true;
  if (!stat.isFile() || readFileSync(networkPath, "utf8") !== network) {
    throw new Error("Refusing to replace an existing network configuration");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
// Validate both paths before either mutation. Never edit suites, keys, or sources.
if (!exists) writeFileSync(networkPath, network, { flag: "wx", mode: 0o644 });
if (current !== after) writeFileSync(mirrorPath, after);
process.stdout.write(after + network);
