# Compass UI MLP — Architecture & Stories

This file has two sections:

1) **Architecture** — shared assumptions and contracts to guide implementation.  
2) **Stories** — standalone build items grouped by **\[Current\]**, **\[Backlog\]**, **\[Icebox\]**.

---

## Architecture

- **Purpose and scope**  
    
  - Editor-first app to compose multi-prompt sequences where each step is just a `prompt: string`. No system vs user channels.  
  - Loops are out of scope.  
  - Keep the interface light: add, remove, reorder, duplicate steps.


- **Templating**  
    
  - Use **Liquid**. Variables like `{{ last_response }}` and `{{ previous_tool_calls }}` are available.  
  - Transform uses a **Liquid filter** named `prompt`. Example:  
    - `{{ last_response | prompt: "Suggest what was wrong with the approach." }}`  
  - `prompt:` is a v1 pass-through; we keep the shape for future use.


- **Models and iterations**  
    
  - Model selection is a simple **multi-select** or checklist (no “chips”). Values like `openai:gpt-4.1`, `anthropic:sonnet-4.5`.  
  - **Iterations** are a first-class input adjacent to model selection: integer **1–128**.  
  - **Progress semantics**:  
    - **Microbars**: one thin progress bar per selected model showing progress **across steps** for the current iteration; icon for the model at the left.  
    - **Main bar**: shows progress **across iterations** (e.g., Iteration 3/20).


- **Tools with transformation prompts (v1-simple)**  
    
  - Each tool has:  
    - **id**: string  
    - **name**: string  
    - **description**: string  
    - **input**: `{ name: string, type: "true-false"|"integer"|"number"|"string"|"none" }`  
    - **transformPrompt**: string that sits **between input and output** and supports tokens  
    - **output**: `{ name: string, type: same union }`  
    - **scope**: `"optional_every" | "mandatory_every" | "mandatory_last"` (default `optional_every`)  
  - **Tokens** available inside `transformPrompt`:  
    - `{{input}}` — the current input value  
    - `{{previous_tool_calls}}` — array of prior tool-call I/O (empty if none)  
    - `{{output_tool}}` — the identifier of the output tool used by the transformation LLM to return results  
  - **Memory behavior**:  
    - Whatever the LLM writes as its **regular text response** (not the structured tool output) is preserved as **narrative context** and becomes visible to future tool calls via `{{previous_tool_calls}}` (e.g., simulated side effects like “/etc/hosts updated”).


- **Internal call semantics for tools**  
    
  - When executing a tool, we **construct the LLM prompt** by replacing the tokens in `transformPrompt` with concrete values.  
  - We **force a call** to `{{output_tool}}` by instructing the LLM explicitly to return the tool’s output payload. The free-form text the LLM also produces is stored as narrative context.


- **Artifacts and files**  
    
  - **CompassExperiment** is the primary artifact for v1. Minimal shape:

```ts
type CompassExperiment = {
  schemaVersion: "1.0.0";
  guid: string;               // stamped on export if missing
  title: string;              // required
  models: string[];           // e.g. ["openai:gpt-4.1","anthropic:sonnet-4.5"]
  iterations: number;         // 1–128
  steps: { prompt: string }[];// ordered array, no ids/names/channels
  tools?: {
    id: string;
    name: string;
    description: string;
    input: { name: string; type: "true-false"|"integer"|"number"|"string"|"none" };
    transformPrompt: string; // uses tokens above
    output: { name: string; type: "true-false"|"integer"|"number"|"string"|"none" };
    scope?: "optional_every"|"mandatory_every"|"mandatory_last";
  }[];
  // description?: string  (allowed in schema; no UI for now)
}
```


- **Creation and persistence**  
    
  - Use **React Hook Form** (or better if you prefer another one). **Autosave on blur** for all fields.  
  - Persist the active **CompassExperiment** in **localStorage** so steps do not disappear on refresh.  
  - A **New** button creates a fresh experiment. If there are edits since last export, **prompt to export** as YAML first.  
  - Export is the **Experiment YAML** (not props or results).


- **Execution model v1**  
    
  - Mock execution across `iterations` and `steps` for each selected `model`.  
  - Record timestamps (`startedAt`, `completedAt`) for transparency.  
  - Show **microbars per model** and a **main iteration bar**.


- **Layout and responsiveness**  
    
  - Prioritize desktop; define breakpoints for **mobile / tablet / desktop**.  
  - Editor is a scrollable list of collapsible step cards.  
  - Persistent **Run bar** at all breakpoints.

---

## Stories

### \[Current\]

**C01 — App bootstrap and responsive layout**

- Objective: Next.js App Router \+ TS \+ Tailwind; header, editor area, persistent Run bar; mobile/tablet/desktop breakpoints.  
- Deliverables:  
  - TS strict, ESLint, Prettier.  
  - Layout scaffolding and base styles in light mode.  
- Acceptance:  
  - App loads cleanly. Layout holds between 360–1440 px without overflow.

**C02 — Minimal CompassExperiment schema \+ validation**

- Objective: Define JSON Schema for the minimal experiment and generate TS types; validate imports.  
- Deliverables:  
  - `lib/schemas/compass-experiment.schema.json` per Architecture.  
  - AJV validator \+ readable error mapping; derived TS types.  
- Acceptance:  
  - Invalid imports show precise path \+ message; valid imports hydrate state.

**C03 — Experiment Import/Export \+ GUID stamping \+ Autosave on blur \+ New flow**

- Objective: Round-trip experiment files and keep edits on refresh.  
- Deliverables:  
  - Import YAML/JSON; Export YAML/JSON. Stamp GUID if missing.  
  - Autosave to localStorage **on blur** of any field.  
  - **New** button that, if edited since last export, prompts user to export first.  
- Acceptance:  
  - Refresh preserves work; New guard works; GUID stamping correct.

**C04 — Step editor (prompts only) with collapse and reorder**

- Objective: Steps are `{ prompt }`. CRUD \+ duplicate \+ drag reorder \+ keyboard move.  
- Deliverables:  
  - Step card with textarea for `prompt`, collapse toggle, duplicate/delete.  
  - Reorder via DnD and keyboard.  
- Acceptance:  
  - All ops persist and survive refresh without id churn.

**C05 — Liquid prompt support for steps \+ step token chips**

- Objective: Liquid transformation works; chips help insert tokens.  
- Deliverables:  
  - **Token chips** for step prompts: `{{ last_response}} {{ last_response | prompt:”” }}`, `{{ previous_tool_calls }}` (insert at cursor). (give them pretty names when as chips)  
- Acceptance:  
  - Liquid transformation server function works  
  - Token chips insert correctly

**C06 — Model selector \+ Iterations (1–128)**

- Objective: Multi-select for models and a numeric input for iterations 1–128 in the same panel.  
- Deliverables:  
  - Checklist or multi-select for models; required to pick at least one.  
  - Iterations numeric input (min 1, max 128\) with validation and nice UI element for selecting powers of 2 runs.  
- Acceptance:  
  - Values persist; validation errors are clear.

**C07 — Simulated tool editor with transformation prompt, tokens, preview, and enforced output call**

- Objective: Implement v1 tool definitions with name/description; support tokens including **`{{output_tool}}`**; preview shows what a simulated tool call will look like.  
- Fields per tool:  
  - `name`, `description`  
  - `input` `{ name, type }`  
  - `transformPrompt` (supports tokens: `{{input}}`, `{{previous_tool_calls}}`, `{{output_tool}}`)  
  - `output` `{ name, type }`  
  - `scope` default `optional_every`  
- **Token chip bar** above `transformPrompt` to insert tokens at cursor (wraps as needed).  
- Create slugs from name at runtime, enforce unique names in UI, when creating a new one, call it ‘foo’ ‘bar’ ‘bin’ ‘baz’ ‘foo2’ ‘bar2’ etc  
- **Internal call semantics**:  
  - Build the **LLM instruction** by replacing tokens in `transformPrompt`.  
  - The instruction explicitly tells the model to **call `{{output_tool}}`** and return a payload for **`{{output_name}}`**.  
  - Any **regular text response** from the LLM is persisted as **narrative context** for future tool calls (e.g., simulated file changes).  
- **Unix example to include verbatim in this story’s fixtures/docs**:  
  TransformPrompt: Process {{input}} as if it were a Unix command. Then call {{output\_tool}} with the hypothetical command results. Anything you write as your normal text response will be preserved as narrative context for future tool calls — for example, you may describe simulated side effects like “/etc/hosts updated” or “created /tmp/foo.txt”. Return only the textual command output to {{output\_tool}}. Do not include JSON in your text response.  
- **Preview behavior**:  
- Synthesize a hypothetical input from the input type/name using LLM call in server function.  
- Render `transformPrompt` with tokens filled.  
- Show:  
  - **Hypothetical input**  
  - **Generated typed output**  
  - **Any narrative context**  
- Acceptance:  
- Tools persist; scopes persist with default `optional_every`.  
- Preview clearly displays forced call target and output;

**C08 — Run bar with microbars and main iteration bar \+ mock execution with timestamps**

- Objective: Execute mock runs across iterations and steps, rendering stacked **microbars per model** and the **main iteration bar**.  
- Deliverables:  
- Run bar: Play/Stop, model microbars (one per selected model with icon), main iteration bar below them.  
- Mock scheduler:  
  - For each iteration (1..N): for each model: walk steps sequentially.  
  - Record `startedAt`/`completedAt` ISO timestamps.  
  - Update the model’s microbar as steps complete; update main bar as iterations complete.  
- Acceptance:  
- UI reflects step progress per model and iteration progress globally.  
- Stop cancels cleanly and leaves timestamps for completed steps.

**C09 — Title field and editor plumbing**

- Objective: Title is required and part of the experiment file; no description UI yet.  
- Deliverables:  
- Title input at the top; validation on empty.  
- Acceptance:  
- Title persists and is included in export.

---

### \[Backlog\]

**B01 — Dev console cheat code for higher concurrency**

- `window.__COMPASS_DEV_MAX__ = 8` lifts mock concurrency ceiling; badge shows DEV MAX ACTIVE.

**B02 — Stacked cascade results viewer**

- Turn-flipping stacked view with cap of \~4–6 visible; virtualization beyond that.

**B03 — Optional scoring \+ CSV/Sheets export**

- End-of-run optional scoring tool; CSV export; optional Sheets export.

**B04 — Local run history**

- Keep a local list of recent mock runs; allow viewing and re-opening.

**B05 — Advanced model parameters**

- Hidden panel for temperature and other params.

**B06 — Results panel \+ JSON export**

- In-app results view and export of a `CompassResults` JSON blob.

**B07 / D7 — Server randomizer (generate experiment from 5 curated examples)**

- API route or server action that, given 5 human-provided example experiments and a short prompt, returns a **new experiment JSON**. Not part of the file schema.

---

### \[Icebox\]

**I01 — Slack updates**

- Single message; update in place with monospace bar; store `{channel, ts}`.

**I03 — PWA install \+ notifications**

- Manifest/service worker for install; Web Notifications for completion when/if needed.

**I04 — Remix and ancestry**

- Clone YAML with `parentGuid`; future registry.