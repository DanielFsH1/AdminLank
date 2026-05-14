import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDoc, mockGetDoc, mockGetDocs, mockSetDoc, mockUpdateDoc, mockDeleteDoc, mockRunTransaction, mockTransactionGet, mockTransactionUpdate } = vi.hoisted(() => ({
  mockDoc: vi.fn((...segments) => ({
    path: segments.filter((segment) => typeof segment === 'string').join('/'),
  })),
  mockGetDoc: vi.fn(),
  mockGetDocs: vi.fn(),
  mockSetDoc: vi.fn(),
  mockUpdateDoc: vi.fn(),
  mockDeleteDoc: vi.fn(),
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
  setDoc: mockSetDoc,
  deleteDoc: mockDeleteDoc,
  deleteField: vi.fn(),
  arrayUnion: vi.fn(),
  Timestamp: {},
  getDoc: mockGetDoc,
  collection: vi.fn(),
  addDoc: vi.fn(),
  query: vi.fn(),
  orderBy: vi.fn(),
  getDocs: mockGetDocs,
  limit: vi.fn(),
  writeBatch: vi.fn(),
  where: vi.fn(),
  runTransaction: mockRunTransaction,
}));

import {
  cancelScheduledManualAlert,
  confirmRecurringExpense,
  createVaultPaypalAccount,
  deleteVaultEmailAccount,
  createSlotDeletionAlert,
  createScheduledManualAlert,
  validateSnowballConfig,
} from './firestoreActions';

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

describe('validateSnowballConfig', () => {
  it('rechaza que varias cuentas apunten a la misma cuenta Lank activa', () => {
    const config = {
      wallets: {
        1: { accountId: '1', walletClabe: '646180111111111111', active: true },
        2: { accountId: '2', walletClabe: '646180222222222222', active: true },
        3: { accountId: '3', walletClabe: '646180333333333333', active: true },
      },
      connections: {
        a: { fromAccountId: '1', destinationType: 'lank_wallet', toAccountId: '3', destinationClabe: '646180333333333333', active: true },
        b: { fromAccountId: '2', destinationType: 'lank_wallet', toAccountId: '3', destinationClabe: '646180333333333333', active: true },
      },
    };

    expect(() => validateSnowballConfig(config)).toThrow('solo puede recibir una conexión activa');
  });

  it('rechaza ciclos en conexiones internas activas', () => {
    const config = {
      wallets: {
        1: { accountId: '1', walletClabe: '646180111111111111', active: true },
        2: { accountId: '2', walletClabe: '646180222222222222', active: true },
      },
      connections: {
        a: { fromAccountId: '1', destinationType: 'lank_wallet', toAccountId: '2', destinationClabe: '646180222222222222', active: true },
        b: { fromAccountId: '2', destinationType: 'lank_wallet', toAccountId: '1', destinationClabe: '646180111111111111', active: true },
      },
    };

    expect(() => validateSnowballConfig(config)).toThrow('ciclo');
  });

  it('rechaza usar la misma CLABE bancaria externa como destino activo más de una vez', () => {
    const config = {
      wallets: {},
      connections: {
        a: {
          fromAccountId: '1',
          destinationType: 'external_bank',
          destinationBankId: 'bank-1',
          destinationClabe: '012 345 678 901 234 567',
          active: true,
        },
        b: {
          fromAccountId: '2',
          destinationType: 'external_bank',
          destinationBankId: 'bank-1',
          destinationClabe: '012345678901234567',
          active: true,
        },
      },
    };

    expect(() => validateSnowballConfig(config)).toThrow('solo puede usarse como destino una vez');
  });
});

describe('scheduled manual alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a scheduled manual alert with future date and scheduled status', async () => {
    const scheduledId = await createScheduledManualAlert({
      title: 'Llamar al banco',
      note: 'Confirmar cargo pendiente',
      scheduledDate: '2026-05-10',
      priority: 'high',
    });

    expect(scheduledId).toMatch(/^scheduled_manual_/);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [ref, payload] = mockSetDoc.mock.calls[0];
    expect(ref.path).toBe(`scheduled-alerts/${scheduledId}`);
    expect(payload.title).toBe('Llamar al banco');
    expect(payload.note).toBe('Confirmar cargo pendiente');
    expect(payload.scheduledDate).toBe('2026-05-10');
    expect(payload.priority).toBe('high');
    expect(payload.status).toBe('scheduled');
    expect(payload.source).toBe('scheduled_manual_alert');
    expect(payload.createdBy).toBe('manual_user');
    expect(payload.generatedAlertId).toBe(null);
    expect(payload.generatedAt).toBe(null);
    expect(payload.cancelledAt).toBe(null);
    expect(payload.createdAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('rejects a scheduled manual alert without future date', async () => {
    await expect(createScheduledManualAlert({
      title: 'Llamar al banco',
      note: '',
      scheduledDate: '',
      priority: 'high',
    })).rejects.toThrow('Debes elegir una fecha futura válida');

    await expect(createScheduledManualAlert({
      title: 'Llamar al banco',
      note: '',
      scheduledDate: '2026-05-01',
      priority: 'high',
    })).rejects.toThrow('Debes elegir una fecha futura válida');

    await expect(createScheduledManualAlert({
      title: 'Llamar al banco',
      note: '',
      scheduledDate: '2026-02-31',
      priority: 'high',
    })).rejects.toThrow('Debes elegir una fecha futura válida');
  });

  it('rejects a scheduled manual alert without title or valid priority', async () => {
    await expect(createScheduledManualAlert({
      title: '   ',
      note: '',
      scheduledDate: '2026-05-10',
      priority: 'high',
    })).rejects.toThrow('Debes escribir un título');

    await expect(createScheduledManualAlert({
      title: 'Llamar al banco',
      note: '',
      scheduledDate: '2026-05-10',
      priority: 'urgent',
    })).rejects.toThrow('Debes elegir una prioridad válida');
  });

  it('cancels a scheduled manual alert without deleting the document', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        title: 'Pagar factura',
        status: 'scheduled',
        scheduledDate: '2026-05-15',
      }),
    });

    await cancelScheduledManualAlert('scheduled_manual_1');

    expect(mockGetDoc).toHaveBeenCalledTimes(1);
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    const [ref, payload] = mockUpdateDoc.mock.calls[0];
    expect(ref.path).toBe('scheduled-alerts/scheduled_manual_1');
    expect(payload.status).toBe('cancelled');
    expect(payload.cancelledAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('rejects cancellation when the scheduled alert does not exist or is not pending', async () => {
    mockGetDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => null,
    });

    await expect(cancelScheduledManualAlert('scheduled_manual_missing')).rejects.toThrow('La alerta programada no existe');
    expect(mockUpdateDoc).not.toHaveBeenCalled();

    mockGetDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        title: 'Pagar factura',
        status: 'generated',
      }),
    });

    await expect(cancelScheduledManualAlert('scheduled_manual_generated')).rejects.toThrow('Solo puedes cancelar alertas programadas pendientes');
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });
});

describe('vault PayPal accounts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects PayPal creation without a linked principal Lank account', async () => {
    await expect(createVaultPaypalAccount({
      email: 'paypal@example.com',
      password: 'secret',
    })).rejects.toThrow('Selecciona una cuenta principal para vincular PayPal');

    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('rejects PayPal creation when the linked principal does not exist', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => false,
      data: () => null,
    });

    await expect(createVaultPaypalAccount({
      lankAccountId: '12',
      email: 'paypal@example.com',
      password: 'secret',
    })).rejects.toThrow('La cuenta principal vinculada no existe');

    expect(mockGetDoc).toHaveBeenCalledWith(expect.objectContaining({ path: 'secrets/lank_google_12' }));
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('creates PayPal credentials only when linked to an existing principal account', async () => {
    mockGetDoc
      .mockResolvedValueOnce(buildSnapshot({
        type: 'lank_google',
        lankAccountId: '12',
        email: 'principal@gmail.com',
        canonicalAlias: 'Cuenta Principal',
        fullName: 'Cuenta Principal',
      }))
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => null,
      });

    const docId = await createVaultPaypalAccount({
      lankAccountId: '12',
      email: 'paypal@example.com',
      password: 'paypal-secret',
      notes: 'Pagos',
    });

    expect(docId).toBe('paypal_12_paypal_example_com');
    expect(mockSetDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'secrets/paypal_12_paypal_example_com' }),
      expect.objectContaining({
        type: 'paypal',
        email: 'paypal@example.com',
        lankAccountId: '12',
        principalEmail: 'principal@gmail.com',
        principalAlias: 'Cuenta Principal',
        notes: 'Pagos',
        createdAt: '2026-05-09T12:00:00.000Z',
        updatedAt: '2026-05-09T12:00:00.000Z',
      }),
    );
    const payload = mockSetDoc.mock.calls[0][1];
    expect(payload.password).toBeTruthy();
    expect(payload.password).not.toBe('paypal-secret');
  });

  it('blocks deletion of a principal account while PayPal accounts are linked', async () => {
    mockGetDoc.mockResolvedValue(buildSnapshot({
      type: 'lank_google',
      lankAccountId: '12',
      email: 'principal@gmail.com',
    }));
    mockGetDocs.mockResolvedValue({
      docs: [
        {
          id: 'paypal_12_paypal_example_com',
          data: () => ({
            type: 'paypal',
            lankAccountId: '12',
            email: 'paypal@example.com',
          }),
        },
      ],
    });

    await expect(deleteVaultEmailAccount('lank_google_12')).rejects.toThrow('No puedes eliminar esta cuenta principal porque tiene PayPal vinculado: paypal@example.com');

    expect(mockDeleteDoc).not.toHaveBeenCalled();
  });

  it('allows deletion of a principal account when no PayPal accounts are linked', async () => {
    mockGetDoc
      .mockResolvedValueOnce(buildSnapshot({
        type: 'lank_google',
        lankAccountId: '12',
        email: 'principal@gmail.com',
      }))
      .mockResolvedValueOnce({
        exists: () => false,
        data: () => null,
      });
    mockGetDocs.mockResolvedValue({ docs: [] });

    await deleteVaultEmailAccount('lank_google_12');

    expect(mockDeleteDoc).toHaveBeenCalledWith(expect.objectContaining({ path: 'secrets/lank_google_12' }));
  });
});

describe('slot deletion alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a pending slot deletion alert with slot metadata and visible reason', async () => {
    const alertId = await createSlotDeletionAlert({
      service: 'ChatGPT Plus',
      accountId: '28',
      accountAlias: 'Daniel',
      userAlias: 'Alan',
      serviceAccountRef: 'chatgpt_2',
      realAccountEmail: 'pool@example.com',
      slotNumber: 1,
      reason: 'Dado de baja del grupo 28',
      source: 'user_removal',
    });

    expect(alertId).toMatch(/^manual_/);
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    const [ref, payload] = mockSetDoc.mock.calls[0];
    expect(ref.path).toBe(`alerts/${alertId}`);
    expect(payload.type).toBe('slot_pending_deletion');
    expect(payload.status).toBe('pending');
    expect(payload.priority).toBe('high');
    expect(payload.serviceAccountRef).toBe('chatgpt_2');
    expect(payload.slotNumber).toBe(1);
    expect(payload.reason).toBe('Dado de baja del grupo 28');
    expect(payload.dependsOn).toBe(null);
    expect(payload.createdAt).toBe('2026-05-05T12:00:00.000Z');
  });
});
