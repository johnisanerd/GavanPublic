# voice-transport — polyglot image for the pat-transports Fly app.
#
# Two process groups share this image (per Fly's one-image-per-app model):
#   - cartesia: Python — the Cartesia Line agent bridging to nanoclaw
#   - signal:   signal-cli JAR + JRE — JSON-RPC daemon on
#               fly-local-6pn:7583, signal-cli/ entrypoint
#
# Stages:
#   build    — uv-managed Python venv (cartesia)
#   sigcli   — fetches the signal-cli JAR-based Linux tarball
#   runtime  — python:3.13-slim + venv + signal-cli + Temurin JRE 21
#
# Native binary alternative was tried first (~80MB single binary, no JRE)
# but segfaulted on python:3.13-slim runtime (GraalVM native-image is
# sensitive to glibc / kernel features, and our base isn't a tested
# target). Reverted to JAR + JRE — adds ~200MB image but reliably runs.

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

COPY main.py ./
# PAT 2026-05-13: signal_staging.py is a small FastAPI sidecar launched
# from signal-cli/entrypoint.sh on the `signal` process. Same venv as
# main.py — no extra deps.
COPY signal_staging.py ./
RUN uv sync --frozen --no-dev

# ---- sigcli (signal-cli JAR tarball + Java launcher) ----
# The JAR tarball extracts to /opt/signal-cli-<version>/ with a Java
# launcher script at bin/signal-cli that calls `java -jar` under the
# hood. Pinned to a specific release so image builds are reproducible.
# Update in lockstep with the local Mac install when you bump signal-cli
# (see add-signal SKILL.md).
FROM debian:bookworm-slim AS sigcli

# PAT 2026-06-25: bumped 0.14.3 → 0.14.5 to fix signal-cli issue #2059 — the
# Signal server stopped including serverGuid in some sealed-sender envelopes
# (~2026-06-10), and libsignal's non-null check threw getServerGuid-null,
# silently DROPPING every sealed-sender inbound (Signal's default for contacts)
# before it could decrypt. Symptom: receive thread healthy but zero inbound
# reaches the adapter; user gets no reply. Fixed in 0.14.5 ("Receiving
# unidentified sender messages after signal server change"). JRE 25 unchanged.
ARG SIGNAL_CLI_VERSION=0.14.5

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      -o /tmp/signal-cli.tar.gz \
    && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
    && ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli \
    && rm /tmp/signal-cli.tar.gz \
    && ls -la "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/" "/opt/signal-cli-${SIGNAL_CLI_VERSION}/lib/" | head -20

# ---- runtime ----
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

# Install Temurin JRE 21 (current LTS — signal-cli 0.14.x is tested
# against 17-25, 21 is the safe middle). Adoptium's apt repo serves the
# Debian-native packages. ca-certificates + curl + gnupg are left
# installed: they're small, useful for runtime ops (flyctl ssh into the
# machine to debug signal-cli state via `curl` or `gpg --verify`), and
# the slim-image savings from purging are dwarfed by the JRE itself.
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

# PAT 2026-06-25: keep in lockstep with the sigcli stage (0.14.5 — see #2059 note above).
ARG SIGNAL_CLI_VERSION=0.14.5

WORKDIR /app
COPY --from=build /app /app
COPY --from=sigcli /opt /opt
RUN ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli
COPY signal-cli/entrypoint.sh /app/signal-cli/entrypoint.sh
COPY signal-cli/watchdog.sh /app/signal-cli/watchdog.sh
COPY signal-cli/keepalive.sh /app/signal-cli/keepalive.sh
RUN chmod +x /app/signal-cli/entrypoint.sh /app/signal-cli/watchdog.sh /app/signal-cli/keepalive.sh

# Smoke-test: ensure the launcher script can locate java and load the
# main class. This catches the JAR/JRE setup at build time rather than
# at boot (the GraalVM native binary's runtime crash was *exactly* the
# class of failure we want to surface in CI).
RUN signal-cli --version

EXPOSE 8000
# CMD is overridden per-process by fly.toml [processes]; this default is the
# cartesia transport so `docker run …` outside Fly still does something useful.
CMD ["python", "main.py"]
