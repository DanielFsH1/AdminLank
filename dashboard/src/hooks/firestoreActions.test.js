import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDoc, mockGetDoc, mockUpdateDoc, mockRunTransaction, mockTransactionGet, mockTransactionUpdate } = vi.hoisted(() => ({
  mockDoc: vi.fn((...segments) => ({
    path: segments.filter((segment) => typeof segment === 'string').join('/'),
  })),
  mockGetDoc: vi.fn(),
  mockUpdateDoc: vi.fn(),
  mockRunTransaction: vi.fn(),
  mockTransactionGet: vi.fn(),
  mockTransactionUpdate: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
}));

vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  updateDoc: mockUpdateDoc,
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  deleteField: vi.fn(),
  arrayUnion: vi.fn(),
  Timestamp: {},
  getDoc: mockGetDoc,
  collection: vi.fn(),
  addDoc: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  getDocs: vi.fn(),
  limit: vi.fn(),
  writeBatch: vi.fn(),
  where: vi.fn(),
  runTransaction: mockRunTransaction,
}));

import { confirmRecurringExpense } from './firestoreActions';

function buildSnapshot(data) {
  return {
    exists: () => true,
    data: () => data,
  };
}

function getBankBalancePayload(callPayload) {
  if ('creditAccount.currentBalance' in callPayload) {
    return callPayload['creditAccount.currentBalance'];
  }

  return callPayload.creditAccount?.currentBalance;
}

function buildTransaction() {
  return {
    get: mockTransactionGet,
    update: mockTransactionUpdate,
  };
}

describe('confirmRecurringExpense', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T12:00:00Z'));
    vi.clearAllMocks();
    mockRunTransaction.mockImplementation(async (_db, handler) => handler(buildTransaction()));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('incrementa el saldo de la cuenta de crédito al confirmar un cobro ligado a tarjeta de crédito', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            entryId: 'recurring:card-1:charge-1:2026-04',
            status: 'pending',
            amount: 150,
            effectiveAt: '2026-04-25',
            cardId: 'card-1',
          }],
        });
      }

      if (ref.path === 'finance/overview') {
        return buildSnapshot({
          totals: {
            manualExpensesGross: 0,
            manualInvestmentsGross: 0,
            withdrawalCompletedGross: 1000,
            walletCreditsGross: 900,
          },
        });
      }

      if (ref.path === 'vault-cards/card-1') {
        return buildSnapshot({
          bankId: 'bank-1',
          accountType: 'credit',
        });
      }

      if (ref.path === 'banks/bank-1') {
        return buildSnapshot({
          creditAccount: {
            currentBalance: 400,
          },
        });
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await confirmRecurringExpense('recurring:card-1:charge-1:2026-04');

    const bankUpdateCall = mockTransactionUpdate.mock.calls.find(([ref]) => ref.path === 'banks/bank-1');

    expect(mockRunTransaction).toHaveBeenCalledTimes(1);
    expect(bankUpdateCall).toBeTruthy();
    expect(getBankBalancePayload(bankUpdateCall[1])).toBe(550);
  });

  it('no toca el saldo del banco cuando la tarjeta ligada no es de crédito', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            entryId: 'recurring:card-2:charge-1:2026-04',
            status: 'pending',
            amount: 200,
            effectiveAt: '2026-04-10',
            cardId: 'card-2',
          }],
        });
      }

      if (ref.path === 'finance/overview') {
        return buildSnapshot({
          totals: {
            manualExpensesGross: 0,
            manualInvestmentsGross: 0,
            withdrawalCompletedGross: 1000,
            walletCreditsGross: 900,
          },
        });
      }

      if (ref.path === 'vault-cards/card-2') {
        return buildSnapshot({
          bankId: 'bank-2',
          accountType: 'debit',
        });
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await confirmRecurringExpense('recurring:card-2:charge-1:2026-04');

    const bankUpdateCall = mockTransactionUpdate.mock.calls.find(([ref]) => ref.path === 'banks/bank-2');
    expect(bankUpdateCall).toBeUndefined();
  });

  it('falla cuando la tarjeta de crédito no tiene bankId', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            entryId: 'recurring:card-3:charge-1:2026-04',
            status: 'pending',
            amount: 200,
            effectiveAt: '2026-04-10',
            cardId: 'card-3',
          }],
        });
      }

      if (ref.path === 'finance/overview') {
        return buildSnapshot({
          totals: {
            manualExpensesGross: 0,
            manualInvestmentsGross: 0,
            withdrawalCompletedGross: 1000,
            walletCreditsGross: 900,
          },
        });
      }

      if (ref.path === 'vault-cards/card-3') {
        return buildSnapshot({
          accountType: 'credit',
        });
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await expect(confirmRecurringExpense('recurring:card-3:charge-1:2026-04')).rejects.toThrow('La tarjeta de crédito no tiene una cuenta bancaria vinculada');

    const bankUpdateCall = mockTransactionUpdate.mock.calls.find(([ref]) => ref.path.startsWith('banks/'));
    expect(bankUpdateCall).toBeUndefined();
  });

  it('no reconfirma un cobro ya confirmado', async () => {
    mockTransactionGet.mockResolvedValue(buildSnapshot({
      entries: [{
        entryId: 'recurring:card-4:charge-1:2026-04',
        status: 'confirmed',
        amount: 120,
        effectiveAt: '2026-04-10',
        cardId: 'card-4',
      }],
    }));

    await confirmRecurringExpense('recurring:card-4:charge-1:2026-04');

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
  });

  it('rechaza montos inválidos antes de confirmar el cobro', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            entryId: 'recurring:card-5:charge-1:2026-04',
            status: 'pending',
            amount: 150,
            effectiveAt: '2026-04-25',
            cardId: 'card-5',
          }],
        });
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await expect(confirmRecurringExpense('recurring:card-5:charge-1:2026-04', 0)).rejects.toThrow('Ingresa un monto válido mayor a cero');

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
  });

  it('falla cuando no existe el resumen financiero del mes', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            entryId: 'recurring:card-6:charge-1:2026-03',
            status: 'pending',
            amount: 150,
            effectiveAt: '2026-03-25',
            cardId: 'card-6',
          }],
        });
      }

      if (ref.path === 'finance/monthly-2026-03') {
        return {
          exists: () => false,
          data: () => null,
        };
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await expect(confirmRecurringExpense('recurring:card-6:charge-1:2026-03')).rejects.toThrow('No existe el resumen financiero del mes 2026-03');

    expect(mockTransactionUpdate).not.toHaveBeenCalled();
  });

  it('permite confirmar un cobro legacy identificado por su huella estable', async () => {
    mockTransactionGet.mockImplementation(async (ref) => {
      if (ref.path === 'finance/manual-ledger') {
        return buildSnapshot({
          entries: [{
            status: 'pending',
            type: 'expense',
            description: 'Netflix',
            amount: 219,
            effectiveAt: '2026-04-25',
            subscription: 'netflix',
            cardId: 'card-7',
          }],
        });
      }

      if (ref.path === 'finance/overview') {
        return buildSnapshot({
          totals: {
            manualExpensesGross: 0,
            manualInvestmentsGross: 0,
            withdrawalCompletedGross: 1000,
            walletCreditsGross: 900,
          },
        });
      }

      if (ref.path === 'vault-cards/card-7') {
        return buildSnapshot({
          accountType: 'debit',
          bankId: 'bank-7',
        });
      }

      throw new Error(`Unexpected transaction.get for ${ref.path}`);
    });

    await confirmRecurringExpense('legacy|expense|2026-04-25|Netflix|219|netflix||card-7|pending');

    const ledgerUpdateCall = mockTransactionUpdate.mock.calls.find(([ref]) => ref.path === 'finance/manual-ledger');
    expect(ledgerUpdateCall).toBeTruthy();
    expect(ledgerUpdateCall[1].entries[0].status).toBe('confirmed');
  });
});
