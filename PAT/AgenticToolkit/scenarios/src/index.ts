/**
 * @agentic-toolkit/scenarios — top-level barrel.
 *
 * Scenarios is the generic envelope concept; specific kinds (today
 * just `presentation`) live under sibling subpaths and are imported
 * directly:
 *
 *   import { validateSpec } from '@agentic-toolkit/scenarios/presentation';
 *   import { RevealDeck } from '@agentic-toolkit/scenarios/presentation/react';
 *
 * This barrel only re-exports the kind-agnostic core: types,
 * provisioning client, scenarios index helpers.
 */
export * from './core/types.js';
export * from './core/provision-client.js';
export * from './core/scenarios-index.js';
