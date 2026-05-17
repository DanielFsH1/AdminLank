import { describe, expect, it } from 'vitest';

import {
  buildServiceConfig,
  getDefaultSlotFields,
  getDefaultUserFields,
  getBankMeta,
  normalizeServiceKey,
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

  it('resuelve metadatos de Plata aunque el banco venga como Banco Plata', () => {
    expect(getBankMeta('Plata').logo).toBe('/assets/Plata.png');
    expect(getBankMeta('Banco Plata').logo).toBe('/assets/Plata.png');
  });
});
