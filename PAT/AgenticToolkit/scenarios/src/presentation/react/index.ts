/**
 * React layouts + deck wrapper for the presentation kind.
 *
 * Consumers must have `react`, `reveal.js`, and `@revealjs/react`
 * installed (declared as optional peer deps on the package).
 */
export { RevealDeck } from './components/RevealDeck.js';
export type { RevealDeckProps } from './components/RevealDeck.js';
export { compileVisual } from './components/slide-layouts/index.js';
export {
  Title,
  Section,
  Bullets,
  TwoCol,
  ImageFull,
  Quote,
  Stat,
  Table,
} from './components/slide-layouts/index.js';
