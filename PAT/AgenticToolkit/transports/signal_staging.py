"""
signal-staging — tiny HTTP sidecar that lets pat-nanoclaw stage
attachment bytes onto signal-cli's local filesystem before invoking
the JSON-RPC `send` command with a real path.

Context: signal-cli runs on the `signal` process of pat-transports,
not colocated with pat-nanoclaw. The previous outbound code wrote
bytes to /tmp on pat-nanoclaw and passed the path to signal-cli,
which then failed with `AttachmentInvalidException` because /tmp on
the two machines are different filesystems.

The data: URL workaround DOES work for plain attachments, but the
Signal client doesn't render the native voice-memo bubble (waveform,
hold-to-listen, server transcription, playback-speed) when
attachments come through that path. Voice notes need a real file
path so signal-cli's `voiceNote: true` flag is honored end-to-end.

This sidecar is the bridge: pat-nanoclaw POSTs the raw bytes, this
service writes them to /tmp on the signal machine, returns the path,
and pat-nanoclaw then calls signal-cli's JSON-RPC `send` with that
path — same as if signal-cli were colocated.

Auth: none. Bound to fly-local-6pn (signal.process.pat-transports.internal:7584),
so only sibling Fly apps in the org can reach it. Same trust model
as the signal-cli JSON-RPC daemon on :7583.

Lifecycle:
  - Files are written under /tmp/signal-stage-<random>.<ext> and
    expected to be one-shot — signal-cli reads them during the upload,
    after which they're stale.
  - A background sweeper deletes files older than STAGING_TTL_SEC
    (default 600s = 10min) so a crashed nanoclaw call doesn't leak
    bytes. Plenty of buffer for normal signal-cli upload latency.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response

logging.basicConfig(level=logging.INFO, format='%(asctime)s [signal-staging] %(message)s')
log = logging.getLogger('signal-staging')

PORT = int(os.environ.get('SIGNAL_STAGING_PORT', '7584'))
# Bind IPv6 wildcard — Fly's 6PN is IPv6-only, sibling apps reach us
# via `signal.process.pat-transports.internal` which resolves to an
# fdaa:: address. `0.0.0.0` is IPv4-only and would be unreachable
# from pat-nanoclaw. signal-cli's Java socket binds dual-stack on
# `0.0.0.0` automatically; Python/uvicorn doesn't — so we ask for
# `::` explicitly. Loopback IPv4 still works via this (dual-stack
# accept).
BIND = os.environ.get('SIGNAL_STAGING_BIND', '::')
STAGING_TTL_SEC = int(os.environ.get('SIGNAL_STAGING_TTL_SEC', '600'))
MAX_BYTES = int(os.environ.get('SIGNAL_STAGING_MAX_BYTES', str(100 * 1024 * 1024)))  # 100MB ceiling


async def sweeper_task() -> None:
    """Background loop: delete /tmp/signal-stage-* files older than TTL."""
    while True:
        try:
            cutoff = time.time() - STAGING_TTL_SEC
            for p in Path('/tmp').glob('signal-stage-*'):
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass
                except Exception as e:
                    log.warning('sweep error on %s: %s', p, e)
        except Exception as e:
            log.warning('sweep loop error: %s', e)
        await asyncio.sleep(STAGING_TTL_SEC // 2)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(sweeper_task())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(lifespan=lifespan)


@app.get('/healthz')
async def healthz() -> dict:
    return {'status': 'ok', 'service': 'signal-staging'}


@app.post('/stage')
async def stage(request: Request, response: Response) -> dict:
    """Write raw request body to a fresh /tmp file and return its path.

    Caller passes `?ext=.ogg` to control the suffix (signal-cli uses it
    for MIME sniffing). Defaults to no extension.
    """
    ext = request.query_params.get('ext', '')
    if ext and not ext.startswith('.'):
        ext = '.' + ext
    if any(c in ext for c in '/\\\x00'):
        response.status_code = 400
        return {'error': 'invalid ext'}

    # Streamed read with a hard ceiling — signal-cli's own attachment
    # cap is ~100MB, no point buffering more.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BYTES:
            response.status_code = 413
            return {'error': f'too large; ceiling {MAX_BYTES} bytes'}

    fd, path = tempfile.mkstemp(prefix='signal-stage-', suffix=ext, dir='/tmp')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(body)
    except Exception:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise

    log.info('staged %d bytes → %s', len(body), path)
    return {'path': path, 'bytes': len(body)}


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host=BIND, port=PORT, log_level='info')
