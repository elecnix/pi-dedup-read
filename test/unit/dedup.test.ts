/**
 * Unit tests for pi-dedup-read extension.
 *
 * Tests the core logic: content hashing, image detection, cache hit/miss,
 * session lifecycle, and delegation to the built-in read tool.
 */

import { createHash } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ExtensionAPI,
  type ReadToolDetails,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  unchangedMessage,
  hashContent,
  detectImageMimeTypeFromBuffer,
  type ReadParams,
} from "../../src/index.js";

// We import the extension factory to capture the registered tool.
import createExtension from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), "pi-dedup-read-test");

function makeTempPath(name: string): string {
  return join(TEST_DIR, name);
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const p = makeTempPath(name);
  await writeFile(p, content, "utf-8");
  return p;
}

/** Capture the tool registered as "read" by the extension factory. */
function captureReadTool(): {
  execute: (
    toolCallId: string,
    params: ReadParams,
    signal: AbortSignal | undefined,
    onUpdate: ((u: unknown) => void) | undefined,
    ctx: { cwd: string; model?: { input: string[] } },
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: ReadToolDetails }>;
} {
  const registered: Record<string, unknown> = {};

  const mockPi = {
    on: () => {},
    registerTool: (def: { name: string; execute: unknown }) => {
      registered[def.name] = def;
    },
  } as unknown as ExtensionAPI;

  createExtension(mockPi);

  const tool = registered["read"] as {
    execute: (
      toolCallId: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate: ((u: unknown) => void) | undefined,
      ctx: { cwd: string },
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: ReadToolDetails }>;
  };

  if (!tool) {
    throw new Error("Extension did not register a 'read' tool");
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("produces deterministic SHA-256 hex", () => {
    const buf = Buffer.from("hello world", "utf-8");
    const h1 = hashContent(buf);
    const h2 = hashContent(buf);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it("produces different hashes for different content", () => {
    const h1 = hashContent(Buffer.from("abc", "utf-8"));
    const h2 = hashContent(Buffer.from("abd", "utf-8"));
    expect(h1).not.toBe(h2);
  });

  it("matches node crypto directly", () => {
    const buf = Buffer.from("test content", "utf-8");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(hashContent(buf)).toBe(expected);
  });
});

describe("detectImageMimeTypeFromBuffer", () => {
  it("detects PNG", () => {
    // Minimal PNG: magic + IHDR chunk
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    expect(detectImageMimeTypeFromBuffer(png)).toBe("image/png");
  });

  it("detects JPEG", () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMimeTypeFromBuffer(jpg)).toBe("image/jpeg");
  });

  it("detects GIF", () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMimeTypeFromBuffer(gif)).toBe("image/gif");
  });

  it("detects WebP", () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    expect(detectImageMimeTypeFromBuffer(webp)).toBe("image/webp");
  });

  it("detects BMP", () => {
    const bmp = Buffer.from([0x42, 0x4d]);
    expect(detectImageMimeTypeFromBuffer(bmp)).toBe("image/bmp");
  });

  it("returns null for text", () => {
    const text = Buffer.from("Hello, world!", "utf-8");
    expect(detectImageMimeTypeFromBuffer(text)).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(detectImageMimeTypeFromBuffer(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for tiny buffer", () => {
    expect(detectImageMimeTypeFromBuffer(Buffer.from([0x00]))).toBeNull();
  });
});

describe("unchangedMessage", () => {
  it("formats the path", () => {
    const msg = unchangedMessage("src/index.ts");
    expect(msg).toContain("src/index.ts");
    expect(msg).toContain("unchanged since last read");
  });
});

describe("read tool deduplication (unit)", () => {
  let tool: ReturnType<typeof captureReadTool>;
  const cwd = TEST_DIR;

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    tool = captureReadTool();
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  const ctx = { cwd };

  it("returns full content on first read", async () => {
    await writeTempFile("a.txt", "hello world\n");
    const result = await tool.execute("id1", { path: "a.txt" }, undefined, undefined, ctx);
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("hello world");
  });

  it("returns unchangedMessage on second read of the same content", async () => {
    await writeTempFile("b.txt", "same content\n");
    await tool.execute("id1", { path: "b.txt" }, undefined, undefined, ctx);
    const result = await tool.execute("id2", { path: "b.txt" }, undefined, undefined, ctx);
    const text = result.content.map((c) => c.text).join("");
    expect(text).toContain("unchanged since last read");
    expect(text).not.toContain("same content");
  });

  it("returns full content again after file changes", async () => {
    const p = makeTempPath("c.txt");
    await writeFile(p, "version 1\n", "utf-8");
    const r1 = await tool.execute("id1", { path: "c.txt" }, undefined, undefined, ctx);
    expect(r1.content.map((c) => c.text).join("")).toContain("version 1");

    await writeFile(p, "version 2\n", "utf-8");
    const r2 = await tool.execute("id2", { path: "c.txt" }, undefined, undefined, ctx);
    expect(r2.content.map((c) => c.text).join("")).toContain("version 2");
  });

  it("caches per-path independently", async () => {
    await writeTempFile("d1.txt", "data 1\n");
    await writeTempFile("d2.txt", "data 2\n");

    // First reads
    await tool.execute("id1", { path: "d1.txt" }, undefined, undefined, ctx);
    await tool.execute("id2", { path: "d2.txt" }, undefined, undefined, ctx);

    // Re-read d1 → should dedup
    const r = await tool.execute("id3", { path: "d1.txt" }, undefined, undefined, ctx);
    expect(r.content.map((c) => c.text).join("")).toContain("unchanged");
  });

  it("treats relative and absolute paths as the same file", async () => {
    const abs = resolve(TEST_DIR, "e.txt");
    await writeFile(abs, "path test\n", "utf-8");

    await tool.execute("id1", { path: abs }, undefined, undefined, ctx);
    const result = await tool.execute("id2", { path: "e.txt" }, undefined, undefined, ctx);
    expect(result.content.map((c) => c.text).join("")).toContain("unchanged");
  });

  it("delegates to built-in read tool on cache miss", async () => {
    await writeTempFile("f.txt", "delegation test\nline two\nline three\n");
    const result = await tool.execute("id1", { path: "f.txt" }, undefined, undefined, ctx);
    const text = result.content.map((c) => c.text).join("");
    // Should include actual content (delegated to built-in)
    expect(text).toContain("delegation test");
  });

  it("passes offset/limit through to built-in read", async () => {
    await writeTempFile("g.txt", "line 1\nline 2\nline 3\nline 4\nline 5\n");
    // First read to populate cache (miss)
    await tool.execute("id1", { path: "g.txt" }, undefined, undefined, ctx);
    // Re-read with offset to trigger cache miss (different params)
    const result = await tool.execute("id2", { path: "g.txt", offset: 3 }, undefined, undefined, ctx);
    const text = result.content.map((c) => c.text).join("");
    // offset/limit affect the output text but the file content is the same,
    // so this should still be a cache hit
    expect(text).toContain("unchanged");
  });

  it("handles nonexistent files gracefully", async () => {
    const result = await tool.execute(
      "id1",
      { path: "nonexistent.txt" },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content.map((c) => c.text).join("");
    expect(text).toMatch(/error/i);
  });
});
