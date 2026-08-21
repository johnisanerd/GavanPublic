<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Library API Research

### Always Research Before Coding

When writing code that uses external libraries, **always research the library's API first**:

1. **Use Context7** (`mcp__context7__resolve-library-id` and `mcp__context7__query-docs`) for library documentation
2. **Use WebFetch** or **WebSearch** if Context7 doesn't have the library
3. **Never guess** API signatures, return types, or behavior

### Trust User Model References

Never second-guess the user about model names or versions. If a user references a model that seems newer than your training data, trust them and use it.

## E2B Templates

Build templates with `e2b template create` (v2, builds remotely, no Docker needed):

```bash
cd template && e2b template create -d e2b.Dockerfile claude-code-latest
```

Current sandbox pattern: base `e2b` SDK (NOT `@e2b/code-interpreter`), `claude-code-latest` template.

## AI Model Configuration

**Never hardcode model IDs in business logic.** All model assignments must go through a central config module.

### Principles
- Define model **categories** (fast, detailed, embedding, etc.) — not individual model IDs scattered through code
- A single env var (`AI_MODEL`) should be able to override ALL models to one value for testing
- Support **effort levels** (`EFFORT=low/medium/high`) that control models, timeouts, budgets together
- During testing, **always use the cheapest/fastest model** unless explicitly checking output quality
- Never burn expensive model tokens on iteration/debugging

### Implementation pattern
```
config.ts → getModel("fast") / getModel("detailed") / etc.
env: AI_MODEL=haiku overrides everything
env: EFFORT=low sets fast defaults for all parameters
```

### Per-project config
This project uses `src/lib/config.ts` with:
- `getApiModel()` — fast tasks (extraction, summarization). Haiku default.
- `getSynthesisModel()` — complex reasoning. Sonnet default.
- `getSandboxModel()` — CLI agents. Varies by effort level.

## No Legacy Support (Unless Explicitly Requested)

**Default behavior: Clean breaks over backward compatibility.**

- When refactoring, delete old code — don't leave deprecated functions
- No migration paths, no warnings, no compatibility layers
- If the user wants backward compatibility, they will explicitly ask for it

## Progress Tracking

**Always** read and update `~/.claude/projects/-Users-user-Projects-aisle-crosser/memory/PROGRESS.md` when completing tasks, fixing bugs, or changing feature status.

## Commit Messages

Descriptive, explain the "why" not just the "what". Use multi-line format for complex changes:

```bash
git commit -m "$(cat <<'EOF'
Short summary line (what)

Detailed explanation:
- Why this change was needed
- What problem it solves
- How it works
EOF
)"
```
