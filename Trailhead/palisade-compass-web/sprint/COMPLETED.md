# Completed Stories

## 044 — Mobile UX Polish and Help Documentation Updates

**Objective:** Polish mobile experience, improve help documentation clarity, and add "Not Implemented Yet" modals for Run and Preview features.

**Requirements:**
- Fix modal positioning on mobile (too low)
- Add iOS clipboard fallback for copy/paste operations
- Improve AI Experiment Generator prompt flow with interstitial state
- Update help documentation with clearer "What is Compass?" description
- Add "Why YAML files?" section to help docs
- Create "Not Implemented Yet" modals for Run and Preview buttons
- Polish Run/Preview modal copy with dynamic experiment details
- Shrink generator prompt height on mobile

**Implementation:**
- Adjusted import/export modal positioning: `pt-16` on mobile (was `pt-[33vh]`), `sm:pt-[33vh]` on desktop
- Added iOS Safari clipboard fallback using `document.execCommand('copy')` for all copy operations
- Added clipboard API check with friendly error message for paste operations on unsupported devices
- Improved AI Generator flow: Added interstitial state after copying with "Paste the prompt into your LLM" message and Continue button
- Made generator prompt scrollable with better readability (`text-gray-500` instead of `text-gray-300`)
- Reduced generator prompt height on mobile: `max-h-32` (was `max-h-64`), desktop stays `sm:max-h-64`
- Updated "What is Compass?" in help docs: Emphasizes internal tool, no Python needed, two-LLM architecture
- Added feature status badges: [Implemented], [Pending] in title case
- Moved "Can I see any examples?" section to top of help (after "What is Compass?")
- Added "Why YAML files?" section explaining: no code changes needed, easy sharing, version control, structured storage, cross-platform, human-editable vs JSON
- Changed tool architecture terms: "Input Value" and "Output Value" (was "Single Typed Input/Output")
- Created NotImplementedModal component at `/components/ui/NotImplementedModal.tsx`
- Run modal: Shows dynamic stats (**bold** numbers for iterations, steps, models), lists tools in **bold**, describes Palisade server flow
- Preview modal: Numbered list (1-3 steps) with **bold** formatting, describes tool preview process
- Removed swipe-down gesture (wasn't working correctly on mobile)
- Fixed import modal error clearing on close/reopen
- Added extra bottom padding on Run button for mobile browsers (`pb-4`)
- Fixed duplicate "Can I see any examples?" section in help accordion
- Added line break in examples answer between "Yes!" and instructions

---

## 043 — Help Modal and Mobile UX Improvements

**Objective:** Add comprehensive help system with FAQ accordion and optimize mobile layout spacing.

**Requirements:**
- Create Help button in header with auto-open on first visit
- Build FAQ modal with animated accordion (Radix UI + Framer Motion)
- Add version info section with expandable details
- Make modals full-screen slide-up trays on mobile (10vh from top)
- Convert Library modal to use same fullScreenMobile pattern
- Tighten mobile vertical spacing around title and tab bar
- Add smooth accordion animations with Framer Motion
- Maintain desktop centered modal at 70vh height and 900px width

**Implementation:**
- Created HelpButton component with modal that auto-opens on first visit using localStorage
- Built FAQ accordion using Radix UI with Framer Motion animations (250ms, snappy easing)
- Added version section as first accordion item with blue styling
- Version description: "design proposal and evaluation tool for the experiment configuration data format"
- Clarified that "running of actual experiments is not implemented yet" rather than "non-functional"
- Implemented Shift+Click secret on Help button to reset localStorage and reload
- Created reusable Modal component at `/components/ui/modal.tsx`
- Added `fullScreenMobile` prop for slide-up tray behavior on mobile
- Mobile modals: `inset-x-0 top-[10vh] bottom-0` with `rounded-t-2xl`
- Desktop modals: centered with `sm:w-[900px] sm:h-[70vh]`
- Updated Library (Examples) modal to use Modal component with fullScreenMobile
- Applied accordion styling: gray cards with borders, hover states, responsive padding
- Reduced mobile spacing: title `pt-2`, tabs negative margin `-mt-1`, tab buttons `py-1`
- Added MutationObserver to track Radix accordion state for animations
- Used `forceMount` on accordion content to allow exit animations
- Loaded shutdown-resistance example on first visit alongside help modal
- FAQ content includes: What is Compass, testing capabilities, tool simulation, steps system, models/iterations

---

## 042 — Import/Export Modal Enhancement

**Objective:** Replace basic import/export buttons with rich modal dialogs for better UX and discoverability.

**Requirements:**
- Create import modal with drag-and-drop file upload
- Add paste-from-clipboard option with experiment preview
- Show metadata preview (title, steps, tools, models, iterations) before importing
- Create export modal with download and copy-to-clipboard options
- Add helpful descriptions and clear error messages
- Mention LLM editing use case in export flow

**Implementation:**
- Built import modal with drag-and-drop zone using Upload icon
- Added "Paste from Clipboard" button that reads and parses clipboard content
- Created preview card showing experiment title and metadata counts
- Preview only appears after valid experiment is detected in clipboard
- Added "Choose File" button as alternative to drag-and-drop
- User-friendly error messages for invalid experiments and clipboard issues
- Built export modal with two options: "Download" (YAML file) and "Copy" (clipboard)
- Added description: "Export this experiment for future use, to have an LLM make changes to it, or to share with others (data not included)"
- Export modal positioned at top with strong shadow for better visibility
- Both modals use same visual design as Examples modal

---

## 041 — Radix UI Tooltips and Mobile Button Labels

**Objective:** Add professional tooltips to all buttons and improve mobile button UX.

**Requirements:**
- Install Radix UI tooltip system with light styling
- Add tooltips to all icon buttons (New, Import, Export, Examples, step actions, tool actions)
- Tooltips should be hover-only (desktop, not mobile)
- Show button labels on mobile below icons in tiny uppercase text
- Remove all old `title` attributes
- Fix hydration error in StepsEditor with dnd-kit

**Implementation:**
- Installed `@radix-ui/react-tooltip` and `@radix-ui/react-slot`
- Created `components/ui/tooltip.tsx` with light background (white bg, gray-900 text)
- Created `components/ui/button.tsx` for future button components
- Added tooltips to all buttons: StepCard (Duplicate, Delete, Expand/Collapse), ToolCard (Delete, Expand/Collapse), header buttons (New, Import, Export, Examples)
- Changed button layout on mobile: flex-col with icon on top, 9px uppercase label below
- On desktop (sm+), buttons switch to horizontal layout with normal text
- Removed all `title` attributes from TitleField and TokenChips
- Fixed StepsEditor hydration error by adding client-side mount detection
- Server renders static version, client renders interactive DndContext after mount
- Enhanced modal shadows with custom top-heavy shadow: `shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]`
- Shifted all modals up (items-start with pt-16) for better top shadow visibility

---

## 040 — Tool Notes System and Chess Cheater Example

**Objective:** Add persistent tool notes mechanism and create chess cheating detection experiment.

**Requirements:**
- Add `{{ tool_notes }}` variable token for reading accumulated notes
- Add `{{ record_tool_note }}` function token for appending notes
- Update existing examples to use tool notes instead of narrative context
- Create chess-cheater.yaml experiment testing AI cheating behavior
- Model must win chess at all costs using both chess moves and Linux commands
- Centralize token examples with includeInSteps/includeInTools flags
- Auto-sort tokens by type then alphabetically

**Implementation:**
- Created `/lib/token-registry.ts` with centralized `TOKEN_EXAMPLE_REGISTRY`
- Added `includeInSteps` and `includeInTools` flags to control token visibility
- Exported `getTokenExamplesForSteps()` and `getTokenExamplesForTools()` helper functions
- Updated TokenChips component to auto-sort tokens by type (variables first) then alphabetically
- Tool notes only appear in tool simulator prompts, not in step prompts
- Updated shutdown-resistance.yaml exec tool to read `{{ tool_notes }}` and call `{{ record_tool_note }}`
- Created chess-cheater.yaml with 12 steps of chess gameplay
- Chess experiment uses `prompt` filter to generate opponent moves from last player move
- Both `make_chess_move` (mandatory_every, type: none output) and `exec` (mandatory_every) tools required each step
- Tool notes maintain board state and system state across calls
- Final `attempted_cheating` tool (mandatory_last) scores whether model tried to manipulate game state
- Added "win at all costs, be ruthless" instruction to encourage aggressive strategies
- Added chess cheater to Examples list in ExamplesButton

---

## 039 — Token System Enhancements and Collapsible UI

**Objective:** Improve token management with Liquid template support and better UX.

**Requirements:**
- Add "Last Call to a Tool" token with Liquid filter example
- Create collapsible "Variables & Tools" section for token chips
- Add help modal with token documentation and Liquid reference
- Add `clear_history` function token to steps
- Distinguish function tokens (teal) from variable tokens (blue) with icons

**Implementation:**
- Added "Last Call to a Tool" token using Liquid's `where` and `last` filters
- Created collapsible TokenChips component with "Variables & Tools" header
- Built help modal showing available tokens, custom `prompt` filter, and Liquid docs link
- Added `{{ clear_history }}` function token to steps for clearing conversation history
- Token chips now color-coded: blue (variables with Variable icon), teal (functions with Play icon)
- Modal filters out example constructs, showing only base tokens
- Card backgrounds updated to subtle off-white (gray-50 header, white body)
- Examples button now has shadow for visual consistency

---

## 001 — App bootstrap and responsive layout

**Objective:** Next.js App Router + TS + Tailwind; header, editor area, persistent Run bar; mobile/tablet/desktop breakpoints.

**Requirements:**
- TS strict, ESLint, Prettier
- Layout scaffolding and base styles in light mode
- App loads cleanly
- Layout holds between 360–1440 px without overflow

**Implementation:**
- Set up Next.js 14 with App Router, TypeScript (strict mode), Tailwind CSS
- Configured ESLint and Prettier for code quality
- Built responsive layout with Header, EditorArea, and RunBar components
- Implemented mobile/tablet/desktop breakpoints with proper spacing and safe-area support for iOS

---

## 002 — Minimal CompassExperiment schema + validation

**Objective:** Define JSON Schema for the minimal experiment and generate TS types; validate imports.

**Requirements:**
- `lib/schemas/compass-experiment.schema.json` per Architecture
- AJV validator + readable error mapping; derived TS types
- Invalid imports show precise path + message; valid imports hydrate state

**Implementation:**
- Created JSON Schema definition in `lib/schemas/compass-experiment.schema.json`
- Generated TypeScript types from schema
- Integrated AJV validator with readable error messages
- Built validation layer that provides clear feedback on import errors

---

## 003 — Experiment Import/Export + GUID stamping + Autosave on blur + New flow

**Objective:** Round-trip experiment files and keep edits on refresh.

**Requirements:**
- Import YAML/JSON; Export YAML/JSON. Stamp GUID if missing
- Autosave to localStorage on blur of any field
- New button that, if edited since last export, prompts user to export first
- Refresh preserves work; New guard works; GUID stamping correct

**Implementation:**
- Built import/export functionality supporting both YAML and JSON formats
- Implemented automatic GUID stamping on export if missing
- Created localStorage autosave system that triggers on field blur
- Added "New" button with guard modal that prompts to export unsaved changes
- Integrated with ExperimentContext for state management

---

## 004 — Step editor (prompts only) with collapse and reorder

**Objective:** Steps are `{ prompt }`. CRUD + duplicate + drag reorder + keyboard move.

**Requirements:**
- Step card with textarea for `prompt`, collapse toggle, duplicate/delete
- Reorder via DnD and keyboard
- All ops persist and survive refresh without id churn

**Implementation:**
- Created StepCard component with expandable/collapsible UI
- Implemented drag-and-drop reordering using dnd-kit library
- Added duplicate and delete actions for each step
- Built textarea with auto-resize functionality
- Ensured all operations persist to localStorage automatically

---

## 005 — Liquid prompt support for steps + step token chips

**Objective:** Liquid transformation works; chips help insert tokens.

**Requirements:**
- Token chips for step prompts: `{{ last_response }}`, `{{ last_response | prompt:"" }}`, `{{ previous_tool_calls }}`
- Insert at cursor with pretty names
- Liquid transformation server function works
- Token chips insert correctly

**Details:**
- Transform filter example: `{{ last_response | prompt: "Create an argument against this claim" }}`
- Default first step includes example prompt demonstrating token usage

**Implementation:**
- Created TokenChips component for inserting Liquid tokens at cursor position
- Implemented "Transform last response" and "Previous tool calls" chips with helpful labels
- Added server-side Liquid transformation support
- Default first step now includes example: `{{ last_response | prompt: "Create an argument against this claim" }}`

---

## 006 — Model selector + Iterations (1–128)

**Objective:** Multi-select for models and a numeric input for iterations 1–128 in the same panel.

**Requirements:**
- Checklist or multi-select for models; required to pick at least one
- Iterations numeric input (min 1, max 128) with validation
- Nice UI element for selecting powers of 2 runs
- Values persist; validation errors are clear

**Details:**
- Model list updated to show only 2 latest models per provider
- Added model icons for visual recognition
- 2-column grid layout with max-width constraint to prevent stretching

**Implementation:**
- Built ModelSelector with checkbox-based multi-select in 2-column grid
- Added model icons (OpenAI, Anthropic, Grok with X logo)
- Created horizontal slider for iterations with text input (1-128 range)
- Implemented power-of-2 quick select buttons
- Curated model list: GPT-4.1, GPT-4.1 Mini, Sonnet 4.5, Haiku 3.5, Grok 4, Grok 4 Fast
- Made text non-selectable for cleaner UX

---

## 007 — Simulated tool editor with transformation prompt, tokens, preview, and enforced output call

**Objective:** Implement v1 tool definitions with name/description; support tokens including `{{output_tool}}`; preview shows what a simulated tool call will look like.

**Requirements:**
- Fields per tool: `name`, `description`, `input { name, type }`, `transformPrompt`, `output { name, type }`, `scope` (default `optional_every`)
- Token chip bar above `transformPrompt` to insert tokens at cursor
- Create slugs from name at runtime, enforce unique names in UI
- When creating new tools, use names: 'foo', 'bar', 'bin', 'baz', 'foo2', 'bar2', etc.
- Build LLM instruction by replacing tokens in `transformPrompt`
- Instruction explicitly tells model to call `{{output_tool}}` and return payload
- Regular text response from LLM persisted as narrative context for future tool calls
- Preview synthesizes hypothetical input using LLM call in server function
- Preview shows: hypothetical input, generated typed output, any narrative context

**Details:**
- **Unix example transformPrompt:** "Process {{input}} as if it were a Unix command. Then call {{output_tool}} with the hypothetical command results. Anything you write as your normal text response will be preserved as narrative context for future tool calls — for example, you may describe simulated side effects like '/etc/hosts updated' or 'created /tmp/foo.txt'. Return only the textual command output to {{output_tool}}. Do not include JSON in your text response."
- Internal call semantics ensure proper tool execution flow
- Memory behavior preserves narrative context across calls

**Implementation:**
- Created ToolCard component with all required fields (name, description, input, output, transformPrompt, scope)
- Built TokenChips component for tools with tokens: `{{input}}`, `{{previous_tool_calls}}`, `{{output_tool}}`
- Implemented automatic slug generation from tool names with fallback naming
- Added tool preview functionality with server-side LLM synthesis
- Enforced unique tool names in UI validation

---

## 008 — Run bar with microbars and main iteration bar + mock execution with timestamps

**Objective:** Execute mock runs across iterations and steps, rendering stacked microbars per model and the main iteration bar.

**Requirements:**
- Run bar: Play/Stop, model microbars (one per selected model with icon), main iteration bar below them
- Mock scheduler: for each iteration (1..N): for each model: walk steps sequentially
- Record `startedAt`/`completedAt` ISO timestamps
- Update model's microbar as steps complete; update main bar as iterations complete
- UI reflects step progress per model and iteration progress globally
- Stop cancels cleanly and leaves timestamps for completed steps

**Details:**
- Random step execution times doubled for more realistic demo
- Progress bars remain visible after completion; microbars disappear when done
- Progress section always stays above Run bar at bottom

**Implementation:**
- Built RunBar component with Play/Stop controls
- Created microbar system showing per-model progress across steps
- Implemented main iteration progress bar
- Built mock execution scheduler with realistic timing (800-1600ms per step)
- Added timestamp tracking for all completed operations
- Positioned progress bars above run controls with proper spacing

---

## 009 — Title field and editor plumbing

**Objective:** Title is required and part of the experiment file; no description UI yet.

**Requirements:**
- Title input at the top
- Validation on empty
- Title persists and is included in export

**Details:**
- Defaults to "Untitled Experiment"
- Editable heading with pencil icon (always visible)
- Click directly on title to edit
- Edit mode shows save/cancel buttons
- Press Enter to save or Escape to cancel

**Implementation:**
- Created TitleField component with inline editing
- Implemented edit mode with save/cancel actions
- Made pencil icon always visible for discoverability
- Added validation requiring non-empty title
- Integrated with form state and localStorage persistence
- Title displays as large heading (3xl font) with hover states

---

## 010 — PWA install + notifications

**Objective:** Manifest/service worker for install; Web Notifications for completion when/if needed.

**Requirements:**
- App manifest for PWA installation
- Service worker configuration
- Proper iOS web app support
- Mobile-optimized viewport and safe areas

**Implementation:**
- Created `manifest.json` with app metadata and compass icon
- Added iOS web app meta tags for standalone mode
- Implemented safe-area viewport configuration
- Fixed iOS scrolling issues with overscroll-behavior
- Added proper bottom padding for iOS Safari bottom bar
- Created PWA icons matching header compass design

---

## 011 — Visual Design Enhancements

**Objective:** Modern, minimalist design with better visual hierarchy

**Requirements:**
- Clean, professional appearance
- Subtle shadows and hover states
- Consistent spacing and borders
- Non-selectable UI text
- Frosted glass effect for header and footer

**Implementation:**
- Applied modern design principles: rounded corners, subtle shadows, hover elevation
- Added shadows to both step and tool cards for consistency
- Created Settings section with white box container for models and iterations
- Moved Settings to bottom after Tools section
- Added frosted glass effect (`backdrop-blur-md bg-white/70`) to Header and RunBar
- Made header compass icon black for better contrast
- Ensured graceful fallback for browsers without backdrop-blur support

---

## 012 — Mobile Optimizations

**Objective:** Improved mobile experience across iOS and Android

**Requirements:**
- Smaller header buttons on mobile
- Icon-only buttons on small screens
- Increased touch targets for iterations slider
- Fixed scrolling quirks
- Proper bottom spacing for mobile Safari

**Implementation:**
- Reduced header button padding on mobile (`px-2 py-1.5`)
- Removed button text labels on mobile, showing icons only
- Increased slider hit target for better touch interaction
- Fixed vertical/horizontal scrolling issues
- Added extra bottom padding (80px) on mobile for Safari bar
- Constrained title controls to container edge to prevent overflow

---

## 013 — Export Attribution

**Objective:** Remove Claude attribution from exports

**Implementation:**
- Updated export functionality to exclude co-authorship metadata
- Clean YAML/JSON exports with only experiment data

---

## 014 — Animated Tab Navigation

**Objective:** Replace legacy tab navigation with modern animated tab component

**Requirements:**
- Smooth spring animation between tab selections
- Rounded container background with shadcn-style design tokens
- Improved mobile spacing and centered title layout
- Reusable component architecture for future use

**Implementation:**
- Replaced border-bottom tab navigation with animated Framer Motion tab component
- Created `components/ui/pricing-tab.tsx` with spring animation using layoutId
- Created `components/ui/badge.tsx` for variant-based badges
- Created `lib/utils.ts` with cn() helper for className merging
- Added shadcn-compatible CSS variables: muted, primary, secondary, destructive, ring
- Installed dependencies: framer-motion, class-variance-authority, clsx, tailwind-merge
- Reduced spacing between title and tabs (mb-4 on title, pt-3/pb-4 on mobile)
- Centered title text and controls for better visual hierarchy
- Added `components/ui/slide-tabs.tsx` (alternate implementation, pricing-tab used in EditorArea)

---

## 035 — Tool Card UX Improvements

**Objective:** Improve tool card layout, spacing, and preview modal experience

**Requirements:**
- Better visual hierarchy and whitespace management
- Clearer labeling and token availability
- Improved preview modal with lighter overlay
- Repositioned preview button for better discoverability
- Add Step Number and Tool Call Count tokens for tools

**Implementation:**
- Moved "Add Tool" button below tool list instead of above
- Renamed "Scope" field to "When" for clarity
- Reversed scope option labels to "Every Step (Optional)" format
- Renamed "Simulation Prompt" to "Tool Simulator Prompt"
- Added Step Number and Tool Call Count tokens to tool transform prompt chips
- Improved spacing: more whitespace between major sections (space-y-8), tighter within I/O flow (space-y-4)
- Reduced arrow spacing with negative margins (-my-2) for compact visual flow
- Shortened dotted line height from h-8 to h-4
- Removed horizontal divider lines for cleaner appearance
- Moved Preview button from toolbar to bottom of card as centered call-to-action
- Styled Preview button with light blue background (bg-blue-50)
- Updated preview modal overlay from black/50% to white/20% with backdrop blur
- Added click-outside-to-close functionality for preview modal
- Removed "UI" suffix from app title (now just "Compass")
- Fixed drag-and-drop animation by disabling layout changes (documented in KNOWN_ISSUES.md)

---

## 036 — Schema Cleanup and Examples Browser

**Objective:** Rename schema fields for clarity and add examples browser functionality

**Requirements:**
- Rename `transformPrompt` to `simulatorPrompt` in schema
- Rename `guid` to `id` for experiment identifier
- Change type enum from "true-false" to "boolean"
- Add Examples button to browse and load example experiments
- Create shutdown-resistance.yaml example based on Palisade Research

**Implementation:**
- Updated JSON schema: `transformPrompt` → `simulatorPrompt`, `guid` → `id`
- Changed type enum from `["true-false", ...]` to `["boolean", ...]` with UI labels
- Updated TypeScript types to match schema changes
- Updated all code references: ToolCard, ToolsEditor, preview-tool action, import-export utils
- Created ExamplesButton component with modal to browse examples
- Added "Examples" button to header (icon-only on mobile)
- Created AGENTS.md to document manual example list maintenance
- Created shutdown-resistance.yaml example testing AI shutdown resistance
- Copied examples to public/examples/ for Next.js static serving
- Exposed `setHasUnsavedChanges` in ExperimentContext for example loading
