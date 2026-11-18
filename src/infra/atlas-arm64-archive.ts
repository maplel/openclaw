import fs from "node:fs/promises";
import path from "node:path";
import { list, extract } from "tar";
import { runtimeDirectoryFor } from "./update-runtime-directories.ts";

export const ATLAS_ARM64_ASSET = "atlas-linux-arm64.tar.gz";
export const ATLAS_ARM64_TAG_PREFIX = "atlas-linux-arm64-";

function isRelativeLink(name: string, target: string): boolean {
  const resolved = path.posix.join(path.posix.dirname(name), target);
  const suffix = target.replace(/^(?:\.\.\/)+/, "");
  return (
    target.length > 0 &&
    !/[\\\x00]/.test(target) &&
    !path.posix.isAbsolute(target) &&
    (!suffix.split("/").includes("..") || suffix === "..") &&
    resolved !== ".." &&
    !resolved.startsWith("../")
  );
}

export async function unpackAtlasArm64Archive(file: string, root: string): Promise<void> {
  const { bsize, bavail } = await fs.statfs(root, { bigint: true });
  let requiredBlocks = 0n;
  const entries = new Map<string, string>();
  let invalidEntry: string | undefined;
  await list({
    file,
    strict: true,
    onReadEntry: (entry) => {
      const name = entry.path.replace(/\/$/, "");
      const parts = name.split("/");
      if (
        !runtimeDirectoryFor(name) ||
        parts.some((part) => !part || part === "." || part === ".." || /[\\\x00]/.test(part)) ||
        entries.has(name) ||
        (entry.type !== "File" &&
          entry.type !== "Directory" &&
          (entry.type !== "SymbolicLink" || !isRelativeLink(name, entry.linkpath ?? ""))) ||
        ((entry.mode ?? 0) & 0o7000) !== 0
      ) {
        invalidEntry ??= name;
      }
      const contents = BigInt(entry.size ?? 0);
      // Reserve at least one filesystem block per entry, including metadata-only entries.
      requiredBlocks += contents === 0n ? 1n : (contents + bsize - 1n) / bsize;
      entries.set(name, entry.type);
    },
  });
  if (invalidEntry !== undefined || entries.size === 0) {
    throw new Error(`Invalid Atlas ARM64 archive entry: ${invalidEntry ?? "(empty archive)"}`);
  }
  if (requiredBlocks > bavail) {
    throw new Error(
      `Insufficient space to unpack Atlas ARM64 runtime (needs at least ${requiredBlocks * bsize} bytes, ${bavail * bsize} available).`,
    );
  }
  // A file must never be extracted through an archive-created symlink.
  for (const name of entries.keys()) {
    for (
      let parent = path.posix.dirname(name);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      const type = entries.get(parent);
      if (type && type !== "Directory") {
        throw new Error(`Invalid Atlas ARM64 archive parent: ${parent}`);
      }
    }
  }
  await extract({ file, cwd: root, keep: true, strict: true, noChmod: false });
}
