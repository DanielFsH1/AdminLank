import { useMemo, useState, useEffect } from 'react';
import { signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { useCollection, useDocument } from '../hooks/useFirestore';
import { BarChartIcon, KeyIcon, UsersIcon, BellIcon, MoneyIcon, AnalyzeIcon, LockIcon, ToolboxIcon, DoorIcon, NotepadIcon, LinkIcon, MenuIcon } from './Icons';

// SIM Card icon for sidebar
const SimCardIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <path d="M4 7V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>
    <path d="M8 12h8"/><path d="M8 16h8"/><path d="M12 12v4"/>
  </svg>
);

// Icon mapping for health/status tab
const StatusIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>
);

// History/changelog icon
const HistoryIcon = (props) => (
  <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: 'middle' }}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
    <path d="M3 3v5h5"/>
    <path d="M12 7v5l4 2"/>
  </svg>
);

const NAV_ITEMS = [
  { id: 'overview', icon: BarChartIcon, label: 'Resumen' },
  { id: 'subscriptions', icon: KeyIcon, label: 'Suscripciones' },
  { id: 'accounts', icon: UsersIcon, label: 'Cuentas Lank' },
  { id: 'alerts', icon: BellIcon, label: 'Alertas', badgeKey: 'alerts' },
  { id: 'finance', icon: MoneyIcon, label: 'Finanzas', badgeKey: 'finance' },
  { id: 'snowball', icon: LinkIcon, label: 'Bola de Nieve' },
  { id: 'vault', icon: LockIcon, label: 'Bóveda' },
  { id: 'sim-cards', icon: SimCardIcon, label: 'SIM Cards', badgeKey: 'simCards' },
  { id: 'analyze', icon: AnalyzeIcon, label: 'Analizar' },
];

const SYSTEM_ITEMS = [
  { id: 'history', icon: HistoryIcon, label: 'Historial' },
  { id: 'notes', icon: NotepadIcon, label: 'Notas' },
  { id: 'status', icon: StatusIcon, label: 'Estado' },
  { id: 'tools', icon: ToolboxIcon, label: 'Herramientas' },
];

export default function Sidebar({ activeTab, onTabChange, mobileOpen, onClose, collapsed = false, onToggleCollapsed }) {
  const { data: alerts } = useCollection('alerts');
  const { data: ledger } = useDocument('finance', 'manual-ledger', { realtime: true });
  const [simOverdueCount, setSimOverdueCount] = useState(0);

  const pendingCount = useMemo(() => {
    return alerts.filter(a => a.status === 'pending').length;
  }, [alerts]);

  const financePendingCount = useMemo(() => {
    const entries = ledger?.entries || [];
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return entries.filter(e => {
      if (e.status !== 'pending') return false;
      if (e.type === 'deposit' || e.type === 'credit_payment') return false;
      const eMonth = (e.effectiveAt || '').slice(0, 7);
      return eMonth === monthKey;
    }).length;
  }, [ledger]);

  useEffect(() => {
    getDoc(doc(db, 'config', 'sim-cards')).then(snap => {
      if (!snap.exists()) return;
      const sims = snap.data().sims || [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const count = sims.filter(s => {
        if (!s.nextRechargeDate) return false;
        const d = new Date(s.nextRechargeDate + 'T12:00:00');
        return d <= today;
      }).length;
      setSimOverdueCount(count);
    }).catch(() => {});
  }, []);

  const badgeCounts = useMemo(() => ({
    alerts: pendingCount,
    finance: financePendingCount,
    simCards: simOverdueCount,
  }), [pendingCount, financePendingCount, simOverdueCount]);

  const handleLogout = async () => {
    if (window.confirm('¿Cerrar sesión?')) {
      await signOut(auth);
    }
  };

  return (
    <>
      <div className={`sidebar-overlay ${mobileOpen ? 'open' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${mobileOpen ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-logo" aria-hidden="true">AL</div>
            <div className="sidebar-brand-copy">
              <h2>AdminLank</h2>
              <span>v2.1 Firebase</span>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expandir barra lateral' : 'Ocultar barra lateral'}
            aria-label={collapsed ? 'Expandir barra lateral' : 'Ocultar barra lateral'}
          >
            <MenuIcon size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Principal</div>
          {NAV_ITEMS.map(item => {
            const IconComp = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => { onTabChange(item.id); onClose(); }}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon"><IconComp size={18} /></span>
                <span className="nav-label">{item.label}</span>
                {item.badgeKey && badgeCounts[item.badgeKey] > 0 && (
                  <span className="nav-badge">{badgeCounts[item.badgeKey]}</span>
                )}
              </button>
            );
          })}
          <div className="nav-section-label" style={{ marginTop: '12px' }}>Sistema</div>
          {SYSTEM_ITEMS.map(item => {
            const IconComp = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => { onTabChange(item.id); onClose(); }}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon"><IconComp size={18} /></span>
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">D</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">DanielFsH1</div>
              <div className="sidebar-user-role">Administrador</div>
            </div>
            <button className="btn-logout" onClick={handleLogout} title="Cerrar sesión">
              <DoorIcon size={18} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
