import { Slide } from '@revealjs/react';
import type { StatSpec } from '../../../slide-spec.js';

/**
 * Hero-stat layout — single massive number, short label, optional
 * DM Mono eyebrow above. Brand-native scale (~6em ≈ 240px on the
 * 1080 canvas, in the 160-200pt range the brand calls for).
 *
 * Persuasive-briefing primitive. Use whenever a single quantitative
 * beat is doing the heavy lifting and would otherwise get buried in
 * prose or a table cell.
 *
 * `background: 'steel'` flips to full-bleed Steel Grey statement
 * variant (title/conclusion register); `stone` is the default
 * content-slide register.
 */
export function Stat({ spec }: { spec: StatSpec }) {
  const isSteel = spec.background === 'steel';
  return (
    <Slide
      backgroundColor={isSteel ? '#29303E' : undefined}
      autoAnimate={Boolean(spec.auto_animate_from)}
    >
      <div
        className={`layout-stat ${isSteel ? 'is-steel' : ''}`}
        data-bg={isSteel ? 'steel' : 'stone'}
      >
        {spec.context && <p className="stat-context">{spec.context}</p>}
        <p className="stat-value" data-id="stat-value">
          {spec.value}
        </p>
        <p className="stat-label">{spec.label}</p>
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
