/**
 * Utilidades de cifrado AES-256 para la Bóveda de credenciales.
 * Cifra campos sensibles antes de guardarlos en Firestore.
 */
import CryptoJS from 'crypto-js';

const VAULT_SALT = import.meta.env.VITE_VAULT_SALT || 'AdminLank_Vault';
let derivedVaultKey = '';

export function configureVaultKey(seed) {
  const cleanSeed = String(seed || '').trim();
  if (!cleanSeed) {
    derivedVaultKey = '';
    return false;
  }
  derivedVaultKey = CryptoJS.PBKDF2(cleanSeed, VAULT_SALT, {
    keySize: 256 / 32,
    iterations: 1000,
  }).toString();
  return true;
}

export function clearVaultKey() {
  derivedVaultKey = '';
}

export function hasVaultKey() {
  return Boolean(derivedVaultKey);
}

function requireVaultKey() {
  if (!derivedVaultKey) {
    throw new Error('La clave de Boveda no esta desbloqueada en esta sesion');
  }
  return derivedVaultKey;
}

/**
 * Cifra un string con AES-256.
 * @param {string} plainText - Texto a cifrar
 * @returns {string} Texto cifrado en Base64
 */
export function encrypt(plainText) {
  if (!plainText || typeof plainText !== 'string') return '';
  return CryptoJS.AES.encrypt(plainText, requireVaultKey()).toString();
}

/**
 * Descifra un string cifrado con AES-256.
 * @param {string} cipherText - Texto cifrado en Base64
 * @returns {string} Texto descifrado
 */
export function decrypt(cipherText) {
  if (!cipherText || typeof cipherText !== 'string') return '';
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, requireVaultKey());
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
