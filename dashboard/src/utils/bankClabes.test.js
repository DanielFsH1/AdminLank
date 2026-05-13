import { describe, expect, it } from 'vitest';
import { buildBankClabeOptions, resolveBankClabeOptionId } from './bankClabes';

const banks = [
  {
    id: 'bbva',
    name: 'BBVA',
    color: '#004481',
    logoUrl: '/bbva.png',
    debitAccount: { clabe: '012 345 678 901 234 567', note: 'principal' },
  },
  {
    id: 'nu',
    name: 'Nu',
    color: '#7c3aed',
    logoUrl: '/nu.png',
    creditAccount: { paymentClabe: '999999999999999999', paymentClabeNote: 'solo pago' },
  },
];

describe('buildBankClabeOptions', () => {
  it('incluye CLABEs de debito y credito desde banks con metadatos visuales', () => {
    const options = buildBankClabeOptions({ banks, bankAccountsConfig: null });

    expect(options.map(option => option.clabe)).toEqual([
      '012345678901234567',
      '999999999999999999',
    ]);
    expect(options.find(option => option.clabe === '999999999999999999')).toEqual(expect.objectContaining({
      id: 'bank:nu:credit:999999999999999999',
      bankId: 'nu',
      name: 'Nu',
      type: 'credito',
      note: 'solo pago',
      color: '#7c3aed',
      logoUrl: '/nu.png',
    }));
  });

  it('incluye todas las CLABEs externas de config/bank-accounts sin excluir credito', () => {
    const options = buildBankClabeOptions({
      banks,
      bankAccountsConfig: {
        accounts: [
          { bank: 'BBVA Nomina', clabe: '111111111111111111', type: 'debito', note: 'nomina' },
          { bank: 'BBVA Credito', clabe: '222222222222222222', type: 'credito', note: 'pago tarjeta' },
          { bank: 'Santander', clabe: '333333333333333333', type: 'debito', note: 'extra' },
        ],
      },
    });

    expect(options.map(option => option.clabe)).toEqual([
      '012345678901234567',
      '222222222222222222',
      '111111111111111111',
      '999999999999999999',
      '333333333333333333',
    ]);
    expect(options.find(option => option.clabe === '222222222222222222')).toEqual(expect.objectContaining({
      bankId: 'bbva',
      name: 'BBVA Credito',
      type: 'credito',
      logoUrl: '/bbva.png',
    }));
  });

  it('deduplica por CLABE normalizada conservando banks como fuente primaria', () => {
    const options = buildBankClabeOptions({
      banks,
      bankAccountsConfig: {
        accounts: [
          { bank: 'BBVA', clabe: '012345678901234567', type: 'debito', note: 'duplicada' },
        ],
      },
    });

    expect(options.filter(option => option.clabe === '012345678901234567')).toHaveLength(1);
    expect(options.find(option => option.clabe === '012345678901234567')).toEqual(expect.objectContaining({
      source: 'banks',
      note: 'principal',
    }));
  });

  it('resuelve una opcion existente por id guardado o por CLABE', () => {
    const options = buildBankClabeOptions({ banks, bankAccountsConfig: null });

    expect(resolveBankClabeOptionId({
      options,
      destinationBankAccountId: 'bank:nu:credit:999999999999999999',
    })).toBe('bank:nu:credit:999999999999999999');

    expect(resolveBankClabeOptionId({
      options,
      destinationBankId: 'nu',
      destinationClabe: '999999999999999999',
    })).toBe('bank:nu:credit:999999999999999999');
  });
});
