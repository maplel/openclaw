import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create, Header } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATLAS_ARM64_ASSET, unpackAtlasArm64Archive } from "./atlas-arm64-archive.js";
import { stageAtlasArm64Release } from "./atlas-arm64-release.js";

const sha = "ab".repeat(20);
const tag = `atlas-linux-arm64-${sha}`;
const url = `https://github.com/maplel/openclaw/releases/download/${tag}/${ATLAS_ARM64_ASSET}`;
const fetchGitHub = vi.fn<typeof fetch>();
let stagingRoot: string;
let root: string;

beforeEach(async () => {
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-release-test-"));
  root = path.join(stagingRoot, "checkout");
  await fs.mkdir(root);
  fetchGitHub.mockReset();
  vi.stubGlobal("fetch", fetchGitHub);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(stagingRoot, { force: true, recursive: true });
});

async function makeRuntimeArchive(commit = sha): Promise<Buffer> {
  const source = path.join(stagingRoot, "build");
  const dist = path.join(source, "dist");
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: commit })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: commit })),
    fs.writeFile(path.join(dist, "entry.js"), ""),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "<html></html>"),
  ]);
  const archive = path.join(stagingRoot, "built.tgz");
  await create({ cwd: source, file: archive, gzip: true }, ["dist"]);
  return fs.readFile(archive);
}

function offerArchive(body: Buffer, digest = createHash("sha256").update(body).digest("hex")) {
  fetchGitHub
    .mockResolvedValueOnce(
      Response.json({
        tag_name: tag,
        target_commitish: sha,
        draft: false,
        assets: [
          {
            name: ATLAS_ARM64_ASSET,
            state: "uploaded",
            browser_download_url: url,
            size: body.length,
            digest: `sha256:${digest}`,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(new Response(Uint8Array.from(body)));
}

const stage = () => stageAtlasArm64Release({ root, stagingRoot, sha, timeoutMs: 5000 });

describe("Atlas ARM64 release staging", () => {
  it("stages the published runtime for the exact commit", async () => {
    offerArchive(await makeRuntimeArchive());
    await stage();
    expect(fetchGitHub).toHaveBeenLastCalledWith(url, expect.any(Object));
    expect(await fs.readdir(root)).toEqual(["dist"]);
    await expect(fs.stat(path.join(stagingRoot, ATLAS_ARM64_ASSET))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to unpack a download with a different digest", async () => {
    offerArchive(await makeRuntimeArchive(), "0".repeat(64));
    await expect(stage()).rejects.toThrow("SHA-256");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a valid archive built from a different revision", async () => {
    offerArchive(await makeRuntimeArchive("0".repeat(40)));
    await expect(stage()).rejects.toThrow("runtime validation failed");
  });

  it("surfaces the release link when the package is missing", async () => {
    fetchGitHub.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(stage()).rejects.toThrow(`https://github.com/maplel/openclaw/releases/tag/${tag}`);
    expect(fetchGitHub).toHaveBeenCalledOnce();
  });

  it.each([
    ["dist/../../outside", "File", ""],
    ["node_modules/escape", "SymbolicLink", "../../outside"],
    ["scripts/replaced.mjs", "File", ""],
  ] as const)("rejects unsafe archive entry %s", async (name, type, linkpath) => {
    const header = new Header({ path: name, size: 0, type, linkpath });
    const buffer = Buffer.alloc(512 * 3);
    header.encode(buffer);
    const archive = path.join(stagingRoot, "unsafe.tar");
    await fs.writeFile(archive, buffer);
    await expect(unpackAtlasArm64Archive(archive, root)).rejects.toThrow(
      "Invalid Atlas ARM64 archive",
    );
    expect(await fs.readdir(root)).toEqual([]);
  });
});
