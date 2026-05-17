import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

describe('dashboard visual separation styles', () => {
  it('defines reusable subtle separation tokens for nested dashboard surfaces', () => {
    expect(css).toContain('--surface-panel-shadow');
    expect(css).toContain('--surface-nested-shadow');
    expect(css).toContain('--surface-divider');
    expect(css).toContain('--surface-highlight');
  });

  it('applies subtle hierarchy to common cards, panels, rows, and detail lists', () => {
    expect(css).toContain('Visual hierarchy separators');
    expect(css).toContain('.finance-col');
    expect(css).toContain('.vault-credential-card');
    expect(css).toContain('.status-service-card');
    expect(css).toContain('.credit-date-item');
    expect(css).toContain('.tools-storage-stat-item');
    expect(css).toContain('box-shadow: var(--surface-panel-shadow)');
    expect(css).toContain('box-shadow: var(--surface-nested-shadow)');
  });
});
