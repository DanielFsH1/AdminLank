import { describe, expect, it } from 'vitest';
import { normalizeFirestoreOptions } from './firestoreQueryHelpers';

describe('normalizeFirestoreOptions', () => {
  it('usa defaults seguros cuando no recibe opciones', () => {
    expect(normalizeFirestoreOptions()).toEqual({
      enabled: true,
      realtime: false,
      constraints: [],
      deps: [],
    });
  });

  it('respeta enabled false y constraints explícitos', () => {
    const constraints = [{ type: 'limit', value: 50 }];
    const deps = ['alerts'];

    expect(normalizeFirestoreOptions({ enabled: false, constraints, deps })).toEqual({
      enabled: false,
      realtime: false,
      constraints,
      deps,
    });
  });

  it('permite desactivar realtime', () => {
    expect(normalizeFirestoreOptions({ realtime: false })).toEqual({
      enabled: true,
      realtime: false,
      constraints: [],
      deps: [],
    });
  });
});
