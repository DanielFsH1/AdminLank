import { describe, expect, it } from 'vitest';
import {
  buildAssignableLankAccountsForSlot,
  findRealAccountSlotForGroupUser,
  getGroupUserAccessState,
} from './subscriptionAssignments';

const hboGroup = {
  id: '6',
  accountId: 6,
  accountAlias: 'Juan Hoyos',
  groupStatus: 'active',
  users: [
    { userAlias: 'Ivan G', serviceAccountRef: 'hbo_1' },
    { userAlias: 'CallMeDevi' },
  ],
};

const hboPool = [
  {
    id: 'hbo_1',
    serviceAccountRef: 'hbo_1',
    label: 'HBO activa',
    slots: [
      {
        slotNumber: 5,
        status: 'active',
        memberAlias: 'Ivan G',
        assignedFrom: { accountId: 6, canonicalAlias: 'Juan Hoyos' },
      },
    ],
  },
];

describe('subscription assignment helpers', () => {
  it('matches a group user to its real account slot using alias and group account id', () => {
    const match = findRealAccountSlotForGroupUser({
      user: hboGroup.users[0],
      group: hboGroup,
      realAccounts: hboPool,
    });

    expect(match).toMatchObject({
      accountId: 'hbo_1',
      accountLabel: 'HBO activa',
      slotNumber: 5,
    });
  });

  it('reports pending access for pool group users with no real slot', () => {
    const access = getGroupUserAccessState({
      user: hboGroup.users[1],
      group: hboGroup,
      realAccounts: hboPool,
    });

    expect(access).toEqual({
      state: 'pending',
      label: 'Pendiente de cuenta real',
    });
  });

  it('keeps assigned users out of the list of users available for new real-account slots', () => {
    const accounts = buildAssignableLankAccountsForSlot({
      groups: [hboGroup],
      realAccounts: hboPool,
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].users.map(user => user.userAlias)).toEqual(['CallMeDevi']);
  });
});
