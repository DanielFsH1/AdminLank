import { describe, expect, it } from 'vitest';
import { getScheduledAlertGroups, getTomorrowDateKey, toDateKey, toDateValue } from './scheduledAlerts';

describe('scheduledAlerts utils', () => {
 it('normaliza Date, string y Firestore Timestamp-like a Date válido', () => {
  const directDate = new Date('2026-05-01T12:00:00Z');
  const timestampLike = {
   toDate: () => new Date('2026-05-02T09:30:00Z'),
  };

  expect(toDateValue(directDate)?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  expect(toDateValue('2026-05-03T00:00:00Z')?.toISOString()).toBe('2026-05-03T00:00:00.000Z');
  expect(toDateValue(timestampLike)?.toISOString()).toBe('2026-05-02T09:30:00.000Z');
  expect(toDateValue('2026-05-10')?.getFullYear()).toBe(2026);
  expect(toDateValue('2026-05-10')?.getMonth()).toBe(4);
  expect(toDateValue('2026-05-10')?.getDate()).toBe(10);
  expect(toDateValue('not-a-date')).toBe(null);
 });

 it('normaliza valores de fecha a una llave YYYY-MM-DD', () => {
  expect(toDateKey('2026-05-10')).toBe('2026-05-10');
  expect(toDateKey(new Date('2026-05-11T19:00:00Z'))).toBe('2026-05-11');
  expect(toDateKey({ toDate: () => new Date('2026-05-12T18:00:00Z') })).toBe('2026-05-12');
 });

 it('calcula mañana a partir de una fecha base', () => {
  expect(getTomorrowDateKey(new Date('2026-05-01T23:59:00Z'))).toBe('2026-05-02');
  expect(getTomorrowDateKey(new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01');
 });

 it('aplica filtro global de prioridad y búsqueda a alertas programadas', () => {
  const alerts = [
   { id: 'sched-1', title: 'Llamar al banco', note: 'Confirmar cargo', priority: 'high', status: 'scheduled', scheduledDate: '2026-05-10' },
   { id: 'sched-2', title: 'Renovar dominio', note: 'Proyecto principal', priority: 'medium', status: 'scheduled', scheduledDate: '2026-05-12' },
   { id: 'sched-3', title: 'Cobro Netflix', note: 'Ya generado', priority: 'high', status: 'generated', scheduledDate: '2026-05-01', generatedAt: '2026-05-01T12:00:00Z' },
  ];

  const byPriority = getScheduledAlertGroups(alerts, { filterPriority: 'high' });
  expect(byPriority.scheduled.map((alert) => alert.id)).toEqual(['sched-1']);
  expect(byPriority.generated.map((alert) => alert.id)).toEqual(['sched-3']);

  const byQuery = getScheduledAlertGroups(alerts, { searchQuery: 'dominio' });
  expect(byQuery.scheduled.map((alert) => alert.id)).toEqual(['sched-2']);
  expect(byQuery.generated).toEqual([]);
 });

 it('ordena generadas por generatedAt y canceladas por cancelledAt', () => {
  const alerts = [
   { id: 'generated-older', title: 'A', priority: 'low', status: 'generated', scheduledDate: '2026-05-01', generatedAt: '2026-05-02T09:00:00Z' },
   { id: 'generated-newer', title: 'B', priority: 'low', status: 'generated', scheduledDate: '2026-05-01', generatedAt: '2026-05-03T09:00:00Z' },
   { id: 'cancelled-older', title: 'C', priority: 'low', status: 'cancelled', scheduledDate: '2026-05-01', cancelledAt: '2026-05-01T09:00:00Z' },
   { id: 'cancelled-newer', title: 'D', priority: 'low', status: 'cancelled', scheduledDate: '2026-05-01', cancelledAt: '2026-05-04T09:00:00Z' },
  ];

  const grouped = getScheduledAlertGroups(alerts);

  expect(grouped.generated.map((alert) => alert.id)).toEqual(['generated-newer', 'generated-older']);
  expect(grouped.cancelled.map((alert) => alert.id)).toEqual(['cancelled-newer', 'cancelled-older']);
 });
});
