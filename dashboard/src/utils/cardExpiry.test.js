import { describe, expect, it } from 'vitest';
import { normalizeCardExpiryInput } from './cardExpiry';

describe('normalizeCardExpiryInput', () => {
  it('interpreta dos dígitos como mes parcial', () => {
    expect(normalizeCardExpiryInput('05')).toBe('05');
  });

  it('interpreta escritura seguida de mes y año corto', () => {
    expect(normalizeCardExpiryInput('0530')).toBe('05/2030');
  });

  it('normaliza entrada con slash y año corto', () => {
    expect(normalizeCardExpiryInput('05/30')).toBe('05/2030');
  });

  it('preserva año de cuatro dígitos', () => {
    expect(normalizeCardExpiryInput('05/2030')).toBe('05/2030');
  });

  it('recorta caracteres no numéricos y limita el mes a 12', () => {
    expect(normalizeCardExpiryInput('1930')).toBe('12/2030');
  });

  it('normaliza mes cero al mínimo válido', () => {
    expect(normalizeCardExpiryInput('0030')).toBe('01/2030');
  });

  it('permite escritura seguida del modal: 05 y luego 30', () => {
    const monthOnly = normalizeCardExpiryInput('05');
    const completed = normalizeCardExpiryInput('0530');

    expect(monthOnly).toBe('05');
    expect(completed).toBe('05/2030');
  });
});
