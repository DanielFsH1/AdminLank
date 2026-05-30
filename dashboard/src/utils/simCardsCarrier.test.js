import { describe, expect, it } from 'vitest';
import { normalizeSimCarrier, resolveSimCarrier } from './simCardsCarrier';

describe('SIM Cards carrier normalization', () => {
  it('normalizes Cuenta Demo 6 account #6 as OXXO Cel even if it was previously defaulted to Telcel', () => {
    const sim = {
      lankAccountId: 6,
      fullName: 'Cuenta Demo 6',
      canonicalAlias: 'Cuenta Demo 6',
      carrier: 'telcel',
    };

    expect(resolveSimCarrier(sim)).toBe('oxxocel');
    expect(normalizeSimCarrier(sim)).toEqual({ ...sim, carrier: 'oxxocel' });
  });

  it('corrects Cuenta Demo 10 account #10 away from stale OXXO Cel data', () => {
    const sim = {
      lankAccountId: 10,
      fullName: 'Cuenta Demo 10',
      canonicalAlias: 'Cuenta Demo 10',
      carrier: 'oxxocel',
    };

    expect(resolveSimCarrier(sim)).toBe('telcel');
    expect(normalizeSimCarrier(sim)).toEqual({ ...sim, carrier: 'telcel' });
  });

  it('normalizes known AT&T accounts from legacy Telcel defaults', () => {
    expect(resolveSimCarrier({ lankAccountId: 3, canonicalAlias: 'Cuenta Demo 3', carrier: 'telcel' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 4, canonicalAlias: 'Cuenta Demo 4' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 5, canonicalAlias: 'Cuenta Demo 5', carrier: 'telcel' })).toBe('att');
  });

  it('keeps explicit non-legacy carriers for other SIMs', () => {
    expect(resolveSimCarrier({ lankAccountId: 8, carrier: 'att' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 1, carrier: 'telcel' })).toBe('telcel');
  });

  it('defaults unknown or missing carriers to Telcel', () => {
    expect(resolveSimCarrier({ lankAccountId: 11 })).toBe('telcel');
    expect(resolveSimCarrier({ lankAccountId: 12, carrier: 'unknown' })).toBe('telcel');
  });
});
