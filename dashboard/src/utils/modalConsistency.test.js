import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const srcRoot = resolve(repoRoot, 'dashboard/src');

const modalFiles = [
  'components/EditModal.jsx',
  'components/AddClabeModal.jsx',
  'components/BankManager.jsx',
  'pages/Analyze.jsx',
  'pages/Notes.jsx',
  'pages/SimCards.jsx',
  'pages/Snowball.jsx',
  'pages/Subscriptions.jsx',
  'pages/Tools.jsx',
  'pages/Vault.jsx',
];

const read = (path) => readFileSync(resolve(srcRoot, path), 'utf8');
const sources = Object.fromEntries(modalFiles.map(path => [path, read(path)]));
const allModalSource = Object.values(sources).join('\n');
const styles = read('index.css');

describe('modal consistency', () => {
  it('does not close modal windows from overlay mouse or click handlers', () => {
    expect(allModalSource).not.toMatch(/modal-overlay[^>\n]*(onClick|onMouseDown|onMouseUp)=/);
    expect(allModalSource).not.toContain('overlayProps(');
    expect(allModalSource).not.toContain('mouseDownOnOverlayRef');
  });

  it('keeps cancel as the visible close control and removes X close buttons', () => {
    expect(allModalSource).not.toContain('edit-modal-close');
    expect(allModalSource).not.toContain('vault-modal-close');
    expect(allModalSource).not.toMatch(/title="Cerrar"|&times;|>x<\/button>/);
    expect(styles).not.toMatch(/\.(edit-modal-close|vault-modal-close)\b/);
  });

  it('uses the shared modal shell and actions instead of parallel modal button systems', () => {
    for (const path of modalFiles) {
      if (sources[path].includes('modal-overlay') || sources[path].includes('ModalShell')) {
        expect(sources[path], path).toContain('ModalShell');
      }
    }
    expect(allModalSource).toContain('ModalActions');
    expect(allModalSource).not.toMatch(/note-modal-btn|vault-modal-btn|schedule-modal-btn/);
    expect(styles).not.toMatch(/\.note-modal-btn|\.vault-modal-btn|\.schedule-modal-btn/);
  });
});
