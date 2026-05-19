import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const historyPage = readFileSync(resolve(repoRoot, 'dashboard/src/pages/History.jsx'), 'utf8');
const firestoreActions = readFileSync(resolve(repoRoot, 'dashboard/src/hooks/firestoreActions.js'), 'utf8');
const lankAudit = readFileSync(resolve(repoRoot, 'functions/lank_audit.py'), 'utf8');
const functionsMain = readFileSync(resolve(repoRoot, 'functions/main.py'), 'utf8');

describe('audit log retention limits', () => {
  it('lets the dashboard history tab request up to 1000 audit records', () => {
    expect(historyPage).toContain('<option value={1000}>1000 registros</option>');
    expect(historyPage).toContain('limit(displayLimit)');
  });

  it('keeps dashboard audit-log cleanup at 1000 records', () => {
    expect(firestoreActions).toContain('AUDIT_LOG_RETENTION_LIMIT = 1000');
    expect(firestoreActions).toContain('snap.docs.slice(AUDIT_LOG_RETENTION_LIMIT)');
  });

  it('keeps backend audit-log cleanup and API reads at 1000 records', () => {
    expect(lankAudit).toContain('AUDIT_LOG_RETENTION_LIMIT = 1000');
    expect(lankAudit).toContain('_cleanup_old_entries(db, max_entries=AUDIT_LOG_RETENTION_LIMIT)');
    expect(functionsMain).toContain('AUDIT_LOG_MAX_LIMIT = 1000');
    expect(functionsMain).toContain('min(int(req.args.get');
    expect(functionsMain).toContain('AUDIT_LOG_MAX_LIMIT');
  });
});
