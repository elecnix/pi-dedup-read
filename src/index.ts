/**
 * pi-dedup-read — pi extension that deduplicates the read tool.
 *
 * On every read call, the file content is hashed (SHA-256) and compared
 * against a per-session cache. If the exact same content was already read
 * earlier in the session, a token-efficient one-liner replaces the full
 * file content.
 *
 * Install: pi install git:github.com/elecnix/pi-dedup-read@main
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ReadOperations,
  type ReadToolDetails,
  type ReadToolInput,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Per-session read cache — maps absolute path → set of seen content hashes
// ---------------------------------------------------------------------------
const readCache = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Image magic bytes for detectImageMimeType (used when delegating to built-in)
// The built-in read tool uses this to distinguish images from text files.
// ---------------------------------------------------------------------------
const IMAGE_SIGNATURES: Array<{ bytes: number[]; mimeType: string }> = [
  { bytes: [0xff, 0xd8, 0xff], mimeType: "image/jpeg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: "image/png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mimeType: "image/webp" },
  { bytes: [0x42, 0x4d], mimeType: "image/bmp" },
];

function detectImageMimeType(buffer: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) {
      return sig.mimeType;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Short message returned on cache hit
// ---------------------------------------------------------------------------
export function unchangedMessage(filePath: string): string {
  return `You already have ${filePath} in your context (unchanged since last read).`;
}

export function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function detectImageMimeTypeFromBuffer(buffer: Buffer): string | null {
  return detectImageMimeType(buffer);
}

export type { ReadParams };

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
const readSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of lines to read",
    }),
  ),
});

type ReadParams = ReadToolInput;

export default function (pi: ExtensionAPI) {
  // ── Session lifecycle: clear the cache on every new session ──────────
  pi.on("session_start", () => {
    readCache.clear();
  });

  // ── Register the shadow read tool ────────────────────────────────────
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). " +
      "Automatically skips re-reading unchanged files.",
    promptSnippet: "Read file contents",
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
    ],
    parameters: readSchema,

    async execute(
      _toolCallId: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      ctx: { cwd: string; model?: { input: string[] } },
    ) {
      const absolutePath = resolvePath(ctx.cwd, params.path);

      // 1. Read file bytes
      let buffer: Buffer;
      try {
        buffer = await readFile(absolutePath);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error reading file: ${message}` }],
          details: undefined,
        };
      }

      // 2. Compute content hash
      const hash = createHash("sha256").update(buffer).digest("hex");

      // 3. Check cache
      let hashes = readCache.get(absolutePath);
      if (hashes?.has(hash)) {
        // Cache hit — return the token-efficient one-liner
        return {
          content: [
            { type: "text", text: unchangedMessage(params.path) },
          ],
          details: undefined,
        };
      }

      // 4. Cache miss — record this hash and delegate to built-in read
      if (!hashes) {
        hashes = new Set();
        readCache.set(absolutePath, hashes);
      }
      hashes.add(hash);

      // Build custom ReadOperations that return the already-read buffer
      // so the built-in tool doesn't re-read from disk.
      const operations: ReadOperations = {
        readFile: async () => buffer,
        access: async () => {
          // Already verified — the readFile above would have thrown
        },
        detectImageMimeType: async () => detectImageMimeType(buffer),
      };

      const builtin = createReadToolDefinition(ctx.cwd, {
        operations,
        autoResizeImages: true,
      });

      return builtin.execute(
        _toolCallId,
        params,
        signal,
        onUpdate,
        ctx as Parameters<(typeof builtin)["execute"]>[4],
      );
    },

    // No renderCall / renderResult — pi inherits the built-in renderer
    // (syntax highlighting, line numbers, truncation warnings).
  });
}
