---
name: find-allies
description: Find cross-party allies for a US legislator on a policy topic. Uses the Aisle Crosser research platform to run AI agents that search voting records, speeches, social media, and personal connections.
disable-model-invocation: true
allowed-tools: Bash(curl:*)
---

# Find Cross-Party Allies

Find potential bipartisan allies for a US legislator using the Aisle Crosser platform.

## Usage

`/find-allies <legislator name> <policy topic>`

Example: `/find-allies Elizabeth Warren AI safety regulation`

## How it works

1. Search for the legislator by name
2. Launch a research run (4 parallel AI agents analyze voting, speeches, constituencies, interests)
3. Poll until complete (~1-2 minutes)
4. Display results: candidates ranked by alignment score with evidence and approach strategies

## Steps

### Step 1: Find the legislator

```bash
RESULTS=$(curl -s "https://aislecrosser.example.railway.app/api/legislators?q=$1&chamber=senate" 2>/dev/null)
```

If not found in senate, try house:
```bash
RESULTS=$(curl -s "https://aislecrosser.example.railway.app/api/legislators?q=$1&chamber=house" 2>/dev/null)
```

Parse the response to get the legislator ID. Show the user who was found and confirm.

### Step 2: Launch research

```bash
RESEARCH=$(curl -s -X POST "https://aislecrosser.example.railway.app/api/research" \
  -H "Content-Type: application/json" \
  -d "{\"legislatorId\":\"$LEGISLATOR_ID\",\"title\":\"$TOPIC\"}")
```

Extract `researchId` from the response.

### Step 3: Poll for results

Poll every 10 seconds until status is "completed" or "failed":

```bash
curl -s "https://aislecrosser.example.railway.app/api/research/$RESEARCH_ID"
```

While polling, report progress to the user:
- `agents_running` → "AI agents are researching... X candidates found so far"
- `finding_connections` → "Finding personal connections for top candidates..."
- `synthesizing` → "Generating approach strategies..."

### Step 4: Display results

When complete, format the candidates nicely:

For each candidate (sorted by score):
- **Name** (Party-State) — Score: XX%
- **Evidence**: What the research agents found
- **Connections**: Personal connections (hobbies, alma mater, family, etc.)
- **Approach Strategy**: How to approach them (if synthesized)
- **Talking Points**: Specific conversation starters

### Step 5: On-demand synthesis

If a candidate doesn't have an approach strategy, generate one:

```bash
curl -s -X POST "https://aislecrosser.example.railway.app/api/research/$RESEARCH_ID/synthesize" \
  -H "Content-Type: application/json" \
  -d "{\"candidateName\":\"$CANDIDATE_NAME\"}"
```

## Notes

- The API base URL is `https://aislecrosser.example.railway.app`
- Research takes 1-2 minutes on medium effort, longer on high
- The UI is available at https://aislecrosser.org for visual exploration
- Candidates are from the opposite party to the requesting legislator
