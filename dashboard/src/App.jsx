import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { onSnapshot, doc as firestoreDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { setDynamicServices } from './config/services';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { getPageTransitionClass } from './utils/pageChrome';
import {
  formatSidebarCollapsedValue,
  getSidebarLayoutClass,
  parseStoredSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
} from './utils/sidebarLayout';
import Login from './components/Login';
import LoadingState from './components/LoadingState';
import Sidebar from './components/Sidebar';
import Overview from './pages/Overview';
import { MenuIcon, SunIcon, MoonIcon, WarningIcon, CheckCircleIcon } from './components/Icons';
import './index.css';

const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Finance = lazy(() => import('./pages/Finance'));
const Snowball = lazy(() => import('./pages/Snowball'));
const Analyze = lazy(() => import('./pages/Analyze'));
const Status = lazy(() => import('./pages/Status'));
const Tools = lazy(() => import('./pages/Tools'));
const Vault = lazy(() => import('./pages/Vault'));
const History = lazy(() => import('./pages/History'));
const SimCards = lazy(() => import('./pages/SimCards'));
const Notes = lazy(() => import('./pages/Notes'));

const TAB_ORDER = ['overview','subscriptions','accounts','alerts','finance','snowball','vault','sim-cards','analyze','history','notes','status','tools'];

const TAB_TITLES = {
  overview: 'Resumen General',
  subscriptions: 'Suscripciones',
  accounts: 'Cuentas Lank',
  alerts: 'Alertas',
  finance: 'Finanzas',
  snowball: 'Efecto Bola de Nieve',
  'sim-cards': 'SIM Cards',
  analyze: 'Analizar',
  status: 'Estado del Sistema',
  tools: 'Herramientas',
  vault: 'Bóveda',
  notes: 'Notas',
  history: 'Historial',
};

const TAB_SHORT = {
  overview: 'Resumen',
  subscriptions: 'Suscripciones',
  accounts: 'Cuentas',
  alerts: 'Alertas',
  finance: 'Finanzas',
  snowball: 'Snowball',
  'sim-cards': 'SIM Cards',
  analyze: 'Analizar',
  vault: 'Bóveda',
  notes: 'Notas',
  status: 'Estado',
  tools: 'Herramientas',
  history: 'Historial',
};

const TAB_SUBTITLES = {
  overview: 'Vista global del sistema',
  subscriptions: 'Pools y cuentas reales',
  accounts: 'Registro de cuentas Lank',
  alerts: 'Notificaciones y advertencias',
  finance: 'Ingresos, egresos y reportes',
  snowball: 'Cadenas de CLABEs internas Lank',
  'sim-cards': 'Control de recargas de tarjetas SIM',
  analyze: 'Procesamiento de correos',
  status: 'Salud y monitoreo de servicios',
  tools: 'Exportación, estadísticas y mantenimiento',
  vault: 'Credenciales, contraseñas y tarjetas',
  notes: 'Bloc de notas general',
  history: 'Registro de todos los cambios del sistema',
};

function PageFallback() {
  return <LoadingState variant="page" />;
}

function App() {
  const [user, setUser] = useState(undefined);
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() => (
    parseStoredSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY))
  ));
  const [theme, setTheme] = useState(() => localStorage.getItem('adminlank-theme') || 'dark');
  const [navData, setNavData] = useState(null); // cross-linking data
  const [appToast, setAppToast] = useState(null);
  const [slideDir, setSlideDir] = useState(null); // 'left' | 'right' | null — animación de transición
  const activeTabRef = useRef(activeTab); // ref para acceder desde event handlers nativos
  const { isOnline, wasOffline } = useOnlineStatus();

  // Sincronizar ref con estado
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // Cambio de pestaña unificado con animación
  const changeTab = useCallback((newTab, opts = {}) => {
    const currentIdx = TAB_ORDER.indexOf(activeTabRef.current);
    const newIdx = TAB_ORDER.indexOf(newTab);
    if (newIdx === currentIdx || newIdx < 0) return;

    const dir = opts.direction || (newIdx > currentIdx ? 'left' : 'right');
    setSlideDir(dir);
    if (!opts.keepNavData) setNavData(null);
    setActiveTab(newTab);
  }, []);

  // Swipe navigation — usa eventos nativos para mejor compatibilidad móvil
  const mainBodyRef = useRef(null);

  useEffect(() => {
    const el = mainBodyRef.current;
    if (!el) return;

    let startX = 0, startY = 0, endX = 0, endY = 0;
    let touchTarget = null;

    const onTouchStart = (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      endX = startX;
      endY = startY;
      touchTarget = e.target;
    };
    const onTouchMove = (e) => {
      endX = e.touches[0].clientX;
      endY = e.touches[0].clientY;
    };
    const onTouchEnd = () => {
      const dx = endX - startX;
      const dy = endY - startY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
        // No hacer swipe si hay un modal abierto (PIN gate de Bóveda NO bloquea)
        if (document.querySelector('.vault-modal-overlay, .tools-modal-overlay, .edit-modal-overlay')) return;

        // No hacer swipe si el toque inicio dentro de un contenedor con scroll horizontal
        // PERO permitir swipe si el contenedor está en el extremo correspondiente
        if (touchTarget) {
          let node = touchTarget;
          while (node && node !== el) {
            if (node.scrollWidth > node.clientWidth + 2) {
              const ov = getComputedStyle(node).overflowX;
              if (ov === 'auto' || ov === 'scroll') {
                const atStart = node.scrollLeft <= 2;
                const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 2;
                if ((dx < 0 && !atEnd) || (dx > 0 && !atStart)) return;
              }
            }
            node = node.parentElement;
          }
        }

        const currentIdx = TAB_ORDER.indexOf(activeTabRef.current);
        if (dx < 0 && currentIdx < TAB_ORDER.length - 1) {
          changeTab(TAB_ORDER[currentIdx + 1], { direction: 'left' });
        } else if (dx > 0 && currentIdx > 0) {
          changeTab(TAB_ORDER[currentIdx - 1], { direction: 'right' });
        }
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [user, changeTab]); // Re-ejecutar cuando user pasa de undefined → autenticado

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    return () => unsub();
  }, []);

  // Listener dinámico de config/services
  const [servicesConfig, setServicesConfig] = useState(null);
  useEffect(() => {
    const unsub = onSnapshot(firestoreDoc(db, 'config', 'services'), snap => {
      if (snap.exists()) {
        const data = snap.data();
        const svcs = data.services || {};
        setDynamicServices(svcs);
        setServicesConfig(svcs);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('adminlank-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      formatSidebarCollapsedValue(desktopSidebarCollapsed)
    );
  }, [desktopSidebarCollapsed]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
  const toggleDesktopSidebar = () => setDesktopSidebarCollapsed(value => !value);

  // Cross-navigation handler (con animación)
  const handleNavigate = useCallback((tab, data) => {
    setNavData(data);
    const currentIdx = TAB_ORDER.indexOf(activeTabRef.current);
    const newIdx = TAB_ORDER.indexOf(tab);
    if (newIdx >= 0 && newIdx !== currentIdx) {
      setSlideDir(newIdx > currentIdx ? 'left' : 'right');
    }
    setActiveTab(tab);
  }, []);

  if (user === undefined) {
    return <LoadingState variant="page" className="app-loading-state" />;
  }
  if (!user) return <Login />;

  const renderPage = () => {
    switch (activeTab) {
      case 'overview': return <Overview onNavigate={handleNavigate} servicesConfig={servicesConfig} />;
      case 'subscriptions': return <Subscriptions onNavigate={handleNavigate} navData={navData} servicesConfig={servicesConfig} />;
      case 'accounts': return <Accounts navData={navData} onNavigate={handleNavigate} servicesConfig={servicesConfig} />;
      case 'alerts': return <Alerts onNavigate={handleNavigate} navData={navData} servicesConfig={servicesConfig} />;
      case 'finance': return <Finance />;
      case 'snowball': return <Snowball />;
      case 'sim-cards': return <SimCards onNavigate={handleNavigate} />;
      case 'analyze': return <Analyze onNavigate={handleNavigate} navData={navData} servicesConfig={servicesConfig} />;
      case 'status': return <Status />;
      case 'tools': return <Tools />;
      case 'vault': return <Vault onNavigate={handleNavigate} navData={navData} servicesConfig={servicesConfig} />;
      case 'notes': return <Notes />;
      case 'history': return <History navData={navData} onNavigate={handleNavigate} />;
      default: return <Overview onNavigate={handleNavigate} servicesConfig={servicesConfig} />;
    }
  };

  // Breadcrumb: pestañas adyacentes
  const tabIdx = TAB_ORDER.indexOf(activeTab);
  const prevTab = tabIdx > 0 ? TAB_ORDER[tabIdx - 1] : null;
  const nextTab = tabIdx < TAB_ORDER.length - 1 ? TAB_ORDER[tabIdx + 1] : null;

  return (
    <div className={getSidebarLayoutClass(desktopSidebarCollapsed)}>
      <Sidebar
        activeTab={activeTab}
        onTabChange={(tab) => changeTab(tab)}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={desktopSidebarCollapsed}
        onToggleCollapsed={toggleDesktopSidebar}
      />

      <div className="main-content">
        <div className="main-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="mobile-menu-btn" onClick={() => setMobileOpen(true)}><MenuIcon size={20} /></button>
              <div>
                <h1>{TAB_TITLES[activeTab]}</h1>
                <div className="header-subtitle">{TAB_SUBTITLES[activeTab]}</div>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}>
              {theme === 'dark' ? <SunIcon size={20} /> : <MoonIcon size={20} />}
            </button>
            <div className={`header-live ${isOnline ? '' : 'offline'}`}>
              <div className={`live-dot ${isOnline ? '' : 'offline'}`}></div>
              {isOnline ? 'En vivo' : 'Sin conexión'}
            </div>
          </div>
        </div>

        {/* Breadcrumb de navegación — solo visible en móvil */}
        <div className="tab-breadcrumb">
          <span
            className={`tab-bc-side ${prevTab ? '' : 'invisible'}`}
            onClick={() => prevTab && changeTab(prevTab, { direction: 'right' })}
          >
            ‹ {prevTab ? TAB_SHORT[prevTab] : ''}
          </span>
          <span className="tab-bc-active">
            {TAB_SHORT[activeTab]}
            <span className="tab-bc-pos">{tabIdx + 1}/{TAB_ORDER.length}</span>
          </span>
          <span
            className={`tab-bc-side ${nextTab ? '' : 'invisible'}`}
            onClick={() => nextTab && changeTab(nextTab, { direction: 'left' })}
          >
            {nextTab ? TAB_SHORT[nextTab] : ''} ›
          </span>
        </div>

        <div className="main-body" ref={mainBodyRef}>
          <div
            className={getPageTransitionClass(slideDir)}
            onAnimationEnd={event => {
              if (event.currentTarget === event.target) setSlideDir(null);
            }}
          >
            <Suspense fallback={<PageFallback />}>
              {renderPage()}
            </Suspense>
          </div>
        </div>

        {/* Tab dots indicator — solo visible en móvil via CSS */}
        <div className="tab-dots">
          {TAB_ORDER.map(tab => (
            <button
              key={tab}
              className={`tab-dot ${activeTab === tab ? 'active' : ''}`}
              onClick={() => changeTab(tab)}
              aria-label={TAB_TITLES[tab]}
            />
          ))}
        </div>
      </div>

      {/* Banner de conexión */}
      {!isOnline && (
        <div className="offline-banner">
          <WarningIcon size={16} /> Sin conexión — Los cambios se guardarán cuando vuelva el internet
        </div>
      )}
      {wasOffline && isOnline && (
        <div className="offline-banner reconnected">
          <CheckCircleIcon size={16} /> Conexión restaurada — Sincronizando cambios
        </div>
      )}

      {/* Toast global para cobros recurrentes */}
      {appToast && (
        <div
          className="app-toast"
          style={{
            position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999,
            background: '#10b981', color: '#fff', padding: '12px 20px',
            borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,.3)',
            fontSize: '14px', fontWeight: 500, animation: 'fadeIn .3s ease',
            cursor: 'pointer'
          }}
          onClick={() => setAppToast(null)}
          onAnimationEnd={() => setTimeout(() => setAppToast(null), 4000)}
        >
          {appToast}
        </div>
      )}
    </div>
  );
}

export default App;
