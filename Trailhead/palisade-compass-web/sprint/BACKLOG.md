# Backlog Stories

## 037 — Liquid Syntax Highlighting in Prompts

**Objective:** Add syntax highlighting for Liquid tokens in prompt textareas.

**Requirements:**
- Highlight Liquid tokens `{{ }}` with distinct styling
- Color-code different token types:
  - Standard tokens (input, previous_tool_calls, etc.) in one color
  - Action tokens (update_score, score) in a different color
  - Filters and pipes with appropriate styling
- Apply to both step prompts and tool simulator prompts
- Syntax highlighting should not interfere with editing
- Use CodeMirror, Monaco, or lightweight highlighting solution

**Details:**
- New action tokens: `{{update_score}}`, `{{score}}`
- Existing tokens: `{{input}}`, `{{previous_tool_calls}}`, `{{output_tool}}`, `{{step_number}}`, `{{tool_call_count}}`, `{{last_response}}`
- Filters: `{{last_response | prompt: "..."}}`

---

## 014 — Dev console cheat code for higher concurrency

**Objective:** Allow developers to override mock concurrency limits for testing.

**Requirements:**
- Set `window.__COMPASS_DEV_MAX__ = 8` to lift mock concurrency ceiling
- Show badge indicating "DEV MAX ACTIVE" when override is enabled
- Useful for testing UI with high concurrency scenarios

---

## 015 — Stacked cascade results viewer

**Objective:** Visualize results in a turn-flipping stacked view.

**Requirements:**
- Stacked view showing results with card-flip interaction
- Cap visible results at ~4-6 cards
- Implement virtualization for result sets beyond the visible cap
- Smooth animations for card transitions

---

## 016 — Optional scoring + CSV/Sheets export

**Objective:** Allow users to score results and export data.

**Requirements:**
- End-of-run optional scoring interface
- CSV export functionality for results
- Optional Google Sheets export integration
- Preserve scores with experiment results

---

## 017 — Local run history

**Objective:** Maintain history of past experiment runs.

**Requirements:**
- Keep local list of recent mock runs with metadata
- Allow viewing past run details
- Support re-opening/re-running past experiments
- Store run history in localStorage or IndexedDB

---

## 018 — Advanced model parameters

**Objective:** Expose model configuration options.

**Requirements:**
- Hidden/collapsible panel for advanced parameters
- Temperature control
- Other provider-specific parameters
- Per-model parameter overrides

---

## 019 — Results panel + JSON export

**Objective:** Display and export comprehensive results data.

**Requirements:**
- In-app results viewing panel
- Show responses, timestamps, and metadata
- Export `CompassResults` JSON blob
- Support filtering and searching results

---

## 020 — Server randomizer (generate experiment from 5 curated examples)

**Objective:** AI-assisted experiment generation from examples.

**Requirements:**
- API route or server action for experiment generation
- Accept 5 human-provided example experiments as input
- Take short prompt describing desired experiment
- Return new experiment JSON based on examples
- Not part of the core file schema

---

## 021 — Scrolling and Layout Fixes

**Objective:** Fix remaining scrolling and layout edge cases.

**Requirements:**
- Fix vertical/horizontal scrolling failures after canceling title edit
- Prevent controls from overflowing container edge
- Eliminate gray background at outer edges
- Ensure consistent scrolling behavior across devices

---

## 022 — Title Bar Mobile Refinements

**Objective:** Better mobile title experience.

**Requirements:**
- Smaller title font size on mobile
- Ensure controls stay within container bounds
- Better touch targets for edit/save/cancel actions

---

## 023 — Drag and Drop Mobile Improvements

**Objective:** Improve step reordering on mobile.

**Requirements:**
- Better drag handles for touch interfaces
- Visual feedback during drag operations
- Prevent accidental drags when scrolling
