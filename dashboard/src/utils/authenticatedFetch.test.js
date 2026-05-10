import { describe, expect, it, vi } from 'vitest';

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: { currentUser: null },
}));

vi.mock('../firebase', () => ({
  auth: mockAuth,
}));

describe('authenticatedFetch', () => {
  it('rechaza llamadas cuando no hay sesión Firebase activa', async () => {
    const { authenticatedFetch } = await import('./authenticatedFetch');

    await expect(authenticatedFetch('https://example.test/status')).rejects.toThrow(
      'Sesión Firebase expirada o faltante',
    );
  });

  it('agrega Authorization con el ID token del usuario actual', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    mockAuth.currentUser = {
      getIdToken: vi.fn().mockResolvedValue('id-token-123'),
    };
    vi.stubGlobal('fetch', fetchMock);

    const { authenticatedFetch } = await import('./authenticatedFetch');
    await authenticatedFetch('https://example.test/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(mockAuth.currentUser.getIdToken).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer id-token-123',
      },
      body: JSON.stringify({ enabled: true }),
    });

    vi.unstubAllGlobals();
  });

  it('explica 401 como sesión expirada o faltante', async () => {
    const { getAdminFunctionErrorMessage } = await import('./authenticatedFetch');
    const response = {
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'Authorization Bearer token requerido' }),
    };

    await expect(getAdminFunctionErrorMessage(response)).resolves.toBe(
      'Sesión Firebase expirada o faltante. Vuelve a iniciar sesión en AdminLank.',
    );
  });

  it('explica 403 como cuenta no autorizada', async () => {
    const { getAdminFunctionErrorMessage } = await import('./authenticatedFetch');
    const response = {
      status: 403,
      json: vi.fn().mockResolvedValue({ error: 'Acceso restringido al administrador de AdminLank' }),
    };

    await expect(getAdminFunctionErrorMessage(response)).resolves.toBe(
      'Esta cuenta no tiene permisos de administrador para AdminLank.',
    );
  });

  it('ensureAdminFunctionResponse lanza mensajes admin claros cuando la respuesta falla', async () => {
    const { ensureAdminFunctionResponse } = await import('./authenticatedFetch');
    const response = {
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: 'Fallo interno' }),
    };

    await expect(ensureAdminFunctionResponse(response)).rejects.toThrow('Fallo interno');
  });
});
