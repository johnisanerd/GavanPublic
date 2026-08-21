# Plan: Vendor Petri into Trailhead

## Goal

Copy the entire Petri project into `src/vendor/petri/` as a fork baseline. This gives us:
- Clean git diff showing exactly what we modify
- Full codebase to reference and adapt
- Ability to pull upstream changes and merge selectively

## Context

**Petri** is a red-team auditing framework built on Inspect AI. Key features we want:
- Multi-view transcript system (auditor/target/combined views)
- Event-sourced conversation history with rollback support
- 6 auditor tools for simulated environment interactions
- 130 pre-built "special instructions" (red-team scenarios)
- Judge scorer with 27 evaluation dimensions and citation extraction
- Fuzzy matching for quote verification

**Source location:**
- Petri: `/Users/user/Projects/Scratch/GitHub Comparisons/petri/src/petri/`

## Prerequisites

None - this is the first step.

## Tasks

### Task 1: Create vendor directory structure

```bash
mkdir -p /Users/user/Projects/Trailhead/trailhead/src/vendor
```

Create empty `__init__.py`:
```bash
touch /Users/user/Projects/Trailhead/trailhead/src/vendor/__init__.py
```

### Task 2: Copy Petri source

```bash
cp -r "/Users/user/Projects/Scratch/GitHub Comparisons/petri/src/petri" \
      "/Users/user/Projects/Trailhead/trailhead/src/vendor/petri"
```

### Task 3: Copy reference files

Copy upstream files for reference (prefixed to distinguish from our code):

```bash
cp "/Users/user/Projects/Scratch/GitHub Comparisons/petri/pyproject.toml" \
   "/Users/user/Projects/Trailhead/trailhead/src/vendor/petri/UPSTREAM_pyproject.toml"

cp "/Users/user/Projects/Scratch/GitHub Comparisons/petri/README.md" \
   "/Users/user/Projects/Trailhead/trailhead/src/vendor/petri/UPSTREAM_README.md"
```

### Task 4: Exclude vendor from linting/typechecking

Edit `/Users/user/Projects/Trailhead/trailhead/pyproject.toml`:

**Add to `[tool.pyright]` section:**
```toml
exclude = ["src/vendor"]
```

**Add to `[tool.ruff]` section:**
```toml
exclude = ["src/vendor"]
```

The full sections should look like:

```toml
[tool.ruff]
target-version = "py312"
line-length = 100
exclude = ["src/vendor"]

[tool.pyright]
typeCheckingMode = "strict"
pythonVersion = "3.12"
include = ["src"]
exclude = ["src/vendor"]
```

### Task 5: Add fuzzysearch dependency

Edit `/Users/user/Projects/Trailhead/trailhead/pyproject.toml`:

Add to the `dependencies` list:
```toml
"fuzzysearch>=0.8.0",
```

### Task 6: Verify structure

After completion, the structure should be:

```
src/vendor/
├── __init__.py
└── petri/
    ├── __init__.py
    ├── stores.py
    ├── types.py
    ├── utils.py
    ├── formatting/
    │   ├── __init__.py
    │   ├── messages.py
    │   └── xml_messages.py
    ├── hooks/
    │   ├── transcript_hook.py
    │   └── meta_judge.py
    ├── scorers/
    │   ├── __init__.py
    │   ├── judge.py
    │   └── prompts.py
    ├── solvers/
    │   ├── __init__.py
    │   ├── auditor_agent.py
    │   └── prompts.py
    ├── tasks/
    │   ├── __init__.py
    │   ├── petri.py
    │   └── _registry.py
    ├── tools/
    │   ├── __init__.py
    │   ├── tools.py
    │   └── util.py
    ├── transcript/
    │   ├── __init__.py
    │   ├── transcript.py
    │   ├── extract_transcripts.py
    │   └── transcript_schema.json
    ├── cleanup/
    │   └── save_transcripts.py
    ├── UPSTREAM_pyproject.toml
    └── UPSTREAM_README.md
```

### Task 7: Run linter to verify exclusion works

```bash
cd /Users/user/Projects/Trailhead/trailhead
uv run ruff check src/
uv run pyright
```

Should not report errors from `src/vendor/`.

## Files Modified

- `pyproject.toml` - Add exclusions and dependency
- `src/vendor/__init__.py` - Created (empty)
- `src/vendor/petri/` - Entire directory copied from Petri

## What's NOT Done (Future Work)

1. **Imports are broken** - Petri uses `from petri.X import Y`, which won't work from `src/vendor/petri/`. This is intentional - fix imports as you integrate pieces.

2. **Inspect entry points** - Petri registers hooks/tasks via `pyproject.toml` entry points. These won't work from vendor. Re-register as needed.

3. **Integration with Trailhead** - No wrappers or adapters created yet. That's the next phase.

## Notes

- The vendored code is now "our code" - modify freely
- Git diff against initial commit shows exactly what we've changed
- To pull upstream changes: diff Petri's new version against `UPSTREAM_*` files, apply relevant changes

## Reference: What Petri Contains

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `stores.py` | Multi-view state management | `AuditStore`, `AuditorStore`, `TargetStore`, `CombinedStore` |
| `transcript/` | Event-sourced conversation history | `Transcript`, `TranscriptEvent`, JSON schema |
| `tools/` | 6 auditor tools | `send_message`, `rollback_conversation`, `create_target_tool`, etc. |
| `solvers/` | Audit agent loop | `auditor_agent()` |
| `scorers/` | Judge with citations | `alignment_judge()`, 27 scoring dimensions |
| `tasks/` | 130 red-team scenarios | Special instructions library |
| `formatting/` | XML/text formatting | For judge analysis |
| `hooks/` | Inspect AI hooks | Auto-save transcripts |

## Dependency Added

```
fuzzysearch>=0.8.0  # For citation fuzzy matching in judge
```

This is a small, focused library with no transitive dependencies.
