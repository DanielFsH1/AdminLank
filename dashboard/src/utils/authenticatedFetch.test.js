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
      'Sesión Firebase requerida',
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
});
