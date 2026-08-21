import { Slide } from '@revealjs/react';
import type { ImageFullSpec } from '../../../slide-spec.js';

/**
 * Full-bleed image slide. Uses reveal's `data-background-image`
 * rather than `r-stretch` (which is direct-descendant-only and
 * single-per-slide; conflicts with our grid-based layouts). Optional
 * caption overlay at the bottom.
 */
export function ImageFull({ spec }: { spec: ImageFullSpec }) {
  return (
    <Slide
      backgroundImage={spec.figure}
      backgroundSize="contain"
      backgroundPosition="center"
      backgroundRepeat="no-repeat"
      backgroundColor="#000"
      autoAnimate={Boolean(spec.auto_animate_from)}
    >
      {spec.caption && (
        <div className="layout-image-full-caption">
          <p>{spec.caption}</p>
        </div>
      )}
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
