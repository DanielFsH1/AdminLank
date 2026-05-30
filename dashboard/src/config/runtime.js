export const CLOUD_FUNCTIONS_URL = (import.meta.env.VITE_CLOUD_FUNCTIONS_URL || '').replace(/\/+$/, '');

export function buildCloudFunctionUrl(path) {
  if (!CLOUD_FUNCTIONS_URL) {
    throw new Error('VITE_CLOUD_FUNCTIONS_URL no esta configurada');
  }
  return `${CLOUD_FUNCTIONS_URL}/${String(path || '').replace(/^\/+/, '')}`;
}
