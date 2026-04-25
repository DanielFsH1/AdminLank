import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDoc, mockGetDoc, mockUpdateDoc } = vi.hoisted(() => ({
  mockDoc: vi.fn((...segments) => ({ path: segments.join('/') })),
  mockGetDoc: vi.fn(),
  mockUpdateDoc: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  storage: {},
}));

vi.mock('../config/services', () => ({
  BANKS: {},
}));

vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  uploadBytes: vi.fn(),
  getDownloadURL: vi.fn(),
  deleteObject: vi.fn(),
  listAll: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  updateDoc: mockUpdateDoc,
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDoc: mockGetDoc,
  collection: vi.fn(),
  getDocs: vi.fn(),
  writeBatch: vi.fn(),
}));

import { updateCreditAccount } from './bankActions';

function buildCreditAccount(overrides = {}) {
  return {
    creditLimit: 5000,
    currentBalance: 2000,
    annualRate: 35,
    minimumPayment: 450,
    cutoffDay: 12,
    paymentDueDay: 25,
    alertDaysBefore: 3,
    paymentClabe: '123456789012345678',
    paymentClabeNote: 'pago',
    ...overrides,
  };
}

describe('updateCreditAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persiste ceros en los campos numéricos de crédito', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ creditAccount: buildCreditAccount() }),
    });

    await updateCreditAccount('nu', {
      creditLimit: '0',
      currentBalance: '0',
      annualRate: '0',
      minimumPayment: '0',
    });

    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    const payload = mockUpdateDoc.mock.calls[0][1];

    expect(payload.creditAccount).toEqual(expect.objectContaining({
      creditLimit: 0,
      currentBalance: 0,
      annualRate: 0,
      minimumPayment: 0,
    }));
  });

  it('conserva valores previos cuando el campo numérico no viene informado', async () => {
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ creditAccount: buildCreditAccount() }),
    });

    await updateCreditAccount('nu', {
      creditLimit: '',
      currentBalance: undefined,
      annualRate: null,
      minimumPayment: '',
    });

    const payload = mockUpdateDoc.mock.calls[0][1];

    expect(payload.creditAccount).toEqual(expect.objectContaining({
      creditLimit: 5000,
      currentBalance: 2000,
      annualRate: 35,
      minimumPayment: 450,
    }));
  });
});
