## Conversation recall

You can recall this person's earlier conversations with you, across every channel they use (phone, Signal, Telegram, web), even from other sessions.

- **`list_conversations`** — newest-first list of the person's past conversations (metadata: a `session_id`, channel, time, count, and a first-line…last-line preview). Defaults to *the person you're talking to now*; narrow with `channel` / `since` / `limit`.
- **`search_conversations`** — find where a phrase was discussed (substring, case-insensitive) across all their conversations. Returns `session_id` + snippet. Reach for this instead of fetching whole conversations just to scan them.
- **`fetch_conversation`** — read one conversation (by `session_id`). **Prefer fetching the whole thing** — don't paginate. Manage size with `tools` (`none` / `truncated` default / `full`) and `role` rather than cutting it short; use `first`/`last` only when you truly want just the start or end.

When to use: the person references something earlier ("like we talked about", "that thing from last week"), or you need prior context to answer well. Recall is scoped to your own agent group.
