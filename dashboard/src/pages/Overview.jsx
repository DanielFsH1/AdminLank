import { useCollection, useDocument } from '../hooks/useFirestore';
import { useState, useEffect, useRef, useMemo } from 'react';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { SERVICES, getServiceMeta, formatMXN, getPoolServiceKeys } from '../config/services';
import { UsersIcon, CheckCircleIcon, KeyIcon, BellIcon, AtmIcon, ClipboardIcon, InboxIcon } from '../components/Icons';

export default function Overview({ onNavigate, servicesConfig }) {
  const SERVICE_KEYS = useMemo(() => getPoolServiceKeys(), [servicesConfig]);
  const { data: accounts, loading: loadingAccounts } = useCollection('accounts');
  const { data: groups, loading: loadingGroups } = useCollection('groups');
  const { data: pools } = useCollection('service-pools');
  const { data: alerts } = useCollection('alerts');
  const { data: finOverview } = useDocument('finance', 'overview');
  const { data: actionableDoc } = useDocument('analysis', 'actionable-events');
  const analysisEvents = actionableDoc?.events || [];
  const [serviceStats, setServiceStats] = useState({});
  const [statsReady, setStatsReady] = useState(false);
  const loadedServicesRef = useRef(new Set());

  // ─── Notificaciones (solo conteo) ───
  const [notifications, setNotifications] = useState([]);
  const [readUids, setReadUids] = useState(new Set());

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'notifications'), snap => {
      const notifs = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
      setNotifications(notifs);
    });
    const unsubReads = onSnapshot(doc(db, 'config', 'notification-reads'), snap => {
      if (snap.exists()) setReadUids(new Set(snap.data().readUids || []));
    });
    return () => { unsub(); unsubReads(); };
  }, []);

  const totalNotifs = useMemo(() =>
    notifications.reduce((sum, n) => sum + (n.items?.length || 0), 0), [notifications]);
  const unreadCount = useMemo(() =>
    notifications.reduce((sum, n) =>
      sum + (n.items || []).filter(i => !readUids.has(String(i.uid))).length, 0),
    [notifications, readUids]);

  // Service stats
  useEffect(() => {
    if (groups.length === 0) return;
    loadedServicesRef.current = new Set();
    setStatsReady(false);
    const unsubs = [];
    groups.forEach(group => {
      const colRef = collection(db, `groups/${group.id}/lank-accounts`);
      const unsub = onSnapshot(colRef, snap => {
        const docs = snap.docs.map(d => d.data());
        const active = docs.filter(d => d.groupStatus === 'active');
        const totalUsers = active.reduce((s, d) => s + (d.users?.length || 0), 0);
        setServiceStats(prev => ({
          ...prev,
          [group.id]: {
            serviceName: getServiceMeta(group.id).name,
            activeAccounts: active.length,
            totalUsers,
            totalAccounts: docs.length,
          }
        }));
        loadedServicesRef.current.add(group.id);
        if (loadedServicesRef.current.size >= groups.length) {
          setStatsReady(true);
        }
      });
      unsubs.push(unsub);
    });
    return () => unsubs.forEach(u => u());
  }, [groups]);

  if (loadingAccounts || loadingGroups) {
    return <div className="loading-container"><div className="loading-spinner"></div></div>;
  }

  const totalActiveUsers = Object.values(serviceStats).reduce((s, v) => s + v.totalUsers, 0);

  // Conteo unificado: alertas de Firestore + actionable-events (sin duplicados)
  const TERMINAL_STATUSES = ['completed', 'done', 'discarded', 'cancelled_by_ai', 'resolved'];
  const firestorePending = alerts.filter(a => a.status === 'pending');
  // Alertas resueltas: todas las que tienen un status terminal
  const resolvedAlerts = alerts.filter(a => TERMINAL_STATUSES.includes(a.status));
  const extraFromAnalysis = analysisEvents.filter(ae => {
    // Excluir si ya tiene una alerta (cualquier estado) para el mismo usuario/cuenta/servicio
    const hasAlert = [...firestorePending, ...resolvedAlerts].some(a =>
      a.userAlias === ae.userName &&
      String(a.accountId) === String(ae.accountId) &&
      a.service === ae.subscription
    );
    return !hasAlert;
  });
  const pendingAlerts = firestorePending.length + extraFromAnalysis.length;

  const totals = finOverview?.totals || {};
  const accountsReady = !loadingAccounts && accounts.length > 0;

  return (
    <>
      {/* Stats principales */}
      <div className="stats-grid">
        <div className="stat-card" style={{ '--card-accent': 'var(--accent-primary)', cursor: 'pointer' }} onClick={() => onNavigate?.('accounts')}>
          <div className="stat-card-icon"><UsersIcon size={24} /></div>
          <div className="stat-card-value">{accountsReady ? accounts.length : '—'}</div>
          <div className="stat-card-label">Cuentas Lank</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--accent-success)' }}>
          <div className="stat-card-icon"><CheckCircleIcon size={24} /></div>
          <div className="stat-card-value">{statsReady ? totalActiveUsers : '—'}</div>
          <div className="stat-card-label">Usuarios activos</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': 'var(--accent-secondary)', cursor: 'pointer' }} onClick={() => onNavigate?.('subscriptions')}>
          <div className="stat-card-icon"><KeyIcon size={24} /></div>
          <div className="stat-card-value">{pools.length}</div>
          <div className="stat-card-label">Pools de cuentas</div>
        </div>
        <div className="stat-card" style={{ '--card-accent': pendingAlerts > 0 ? 'var(--accent-danger)' : 'var(--accent-warning)', cursor: 'pointer' }} onClick={() => onNavigate?.('alerts')}>
          <div className="stat-card-icon"><BellIcon size={24} /></div>
          <div className="stat-card-value">{pendingAlerts}</div>
          <div className="stat-card-label">Alertas pendientes</div>
        </div>
        <div
          className="stat-card"
          style={{ '--card-accent': unreadCount > 0 ? '#8b5cf6' : 'var(--text-muted)', cursor: 'pointer' }}
          onClick={() => onNavigate?.('analyze', { view: 'notificaciones' })}
        >
          <div className="stat-card-icon"><InboxIcon size={24} /></div>
          <div className="stat-card-value">{unreadCount}</div>
          <div className="stat-card-label">Notificaciones</div>
          {totalNotifs > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {totalNotifs} total
            </div>
          )}
        </div>
        {totals.bankNetAfterExpenses != null && (
          <div className="stat-card" style={{ '--card-accent': '#22d3ee', cursor: 'pointer' }} onClick={() => onNavigate?.('finance')}>
            <div className="stat-card-icon"><AtmIcon size={24} /></div>
            <div className="stat-card-value">{formatMXN(totals.bankNetAfterExpenses)}</div>
            <div className="stat-card-label">Neto bancario</div>
          </div>
        )}
      </div>

      {/* Servicios */}
      <div className="section-header">
        <div className="section-title"><ClipboardIcon size={18} /> Servicios</div>
      </div>
      {statsReady ? (
      <div className="services-grid">
        {Object.entries(serviceStats)
          .sort((a, b) => b[1].totalUsers - a[1].totalUsers)
          .map(([serviceId, stats]) => {
            const meta = getServiceMeta(serviceId);
            return (
              <div className="service-card" key={serviceId} onClick={() => onNavigate?.('subscriptions')} style={{ cursor: 'pointer' }}>
                <div className="service-card-header">
                  <div className="service-card-title">
                    <img src={meta.logo} className="svc-logo-sm" alt="" />
                    <h3>{stats.serviceName}</h3>
                  </div>
                  <div className="service-card-stats">
                    <span><strong>{stats.activeAccounts}</strong> grupos</span>
                    <span><strong>{stats.totalUsers}</strong> usuarios</span>
                  </div>
                </div>
                <div className="service-card-body">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span className="badge badge-success">{stats.activeAccounts} activos</span>
                    <span className="badge badge-muted">{stats.totalAccounts - stats.activeAccounts} inactivos</span>
                  </div>
                </div>
              </div>
            );
          })}
      </div>
      ) : (
        <div className="services-grid">
          {SERVICE_KEYS.map(k => (
            <div className="service-card" key={k} style={{ opacity: 0.4, minHeight: '90px' }}>
              <div className="service-card-header">
                <div className="service-card-title">
                  <img src={getServiceMeta(k).logo} className="svc-logo-sm" alt="" />
                  <h3>{getServiceMeta(k).name}</h3>
                </div>
              </div>
              <div className="service-card-body">
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Cargando...</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
