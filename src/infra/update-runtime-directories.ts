export const runtimeDirectoryNames = ["dist", "dist-runtime", "node_modules"];

export const runtimeDirectoryGitArgs = [
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--directory",
  "-z",
  "--",
  ...runtimeDirectoryNames,
  ...runtimeDirectoryNames.map((directory) => `**/${directory}`),
  ":(exclude).artifacts/**",
  ":(exclude).worktrees/**",
  ":(exclude).claude/**",
];

export function runtimeDirectoryFor(entry: string): string | undefined {
  const parts = entry.split("/");
  const runtimeIndex = parts.findIndex((part) => runtimeDirectoryNames.includes(part));
  const runtimeRoot = parts.slice(0, runtimeIndex + 1);
  return runtimeRoot.length && !runtimeRoot.some((part) => part.startsWith("."))
    ? runtimeRoot.join("/")
    : undefined;
}

export function parseRuntimeDirectoryInventory(output: string): string[] {
  // Git may list individual ignored entries if the directory shares tracked siblings.
  return [
    ...new Set(
      output
        .split("\0")
        .map(runtimeDirectoryFor)
        .filter((entry) => entry !== undefined),
    ),
  ];
}
