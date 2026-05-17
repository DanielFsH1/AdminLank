import { describe, expect, it } from 'vitest';
import {
  formatSidebarCollapsedValue,
  getSidebarLayoutClass,
  parseStoredSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
} from './sidebarLayout';

describe('sidebar layout helpers', () => {
  it('adds the collapsed layout class only when the desktop sidebar is collapsed', () => {
    expect(getSidebarLayoutClass(false)).toBe('app-layout');
    expect(getSidebarLayoutClass(true)).toBe('app-layout sidebar-collapsed');
  });

  it('parses and formats the persisted collapsed preference', () => {
    expect(SIDEBAR_COLLAPSED_STORAGE_KEY).toBe('adminlank-sidebar-collapsed');
    expect(parseStoredSidebarCollapsed('true')).toBe(true);
    expect(parseStoredSidebarCollapsed('false')).toBe(false);
    expect(parseStoredSidebarCollapsed(null)).toBe(false);
    expect(formatSidebarCollapsedValue(true)).toBe('true');
    expect(formatSidebarCollapsedValue(false)).toBe('false');
  });
});
