import { Slide } from '@revealjs/react';
import type { TwoColSpec } from '../../../slide-spec.js';

interface SlotProps {
  slot: TwoColSpec['left'];
}

function Slot({ slot }: SlotProps) {
  if (slot.kind === 'text') {
    const body = Array.isArray(slot.body) ? slot.body.join('\n\n') : slot.body;
    return (
      <div className="slot-text">
        {body.split('\n\n').map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
    );
  }
  if (slot.kind === 'list') {
    const items = Array.isArray(slot.body) ? slot.body : [slot.body];
    return (
      <ul className="slot-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  if (slot.kind === 'figure') {
    const src = typeof slot.body === 'string' ? slot.body : slot.body[0] ?? '';
    return (
      <figure className="slot-figure">
        <img src={src} alt={slot.caption ?? ''} />
        {slot.caption && <figcaption>{slot.caption}</figcaption>}
      </figure>
    );
  }
  // code
  const code = typeof slot.body === 'string' ? slot.body : slot.body.join('\n');
  return (
    <pre className="slot-code">
      <code className={slot.language ? `language-${slot.language}` : ''}>
        {code}
      </code>
    </pre>
  );
}

/**
 * Two-column workhorse. CSS Grid (not flexbox — better ratio control,
 * no flex-shrink surprises with images). Replaces v2's `callouts-N`,
 * `image-text`, `image-left/right` — one primitive covers them all
 * via the typed slot kinds.
 */
export function TwoCol({ spec }: { spec: TwoColSpec }) {
  const ratio = spec.ratio ?? '1fr 1fr';
  return (
    <Slide autoAnimate={Boolean(spec.auto_animate_from)}>
      <div className="layout-two-col">
        {spec.title && (
          <h2 className="slide-title" data-id="title">
            {spec.title}
          </h2>
        )}
        <div
          className="two-col-grid"
          style={{ gridTemplateColumns: ratio }}
        >
          <div className="two-col-side two-col-left">
            <Slot slot={spec.left} />
          </div>
          <div className="two-col-side two-col-right">
            <Slot slot={spec.right} />
          </div>
        </div>
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
