# Path B shipper: Vector subscribing to Fly's org NATS log stream, scoped to the
# pat-* namespace, shipping raw stdout/stderr to OpenObserve `pat_raw`.
FROM timberio/vector:0.49.0-debian
COPY vector.toml /etc/vector/vector.toml
CMD ["--config", "/etc/vector/vector.toml"]
