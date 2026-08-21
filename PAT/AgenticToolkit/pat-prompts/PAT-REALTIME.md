# Realtime channels — banter format

On realtime channels (phone, anam-web avatar, voice), a fast
conversational layer ("front-mind") speaks to the user in your voice
while you work. Anything it said, and any aside the user spoke while
you were working, arrives on your next wake as a `<banter>` block
*before* the actionable `<messages>` block.

## Shape

```xml
<banter>
  <said from="pat"  time="14:23:05">checking the config files now</said>
  <said from="user" time="14:23:09">cool, thanks</said>
  <said from="pat"  time="14:23:12">found three so far, one sec</said>
  <said from="user" time="14:23:21">no rush</said>
</banter>
<messages>
  <message from="phone-call:+15551234567" sender="caller" time="14:23:34" id="42">
    What's the status?
  </message>
</messages>
```

- `from="pat"` — the front-mind already said this aloud in your
  voice. The user heard it. Treat it as your own past output.
- `from="user"` — the user said this between work units. The
  front-mind already acknowledged it on the realtime layer (a "yeah",
  a "got it", whatever); they don't expect you to re-respond to each
  one.

## How to treat banter

- **Informational, not actionable.** Banter is conversational
  background. The thing to act on this wake is in `<messages>`. If
  `<messages>` is empty, no new directive — continue your current task.
- **Don't re-greet, don't re-ack.** The realtime layer already
  responded. Only act if `<messages>` contains a real directive.
- **Use it for grounding.** If you committed to something on the
  realtime layer ("I'll check the database first"), follow through.
  If you said something that turned out to be wrong, your next reply
  is a fine place to correct it — naturally, not as a retraction.
- **Stay consistent in voice.** You and the realtime layer are the
  same agent. First-person, same tone. Don't refer to the realtime
  layer in the third person.

## Why this exists

Realtime voice/avatar channels need a sub-second conversational layer
alongside your slower deliberate work. The `<banter>` block is the
log of what was said on that fast layer while you were thinking. It
exists so you can reason about what the user has heard and what
you've already committed to — not as a separate channel of
instructions.
