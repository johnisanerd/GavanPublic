/**
 * Unit tests for the per-call HTTP-timing instrumentation. The module
 * subscribes to undici's `diagnostics_channel` events; we don't want to
 * issue real fetches in tests, so we publish on the channels directly
 * and assert the timing classification flips appropriately.
 *
 * Why this matters: the production diagnosis for "wildly inconsistent
 * banter-ack ttfb" depends on `connection_reused` being correctly
 * classified per call. A unit test of the host-keyed window logic gives
 * us confidence the field isn't lying in production.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markCallStart,
  markCallEnd,
  _resetLlmHttpInstrumentationForTesting,
} from './llm-http-instrumentation.js';

const HOST = 'api.cerebras.ai';
const OTHER_HOST = 'openrouter.ai';

function fireBeforeConnect(hostname: string): void {
  diagnosticsChannel.channel('undici:client:beforeConnect').publish({
    connectParams: { hostname },
  });
}

function fireConnected(hostname: string): void {
  diagnosticsChannel.channel('undici:client:connected').publish({
    connectParams: { hostname },
  });
}

describe('llm-http-instrumentation', () => {
  beforeEach(() => {
    _resetLlmHttpInstrumentationForTesting();
  });

  afterEach(() => {
    _resetLlmHttpInstrumentationForTesting();
  });

  it('returns undefined connectionReused before any connect to host', () => {
    const ctx = markCallStart();
    const result = markCallEnd(ctx, HOST);
    expect(result.connectionReused).toBeUndefined();
    expect(result.connectMs).toBeUndefined();
  });

  it('marks call as cold (connection_reused=false) when beforeConnect fires during the call', async () => {
    const ctx = markCallStart();
    // Yield so the timestamp gap is observable.
    await new Promise((r) => setTimeout(r, 2));
    fireBeforeConnect(HOST);
    await new Promise((r) => setTimeout(r, 2));
    fireConnected(HOST);
    const result = markCallEnd(ctx, HOST);
    expect(result.connectionReused).toBe(false);
    expect(typeof result.connectMs).toBe('number');
    expect(result.connectMs!).toBeGreaterThanOrEqual(0);
  });

  it('marks call as warm (connection_reused=true) when no beforeConnect fires during the call', async () => {
    // Establish a connection BEFORE the call starts.
    fireBeforeConnect(HOST);
    fireConnected(HOST);
    await new Promise((r) => setTimeout(r, 5));
    const ctx = markCallStart();
    await new Promise((r) => setTimeout(r, 2));
    const result = markCallEnd(ctx, HOST);
    expect(result.connectionReused).toBe(true);
    // connectMs is for THIS call only — warm calls don't report it.
    expect(result.connectMs).toBeUndefined();
  });

  it('is host-keyed — a connect to OTHER_HOST does not mark HOST as cold', async () => {
    // Establish a connection to HOST first so we have prior observations.
    fireBeforeConnect(HOST);
    fireConnected(HOST);
    // Sleep so the prior connect is strictly OLDER than markCallStart;
    // Date.now() is ms-precision and the prior events plus the call
    // start frequently land on the same millisecond otherwise.
    await new Promise((r) => setTimeout(r, 5));
    const ctx = markCallStart();
    await new Promise((r) => setTimeout(r, 2));
    // A connect to a DIFFERENT host fires during our window.
    fireBeforeConnect(OTHER_HOST);
    fireConnected(OTHER_HOST);
    await new Promise((r) => setTimeout(r, 2));
    const result = markCallEnd(ctx, HOST);
    expect(result.connectionReused).toBe(true);
  });

  it('lastConnectedAt is exposed even when the call itself was warm', async () => {
    fireBeforeConnect(HOST);
    fireConnected(HOST);
    const connectedAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const ctx = markCallStart();
    const result = markCallEnd(ctx, HOST);
    expect(result.lastConnectedAt).toBeDefined();
    // Within 50ms slop of when we fired the synthetic event.
    expect(Math.abs(result.lastConnectedAt! - connectedAt)).toBeLessThan(50);
  });
});
