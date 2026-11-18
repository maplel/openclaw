import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ATLAS_ARM64_ASSET,
  ATLAS_ARM64_TAG_PREFIX,
  unpackAtlasArm64Archive,
} from "./atlas-arm64-archive.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";

const repository = "maplel/openclaw";

function atlasReleaseTag(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("Atlas ARM64 installation requires an exact Git commit.");
  }
  return `${ATLAS_ARM64_TAG_PREFIX}${sha}`;
}

export async function readAtlasArm64Release(sha: string, signal: AbortSignal) {
  const tag = atlasReleaseTag(sha);
  const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    redirect: "error",
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Atlas ARM64 release lookup failed (HTTP ${response.status}). ${releaseUrl}`);
  }
  const release = asNullableRecord(await response.json());
  const asset = Array.isArray(release?.assets)
    ? release.assets.map(asNullableRecord).find((entry) => entry?.name === ATLAS_ARM64_ASSET)
    : undefined;
  const url = `https://github.com/${repository}/releases/download/${tag}/${ATLAS_ARM64_ASSET}`;
  const digest = asset?.digest;
  const size = asset?.size;
  if (
    release?.tag_name !== tag ||
    release.draft !== false ||
    release.target_commitish !== sha ||
    asset?.state !== "uploaded" ||
    asset.browser_download_url !== url ||
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(digest) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new Error(`Atlas ARM64 release metadata is incomplete or mismatched. ${releaseUrl}`);
  }
  return { url, digest, size, releaseUrl };
}

export async function stageAtlasArm64Release(params: {
  root: string;
  stagingRoot: string;
  sha: string;
  timeoutMs: number;
}): Promise<void> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  const release = await readAtlasArm64Release(params.sha, signal);
  if (!release) {
    throw new Error(
      `Atlas ARM64 package has not been published. https://github.com/${repository}/releases/tag/${atlasReleaseTag(params.sha)}`,
    );
  }
  const { url, digest, size, releaseUrl } = release;
  const download = await fetch(url, { signal });
  if (!download.ok || !download.body) {
    throw new Error(`Atlas ARM64 download failed (HTTP ${download.status}). ${releaseUrl}`);
  }
  const archive = path.join(params.stagingRoot, ATLAS_ARM64_ASSET);
  const hash = createHash("sha256");
  let bytes = 0;
  const verifyStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > size) {
        callback(new Error("Atlas ARM64 download exceeds the published asset size."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      download.body,
      verifyStream,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      {
        signal,
      },
    );
    if (bytes !== size || `sha256:${hash.digest("hex")}` !== digest) {
      throw new Error("Atlas ARM64 download is incomplete or its SHA-256 does not match GitHub.");
    }
    await unpackAtlasArm64Archive(archive, params.root);
    const errors = await collectGitRuntimeErrors({ root: params.root, sha: params.sha });
    if (errors.length > 0) {
      throw new Error(`Atlas ARM64 runtime validation failed. ${errors.join(" ")}`);
    }
  } finally {
    await fs.rm(archive, { force: true });
  }
}
