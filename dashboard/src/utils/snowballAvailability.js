function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeClabeValue(value) {
  return String(value || '').replace(/\D+/g, '');
}

function activeConnections(config, editingConnection) {
  const editingId = editingConnection?.id ? normalizeId(editingConnection.id) : '';
  return Object.entries(config?.connections || {})
    .map(([id, connection]) => ({ id, ...connection }))
    .filter(connection => connection.active !== false)
    .filter(connection => normalizeId(connection.id) !== editingId);
}

export function hasActiveSnowballWallet(config, accountId) {
  const wallet = config?.wallets?.[normalizeId(accountId)];
  if (!wallet || wallet.active === false) return false;
  return normalizeClabeValue(wallet.walletClabe || wallet.clabe).length === 18;
}

export function buildSnowballAccountOptions({
  accounts = [],
  config = {},
  editingConnection = null,
  fromAccountId = '',
  destinationType = 'lank_wallet',
} = {}) {
  const connections = activeConnections(config, editingConnection);
  const usedOutgoing = new Set();
  const usedIncoming = new Set();

  connections.forEach((connection) => {
    const from = normalizeId(connection.fromAccountId);
    if (from) usedOutgoing.add(from);
    if ((connection.destinationType || 'lank_wallet') === 'lank_wallet') {
      const to = normalizeId(connection.toAccountId);
      if (to) usedIncoming.add(to);
    }
  });

  const normalizedFrom = normalizeId(fromAccountId);
  const normalizedDestinationType = destinationType || 'lank_wallet';
  const accountList = accounts.map(account => ({ ...account, id: normalizeId(account.id) }));

  return {
    usedOutgoing,
    usedIncoming,
    originAccounts: accountList.filter(account => !usedOutgoing.has(account.id)),
    destinationAccounts: normalizedDestinationType === 'lank_wallet'
      ? accountList.filter(account => (
        account.id !== normalizedFrom
        && !usedIncoming.has(account.id)
        && hasActiveSnowballWallet(config, account.id)
      ))
      : [],
  };
}
