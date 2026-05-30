import { describe, expect, it } from 'vitest';

import {
  buildServiceConfig,
  getDefaultSlotFields,
  getDefaultUserFields,
  getBankMeta,
  normalizeServiceKey,
  normalizeServicesConfigDocument,
} from './services';

describe('dynamic service helpers', () => {
  it('normaliza nombres arbitrarios a serviceKey estable', () => {
    expect(normalizeServiceKey('Disney+ Premium')).toBe('disney_premium');
    expect(normalizeServiceKey('  VPN Mexico / Familiar  ')).toBe('vpn_mexico_familiar');
  });

  it('construye defaults operativos para servicios por invitacion', () => {
    const { key, config } = buildServiceConfig({
      name: 'Disney Plus',
      accessType: 'email_invitation',
      usesPool: true,
      maxSlotsPerRealAccount: 6,
      nameAliases: ['Disney+', 'Disney Plus Premium'],
    });

    expect(key).toBe('disney_plus');
    expect(config.active).toBe(true);
    expect(config.nameAliases).toEqual(['Disney Plus', 'Disney+', 'Disney Plus Premium']);
    expect(config.slotFields.map(field => field.key)).toEqual(['memberAlias', 'memberEmail']);
    expect(config.userFields.map(field => field.key)).toContain('userEmail');
  });

  it('marca profile_project como servicio con perfil y cupos por defecto', () => {
    const slotFields = getDefaultSlotFields('profile_project');
    const userFields = getDefaultUserFields('profile_project');

    expect(slotFields.map(field => field.key)).toEqual(['memberAlias', 'profileName']);
    expect(userFields.map(field => field.key)).toContain('profileName');
  });

  it('normaliza config/services tanto anidado como top-level sin mezclar metadata', () => {
    const topLevel = normalizeServicesConfigDocument({
      id: 'services',
      updatedAt: '2026-05-27T00:00:00Z',
      hbo: { name: 'HBO Max Platino', maxSlotsPerRealAccount: 5, maxSlotsPerLankGroup: 3 },
    });
    const nested = normalizeServicesConfigDocument({
      services: {
        hbo: { name: 'HBO Max Platino', maxSlotsPerRealAccount: 5, maxSlotsPerLankGroup: 3 },
      },
      updatedAt: 'ignored',
    });

    expect(topLevel).toEqual(nested);
    expect(topLevel.hbo.maxSlotsPerRealAccount).toBe(5);
    expect(topLevel.hbo.maxSlotsPerLankGroup).toBe(3);
    expect(topLevel.id).toBeUndefined();
    expect(topLevel.updatedAt).toBeUndefined();
  });

  it('resuelve metadatos de Plata aunque el banco venga como Banco Plata', () => {
    expect(getBankMeta('Plata').logo).toMatch(/^data:image\/svg\+xml,/);
    expect(getBankMeta('Banco Plata').logo).toMatch(/^data:image\/svg\+xml,/);
  });
});
