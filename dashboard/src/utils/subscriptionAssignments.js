import { normalizeSearch } from './normalize';

export function getGroupUserAlias(user) {
  if (typeof user === 'string') return user.trim();
  return String(user?.userAlias || user?.memberAlias || '').trim();
}

function normalizeAlias(alias) {
  return normalizeSearch(alias);
}

function buildAssignedAliasSet(realAccounts = []) {
  const aliases = new Set();

  realAccounts.forEach((account) => {
    (account.slots || []).forEach((slot) => {
      if (slot?.status !== 'active') return;
      const alias = normalizeAlias(slot.memberAlias);
      if (alias) aliases.add(alias);
    });
  });

  return aliases;
}

export function isGroupUserAssignedToRealAccount(user, assignedSlotAliases = new Set()) {
  if (typeof user !== 'string' && user?.serviceAccountRef) return true;
  const alias = normalizeAlias(getGroupUserAlias(user));
  return Boolean(alias && assignedSlotAliases.has(alias));
}

export function normalizeGroupUser(user) {
  return typeof user === 'string' ? { userAlias: user.trim() } : user;
}

export function buildAssignableLankAccountsForSlot({ groups = [], realAccounts = [] } = {}) {
  const assignedSlotAliases = buildAssignedAliasSet(realAccounts);

  return groups
    .filter(group => group.groupStatus === 'active')
    .map((group) => {
      const users = (group.users || [])
        .map(normalizeGroupUser)
        .filter(user => getGroupUserAlias(user))
        .filter(user => !isGroupUserAssignedToRealAccount(user, assignedSlotAliases));

      return { ...group, users };
    })
    .filter(group => group.users.length > 0)
    .sort((a, b) => (a.accountId || 0) - (b.accountId || 0));
}
