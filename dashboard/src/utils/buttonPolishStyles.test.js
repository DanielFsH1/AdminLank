import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const notesPage = readFileSync(resolve(repoRoot, 'dashboard/src/pages/Notes.jsx'), 'utf8');
const bankManager = readFileSync(resolve(repoRoot, 'dashboard/src/components/BankManager.jsx'), 'utf8');
const styles = readFileSync(resolve(repoRoot, 'dashboard/src/index.css'), 'utf8');

describe('button visual polish', () => {
  it('uses designed note modal action buttons instead of browser-default buttons', () => {
    expect(notesPage).toContain('ModalActions');
    expect(notesPage).toContain('danger');
    expect(styles).toContain('.modal-action-btn');
    expect(styles).toContain('.modal-action-btn.primary');
    expect(styles).toContain('.modal-action-btn.danger');
  });

  it('keeps note card icon actions as visible designed controls', () => {
    expect(styles).toContain('.note-action-btn');
    expect(styles).toContain('border: 1px solid');
    expect(styles).toContain('.note-action-btn.danger');
  });

  it('replaces inline bank chip remove buttons with a reusable styled class', () => {
    expect(bankManager).toContain('className="vault-chip-remove-btn"');
    expect(styles).toContain('.vault-chip-remove-btn');
    expect(styles).toContain('.vault-chip-remove-btn:hover');
  });
});
