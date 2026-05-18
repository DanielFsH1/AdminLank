import { describe, expect, it } from 'vitest';
import {
  UNCLASSIFIED_DESTINATION_LABEL,
  isOperationalExternalBankLabel,
  resolveWithdrawalDestinationLabel,
} from './financeWithdrawalDestination';

const accounts = [
  { id: '14', canonicalAlias: 'Fática Cáceres' },
  { id: '32', canonicalAlias: 'Ezequiel Chico' },
];

const snowballConfig = {
  wallets: {
    14: { accountId: '14', accountAlias: 'Fática Cáceres', walletClabe: '646180141414141414', active: true },
    32: { accountId: '32', accountAlias: 'Ezequiel Chico', walletClabe: '646180323232323232', active: true },
  },
  connections: {
    snowball_32_14: {
      id: 'snowball_32_14',
      fromAccountId: '32',
      destinationType: 'lank_wallet',
      toAccountId: '14',
      destinationClabe: '646180141414141414',
      active: true,
    },
  },
};

describe('resolveWithdrawalDestinationLabel', () => {
  it('shows an internal Snowball destination account instead of an unclassified destination', () => {
    const label = resolveWithdrawalDestinationLabel({
      accountId: '32',
      bank: 'STP',
      accountNumber: '646 180 141 414 141 414',
      movementType: 'snowball_internal',
      destinationAccountId: '14',
    }, {
      accounts,
      snowballConfig,
    });

    expect(label).toBe('Retiro a cuenta #14 Fática Cáceres');
  });

  it('infers the Snowball destination from the withdrawal CLABE even when AdminBot did not store destinationAccountId', () => {
    const label = resolveWithdrawalDestinationLabel({
      accountId: '32',
      bank: 'STP',
      accountNumber: '646180141414141414',
    }, {
      accounts,
      snowballConfig,
    });

    expect(label).toBe('Retiro a cuenta #14 Fática Cáceres');
  });

  it('uses an active Snowball wallet CLABE as the destination even without a matching connection', () => {
    const label = resolveWithdrawalDestinationLabel({
      accountId: '99',
      bank: 'Arcus',
      accountNumber: '646180141414141414',
    }, {
      accounts,
      snowballConfig: {
        ...snowballConfig,
        connections: {},
      },
    });

    expect(label).toBe('Retiro a cuenta #14 Fática Cáceres');
  });

  it('keeps registered external bank labels when the CLABE is not a Snowball wallet', () => {
    const label = resolveWithdrawalDestinationLabel({
      bank: 'STP',
      accountNumber: '012345678901234567',
      knownBankAccount: { bank: 'BBVA', clabe: '012345678901234567' },
    }, {
      bankClabes: [{ bank: 'BBVA', clabe: '012345678901234567' }],
      snowballConfig,
    });

    expect(label).toBe('BBVA');
  });

  it('leaves non-operational labels unclassified when no Snowball or bank match exists', () => {
    const label = resolveWithdrawalDestinationLabel({
      bank: 'STP',
      accountNumber: '646180999999999999',
    }, {
      accounts,
      snowballConfig,
    });

    expect(label).toBe(UNCLASSIFIED_DESTINATION_LABEL);
  });

  it('keeps Snowball labels out of external bank-only lists', () => {
    expect(isOperationalExternalBankLabel('BBVA')).toBe(true);
    expect(isOperationalExternalBankLabel('STP')).toBe(false);
    expect(isOperationalExternalBankLabel(UNCLASSIFIED_DESTINATION_LABEL)).toBe(false);
    expect(isOperationalExternalBankLabel('Retiro a cuenta #14 Fática Cáceres')).toBe(false);
  });
});
