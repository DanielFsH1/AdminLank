import { describe, expect, it } from 'vitest';
import { buildSnowballAccountOptions } from './snowballAvailability';

const accounts = [
  { id: '1', canonicalAlias: 'Daniel' },
  { id: '2', canonicalAlias: 'Silva' },
  { id: '3', canonicalAlias: 'Domingo' },
  { id: '4', canonicalAlias: 'Santiago' },
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
