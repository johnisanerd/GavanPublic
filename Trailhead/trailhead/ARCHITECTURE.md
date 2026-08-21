## Overview

Trailhead is a Slack-based system for running fast experiments on LLMs. Users describe experiments in natural language, and Trailhead generates configs, runs experiments, and delivers summarized results.

## Core Stack

- Python 3.12+
- uv for env and deps
- taskipy for npm-style tasks
- Ruff for lint and format
- Pyright for type checking
- Pydantic v2 for config and data models
- FastAPI for HTTP endpoints
- Slack Bolt for Python (FastAPI adapter)
- Inspect AI for experiment execution
- pytest for tests

## Architecture

**Single FastAPI Application** with:
- Slack Bot (mounted at /slack/events) - primary interface
- REST API endpoints - for programmatic access and testing
- CLI tools - for local development

**Request Flow (Slack):**
1. User @mentions bot with experiment description
2. `generate_experiment.py` uses LLM to generate ExperimentConfig
3. User clicks Start → `slack_trailrunner.py` orchestrates execution
4. `core.py` runs experiment via Inspect AI subprocess
5. Results parsed, summarized, posted to Slack thread

**Request Flow (API):**
1. POST `/generate-run-summarize` with description
2. Same config generation and execution
3. Returns JSON with prose summary and viewer URL

## Project Layout

```
src/
├── config.py              # Pydantic Settings from .env
├── main.py                # FastAPI app, includes all routers
├── types.py               # Shared Pydantic models
├── cli/
│   ├── runner.py          # CLI for running experiments
│   ├── summarizer.py      # CLI for summarizing logs
│   └── highlight.py       # CLI for extracting highlights from logs
├── endpoints/             # One file per endpoint
│   ├── health.py          # GET /, /health
│   ├── summarize.py       # POST /summarize
│   ├── followup.py        # POST /followup
│   ├── generate.py        # POST /generate
│   ├── run.py             # POST /run
│   ├── generate_run_summarize.py  # POST /generate-run-summarize
│   ├── dashboard.py       # GET /trailruns
│   ├── data_inspector.py  # GET /data-inspector/{id}
│   └── cancel.py          # POST /trailrun/{id}/cancel
├── orchestration/
│   ├── client/            # Centralized AI client
│   │   ├── llm.py         # call_llm() with rate limiting
│   │   └── image.py       # generate_image() for infographics
│   ├── analysis/
│   │   ├── highlighter.py # Extract key highlights with citations
│   │   ├── summarizers/   # Format-specific summarizers
│   │   │   ├── slack.py   # Slack Block Kit output
│   │   │   ├── prose.py   # Narrative text output
│   │   │   └── bullets.py # Markdown bullets output
│   │   └── answerers/     # Q&A on experiment data
│   ├── citations/         # Citation extraction and verification
│   └── parsers/           # Log file parsers
├── prompts/               # Centralized LLM prompts
│   ├── shared.py          # Common prompt components
│   ├── slack_formatting.py # Slack Block Kit guidance
│   ├── media.py           # Image generation prompts
│   ├── summarizers/       # Summarizer prompts
│   ├── answerers/         # Answerer prompts
│   ├── experiment/        # Experiment generation prompts
│   └── utils/             # Prompt utilities
├── runner/
│   ├── runner.py          # Experiment execution logic
│   ├── subprocess_runner.py  # Subprocess management
│   ├── subprocess_worker.py  # Worker process entry point
│   └── types.py           # ExperimentConfig, ExperimentResult
├── slack/
│   ├── app.py             # Bolt AsyncApp setup
│   ├── actions/           # Button click handlers
│   ├── events/            # Event handlers (app_mention)
│   └── utils/             # Slack utilities (blocks, fallback, personas)
├── trailrun/
│   ├── core.py            # Slack-independent execution
│   ├── generate_experiment.py  # LLM config generation
│   ├── slack_trailrunner.py  # Slack-specific orchestration
│   ├── blocks.py          # Slack Block Kit builders
│   ├── store.py           # In-memory trailrun storage
│   ├── tasks.py           # Background task management
│   └── types.py           # Trailrun, Phase models
└── utils/
    ├── rate_limiter.py    # Token bucket rate limiter
    ├── sanitize.py        # Text sanitization
    ├── file_utils.py      # File/URL fetching
    ├── model_repository.py # OpenRouter model listing
    └── progress_indicator.py # Animated progress updates
tests/
├── unit/                  # Fast tests (no LLM calls)
├── llm/                   # Tests that call real LLMs
├── mocks/                 # Shared test mocks
└── one_off/               # Temporary test files (gitignored)
```

## Key Design Decisions

**Functional over OO**: Functions for stateless transforms, classes only for state (RateLimiter, Trailrun store).

**Slack-independent core**: `trailrun/core.py` runs experiments without Slack dependencies. `slack_trailrunner.py` adds Slack UI updates. API endpoint uses core directly.

**One endpoint per file**: Each endpoint in `endpoints/` is a single file with one router.

**Centralized AI client**: All LLM calls go through `orchestration/client/` for rate limiting and consistent error handling.

**Structured outputs**: Slack summarizers use OpenAI's json_schema response format for reliable JSON.

## Data Contracts

**ExperimentConfig** (input to runner):
- title, prompts, models, n (repetitions)
- Generated from natural language by generate_experiment.py

**SummarizerResponse** (output from summarizers):
- blocks: list of Slack Block Kit blocks
- Used by Slack summarizers; prose/bullets return plain strings

## Security

- Slack escapes HTML; we additionally sanitize text (strip control chars, clamp lengths)
- File paths only accepted in dev mode, never from Slack users
- Secrets loaded from .env via Pydantic Settings
- Public assets served at /public/* (intentionally open)

## Development

```bash
# Setup
uv sync --all-extras --dev

# Run dev server
uv run task dev

# Run tests
uv run task test        # Unit tests only
uv run task test-llm    # Tests that call LLMs

# Lint and format
uv run task fmt
uv run task lint
uv run task typecheck
```

## CLI Usage

```bash
# Summarize a log file
uv run task summarize ./sample.eval --format prose

# Run an experiment config
uv run task run ./config.yaml
```
