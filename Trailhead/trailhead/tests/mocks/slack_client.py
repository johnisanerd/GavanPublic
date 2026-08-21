"""Mock Slack client for testing Slack flows end-to-end.

Tracks all messages, updates, and actions for assertion in tests.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SlackMessage:
    """Represents a Slack message and its history."""

    channel: str
    ts: str
    text: str
    blocks: list[dict[str, Any]] | None = None
    thread_ts: str | None = None
    updates: list[dict[str, Any]] = field(default_factory=list)
    deleted: bool = False

    @property
    def current_text(self) -> str:
        """Get current text after all updates."""
        if self.updates:
            return self.updates[-1].get("text", self.text)
        return self.text

    @property
    def current_blocks(self) -> list[dict[str, Any]] | None:
        """Get current blocks after all updates."""
        if self.updates:
            return self.updates[-1].get("blocks", self.blocks)
        return self.blocks


@dataclass
class EphemeralMessage:
    """Represents an ephemeral message (only visible to one user)."""

    channel: str
    user: str
    text: str
    blocks: list[dict[str, Any]] | None = None


@dataclass
class UploadedFile:
    """Represents an uploaded file."""

    channel: str
    filename: str
    content: bytes
    thread_ts: str | None = None


class MockSlackClient:
    """Mock Slack WebClient that records all interactions.

    Usage:
        client = MockSlackClient()

        # Run code that uses the client
        await some_slack_handler(client=client)

        # Assert on what happened
        assert len(client.messages) == 1
        assert "Running" in client.messages[0].current_text
        assert client.messages[0].updates  # Was updated at least once
    """

    def __init__(self) -> None:
        self.messages: list[SlackMessage] = []
        self.ephemeral_messages: list[EphemeralMessage] = []
        self.uploaded_files: list[UploadedFile] = []
        self._ts_counter = 1000000

    def _next_ts(self) -> str:
        """Generate next unique timestamp."""
        self._ts_counter += 1
        return f"{self._ts_counter}.000000"

    def _find_message(self, channel: str, ts: str) -> SlackMessage | None:
        """Find a message by channel and ts."""
        for msg in self.messages:
            if msg.channel == channel and msg.ts == ts:
                return msg
        return None

    # --- Slack API methods ---

    async def chat_postMessage(
        self,
        *,
        channel: str,
        text: str = "",
        blocks: list[dict[str, Any]] | None = None,
        thread_ts: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Post a new message."""
        ts = self._next_ts()
        msg = SlackMessage(
            channel=channel,
            ts=ts,
            text=text,
            blocks=blocks,
            thread_ts=thread_ts,
        )
        self.messages.append(msg)
        return {"ok": True, "ts": ts, "channel": channel}

    async def chat_update(
        self,
        *,
        channel: str,
        ts: str,
        text: str = "",
        blocks: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Update an existing message."""
        msg = self._find_message(channel, ts)
        if not msg:
            return {"ok": False, "error": "message_not_found"}

        msg.updates.append({"text": text, "blocks": blocks})
        return {"ok": True, "ts": ts, "channel": channel}

    async def chat_postEphemeral(
        self,
        *,
        channel: str,
        user: str,
        text: str = "",
        blocks: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Post an ephemeral message (only visible to one user)."""
        self.ephemeral_messages.append(
            EphemeralMessage(channel=channel, user=user, text=text, blocks=blocks)
        )
        return {"ok": True}

    async def chat_delete(
        self,
        *,
        channel: str,
        ts: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Delete a message."""
        msg = self._find_message(channel, ts)
        if msg:
            msg.deleted = True
            return {"ok": True}
        return {"ok": False, "error": "message_not_found"}

    async def files_upload_v2(
        self,
        *,
        channel: str,
        filename: str,
        content: bytes,
        thread_ts: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Upload a file."""
        self.uploaded_files.append(
            UploadedFile(
                channel=channel,
                filename=filename,
                content=content,
                thread_ts=thread_ts,
            )
        )
        return {"ok": True, "file": {"id": f"F{self._next_ts()}"}}

    # --- Helper methods for tests ---

    def get_messages_in_channel(self, channel: str) -> list[SlackMessage]:
        """Get all messages in a channel."""
        return [m for m in self.messages if m.channel == channel]

    def get_thread_messages(self, channel: str, thread_ts: str) -> list[SlackMessage]:
        """Get all messages in a thread."""
        return [m for m in self.messages if m.channel == channel and m.thread_ts == thread_ts]

    def get_message_by_ts(self, ts: str) -> SlackMessage | None:
        """Find message by timestamp across all channels."""
        for msg in self.messages:
            if msg.ts == ts:
                return msg
        return None

    def find_message_containing(self, text: str) -> SlackMessage | None:
        """Find first message containing text (checks current state after updates)."""
        for msg in self.messages:
            if text in msg.current_text:
                return msg
        return None

    def count_updates(self, ts: str) -> int:
        """Count how many times a message was updated."""
        msg = self.get_message_by_ts(ts)
        return len(msg.updates) if msg else 0

    def reset(self) -> None:
        """Clear all recorded interactions."""
        self.messages.clear()
        self.ephemeral_messages.clear()
        self.uploaded_files.clear()
        self._ts_counter = 1000000
