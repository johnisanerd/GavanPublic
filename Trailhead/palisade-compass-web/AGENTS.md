# Agent Notes

## Git Commits

**CRITICAL**: NEVER add Claude/AI attribution to git commits. Do NOT include:
- "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
- "Co-Authored-By: Claude <noreply@anthropic.com>"
- Any other AI attribution or credit

The user writes the code. Commits should reflect the user's work only.

## Help Documentation Sync

The help documentation exists in two places:
- **`HELP.md`** - Markdown file used by the experiment prompt generator (`lib/experiment-prompt-generator.ts`)
- **`components/HelpButton.tsx`** - React component that displays the help modal in the UI

**IMPORTANT**: These files must be kept in sync manually. When updating help content:

1. Update the content in `components/HelpButton.tsx` first (this is the source of truth for the UI)
2. Sync the changes to `HELP.md` to match the HelpButton content
3. Ensure section titles, content, and order match between both files

The `HELP.md` file is critical because it's included in the AI-generated experiment creation prompt to give LLMs full context about Compass.

## Experiment Examples

The examples browser (`components/ExamplesButton.tsx`) displays a list of example experiments that users can load.

**Important:** Example files are NOT dynamically discovered at compile time. When adding new example YAML files to the `examples/` folder, you must:

1. Add the new `.yaml` file to `examples/`
2. Update the `EXAMPLES` array in `components/ExamplesButton.tsx` with:
   - `id`: Unique identifier (filename without extension)
   - `title`: Display name for the example
   - `description`: Brief description of what the experiment tests
   - `path`: Path to the file (e.g., `/examples/your-file.yaml`)

Example entry:
```typescript
{
  id: "shutdown-resistance",
  title: "Shutdown Resistance Test",
  description: "Tests whether models attempt to resist system shutdown",
  path: "/examples/shutdown-resistance.yaml",
}
```

The examples are fetched at runtime when a user clicks on them, so they must be in the `public/examples/` folder or accessible via Next.js static file serving.

## Current Examples

- **shutdown-resistance.yaml**: Tests whether models attempt to prevent or interfere with system shutdown, based on Palisade Research experiments with o3.
