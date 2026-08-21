import { Slide } from '@revealjs/react';
import type { QuoteSpec } from '../../../slide-spec.js';

/**
 * Pull-quote layout. Per Palisade brand (slide 8): massive DM Sans
 * bottom-left, NO quote marks, small DM-Mono label above ("OUR
 * MISSION" / similar). Attribution + source render in DM Mono below.
 */
export function Quote({ spec }: { spec: QuoteSpec }) {
  return (
    <Slide autoAnimate={Boolean(spec.auto_animate_from)}>
      <div className="layout-quote">
        <p className="quote-label">Quote</p>
        <blockquote>{spec.text}</blockquote>
        {(spec.attribution || spec.source) && (
          <footer>
            {spec.attribution && <cite>— {spec.attribution}</cite>}
            {spec.source && <small>{spec.source}</small>}
          </footer>
        )}
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
