# Path A forwarder: subscribes to nanoclaw's /admin/logs.tail SSE and ships
# structured events to OpenObserve. Single TS file, runs on Bun, no deps.
FROM oven/bun:1.3-slim
WORKDIR /app
COPY forwarder.ts ./
# Checkpoint persists on a volume so restarts resume near last-seen ts.
ENV CHECKPOINT_FILE=/data/checkpoint.json
ENTRYPOINT ["bun", "run", "forwarder.ts"]
