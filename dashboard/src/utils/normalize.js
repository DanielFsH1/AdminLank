/**
 * Normaliza texto para búsquedas: quita acentos/diacríticos, convierte a
 * minúsculas y elimina símbolos especiales conservando espacios y alfanuméricos.
 *
 *   normalizeSearch('García')  → 'garcia'
 *   normalizeSearch('José María Ñoño') → 'jose maria nono'
 *   normalizeSearch('correo+tag@gmail.com') → 'correotaggmailcom'
 */
export function normalizeSearch(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')                     // descompone acentos: é → e + ́
    .replace(/[\u0300-\u036f]/g, '')      // elimina diacríticos combinados
    .toLowerCase()
    .replace(/[^a-z0-9\s@._-]/g, '')     // conserva alfanum, espacios, @._-
    .trim();
}

/**
 * Versión que compara si `text` contiene `query`, ambos normalizados.
 *   nMatch('José García', 'garcia')  → true
 */
export function nMatch(text, normalizedQuery) {
  return normalizeSearch(text).includes(normalizedQuery);
}
