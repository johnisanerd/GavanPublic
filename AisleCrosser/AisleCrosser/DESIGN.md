# Design System Specification: The Editorial Statesman

## 1. Overview & Creative North Star

This design system is anchored by the dual philosophy of the **"Digital Architect"** and the **"Editorial Statesman."** We are not building a generic government portal; we are crafting a digital monument to legislative intent.

The aesthetic rejects the "Bootstrap-standard" of boxes and borders in favor of **intentional asymmetry** and **tonal depth**. By utilizing high-contrast serif typography against a backdrop of "Alabaster Parchment," we evoke the gravitas of a physical broadsheet newspaper and the structural permanence of neoclassical architecture. The layout should feel "curated" rather than "rendered," using breathing room and layering to guide the eye through complex legislative data.

---

## 2. Color Palette & Tonal Logic

Our palette is rooted in a heritage-inspired spectrum, updated for digital legibility and premium feel.

### Core Brand Palette
*   **Midnight Navy (`primary_container` | #002147):** The foundation of authority. Used for high-level navigation and primary structural anchors.
*   **Alabaster Parchment (`surface` | #F8F5F2):** Our primary canvas. It is softer than pure white, reducing eye strain and providing a sophisticated, tactile feel.
*   **Gilded Gold (`secondary` | #B1976B):** Used for "The Golden Thread"—highlighting key actions, active states, and prestige elements.
*   **Patriot Red (`on_tertiary_container` | #8B0000):** A deep, authoritative crimson for critical alerts and urgent legislative updates.
*   **Bipartisan Purple (#6D28D9):** Reserved for collaborative features and bridge-building interactive elements.

### The "No-Line" Rule
**Strict Mandate:** Designers are prohibited from using 1px solid borders to section content. Visual boundaries must be achieved through:
1.  **Background Shifts:** Transitioning from `surface` to `surface_container_low`.
2.  **Tonal Transitions:** Using the `surface_variant` to define header regions.
3.  **Negative Space:** Utilizing the spacing scale (e.g., `spacing-12`) to create a "conceptual border."

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked high-quality paper stocks.
*   **Base:** `surface` (#fcf9f6)
*   **Layer 1 (Main Content):** `surface_container_low` (#f6f3f0)
*   **Layer 2 (Interactive Cards):** `surface_container` (#f0edea)
*   **Layer 3 (Floating Modals):** `surface_container_highest` (#e5e2df)

---

## 3. Typography: The Voice of Authority

The typography system relies on the interplay between the structural **Noto Serif** and the functional **Public Sans**.

| Token | Font Family | Size | Intent |
| :--- | :--- | :--- | :--- |
| `display-lg` | Noto Serif | 3.5rem | Hero headlines for landmark legislation. |
| `headline-md` | Noto Serif | 1.75rem | Section headers; editorial in feel. |
| `title-lg` | Public Sans | 1.375rem | High-level functional labels and card titles. |
| `body-lg` | Public Sans | 1rem | Primary reading text; generous for accessibility. |
| `label-md` | Public Sans | 0.75rem | Meta-data, timestamps, and micro-copy. |

**Editorial Note:** Always pair `display` sizes with tight line-height (1.1) and `body` sizes with generous line-height (1.6) to maintain the "Statesman" aesthetic.

---

## 4. Elevation & Depth

We eschew "material" shadows in favor of **Tonal Layering** and **Ambient Light**.

*   **The Layering Principle:** Depth is achieved by placing a `surface_container_lowest` (#ffffff) card onto a `surface_container_low` (#f6f3f0) background. This creates a "soft lift" that feels organic.
*   **Ghost Borders:** If a boundary is required for accessibility, use `outline_variant` at **15% opacity**. It should be felt, not seen.
*   **Glassmorphism:** For floating navigation or mobile headers, use a 70% opacity fill of `surface_bright` with a `backdrop-filter: blur(12px)`. This integrates the component into the page's color story.
*   **Ambient Shadows:** For high-priority modals, use a shadow with a 32px blur, 0px offset, and 4% opacity of the `on_surface` color.

---

## 5. Components

### Buttons
*   **Primary:** Filled with `primary_container` (#002147). 0px corner radius. Text in `on_primary` (White).
*   **Secondary:** Ghost style with a `Gilded Gold` text color and a 10% opacity Gold background on hover.
*   **Tertiary:** Underlined text using `Public Sans` Bold. No container.

### Cards & Lists
*   **No Dividers:** Lists should never use horizontal lines. Use `spacing-4` between items and a background shift (`surface_container_low`) on hover.
*   **The "Architect" Card:** Use an asymmetrical padding (e.g., `padding-left: 2.75rem`, `padding-right: 1.4rem`) to create an editorial layout within the card itself.

### Signature Component: The Legislative Scroll
A specialized container for long-form bill text. Use `Alabaster Parchment` for the background, `Noto Serif` for the body text, and a sticky "Gilded Gold" progress bar at the top to indicate reading depth.

---

## 6. Do's and Don'ts

### Do:
*   **Do** use asymmetrical layouts where one column is significantly wider than the other to mimic professional journals.
*   **Do** lean into "Alabaster Parchment" as your primary background color to avoid the sterile "tech" look.
*   **Do** ensure all interactive elements have at least a 44px hit target for accessibility, despite the "refined" look.

### Don't:
*   **Don't** use rounded corners (`0px` radius is mandatory). Sharp corners convey structural integrity.
*   **Don't** use pure black (#000000). Use `primary` (#000a1e) for high-contrast text.
*   **Don't** use drop shadows to define every card. Rely on the "Surface Hierarchy" tokens first.
*   **Don't** crowd the interface. If the legislative data is complex, increase the whitespace (`spacing-16` or `spacing-20`).
