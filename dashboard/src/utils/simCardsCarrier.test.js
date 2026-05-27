import { describe, expect, it } from 'vitest';
import { normalizeSimCarrier, resolveSimCarrier } from './simCardsCarrier';

describe('SIM Cards carrier normalization', () => {
  it('normalizes legacy Juan Hoyos SIM as OXXO Cel even if it was previously defaulted to Telcel', () => {
    const sim = {
      lankAccountId: 10,
      fullName: 'Juan Hoyos',
      canonicalAlias: 'Juan Hoyos',
      carrier: 'telcel',
    };

    expect(resolveSimCarrier(sim)).toBe('oxxocel');
    expect(normalizeSimCarrier(sim)).toEqual({ ...sim, carrier: 'oxxocel' });
  });

  it('keeps explicit non-legacy carriers for other SIMs', () => {
    expect(resolveSimCarrier({ lankAccountId: 3, carrier: 'att' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 1, carrier: 'telcel' })).toBe('telcel');
  });

  it('defaults unknown or missing carriers to Telcel', () => {
    expect(resolveSimCarrier({ lankAccountId: 11 })).toBe('telcel');
    expect(resolveSimCarrier({ lankAccountId: 12, carrier: 'unknown' })).toBe('telcel');
  });
});
