# Known Issues

## Drag-and-Drop Animation

**Issue:** Step cards do not animate smoothly after drag ends.

**Current Behavior:** When dragging a step card and releasing it, the card snaps to its final position without animation.

**Expected Behavior:** The card should smoothly animate from its current drag position to the final resting position.

**Root Cause:** dnd-kit's layout animation attempts to animate from the item's original position (before drag started) rather than from the current hover position during drag. This creates a jarring "snap back" effect.

**Workaround:** Disabled layout animations with `animateLayoutChanges: () => false` in `useSortable()` to prevent the incorrect animation. Items now instantly appear in their final position on drop, which is less jarring than animating from the wrong starting point.

**Potential Fix:** May require custom animation implementation or upgrade to a newer version of dnd-kit if they've addressed this issue.

**Files Affected:**
- `components/StepsEditor.tsx` (line 30-34)

**Priority:** Low - functionality works correctly, purely cosmetic issue
