// Configuración centralizada de servicios, bancos y utilidades de avatar
// SERVICES se mantiene como seed/fallback mientras carga la configuración dinámica de Firestore

function getInitials(label) {
  const words = String(label || 'AL')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const chars = words.length > 1
    ? `${words[0][0]}${words[1][0]}`
    : (words[0] || 'AL').slice(0, 2);
  return chars.toUpperCase();
}

export function buildPlaceholderLogo(label = 'AL', color = '#64748b') {
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#64748b';
  const initials = getInitials(label);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="${safeColor}"/><text x="48" y="58" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="28" font-weight="800" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function resolvePublicLogo(logo, label, color) {
  const value = String(logo || '').trim();
  if (value) return value;
  return buildPlaceholderLogo(label, color);
}

function withResolvedLogo(meta = {}, fallbackName = 'AL') {
  const color = meta.color || '#64748b';
  const name = meta.name || fallbackName;
  return {
    ...meta,
    color,
    logo: resolvePublicLogo(meta.logo || meta.logoUrl, name, color),
  };
}

export const SERVICES = {
  chatgpt: {
    name: 'ChatGPT Plus', color: '#10a37f', logo: buildPlaceholderLogo('ChatGPT Plus', '#10a37f'), maxSlots: 4,
    usesPool: true, accessType: 'credentials', accessTypeLabel: 'Perfil / proyecto', displayOrder: 1,
    nameAliases: ['ChatGPT Plus', 'ChatGPT'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'projectName', label: 'Proyecto asignado', placeholder: 'Nombre del proyecto en ChatGPT' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'projectName', label: 'Proyecto asignado', placeholder: 'Nombre del proyecto en ChatGPT' },
    ],
  },
  gemini: {
    name: 'Google AI Pro', color: '#8e44ec', logo: buildPlaceholderLogo('Google AI Pro', '#8e44ec'), maxSlots: 5,
    usesPool: true, accessType: 'email_invitation', displayOrder: 2,
    nameAliases: ['Gemini AI', 'Google/Gemini AI', 'Google AI Pro'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'memberEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@example.com' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'userEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@example.com' },
    ],
  },
  youtube: {
    name: 'YouTube Premium', color: '#ff0000', logo: buildPlaceholderLogo('YouTube Premium', '#ff0000'), maxSlots: 5,
    usesPool: true, accessType: 'email_invitation', displayOrder: 3,
    nameAliases: ['YouTube Premium', 'YouTube'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'memberEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@example.com' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'userEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@example.com' },
    ],
  },
  hbo: {
    name: 'HBO Max Platino', color: '#b535f6', logo: buildPlaceholderLogo('HBO Max Platino', '#b535f6'), maxSlots: 3,
    usesPool: true, accessType: 'profile_project', displayOrder: 4,
    nameAliases: ['HBO Max Platino'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'profileName', label: 'Nombre de perfil en HBO', placeholder: 'Perfil HBO Max' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'profileName', label: 'Nombre de perfil HBO', placeholder: 'Mi perfil' },
    ],
  },
  f1tv: {
    name: 'F1 TV Premium', color: '#e10600', logo: buildPlaceholderLogo('F1 TV Premium', '#e10600'), maxSlots: 5,
    usesPool: true, accessType: 'credentials', displayOrder: 5,
    nameAliases: ['F1 TV Premium', 'F1 TV'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
    ],
  },
  microsoft365: {
    name: 'Microsoft 365', color: '#0078d4', logo: buildPlaceholderLogo('Microsoft 365', '#0078d4'), maxSlots: 5,
    usesPool: false, accessType: 'email_invitation', displayOrder: 6,
    isRenewalBased: true,
    nameAliases: ['Microsoft 365', 'Office365'],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'invitationEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@example.com' },
    ],
  },
};

export const ACCESS_TYPES = {
  credentials: {
    label: 'Credenciales compartidas',
    description: 'Usuarios comparten una cuenta/contrasena; al salir alguien normalmente se cambia la contrasena.',
  },
  profile_project: {
    label: 'Perfil / proyecto',
    description: 'Usuarios ocupan perfiles, proyectos o espacios dentro de una cuenta compartida.',
  },
  email_invitation: {
    label: 'Invitacion por correo',
    description: 'Usuarios se agregan o remueven mediante invitacion, familia, workspace o correo.',
  },
};

export function normalizeServiceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function getAccessTypeLabel(accessType) {
  return ACCESS_TYPES[accessType]?.label || ACCESS_TYPES.email_invitation.label;
}

export function getDefaultSlotFields(accessType = 'email_invitation') {
  const fields = [
    { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
  ];

  if (accessType === 'email_invitation') {
    fields.push({ key: 'memberEmail', label: 'Correo de invitacion', type: 'email', placeholder: 'correo@example.com' });
  } else if (accessType === 'profile_project') {
    fields.push({ key: 'profileName', label: 'Perfil asignado', placeholder: 'Nombre del perfil' });
  }

  return fields;
}

export function getDefaultUserFields(accessType = 'email_invitation') {
  const fields = [
    { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
    { key: 'phone', label: 'Telefono', placeholder: '+52...' },
  ];

  if (accessType === 'email_invitation') {
    fields.push({ key: 'userEmail', label: 'Correo de invitacion', type: 'email', placeholder: 'correo@example.com' });
  } else if (accessType === 'profile_project') {
    fields.push({ key: 'profileName', label: 'Perfil asignado', placeholder: 'Nombre del perfil' });
  }

  return fields;
}

export function buildServiceConfig(input = {}, existing = {}) {
  const accessType = ACCESS_TYPES[input.accessType] ? input.accessType : 'email_invitation';
  const name = String(input.name || existing.name || '').trim();
  const key = normalizeServiceKey(input.key || input.serviceKey || existing.key || name);
  const usesPool = input.usesPool ?? existing.usesPool ?? true;
  const maxSlots = Number(input.maxSlots || existing.maxSlots || existing.maxSlotsPerRealAccount || 5);
  const maxSlotsPerRealAccount = Math.max(1, Math.min(20, Number(input.maxSlotsPerRealAccount || maxSlots || 5)));
  const maxSlotsPerLankGroup = Math.max(1, Math.min(20, Number(input.maxSlotsPerLankGroup || existing.maxSlotsPerLankGroup || maxSlotsPerRealAccount)));
  const aliases = Array.isArray(input.nameAliases)
    ? input.nameAliases
    : String(input.nameAliases || existing.nameAliases || '')
      .split(',')
      .map(alias => alias.trim())
      .filter(Boolean);
  const normalizedAliases = [...new Set([name, ...aliases].filter(Boolean))];

  return {
    key,
    config: {
      name,
      color: input.color || existing.color || '#64748b',
      logo: input.logo || existing.logo || '',
      maxSlots: maxSlotsPerRealAccount,
      maxSlotsPerRealAccount,
      maxSlotsPerLankGroup,
      usesPool: Boolean(usesPool),
      accessType,
      accessTypeLabel: getAccessTypeLabel(accessType),
      displayOrder: Number(input.displayOrder || existing.displayOrder || 99),
      active: input.active ?? existing.active ?? true,
      nameAliases: normalizedAliases,
      slotFields: input.slotFields || existing.slotFields || getDefaultSlotFields(accessType),
      userFields: input.userFields || existing.userFields || getDefaultUserFields(accessType),
    },
  };
}

export const BANKS = {
  'DiDi':           { color: '#ff6600', logo: buildPlaceholderLogo('DiDi', '#ff6600') },
  'OpenBank':       { color: '#00a877', logo: buildPlaceholderLogo('OpenBank', '#00a877') },
  'Plata Débito':   { color: '#7c3aed', logo: buildPlaceholderLogo('Plata Débito', '#7c3aed') },
  'Plata Crédito':  { color: '#7c3aed', logo: buildPlaceholderLogo('Plata Crédito', '#7c3aed') },
  'Klar':           { color: '#00c389', logo: buildPlaceholderLogo('Klar', '#00c389') },
  'Klar Crédito':   { color: '#00c389', logo: buildPlaceholderLogo('Klar Crédito', '#00c389') },
  'Nu':             { color: '#820ad1', logo: buildPlaceholderLogo('Nu', '#820ad1') },
  'Nu Crédito':     { color: '#820ad1', logo: buildPlaceholderLogo('Nu Crédito', '#820ad1') },
  'BBVA':           { color: '#004481', logo: buildPlaceholderLogo('BBVA', '#004481') },
  'Mifel':          { color: '#003b71', logo: buildPlaceholderLogo('Mifel', '#003b71') },
  'Mercado Pago':   { color: '#009ee3', logo: buildPlaceholderLogo('Mercado Pago', '#009ee3') },
  'AstroPay':       { color: '#0066ff', logo: buildPlaceholderLogo('AstroPay', '#0066ff') },
};

// ─── Servicios dinámicos (cargados desde Firestore en runtime) ──────────────

let _dynamicServices = null;

/**
 * Actualiza la configuración dinámica de servicios (llamado desde App.jsx al recibir config/services).
 */
export function setDynamicServices(servicesFromFirestore) {
  _dynamicServices = servicesFromFirestore;
}

/**
 * Retorna true si la configuración dinámica ya fue cargada desde Firestore.
 */
export function isDynamicLoaded() {
  return _dynamicServices !== null;
}

/**
 * Retorna el objeto completo de servicios (dinámico o fallback).
 */
export function getServicesMap() {
  return _dynamicServices || SERVICES;
}

const NON_SERVICE_CONFIG_KEYS = new Set(['id', 'updatedAt']);

export function normalizeServicesConfigDocument(data = {}) {
  const rawServices = data?.services && typeof data.services === 'object'
    ? data.services
    : data;

  return Object.fromEntries(
    Object.entries(rawServices || {}).filter(([key, value]) => (
      !NON_SERVICE_CONFIG_KEYS.has(key) && value && typeof value === 'object' && !Array.isArray(value)
    )),
  );
}

// ─── Utilidades de servicio ─────────────────────────────────────────────────

// Ruta a la imagen de perfil de una cuenta Lank
export function getProfileImage(accountId) {
  return accountId
    ? `/assets/profiles/account_${accountId}.png`
    : buildPlaceholderLogo('Cuenta Lank', '#64748b');
}

// Formatear moneda MXN
export function formatMXN(n) {
  if (n === undefined || n === null) return '$0';
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Obtener metadata de servicio con fallback
export function getServiceMeta(id) {
  if (_dynamicServices && _dynamicServices[id]) {
    return withResolvedLogo(_dynamicServices[id], id);
  }
  return withResolvedLogo(SERVICES[id] || { name: id, color: '#666', maxSlots: 0 }, id);
}

let _customBankAccounts = {};

export function setCustomBankAccounts(accounts) {
  _customBankAccounts = accounts || {};
}

export function getCustomBankAccounts() {
  return _customBankAccounts;
}

function normalizeBankName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^banco\s+/, '')
    .replace(/\s+(debito|credito)$/, '')
    .trim();
}

function findBankMetaByLooseName(bankName, source) {
  const normalized = normalizeBankName(bankName);
  if (!normalized) return null;

  const entry = Object.entries(source || {}).find(([name]) => normalizeBankName(name) === normalized);
  return entry?.[1] || null;
}

// Obtener metadata de banco con fallback
export function getBankMeta(bankName) {
  if (BANKS[bankName]) return withResolvedLogo(BANKS[bankName], bankName);
  if (_customBankAccounts[bankName]) return withResolvedLogo(_customBankAccounts[bankName], bankName);
  const customMeta = findBankMetaByLooseName(bankName, _customBankAccounts);
  if (customMeta) return withResolvedLogo(customMeta, bankName);
  const defaultMeta = findBankMetaByLooseName(bankName, BANKS);
  if (defaultMeta) return withResolvedLogo(defaultMeta, bankName);
  return withResolvedLogo({ color: '#64748b' }, bankName || 'Banco');
}

/**
 * Retorna todas las keys de servicios activos.
 */
export function getAllServiceKeys() {
  const src = _dynamicServices || SERVICES;
  return Object.keys(src)
    .filter(k => src[k].active !== false)
    .sort((a, b) => (src[a].displayOrder || 99) - (src[b].displayOrder || 99));
}

/**
 * Retorna las keys de servicios activos que usan pool de cuentas reales (usesPool !== false).
 * Excluye servicios como Microsoft 365 que solo manejan grupos Lank.
 */
export function getPoolServiceKeys() {
  const src = _dynamicServices || SERVICES;
  return Object.keys(src)
    .filter(k => src[k].active !== false && src[k].usesPool !== false)
    .sort((a, b) => (src[a].displayOrder || 99) - (src[b].displayOrder || 99));
}

/**
 * Retorna las keys de servicios sin pool (solo grupos Lank, como Microsoft 365).
 */
export function getNonPoolServiceKeys() {
  const src = _dynamicServices || SERVICES;
  return Object.keys(src)
    .filter(k => src[k].active !== false && src[k].usesPool === false)
    .sort((a, b) => (src[a].displayOrder || 99) - (src[b].displayOrder || 99));
}

/**
 * Resuelve un nombre de suscripción a su serviceKey usando nameAliases.
 * Ej: "ChatGPT Plus" → "chatgpt", "Office365" → "microsoft365"
 */
export function getServiceKeyByName(name) {
  if (!name) return null;
  const src = _dynamicServices || SERVICES;
  const normalized = name.toLowerCase().trim();

  // Primero: buscar coincidencia exacta por key
  if (src[normalized] && src[normalized].active !== false) return normalized;

  // Segundo: buscar en nameAliases y nombre
  for (const [key, svc] of Object.entries(src)) {
    if (svc.active === false) continue;
    if (svc.name && svc.name.toLowerCase() === normalized) return key;
    if ((svc.nameAliases || []).some(a => a.toLowerCase() === normalized)) return key;
  }

  // Tercero: búsqueda parcial (ej: "chatgpt" includes en "ChatGPT Plus")
  for (const [key, svc] of Object.entries(src)) {
    if (svc.active === false) continue;
    if (svc.name && svc.name.toLowerCase().includes(normalized)) return key;
    if ((svc.nameAliases || []).some(a => a.toLowerCase().includes(normalized))) return key;
  }

  return null;
}

/**
 * Retorna los campos editables para cupos de cuentas reales de un servicio.
 * Lee de slotFields de la config dinámica, con fallback a campos básicos.
 */
export function getSlotFields(serviceKey) {
  const meta = getServiceMeta(serviceKey);
  return meta.slotFields || [
    { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
  ];
}

/**
 * Retorna los campos editables para usuarios en grupos Lank de un servicio.
 * Lee de userFields de la config dinámica, con fallback a campos básicos.
 */
export function getUserFields(serviceKey) {
  const meta = getServiceMeta(serviceKey);
  return meta.userFields || [
    { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
    { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
  ];
}

/**
 * Retorna los campos esperados (required) para validación de info faltante en cupos.
 */
export function getExpectedSlotFields(serviceKey) {
  const fields = getSlotFields(serviceKey);
  return fields.map(f => f.key);
}
