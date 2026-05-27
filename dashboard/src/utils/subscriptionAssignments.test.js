import { describe, expect, it } from 'vitest';
import {
  buildAssignableLankAccountsForSlot,
  getGroupUserAlias,
  isGroupUserAssignedToRealAccount,
} from './subscriptionAssignments';

describe('subscription slot assignment candidates', () => {
  it('excludes users already linked to any real account of the service', () => {
    const groups = [
      {
        id: 'silva-herrera',
        accountId: 2,
        accountAlias: 'Silva Herrera',
        groupStatus: 'active',
        users: [
          { userAlias: 'Kytzia1', serviceAccountRef: 'hbo_1' },
          { userAlias: 'Libre', userEmail: 'libre@example.com' },
          { userAlias: 'EnSlotPeroSinRef' },
          'TextoLibre',
        ],
      },
    ];
    const realAccounts = [
      {
        id: 'hbo_2',
        slots: [
          { status: 'active', memberAlias: 'EnSlotPeroSinRef' },
          { status: 'free', memberAlias: '' },
        ],
      },
    ];

    const accounts = buildAssignableLankAccountsForSlot({ groups, realAccounts });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].users.map(getGroupUserAlias)).toEqual(['Libre', 'TextoLibre']);
  });

  it('removes groups when every user already has a real-account assignment', () => {
    const groups = [
      {
        id: 'juan-felipe',
        accountId: 5,
        accountAlias: 'Juan Felipe',
        groupStatus: 'active',
        users: [
          { userAlias: 'Ana', serviceAccountRef: 'hbo_1' },
          { userAlias: 'Beto' },
        ],
      },
      {
        id: 'inactive',
        accountId: 9,
        groupStatus: 'paused',
        users: [{ userAlias: 'Disponible' }],
      },
    ];
    const realAccounts = [
      { id: 'hbo_2', slots: [{ status: 'active', memberAlias: 'Beto' }] },
    ];

    expect(buildAssignableLankAccountsForSlot({ groups, realAccounts })).toEqual([]);
  });

  it('treats serviceAccountRef as an assignment even before checking slots', () => {
    expect(isGroupUserAssignedToRealAccount({ userAlias: 'Moni', serviceAccountRef: 'chatgpt_2' })).toBe(true);
    expect(isGroupUserAssignedToRealAccount({ userAlias: 'Moni' })).toBe(false);
  });
});
