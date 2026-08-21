#!/usr/bin/env bash
# Open a local tunnel to the (6PN-only) pat-observability store so a laptop
# agent / MCP / curl can query it at http://127.0.0.1:5080.
# Leave this running in a terminal while using the MCP plugin or pat-trace.
set -euo pipefail
exec env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN flyctl proxy 5080:5080 -a pat-observability
