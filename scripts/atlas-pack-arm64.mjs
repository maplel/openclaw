import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unpackAtlasArm64Archive } from "../src/infra/atlas-arm64-archive.ts";
import {
  parseRuntimeDirectoryInventory,
  runtimeDirectoryGitArgs,
} from "../src/infra/update-runtime-directories.ts";

const output = process.argv[2];
if (!output || process.platform !== "linux" || process.arch !== "arm64") {
  throw new Error("Usage on Linux ARM64: node scripts/atlas-pack-arm64.mjs <archive>");
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (args, options = {}) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", ...options });
const revision = git(["rev-parse", "HEAD"]).trim();
const archive = path.resolve(output);
const roots = parseRuntimeDirectoryInventory(
  git(runtimeDirectoryGitArgs, { maxBuffer: 64 * 1024 * 1024 }),
);
if (!roots.includes("dist") || !roots.includes("node_modules")) {
  throw new Error("The Atlas source build did not produce dist and node_modules.");
}

await fs.mkdir(path.dirname(archive), { recursive: true });
execFileSync(
  "tar",
  [
    "--create",
    "--gzip",
    "--hard-dereference",
    "--file",
    archive,
    "--directory",
    root,
    "--null",
    "-T",
    "-",
  ],
  { input: `${roots.join("\0")}\0`, stdio: ["pipe", "inherit", "inherit"] },
);

// Restore the actual bytes at a different absolute path before allowing publication.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-arm64-"));
const restored = path.join(temporary, "checkout");

async function checkGateway() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  const child = spawn(
    process.execPath,
    [
      "openclaw.mjs",
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--auth",
      "token",
      "--allow-unconfigured",
    ],
    {
      cwd: restored,
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCLAW_HOME: temporary,
        OPENCLAW_STATE_DIR: path.join(temporary, "state"),
        OPENCLAW_CONFIG_PATH: path.join(temporary, "state", "openclaw.json"),
        OPENCLAW_GATEWAY_TOKEN: randomBytes(24).toString("hex"),
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_NO_RESPAWN: "1",
      },
    },
  );
  const exited = once(child, "exit");
  try {
    for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
      const ready = await Promise.race([
        fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }).then(
          (response) => response.ok,
          () => false,
        ),
        exited.then(([exitCode]) => {
          throw new Error(`Restored ARM64 Gateway exited during startup (${exitCode}).`);
        }),
      ]);
      if (ready) {
        return;
      }
      await delay(1000);
    }
    throw new Error("Restored ARM64 Gateway did not become healthy.");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

try {
  git(["worktree", "add", "--detach", restored, revision], { stdio: "inherit" });
  await unpackAtlasArm64Archive(archive, restored);
  for (const [file, key] of [
    ["build-info.json", "commit"],
    [".buildstamp", "head"],
    [".runtime-postbuildstamp", "head"],
  ]) {
    const contents = JSON.parse(await fs.readFile(path.join(restored, "dist", file), "utf8"));
    if (contents[key] !== revision) {
      throw new Error(`${file} does not identify the archived Atlas commit.`);
    }
  }
  await fs.access(path.join(restored, "dist", "control-ui", "index.html"));
  const run = (args) =>
    execFileSync(process.execPath, args, { cwd: restored, stdio: "inherit", timeout: 60_000 });
  run(["openclaw.mjs", "--version"]);
  run(["openclaw.mjs", "gateway", "--help"]);
  // Verify the native SQLite runtime required by the Gateway.
  run([
    "--input-type=module",
    "-e",
    "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE smoke (id INTEGER)'); db.close();",
  ]);
  await checkGateway();
} finally {
  try {
    git(["worktree", "remove", "--force", restored], { stdio: "inherit" });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
