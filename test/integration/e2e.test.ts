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

/**
 * Detect when pi failed because the LLM endpoint itself is unusable for this
 * run — out-of-credit, invalid key, rate limited, or provider-side outage.
 * In those cases the integration test cannot exercise the extension at all,
 * so the caller should skip the test rather than fail the build. This mirrors
 * the existing skipIfNoKey gate: no usable endpoint == no usable test.
 */
function isEndpointUnavailable(
  stderr: string,
  code: number | null,
): boolean {
  if (code !== 0 && code !== null) {
    const s = stderr.toLowerCase();
    if (
      s.includes("credit balance is too low") ||
      s.includes("insufficient") ||
      s.includes("invalid_request_error") ||
      s.includes("authentication") ||
      s.includes("invalid api key") ||
      s.includes("unauthorized") ||
      s.includes("rate limit") ||
      s.includes("overloaded") ||
      /\b(401|403|429|500|529)\b/.test(s)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-dedup-read integration (pi CLI)", () => {
  const hasApiKey =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.OPENAI_API_KEY;

  const skipIfNoKey = hasApiKey ? it : it.skip;

  // Always-run unit tests for the endpoint-availability detector. These
  // don't spawn pi and need no API key, so they keep CI green even when the
  // pi-driven tests are skipped (e.g. a depleted CI secret).
  describe("isEndpointUnavailable", () => {
    it("detects the Anthropic out-of-credit 400 (the CI failure mode)", () => {
      const stderr =
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdkqGkZiYxJzE3b7opJ5h"}';
      expect(isEndpointUnavailable(stderr, 1)).toBe(true);
    });

    it("detects auth / rate-limit / overload errors", () => {
      expect(isEndpointUnavailable("HTTP 401 Unauthorized: invalid api key", 1)).toBe(true);
      expect(isEndpointUnavailable("rate limit exceeded (429)", 1)).toBe(true);
      expect(isEndpointUnavailable("Error: overloaded (529)", 1)).toBe(true);
      expect(isEndpointUnavailable("insufficient_quota", 1)).toBe(true);
    });

    it("is false on success", () => {
      expect(isEndpointUnavailable("", 0)).toBe(false);
      expect(isEndpointUnavailable("", null)).toBe(false);
    });

    it("does not skip on an unrelated non-zero exit (e.g. extension load error)", () => {
      const stderr =
        'Error: Failed to load extension "./src/index.ts": Tool "read" conflicts with another extension';
      expect(isEndpointUnavailable(stderr, 1)).toBe(false);
    });
  });

  skipIfNoKey(
    "deduplicates a re-read of the same file within one turn",
    async (ctx) => {
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

        // If the LLM endpoint is unusable for this run (e.g. the CI secret is
        // out of credit / invalid), the extension can't be exercised — skip
        // instead of failing the build on an environment issue.
        if (isEndpointUnavailable(stderr, code)) {
          ctx.skip();
          return;
        }

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
    async (ctx) => {
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

        const { stdout: out1, stderr: err1, code: code1 } = await runPi(testDir, prompt);

        // If the LLM endpoint is unusable for this run, skip — the
        // extension can't be exercised without a working model.
        if (isEndpointUnavailable(err1, code1)) {
          ctx.skip();
          return;
        }

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
