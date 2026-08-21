# Quote Extraction & Verification System

## Problem

LLMs can hallucinate quotes when summarizing experiment results. We need to:

1. Have the LLM extract potential quotes from research content
2. Verify those quotes actually exist in the source material
3. Return the **exact text** from the source (not the LLM's version)
4. Include attribution metadata (model, sample ID, turn number)

## Solution: Two-Phase Fuzzy Matching

### Phase 1: Find Which Segment (RapidFuzz)

Use `rapidfuzz.process.extract()` to rank all segments by similarity to the quote. Returns the full segment object with metadata.

### Phase 2: Extract Exact Text (fuzzysearch)

Use `fuzzysearch.find_near_matches()` on the winning segment to get the verbatim source text.

## Why Two Phases?

| Library | Returns | Speed |
|---------|---------|-------|
| RapidFuzz | Score + original object | Very fast (C++) |
| fuzzysearch | Exact matched substring with position | Slower, precise |

RapidFuzz tells us **where** the quote is. fuzzysearch gives us the **exact text**.

## Implementation

### Data Structure

```python
from dataclasses import dataclass

@dataclass
class Segment:
    content: str
    model: str
    sample_id: str
    turn: int

@dataclass
class VerifiedQuote:
    verified_text: str  # Exact text from source
    model: str
    sample_id: str
    turn: int
    confidence: float
```

### Core Function

```python
from rapidfuzz import process, fuzz
from fuzzysearch import find_near_matches

def verify_quote(
    quote: str,
    segments: list[Segment],
    score_cutoff: int = 80,
    max_l_dist: int = 5,
) -> VerifiedQuote | None:
    """Verify an LLM-extracted quote against source material."""

    # Phase 1: Find best matching segment(s)
    result = process.extractOne(
        quote,
        segments,
        processor=lambda s: s.content,
        scorer=fuzz.partial_ratio,
        score_cutoff=score_cutoff,
    )

    if not result:
        return None

    segment, score, _ = result

    # Phase 2: Extract exact text from that segment
    matches = find_near_matches(quote, segment.content, max_l_dist=max_l_dist)

    if not matches:
        return None

    best = min(matches, key=lambda m: m.dist)

    return VerifiedQuote(
        verified_text=best.matched,
        model=segment.model,
        sample_id=segment.sample_id,
        turn=segment.turn,
        confidence=score / 100,
    )
```

### Multiple Matches (Ranked)

```python
def verify_quote_all_sources(
    quote: str,
    segments: list[Segment],
    limit: int = 3,
) -> list[VerifiedQuote]:
    """Find all segments containing the quote, ranked by match quality."""

    results = process.extract(
        quote,
        segments,
        processor=lambda s: s.content,
        scorer=fuzz.partial_ratio,
        score_cutoff=80,
        limit=limit,
    )

    verified = []
    for segment, score, _ in results:
        matches = find_near_matches(quote, segment.content, max_l_dist=5)
        if matches:
            best = min(matches, key=lambda m: m.dist)
            verified.append(VerifiedQuote(
                verified_text=best.matched,
                model=segment.model,
                sample_id=segment.sample_id,
                turn=segment.turn,
                confidence=score / 100,
            ))

    return verified
```

## Slack Integration

### Rendering Verified Quotes

Verified quotes are wrapped in backticks. The LLM is instructed to never use backticks directly, so backticks always indicate verified content.

```python
def format_quote_block(quote: VerifiedQuote) -> dict:
    """Format a verified quote as a Slack Block Kit element."""
    return {
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f"`{quote.verified_text}`",
        },
        "accessory": {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"_{quote.model}_ · Sample {quote.sample_id}, Turn {quote.turn}"
                }
            ]
        }
    }
```

### Alternative: Citation Block

```python
def format_quote_with_citation(quote: VerifiedQuote) -> list[dict]:
    """Quote followed by small citation context block."""
    return [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"> {quote.verified_text}"}
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": f"— *{quote.model}* · Sample {quote.sample_id}, Turn {quote.turn}"}
            ]
        }
    ]
```

## Dependencies

```toml
[project.dependencies]
rapidfuzz = "^3.0"
fuzzysearch = "^0.7"
```

## Tuning Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `score_cutoff` | 80 | Minimum RapidFuzz score to consider a match |
| `max_l_dist` | 5 | Maximum Levenshtein distance for fuzzysearch |

For longer quotes, consider scaling `max_l_dist` proportionally:

```python
max_l_dist = max(3, len(quote) // 10)  # ~10% tolerance
```

## Workflow

1. LLM generates summary with structured quote extraction:
   ```json
   {"quotes": ["quote one", "quote two", ...]}
   ```

2. Each quote is verified against source segments

3. Unverified quotes are dropped (hallucinations)

4. Verified quotes rendered with backticks + attribution

5. LLM is prompted to never use backticks → backticks = verified
