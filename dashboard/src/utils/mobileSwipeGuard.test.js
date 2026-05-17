import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, '..');
const appSource = readFileSync(resolve(srcRoot, 'App.jsx'), 'utf8');
const vaultSource = readFileSync(resolve(srcRoot, 'pages/Vault.jsx'), 'utf8');
const cssSource = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');

describe('mobile tab swipe guard', () => {
  it('blocks page tab swipes that start inside any horizontal scroll container', () => {
    expect(appSource).toContain("if (ov === 'auto' || ov === 'scroll') return;");
    expect(appSource).not.toContain('atStart');
    expect(appSource).not.toContain('atEnd');
  });

  it('does not leave the removed tab fade overlay wired into Vault', () => {
    expect(vaultSource).not.toContain('scroll-fade-hint');
    expect(vaultSource).not.toContain("classList.toggle('at-end'");
    expect(cssSource).not.toContain('.scroll-fade-hint');
  });
});
