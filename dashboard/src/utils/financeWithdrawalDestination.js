const NON_OPERATIONAL_BANK_LABELS = new Set(['stp', 'arcus']);
export const UNCLASSIFIED_DESTINATION_LABEL = 'Destino por clasificar';

export function normalizeWithdrawalDestinationClabe(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeBankLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isOperationalBankLabel(value) {
  const normalized = normalizeBankLabel(value);
  return normalized
    && normalized !== normalizeBankLabel(UNCLASSIFIED_DESTINATION_LABEL)
    && !NON_OPERATIONAL_BANK_LABELS.has(normalized);
}

export function isOperationalExternalBankLabel(value) {
  const normalized = normalizeBankLabel(value);
  return Boolean(
    isOperationalBankLabel(value)
    && !normalized.startsWith('retiro a cuenta')
  );
}

function getWithdrawalClabe(withdrawal = {}) {
  return normalizeWithdrawalDestinationClabe(
    withdrawal.destinationClabe
    || withdrawal.accountNumber
    || withdrawal.clabe
    || withdrawal.knownBankAccount?.clabe
    || withdrawal.knownBankAccount?.accountNumber
  );
}

function normalizeAccountId(value) {
  return String(value || '').trim();
}

function accountAlias(account) {
  return account?.canonicalAlias || account?.fullName || account?.email || account?.accountAlias || '';
}

function buildAccountLookup(accounts = []) {
  return new Map(accounts.map(account => [normalizeAccountId(account.id || account.accountId), account]));
}

function findSnowballWalletByClabe(snowballConfig = {}, clabe = '') {
  if (!clabe) return null;
  const wallets = snowballConfig.wallets || {};

  return Object.entries(wallets).reduce((match, [walletId, wallet]) => {
    if (match || !wallet || wallet.active === false) return match;
    const walletClabe = normalizeWithdrawalDestinationClabe(wallet.walletClabe || wallet.clabe);
    if (walletClabe !== clabe) return null;
    return {
      accountId: normalizeAccountId(wallet.accountId || walletId),
      wallet,
    };
  }, null);
}

function findSnowballDestination(withdrawal = {}, snowballConfig = {}) {
  const explicitDestinationId = normalizeAccountId(withdrawal.destinationAccountId);
  if (withdrawal.movementType === 'snowball_internal' && explicitDestinationId) {
    return {
      accountId: explicitDestinationId,
      wallet: snowballConfig.wallets?.[explicitDestinationId],
    };
  }

  const clabe = getWithdrawalClabe(withdrawal);
  const walletMatch = findSnowballWalletByClabe(snowballConfig, clabe);
  if (!walletMatch) return null;

  return walletMatch;
}

function formatSnowballDestination(destination, accountsById) {
  if (!destination?.accountId) return null;

  const account = accountsById.get(destination.accountId);
  const alias = accountAlias(account) || destination.wallet?.accountAlias || destination.wallet?.fullName || '';

  return `Retiro a cuenta #${destination.accountId}${alias ? ` ${alias}` : ''}`;
}

export function resolveWithdrawalDestinationLabel(withdrawal = {}, {
  bankClabes = [],
  snowballConfig = {},
  accounts = [],
} = {}) {
  const accountsById = buildAccountLookup(accounts);
  const snowballDestination = findSnowballDestination(withdrawal, snowballConfig);
  const snowballLabel = formatSnowballDestination(snowballDestination, accountsById);
  if (snowballLabel) return snowballLabel;

  if (withdrawal.knownBankAccount?.bank) return withdrawal.knownBankAccount.bank;

  const clabe = getWithdrawalClabe(withdrawal);
  if (clabe) {
    const match = bankClabes.find(entry => (
      normalizeWithdrawalDestinationClabe(entry.clabe || entry.accountNumber) === clabe
    ));
    if (match?.bank) return match.bank;
  }

  if (!isOperationalBankLabel(withdrawal.bank)) return UNCLASSIFIED_DESTINATION_LABEL;
  return withdrawal.bank || UNCLASSIFIED_DESTINATION_LABEL;
}
