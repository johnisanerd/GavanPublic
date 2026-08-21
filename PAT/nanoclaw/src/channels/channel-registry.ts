/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter, OutboundDeliveryContext } from '../delivery.js';
import { log } from '../log.js';
// PAT: defensive recipient→person resolution for the outbound.sent log event.
// resolvePersonIdentity never throws and returns { personId: null } on a
// null/unlinked handle or any DB error — so it's safe on the delivery path.
import { resolvePersonIdentity } from '../people/index.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by its EXACT registry key (instance name; default
 *  instances are keyed by channelType itself). No channelType fallback —
 *  callers that address a specific instance (outbound delivery, typing)
 *  must never be rerouted through a sibling instance: that would send
 *  through the wrong bot identity with the wrong token. A missing key
 *  means the owning adapter is offline; callers apply their normal
 *  offline-adapter handling. */
export function getChannelAdapterExact(key: string): ChannelAdapter | undefined {
  return activeAdapters.get(key);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. The fallback exists ONLY for channelType-only callers
 *  (user-id prefix resolution and cold DMs in user-dm.ts, approval delivery
 *  in channel-approval.ts, the router's thread-policy probe when an event
 *  carries no instance) — they must still resolve when every instance of a
 *  platform is named. First registered wins (Map insertion order,
 *  deterministic). Default instances are keyed by channelType itself, so
 *  single-instance installs always hit the exact-key path. Instance-addressed
 *  dispatch (delivery, typing) must use getChannelAdapterExact instead. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const [registryKey, adapter] of activeAdapters) {
    if (adapter.channelType === key) {
      log.warn('Channel adapter fallback: requested key resolved through a differently-keyed instance', {
        requested: key,
        resolvedKey: registryKey,
      });
      return adapter;
    }
  }
  return undefined;
}

/**
 * Build the host's outbound delivery bridge: dispatches delivery-poll and
 * typing traffic into the adapter registry. Resolution is EXACT-key only —
 * `instance ?? channelType`. For default-instance messaging_groups rows the
 * stored instance IS the channelType, which matches default-registered
 * adapters, so single-instance behavior is unchanged. A named instance whose
 * adapter is offline gets the normal offline-adapter handling (warn + drop
 * into the delivery retry path) — never a cross-identity send through a
 * sibling bot of the same platform.
 */
// PAT: extract the human-readable body from a parsed outbound content blob.
// Mirrors the (string | { text }) shape every channel adapter handles (see
// e.g. signal.ts deliver). Returns '' for bodyless sends (pure attachment,
// ask_question card) — outbound.sent still records who→who in that case.
function outboundBodyText(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
    return (parsed as { text: string }).text;
  }
  return '';
}

// PAT: emit `outbound.sent` for one delivered outbound message. Fully
// defensive — a logging failure must NEVER break delivery, so the whole body
// is wrapped and swallowed. `recipient_user_id` follows the `<channel>:<handle>`
// convention (== nanoclaw users.id / inbound.received.sender_id); the opaque
// `recipient_person_id` is resolved from it via the people spine. `origin`
// defaults to 'system' when the caller didn't thread a context (all
// host-module system sends); the delivery poll passes origin='agent'.
// `sender_user_id` is left '' — PAT's own per-channel account isn't available
// at this generic seam (best-effort per schema).
function emitOutboundSent(
  channelType: string,
  platformId: string,
  threadId: string | null,
  parsed: unknown,
  ctx?: OutboundDeliveryContext,
): void {
  try {
    const recipientUserId = `${channelType}:${platformId}`;
    const { personId } = resolvePersonIdentity(recipientUserId);
    log.event({
      kind: 'outbound.sent',
      thread_id: threadId,
      session_id: ctx?.sessionId ?? null,
      platform_id: platformId,
      data: {
        channel_type: channelType,
        text: outboundBodyText(parsed),
        recipient_user_id: recipientUserId,
        recipient_person_id: personId,
        sender_user_id: '',
        sender_agent_group_id: ctx?.senderAgentGroupId ?? null,
        origin: ctx?.origin ?? 'system',
      },
    });
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('outbound.sent emit failed', { err });
  }
}

export function createChannelDeliveryAdapter(): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
      ctx?: OutboundDeliveryContext,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType, instance });
        return;
      }
      const parsed: unknown = JSON.parse(content);
      const platformMsgId = await adapter.deliver(platformId, threadId, { kind, content: parsed, files });
      // PAT: emit `outbound.sent` — the symmetric counterpart of
      // `inbound.received`. This `deliver()` is the single channel-agnostic
      // choke point: the outbound delivery poll (back-mind/container replies,
      // origin='agent') AND every host-module system send (permissions /
      // approvals / pairing / signal-health, default origin='system') reach
      // it via getDeliveryAdapter(). One emit here captures PAT's whole
      // outbound half of a conversation. Only fires AFTER a successful
      // adapter.deliver (a missing adapter returns above; a throwing adapter
      // propagates into the retry path) — so the event means "actually sent".
      emitOutboundSent(channelType, platformId, threadId, parsed, ctx);
      return platformMsgId;
    },
    async setTyping(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      // Adapters key by instance (default instance = channelType), so N
      // instances of one platform coexist. Duplicate keys warn instead of
      // throwing — boot stays resilient, matching the historical silent
      // last-write-wins, but now visibly.
      const key = adapter.instance ?? adapter.channelType;
      if (activeAdapters.has(key)) {
        log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
      }
      activeAdapters.set(key, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType, instance: key });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
