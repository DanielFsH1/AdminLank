import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const simCardsPage = readFileSync(resolve(repoRoot, 'dashboard/src/pages/SimCards.jsx'), 'utf8');

describe('SIM Cards visual details', () => {
  it('shows carrier badges for SIMs pending first recharge', () => {
    const pendingSection = simCardsPage.slice(
      simCardsPage.indexOf('{/* Pending first recharge */}'),
      simCardsPage.indexOf('{/* Unregistered accounts'),
    );

    expect(pendingSection).toContain('CARRIER_CONFIG[sim.carrier]');
    expect(pendingSection).toContain('sim-carrier-badge');
  });
});
