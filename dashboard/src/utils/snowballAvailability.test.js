import { describe, expect, it } from 'vitest';
import {
  buildSnowballAccountOptions,
  buildSnowballBankDestinationOptions,
  describeSnowballConnectionDeletion,
} from './snowballAvailability';

const accounts = [
  { id: '1', canonicalAlias: 'Cuenta Demo 1' },
  { id: '2', canonicalAlias: 'Cuenta Demo 2' },
  { id: '3', canonicalAlias: 'Cuenta Demo 3' },
  { id: '4', canonicalAlias: 'Cuenta Demo 4' },
];

const config = {
  wallets: {
    1: { accountId: '1', walletClabe: '646180111111111111', active: true },
    2: { accountId: '2', walletClabe: '646180222222222222', active: true },
    3: { accountId: '3', walletClabe: '646180333333333333', active: true },
    4: { accountId: '4', walletClabe: '646180444444444444', active: false },
  },
  connections: {
    one_to_two: {
      id: 'one_to_two',
      fromAccountId: '1',
      destinationType: 'lank_wallet',
      toAccountId: '2',
      destinationClabe: '646180222222222222',
      active: true,
    },
    three_to_bank: {
      id: 'three_to_bank',
      fromAccountId: '3',
      destinationType: 'external_bank',
      destinationBankId: 'bank_1',
      destinationClabe: '012345678901234567',
      active: true,
    },
    inactive_four_to_three: {
      id: 'inactive_four_to_three',
      fromAccountId: '4',
      destinationType: 'lank_wallet',
      toAccountId: '3',
      destinationClabe: '646180333333333333',
      active: false,
    },
  },
};

function ids(list) {
  return list.map(account => account.id);
}

describe('buildSnowballAccountOptions', () => {
  it('oculta cuentas que ya tienen salida activa al crear una conexión', () => {
    const options = buildSnowballAccountOptions({ accounts, config });

    expect(ids(options.originAccounts)).toEqual(['2', '4']);
  });

  it('oculta cuentas que ya tienen entrada interna activa como destino', () => {
    const options = buildSnowballAccountOptions({
      accounts,
      config,
      fromAccountId: '4',
      destinationType: 'lank_wallet',
    });

    expect(ids(options.destinationAccounts)).toEqual(['1', '3']);
  });

  it('oculta una cuenta en ambos selectores cuando ya se uso como entrada y salida', () => {
    const bothUsedConfig = {
      ...config,
      connections: {
        ...config.connections,
        two_to_three: {
          id: 'two_to_three',
          fromAccountId: '2',
          destinationType: 'lank_wallet',
          toAccountId: '3',
          destinationClabe: '646180333333333333',
          active: true,
        },
      },
    };

    const options = buildSnowballAccountOptions({
      accounts,
      config: bothUsedConfig,
      fromAccountId: '4',
      destinationType: 'lank_wallet',
    });

    expect(ids(options.originAccounts)).toEqual(['4']);
    expect(ids(options.destinationAccounts)).toEqual(['1']);
  });

  it('ignora conexiones inactivas para disponibilidad', () => {
    const options = buildSnowballAccountOptions({
      accounts,
      config,
      fromAccountId: '1',
      destinationType: 'lank_wallet',
    });

    expect(ids(options.destinationAccounts)).toContain('3');
  });

  it('permite conservar cuentas de la conexión actual al editar', () => {
    const editingConnection = config.connections.one_to_two;
    const options = buildSnowballAccountOptions({
      accounts,
      config,
      editingConnection,
      fromAccountId: '1',
      destinationType: 'lank_wallet',
    });

    expect(ids(options.originAccounts)).toContain('1');
    expect(ids(options.destinationAccounts)).toContain('2');
  });

  it('solo ofrece destinos internos con billetera activa y distinta del origen', () => {
    const options = buildSnowballAccountOptions({
      accounts,
      config,
      fromAccountId: '3',
      destinationType: 'lank_wallet',
    });

    expect(ids(options.destinationAccounts)).not.toContain('3');
    expect(ids(options.destinationAccounts)).not.toContain('4');
  });
});

describe('buildSnowballBankDestinationOptions', () => {
  const bankOptions = [
    { id: 'bank:one:debit:012345678901234567', bankId: 'one', clabe: '012345678901234567' },
    { id: 'bank:one:credit:111111111111111111', bankId: 'one', clabe: '111111111111111111' },
    { id: 'bank:two:debit:999999999999999999', bankId: 'two', clabe: '999999999999999999' },
  ];

  it('oculta CLABEs bancarias externas que ya son destino activo', () => {
    const options = buildSnowballBankDestinationOptions({ bankOptions, config });

    expect(options.destinationBanks.map(bank => bank.id)).toEqual([
      'bank:one:credit:111111111111111111',
      'bank:two:debit:999999999999999999',
    ]);
    expect([...options.usedExternalClabes]).toEqual(['012345678901234567']);
  });

  it('mantiene disponible otra CLABE del mismo banco externo', () => {
    const configSameBank = {
      ...config,
      connections: {
        ...config.connections,
        three_to_bank: {
          ...config.connections.three_to_bank,
          destinationBankId: 'one',
        },
      },
    };

    const options = buildSnowballBankDestinationOptions({ bankOptions, config: configSameBank });

    expect(options.destinationBanks.map(bank => bank.id)).toEqual([
      'bank:one:credit:111111111111111111',
      'bank:two:debit:999999999999999999',
    ]);
  });

  it('permite conservar la CLABE bancaria externa al editar esa conexión', () => {
    const options = buildSnowballBankDestinationOptions({
      bankOptions,
      config,
      editingConnection: config.connections.three_to_bank,
    });

    expect(options.destinationBanks.map(bank => bank.id)).toEqual([
      'bank:one:debit:012345678901234567',
      'bank:one:credit:111111111111111111',
      'bank:two:debit:999999999999999999',
    ]);
  });
});

describe('describeSnowballConnectionDeletion', () => {
  it('describe cuando borrar una conexión parte una bola en dos cadenas', () => {
    const chainConfig = {
      ...config,
      wallets: {
        ...config.wallets,
        4: { accountId: '4', walletClabe: '646180444444444444', active: true },
      },
      connections: {
        one_to_two: config.connections.one_to_two,
        two_to_three: {
          id: 'two_to_three',
          fromAccountId: '2',
          destinationType: 'lank_wallet',
          toAccountId: '3',
          destinationClabe: '646180333333333333',
          active: true,
        },
        three_to_four: {
          id: 'three_to_four',
          fromAccountId: '3',
          destinationType: 'lank_wallet',
          toAccountId: '4',
          destinationClabe: '646180444444444444',
          active: true,
        },
      },
    };

    const impact = describeSnowballConnectionDeletion(chainConfig, chainConfig.connections.two_to_three);

    expect(impact.willSplitChain).toBe(true);
    expect(impact.message).toContain('separará la bola');
    expect(impact.message).toContain('#2');
    expect(impact.message).toContain('#3');
  });
});
