# pi-dedup-read

**pi extension** — deduplicates the `read` tool by content hash.  
When an agent re-reads a file whose content has not changed since the last
read, a token-efficient one-liner is returned instead of the full file
content.

## Install

```bash
pi install git:github.com/elecnix/pi-dedup-read@main
```

That's it — the extension auto-loads on your next pi session.

To install manually:

```bash
# Global (all projects)
cp src/index.ts ~/.pi/agent/extensions/pi-dedup-read.ts

# Project-local
mkdir -p .pi/extensions
cp src/index.ts .pi/extensions/pi-dedup-read.ts
```

## What it does

Every `read` call is intercepted:

1. **Content is hashed** — SHA-256 of the file bytes is the source of truth.
2. **Per-session cache** — `(path, hash)` pairs are tracked within the session.
3. **Cache hit** → `You already have src/foo.ts in your context (unchanged since last read).`
4. **Cache miss** → delegates to the built-in `read` tool, which handles
   truncation, syntax highlighting, image detection, offset/limit, etc.

The cache is cleared on every new session (`session_start`).

## Why

Agents re-read files they already have in context, wasting tokens. This
extension eliminates that pattern transparently — no agent-side rules needed.

## Development

```bash
npm install
npm test              # unit + integration
npm run test:unit     # unit only
npm run test:integration  # integration only (needs pi CLI + API key)
```

Integration tests spawn `pi -p -e ./src/index.ts` and verify dedup behavior
end-to-end. They require an LLM API key (`ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`) — otherwise they are skipped.

## License

MIT
