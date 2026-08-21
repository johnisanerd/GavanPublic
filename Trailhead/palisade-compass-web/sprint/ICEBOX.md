# Icebox Stories

Low-priority features and ideas for future consideration.

---

## Improve "Unsaved Changes" Dialog

**Objective:** Enhance the New Experiment dialog UX when user has unsaved changes.

**Details:**
- Current dialog shows three buttons: Download, Discard, Cancel
- Could be improved with better messaging and button hierarchy
- Consider showing a preview of what will be lost
- Maybe auto-save to localStorage as a backup before creating new
- Better copy explaining the difference between Download (exports YAML) and Discard (loses work)

---

## 024 — Slack updates

**Objective:** Send run progress updates to Slack.

**Requirements:**
- Post single message to Slack channel
- Update message in place with monospace progress bar
- Store `{channel, ts}` for message updates
- Configurable Slack webhook or bot integration

---

## 025 — Remix and ancestry

**Objective:** Support experiment forking and lineage tracking.

**Requirements:**
- Clone YAML with `parentGuid` field
- Track experiment ancestry
- Future experiment registry/sharing
- Version history visualization

---

## 026 — Dark Mode Support

**Objective:** Add optional dark theme.

**Requirements:**
- Toggle between light and dark modes
- Respect system preference
- Persist user choice
- Ensure consistent styling across all components

**Note:** Currently deferred in favor of polished light mode design.

---

## 027 — Collaboration Features

**Objective:** Enable team collaboration on experiments.

**Requirements:**
- Share experiments via URL
- Real-time collaboration (optional)
- Comments and annotations
- Team workspace/folders

---

## 028 — Advanced Visualization

**Objective:** Better ways to explore results.

**Requirements:**
- Graph/chart views for metrics
- Diff views between model responses
- Timeline view of execution
- Heatmaps for performance comparisons

---

## 029 — Template Library

**Objective:** Pre-built experiment templates.

**Requirements:**
- Curated template collection
- Template categories (evaluation, generation, analysis, etc.)
- Template search and preview
- User-contributed templates

---

## 030 — API Integration

**Objective:** Run experiments via API or CLI.

**Requirements:**
- REST API for experiment CRUD
- CLI tool for running experiments
- Webhook notifications for completion
- API authentication and rate limiting

---

## 031 — Single Long-Scroll View with Tab-Driven Navigation

**Objective:** Replace tab panels with smooth scrolling to sections.

**Requirements:**
- Convert editor to single vertical scrollable page
- Clicking a tab smoothly scrolls to the corresponding section (Steps/Tools/Settings)
- Use IntersectionObserver to sync active tab with scroll position
- Maintain mobile-friendly scroll behavior with proper touch handling

**Benefits:**
- Easier mobile navigation (no panel switching)
- Simpler layout state management
- Natural sequential flow through experiment configuration
- Better for users who want to see multiple sections at once

---

## 032 — Unified Button Design System

**Objective:** Replace disparate button styles with a consistent design system.

**Requirements:**
- Create `components/ui/button.tsx` with variant system
- Support variants: primary, secondary, ghost, destructive, outline
- Implement size variants: sm, md, lg
- Add proper focus/ring states using design tokens
- Include icon support and loading states
- Migrate all existing buttons to use new component

**Benefits:**
- Consistent visual language across the app
- Better accessibility with standardized focus states
- Easier maintenance and theming
- Follows shadcn/ui patterns for familiarity

---

## 033 — Monochrome Color Theme Option

**Objective:** Provide a monochrome color palette option alongside existing theme.

**Requirements:**
- Add theme toggle or selector (light/dark/monochrome)
- Define monochrome palette using grayscale + single accent color
- Update all color tokens to support monochrome variant
- Apply to badges, rings, backgrounds, borders, and text
- Persist theme preference in localStorage

**Benefits:**
- Professional, minimalist aesthetic option
- Reduced visual noise for focused work
- Better for users with color sensitivity
- Distinctive brand option

---

## 034 — Ghost-Style Add Controls for Steps and Tools

**Objective:** Replace prominent "Add" buttons with subtle inline ghost controls.

**Requirements:**
- Replace "Add Step" and "Add Tool" buttons with subtle ghost plus buttons
- Position centered below the last item in each list
- Low-contrast circular button with plus icon
- Animated appearance on hover/scroll
- Larger tappable hit target on mobile (min 44x44px)
- Smooth transition to visible state

**Benefits:**
- Declutters UI by removing prominent CTAs
- Emphasizes content (steps/tools) as primary focus
- More discoverable on mobile with larger touch targets
- Feels like natural continuation of list

---

## 038 — Advanced Step Settings

**Objective:** Add per-step advanced settings accessible via cog icon.

**Requirements:**
- Add cog icon to step card header (next to duplicate/delete)
- Opens advanced settings panel/dropdown
- "Clear previous conversation" option - removes context from prior steps
- Additional settings as needed (temperature override, model override, etc.)

**Details:**
- Useful for multi-stage experiments where you want a fresh context
- Could also include step-specific model parameters
- Settings stored in step data structure
