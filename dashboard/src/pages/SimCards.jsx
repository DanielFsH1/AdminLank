import { useState, useEffect, useMemo, useCallback } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { getSimCardConfig, markGroupRechargeComplete, markSimRechargeComplete, addSimCard, saveSimCardConfig } from '../hooks/firestoreActions';
import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import {
  BellIcon, CalendarIcon, CheckCircleIcon, ClockIcon, EditIcon,
  PlusIcon, RefreshIcon, TrashIcon, WarningIcon, UsersIcon,
} from '../components/Icons';

const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MONTH_NAMES_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// SIM chip icon
const SimIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <path d="M4 7V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>
    <path d="M8 12h8"/><path d="M8 16h8"/><path d="M12 12v4"/>
  </svg>
);

const PhoneIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>
  </svg>
);

const ChevronIcon = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`sim-group-chevron${open ? ' open' : ''}`}>
    <path d="M6 9l6 6 6-6"/>
  </svg>
);

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()} ${MONTH_NAMES_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

function getUrgencyLevel(daysLeft) {
  if (daysLeft <= 0) return 'overdue';
  if (daysLeft <= 15) return 'critical';
  if (daysLeft <= 30) return 'warning';
  if (daysLeft <= 60) return 'soon';
  return 'ok';
}

function getUrgencyColor(level) {
  switch (level) {
    case 'overdue': return 'var(--accent-danger, #ef4444)';
    case 'critical': return 'var(--accent-warning, #f59e0b)';
    case 'warning': return '#fb923c';
    case 'soon': return 'var(--accent-info, #3b82f6)';
    default: return 'var(--accent-success, #10b981)';
  }
}

function getUrgencyLabel(daysLeft) {
  if (daysLeft < 0) return `Vencida hace ${Math.abs(daysLeft)} día${Math.abs(daysLeft) !== 1 ? 's' : ''}`;
  if (daysLeft === 0) return 'Vence hoy';
  if (daysLeft === 1) return 'Vence mañana';
  if (daysLeft <= 7) return `${daysLeft} días — Urgente`;
  if (daysLeft <= 30) return `${daysLeft} días`;
  return `${daysLeft} días`;
}

function getBadgeClass(level) {
  switch (level) {
    case 'overdue': return 'badge badge-danger';
    case 'critical': return 'badge badge-warning';
    case 'warning': return 'badge badge-high';
    case 'soon': return 'badge badge-info';
    default: return 'badge badge-success';
  }
}

export default function SimCards({ onNavigate }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [addModal, setAddModal] = useState(null);
  const [individualRechargeModal, setIndividualRechargeModal] = useState(null);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [lankRegistry, setLankRegistry] = useState([]);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ message: msg, type });
  }, []);

  // Cargar SIM config en tiempo real
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'config', 'sim-cards'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setGroups(data.groups || []);
      } else {
        setGroups([]);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Cargar account registry para agregar nuevas SIMs
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'config', 'account-registry'), (snap) => {
      if (snap.exists()) {
        const accounts = (snap.data().accounts || []).map(a => ({
          id: Number(a.id),
          fullName: a.fullName || '',
          canonicalAlias: a.canonicalAlias || '',
          whatsapp: a.whatsapp || '',
        }));
        setLankRegistry(accounts);
      }
    });
    return () => unsub();
  }, []);

  // IDs de cuentas ya registradas en SIM cards
  const registeredIds = useMemo(() => {
    const ids = new Set();
    for (const g of groups) {
      for (const sim of g.sims || []) {
        ids.add(sim.lankAccountId);
      }
    }
    return ids;
  }, [groups]);

  // Cuentas no registradas
  const unregisteredAccounts = useMemo(() =>
    lankRegistry.filter(a => !registeredIds.has(a.id)),
  [lankRegistry, registeredIds]);

  // Estadísticas
  const stats = useMemo(() => {
    const totalSims = groups.reduce((sum, g) => sum + (g.sims?.length || 0), 0);
    const dueSoon = groups.filter(g => {
      const days = daysUntil(g.nextRechargeDate);
      return days <= 30 && days > 0;
    }).length;
    const overdue = groups.filter(g => daysUntil(g.nextRechargeDate) <= 0).length;
    // Next group to recharge
    const sorted = [...groups].sort((a, b) => daysUntil(a.nextRechargeDate) - daysUntil(b.nextRechargeDate));
    const nextGroup = sorted.find(g => daysUntil(g.nextRechargeDate) > 0);
    const nextDays = nextGroup ? daysUntil(nextGroup.nextRechargeDate) : null;
    return { totalSims, totalGroups: groups.length, dueSoon, overdue, nextDays };
  }, [groups]);

  // Ordenar grupos por urgencia (más urgente primero)
  const sortedGroups = useMemo(() =>
    [...groups].sort((a, b) => daysUntil(a.nextRechargeDate) - daysUntil(b.nextRechargeDate)),
  [groups]);

  // --- Handlers ---

  const handleGroupRecharge = async (groupNumber) => {
    try {
      const updated = await markGroupRechargeComplete(groups, groupNumber);
      setGroups(updated);
      showToast(`Grupo ${groupNumber} recargado correctamente`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
    setConfirmDialog(null);
  };

  const handleIndividualRecharge = async () => {
    if (!individualRechargeModal) return;
    const { lankAccountId, rechargeDate } = individualRechargeModal;
    try {
      const updated = await markSimRechargeComplete(groups, lankAccountId, rechargeDate || null);
      setGroups(updated);
      showToast('Recarga individual registrada');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
    setIndividualRechargeModal(null);
  };

  const handleAddSim = async () => {
    if (!addModal?.lankAccountId || !addModal?.lastRechargeDate) return;
    const account = lankRegistry.find(a => a.id === addModal.lankAccountId);
    if (!account) return;
    try {
      const updated = await addSimCard(groups, {
        lankAccountId: account.id,
        phone: account.whatsapp,
        fullName: account.fullName,
        canonicalAlias: account.canonicalAlias,
        lastRechargeDate: addModal.lastRechargeDate,
      });
      setGroups(updated);
      showToast(`SIM de ${account.canonicalAlias} agregada`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
    setAddModal(null);
  };

  // --- Timeline visual: 12 meses ---
  const timelineMonths = useMemo(() => {
    const months = [];
    const now = new Date();
    // Start 2 months back to show overdue groups
    for (let i = -2; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: MONTH_NAMES[d.getMonth()],
        year: d.getFullYear(),
        month: d.getMonth(),
      });
    }
    return months;
  }, []);

  // Agrupar por mes de recarga
  const groupsByMonth = useMemo(() => {
    const map = {};
    for (const g of groups) {
      if (!g.nextRechargeDate) continue;
      const key = g.nextRechargeDate.slice(0, 7);
      if (!map[key]) map[key] = [];
      map[key].push(g);
    }
    return map;
  }, [groups]);

  if (loading) {
    return <div className="loading-container"><div className="loading-spinner"></div></div>;
  }

  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  return (
    <>
      {/* --- KPIs --- */}
      <div className="sim-kpis">
        <div className="kpi-card" style={{ '--kpi-color': 'var(--accent-primary)' }}>
          <div className="kpi-label"><SimIcon size={14} /> Total SIMs</div>
          <div className="kpi-value">{stats.totalSims}</div>
          <div className="kpi-sub">{stats.totalGroups} grupos activos</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': stats.overdue > 0 ? 'var(--accent-danger)' : 'var(--accent-success)' }}>
          <div className="kpi-label"><WarningIcon size={14} /> Vencidas</div>
          <div className={`kpi-value ${stats.overdue > 0 ? 'negative' : ''}`}>{stats.overdue}</div>
          <div className="kpi-sub">{stats.overdue > 0 ? 'Requieren atención' : 'Todo al día'}</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': stats.dueSoon > 0 ? 'var(--accent-warning)' : 'var(--accent-info)' }}>
          <div className="kpi-label"><ClockIcon size={14} /> Próximas</div>
          <div className="kpi-value">{stats.dueSoon}</div>
          <div className="kpi-sub">En los próximos 30 días</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': 'var(--accent-info)' }}>
          <div className="kpi-label"><CalendarIcon size={14} /> Siguiente</div>
          <div className="kpi-value">{stats.nextDays != null ? `${stats.nextDays}d` : '—'}</div>
          <div className="kpi-sub">{stats.nextDays != null ? 'Para próxima recarga' : 'Sin recargas pendientes'}</div>
        </div>
      </div>

      {/* --- Timeline visual --- */}
      <div className="finance-section">
        <div className="finance-section-title" style={{ justifyContent: 'space-between' }}>
          <span><CalendarIcon size={16} /> Calendario de Recargas</span>
          <button
            className="alert-action-btn edit"
            onClick={() => setAddModal({ lankAccountId: null, lastRechargeDate: '' })}
          >
            <PlusIcon size={14} /> Agregar SIM
          </button>
        </div>

        <div className="sim-timeline">
          {timelineMonths.map(m => {
            const monthGroups = groupsByMonth[m.key] || [];
            const isCurrent = m.key === currentMonthKey;
            const totalSims = monthGroups.reduce((s, g) => s + (g.sims?.length || 0), 0);
            const bestUrgency = monthGroups.length > 0
              ? getUrgencyLevel(Math.min(...monthGroups.map(g => daysUntil(g.nextRechargeDate))))
              : null;

            return (
              <div key={m.key} className={`sim-timeline-month${isCurrent ? ' current' : ''}`}>
                <div className="sim-timeline-label">{m.label}</div>
                {monthGroups.length > 0 ? (
                  <>
                    <div className="sim-timeline-count" style={{ color: getUrgencyColor(bestUrgency) }}>
                      {totalSims}
                    </div>
                    <div className="sim-timeline-sub">
                      {monthGroups.map(g => `G${g.groupNumber}`).join(', ')}
                    </div>
                  </>
                ) : (
                  <div className="sim-timeline-count" style={{ opacity: 0.15 }}>—</div>
                )}
                <div className="sim-timeline-sub" style={{ opacity: 0.5 }}>{m.year}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* --- Lista de Grupos --- */}
      <div className="finance-section">
        <div className="finance-section-title">
          <span><UsersIcon size={16} /> Grupos de Recarga</span>
        </div>

        <div className="sim-groups">
          {sortedGroups.map(group => {
            const daysLeft = daysUntil(group.nextRechargeDate);
            const urgency = getUrgencyLevel(daysLeft);
            const isExpanded = expandedGroup === group.groupNumber;
            const simCount = group.sims?.length || 0;

            return (
              <div key={group.groupNumber} className={`sim-group-card ${urgency}`}>
                {/* Header del grupo */}
                <div
                  className="sim-group-header"
                  onClick={() => setExpandedGroup(isExpanded ? null : group.groupNumber)}
                >
                  <div className="sim-group-info">
                    <span
                      className="sim-group-number"
                      style={{
                        background: `${getUrgencyColor(urgency)}18`,
                        color: getUrgencyColor(urgency),
                      }}
                    >
                      {group.groupNumber}
                    </span>
                    <div className="sim-group-meta">
                      <div className="sim-group-title">
                        Grupo {group.groupNumber}
                        <span className="count">{simCount} número{simCount !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="sim-group-date">
                        Próxima recarga: {formatDate(group.nextRechargeDate)}
                      </div>
                    </div>
                  </div>

                  <div className="sim-group-actions">
                    <span className={getBadgeClass(urgency)}>
                      {daysLeft !== Infinity ? getUrgencyLabel(daysLeft) : 'Sin fecha'}
                    </span>
                    <button
                      className="alert-action-btn complete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDialog({
                          title: `Confirmar recarga — Grupo ${group.groupNumber}`,
                          message: `¿Confirmas que se recargaron los ${simCount} números del grupo ${group.groupNumber}?\n\nPróxima recarga programada: 11 meses después.`,
                          onConfirm: () => handleGroupRecharge(group.groupNumber),
                        });
                      }}
                    >
                      <CheckCircleIcon size={13} /> Recarga hecha
                    </button>
                    <ChevronIcon open={isExpanded} />
                  </div>
                </div>

                {/* Detalle expandido */}
                {isExpanded && (
                  <div className="sim-group-body">
                    {/* Desktop: table */}
                    <table className="sim-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Nombre</th>
                          <th>Teléfono</th>
                          <th>Última recarga</th>
                          <th>Próxima recarga</th>
                          <th style={{ textAlign: 'center', width: 60 }}>Acción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(group.sims || []).map((sim, idx) => {
                          const simDays = daysUntil(sim.nextRechargeDate);
                          const simUrgency = getUrgencyLevel(simDays);
                          return (
                            <tr key={sim.lankAccountId || idx}>
                              <td><span className="sim-account-id">#{sim.lankAccountId}</span></td>
                              <td style={{ fontWeight: 500 }}>{sim.canonicalAlias || sim.fullName}</td>
                              <td><span className="sim-phone">{sim.phone}</span></td>
                              <td><span className="sim-date">{formatDateShort(sim.lastRechargeDate)}</span></td>
                              <td>
                                <span className="sim-next-date" style={{ color: getUrgencyColor(simUrgency) }}>
                                  {formatDateShort(sim.nextRechargeDate)}
                                </span>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <button
                                  className="alert-action-btn"
                                  title="Recarga individual anticipada"
                                  style={{ padding: '4px 8px' }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setIndividualRechargeModal({
                                      lankAccountId: sim.lankAccountId,
                                      name: sim.canonicalAlias || sim.fullName,
                                      rechargeDate: new Date().toISOString().slice(0, 10),
                                    });
                                  }}
                                >
                                  <RefreshIcon size={13} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {/* Mobile: card list */}
                    <div className="sim-card-list">
                      {(group.sims || []).map((sim, idx) => {
                        const simDays = daysUntil(sim.nextRechargeDate);
                        const simUrgency = getUrgencyLevel(simDays);
                        return (
                          <div key={sim.lankAccountId || idx} className="sim-card-item">
                            <div className="sim-card-item-info">
                              <div className="sim-card-item-name">
                                <span className="sim-account-id" style={{ marginRight: 6 }}>#{sim.lankAccountId}</span>
                                {sim.canonicalAlias || sim.fullName}
                              </div>
                              <div className="sim-card-item-details">
                                <span><PhoneIcon size={11} /> {sim.phone}</span>
                                <span style={{ color: getUrgencyColor(simUrgency), fontWeight: 600 }}>
                                  Prox: {formatDateShort(sim.nextRechargeDate)}
                                </span>
                              </div>
                            </div>
                            <button
                              className="alert-action-btn"
                              title="Recarga individual"
                              style={{ padding: '6px 8px', flexShrink: 0 }}
                              onClick={() => setIndividualRechargeModal({
                                lankAccountId: sim.lankAccountId,
                                name: sim.canonicalAlias || sim.fullName,
                                rechargeDate: new Date().toISOString().slice(0, 10),
                              })}
                            >
                              <RefreshIcon size={13} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* --- Cuentas sin SIM registrada --- */}
      {unregisteredAccounts.length > 0 && (
        <div className="sim-group-card soon" style={{ marginTop: '8px' }}>
          <div className="sim-notice">
            <BellIcon size={16} className="sim-notice-icon" />
            <div>
              <strong>{unregisteredAccounts.length}</strong> cuenta{unregisteredAccounts.length !== 1 ? 's' : ''} Lank sin SIM registrada:{' '}
              {unregisteredAccounts.slice(0, 5).map(a => `#${a.id} ${a.canonicalAlias}`).join(', ')}
              {unregisteredAccounts.length > 5 ? '...' : ''}
            </div>
          </div>
        </div>
      )}

      {/* --- Modal: Agregar SIM --- */}
      {addModal && (
        <EditModal
          open
          onClose={() => setAddModal(null)}
          onSave={handleAddSim}
          title="Agregar SIM Card"
          fields={[
            {
              key: 'lankAccountId', label: 'Cuenta Lank', type: 'select',
              options: unregisteredAccounts.map(a => ({ value: a.id, label: `#${a.id} — ${a.canonicalAlias} (${a.fullName})` })),
              required: true,
            },
            {
              key: 'lastRechargeDate', label: 'Fecha de última recarga', type: 'date',
              required: true,
              hint: 'Selecciona la fecha de la última recarga de este número (máximo 12 meses atrás)',
            },
          ]}
          values={addModal}
          onChange={(key, val) => setAddModal(prev => ({ ...prev, [key]: key === 'lankAccountId' ? Number(val) : val }))}
          saveLabel={<><PlusIcon size={14} /> Agregar SIM</>}
        />
      )}

      {/* --- Modal: Recarga individual --- */}
      {individualRechargeModal && (
        <EditModal
          open
          onClose={() => setIndividualRechargeModal(null)}
          onSave={handleIndividualRecharge}
          title={`Recarga anticipada — ${individualRechargeModal.name}`}
          fields={[
            {
              key: 'rechargeDate', label: 'Fecha de recarga', type: 'date',
              required: true,
            },
          ]}
          values={individualRechargeModal}
          onChange={(key, val) => setIndividualRechargeModal(prev => ({ ...prev, [key]: val }))}
          saveLabel={<><CheckCircleIcon size={14} /> Confirmar recarga</>}
        />
      )}

      {/* --- Confirm Dialog --- */}
      {confirmDialog && (
        <ConfirmDialog
          open
          onClose={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={<><CheckCircleIcon size={14} /> Confirmar</>}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </>
  );
}
