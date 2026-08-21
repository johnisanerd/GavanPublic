/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
// PAT: cross-channel auto-approve — link a Slack sender to a known person by
// email (users.info) so they're auto-recognized like signal/pstn senders.
import { createSlackPersonLinkInterceptor } from './slack-person-link.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    // PAT: supportsThreads=true with a one-line patch to @chat-adapter/slack
    // (see nanoclaw/patches/) that drops the upstream synthesis of
    // event.ts as threadTs for non-DM top-level posts. Combined with this
    // flag staying true, the router preserves real thread_ts end-to-end:
    // top-level posts get threadTs="" → reply at channel level; in-thread
    // posts keep parent thread_ts → reply lands in the thread; DMs unchanged.
    // Typing indicator works in DMs and threaded contexts; top-level posts
    // can't show typing (Slack's assistant.threads.setStatus requires a
    // thread).
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };

    // PAT: wrap setup to splice the person-link interceptor into onInbound —
    // mirrors the Telegram pairing interceptor pattern. On first sight of an
    // unlinked Slack handle it resolves the sender's email (users.info) and
    // links a matching person, so the downstream access gate auto-approves
    // vouched-for humans. Requires the bot's `users:read.email` scope.
    const token = env.SLACK_BOT_TOKEN;
    const wrapped: ChannelAdapter = {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        return bridge.setup({
          ...hostConfig,
          onInbound: createSlackPersonLinkInterceptor(token, hostConfig.onInbound),
        });
      },
    };
    return wrapped;
  },
});
