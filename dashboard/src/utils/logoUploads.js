import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

export const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;
export const ACCEPTED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export function validateLogoFile(file) {
  if (!file) return 'Selecciona una imagen';
  if (!ACCEPTED_LOGO_TYPES.has(file.type)) return 'Solo se permiten imágenes PNG, JPG o WebP';
  if (file.size > MAX_LOGO_FILE_SIZE) return 'La imagen no debe superar 2 MB';
  return '';
}

export function buildLogoStoragePath(folder, file, displayName, timestamp = Date.now()) {
  const safeFolder = String(folder || '').replace(/[^a-z0-9-]/gi, '');
  const extension = String(file?.name || 'logo.png').split('.').pop().toLowerCase();
  const safeName = String(displayName || file?.name || 'logo')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'logo';

  return `${safeFolder}/${safeName}_${timestamp}.${extension}`;
}

export async function uploadLogoFile(storage, file, { folder, displayName } = {}) {
  const validationError = validateLogoFile(file);
  if (validationError) throw new Error(validationError);

  const storagePath = buildLogoStoragePath(folder, file, displayName);
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  return { url, storagePath };
}
