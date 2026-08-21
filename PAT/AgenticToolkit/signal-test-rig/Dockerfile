# signal-test-rig — Fly deployment image.
#
# Single process: an entrypoint script that spawns signal-cli (multi-account
# JSON-RPC daemon on :7583) then the FastAPI rig (WS + REST on :7585). The
# rig connects to the daemon over loopback inside the container.
#
# Why multi-account: the rig fronts N burner identities (e.g. the two test
# burners +15550100005 + +15550100006). signal-cli's multi-account daemon
# (no `-a` flag, every RPC takes `{"account": …}`) is the one shape that
# supports more than one identity on a single TCP socket. The rig drives
# that shape regardless of len(accounts) == 1 — see signal_cli_bridge.py.
#
# Stages (mirrors transports/Dockerfile precedent):
#   build    — uv-managed Python venv (FastAPI + uvicorn + websockets)
#   sigcli   — fetches the signal-cli JAR-based Linux tarball
#   runtime  — python:3.13-slim + venv + signal-cli JAR + Temurin JRE 25
#
# Native binary alternative was tried in transports/ and segfaulted on
# python:3.13-slim — GraalVM native-image is sensitive to glibc/kernel
# features. JAR + JRE adds ~200MB but reliably runs. Same decision applies
# here, same JRE version (25, since signal-cli 0.14.3 JAR is compiled for
# class file 69 = Java 25). See reference_pat_signal_deploy.md for the
# longer story.

# ---- build (Python venv) ----
FROM python:3.13-slim AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.13 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY signal_test_rig ./signal_test_rig
RUN uv sync --frozen --no-dev

# ---- sigcli (signal-cli JAR tarball + Java launcher) ----
# The JAR tarball extracts to /opt/signal-cli-<version>/ with a Java
# launcher script at bin/signal-cli. Pinned to a specific release so
# image builds are reproducible. Bump in lockstep with the local Mac
# install when you bump signal-cli (see add-signal SKILL.md).
FROM debian:bookworm-slim AS sigcli

ARG SIGNAL_CLI_VERSION=0.14.3

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      -o /tmp/signal-cli.tar.gz \
    && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
    && ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli \
    && rm /tmp/signal-cli.tar.gz

# ---- runtime ----
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

# Install Temurin JRE 25 (current LTS — signal-cli 0.14.3 JAR is class
# file 69 = Java 25; JRE 21 gets UnsupportedClassVersionError). Adoptium's
# apt repo serves Debian-native packages. ca-certificates + curl + gnupg
# are left installed for runtime debugging (flyctl ssh + curl checks).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public \
       | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" \
       > /etc/apt/sources.list.d/adoptium.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends temurin-25-jre \
    && rm -rf /var/lib/apt/lists/*

ARG SIGNAL_CLI_VERSION=0.14.3

WORKDIR /app
COPY --from=build /app /app
COPY --from=sigcli /opt /opt
RUN ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Smoke-test: ensure the launcher script can locate java and load the
# main class. Build-time catch for the JAR/JRE wiring break that bit
# pat-transports on first deploy.
RUN signal-cli --version

EXPOSE 7585
CMD ["/app/entrypoint.sh"]
