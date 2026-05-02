import { normalizeSearch, nMatch } from './normalize';

export function toDateValue(value) {
 if (!value) return null;

 if (value instanceof Date) {
  return Number.isNaN(value.getTime()) ? null : value;
 }

 if (typeof value?.toDate === 'function') {
  const normalizedDate = value.toDate();
  return normalizedDate instanceof Date && !Number.isNaN(normalizedDate.getTime()) ? normalizedDate : null;
 }

 if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
  const [year, month, day] = value.split('-').map(Number);
  const normalizedDate = new Date(year, month - 1, day);
  return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate;
 }

 const normalizedDate = new Date(value);
 return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate;
}

export function toDateKey(value) {
 if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
  return value;
 }

 const normalizedDate = toDateValue(value);
 if (!normalizedDate) return null;

 return [
  normalizedDate.getFullYear(),
  String(normalizedDate.getMonth() + 1).padStart(2, '0'),
  String(normalizedDate.getDate()).padStart(2, '0'),
 ].join('-');
}

export function getTomorrowDateKey(now = new Date()) {
 const tomorrow = new Date(now);
 tomorrow.setHours(0, 0, 0, 0);
 tomorrow.setDate(tomorrow.getDate() + 1);
 return toDateKey(tomorrow);
}

function matchesScheduledAlert(alert, query) {
 return nMatch(alert.title || '', query)
  || nMatch(alert.note || '', query)
  || nMatch(alert.status || '', query)
  || nMatch(toDateKey(alert.scheduledDate) || '', query);
}

function sortByDateField(left, right, field, direction = 'asc') {
 const leftDate = toDateKey(left[field]) || toDateKey(left.scheduledDate) || '';
 const rightDate = toDateKey(right[field]) || toDateKey(right.scheduledDate) || '';

 return direction === 'asc'
  ? leftDate.localeCompare(rightDate)
  : rightDate.localeCompare(leftDate);
}

export function getScheduledAlertGroups(alerts, { searchQuery = '', filterPriority = 'all' } = {}) {
 let filteredAlerts = Array.isArray(alerts) ? alerts.slice() : [];

 if (filterPriority !== 'all') {
  filteredAlerts = filteredAlerts.filter((alert) => alert.priority === filterPriority);
 }

 const normalizedQuery = normalizeSearch(searchQuery);
 if (normalizedQuery.length >= 2) {
  filteredAlerts = filteredAlerts.filter((alert) => matchesScheduledAlert(alert, normalizedQuery));
 }

 const scheduled = filteredAlerts
  .filter((alert) => alert.status === 'scheduled')
  .sort((left, right) => sortByDateField(left, right, 'scheduledDate', 'asc'));

 const generated = filteredAlerts
  .filter((alert) => alert.status === 'generated')
  .sort((left, right) => sortByDateField(left, right, 'generatedAt', 'desc'));

 const cancelled = filteredAlerts
  .filter((alert) => alert.status === 'cancelled')
  .sort((left, right) => sortByDateField(left, right, 'cancelledAt', 'desc'));

 return { scheduled, generated, cancelled };
}
