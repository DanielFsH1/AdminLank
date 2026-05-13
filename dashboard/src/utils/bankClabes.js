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

function normalizeType(value, fallback = 'debito') {
  const type = normalizeName(value);
  return type === 'credito' || type === 'credit' ? 'credito' : fallback;
}

function buildOption({ id, bankId, name, clabe, type, note, color, logoUrl, source }) {
  return {
    id,
    bankId,
    name,
    clabe,
    type,
    note: note || '',
    color: color || '#64748b',
    logoUrl: logoUrl || '',
    source,
  };
}

function addOption(options, seenClabes, option) {
  if (!option.clabe || seenClabes.has(option.clabe)) return;
  seenClabes.add(option.clabe);
  options.push(buildOption(option));
}

export function buildBankClabeOptions({ banks = [], bankAccountsConfig = null } = {}) {
  const options = [];
  const seenClabes = new Set();

  banks.forEach((bank) => {
    const debitClabe = normalizeClabe(bank.debitAccount?.clabe || bank.clabe);
    addOption(options, seenClabes, {
      id: `bank:${bank.id}:debit:${debitClabe}`,
      bankId: bank.id,
      name: bank.name || bank.id,
      clabe: debitClabe,
      type: 'debito',
      note: bank.debitAccount?.note || bank.note,
      color: bank.color,
      logoUrl: bank.logoUrl,
      source: 'banks',
    });

    const creditClabe = normalizeClabe(bank.creditAccount?.paymentClabe);
    addOption(options, seenClabes, {
      id: `bank:${bank.id}:credit:${creditClabe}`,
      bankId: bank.id,
      name: bank.name || bank.id,
      clabe: creditClabe,
      type: 'credito',
      note: bank.creditAccount?.paymentClabeNote,
      color: bank.color,
      logoUrl: bank.logoUrl,
      source: 'banks',
    });
  });

  asConfigAccounts(bankAccountsConfig).forEach((account) => {
    const clabe = normalizeClabe(account.clabe);
    const type = normalizeType(account.type);
    const bankMeta = findBankMeta(banks, account.bank);
    const bankId = bankMeta?.id || slugify(account.bank);

    addOption(options, seenClabes, {
      id: `config:${bankId}:${type}:${clabe}`,
      bankId,
      name: account.bank || bankMeta?.name || 'Banco externo',
      clabe,
      type,
      note: account.note,
      color: bankMeta?.color,
      logoUrl: bankMeta?.logoUrl,
      source: 'config/bank-accounts',
    });
  });

  return options.sort((a, b) => a.name.localeCompare(b.name) || a.clabe.localeCompare(b.clabe));
}

export function resolveBankClabeOptionId({
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
