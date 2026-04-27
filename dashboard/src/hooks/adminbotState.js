import { useDocument } from './useFirestore';

const STATUS_LABELS = {
  pending: 'Trabajo pendiente',
  claimed: 'Procesando',
  completed: 'Última corrida completada',
  failed: 'Última corrida falló',
};

export function useAdminbotState() {
  const { data, loading } = useDocument('analysis/adminbot-latest');
  return {
    loading,
    data: data
      ? {
          jobId: data.jobId || null,
          status: data.status || 'unknown',
          runSource: data.runSource || 'system',
          analysisGeneratedAt: data.analysisGeneratedAt || null,
          scheduleSlot: data.scheduleSlot || null,
          updatedAt: data.updatedAt || null,
          statusLabel: STATUS_LABELS[data.status] || data.status || 'Desconocido',
        }
      : null,
  };
}
