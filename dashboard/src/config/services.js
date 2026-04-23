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
    name: 'HBO Max Platino', color: '#b535f6', logo: '/assets/HBO Max.jpg', maxSlots: 3,
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
      { key: 'renewDay', label: 'Día de renovación (1-31)', type: 'select-day', placeholder: 'Seleccionar día del mes' },
    ],
  },
};

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

// Obtener metadata de banco con fallback
export function getBankMeta(bankName) {
  if (BANKS[bankName]) return BANKS[bankName];
  if (_customBankAccounts[bankName]) return _customBankAccounts[bankName];
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
