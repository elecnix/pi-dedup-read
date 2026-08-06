/**
 * Integration tests for pi-dedup-read.
 *
 * Spawns the pi CLI in print mode (-p) with the extension loaded (-e) and
 * `--mode json` so tool calls/results are emitted as structured NDJSON events.
 * Assertions read the `read` tool results directly from that event stream,
 * which is deterministic and does not depend on how the model phrases its
 * final answer.
 *
 * The model is selected via the PI_TEST_MODEL env var (set by CI to a free
 * OpenRouter model). The provider key is OPENROUTER_API_KEY (Anthropic /
 * OpenAI keys are still accepted as fallbacks).
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

type PiRun = { stdout: string; stderr: string; code: number };
type Event = Record<string, unknown> & { type?: string };

/** Run pi in print mode (JSON output) with the extension; return stdout+stderr. */
function runPi(
  cwd: string,
  prompt: string,
  env?: Record<string, string>,
): Promise<PiRun> {
  return new Promise((resolve, reject) => {
    // -a auto-approves project-local trust so pi never blocks on a trust
    // prompt reading stdin (a fresh CI runner has no trust.json).
    // --mode json emits structured NDJSON events (tool calls + results) so
    // assertions can read tool results directly instead of relying on the
    // model's prose.
    const args = ["-p", "-a", "--mode", "json", "-e", EXT_PATH];
    const model = process.env.PI_TEST_MODEL;
    if (model) args.push("--model", model);
    args.push(prompt);

    const child = execFile(
      "pi",
      args,
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

/** Parse pi `--mode json` NDJSON stdout into event objects (skips non-JSON). */
function parseEvents(stdout: string): Event[] {
  const events: Event[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as Event);
    } catch {
      // Ignore non-JSON lines (warnings, etc.).
    }
  }
  return events;
}

/** Extract the result text of every `read` tool call from the event stream. */
function readToolResults(events: Event[]): string[] {
  const results: string[] = [];
  for (const e of events) {
    if (e.type !== "tool_execution_end" || e.toolName !== "read") continue;
    const content = (e.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    results.push(text);
  }
  return results;
}

/**
 * Detect when the LLM endpoint was unusable for this run — out-of-credit,
 * invalid key, rate limited, or provider-side outage. In `--mode json` such
 * failures surface as an assistant message whose `stopReason` is `"error"`
 * (pi still exits 0 with an empty assistant turn). A stderr fallback catches
 * the legacy text-mode credit/auth strings. When true, the caller skips the
 * test rather than failing the build on an environment issue — mirroring the
 * skipIfNoKey gate: no usable endpoint == no usable test.
 */
function hasEndpointError(events: Event[], stderr: string): boolean {
  for (const e of events) {
    if (e.type !== "message_end") continue;
    const message = e.message as { role?: string; stopReason?: string } | undefined;
    if (message?.role === "assistant" && message?.stopReason === "error") {
      return true;
    }
  }
  const s = (stderr || "").toLowerCase();
  return (
    s.includes("credit balance is too low") ||
    s.includes("insufficient") ||
    s.includes("invalid_request_error") ||
    s.includes("invalid api key") ||
    s.includes("unauthorized") ||
    s.includes("rate limit") ||
    s.includes("overloaded") ||
    /\b(401|403|429|500|502|503|504|529)\b/.test(s)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-dedup-read integration (pi CLI)", () => {
  const hasApiKey =
    !!process.env.OPENROUTER_API_KEY ||
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.OPENAI_API_KEY;

  const skipIfNoKey = hasApiKey ? it : it.skip;

  // Always-run unit tests for the JSON helpers. These don't spawn pi and need
  // no API key, so they keep CI green even when the pi-driven tests are
  // skipped (e.g. a depleted/invalid CI secret).
  describe("hasEndpointError", () => {
    it("detects an assistant stopReason of 'error' (the JSON failure mode)", () => {
      const events: Event[] = [
        { type: "message_end", message: { role: "assistant", stopReason: "error" } },
      ];
      expect(hasEndpointError(events, "")).toBe(true);
    });

    it("detects the Anthropic out-of-credit 400 via stderr fallback", () => {
      const stderr =
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
      expect(hasEndpointError([], stderr)).toBe(true);
    });

    it("detects auth / rate-limit / overload errors via stderr", () => {
      expect(hasEndpointError([], "HTTP 401 Unauthorized: invalid api key")).toBe(true);
      expect(hasEndpointError([], "rate limit exceeded (429)")).toBe(true);
      expect(hasEndpointError([], "Error: overloaded (529)")).toBe(true);
      expect(hasEndpointError([], "insufficient_quota")).toBe(true);
    });

    it("is false on a healthy run", () => {
      const events: Event[] = [
        { type: "message_end", message: { role: "assistant", stopReason: "end_turn" } },
      ];
      expect(hasEndpointError(events, "")).toBe(false);
      expect(hasEndpointError([], "")).toBe(false);
    });

    it("does not flag an unrelated stderr (e.g. extension load error)", () => {
      const stderr =
        'Error: Failed to load extension "./src/index.ts": Tool "read" conflicts with another extension';
      expect(hasEndpointError([], stderr)).toBe(false);
    });
  });

  describe("readToolResults", () => {
    it("extracts the text of every read tool result", () => {
      const events: Event[] = [
        {
          type: "tool_execution_end",
          toolName: "read",
          result: { content: [{ type: "text", text: "Hello\nWorld\n" }] },
        },
        {
          type: "tool_execution_end",
          toolName: "bash",
          result: { content: [{ type: "text", text: "ignored" }] },
        },
        {
          type: "tool_execution_end",
          toolName: "read",
          result: {
            content: [
              { type: "text", text: "You already have x in your context (unchanged since last read)." },
            ],
          },
        },
      ];
      const results = readToolResults(events);
      expect(results).toHaveLength(2);
      expect(results[0]).toContain("Hello");
      expect(results[1]).toContain("unchanged since last read");
    });

    it("returns [] when there are no read results", () => {
      expect(readToolResults([])).toEqual([]);
      expect(
        readToolResults([{ type: "tool_execution_end", toolName: "bash", result: { content: [] } }]),
      ).toEqual([]);
    });
  });

  describe("parseEvents", () => {
    it("parses NDJSON lines and skips non-JSON / blank lines", () => {
      const stdout = [
        '{"type":"session"}',
        "",
        "not-json",
        '{"type":"agent_start"}',
        '  {"type":"turn_start"}  ',
      ].join("\n");
      const events = parseEvents(stdout);
      expect(events.map((e) => e.type)).toEqual(["session", "agent_start", "turn_start"]);
    });
  });

  skipIfNoKey(
    "deduplicates a re-read of the same file within one turn",
    async (ctx) => {
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
        // Prompt the agent to read the same file twice. The phrasing "read
        // it, then read it again" makes two read tool calls almost certain.
        const prompt = `Read the file ${fileName}, then read it once more. Report whether both reads returned identical content.`;

        const { stdout, stderr } = await runPi(testDir, prompt);
        const events = parseEvents(stdout);

        // If the LLM endpoint is unusable for this run (e.g. the CI secret is
        // out of credit / invalid), the extension can't be exercised — skip
        // instead of failing the build on an environment issue.
        if (hasEndpointError(events, stderr)) {
          ctx.skip();
          return;
        }

        if (process.env.PI_DEBUG) {
          console.log("=== pi read results ===");
          console.log(readToolResults(events));
        }

        const readResults = readToolResults(events);

        // The first read returns the file content; the second read is
        // deduplicated to the one-liner. Both appear as read tool results in
        // the JSON event stream, deterministically.
        expect(
          readResults.some((r) => r.includes("Hello from pi-dedup-read integration test")),
          "Expected the original file content in a read tool result (first read).\n" +
            "Results:\n" +
            readResults.map((r) => "  - " + r.replace(/\n/g, "\\n")).join("\n"),
        ).toBe(true);

        expect(
          readResults.some((r) => r.includes("unchanged since last read")),
          "Expected the dedup message ('unchanged since last read') in a read tool result.\n" +
            "The agent should have re-read the same file and hit the cache.\n" +
            "Results:\n" +
            readResults.map((r) => "  - " + r.replace(/\n/g, "\\n")).join("\n"),
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
        await writeFile(filePath, "Version ONE of mutable file.\n", "utf-8");

        const prompt = `Read the file ${fileName} and show me exactly what it says.`;

        const run1 = await runPi(testDir, prompt);
        const events1 = parseEvents(run1.stdout);

        // If the LLM endpoint is unusable, skip — the extension can't be
        // exercised without a working model.
        if (hasEndpointError(events1, run1.stderr)) {
          ctx.skip();
          return;
        }

        const readResults1 = readToolResults(events1);
        expect(
          readResults1.some((r) => r.includes("Version ONE")),
          "Expected 'Version ONE' in a read tool result.\nResults:\n" +
            readResults1.map((r) => "  - " + r.replace(/\n/g, "\\n")).join("\n"),
        ).toBe(true);

        // Now change the file.
        await writeFile(
          filePath,
          "Version TWO of mutable file — changed!\n",
          "utf-8",
        );

        const prompt2 = `Read the file ${fileName} again and show me exactly what it says.`;
        const run2 = await runPi(testDir, prompt2);
        const events2 = parseEvents(run2.stdout);

        // A transient endpoint error on the second run is also a skip.
        if (hasEndpointError(events2, run2.stderr)) {
          ctx.skip();
          return;
        }

        // Each invocation is a separate pi process, so the cache is fresh
        // per run. The second run must show the new content (no dedup across
        // processes — the dedup is per-session only).
        const readResults2 = readToolResults(events2);
        expect(
          readResults2.some((r) => r.includes("Version TWO")),
          "Expected 'Version TWO' in a read tool result after changing the file.\nResults:\n" +
            readResults2.map((r) => "  - " + r.replace(/\n/g, "\\n")).join("\n"),
        ).toBe(true);
      } finally {
        await rm(testDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    600_000,
  );
});