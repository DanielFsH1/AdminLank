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
        accountAlias: 'Cuenta Demo 1',
        groupStatus: 'active',
        users: [
          { userAlias: 'User A', serviceAccountRef: 'hbo_1' },
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
        accountAlias: 'Cuenta Demo 5',
        groupStatus: 'active',
        users: [
          { userAlias: 'User A', serviceAccountRef: 'hbo_1' },
          { userAlias: 'User B' },
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
      { id: 'hbo_2', slots: [{ status: 'active', memberAlias: 'User B' }] },
    ];

    expect(buildAssignableLankAccountsForSlot({ groups, realAccounts })).toEqual([]);
  });

  it('treats serviceAccountRef as an assignment even before checking slots', () => {
    expect(isGroupUserAssignedToRealAccount({ userAlias: 'User A', serviceAccountRef: 'chatgpt_2' })).toBe(true);
    expect(isGroupUserAssignedToRealAccount({ userAlias: 'User A' })).toBe(false);
  });
});
