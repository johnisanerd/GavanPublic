/**
 * compileVisual — dispatch a SlideSpec to its React layout component.
 * The single compile entrypoint pat-web uses to render any spec.
 *
 * Validation is the caller's job (`validateSpec` first). compileVisual
 * doesn't re-validate; it trusts well-formed input. A malformed spec
 * here is a bug in the caller, not a graceful failure path.
 */
import type { JSX } from 'react';
import type { SlideSpec } from '../../../slide-spec.js';
import { Title } from './Title.js';
import { Section } from './Section.js';
import { Bullets } from './Bullets.js';
import { TwoCol } from './TwoCol.js';
import { ImageFull } from './ImageFull.js';
import { Quote } from './Quote.js';
import { Stat } from './Stat.js';
import { Table } from './Table.js';

export { Title, Section, Bullets, TwoCol, ImageFull, Quote, Stat, Table };

export function compileVisual(spec: SlideSpec): JSX.Element {
  switch (spec.layout) {
    case 'title':
      return <Title spec={spec} />;
    case 'section':
      return <Section spec={spec} />;
    case 'bullets':
      return <Bullets spec={spec} />;
    case 'two-col':
      return <TwoCol spec={spec} />;
    case 'image-full':
      return <ImageFull spec={spec} />;
    case 'quote':
      return <Quote spec={spec} />;
    case 'stat':
      return <Stat spec={spec} />;
    case 'table':
      return <Table spec={spec} />;
  }
}
