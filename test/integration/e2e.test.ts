/**
 * Integration tests for pi-dedup-read.
 *
 * Spawns the pi CLI in print mode (-p) with the extension loaded (-e),
 * and verifies that redundant reads of the same file are deduplicated.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXT_PATH = resolve(import.meta.dirname!, "../../src/index.ts");

/** Run pi in print mode with the extension and return stdout + stderr. */
function runPi(
  cwd: string,
  prompt: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pi",
      // -a auto-approves project-local trust so pi never blocks on a trust
      // prompt reading stdin (a fresh CI runner has no trust.json).
      ["-p", "-a", "-e", EXT_PATH, prompt],
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: 240_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err: Error | null, stdout: string, stderr: string) => {
        resolve({ stdout, stderr, code: err ? 1 : 0 });
      },
    );

    // Send EOF on stdin immediately so pi can never hang waiting for input
    // (e.g. an interactive prompt) in a non-TTY CI environment.
    child.stdin?.end();

    child.on("error", (err) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-dedup-read integration (pi CLI)", () => {
  const hasApiKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.OPENAI_API_KEY;

  const skipIfNoKey = hasApiKey ? it : it.skip;

  skipIfNoKey(
    "deduplicates a re-read of the same file within one turn",
    async () => {
      // Create a temp directory with a unique test file
      const testDir = join(tmpdir(), `pi-dedup-e2e-${Date.now()}`);
      await mkdir(testDir, { recursive: true });

      const fileName = "greeting.txt";
      const filePath = join(testDir, fileName);
      await writeFile(
        filePath,
        "Hello from pi-dedup-read integration test!\nThis file exists to be read twice.\n",
        "utf-8",
      );

      try {
        // Prompt the agent to read the same file twice.
        // The phrasing "read it, then read it again" makes two tool calls
        // almost certain.
        const prompt = `Read the file ${fileName}, then read it once more. Report whether both reads returned identical content.`;

        const { stdout, stderr, code } = await runPi(testDir, prompt);

        console.log("=== pi stdout ===");
        console.log(stdout);
        if (stderr) {
          console.log("=== pi stderr ===");
          console.log(stderr);
        }
        console.log(`=== pi exit code: ${code} ===`);

        // The dedup message must appear exactly when the second read is
        // deduplicated. We also confirm the file content appeared once
        // (the first read).
        const hasDedupMessage = stdout.includes(
          "unchanged since last read",
        );
        const hasFileContent = stdout.includes(
          "Hello from pi-dedup-read integration test",
        );

        expect(
          hasDedupMessage,
          "Expected the dedup message ('unchanged since last read') in pi stdout.\n" +
            "The agent should have re-read the same file and hit the cache.",
        ).toBe(true);

        expect(
          hasFileContent,
          "Expected the original file content in pi stdout (first read).",
        ).toBe(true);
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    300_000,
  );

  skipIfNoKey(
    "returns full content when file changes between reads",
    async () => {
      const testDir = join(tmpdir(), `pi-dedup-e2e-changed-${Date.now()}`);
      await mkdir(testDir, { recursive: true });

      const fileName = "mutable.txt";
      const filePath = join(testDir, fileName);

      try {
        // Write version 1
        await writeFile(
          filePath,
          "Version ONE of mutable file.\n",
          "utf-8",
        );

        const prompt = `Read the file ${fileName} and show me exactly what it says.`;

        const { stdout: out1 } = await runPi(testDir, prompt);

        // The agent should have read the file and displayed the content.
        // Now change the file.
        await writeFile(
          filePath,
          "Version TWO of mutable file — changed!\n",
          "utf-8",
        );

        const prompt2 = `Read the file ${fileName} again and show me exactly what it says.`;

        const { stdout: out2 } = await runPi(testDir, prompt2);

        // Each invocation is a separate pi process, so the cache is fresh
        // per run. Both runs should show full content (no dedup across
        // processes — the dedup is per-session only).
        expect(out2).toContain("Version TWO");
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    600_000,
  );
});
