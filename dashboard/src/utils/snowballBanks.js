function normalizeClabe(value) {
  return String(value || '').replace(/\D+/g, '');
}

function slugify(value) {
  return String(value || 'banco')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'banco';
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function asConfigAccounts(bankAccountsConfig) {
  const accounts = bankAccountsConfig?.accounts;
  if (Array.isArray(accounts)) return accounts;
  if (accounts && typeof accounts === 'object') return Object.values(accounts);
  return [];
}

function findBankMeta(banks, bankName) {
  const normalized = normalizeName(bankName);
  return banks.find(bank => {
    const bankNormalized = normalizeName(bank.name || bank.id);
    return normalized === bankNormalized
      || normalized.startsWith(`${bankNormalized} `)
      || bankNormalized.startsWith(`${normalized} `);
  }) || null;
}

function buildOption({ id, bankId, name, clabe, note, color, logoUrl, source }) {
  return {
    id,
    bankId,
    name,
    clabe,
    note: note || '',
    color: color || '#64748b',
    logoUrl: logoUrl || '',
    source,
  };
}

export function buildSnowballBankOptions({ banks = [], bankAccountsConfig = null } = {}) {
  const options = [];
  const seenClabes = new Set();

  banks.forEach((bank) => {
    const clabe = normalizeClabe(bank.debitAccount?.clabe || bank.clabe);
    if (!clabe || seenClabes.has(clabe)) return;
    seenClabes.add(clabe);
    options.push(buildOption({
      id: `bank:${bank.id}:${clabe}`,
      bankId: bank.id,
      name: bank.name || bank.id,
      clabe,
      note: bank.debitAccount?.note || bank.note,
      color: bank.color,
      logoUrl: bank.logoUrl,
      source: 'banks',
    }));
  });

  asConfigAccounts(bankAccountsConfig).forEach((account) => {
    if (String(account.type || '').toLowerCase() === 'credito') return;
    const clabe = normalizeClabe(account.clabe);
    if (!clabe || seenClabes.has(clabe)) return;
    seenClabes.add(clabe);

    const bankMeta = findBankMeta(banks, account.bank);
    const bankId = bankMeta?.id || slugify(account.bank);
    options.push(buildOption({
      id: `config:${bankId}:${clabe}`,
      bankId,
      name: account.bank || bankMeta?.name || 'Banco externo',
      clabe,
      note: account.note,
      color: bankMeta?.color,
      logoUrl: bankMeta?.logoUrl,
      source: 'config/bank-accounts',
    }));
  });

  return options.sort((a, b) => a.name.localeCompare(b.name) || a.clabe.localeCompare(b.clabe));
}

export function resolveSnowballBankOptionId({
  options = [],
  destinationBankAccountId,
  destinationBankId,
  destinationClabe,
} = {}) {
  if (destinationBankAccountId && options.some(option => option.id === destinationBankAccountId)) {
    return destinationBankAccountId;
  }

  const clabe = normalizeClabe(destinationClabe);
  const matchingOption = options.find(option => (
    String(option.bankId || '') === String(destinationBankId || '')
    && (!clabe || option.clabe === clabe)
  )) || options.find(option => clabe && option.clabe === clabe);

  return matchingOption?.id || '';
}
