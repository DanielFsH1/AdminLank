// Configuración centralizada de servicios, bancos y utilidades de avatar
// SERVICES se mantiene como seed/fallback mientras carga la configuración dinámica de Firestore

export const SERVICES = {
  chatgpt: {
    name: 'ChatGPT Plus', color: '#10a37f', logo: '/assets/ChatGPT.png', maxSlots: 4,
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
    name: 'Google AI Pro', color: '#8e44ec', logo: '/assets/Gemini.png', maxSlots: 5,
    usesPool: true, accessType: 'email_invitation', displayOrder: 2,
    nameAliases: ['Gemini AI', 'Google/Gemini AI', 'Google AI Pro'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'memberEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@ejemplo.com' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'userEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@ejemplo.com' },
    ],
  },
  youtube: {
    name: 'YouTube Premium', color: '#ff0000', logo: '/assets/YouTube.jpg', maxSlots: 5,
    usesPool: true, accessType: 'email_invitation', displayOrder: 3,
    nameAliases: ['YouTube Premium', 'YouTube'],
    slotFields: [
      { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
      { key: 'memberEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@ejemplo.com' },
    ],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'userEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@ejemplo.com' },
    ],
  },
  hbo: {
    name: 'HBO Max Platino', color: '#b535f6', logo: '/assets/HBO Max.jpg', maxSlots: 5,
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
    name: 'F1 TV Premium', color: '#e10600', logo: '/assets/F1 TV.png', maxSlots: 5,
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
    name: 'Microsoft 365', color: '#0078d4', logo: '/assets/Microsoft.png', maxSlots: 5,
    usesPool: false, accessType: 'email_invitation', displayOrder: 6,
    isRenewalBased: true,
    nameAliases: ['Microsoft 365', 'Office365'],
    userFields: [
      { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
      { key: 'phone', label: 'Teléfono', placeholder: '+52...' },
      { key: 'invitationEmail', label: 'Correo de invitación', type: 'email', placeholder: 'correo@ejemplo.com' },
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
    fields.push({ key: 'memberEmail', label: 'Correo de invitacion', type: 'email', placeholder: 'correo@ejemplo.com' });
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
    fields.push({ key: 'userEmail', label: 'Correo de invitacion', type: 'email', placeholder: 'correo@ejemplo.com' });
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
  'DiDi':           { color: '#ff6600', logo: '/assets/DiDi.png' },
  'OpenBank':       { color: '#00a877', logo: '/assets/Openbank.webp' },
  'Plata Débito':   { color: '#7c3aed', logo: '/assets/Plata.png' },
  'Plata Crédito':  { color: '#7c3aed', logo: '/assets/Plata.png' },
  'Klar':           { color: '#00c389', logo: '/assets/Klar.jpg' },
  'Klar Crédito':   { color: '#00c389', logo: '/assets/Klar.jpg' },
  'Nu':             { color: '#820ad1', logo: '/assets/NU.png' },
  'Nu Crédito':     { color: '#820ad1', logo: '/assets/NU.png' },
  'BBVA':           { color: '#004481', logo: '/assets/BBVA.png' },
  'Mifel':          { color: '#003b71', logo: '/assets/Mifel.png' },
  'Mercado Pago':   { color: '#009ee3', logo: '/assets/Mercado Pago.jpg' },
  'AstroPay':       { color: '#0066ff', logo: '/assets/AstroPay.png' },
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

// ─── Utilidades de servicio ─────────────────────────────────────────────────

// Ruta a la imagen de perfil de una cuenta Lank
export function getProfileImage(accountId) {
  return `/assets/profiles/account_${accountId}.png`;
}

// Formatear moneda MXN
export function formatMXN(n) {
  if (n === undefined || n === null) return '$0';
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Obtener metadata de servicio con fallback
export function getServiceMeta(id) {
  if (_dynamicServices && _dynamicServices[id]) {
    return _dynamicServices[id];
  }
  return SERVICES[id] || { name: id, color: '#666', logo: '', maxSlots: 0 };
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
  if (BANKS[bankName]) return BANKS[bankName];
  if (_customBankAccounts[bankName]) return _customBankAccounts[bankName];
  const customMeta = findBankMetaByLooseName(bankName, _customBankAccounts);
  if (customMeta) return customMeta;
  const defaultMeta = findBankMetaByLooseName(bankName, BANKS);
  if (defaultMeta) return defaultMeta;
  return { color: '#64748b', logo: '' };
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
