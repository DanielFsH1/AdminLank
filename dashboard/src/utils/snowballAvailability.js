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

function connectionDestinationType(connection) {
  return connection?.destinationType || 'lank_wallet';
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

export function buildSnowballBankDestinationOptions({
  bankOptions = [],
  config = {},
  editingConnection = null,
} = {}) {
  const connections = activeConnections(config, editingConnection);
  const usedExternalClabes = new Set();
  const usedExternalBankIds = new Set();

  connections.forEach((connection) => {
    if (connectionDestinationType(connection) !== 'external_bank') return;
    const clabe = normalizeClabeValue(connection.destinationClabe);
    if (clabe) usedExternalClabes.add(clabe);
    const bankId = normalizeId(connection.destinationBankId);
    if (bankId) usedExternalBankIds.add(bankId);
  });

  return {
    usedExternalClabes,
    usedExternalBankIds,
    destinationBanks: bankOptions.filter(bank => (
      !usedExternalClabes.has(normalizeClabeValue(bank.clabe))
      && !usedExternalBankIds.has(normalizeId(bank.bankId))
    )),
  };
}

export function describeSnowballConnectionDeletion(config = {}, connection = {}) {
  const active = activeConnections(config, connection);
  const from = normalizeId(connection.fromAccountId);
  const to = normalizeId(connection.toAccountId);
  const destinationType = connectionDestinationType(connection);

  if (connection.active === false) {
    return {
      willSplitChain: false,
      message: 'Esta conexión está inactiva; eliminarla no cambia las bolas activas.',
    };
  }

  if (destinationType === 'external_bank') {
    return {
      willSplitChain: false,
      message: `Se eliminará el retiro externo desde la cuenta Lank #${from}. La cuenta quedará sin destino final.`,
    };
  }

  const hasIncomingBefore = active.some(candidate => (
    connectionDestinationType(candidate) === 'lank_wallet'
    && normalizeId(candidate.toAccountId) === from
  ));
  const hasOutgoingAfter = active.some(candidate => normalizeId(candidate.fromAccountId) === to);
  const willSplitChain = Boolean(hasIncomingBefore && hasOutgoingAfter);

  if (willSplitChain) {
    return {
      willSplitChain: true,
      message: `Eliminar la conexión #${from} -> #${to} separará la bola en dos cadenas activas independientes.`,
    };
  }

  return {
    willSplitChain: false,
    message: `Se eliminará la conexión #${from} -> #${to}. La cadena se recalculará automáticamente.`,
  };
}
