#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function resolveCommandPath(commandName) {
  const locator = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(locator, [commandName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (located.status !== 0) {
    return [];
  }
  return located.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(line));
}

function preferExecutablePath(paths, priorityOrder = [".exe", ".cmd", ".bat", ".com"]) {
  if (paths.length === 0) {
    return null;
  }
  for (const extension of priorityOrder) {
    const match = paths.find((path) => path.toLowerCase().endsWith(extension));
    if (match) {
      return match;
    }
  }
  return paths[0] ?? null;
}

function resolveCodexBinaryPath() {
  const configured = process.env.CODEX_BINARY_PATH?.trim();
  if (configured) {
    return configured;
  }
  const codexPaths = resolveCommandPath("codex").filter(
    (path) => !path.toLowerCase().includes("\\windowsapps\\openai.codex_"),
  );
  return preferExecutablePath(codexPaths, [".cmd", ".bat", ".exe", ".com"]);
}

const codexBinaryPath = resolveCodexBinaryPath();
if (!codexBinaryPath) {
  console.error(
    "Unable to resolve CODEX_BINARY_PATH. Set it explicitly or make sure `codex` is on PATH.",
  );
  process.exit(1);
}

const bunExecutable =
  process.env.BUN_BINARY_PATH?.trim() ?? preferExecutablePath(resolveCommandPath("bun")) ?? "bun";
const run = spawnSync(
  bunExecutable,
  [
    "run",
    "--cwd",
    "apps/server",
    "vitest",
    "run",
    "integration/orchestrationEngine.integration.test.ts",
    "--testNamePattern",
    "T3 Homer restarts under token pressure and spawns a successor thread",
    "--testTimeout",
    "600000",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_BINARY_PATH: codexBinaryPath,
      RUN_T3HOMER_LIVE_TEST: "1",
    },
  },
);

if (run.error) {
  console.error(`Failed to start Bun command '${bunExecutable}': ${run.error.message}`);
}

process.exit(run.status ?? 1);
