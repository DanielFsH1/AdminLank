import { beforeEach, describe, expect, it } from 'vitest';
import { clearVaultKey, configureVaultKey, decrypt, encrypt, hasVaultKey } from './crypto';

describe('vault crypto session key', () => {
  beforeEach(() => {
    clearVaultKey();
  });

  it('does not encrypt before the vault key is unlocked in memory', () => {
    expect(hasVaultKey()).toBe(false);
    expect(() => encrypt('secret')).toThrow('Boveda');
  });

  it('encrypts and decrypts after configuring the runtime key', () => {
    expect(configureVaultKey('example-runtime-key')).toBe(true);

    const cipherText = encrypt('example password');

    expect(cipherText).not.toBe('example password');
    expect(decrypt(cipherText)).toBe('example password');
  });

  it('clears the runtime key when the vault locks', () => {
    configureVaultKey('example-runtime-key');
    clearVaultKey();

    expect(hasVaultKey()).toBe(false);
    expect(() => encrypt('secret')).toThrow('Boveda');
  });
});
