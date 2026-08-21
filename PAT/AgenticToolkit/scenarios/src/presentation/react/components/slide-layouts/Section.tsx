import { Slide } from '@revealjs/react';
import type { SectionSpec } from '../../../slide-spec.js';

/**
 * Section divider. Single big phrase, theme-styled, no other content.
 * Use to mark a topic change between major beats. Different from
 * `title` (which is a real cover slide with subtitle support).
 */
export function Section({ spec }: { spec: SectionSpec }) {
  return (
    <Slide autoAnimate={Boolean(spec.auto_animate_from)}>
      <div className="layout-section">
        <h2 className="r-fit-text">{spec.label}</h2>
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
