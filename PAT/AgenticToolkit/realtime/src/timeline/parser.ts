/**
 * Timeline parser — re-export of the existing TagStreamParser.
 *
 * Phase 1 keeps the physical file at `realtime/src/tag-stream-parser.ts`
 * to avoid touching call sites. This re-export gives downstream code
 * (e.g. `timeline/queue.ts`, future domain extensions) a single import
 * path under `timeline/`. A later phase may physically move the file
 * once the queue is wired through.
 */

export { TagStreamParser, parseTagStream } from '../tag-stream-parser.js';
export type { TagEvent } from '../tag-stream-parser.js';
