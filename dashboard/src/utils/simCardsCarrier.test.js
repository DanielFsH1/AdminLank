import { describe, expect, it } from 'vitest';
import { normalizeSimCarrier, resolveSimCarrier } from './simCardsCarrier';

describe('SIM Cards carrier normalization', () => {
  it('normalizes Juan Hoyos account #6 as OXXO Cel even if it was previously defaulted to Telcel', () => {
    const sim = {
      lankAccountId: 6,
      fullName: 'Juan Hoyos',
      canonicalAlias: 'Juan Hoyos',
      carrier: 'telcel',
    };

    expect(resolveSimCarrier(sim)).toBe('oxxocel');
    expect(normalizeSimCarrier(sim)).toEqual({ ...sim, carrier: 'oxxocel' });
  });

  it('corrects Lina Amalia account #10 away from stale OXXO Cel data', () => {
    const sim = {
      lankAccountId: 10,
      fullName: 'Lina Amalia Sotto',
      canonicalAlias: 'Lina Amalia',
      carrier: 'oxxocel',
    };

    expect(resolveSimCarrier(sim)).toBe('telcel');
    expect(normalizeSimCarrier(sim)).toEqual({ ...sim, carrier: 'telcel' });
  });

  it('normalizes known AT&T accounts from legacy Telcel defaults', () => {
    expect(resolveSimCarrier({ lankAccountId: 3, canonicalAlias: 'Israel', carrier: 'telcel' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 4, canonicalAlias: 'Juan53' })).toBe('att');
    expect(resolveSimCarrier({ lankAccountId: 5, canonicalAlias: 'Juan Felipe', carrier: 'telcel' })).toBe('att');
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
