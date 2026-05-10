import { auth } from '../firebase';

function normalizeHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

export async function authenticatedFetch(url, options = {}) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sesión Firebase expirada o faltante. Vuelve a iniciar sesión en AdminLank.');
  }

  const token = await user.getIdToken();
  const headers = {
    ...normalizeHeaders(options.headers),
    Authorization: `Bearer ${token}`,
  };

  return fetch(url, {
    ...options,
    headers,
  });
}

export async function getAdminFunctionErrorMessage(response) {
  if (response.status === 401) {
    return 'Sesión Firebase expirada o faltante. Vuelve a iniciar sesión en AdminLank.';
  }
  if (response.status === 403) {
    return 'Esta cuenta no tiene permisos de administrador para AdminLank.';
  }

  let message = `HTTP ${response.status}`;
  try {
    const data = await response.json();
    message = data.error || data.message || message;
  } catch {
    // Mantener el mensaje HTTP si la respuesta no trae JSON.
  }
  return message;
}

export async function ensureAdminFunctionResponse(response) {
  if (response.ok) return response;
  throw new Error(await getAdminFunctionErrorMessage(response));
}
