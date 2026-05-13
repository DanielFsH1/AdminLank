import { describe, expect, it } from 'vitest';
import { buildSnowballBankOptions, resolveSnowballBankOptionId } from './snowballBanks';

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

describe('buildSnowballBankOptions', () => {
  it('incluye CLABEs de retiro de banks con metadatos visuales', () => {
    const options = buildSnowballBankOptions({ banks, bankAccountsConfig: null });

    expect(options).toEqual([
      expect.objectContaining({
        id: 'bank:bbva:012345678901234567',
        bankId: 'bbva',
        name: 'BBVA',
        clabe: '012345678901234567',
        note: 'principal',
        color: '#004481',
        logoUrl: '/bbva.png',
      }),
    ]);
  });

  it('agrega todas las CLABEs externas no credito desde config/bank-accounts', () => {
    const options = buildSnowballBankOptions({
      banks,
      bankAccountsConfig: {
        accounts: [
          { bank: 'BBVA Nómina', clabe: '111111111111111111', type: 'debito', note: 'nomina' },
          { bank: 'BBVA Crédito', clabe: '222222222222222222', type: 'credito', note: 'pago tarjeta' },
          { bank: 'Santander', clabe: '333333333333333333', type: 'debito', note: 'extra' },
        ],
      },
    });

    expect(options.map(option => option.clabe)).toEqual([
      '012345678901234567',
      '111111111111111111',
      '333333333333333333',
    ]);
    expect(options.find(option => option.clabe === '111111111111111111')).toEqual(expect.objectContaining({
      bankId: 'bbva',
      name: 'BBVA Nómina',
      logoUrl: '/bbva.png',
    }));
  });

  it('resuelve una conexión existente por id guardado o por CLABE', () => {
    const options = buildSnowballBankOptions({ banks, bankAccountsConfig: null });

    expect(resolveSnowballBankOptionId({
      options,
      destinationBankAccountId: 'bank:bbva:012345678901234567',
    })).toBe('bank:bbva:012345678901234567');

    expect(resolveSnowballBankOptionId({
      options,
      destinationBankId: 'bbva',
      destinationClabe: '012345678901234567',
    })).toBe('bank:bbva:012345678901234567');
  });
});
