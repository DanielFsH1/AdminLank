/**
 * Utilidades de cifrado AES-256 para la Bóveda de credenciales.
 * Cifra campos sensibles antes de guardarlos en Firestore.
 */
import CryptoJS from 'crypto-js';

// Clave derivada del UID del admin + salt
const ADMIN_UID = '***REMOVED***';
const SALT = '***REMOVED***';
const DERIVED_KEY = CryptoJS.PBKDF2(ADMIN_UID, SALT, {
  keySize: 256 / 32,
  iterations: 1000,
}).toString();

/**
 * Cifra un string con AES-256.
 * @param {string} plainText - Texto a cifrar
 * @returns {string} Texto cifrado en Base64
 */
export function encrypt(plainText) {
  if (!plainText || typeof plainText !== 'string') return '';
  return CryptoJS.AES.encrypt(plainText, DERIVED_KEY).toString();
}

/**
 * Descifra un string cifrado con AES-256.
 * @param {string} cipherText - Texto cifrado en Base64
 * @returns {string} Texto descifrado
 */
export function decrypt(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, DERIVED_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    console.error('Error al descifrar:', e);
    return '[Error de descifrado]';
  }
}

/**
 * Cifra un objeto, cifrando solo los campos especificados.
 * @param {object} data - Objeto con datos
 * @param {string[]} sensitiveFields - Campos a cifrar
 * @returns {object} Objeto con campos sensibles cifrados
 */
export function encryptFields(data, sensitiveFields = []) {
  const result = { ...data };
  sensitiveFields.forEach(field => {
    if (result[field] && typeof result[field] === 'string') {
      result[field] = encrypt(result[field]);
    }
  });
  return result;
}

/**
 * Descifra un objeto, descifrando solo los campos especificados.
 * @param {object} data - Objeto con datos cifrados
 * @param {string[]} sensitiveFields - Campos a descifrar
 * @returns {object} Objeto con campos sensibles descifrados
 */
export function decryptFields(data, sensitiveFields = []) {
  const result = { ...data };
  sensitiveFields.forEach(field => {
    if (result[field] && typeof result[field] === 'string') {
      result[field] = decrypt(result[field]);
    }
  });
  return result;
}
