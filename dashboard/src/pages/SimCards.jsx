import { useState, useEffect, useMemo, useCallback } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { markSimRechargeComplete, addSimCard, saveSimCardConfig } from '../hooks/firestoreActions';
import EditModal, { Toast } from '../components/EditModal';
import { ModalActions, ModalShell } from '../components/Modal';
import {
  BellIcon, CalendarIcon, CheckCircleIcon, ClockIcon,
  PlusIcon, WarningIcon,
} from '../components/Icons';
import LoadingState from '../components/LoadingState';
import { CARRIER_CONFIG, normalizeSimCarrier, resolveSimCarrier } from '../utils/simCardsCarrier';

const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MONTH_NAMES_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function formatPhone(phone) {
  if (!phone) return '—';
  const clean = phone.replace(/\D/g, '');
  if (clean.length === 12 && clean.startsWith('52')) {
    return `+52 ${clean.slice(2, 4)} ${clean.slice(4, 8)} ${clean.slice(8)}`;
  }
  if (clean.length === 10) {
    return `${clean.slice(0, 2)} ${clean.slice(2, 6)} ${clean.slice(6)}`;
  }
  return phone;
}

function todayLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function computeNextRechargeDate(rechargeDate, carrier = 'telcel') {
  if (!rechargeDate) return null;
  const d = new Date(rechargeDate + 'T12:00:00');
  const cfg = CARRIER_CONFIG[carrier];
  if (cfg && cfg.rechargeDays) {
    d.setDate(d.getDate() + cfg.rechargeDays);
  } else {
    d.setMonth(d.getMonth() + 11);
    d.setDate(15);
  }
  return d.toISOString().slice(0, 10);
}

function getRechargeFormulaText(carrier = 'telcel') {
  const cfg = CARRIER_CONFIG[carrier];
  if (cfg && cfg.rechargeDays) return `+ ${cfg.rechargeDays} días`;
  return '+ 11 meses → día 15';
}

/**
 * Modal custom de recarga con preview en vivo de la próxima fecha.
 * Paso 1: selección de fecha + preview.
 * Paso 2: confirmación con resumen completo.
 */
function RechargeModal({ sim, initialDate, onConfirm, onClose }) {
  const [rechargeDate, setRechargeDate] = useState(initialDate);
  const [step, setStep] = useState('date'); // 'date' | 'confirm'
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const carrier = resolveSimCarrier(sim);
  const carrierCfg = CARRIER_CONFIG[carrier] || CARRIER_CONFIG.telcel;
  const nextDate = computeNextRechargeDate(rechargeDate, carrier);
  const nextDateFormatted = nextDate ? formatDateShort(nextDate) : '—';
  const currentDateFormatted = rechargeDate ? formatDateShort(rechargeDate) : '—';

  // Mes y año destino
  const targetMonth = nextDate ? MONTH_NAMES_FULL[parseInt(nextDate.slice(5, 7)) - 1] : '';
  const targetYear = nextDate ? nextDate.slice(0, 4) : '';

  const today = todayLocal();

  const handleRequestConfirm = () => {
    if (!rechargeDate) {
      setError('Selecciona una fecha de recarga');
      return;
    }
    if (rechargeDate > today) {
      setError('No se pueden registrar recargas con fecha futura');
      return;
    }
    setError('');
    setStep('confirm');
  };

  const handleFinalConfirm = async () => {
    setSaving(true);
    setError('');
    try {
      await onConfirm(rechargeDate);
      setDone(true);
      setTimeout(() => onClose(), 900);
    } catch (err) {
      setError(err.message || 'Error al registrar la recarga');
      setSaving(false);
      setStep('date');
    }
  };

  return (
    <ModalShell
      open
      onCancel={onClose}
      size="md"
      className="edit-modal"
      title={done ? null : (step === 'confirm' ? 'Confirmar recarga' : (
        <>
          Recarga — {sim.canonicalAlias || sim.fullName}
          <span style={{
            display: 'inline-block', marginLeft: '8px', fontSize: '11px', fontWeight: 600,
            padding: '2px 8px', borderRadius: '10px', verticalAlign: 'middle',
            background: carrierCfg.color + '22', color: carrierCfg.color,
          }}>{carrierCfg.label}</span>
        </>
      ))}
      icon={done ? null : (step === 'confirm' ? <CheckCircleIcon size={20} /> : <CalendarIcon size={18} />)}
    >
        {done ? (
          <div className="edit-modal-success">
            <span className="edit-modal-success-icon"><CheckCircleIcon size={48} /></span>
            <div className="edit-modal-success-text">Recarga registrada</div>
          </div>
        ) : step === 'confirm' ? (
          /* ── Paso 2: Confirmación ── */
          <div style={{ padding: '28px 24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '10px' }}><CheckCircleIcon size={40} /></div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>Confirmar recarga</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
              Revisa los datos antes de confirmar.
            </p>

            <div className="recharge-confirm-summary">
              <div className="recharge-confirm-row">
                <span className="recharge-confirm-label">SIM</span>
                <span className="recharge-confirm-value">#{sim.lankAccountId} — {sim.canonicalAlias || sim.fullName}</span>
              </div>
              <div className="recharge-confirm-row">
                <span className="recharge-confirm-label">Teléfono</span>
                <span className="recharge-confirm-value">{formatPhone(sim.phone)}</span>
              </div>
              <div className="recharge-confirm-divider" />
              <div className="recharge-confirm-row">
                <span className="recharge-confirm-label">Fecha de recarga</span>
                <span className="recharge-confirm-value">{currentDateFormatted}</span>
              </div>
              <div className="recharge-confirm-row highlight">
                <span className="recharge-confirm-label">Próxima recarga</span>
                <span className="recharge-confirm-value accent">{nextDateFormatted}</span>
              </div>
              <div className="recharge-confirm-row">
                <span className="recharge-confirm-label">Se ubicará en</span>
                <span className="recharge-confirm-value">{targetMonth} {targetYear}</span>
              </div>
            </div>

            <ModalActions
              onCancel={onClose}
              secondaryLabel="Volver a editar"
              onSecondary={() => setStep('date')}
              primaryLabel={<><CheckCircleIcon size={16} /> Sí, confirmar recarga</>}
              onPrimary={handleFinalConfirm}
              loading={saving}
            />
            {error && <div className="edit-modal-error" style={{ marginTop: '12px' }}><WarningIcon size={14} /> {error}</div>}
          </div>
        ) : (
          /* ── Paso 1: Selección de fecha ── */
          <>
            <div className="edit-modal-body">
              <div className="edit-modal-field">
                <label className="edit-modal-label">Fecha de recarga<span className="edit-modal-required">*</span></label>
                <input
                  className="edit-modal-input"
                  type="date"
                  value={rechargeDate}
                  max={today}
                  onChange={e => { setRechargeDate(e.target.value); setError(''); }}
                  autoFocus
                />
                <span className="edit-modal-hint">
                  Selecciona la fecha en que se realizó la recarga.
                </span>
              </div>

              {/* Preview en vivo */}
              {rechargeDate && (
                <div className="recharge-preview">
                  <div className="recharge-preview-title"><CalendarIcon size={14} /> Próxima recarga calculada</div>
                  <div className="recharge-preview-date">{nextDateFormatted}</div>
                  <div className="recharge-preview-detail">
                    Se ubicará en <strong>{targetMonth} {targetYear}</strong>
                  </div>
                  <div className="recharge-preview-formula">
                    {currentDateFormatted} {getRechargeFormulaText(carrier)}
                  </div>
                </div>
              )}
            </div>

            {error && <div className="edit-modal-error"><WarningIcon size={14} /> {error}</div>}

            <ModalActions
              onCancel={onClose}
              primaryLabel={<><CheckCircleIcon size={14} /> Confirmar recarga</>}
              onPrimary={handleRequestConfirm}
            />
          </>
        )}
    </ModalShell>
  );
}

const PhoneIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>
  </svg>
);

const SimIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <path d="M4 7V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>
    <path d="M8 12h8"/><path d="M8 16h8"/><path d="M12 12v4"/>
  </svg>
);

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
  if (daysLeft <= 7) return 'critical';
  if (daysLeft <= 15) return 'warning';
  if (daysLeft <= 30) return 'soon';
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
  if (daysLeft < 0) return `Vencida ${Math.abs(daysLeft)}d`;
  if (daysLeft === 0) return 'Hoy';
  if (daysLeft === 1) return 'Mañana';
  if (daysLeft <= 7) return `${daysLeft}d — Urgente`;
  if (daysLeft <= 30) return `${daysLeft}d`;
  return `${daysLeft}d`;
}

/**
 * Corrige fechas legacy: suma 1 mes a nextRechargeDate y lastRechargeDate.
 * Aplica a todos los SIMs excepto #1, que ya fue corregido manualmente.
 */
function fixLegacyDate(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T12:00:00');
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Migra estructura legacy (groups) a lista plana de SIMs.
 * Solo se ejecuta si detecta el campo 'groups' en los datos.
 * Corrige el desfase de 1 mes en las fechas de todos los SIMs excepto #1.
 */
function migrateGroupsToFlat(data) {
  if (!data?.groups || data.sims) return data?.sims || [];
  const sims = [];
  for (const group of data.groups) {
    for (const sim of (group.sims || [])) {
      const isAccount1 = sim.lankAccountId === 1;
      sims.push({
        lankAccountId: sim.lankAccountId,
        phone: sim.phone,
        fullName: sim.fullName,
        canonicalAlias: sim.canonicalAlias,
        lastRechargeDate: isAccount1 ? sim.lastRechargeDate : fixLegacyDate(sim.lastRechargeDate),
        nextRechargeDate: isAccount1 ? sim.nextRechargeDate : fixLegacyDate(sim.nextRechargeDate),
      });
    }
  }
  return sims;
}

export default function SimCards() {
  const [sims, setSims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [addModal, setAddModal] = useState(null);
  const [rechargeModal, setRechargeModal] = useState(null);
  const [selectedYear, setSelectedYear] = useState(null);
  const [lankRegistry, setLankRegistry] = useState([]);
  const [addCarrier, setAddCarrier] = useState('telcel');

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ message: msg, type });
  }, []);

  // Load SIM config
  useEffect(() => {
    getDoc(doc(db, 'config', 'sim-cards')).then(snap => {
      if (snap.exists()) {
        const data = snap.data();
        let flatSims = data.sims || migrateGroupsToFlat(data);
        // Migrate: ensure all SIMs have a valid carrier field
        let needsMigration = false;
        flatSims = flatSims.map(sim => {
          const normalized = normalizeSimCarrier(sim);
          if (normalized !== sim) {
            needsMigration = true;
          }
          return normalized;
        });
        setSims(flatSims);
        if ((data.groups && !data.sims) || needsMigration) {
          saveSimCardConfig({ sims: flatSims }).catch(() => {});
        }
      } else {
        setSims([]);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Account registry for adding new SIMs
  useEffect(() => {
    getDoc(doc(db, 'config', 'account-registry')).then(snap => {
      if (snap.exists()) {
        const accounts = (snap.data().accounts || []).map(a => ({
          id: Number(a.id),
          fullName: a.fullName || '',
          canonicalAlias: a.canonicalAlias || '',
          whatsapp: a.whatsapp || '',
        }));
        setLankRegistry(accounts);
      }
    }).catch(() => {});
  }, []);

  // Set default year to earliest year with pending/overdue sims, or current year
  useEffect(() => {
    if (selectedYear || sims.length === 0) return;
    const now = new Date();
    const currentYear = now.getFullYear();
    // Find earliest year that has SIMs needing attention
    const years = [...new Set(sims.map(s => {
      if (!s.nextRechargeDate) return currentYear;
      return parseInt(s.nextRechargeDate.slice(0, 4));
    }))].sort();
    // Default to current year if available, else first year
    setSelectedYear(years.includes(currentYear) ? currentYear : years[0] || currentYear);
  }, [sims, selectedYear]);

  // Registered IDs
  const registeredIds = useMemo(() => new Set(sims.map(s => s.lankAccountId)), [sims]);

  // Unregistered accounts
  const unregisteredAccounts = useMemo(() =>
    lankRegistry.filter(a => !registeredIds.has(a.id)),
  [lankRegistry, registeredIds]);

  // Available years
  const availableYears = useMemo(() => {
    const years = new Set();
    for (const sim of sims) {
      if (sim.nextRechargeDate) {
        years.add(parseInt(sim.nextRechargeDate.slice(0, 4)));
      }
    }
    if (years.size === 0) years.add(new Date().getFullYear());
    return [...years].sort();
  }, [sims]);

  // SIMs grouped by month for selected year
  const monthData = useMemo(() => {
    const months = [];
    for (let m = 0; m < 12; m++) {
      const monthSims = sims
        .filter(sim => {
          if (!sim.nextRechargeDate) return false;
          const y = parseInt(sim.nextRechargeDate.slice(0, 4));
          const mo = parseInt(sim.nextRechargeDate.slice(5, 7)) - 1;
          return y === selectedYear && mo === m;
        })
        .sort((a, b) => daysUntil(a.nextRechargeDate) - daysUntil(b.nextRechargeDate));

      months.push({
        month: m,
        label: MONTH_NAMES_FULL[m],
        shortLabel: MONTH_NAMES[m],
        sims: monthSims,
      });
    }
    return months;
  }, [sims, selectedYear]);

  // SIMs pending first recharge (auto-created without dates)
  const pendingSims = useMemo(() =>
    sims.filter(s => !s.nextRechargeDate),
  [sims]);

  // Stats (exclude SIMs without dates)
  const activeSims = useMemo(() => sims.filter(s => s.nextRechargeDate), [sims]);

  // Stats
  const stats = useMemo(() => {
    const totalSims = sims.length;
    const pending = pendingSims.length;
    const overdue = activeSims.filter(s => daysUntil(s.nextRechargeDate) <= 0).length;
    const dueSoon = activeSims.filter(s => {
      const d = daysUntil(s.nextRechargeDate);
      return d > 0 && d <= 30;
    }).length;
    const sorted = [...activeSims].sort((a, b) => daysUntil(a.nextRechargeDate) - daysUntil(b.nextRechargeDate));
    const nextSim = sorted.find(s => daysUntil(s.nextRechargeDate) > 0);
    const nextDays = nextSim ? daysUntil(nextSim.nextRechargeDate) : null;
    return { totalSims, pending, overdue, dueSoon, nextDays };
  }, [sims, activeSims, pendingSims]);

  // Current month/year for highlighting
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Handlers

  const handleAddSim = async () => {
    if (!addModal?.lankAccountId || !addModal?.lastRechargeDate) return;
    const account = lankRegistry.find(a => a.id === addModal.lankAccountId);
    if (!account) return;
    try {
      const updated = await addSimCard(sims, {
        lankAccountId: account.id,
        phone: account.whatsapp,
        fullName: account.fullName,
        canonicalAlias: account.canonicalAlias,
        lastRechargeDate: addModal.lastRechargeDate,
        carrier: addCarrier,
      });
      setSims(updated);
      showToast(`SIM de ${account.canonicalAlias} agregada`);
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
    setAddModal(null);
    setAddCarrier('telcel');
  };

  if (loading) {
    return <LoadingState variant="page" />;
  }

  return (
    <>
      {/* KPIs */}
      <div className="sim-kpis">
        <div className="kpi-card" style={{ '--kpi-color': 'var(--accent-primary)' }}>
          <div className="kpi-label"><SimIcon size={14} /> Total SIMs</div>
          <div className="kpi-value">{stats.totalSims}</div>
          <div className="kpi-sub">Números registrados</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': stats.overdue > 0 ? 'var(--accent-danger)' : 'var(--accent-success)' }}>
          <div className="kpi-label"><WarningIcon size={14} /> Vencidas</div>
          <div className={`kpi-value ${stats.overdue > 0 ? 'negative' : ''}`}>{stats.overdue}</div>
          <div className="kpi-sub">{stats.overdue > 0 ? 'Requieren atención' : 'Todo al día'}</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': stats.dueSoon > 0 ? 'var(--accent-warning)' : 'var(--accent-info)' }}>
          <div className="kpi-label"><ClockIcon size={14} /> Próximas 30d</div>
          <div className="kpi-value">{stats.dueSoon}</div>
          <div className="kpi-sub">Próximos 30 días</div>
        </div>
        <div className="kpi-card" style={{ '--kpi-color': 'var(--accent-info)' }}>
          <div className="kpi-label"><CalendarIcon size={14} /> Siguiente</div>
          <div className="kpi-value">{stats.nextDays != null ? `${stats.nextDays}d` : '—'}</div>
          <div className="kpi-sub">{stats.nextDays != null ? 'Para próxima recarga' : 'Sin pendientes'}</div>
        </div>
      </div>

      {/* Year Tabs + Add Button */}
      <div className="finance-section">
        <div className="sim-header-bar">
          <div className="sim-year-tabs">
            {availableYears.map(year => (
              <button
                key={year}
                className={`sim-year-tab${selectedYear === year ? ' active' : ''}`}
                onClick={() => setSelectedYear(year)}
              >
                {year}
              </button>
            ))}
          </div>
          <button
            className="alert-action-btn edit"
            onClick={() => setAddModal({ lankAccountId: null, lastRechargeDate: '' })}
          >
            <PlusIcon size={14} /> Agregar SIM
          </button>
        </div>

        {/* Month Grid */}
        <div className="sim-month-grid">
          {monthData.map(({ month, label, shortLabel, sims: monthSims }) => {
            const isCurrent = selectedYear === currentYear && month === currentMonth;
            const isPast = selectedYear < currentYear || (selectedYear === currentYear && month < currentMonth);
            const hasOverdue = monthSims.some(s => daysUntil(s.nextRechargeDate) <= 0);
            const hasUrgent = monthSims.some(s => {
              const d = daysUntil(s.nextRechargeDate);
              return d > 0 && d <= 15;
            });

            let monthStatus = '';
            if (hasOverdue) monthStatus = 'overdue';
            else if (hasUrgent) monthStatus = 'urgent';
            else if (isCurrent) monthStatus = 'current';
            else if (isPast && monthSims.length === 0) monthStatus = 'past';

            return (
              <div key={month} className={`sim-month-section ${monthStatus}`}>
                {/* Month Header */}
                <div className="sim-month-header">
                  <div className="sim-month-name">
                    <span className="sim-month-full">{label}</span>
                    <span className="sim-month-short">{shortLabel}</span>
                    {isCurrent && <span className="sim-month-badge current">Actual</span>}
                    {hasOverdue && <span className="sim-month-badge overdue">{monthSims.filter(s => daysUntil(s.nextRechargeDate) <= 0).length} vencida{monthSims.filter(s => daysUntil(s.nextRechargeDate) <= 0).length !== 1 ? 's' : ''}</span>}
                  </div>
                  <span className="sim-month-count">
                    {monthSims.length > 0 ? `${monthSims.length} SIM${monthSims.length !== 1 ? 's' : ''}` : '—'}
                  </span>
                </div>

                {/* SIM Cards */}
                {monthSims.length > 0 && (
                  <div className="sim-number-list">
                    {monthSims.map(sim => {
                      const dLeft = daysUntil(sim.nextRechargeDate);
                      const urgency = getUrgencyLevel(dLeft);
                      const carrier = resolveSimCarrier(sim);
                      const carrierCfg = CARRIER_CONFIG[carrier];
                      return (
                        <div key={sim.lankAccountId} className={`sim-number-card ${urgency}`}>
                          <div className="sim-number-info">
                            <div className="sim-number-top">
                              <span className="sim-number-id">#{sim.lankAccountId}</span>
                              <span className="sim-number-alias">{sim.canonicalAlias || sim.fullName}</span>
                              {carrierCfg && (
                                <span className="sim-carrier-badge" style={{
                                  background: carrierCfg.color + '22',
                                  color: carrierCfg.color,
                                }}>{carrierCfg.label}</span>
                              )}
                            </div>
                            <div className="sim-number-details">
                              <span className="sim-number-phone sim-phone-highlight">
                                <PhoneIcon size={13} /> {formatPhone(sim.phone)}
                              </span>
                              <span className="sim-number-dates">
                                Últ: {formatDateShort(sim.lastRechargeDate)}
                              </span>
                            </div>
                          </div>
                          <div className="sim-number-right">
                            <span
                              className="sim-number-urgency"
                              style={{ color: getUrgencyColor(urgency) }}
                            >
                              {dLeft !== Infinity ? getUrgencyLabel(dLeft) : '—'}
                            </span>
                            <button
                              className="sim-recharge-btn"
                              title="Registrar recarga"
                              onClick={() => setRechargeModal({
                                lankAccountId: sim.lankAccountId,
                                name: sim.canonicalAlias || sim.fullName,
                                rechargeDate: todayLocal(),
                              })}
                            >
                              <CheckCircleIcon size={13} />
                              <span>Recarga</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {monthSims.length === 0 && (
                  <div className="sim-month-empty">Sin recargas programadas</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pending first recharge */}
      {pendingSims.length > 0 && (
        <div className="finance-section" style={{ marginTop: '8px' }}>
          <div className="sim-month-section" style={{ borderLeft: '3px solid var(--accent-warning, #f59e0b)' }}>
            <div className="sim-month-header">
              <div className="sim-month-name">
                <span className="sim-month-full">Pendientes de primera recarga</span>
                <span className="sim-month-badge overdue">{pendingSims.length} sin fecha</span>
              </div>
              <span className="sim-month-count">
                {pendingSims.length} SIM{pendingSims.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="sim-number-list">
              {pendingSims.map(sim => {
                const carrier = resolveSimCarrier(sim);
                const carrierCfg = CARRIER_CONFIG[carrier];
                return (
                  <div key={sim.lankAccountId} className="sim-number-card warning">
                    <div className="sim-number-info">
                      <div className="sim-number-top">
                        <span className="sim-number-id">#{sim.lankAccountId}</span>
                        <span className="sim-number-alias">{sim.canonicalAlias || sim.fullName}</span>
                        {carrierCfg && (
                          <span className="sim-carrier-badge" style={{
                            background: carrierCfg.color + '22',
                            color: carrierCfg.color,
                          }}>{carrierCfg.label}</span>
                        )}
                      </div>
                      <div className="sim-number-details">
                        <span className="sim-number-phone sim-phone-highlight">
                          <PhoneIcon size={13} /> {formatPhone(sim.phone) || '—'}
                        </span>
                        <span className="sim-number-dates" style={{ color: 'var(--accent-warning)' }}>
                          Sin recarga registrada
                        </span>
                      </div>
                    </div>
                    <div className="sim-number-right">
                      <span className="sim-number-urgency" style={{ color: 'var(--accent-warning)' }}>
                        Pendiente
                      </span>
                      <button
                        className="sim-recharge-btn"
                        title="Registrar primera recarga"
                        onClick={() => setRechargeModal({
                          lankAccountId: sim.lankAccountId,
                          name: sim.canonicalAlias || sim.fullName,
                          rechargeDate: todayLocal(),
                        })}
                      >
                        <CheckCircleIcon size={13} />
                        <span>1ª Recarga</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Unregistered accounts (legacy — accounts created before auto-add) */}
      {unregisteredAccounts.length > 0 && (
        <div className="finance-section" style={{ marginTop: '8px' }}>
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

      {/* Modal: Add SIM */}
      {addModal && (
        <EditModal
          open
          onClose={() => { setAddModal(null); setAddCarrier('telcel'); }}
          onSave={handleAddSim}
          title="Agregar SIM Card"
          fields={[
            {
              key: 'lankAccountId', label: 'Cuenta Lank', type: 'select',
              options: unregisteredAccounts.map(a => ({ value: a.id, label: `#${a.id} — ${a.canonicalAlias} (${a.fullName})` })),
              required: true,
            },
            {
              key: 'carrier', label: 'Compañía', type: 'select',
              options: Object.entries(CARRIER_CONFIG).map(([k, v]) => ({ value: k, label: v.label })),
              required: true,
            },
            {
              key: 'lastRechargeDate', label: 'Fecha de última recarga', type: 'date',
              required: true,
              hint: `Fórmula: ${getRechargeFormulaText(addCarrier)}`,
            },
          ]}
          values={{ ...addModal, carrier: addCarrier }}
          onChange={(key, val) => {
            if (key === 'carrier') {
              setAddCarrier(val);
            } else {
              setAddModal(prev => ({ ...prev, [key]: key === 'lankAccountId' ? Number(val) : val }));
            }
          }}
          saveLabel={<><PlusIcon size={14} /> Agregar SIM</>}
        />
      )}

      {/* Modal: Individual recharge */}
      {rechargeModal && (
        <RechargeModal
          sim={sims.find(s => s.lankAccountId === rechargeModal.lankAccountId) || rechargeModal}
          initialDate={rechargeModal.rechargeDate}
          onConfirm={async (rechargeDate) => {
            const updated = await markSimRechargeComplete(sims, rechargeModal.lankAccountId, rechargeDate);
            setSims(updated);
            showToast('Recarga registrada correctamente');
          }}
          onClose={() => setRechargeModal(null)}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </>
  );
}
