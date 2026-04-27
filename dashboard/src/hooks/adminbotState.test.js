import { describe, expect, it, vi } from 'vitest';

const { mockUseDocument } = vi.hoisted(() => ({
  mockUseDocument: vi.fn(),
}));

vi.mock('./useFirestore', () => ({
  useDocument: mockUseDocument,
}));

import { useAdminbotState } from './adminbotState';

describe('useAdminbotState', () => {
  it('normaliza el documento analysis/adminbot-latest para el dashboard', () => {
    mockUseDocument.mockReturnValue({
      data: {
        jobId: 'job_abc',
        status: 'pending',
        runSource: 'dashboard',
        analysisGeneratedAt: '2026-04-26T18:00:00+00:00',
      },
      loading: false,
    });

    const result = useAdminbotState();

    expect(result.data.jobId).toBe('job_abc');
    expect(result.data.status).toBe('pending');
    expect(result.loading).toBe(false);
  });

  it('expone label derivado para mostrar la salud de AdminBot en Status', () => {
    mockUseDocument.mockReturnValue({
      data: {
        jobId: 'job_abc',
        status: 'completed',
        runSource: 'scheduler',
        analysisGeneratedAt: '2026-04-26T18:00:00+00:00',
      },
      loading: false,
    });

    const result = useAdminbotState();

    expect(result.data.statusLabel).toBe('Última corrida completada');
  });

  it('retorna null cuando no hay datos', () => {
    mockUseDocument.mockReturnValue({
      data: null,
      loading: false,
    });

    const result = useAdminbotState();

    expect(result.data).toBeNull();
    expect(result.loading).toBe(false);
  });
});
