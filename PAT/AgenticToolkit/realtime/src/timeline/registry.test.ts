import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerActionDomain,
  findExtensionFor,
  listExtensions,
  resetRegistry,
  setRegistryConflictHook,
  type ActionDomainExtension,
} from './registry.js';
import type { DispatchContext, TimelineAction } from './types.js';

function makeExt(name: string, predicate: (tag: string) => boolean): ActionDomainExtension {
  return {
    name,
    matches: predicate,
    parseAction(): TimelineAction | null {
      return { kind: 'pause', ms: 0 };
    },
    async dispatch(_action: TimelineAction, _ctx: DispatchContext) {
      // no-op
    },
  };
}

describe('registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('finds the first registered match', () => {
    const a = makeExt('a', (t) => t === 'foo');
    const b = makeExt('b', (t) => t === 'bar');
    registerActionDomain(a);
    registerActionDomain(b);
    expect(findExtensionFor('foo')?.name).toBe('a');
    expect(findExtensionFor('bar')?.name).toBe('b');
  });

  it('returns null on unknown tag', () => {
    registerActionDomain(makeExt('only', (t) => t === 'foo'));
    expect(findExtensionFor('missing')).toBeNull();
  });

  it('first-registered wins on conflict and reports via hook', () => {
    const conflicts: { tag: string; winner: string; loser: string }[] = [];
    setRegistryConflictHook((info) => conflicts.push(info));

    const first = makeExt('first', (t) => t.startsWith('x'));
    const second = makeExt('second', (t) => t.startsWith('x'));
    registerActionDomain(first);
    registerActionDomain(second);

    expect(findExtensionFor('xenon')?.name).toBe('first');
    expect(conflicts).toEqual([{ tag: 'xenon', winner: 'first', loser: 'second' }]);
  });

  it('register-with-existing-name replaces in place (idempotent)', () => {
    const v1 = makeExt('scenarios', (t) => t === 'old');
    const v2 = makeExt('scenarios', (t) => t === 'new');
    registerActionDomain(v1);
    registerActionDomain(v2);
    expect(listExtensions().length).toBe(1);
    expect(findExtensionFor('old')).toBeNull();
    expect(findExtensionFor('new')?.name).toBe('scenarios');
  });

  it('resetRegistry clears everything including hook', () => {
    let called = 0;
    setRegistryConflictHook(() => {
      called++;
    });
    registerActionDomain(makeExt('a', () => true));
    registerActionDomain(makeExt('b', () => true));
    expect(listExtensions().length).toBe(2);
    findExtensionFor('anything');
    expect(called).toBe(1);

    resetRegistry();
    expect(listExtensions().length).toBe(0);
    // No conflict reported now — hook is cleared.
    registerActionDomain(makeExt('c', () => true));
    registerActionDomain(makeExt('d', () => true));
    findExtensionFor('anything');
    expect(called).toBe(1);
  });

  it('listExtensions returns a read-only copy', () => {
    registerActionDomain(makeExt('a', (t) => t === 'a'));
    const list = listExtensions();
    expect(list.length).toBe(1);
    // Mutating the snapshot must not affect the registry.
    (list as ActionDomainExtension[]).push(makeExt('b', () => true));
    expect(listExtensions().length).toBe(1);
  });
});
