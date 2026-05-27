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

export function findRealAccountSlotForGroupUser({ user, group = {}, realAccounts = [] } = {}) {
  const alias = normalizeAlias(getGroupUserAlias(user));
  if (!alias) return null;

  const groupAccountId = group.accountId ?? group.id;
  const groupAccountIdStr = groupAccountId === undefined || groupAccountId === null
    ? ''
    : String(groupAccountId);
  const serviceAccountRef = typeof user === 'object' && user
    ? String(user.serviceAccountRef || '').trim()
    : '';

  const candidates = [];

  realAccounts.forEach((account) => {
    const accountRefs = [account.id, account.serviceAccountRef]
      .filter(Boolean)
      .map(value => String(value));

    (account.slots || []).forEach((slot, slotIndex) => {
      if (slot?.status !== 'active') return;
      if (normalizeAlias(slot.memberAlias) !== alias) return;

      const assignedAccountId = slot.assignedFrom?.accountId;
      const assignedAccountIdStr = assignedAccountId === undefined || assignedAccountId === null
        ? ''
        : String(assignedAccountId);
      const assignedMatchesGroup = Boolean(groupAccountIdStr && assignedAccountIdStr === groupAccountIdStr);
      const assignedConflictsGroup = Boolean(groupAccountIdStr && assignedAccountIdStr && assignedAccountIdStr !== groupAccountIdStr);
      const accountMatchesRef = Boolean(serviceAccountRef && accountRefs.includes(serviceAccountRef));
      const accountConflictsRef = Boolean(serviceAccountRef && !accountRefs.includes(serviceAccountRef));

      let score = 1; // Alias match.
      if (assignedMatchesGroup) score += 4;
      if (accountMatchesRef) score += 3;
      if (assignedConflictsGroup) score -= 4;
      if (accountConflictsRef) score -= 2;

      candidates.push({
        score,
        account,
        accountId: account.id,
        accountLabel: account.label || account.serviceAccountRef || account.id,
        slot,
        slotIndex,
        slotNumber: slot.slotNumber || slotIndex + 1,
      });
    });
  });

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score <= 0) return null;
  const { score: _score, ...match } = best;
  return match;
}

export function getGroupUserAccessState({ user, group = {}, realAccounts = [] } = {}) {
  const match = findRealAccountSlotForGroupUser({ user, group, realAccounts });
  if (match) {
    return {
      state: 'assigned',
      label: `Asignado a ${match.accountLabel} / cupo #${match.slotNumber}`,
      match,
    };
  }

  const serviceAccountRef = typeof user === 'object' && user
    ? String(user.serviceAccountRef || '').trim()
    : '';
  if (serviceAccountRef) {
    return {
      state: 'link_only',
      label: `Ref sin slot confirmado: ${serviceAccountRef}`,
      serviceAccountRef,
    };
  }

  return {
    state: 'pending',
    label: 'Pendiente de cuenta real',
  };
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
