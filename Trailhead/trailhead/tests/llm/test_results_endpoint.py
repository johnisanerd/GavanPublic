"""Integration tests for the /trailrun/{id}/results endpoint.

These tests run the full experiment pipeline and verify the results endpoint
works correctly with all format and filter combinations.

Requires a valid OPENROUTER_API_KEY in the environment.
Run with: uv run pytest tests/llm/test_results_endpoint.py -v
"""

import httpx
import pytest


@pytest.mark.llm
class TestResultsEndpoint:
    """Test the /trailrun/{id}/results endpoint with a real experiment."""

    @pytest.fixture(scope="class")
    def completed_trailrun(self, running_server):
        """Create and run a complete trailrun for testing.

        This fixture runs once per test class to avoid repeating expensive
        LLM calls. All tests in the class share the same completed trailrun.

        Note: running_server is session-scoped, but this fixture is class-scoped
        to allow different test classes to have their own trailruns if needed.
        """
        # Step 1: Create trailrun
        response = httpx.post(
            f"{running_server}/trailrun",
            json={},
            timeout=10.0,
        )
        assert response.status_code == 200
        trailrun_id = response.json()["trailrun_id"]

        # Step 2: Design experiment with 2 models and 2 epochs
        # This ensures we have enough variety for filter testing
        response = httpx.post(
            f"{running_server}/trailrun/{trailrun_id}/design",
            json={
                "description": (
                    "Compare gpt-4o-mini and claude-3-5-haiku on basic math. "
                    "Prompt: 'What is 2+2?' Run 2 samples."
                )
            },
            timeout=60.0,
        )
        assert response.status_code == 200
        config = response.json()["config"]

        # Step 3: Run the experiment
        response = httpx.post(
            f"{running_server}/trailrun/{trailrun_id}/run",
            timeout=180.0,
        )
        assert response.status_code == 200
        run_result = response.json()

        return {
            "trailrun_id": trailrun_id,
            "config": config,
            "run_result": run_result,
            "base_url": running_server,
        }

    def test_results_json_format(self, completed_trailrun):
        """Test results endpoint returns valid JSON structure."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "trailrun_id" in data
        assert "status" in data
        assert "experiment" in data
        assert "execution" in data
        assert "filters" in data
        assert "schema" in data
        assert "results" in data

        # Verify experiment metadata
        assert data["experiment"]["title"] is not None
        assert len(data["experiment"]["prompts"]) >= 1
        assert len(data["experiment"]["models"]) >= 1

        # Verify results structure
        results = data["results"]
        assert len(results) > 0, "Should have results"

        for result in results:
            assert "model" in result
            assert "sample" in result
            assert "epoch" in result
            assert "turn" in result
            assert "role" in result
            assert "content" in result

        # Verify sorting: model, sample, epoch, turn
        sorted_results = sorted(
            results,
            key=lambda r: (
                r["model"] or "",
                r["sample"] or "",
                r["epoch"] or 0,
                r["turn"] or 0,
            ),
        )
        assert results == sorted_results, "Results should be sorted by model, sample, epoch, turn"

        print("\n✅ JSON format test passed!")
        print(f"   Total results: {len(results)}")
        print(f"   Models: {set(r['model'] for r in results)}")
        print(f"   Epochs: {set(r['epoch'] for r in results)}")

    def test_results_toon_format(self, completed_trailrun):
        """Test results endpoint returns valid toon format."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"format": "toon"},
            timeout=10.0,
        )
        assert response.status_code == 200
        assert response.headers.get("content-type") == "text/plain; charset=utf-8"

        content = response.text

        # Verify toon structure
        assert "trailrun_id:" in content
        assert "status:" in content
        assert "results[" in content  # Should have results array header

        # Verify column headers are present
        assert "{model,sample,epoch,turn,role,content}" in content

        print("\n✅ Toon format test passed!")
        print(f"   Content length: {len(content)} chars")
        print(f"   Preview:\n{content[:500]}...")

    def test_results_filter_by_model(self, completed_trailrun):
        """Test filtering results by model."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        # First get all results to find available models
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        all_results = response.json()["results"]
        models = set(r["model"] for r in all_results)
        assert len(models) >= 1, "Should have at least one model"

        # Pick the first model to filter by
        target_model = next(iter(models))

        # Filter by that model
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"model": target_model},
            timeout=10.0,
        )
        assert response.status_code == 200
        data = response.json()

        # Verify filter is reflected in response
        assert data["filters"]["model"] == target_model

        # Verify all results match the filter
        filtered_results = data["results"]
        for result in filtered_results:
            assert result["model"] == target_model, (
                f"Result model {result['model']} doesn't match filter {target_model}"
            )

        # Verify we got fewer results than unfiltered (if multiple models)
        if len(models) > 1:
            assert len(filtered_results) < len(all_results), (
                "Filtered results should be fewer than all results"
            )

        print("\n✅ Model filter test passed!")
        print(f"   Filtered to: {target_model}")
        print(f"   Results: {len(filtered_results)} (from {len(all_results)} total)")

    def test_results_filter_by_epoch(self, completed_trailrun):
        """Test filtering results by epoch."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        # First get all results to find available epochs
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        all_results = response.json()["results"]
        epochs = set(r["epoch"] for r in all_results)
        assert len(epochs) >= 1, "Should have at least one epoch"

        # Filter by epoch 1
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"epoch": 1},
            timeout=10.0,
        )
        assert response.status_code == 200
        data = response.json()

        # Verify filter is reflected in response
        assert data["filters"]["epoch"] == 1

        # Verify all results match the filter
        filtered_results = data["results"]
        for result in filtered_results:
            assert result["epoch"] == 1, f"Result epoch {result['epoch']} doesn't match filter 1"

        # Verify we got fewer results than unfiltered (if multiple epochs)
        if len(epochs) > 1:
            assert len(filtered_results) < len(all_results), (
                "Filtered results should be fewer than all results"
            )

        print("\n✅ Epoch filter test passed!")
        print("   Filtered to: epoch 1")
        print(f"   Results: {len(filtered_results)} (from {len(all_results)} total)")

    def test_results_filter_by_sample(self, completed_trailrun):
        """Test filtering results by sample ID."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        # First get all results to find available samples
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        all_results = response.json()["results"]
        samples = set(r["sample"] for r in all_results)
        assert len(samples) >= 1, "Should have at least one sample"

        # Pick the first sample to filter by
        target_sample = next(iter(samples))

        # Filter by that sample
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"sample": target_sample},
            timeout=10.0,
        )
        assert response.status_code == 200
        data = response.json()

        # Verify filter is reflected in response
        assert data["filters"]["sample"] == target_sample

        # Verify all results match the filter
        filtered_results = data["results"]
        for result in filtered_results:
            assert result["sample"] == target_sample, (
                f"Result sample {result['sample']} doesn't match filter {target_sample}"
            )

        print("\n✅ Sample filter test passed!")
        print(f"   Filtered to: sample {target_sample}")
        print(f"   Results: {len(filtered_results)} (from {len(all_results)} total)")

    def test_results_combined_filters(self, completed_trailrun):
        """Test combining multiple filters."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        # First get all results to find available options
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        all_results = response.json()["results"]
        models = set(r["model"] for r in all_results)
        target_model = next(iter(models))

        # Filter by model AND epoch 1
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"model": target_model, "epoch": 1},
            timeout=10.0,
        )
        assert response.status_code == 200
        data = response.json()

        # Verify filters are reflected
        assert data["filters"]["model"] == target_model
        assert data["filters"]["epoch"] == 1

        # Verify all results match both filters
        filtered_results = data["results"]
        for result in filtered_results:
            assert result["model"] == target_model
            assert result["epoch"] == 1

        print("\n✅ Combined filters test passed!")
        print(f"   Filtered to: {target_model}, epoch 1")
        print(f"   Results: {len(filtered_results)} (from {len(all_results)} total)")

    def test_results_toon_with_filters(self, completed_trailrun):
        """Test toon format with filters applied."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        # Get all results first to find a model
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        all_results = response.json()["results"]
        target_model = all_results[0]["model"]

        # Filter by model in toon format
        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            params={"format": "toon", "model": target_model},
            timeout=10.0,
        )
        assert response.status_code == 200
        content = response.text

        # Verify toon structure
        assert f"model: {target_model}" in content
        assert "results[" in content

        # Count lines with model name - all result lines should have this model
        result_lines = [
            line
            for line in content.split("\n")
            if line.strip().startswith(target_model.split("/")[-1]) or target_model in line
        ]

        print("\n✅ Toon with filters test passed!")
        print(f"   Filtered to: {target_model}")
        print(f"   Content:\n{content[:800]}...")

    def test_results_not_found(self, completed_trailrun):
        """Test 404 for non-existent trailrun."""
        base_url = completed_trailrun["base_url"]

        response = httpx.get(
            f"{base_url}/trailrun/tr_nonexistent123/results",
            timeout=10.0,
        )
        assert response.status_code == 404

        print("\n✅ 404 test passed!")

    def test_results_has_expected_message_pairs(self, completed_trailrun):
        """Verify results have user/assistant message pairs."""
        base_url = completed_trailrun["base_url"]
        trailrun_id = completed_trailrun["trailrun_id"]

        response = httpx.get(
            f"{base_url}/trailrun/{trailrun_id}/results",
            timeout=10.0,
        )
        data = response.json()
        results = data["results"]

        # Group results by (model, sample, epoch)
        groups = {}
        for r in results:
            key = (r["model"], r["sample"], r["epoch"])
            if key not in groups:
                groups[key] = []
            groups[key].append(r)

        # Each group should have at least user + assistant (2 turns)
        for key, messages in groups.items():
            roles = [m["role"] for m in messages]
            assert "user" in roles, f"Missing user message for {key}"
            assert "assistant" in roles, f"Missing assistant message for {key}"

            # Verify turn ordering within group
            turns = [m["turn"] for m in messages]
            assert turns == sorted(turns), f"Turns not sorted for {key}"

        print("\n✅ Message pairs test passed!")
        print(f"   Groups (model, sample, epoch): {len(groups)}")
        for key, messages in list(groups.items())[:3]:
            print(f"   {key}: {len(messages)} messages")
