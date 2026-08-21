#!/bin/bash
# Install Trailhead MCP tools for Claude Code
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Parse arguments
TRANSPORT="${1:-cloud}"  # "cloud", "local", or "local-http"

# Remove existing trailhead server if present (makes script idempotent)
claude mcp remove trailhead 2>/dev/null || true

if [ "$TRANSPORT" = "cloud" ]; then
    # Cloud: HTTP transport to staging with bearer auth
    TRAILHEAD_SECRET="${TRAILHEAD_SECRET:-<REDACTED-SECRET-ROTATE-ME>}"
    echo "Installing Trailhead MCP (cloud)..."
    claude mcp add trailhead "https://trailhead-staging.example.railway.app/mcp" \
        -t http -s user -H "Authorization: Bearer $TRAILHEAD_SECRET"
elif [ "$TRANSPORT" = "local-http" ]; then
    # Local HTTP: test HTTP transport against local FastAPI server
    # Requires: uv run task dev (or uvicorn running on port 8000)
    echo "Installing Trailhead MCP (local HTTP)..."
    claude mcp add -t http -s user trailhead \
        "http://localhost:8000/mcp"
else
    # Local: stdio transport (standalone, no server needed)
    echo "Installing Trailhead MCP (local stdio)..."
    claude mcp add --transport stdio --scope user trailhead -- \
        sh -c "cd $PROJECT_DIR && uv run fastmcp run src/mcp_server.py:mcp"
fi

# Get tool names from the MCP server and add permissions
SETTINGS="$HOME/.claude/settings.json"
if ! command -v uv &> /dev/null; then
    echo "Note: uv not found. Tools will need manual approval when first called."
    echo "      To auto-approve, install uv and run this script again."
elif [ -f "$SETTINGS" ] && command -v jq &> /dev/null; then
    # Backup settings first
    BACKUP="$SETTINGS.$(date +%Y%m%d-%H%M%S).bak"
    cp "$SETTINGS" "$BACKUP"
    echo "Backed up to $BACKUP"
    # Extract tool names using fastmcp inspect
    TOOLS=$(uv run fastmcp inspect src/mcp_server.py:mcp --format fastmcp 2>/dev/null \
        | grep -o '"name": "trailhead_[^"]*"' | cut -d'"' -f4)

    # Build JSON array of permissions
    PERMS="["
    for tool in $TOOLS; do
        PERMS="${PERMS}\"mcp__trailhead__${tool}\","
    done
    PERMS="${PERMS%,}]"  # Remove trailing comma, close array

    # Add to settings
    jq --argjson perms "$PERMS" \
        '.permissions.allow = ((.permissions.allow // []) + $perms | unique)' \
        "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"

    echo "Added permissions for: $TOOLS"
fi

echo "Done. Restart Claude Code to use trailhead_* tools."
echo ""
echo "Usage:"
echo "  ./scripts/install-mcp.sh            # Cloud HTTP (default, uses staging)"
echo "  ./scripts/install-mcp.sh local      # Local stdio (standalone)"
echo "  ./scripts/install-mcp.sh local-http # Local HTTP (requires: uv run task dev)"
