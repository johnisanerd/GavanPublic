import { Slide, Fragment } from '@revealjs/react';
import type { BulletsSpec } from '../../../slide-spec.js';

/**
 * Bullets layout. Title + ordered list of points. `emphasis: 'large'`
 * styles bullets as callouts (replaces the v2 `callouts-N` layouts).
 * `fragment: true` reveals items one at a time as reveal fragments.
 *
 * Bullets render as `**bold leading phrase**` followed by body when
 * the item begins with `**...**` — a tiny markdown affordance the
 * agent already uses when expressing "headline + detail" bullets.
 */
function renderBulletItem(item: string, key: number): React.ReactNode {
  const boldMatch = item.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (boldMatch) {
    return (
      <li key={key}>
        <strong>{boldMatch[1]}</strong>
        {boldMatch[2] && <span> {boldMatch[2]}</span>}
      </li>
    );
  }
  return <li key={key}>{item}</li>;
}

export function Bullets({ spec }: { spec: BulletsSpec }) {
  const cls = `layout-bullets ${spec.emphasis === 'large' ? 'is-large' : ''}`;
  const items = spec.items.map((item, i) => {
    const el = renderBulletItem(item, i);
    if (spec.fragment) {
      return (
        <Fragment key={i} asChild animation="fade-up">
          {el as React.ReactElement}
        </Fragment>
      );
    }
    return el;
  });
  return (
    <Slide autoAnimate={Boolean(spec.auto_animate_from)}>
      <div className={cls}>
        <h2 className="slide-title" data-id="title">
          {spec.title}
        </h2>
        <ul>{items}</ul>
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
