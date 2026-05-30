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
      user: { userAlias: 'User D', profileName: 'Profile A' },
      userFields: hboUserFields,
    });

    expect(missing).toEqual(['Teléfono']);
    expect(hasMissingUserData({ user: { userAlias: 'User D' }, userFields: hboUserFields })).toBe(true);
  });

  it('does not duplicate equivalent phone fields', () => {
    const missing = getMissingUserDataFields({
      user: { userAlias: 'User A130', memberPhone: '5500000000' },
      userFields: hboUserFields,
    });

    expect(missing).not.toContain('Teléfono');
  });

  it('uses linked real-account slot data as fallback for service-specific profile or email fields', () => {
    const missingHbo = getMissingUserDataFields({
      user: { userAlias: 'User D', phone: '5500000000' },
      userFields: hboUserFields,
      linkedSlot: { profileName: 'Profile A' },
    });
    const missingYoutube = getMissingUserDataFields({
      user: { userAlias: 'User A', phone: '5500000000' },
      userFields: youtubeUserFields,
      linkedSlot: { memberEmail: 'member@example.com' },
    });

    expect(missingHbo).toEqual([]);
    expect(missingYoutube).toEqual([]);
  });
});
