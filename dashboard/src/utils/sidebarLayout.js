export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'adminlank-sidebar-collapsed';

export function parseStoredSidebarCollapsed(value) {
  return value === 'true';
}

export function formatSidebarCollapsedValue(collapsed) {
  return collapsed ? 'true' : 'false';
}

export function getSidebarLayoutClass(collapsed) {
  return collapsed ? 'app-layout sidebar-collapsed' : 'app-layout';
}
