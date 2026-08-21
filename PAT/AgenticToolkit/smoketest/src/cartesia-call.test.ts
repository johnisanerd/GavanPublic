/**
 * Unit tests for the audio-stream mixer used to render call.wav.
 *
 * These pin down the wall-clock-gap behaviour that makes the recording
 * accurate. We don't burn Cartesia minutes verifying timing — these tests
 * fail loudly if the gap math drifts.
 */
import { describe, it, expect } from 'vitest';

import {
  appendChunk,
  newAudioStream,
  streamDurationSec,
  type AudioStream,
} from './cartesia-call.js';

const SAMPLE_RATE = 44100;
const BYTES_PER_SAMPLE = 2;
const BYTE_RATE = SAMPLE_RATE * BYTES_PER_SAMPLE;

/** Make a PCM chunk of `durationMs` of arbitrary (non-silent) audio. */
function pcm(durationMs: number, fillByte = 0x42): Buffer {
  const bytes = Math.floor((durationMs / 1000) * BYTE_RATE);
  return Buffer.alloc(bytes, fillByte);
}

function durationMs(s: AudioStream): number {
  return Math.round(streamDurationSec(s) * 1000);
}

describe('appendChunk wall-clock gap handling', () => {
  it('first chunk anchors startMs and contributes its full duration', () => {
    const s = newAudioStream();
    appendChunk(s, pcm(500), 1000);
    expect(s.startMs).toBe(1000);
    expect(durationMs(s)).toBe(500);
  });

  it('back-to-back arrivals concatenate (no silence inserted)', () => {
    const s = newAudioStream();
    // Frame 1: 200ms of audio arrives at t=1000.
    appendChunk(s, pcm(200), 1000);
    // Frame 2: 200ms more arrives at t=1200 — exactly when frame 1 would end.
    appendChunk(s, pcm(200), 1200);
    // Total stream duration: 400ms, no silence padding.
    expect(durationMs(s)).toBe(400);
  });

  it('rapid bursts (chunks arriving early) concatenate without overlap', () => {
    const s = newAudioStream();
    // Frame 1: 100ms of audio at t=1000.
    appendChunk(s, pcm(100), 1000);
    // Frame 2: 100ms at t=1010 (network delivered a burst). Even though
    // arrival was only 10ms after frame 1's start, frame 1's audio is
    // 100ms long — so frame 2 still represents continuous audio. No silence.
    appendChunk(s, pcm(100), 1010);
    expect(durationMs(s)).toBe(200);
  });

  it('inserts silence when a chunk arrives after a real wall-clock pause', () => {
    const s = newAudioStream();
    // 200ms of audio at t=1000. Audio ends at t=1200.
    appendChunk(s, pcm(200), 1000);
    // Next chunk arrives at t=2200 — 1000ms after audio would have ended.
    appendChunk(s, pcm(200), 2200);
    // Stream now: 200ms + 1000ms silence + 200ms = 1400ms.
    expect(durationMs(s)).toBeCloseTo(1400, -1);
  });

  it('multiple gaps stack correctly across a sequence', () => {
    const s = newAudioStream();
    appendChunk(s, pcm(500), 0);     // 0–500ms
    appendChunk(s, pcm(500), 2000);  // gap 1500ms → silence; then 2000–2500ms
    appendChunk(s, pcm(500), 5000);  // gap 2500ms → silence; then 5000–5500ms
    expect(durationMs(s)).toBeCloseTo(5500, -1);
  });

  it('gap below the 50ms threshold is treated as continuous', () => {
    const s = newAudioStream();
    appendChunk(s, pcm(200), 1000);
    // Frame 2 arrives 30ms late — under threshold, so it's concat'd.
    appendChunk(s, pcm(200), 1230);
    expect(durationMs(s)).toBe(400);
  });

  it('preserves s16le alignment across odd-byte chunks', () => {
    const s = newAudioStream();
    // 3-byte chunk: even part (2 bytes) is appended; 1 byte carries.
    appendChunk(s, Buffer.from([1, 2, 3]), 1000);
    expect(s.carry.length).toBe(1);
    // 1-byte chunk: combined with carry → 2 bytes total, all appended.
    appendChunk(s, Buffer.from([4]), 1000);
    expect(s.carry.length).toBe(0);
    // Total appended bytes = 4 = 2 samples; bytesTotal reflects that.
    expect(s.bytesTotal).toBe(4);
  });

  it('two-stream barge-in: independent gaps preserved per stream', () => {
    // Simulates user speaks at +0ms (1s of audio), agent starts at +1500ms
    // (overlap). After the call, both streams' wall-clock starts and
    // durations should be preserved.
    const user = newAudioStream();
    const agent = newAudioStream();
    appendChunk(user, pcm(1000), 0);
    appendChunk(agent, pcm(800), 1500);
    expect(user.startMs).toBe(0);
    expect(durationMs(user)).toBe(1000);
    expect(agent.startMs).toBe(1500);
    expect(durationMs(agent)).toBe(800);
    // When mixed, agent audio plays from 1500ms (overlap with last 500ms
    // of user audio); the harness's `placeStream` uses startMs to position
    // the stream, so the mix is correct as long as these invariants hold.
  });
});
