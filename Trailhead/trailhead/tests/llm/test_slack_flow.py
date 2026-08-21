"""End-to-end tests for Slack interaction flows.

These tests call the actual handlers with a MockSlackClient to verify
the full Slack flow works correctly.
"""

from unittest.mock import AsyncMock

import pytest

from tests.mocks import MockSlackClient


@pytest.fixture
def mock_client():
    """Create a fresh MockSlackClient for each test."""
    return MockSlackClient()


@pytest.fixture
def mock_say(mock_client):
    """Create a mock say function that uses the mock client."""

    async def _say(text="", **kwargs):
        await mock_client.chat_postMessage(
            channel=kwargs.get("channel", "C123"),
            text=text,
            **{k: v for k, v in kwargs.items() if k != "channel"},
        )

    return _say


@pytest.fixture
def mock_ack():
    """Create a mock ack function."""
    return AsyncMock()


@pytest.fixture
def clear_stores():
    """Clear trailrun and task stores before/after each test."""
    from src.trailrun import store, tasks

    store._store.clear()
    tasks._tasks.clear()
    yield
    store._store.clear()
    tasks._tasks.clear()


class TestAppMentionFlow:
    """Test the @Trailhead mention flow."""

    async def test_mention_without_content_shows_help(self, mock_client, mock_say, clear_stores):
        """@Trailhead with no description shows help message."""
        from src.slack.events.app_mention import handle_app_mention

        event = {
            "user": "U123",
            "channel": "C456",
            "text": "<@BOT123>",  # Just the mention, no content
        }

        await handle_app_mention(event, mock_say, mock_client)

        # Should have posted help message
        assert len(mock_client.messages) >= 1

    @pytest.mark.llm
    async def test_mention_with_description_generates_config(
        self, mock_client, mock_say, clear_stores
    ):
        """@Trailhead with description generates experiment config and shows buttons."""
        from src.slack.events.app_mention import handle_app_mention

        event = {
            "user": "U123",
            "channel": "C456",
            "text": "<@BOT123> test if GPT can add 2+2",
        }

        await handle_app_mention(event, mock_say, mock_client)

        # Should have posted a message
        assert len(mock_client.messages) >= 1

        # The message should have been updated with config blocks
        msg = mock_client.messages[0]
        assert len(msg.updates) >= 1

        # Final state should have blocks with experiment config
        final_blocks = msg.current_blocks
        assert final_blocks is not None
        block_types = [b.get("type") for b in final_blocks]
        assert "header" in block_types


class TestExperimentStartFlow:
    """Test the experiment start action flow."""

    @pytest.mark.llm
    async def test_full_flow_mention_then_start(
        self, mock_client, mock_say, mock_ack, clear_stores
    ):
        """Full flow: @mention generates config, then Start begins experiment."""
        from src.slack.actions.experiment_start import handle_experiment_start
        from src.slack.events.app_mention import handle_app_mention
        from src.trailrun import cancel_trailrun, store

        # Step 1: @mention to generate config
        event = {
            "user": "U123",
            "channel": "C456",
            "text": "<@BOT123> test if GPT can add 2+2",
        }
        await handle_app_mention(event, mock_say, mock_client)

        # Get the trailrun that was created
        trailruns = list(store._store.values())
        assert len(trailruns) == 1
        trailrun = trailruns[0]

        # Get the message timestamp
        msg = mock_client.messages[0]
        message_ts = msg.ts

        # Step 2: Click Start button
        action = {"value": trailrun.id}
        body = {
            "channel": {"id": "C456"},
            "user": {"id": "U123"},
            "message": {"ts": message_ts},
        }

        await handle_experiment_start(mock_ack, action, body, mock_client)

        # Verify ack was called
        mock_ack.assert_called_once()

        # Verify message was updated to show running status
        assert len(msg.updates) >= 2  # At least config update + running update

        # Cleanup
        cancel_trailrun(trailrun.id)


class TestCancelFlow:
    """Test the experiment cancel flow."""

    async def test_cancel_stops_running_task(self, mock_client, mock_ack, clear_stores):
        """Clicking Cancel stops a running task."""
        import asyncio

        from src.runner.types import ExperimentConfig
        from src.slack.actions.experiment_cancel import handle_experiment_cancel
        from src.trailrun import create_trailrun, list_active_trailruns, update_trailrun
        from src.trailrun.tasks import create_trailrun_task
        from src.trailrun.types import Phase

        # Setup: Create a trailrun in RUN phase with a running task
        trailrun = create_trailrun(channel_id="C456", user_id="U123")
        config = ExperimentConfig(
            title="Long Experiment",
            prompts=["test"],
            models=["gpt-5-nano"],
            n=1,
        )
        await update_trailrun(trailrun.id, config=config, phase=Phase.RUN)

        # Post a message to track
        result = await mock_client.chat_postMessage(channel="C456", text="Running...")
        message_ts = result["ts"]
        await update_trailrun(trailrun.id, thread_ts=message_ts)

        # Create a fake running task
        async def fake_long_task():
            await asyncio.sleep(100)

        task = create_trailrun_task(trailrun.id, fake_long_task())
        assert trailrun.id in list_active_trailruns()

        # Click Cancel
        action = {"value": trailrun.id}
        body = {
            "channel": {"id": "C456"},
            "user": {"id": "U123"},
            "message": {"ts": message_ts},
        }

        await handle_experiment_cancel(mock_ack, action, body, mock_client)

        # Verify ack was called
        mock_ack.assert_called_once()

        # Give cancellation time to propagate
        await asyncio.sleep(0.1)

        # Verify task was cancelled
        assert task.cancelled() or task.done()


class TestSlackBlockOutput:
    """Test the actual Slack Block Kit output that would be sent."""

    @pytest.mark.llm
    @pytest.mark.asyncio
    async def test_slack_summarizer_output_has_correct_deep_links(self):
        """Verify Slack summarizer produces blocks with correct deep link format.

        This is the critical e2e test for Slack output. It verifies:
        1. Deep links have /sample/{id}/{epoch}/ path (not just /samples/messages)
        2. Attribution shows actual sample/turn numbers (not ?.?)
        3. Block structure is valid for Slack
        """
        from src.orchestration.analysis.highlighter import Highlight
        from src.orchestration.analysis.summarizers import SummarizerOptions, get_summarizer

        # Create highlights with realistic data (as they would come from extract_highlights)
        highlights = [
            Highlight(
                index=1,
                description="Model expressed uncertainty",
                quoted_text="I'm not entirely certain about this, but I believe the answer is 42.",
                message_id="msg-abc123",
                deep_link="https://example.com/data-inspector/tr_xxx/index.html#/logs/eval.eval/samples/sample/1/1/messages?message=msg-abc123",
                case=1,
                epoch=1,
                turn=5,
            ),
            Highlight(
                index=2,
                description="Creative response",
                quoted_text="Let me approach this from a different angle entirely.",
                message_id="msg-def456",
                deep_link="https://example.com/data-inspector/tr_xxx/index.html#/logs/eval.eval/samples/sample/2/1/messages?message=msg-def456",
                case=2,
                epoch=1,
                turn=3,
            ),
        ]

        # Sample research content
        research_content = """
        Inspect AI Evaluation Log
        Model: openai/gpt-4o-mini
        Task: test-task

        Sample 1:
        [user]: What is the meaning of life?
        [assistant]: I'm not entirely certain about this, but I believe the answer is 42.

        Sample 2:
        [user]: How would you solve this problem?
        [assistant]: Let me approach this from a different angle entirely.
        """

        # Call the SLACK summarizer (not prose!)
        summarizer = get_summarizer("slack")
        result = await summarizer(
            research_content=research_content,
            model="anthropic/claude-sonnet-4",
            timeout=60.0,
            options=SummarizerOptions(
                research_type="inspect_eval",
                models=["openai/gpt-4o-mini"],
                samples_included=2,
                samples_total=2,
                highlights=highlights,
            ),
        )

        # Verify we got blocks back
        assert result.blocks is not None
        assert len(result.blocks) > 0

        # Find all rich_text blocks (these are our citations)
        rich_text_blocks = [b for b in result.blocks if b.get("type") == "rich_text"]
        context_blocks = [b for b in result.blocks if b.get("type") == "context"]

        # Should have citation blocks if the LLM used cited_highlight
        # (The LLM might not always cite, so we check if it did)
        if rich_text_blocks:
            # Verify rich_text structure
            for block in rich_text_blocks:
                assert "elements" in block
                elements = block["elements"]
                assert len(elements) > 0
                # Should have rich_text_quote element
                quote_elements = [e for e in elements if e.get("type") == "rich_text_quote"]
                assert len(quote_elements) > 0, f"rich_text block missing quote: {block}"

        # Check context blocks for attribution
        for block in context_blocks:
            elements = block.get("elements", [])
            for elem in elements:
                if elem.get("type") == "mrkdwn":
                    text = elem.get("text", "")
                    # If this is a citation attribution, verify it has sample.turn format
                    if "gpt-4o-mini" in text.lower() or "gpt" in text.lower():
                        # Should NOT have "?.?" - should have actual numbers
                        assert "?.?" not in text, f"Attribution missing sample/turn: {text}"

        # Verify deep links in context blocks have correct format
        for block in context_blocks:
            elements = block.get("elements", [])
            for elem in elements:
                if elem.get("type") == "mrkdwn":
                    text = elem.get("text", "")
                    # Check for deep links
                    if "/data-inspector/" in text and "/samples/" in text:
                        # Verify it has /sample/{id}/{epoch}/ format, not just /samples/messages
                        assert "/sample/" in text, f"Deep link missing /sample/ path: {text}"
                        # Should have format: /samples/sample/X/Y/messages
                        assert "/samples/sample/" in text, f"Deep link wrong format: {text}"

        print("\n✅ Slack output test passed!")
        print(f"   Total blocks: {len(result.blocks)}")
        print(f"   Rich text (quotes): {len(rich_text_blocks)}")
        print(f"   Context (attribution): {len(context_blocks)}")


class TestFullE2EFlow:
    """Complete end-to-end flow with follow-up questions."""

    @pytest.mark.llm
    @pytest.mark.timeout(120)
    async def test_full_flow_with_followup_question(
        self, mock_client, mock_say, mock_ack, clear_stores
    ):
        """Full flow: @mention → config → start → wait for completion → ask question."""
        import asyncio

        from src.slack.actions.experiment_start import handle_experiment_start
        from src.slack.events.app_mention import handle_app_mention
        from src.trailrun import get_trailrun, store

        # =========================================================
        # Step 1: @mention to generate experiment config
        # =========================================================
        event = {
            "user": "U123",
            "channel": "C456",
            "text": "<@BOT123> test if GPT can add 2+2",
        }
        await handle_app_mention(event, mock_say, mock_client)

        # Get the trailrun that was created
        trailruns = list(store._store.values())
        assert len(trailruns) == 1
        trailrun = trailruns[0]
        assert trailrun.config is not None

        # Get the message timestamp (this becomes the thread_ts)
        msg = mock_client.messages[0]
        message_ts = msg.ts

        # =========================================================
        # Step 2: Click Start button to run the actual experiment
        # =========================================================
        action = {"value": trailrun.id}
        body = {
            "channel": {"id": "C456"},
            "user": {"id": "U123"},
            "message": {"ts": message_ts},
        }

        await handle_experiment_start(mock_ack, action, body, mock_client)
        mock_ack.assert_called_once()

        # =========================================================
        # Step 3: Wait for experiment to actually complete
        # =========================================================
        for _ in range(60):  # Wait up to 60 seconds
            await asyncio.sleep(1)
            updated = get_trailrun(trailrun.id)
            if updated and updated.status == "completed":
                break
        else:
            pytest.fail("Experiment did not complete in time")

        # Verify we have research content
        updated = get_trailrun(trailrun.id)
        assert updated.research_content is not None
        assert len(updated.research_content) > 0

        # =========================================================
        # Step 4: Ask a follow-up question in the thread
        # =========================================================
        followup_event = {
            "user": "U123",
            "channel": "C456",
            "text": "<@BOT123> what did the model say the answer was?",
            "thread_ts": updated.thread_ts,  # Use the actual thread_ts
        }

        initial_message_count = len(mock_client.messages)

        await handle_app_mention(followup_event, mock_say, mock_client)

        # Should have posted an answer in the thread
        assert len(mock_client.messages) > initial_message_count

        # Find the answer (non-deleted messages after the followup)
        thread_messages = [m for m in mock_client.messages[initial_message_count:] if not m.deleted]
        assert len(thread_messages) >= 1
