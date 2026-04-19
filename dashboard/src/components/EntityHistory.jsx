import { useState } from 'react';

/**
 * Etiquetas legibles por acción de historial.
 */
const ACTION_LABELS = {
  assign: 'Asignado',
  release: 'Liberado',
  move_in: 'Entrada',
  move_out: 'Salida',
  joined: 'Ingresó',
  left: 'Salió',
  updated: 'Editado',
};

/**
 * Genera la descripción legible de una entrada de historial.
 * @param {object} entry
 * @returns {string}
 */
function buildDetail(entry) {
  const parts = [];
  const alias = entry.memberAlias || entry.userAlias || '';
  if (alias) parts.push(alias);

  switch (entry.action) {
    case 'assign':
      if (entry.slotNumber) parts.push(`cupo #${entry.slotNumber}`);
      if (entry.lankAccountId) parts.push(`Lank #${entry.lankAccountId}`);
      break;
    case 'release':
      if (entry.slotNumber) parts.push(`cupo #${entry.slotNumber}`);
      break;
    case 'move_in':
      if (entry.origin) parts.push(`desde ${entry.origin}`);
      if (entry.slotNumber) parts.push(`cupo #${entry.slotNumber}`);
      break;
    case 'move_out':
      if (entry.destination) parts.push(`hacia ${entry.destination}`);
      if (entry.slotNumber) parts.push(`cupo #${entry.slotNumber}`);
      break;
    case 'joined':
      if (entry.serviceAccountRef) parts.push(`→ ${entry.serviceAccountRef}`);
      if (entry.projectName) parts.push(`(${entry.projectName})`);
      break;
    case 'left':
      if (entry.reason) parts.push(`— ${entry.reason}`);
      break;
    case 'updated':
      if (entry.details) parts.push(`(${entry.details})`);
      break;
    default:
      break;
  }
  return parts.join(' ');
}

/**
 * Formatea un timestamp ISO a fecha corta legible.
 * @param {string} ts
 * @returns {string}
 */
function formatDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' }) +
      ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return ts;
  }
}

/**
 * Componente colapsable de historial por entidad.
 * Siempre visible. Muestra "Sin movimientos" si no hay registros.
 *
 * @param {{ history: Array, label?: string, searchKey?: string, onNavigate?: function }} props
 * - history: array de entradas de historial
 * - label: texto del toggle (ej: "Historial de cupos")
 * - searchKey: texto para pre-cargar en el buscador de la pestaña Historial (ej: "chatgpt_1")
 * - onNavigate: función (tab, data) para navegar a otra pestaña
 */
export default function EntityHistory({ history, label = 'Historial', searchKey, onNavigate }) {
  const [open, setOpen] = useState(false);
  const entries = Array.isArray(history) ? history : [];

  return (
    <div className="entity-history-section">
      <div className="entity-history-header">
        <button
          className="entity-history-toggle"
          onClick={() => setOpen(prev => !prev)}
          type="button"
        >
          <span className={`chevron ${open ? 'open' : ''}`}>▶</span>
          {label} ({entries.length})
        </button>
        {onNavigate && searchKey && (
          <button
            className="entity-history-link"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate('history', { historySearch: searchKey });
            }}
            type="button"
            title="Ver todo en pestaña Historial"
          >
            Ver en Historial →
          </button>
        )}
      </div>
      {open && (
        <div className="entity-history-entries">
          {entries.length === 0 ? (
            <div className="entity-history-empty">Sin movimientos registrados</div>
          ) : (
            entries.map((entry, i) => (
              <div className="entity-history-entry" key={entry.timestamp || i}>
                <span className={`history-action ${entry.action || ''}`}>
                  {ACTION_LABELS[entry.action] || entry.action || '?'}
                </span>
                <span className="history-detail">{buildDetail(entry)}</span>
                <span className="history-date">{formatDate(entry.timestamp)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
