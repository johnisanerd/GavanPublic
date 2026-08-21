/**
 * Tiny module-scoped bridge for the browser-side RTT correlation id.
 *
 * use-banter-driver mints a fresh `correlation_id` per user-turn
 * dispatch and stashes it here. use-anam-session reads it on every
 * banter delta arrival to stamp `utterance.delta-received` rows.
 *
 * Module scope is sufficient because pat-web runs one Anam session
 * per page; the two hooks live in the same React tree, and the
 * driver always fires *before* the banter EventSource receives its
 * deltas (the POST is what triggers the upstream pipeline). On
 * concurrent turns the latest mint wins — which matches the actual
 * user-facing model: the previous turn's POST has already been
 * aborted by the time the next dispatch fires.
 *
 * Kept out of a React context / ref because (a) it's set from
 * non-component code (dispatchTurn helper) and (b) the consumer is
 * a closure registered on an EventSource that survives re-renders.
 */

let latestCorrelationId = '';

export function setLatestCorrelationId(id: string): void {
  latestCorrelationId = id;
}

export function getLatestCorrelationId(): string {
  return latestCorrelationId;
}
