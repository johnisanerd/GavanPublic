import { Slide } from '@revealjs/react';
import type { TableSpec } from '../../../slide-spec.js';

/**
 * Tabular data layout. Optional title above; columns + rows render
 * as an HTML `<table>` with theme-driven styling. Wrapped in a
 * scroll-clip container so a marginally-too-tall table degrades to
 * scrollable rather than overflowing the slide.
 */
export function Table({ spec }: { spec: TableSpec }) {
  return (
    <Slide autoAnimate={Boolean(spec.auto_animate_from)}>
      <div className="layout-table">
        {spec.title && (
          <h2 className="slide-title" data-id="title">
            {spec.title}
          </h2>
        )}
        <div className="layout-table-scroll">
          <table>
            <thead>
              <tr>
                {spec.columns.map((col, i) => (
                  <th key={i}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {spec.notes.spoken && <aside className="notes">{spec.notes.spoken}</aside>}
    </Slide>
  );
}
