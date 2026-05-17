import { describe, expect, it } from 'vitest';
import { buildLogoStoragePath, validateLogoFile } from './logoUploads';

function file(overrides = {}) {
  return {
    name: 'Amazon Logo.JPG',
    type: 'image/jpeg',
    size: 100_000,
    ...overrides,
  };
}

describe('validateLogoFile', () => {
  it('acepta imágenes PNG, JPG, JPEG y WebP menores a 2 MB', () => {
    expect(validateLogoFile(file())).toBe('');
    expect(validateLogoFile(file({ type: 'image/png' }))).toBe('');
    expect(validateLogoFile(file({ type: 'image/webp' }))).toBe('');
  });

  it('rechaza archivos no imagen o demasiado grandes', () => {
    expect(validateLogoFile(file({ type: 'application/pdf' }))).toContain('PNG, JPG o WebP');
    expect(validateLogoFile(file({ size: 3 * 1024 * 1024 }))).toContain('2 MB');
  });
});

describe('buildLogoStoragePath', () => {
  it('construye rutas seguras para logos de servicios', () => {
    expect(buildLogoStoragePath('service-logos', file(), 'CyberGhost VPN', 123)).toBe('service-logos/CyberGhost_VPN_123.jpg');
  });

  it('construye rutas seguras para logos bancarios', () => {
    expect(buildLogoStoragePath('bank-logos', file({ name: 'amazon access.png' }), 'Amazon Access', 456)).toBe('bank-logos/Amazon_Access_456.png');
  });
});
