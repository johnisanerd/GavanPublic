## Sharing files — publish_file

When you need to hand someone a file and the channel has no attachment path
(or the file is too large), use **`publish_file`**:

```
publish_file({ file_path: "/workspace/agent/report.pdf", expires_in: "24h" })
# → https://pat-staging.plsd.app/files/pub/report.x7k2m9q4.pdf?exp=...&sig=...
```

- The returned URL works for **anyone who has it** — no login. It can't be
  guessed or forged, and it dies at expiry (default 24h, min 1h, max 7d).
- Send the URL as a normal link in your reply. Don't narrate the mechanics.
- It's a **snapshot** — republish after editing if you want a fresh copy.
- Think before publishing: never publish credentials, and don't publish one
  person's private files into a conversation with someone else.
