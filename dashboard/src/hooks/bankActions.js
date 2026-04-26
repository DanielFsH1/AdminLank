/**
 * Bank CRUD operations for the Bóveda → Bancos system.
 * Each bank lives as its own document in the `banks` collection.
 */
import { doc, updateDoc, setDoc, deleteDoc, getDoc as firestoreGetDoc, collection, getDocs, writeBatch } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject, listAll } from 'firebase/storage';
import { db, storage } from '../firebase';
import { BANKS } from '../config/services';

function nowISO() {
  return new Date().toISOString();
}

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseOptionalFloat(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseOptionalInt(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ─── BANK CRUD ─────────────────────────────────────────────────────

export async function createBank({ name, color, logoUrl, clabe, note }) {
  const bankId = slugify(name) || `bank_${Date.now()}`;
  const ref_ = doc(db, 'banks', bankId);
  const existing = await firestoreGetDoc(ref_);
  if (existing.exists()) throw new Error(`Ya existe un banco con el ID "${bankId}".`);

  const bankData = {
    name: name.trim(),
    color: color || '#64748b',
    logoUrl: logoUrl || '',
    order: Date.now(),
    debitAccount: { clabe: (clabe || '').trim(), note: (note || '').trim() },
    creditAccount: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  await setDoc(ref_, bankData);
  syncBankAccountsConfig().catch(() => {});
  return { id: bankId, ...bankData };
}

export async function updateBank(bankId, updates) {
  const ref_ = doc(db, 'banks', bankId);
  await updateDoc(ref_, { ...updates, updatedAt: nowISO() });
  if (updates.name) await cascadeBankRename(bankId, updates.name);
  syncBankAccountsConfig().catch(() => {});
}

export async function deleteBank(bankId) {
  const cardsSnap = await getDocs(collection(db, 'vault-cards'));
  const linkedCards = [];
  cardsSnap.docs.forEach(d => {
    const data = d.data();
    if (data.bankId === bankId) linkedCards.push({ id: d.id, ...data });
  });

  const hasRecurring = linkedCards.some(c => (c.recurringCharges || []).some(rc => rc.active));
  if (hasRecurring) {
    throw new Error('Este banco tiene tarjetas con cobros recurrentes activos. Desactívalos primero.');
  }

  const batch = writeBatch(db);
  linkedCards.forEach(card => {
    batch.update(doc(db, 'vault-cards', card.id), { bankId: '', accountType: '', updatedAt: nowISO() });
  });
  batch.delete(doc(db, 'banks', bankId));
  await batch.commit();
  syncBankAccountsConfig().catch(() => {});
  return { deletedCards: linkedCards.length };
}

// ─── DEBIT ACCOUNT ─────────────────────────────────────────────────

export async function updateDebitAccount(bankId, { clabe, note }) {
  const ref_ = doc(db, 'banks', bankId);
  await updateDoc(ref_, {
    'debitAccount.clabe': (clabe || '').trim(),
    'debitAccount.note': (note || '').trim(),
    updatedAt: nowISO(),
  });
  syncBankAccountsConfig().catch(() => {});
}

// ─── CREDIT ACCOUNT ────────────────────────────────────────────────

export async function createCreditAccount(bankId, creditData) {
  const ref_ = doc(db, 'banks', bankId);
  const snap = await firestoreGetDoc(ref_);
  if (!snap.exists()) throw new Error('Banco no encontrado.');
  if (snap.data().creditAccount) throw new Error('Este banco ya tiene una cuenta de crédito.');

  const credit = {
    creditLimit: parseFloat(creditData.creditLimit) || 0,
    currentBalance: parseFloat(creditData.currentBalance) || 0,
    annualRate: parseFloat(creditData.annualRate) || 0,
    minimumPayment: parseFloat(creditData.minimumPayment) || 0,
    cutoffDay: parseInt(creditData.cutoffDay, 10) || 1,
    paymentDueDay: parseInt(creditData.paymentDueDay, 10) || 15,
    alertDaysBefore: parseInt(creditData.alertDaysBefore, 10) || 1,
    paymentClabe: creditData.paymentClabe || '',
    paymentClabeNote: creditData.paymentClabeNote || '',
    installments: [],
    monthlyStatements: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  await updateDoc(ref_, { creditAccount: credit, updatedAt: nowISO() });
  syncBankAccountsConfig().catch(() => {});
  return credit;
}

export async function updateCreditAccount(bankId, creditData) {
  const ref_ = doc(db, 'banks', bankId);
  const snap = await firestoreGetDoc(ref_);
  if (!snap.exists()) throw new Error('Banco no encontrado.');
  const current = snap.data().creditAccount;
  if (!current) throw new Error('Este banco no tiene cuenta de crédito.');

  const updated = {
    ...current,
    creditLimit: parseOptionalFloat(creditData.creditLimit, current.creditLimit),
    currentBalance: parseOptionalFloat(creditData.currentBalance, current.currentBalance),
    annualRate: parseOptionalFloat(creditData.annualRate, current.annualRate),
    minimumPayment: parseOptionalFloat(creditData.minimumPayment, current.minimumPayment),
    cutoffDay: parseOptionalInt(creditData.cutoffDay, current.cutoffDay),
    paymentDueDay: parseOptionalInt(creditData.paymentDueDay, current.paymentDueDay),
    alertDaysBefore: parseOptionalInt(creditData.alertDaysBefore, current.alertDaysBefore),
    paymentClabe: creditData.paymentClabe ?? current.paymentClabe ?? '',
    paymentClabeNote: creditData.paymentClabeNote ?? current.paymentClabeNote ?? '',
    updatedAt: nowISO(),
  };
  await updateDoc(ref_, { creditAccount: updated, updatedAt: nowISO() });
  syncBankAccountsConfig().catch(() => {});
  return updated;
}

export async function deleteCreditAccount(bankId) {
  const cardsSnap = await getDocs(collection(db, 'vault-cards'));
  const creditCards = [];
  cardsSnap.docs.forEach(d => {
    const data = d.data();
    if (data.bankId === bankId && data.accountType === 'credit') creditCards.push(d.id);
  });

  const batch = writeBatch(db);
  creditCards.forEach(cardId => {
    batch.update(doc(db, 'vault-cards', cardId), { bankId: '', accountType: '', updatedAt: nowISO() });
  });
  batch.update(doc(db, 'banks', bankId), { creditAccount: null, updatedAt: nowISO() });
  await batch.commit();
  syncBankAccountsConfig().catch(() => {});
}

export async function addCreditInstallment(bankId, installment) {
  const ref_ = doc(db, 'banks', bankId);
  const snap = await firestoreGetDoc(ref_);
  if (!snap.exists()) throw new Error('Banco no encontrado.');
  const credit = snap.data().creditAccount;
  if (!credit) throw new Error('No hay cuenta de crédito.');

  const inst = {
    ...installment,
    id: installment.id || `msi_${Date.now()}`,
    status: installment.status || 'active',
    createdAt: nowISO(),
  };
  const installments = [...(credit.installments || []), inst];
  await updateDoc(ref_, {
    'creditAccount.installments': installments,
    'creditAccount.updatedAt': nowISO(),
    updatedAt: nowISO(),
  });
  return inst;
}

export async function removeCreditInstallment(bankId, installmentId) {
  const ref_ = doc(db, 'banks', bankId);
  const snap = await firestoreGetDoc(ref_);
  if (!snap.exists()) return;
  const credit = snap.data().creditAccount;
  if (!credit) return;

  const installments = (credit.installments || []).filter(i => i.id !== installmentId);
  await updateDoc(ref_, {
    'creditAccount.installments': installments,
    'creditAccount.updatedAt': nowISO(),
    updatedAt: nowISO(),
  });
}

export async function saveCreditStatement(bankId, statement) {
  const ref_ = doc(db, 'banks', bankId);
  const snap = await firestoreGetDoc(ref_);
  if (!snap.exists()) throw new Error('Banco no encontrado.');
  const credit = snap.data().creditAccount;
  if (!credit) throw new Error('No hay cuenta de crédito.');

  const statements = [...(credit.monthlyStatements || [])];
  const idx = statements.findIndex(s => s.monthKey === statement.monthKey);
  if (idx >= 0) {
    statements[idx] = { ...statements[idx], ...statement, updatedAt: nowISO() };
  } else {
    statements.push({ ...statement, createdAt: nowISO() });
  }
  await updateDoc(ref_, {
    'creditAccount.monthlyStatements': statements,
    'creditAccount.updatedAt': nowISO(),
    updatedAt: nowISO(),
  });
}

// ─── CARD ↔ BANK LINKING ──────────────────────────────────────────

export async function linkCardToBank(cardId, bankId, accountType) {
  const ref_ = doc(db, 'vault-cards', cardId);
  await updateDoc(ref_, { bankId, accountType, updatedAt: nowISO() });
}

export async function unlinkCardFromBank(cardId) {
  const ref_ = doc(db, 'vault-cards', cardId);
  await updateDoc(ref_, { bankId: '', accountType: '', updatedAt: nowISO() });
}

// ─── LOGO GALLERY ──────────────────────────────────────────────────

export async function getLogoGallery() {
  const defaultLogos = Object.entries(BANKS).reduce((acc, [name, meta]) => {
    if (meta.logo && !acc.some(l => l.url === meta.logo)) {
      acc.push({ id: `default_${slugify(name)}`, name, url: meta.logo, isDefault: true });
    }
    return acc;
  }, []);

  const configRef = doc(db, 'config', 'bank-logos');
  const snap = await firestoreGetDoc(configRef);
  const uploaded = snap.exists() ? (snap.data().logos || []) : [];

  return [...defaultLogos, ...uploaded.map(l => ({ ...l, isDefault: false }))];
}

export async function uploadBankLogo(file, displayName) {
  const ext = file.name.split('.').pop();
  const safeName = (displayName || file.name).replace(/[^a-zA-Z0-9]/g, '_');
  const ts = Date.now();
  const storageRef = ref(storage, `bank-logos/${safeName}_${ts}.${ext}`);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);

  const logo = { id: `logo_${ts}`, name: displayName || file.name, url, storagePath: `bank-logos/${safeName}_${ts}.${ext}`, uploadedAt: nowISO() };

  const configRef = doc(db, 'config', 'bank-logos');
  const snap = await firestoreGetDoc(configRef);
  const logos = snap.exists() ? (snap.data().logos || []) : [];
  logos.push(logo);
  if (snap.exists()) {
    await updateDoc(configRef, { logos });
  } else {
    await setDoc(configRef, { logos });
  }
  return logo;
}

export async function deleteBankLogo(logoId) {
  const configRef = doc(db, 'config', 'bank-logos');
  const snap = await firestoreGetDoc(configRef);
  if (!snap.exists()) return;
  const logos = snap.data().logos || [];
  const logo = logos.find(l => l.id === logoId);
  if (!logo) return;

  if (logo.storagePath) {
    try { await deleteObject(ref(storage, logo.storagePath)); } catch (e) { /* ignore */ }
  }
  await updateDoc(configRef, { logos: logos.filter(l => l.id !== logoId) });
}

// ─── SYNC config/bank-accounts ─────────────────────────────────────

export async function syncBankAccountsConfig() {
  const banksSnap = await getDocs(collection(db, 'banks'));
  const accounts = [];

  banksSnap.docs.forEach((d) => {
    const bank = d.data();
    if (bank.debitAccount?.clabe) {
      accounts.push({
        bank: bank.name,
        clabe: bank.debitAccount.clabe,
        type: 'debito',
        note: bank.debitAccount.note || '',
      });
    }
    if (bank.creditAccount?.paymentClabe) {
      accounts.push({
        bank: `${bank.name} Crédito`,
        clabe: bank.creditAccount.paymentClabe,
        type: 'credito',
        note: bank.creditAccount.paymentClabeNote || '',
      });
    }
  });

  await setDoc(doc(db, 'config', 'bank-accounts'), { accounts, updatedAt: nowISO() });
}

// ─── CASCADE: rename bank across vault-cards ───────────────────────

async function cascadeBankRename(bankId, newName) {
  const cardsSnap = await getDocs(collection(db, 'vault-cards'));
  const batch = writeBatch(db);
  let updated = 0;

  cardsSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.bankId !== bankId) return;
    const expectedName = data.accountType === 'credit' ? `${newName} Crédito` : newName;
    if (data.bank !== expectedName) {
      batch.update(doc(db, 'vault-cards', d.id), { bank: expectedName, updatedAt: nowISO() });
      updated++;
    }
  });

  if (updated > 0) await batch.commit();
  return updated;
}

// ─── MIGRATION ─────────────────────────────────────────────────────

export async function migrateExistingBanks() {
  const banksSnap = await getDocs(collection(db, 'banks'));
  if (banksSnap.docs.length > 0) return { migrated: 0, reason: 'already_migrated' };

  const clabeSnap = await firestoreGetDoc(doc(db, 'finance', 'bank-clabes'));
  const clabes = clabeSnap.exists() ? (clabeSnap.data().accounts || []) : [];

  const creditSnap = await firestoreGetDoc(doc(db, 'finance', 'credit-accounts'));
  const creditAccounts = creditSnap.exists() ? (creditSnap.data().accounts || []) : [];

  const bankAccSnap = await firestoreGetDoc(doc(db, 'finance', 'bank-accounts'));
  const customBanks = bankAccSnap.exists() ? (bankAccSnap.data().accounts || {}) : {};

  const bankMap = {};

  Object.entries(BANKS).forEach(([name, meta]) => {
    const baseName = name.replace(/ Crédito$| Débito$/, '').trim();
    const id = slugify(baseName);
    if (!bankMap[id]) {
      bankMap[id] = { name: baseName, color: meta.color, logoUrl: meta.logo, debitAccount: { clabe: '', note: '' }, creditAccount: null };
    }
  });

  Object.entries(customBanks).forEach(([name, meta]) => {
    const id = slugify(name);
    if (!bankMap[id]) {
      bankMap[id] = { name, color: meta.color || '#64748b', logoUrl: meta.logo || meta.logoUrl || '', debitAccount: { clabe: '', note: '' }, creditAccount: null };
    }
  });

  clabes.forEach(c => {
    const id = slugify(c.bank);
    if (!bankMap[id]) {
      bankMap[id] = { name: c.bank, color: '#64748b', logoUrl: '', debitAccount: { clabe: '', note: '' }, creditAccount: null };
    }
    if (!bankMap[id].debitAccount.clabe && c.type !== 'credito') {
      bankMap[id].debitAccount = { clabe: c.clabe || '', note: c.note || '' };
    }
  });

  creditAccounts.forEach(ca => {
    const baseName = (ca.bank || '').replace(/ Crédito$/, '').trim();
    const id = slugify(baseName);
    if (!bankMap[id]) {
      bankMap[id] = { name: baseName, color: '#64748b', logoUrl: '', debitAccount: { clabe: '', note: '' }, creditAccount: null };
    }
    bankMap[id].creditAccount = {
      creditLimit: ca.creditLimit || 0,
      currentBalance: ca.currentBalance || 0,
      annualRate: ca.annualRate || 0,
      minimumPayment: ca.minimumPayment || 0,
      cutoffDay: ca.cutoffDay || 1,
      paymentDueDay: ca.paymentDueDay || 15,
      alertDaysBefore: ca.alertDaysBefore || 1,
      installments: ca.installments || [],
      monthlyStatements: ca.monthlyStatements || [],
      createdAt: ca.createdAt || nowISO(),
      updatedAt: ca.updatedAt || nowISO(),
    };
  });

  const cardsSnap = await getDocs(collection(db, 'vault-cards'));
  const cardBankUpdates = [];

  const batch = writeBatch(db);
  let order = 0;
  Object.entries(bankMap).forEach(([id, bank]) => {
    batch.set(doc(db, 'banks', id), {
      ...bank,
      order: order++,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  });

  cardsSnap.docs.forEach(d => {
    const data = d.data();
    const cardBank = (data.bank || '').replace(/ Crédito$| Débito$/, '').trim();
    const bankId = slugify(cardBank);
    if (bankMap[bankId] && !data.bankId) {
      const hasCredit = bankMap[bankId].creditAccount != null;
      const bankName = data.bank || '';
      const isCredit = bankName.toLowerCase().includes('crédit') || bankName.toLowerCase().includes('credit');
      const accountType = isCredit && hasCredit ? 'credit' : 'debit';
      batch.update(doc(db, 'vault-cards', d.id), { bankId, accountType, updatedAt: nowISO() });
      cardBankUpdates.push(d.id);
    }
  });

  await batch.commit();
  return { migrated: Object.keys(bankMap).length, cardsLinked: cardBankUpdates.length };
}
