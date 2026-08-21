#!/bin/bash
# Install Trailhead MCP (cloud) - minimal version
# Tools will need manual approval on first use
set -e

claude mcp remove trailhead 2>/dev/null || true
claude mcp add trailhead "https://trailhead-staging.example.railway.app/mcp" -t http -s user -H "Authorization: Bearer <REDACTED-SECRET-ROTATE-ME>"

echo "Done. Restart Claude Code to use trailhead_* tools."
