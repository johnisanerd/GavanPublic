import { Slide } from '@revealjs/react';
import type { TitleSpec } from '../../../slide-spec.js';

/**
 * Title layout. Big centered title via `r-fit-text` (fitty-driven
 * auto-fit), optional subtitle, optional background. Use this for
 * cover slides + major section starts when a `section` divider isn't
 * enough.
 */
export function Title({ spec }: { spec: TitleSpec }) {
  const bg = spec.background ?? {};
  return (
    <Slide
      backgroundImage={bg.image}
      backgroundColor={bg.color}
      backgroundGradient={bg.gradient}
      autoAnimate={Boolean(spec.auto_animate_from)}
    >
      <div className="layout-title">
        <h1 className="r-fit-text" data-id="title">
          {spec.title}
        </h1>
        {spec.subtitle && <p className="subtitle">{spec.subtitle}</p>}
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
