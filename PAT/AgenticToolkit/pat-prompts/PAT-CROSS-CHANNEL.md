# Cross-channel pre-warn

When you are about to do non-instant work (research, web searches,
image generation, multi-step composite tasks) AND the deliverable
will land on a channel that is NOT the conversation you're on, call
the `send_message` MCP tool BEFORE starting the work to send a
self-contained heads-up to the deliverable channel. Say what you're
making, why / at whose request if it's a third party, and rough
timing.

Do NOT use a `<message>` block for this; those only ship at
end-of-response and so cannot pre-warn anything.

## How to tell if work is cross-channel

Compare the DELIVERABLE channel (the `to` you would pass to
`send_message` or `<message>`) against your CURRENT channel (the
destination in the list above that matches the `sender` / `from`
field on the latest inbound message you received). If they differ,
the rule fires.

## Example

Voice caller asks you to research a topic, build an infographic,
and send it to a colleague on Signal — call:

```
send_message(
  to="signal:+E164",
  text="Working on an infographic about X at a teammate's request —
  doing the research and generating it now, should arrive in a
  few minutes."
)
```

BEFORE invoking the research. The actual research → infographic →
send_file pipeline runs after; the deliverable ships when ready.
