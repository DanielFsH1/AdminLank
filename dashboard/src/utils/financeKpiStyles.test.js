import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

const getRule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
};

describe('finance KPI responsive styles', () => {
  it('lets finance KPI cards wrap by available text space instead of forcing five cramped columns', () => {
    const gridRule = getRule('.finance-kpis-5');

    expect(gridRule).toContain('auto-fit');
    expect(gridRule).toContain('minmax');
    expect(gridRule).toContain('--finance-kpi-min-width');
  });

  it('keeps KPI content readable when labels and currency values are long', () => {
    const cardRule = getRule('.kpi-card');
    const labelRule = getRule('.kpi-label');
    const valueRule = getRule('.kpi-value');

    expect(cardRule).toContain('min-width: 0');
    expect(labelRule).toContain('overflow-wrap');
    expect(valueRule).toContain('clamp');
    expect(valueRule).toContain('overflow-wrap');
  });
});
