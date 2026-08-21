# Claude Instructions

Always use Context7 when I need code generation, setup or configuration steps, or library/API documentation. This means you should automatically use the Context7 MCP tools to resolve library id and get library docs without me having to explicitly ask.

## Sprint Tracking

**REQUIRED**: Keep sprint documentation up to date in the `sprint/` folder:
- `COMPLETED.md` - All finished stories with implementation details
- `CURRENT.md` - Stories actively being worked on
- `BACKLOG.md` - Prioritized future work
- `ICEBOX.md` - Ideas and low-priority features

### Story Format

All stories follow this structure:
- **Objective:** (one-liner describing the goal)
- **Requirements:** (bullet list of what needs to be built)
- **Details:** (optional - context, examples, how things work, edge cases)
- **Implementation:** (what we actually did - only in COMPLETED.md)

### Story Creation

- **IMPORTANT:** Only the user can create stories
- The agent can create tasks under stories to accomplish them
- The agent can propose stories based on user suggestions if they are large changes
- Stories use stable incremental IDs: 001, 002, 003, etc.
- IDs never change once assigned, even when stories move between files

**When the user asks to create a new story:**
1. Check `sprint/SPRINT_INFO.md` for the current LAST_ID
2. Increment by 1 for the new story ID
3. Update LAST_ID in SPRINT_INFO.md
4. Use the format `## 001 — Story title`

### When Completing Work

1. Update the relevant story in COMPLETED.md with 1-4 bullet point implementation summary
2. If a small change relates to a completed story, add implementation details to that story
3. Move stories from CURRENT.md to COMPLETED.md when done (keep the same ID)
4. Keep CURRENT.md up to date with what you're actively working on

## Build Before Commit

**CRITICAL**: Always run `npm run build` successfully before creating any git commits. This ensures:
- TypeScript type errors are caught
- Build errors are fixed
- No broken code is deployed

If the build fails, fix all errors before committing.

## Git Commits

**CRITICAL**: NEVER add Claude attribution to commits. Do NOT include:
- "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
- "Co-Authored-By: Claude <noreply@anthropic.com>"
- Any other AI attribution or credit

The user writes the code. Commits should reflect the user's work only.
