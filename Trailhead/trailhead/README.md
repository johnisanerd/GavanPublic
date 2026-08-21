# Trailhead

A Slack-based system for running fast experiments on LLMs. Describe experiments in natural language, run them, and get summarized results delivered to Slack.

## Quick Start

```bash
# Install
uv sync --all-extras --dev

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# Run dev server
uv run task dev
```

## Prerequisites

- Python 3.12+
- uv (https://docs.astral.sh/uv/)
- Slack app with bot token and signing secret
- OpenRouter API key

## Environment Variables

Required in `.env`:
```
SLACK_SIGNING_SECRET=your_slack_signing_secret
SLACK_BOT_TOKEN=xoxb-your-bot-token
OPENROUTER_API_KEY=sk-or-...
```

Optional:
```
UTILITY_MODEL=anthropic/claude-sonnet-4
TIMEOUT_S=30.0
APP_BASE_URL=http://localhost:8000
```

## Usage

### Slack (Primary Interface)

Mention the bot with an experiment description:
```
@trailhead Compare gpt-4o and claude-sonnet on "What is 2+2?"
```

The bot will:
1. Generate an experiment config from your description
2. Show a preview with Start/Edit buttons
3. Run the experiment when you click Start
4. Post a summary to the thread

### API

```bash
# Full pipeline: generate config, run, summarize
curl -X POST "http://localhost:8000/generate-run-summarize?description=test%20gpt-4o%20on%20math"

# Just summarize an existing log
curl -X POST http://localhost:8000/summarize \
  -H "Content-Type: application/json" \
  -d '{"raw_log": "...", "format": "prose"}'
```

### CLI

```bash
# Summarize a log file
uv run task summarize ./experiment.eval --format prose

# Run an experiment from YAML
uv run task run ./config.yaml
```

## Development

```bash
uv run task fmt        # Format code
uv run task lint       # Lint
uv run task typecheck  # Type check
uv run task test       # Unit tests
uv run task test-llm   # Tests that call LLMs
```

## Slack Setup

1. Create a Slack app at api.slack.com
2. Enable Socket Mode or set Request URL to `https://your-domain/slack/events`
3. Subscribe to `app_mention` event
4. Add bot token scopes: `app_mentions:read`, `chat:write`, `commands`
5. Install to workspace

## Architecture

See `ARCHITECTURE.md` for full details.

Key components:
- `src/slack/` - Slack bot handlers
- `src/endpoints/` - REST API endpoints
- `src/trailrun/` - Experiment orchestration
- `src/orchestration/` - AI client and analysis
