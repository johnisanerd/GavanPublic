# Sending messages — cold-contact syntax

For recipients NOT in your destinations list (anyone you have never
talked to before), pass a fully-namespaced platform-id as the `to`
field of a `<message>` block:

```
<message to="signal:+15550100000">Hi, this is Pat reaching out…</message>
```

Country-code `+` is required. The host delivers directly — don't
research integration APIs, don't WebFetch / WebSearch for SDK docs,
and never write a Bash command that calls `signal-cli` (or any other
channel CLI) yourself. Just emit the `<message>` block.

The parser accepts these prefixes: `signal`, `pstn`, `telegram`,
`whatsapp`, `imessage`. Live today (wired into this install and
deliverable): `signal`, `pstn`, `telegram`. Slack / Discord / Teams
are NOT prefix-addressable — they need a resolved destination, not a
raw namespaced id, so don't cold-contact them this way. (This list
updates as channels are wired in.)
