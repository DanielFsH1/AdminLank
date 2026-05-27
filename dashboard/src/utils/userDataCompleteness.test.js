import { describe, expect, it } from 'vitest';
import {
  getMissingUserDataFields,
  hasMissingUserData,
} from './userDataCompleteness';

const hboUserFields = [
  { key: 'userAlias', label: 'Alias del usuario', required: true },
  { key: 'phone', label: 'Teléfono' },
  { key: 'profileName', label: 'Nombre de perfil HBO' },
];

const youtubeUserFields = [
  { key: 'userAlias', label: 'Alias del usuario', required: true },
  { key: 'phone', label: 'Teléfono' },
  { key: 'userEmail', label: 'Correo de invitación', type: 'email' },
];

describe('user data completeness', () => {
  it('marks a group user as pending when phone is missing even if phone is not required in service config', () => {
    const missing = getMissingUserDataFields({
      user: { userAlias: 'Chaco65', profileName: 'Chaco' },
      userFields: hboUserFields,
    });

    expect(missing).toEqual(['Teléfono']);
    expect(hasMissingUserData({ user: { userAlias: 'Chaco65' }, userFields: hboUserFields })).toBe(true);
  });

  it('does not duplicate equivalent phone fields', () => {
    const missing = getMissingUserDataFields({
      user: { userAlias: 'Moni130', memberPhone: '5512345678' },
      userFields: hboUserFields,
    });

    expect(missing).not.toContain('Teléfono');
  });

  it('uses linked real-account slot data as fallback for service-specific profile or email fields', () => {
    const missingHbo = getMissingUserDataFields({
      user: { userAlias: 'Chaco65', phone: '5512345678' },
      userFields: hboUserFields,
      linkedSlot: { profileName: 'Chaco' },
    });
    const missingYoutube = getMissingUserDataFields({
      user: { userAlias: 'Kytzia1', phone: '5512345678' },
      userFields: youtubeUserFields,
      linkedSlot: { memberEmail: 'kytzia@example.com' },
    });

    expect(missingHbo).toEqual([]);
    expect(missingYoutube).toEqual([]);
  });
});
