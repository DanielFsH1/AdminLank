import { useState, useEffect, useMemo } from 'react';
import { orderBy, limit } from 'firebase/firestore';
import { useCollection } from '../hooks/useFirestore';
import { RefreshIcon, SearchIcon, ClockIcon, EditIcon, TrashIcon, CheckIcon, PlusIcon } from '../components/Icons';

// ─── Iconos locales (SVG inline, misma base S que Icons.jsx) ─────────────────

const S = ({ size = 14, color = 'currentColor', children, ...p }) => (
  <svg
    width={size} height={size}
    viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, verticalAlign: 'middle' }}
    {...p}
  >
    {children}
  </svg>
);

const SystemIcon = p => <S {...p}><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></S>;
const AdminIcon = p => <S {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></S>;
const ChevronDownIcon = p => <S {...p}><polyline points="6 9 12 15 18 9"/></S>;
const ChevronRightIcon = p => <S {...p}><polyline points="9 18 15 12 9 6"/></S>;
const EmptyIcon = p => <S {...p} size={32}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="12" y2="13"/></S>;

// ─── Mapeos ───────────────────────────────────────────────────────────────────

const SOURCE_META = {
  ai_analysis: { label: 'IA Análisis', color: '#8b5cf6' },
  ai_chat:     { label: 'IA histórica', color: '#06b6d4' },
  manual:      { label: 'Manual',      color: '#10b981' },
  system:      { label: 'Sistema',     color: '#64748b' },
  adminbot:    { label: 'AdminBot',    color: '#8b5cf6' },
};

const ACTOR_META = {
  admin:  { label: 'Admin',   Icon: AdminIcon,  color: '#10b981' },
  system: { label: 'Sistema', Icon: SystemIcon, color: '#64748b' },
};

const ACTION_COLOR = {
  create_alert:      '#f59e0b',
  complete_alert:    '#10b981',
  discard_alert:     '#ef4444',
  cancel_alert:      '#ef4444',
  remove_user:       '#ef4444',
  delete_lank_group: '#ef4444',
  add_user:          '#10b981',
  create_lank_group: '#10b981',
  update_user:       '#3b82f6',
  update_slot:       '#3b82f6',
  update_lank_account: '#3b82f6',
  email_analysis:    '#8b5cf6',
  ai_email_analysis: '#a78bfa',
  chat_message:      '#06b6d4',
  restore:           '#f97316',
  correct_classification: '#eab308',
  add_deposit:    '#10b981',
  edit_deposit:   '#3b82f6',
  remove_deposit: '#ef4444',
};

const ACTION_LABEL = {
  create_alert:      'Crear alerta',
  complete_alert:    'Completar alerta',
  discard_alert:     'Descartar alerta',
  cancel_alert:      'Cancelar alerta',
  remove_user:       'Eliminar usuario',
  delete_lank_group: 'Eliminar grupo',
  add_user:          'Agregar usuario',
  create_lank_group: 'Crear grupo',
  update_user:       'Actualizar usuario',
  update_slot:       'Actualizar cupo',
  update_lank_account: 'Actualizar cuenta',
  email_analysis:    'Analisis de correos',
  ai_email_analysis: 'Analisis IA',
  chat_message:      'Mensaje chat',
  restore:           'Restauracion',
  correct_classification: 'Correccion',
  add_deposit:    'Registrar ingreso',
  edit_deposit:   'Editar ingreso',
  remove_deposit: 'Eliminar ingreso',
};

const SOURCE_FILTER_OPTIONS = [
  { value: '', label: 'Todas las fuentes' },
  { value: 'ai_analysis', label: 'IA Análisis' },
  { value: 'ai_chat',     label: 'IA histórica' },
  { value: 'manual',      label: 'Manual' },
  { value: 'system',      label: 'Sistema' },
  { value: 'adminbot',    label: 'AdminBot' },
];

const ACTOR_FILTER_OPTIONS = [
  { value: '', label: 'Todos los actores' },
  { value: 'admin',  label: 'Admin' },
  { value: 'system', label: 'Sistema' },
];

// ─── Helpers de tiempo ────────────────────────────────────────────────────────

function formatRelative(iso) {
  if (!iso) return '?';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Ahora';
  if (m < 60) return `Hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `Hace ${d}d`;
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatFull(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ─── Componente principal ────────────────────────────────────────────────────

export default function History({ navData }) {
  const [expanded, setExpanded] = useState(new Set());

  // Filtros — todos locales (sin llamadas al servidor)
  const [filterSource, setFilterSource] = useState('');
  const [filterActor, setFilterActor]   = useState('');
  const [searchQuery, setSearchQuery]   = useState('');
  const [displayLimit, setDisplayLimit] = useState(50);
  const { data: allEntries, loading } = useCollection('audit-log', {
    realtime: true,
    constraints: [orderBy('timestamp', 'desc'), limit(displayLimit)],
    deps: [displayLimit],
  });

  // Pre-cargar búsqueda desde navegación (ej: desde EntityHistory → "Ver en Historial")
  useEffect(() => {
    if (navData?.historySearch) {
      setSearchQuery(navData.historySearch);
    }
  }, [navData]);


  const toggleExpand = id => {
    setExpanded(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  // Estadísticas
  const stats = useMemo(() => {
    const bySource = {};
    allEntries.forEach(e => { bySource[e.source] = (bySource[e.source] || 0) + 1; });
    return { bySource, total: allEntries.length };
  }, [allEntries]);

  // Filtrado local (sin índices)
  const filtered = useMemo(() => {
    let list = allEntries;
    if (filterSource) list = list.filter(e => e.source === filterSource);
    if (filterActor)  list = list.filter(e => e.actor  === filterActor);
    if (searchQuery.length >= 2) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e =>
        (e.description || '').toLowerCase().includes(q) ||
        (e.action || '').toLowerCase().includes(q) ||
        (e.collection || '').toLowerCase().includes(q) ||
        (e.documentId || '').toLowerCase().includes(q)
      );
    }
    return list.slice(0, displayLimit);
  }, [allEntries, filterSource, filterActor, searchQuery, displayLimit]);

  return (
    <div className="history-page">

      {/* ── Stats ── */}
      <div className="history-stats-row">
        <div className="history-stat-card">
          <span className="history-stat-value">{stats.total}</span>
          <span className="history-stat-label">Total registros</span>
        </div>
        {Object.entries(stats.bySource).map(([src, count]) => {
          const m = SOURCE_META[src] || { label: src, color: '#888' };
          return (
            <div key={src} className="history-stat-card" style={{ borderLeft: `3px solid ${m.color}` }}>
              <span className="history-stat-value" style={{ color: m.color }}>{count}</span>
              <span className="history-stat-label">{m.label}</span>
            </div>
          );
        })}
      </div>

      {/* ── Filtros ── */}
      <div className="history-filters">
        <div className="history-search-wrap">
          <SearchIcon size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            className="history-search"
            type="text"
            placeholder="Buscar en historial..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <select className="history-select" value={filterSource} onChange={e => setFilterSource(e.target.value)}>
          {SOURCE_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select className="history-select" value={filterActor} onChange={e => setFilterActor(e.target.value)}>
          {ACTOR_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select className="history-select" value={displayLimit} onChange={e => setDisplayLimit(Number(e.target.value))}>
          <option value={25}>25 registros</option>
          <option value={50}>50 registros</option>
          <option value={100}>100 registros</option>
          <option value={200}>200 registros</option>
        </select>

        <button
          className="history-refresh-btn"
          onClick={() => { setFilterSource(''); setFilterActor(''); setSearchQuery(''); }}
        >
          <RefreshIcon size={13} />
          Limpiar
        </button>
      </div>

      {/* ── Timeline ── */}
      {loading ? (
        <div className="history-loading">
          <div className="loading-spinner" />
          <span>Cargando historial...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="history-empty">
          <EmptyIcon color="var(--text-muted)" />
          <span>No hay registros que coincidan.</span>
        </div>
      ) : (
        <div className="history-timeline">
          {filtered.map((entry, idx) => {
            const isExp = expanded.has(entry.id);
            const srcMeta = SOURCE_META[entry.source] || { label: entry.source || '?', color: '#888' };
            const actorMeta = ACTOR_META[entry.actor] || { label: entry.actor || '?', Icon: AdminIcon, color: '#888' };
            const dotColor = ACTION_COLOR[entry.action] || '#64748b';
            const hasDiff = entry.before != null || entry.after != null;
            const ActorIcon = actorMeta.Icon;

            return (
              <div
                key={entry.id || idx}
                className={`history-entry${isExp ? ' expanded' : ''}`}
                onClick={() => toggleExpand(entry.id)}
              >
                {/* Línea de timeline */}
                <div className="history-tl-col">
                  <div className="history-dot" style={{ background: dotColor }} />
                  {idx < filtered.length - 1 && <div className="history-connector" />}
                </div>

                {/* Contenido */}
                <div className="history-entry-content">
                  <div className="history-entry-header">
                    <div className="history-entry-tags">
                      {/* Fuente */}
                      <span className="history-tag-source" style={{ color: srcMeta.color, background: srcMeta.color + '20' }}>
                        {srcMeta.label}
                      </span>
                      {/* Acción */}
                      <span className="history-tag-action" style={{ borderColor: dotColor, color: dotColor }}>
                        {ACTION_LABEL[entry.action] || entry.action || '?'}
                      </span>
                      {/* Actor */}
                      <span className="history-actor-badge" style={{ color: actorMeta.color }}>
                        <ActorIcon size={12} color={actorMeta.color} />
                        {actorMeta.label}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="history-entry-id" title={entry.id}>
                        #{(entry.id || '').replace('audit_', '')}
                      </span>
                      <span className="history-time" title={formatFull(entry.timestamp)}>
                        <ClockIcon size={11} />
                        {formatRelative(entry.timestamp)}
                      </span>
                    </div>
                  </div>

                  <p className="history-description">
                    {entry.description || '(sin descripción)'}
                  </p>

                  {/* Metadata */}
                  {(entry.collection || entry.documentId || entry.field) && (
                    <div className="history-meta-row">
                      {entry.collection && <span className="history-meta-item">{entry.collection}</span>}
                      {entry.documentId && <span className="history-meta-item">{entry.documentId}</span>}
                      {entry.field && <span className="history-meta-item">{entry.field}</span>}
                      {entry.aiModel && <span className="history-meta-item">{entry.aiModel}</span>}
                    </div>
                  )}

                  {/* Diff expandible */}
                  {isExp && hasDiff && (
                    <div className="history-diff">
                      {entry.before != null && (
                        <div className="history-diff-block before">
                          <span className="history-diff-label">Antes</span>
                          <pre className="history-diff-value">{JSON.stringify(entry.before, null, 2)}</pre>
                        </div>
                      )}
                      {entry.after != null && (
                        <div className="history-diff-block after">
                          <span className="history-diff-label">Despues</span>
                          <pre className="history-diff-value">{JSON.stringify(entry.after, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Indicador expandible */}
                  {hasDiff && (
                    <span className="history-expand-hint">
                      {isExp ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                      {isExp ? 'Ocultar cambios' : 'Ver cambios'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
