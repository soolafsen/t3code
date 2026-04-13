#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Command = {
  readonly label: string;
  readonly cmd: string;
  readonly args: readonly string[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const includeWebTests = process.argv.includes("--include-web-tests");

const PACKAGE_ROOTS = [
  "apps/server",
  "apps/web",
  "apps/desktop",
  "apps/marketing",
  "packages/client-runtime",
  "packages/contracts",
  "packages/shared",
  "scripts",
] as const;

const PACKAGE_CAPABILITIES: Record<
  (typeof PACKAGE_ROOTS)[number],
  { readonly hasTest: boolean; readonly hasTypecheck: boolean }
> = {
  "apps/server": { hasTest: true, hasTypecheck: true },
  "apps/web": { hasTest: true, hasTypecheck: true },
  "apps/desktop": { hasTest: true, hasTypecheck: true },
  "apps/marketing": { hasTest: false, hasTypecheck: true },
  "packages/client-runtime": { hasTest: true, hasTypecheck: true },
  "packages/contracts": { hasTest: true, hasTypecheck: true },
  "packages/shared": { hasTest: true, hasTypecheck: true },
  scripts: { hasTest: true, hasTypecheck: true },
};

function runGit(args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function listChangedFiles(): string[] {
  const unstaged = runGit(["diff", "--name-only", "--diff-filter=ACMR"]);
  const staged = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  return [...unstaged.split("\n"), ...staged.split("\n"), ...untracked.split("\n")]
    .map((entry) => toPosixPath(entry.trim()))
    .filter((entry) => entry.length > 0)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .toSorted();
}

function packageRootFor(path: string): (typeof PACKAGE_ROOTS)[number] | null {
  for (const root of PACKAGE_ROOTS) {
    if (path === root || path.startsWith(`${root}/`)) {
      return root;
    }
  }
  return null;
}

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function hasSourceExtension(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}

function guessTestFilesFor(path: string): string[] {
  if (isTestFile(path)) {
    return [path];
  }
  if (!hasSourceExtension(path)) {
    return [];
  }
  const base = path.replace(/\.[^.]+$/, "");
  const candidates = [
    `${base}.test.ts`,
    `${base}.test.tsx`,
    `${base}.test.js`,
    `${base}.test.jsx`,
    `${base}.spec.ts`,
    `${base}.spec.tsx`,
    `${base}.spec.js`,
    `${base}.spec.jsx`,
  ];
  return candidates.filter((candidate) => existsSync(resolve(repoRoot, candidate)));
}

function toPackageRelative(path: string, packageRoot: string): string {
  return path.slice(packageRoot.length + 1);
}

function pushCommand(commands: Command[], next: Command): void {
  const key = `${next.cmd} ${next.args.join(" ")}`;
  const exists = commands.some((entry) => `${entry.cmd} ${entry.args.join(" ")}` === key);
  if (!exists) {
    commands.push(next);
  }
}

function buildCommands(changedFiles: readonly string[]): Command[] {
  const commands: Command[] = [];
  const touchedPackages = new Set<(typeof PACKAGE_ROOTS)[number]>();

  for (const path of changedFiles) {
    const packageRoot = packageRootFor(path);
    if (!packageRoot) {
      continue;
    }
    touchedPackages.add(packageRoot);
  }

  for (const packageRoot of touchedPackages) {
    const capabilities = PACKAGE_CAPABILITIES[packageRoot];
    const filesInPackage = changedFiles.filter(
      (path) => path === packageRoot || path.startsWith(`${packageRoot}/`),
    );
    const testTargets = filesInPackage
      .flatMap((path) => guessTestFilesFor(path))
      .filter((path, index, all) => all.indexOf(path) === index);

    const shouldRunTestsForPackage =
      capabilities.hasTest && (packageRoot !== "apps/web" || includeWebTests);

    if (shouldRunTestsForPackage && testTargets.length > 0) {
      pushCommand(commands, {
        label: `${packageRoot}: targeted tests`,
        cmd: "bun",
        args: [
          "run",
          "--cwd",
          packageRoot,
          "test",
          "--",
          ...testTargets.map((path) => toPackageRelative(path, packageRoot)),
        ],
      });
    }

    if (capabilities.hasTypecheck) {
      pushCommand(commands, {
        label: `${packageRoot}: typecheck`,
        cmd: "bun",
        args: ["run", "--cwd", packageRoot, "typecheck"],
      });
    }
  }

  return commands;
}

function runCommand(command: Command): void {
  console.log(`\n[check:smart] ${command.label}`);
  console.log(`[check:smart] > ${command.cmd} ${command.args.join(" ")}`);
  if (dryRun) {
    return;
  }
  const result = spawnSync(command.cmd, [...command.args], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const changedFiles = listChangedFiles();
if (changedFiles.length === 0) {
  console.log("[check:smart] No changed files detected.");
  process.exit(0);
}

console.log("[check:smart] Changed files:");
for (const path of changedFiles) {
  console.log(`- ${path}`);
}

const commands = buildCommands(changedFiles);
if (commands.length === 0) {
  console.log("[check:smart] No package-scoped checks selected for the changed files.");
  process.exit(0);
}

if (!includeWebTests) {
  console.log(
    "[check:smart] Web tests are skipped by default (use --include-web-tests to enable).",
  );
}

for (const command of commands) {
  runCommand(command);
}

console.log("\n[check:smart] Done.");
