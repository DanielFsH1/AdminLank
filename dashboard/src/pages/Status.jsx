import { useState, useEffect, useCallback } from 'react';
import { limit } from 'firebase/firestore';
import { useCollection, useDocument } from '../hooks/useFirestore';
import { useAdminbotState } from '../hooks/adminbotState';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { AnalyzeIcon, BarChartIcon, BellIcon, BuildIcon, CheckIcon, ClipboardIcon, ClockIcon, CloseIcon, DotGray, DotGreen, DotRed, DotYellow, EmailIcon, GlobeIcon, InboxIcon, KeyIcon, LightningIcon, LockKeyIcon, MailboxIcon, RefreshIcon, SatelliteIcon, SaveIcon, ServerIcon, TrendUpIcon, WarningIcon } from '../components/Icons';

const CLOUD_FN_BASE = '***REMOVED***';

const SERVICE_META = {
 firestore: { icon: <ServerIcon size={16} />, label: 'Cloud Firestore', desc: 'Base de datos principal' },
 account_registry: { icon: <ClipboardIcon size={16} />, label: 'Registro de Cuentas', desc: 'Cuentas Lank configuradas' },
 imap_credentials: { icon: <LockKeyIcon size={16} />, label: 'Credenciales IMAP', desc: 'App Passwords de Gmail' },
 imap_connectivity: { icon: <EmailIcon size={16} />, label: 'Conectividad IMAP', desc: 'Acceso a buzones de correo' },
 schedule: { icon: <ClockIcon size={16} />, label: 'Análisis Programado', desc: 'Cloud Scheduler + Functions' },
 last_analysis: { icon: <AnalyzeIcon size={16} />, label: 'Último Análisis', desc: 'Estado del análisis más reciente' },
 latest_report: { icon: <BarChartIcon size={16} />, label: 'Reporte de Análisis', desc: 'Datos del último reporte' },
 alerts: { icon: <BellIcon size={16} />, label: 'Sistema de Alertas', desc: 'Alertas y pendientes' },
 notifications: { icon: <MailboxIcon size={16} />, label: 'Notificaciones', desc: 'Historial de notificaciones' },
 subscription_groups: { icon: <KeyIcon size={16} />, label: 'Grupos de Suscripción', desc: 'Pools de servicios' },
};

const STATUS_CONFIG = {
 ok: { color: '#10b981', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.3)', label: 'Operativo', icon: <CheckIcon size={14} /> },
 warning: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.3)', label: 'Advertencia', icon: <WarningIcon size={16} /> },
 error: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', label: 'Error', icon: <CloseIcon size={16} /> },
 inactive: { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)', label: 'Inactivo', icon: '○' },
 checking: { color: '#6366f1', bg: 'rgba(99,102,241,0.1)', border: 'rgba(99,102,241,0.3)', label: 'Verificando...', icon: '◌' },
};

const OVERALL_CONFIG = {
 operational: { color: '#10b981', bg: 'rgba(16,185,129,0.08)', label: 'Todos los sistemas operativos', icon: <DotGreen /> },
 operational_with_warnings: { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', label: 'Operativo con advertencias', icon: <DotYellow /> },
 degraded: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', label: 'Servicio degradado', icon: <DotRed /> },
 unknown: { color: '#6b7280', bg: 'rgba(107,114,128,0.08)', label: 'Estado desconocido', icon: <DotGray /> },
};

function formatTimeAgo(isoStr) {
 if (!isoStr) return 'Nunca';
 try {
 const dt = new Date(isoStr);
 const now = new Date();
 const diff = (now - dt) / 1000;
 if (diff < 60) return 'Hace unos segundos';
 if (diff < 3600) return `Hace ${Math.floor(diff / 60)} min`;
 if (diff < 86400) return `Hace ${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}min`;
 return `Hace ${Math.floor(diff / 86400)} día(s)`;
 } catch { return isoStr; }
}

function formatDate(isoStr) {
 if (!isoStr) return '—';
 try {
 return new Date(isoStr).toLocaleString('es-MX', {
      dateStyle: 'medium', timeStyle: 'short',
 });
 } catch { return isoStr; }
}

/* ── Detail renderers per service key ─────────────────────────────────────── */

function DetailRow({ label, value, color }) {
 return (
 <div className="status-detail-kv">
      <span className="status-detail-kv-label">{label}</span>
      <span className="status-detail-kv-value" style={color ? { color } : undefined}>{value}</span>
 </div>
 );
}

function renderHostingDetails() {
 return (
 <div className="status-detail-info">
      <DetailRow label="URL" value="adminlank.web.app" />
      <DetailRow label="Protocolo" value="HTTPS / HTTP2" />
      <DetailRow label="CDN" value="Firebase Global CDN" />
      <DetailRow label="Framework" value="React + Vite" />
      <DetailRow label="Verificación" value="Si esta página cargó, Hosting funciona" color="#10b981" />
 </div>
 );
}

function renderCloudFunctionsDetails(check, elapsedMs) {
 return (
 <div className="status-detail-info">
      <DetailRow label="Región" value="us-central1" />
      <DetailRow label="Runtime" value="Python 3.12 (2nd Gen)" />
      <DetailRow label="Latencia health_check" value={`${elapsedMs || '?'}ms`} color={elapsedMs > 2000 ? '#f59e0b' : '#10b981'} />
      <DetailRow label="Funciones desplegadas" value="analyze_emails, update_schedule, get_schedule, health_check, scheduled_analysis" />
      <DetailRow label="Cloud Run" value="Servicios activos en us-central1" />
 </div>
 );
}

function renderFirestoreDetails(check) {
 return (
 <div className="status-detail-info">
      <DetailRow label="Base de datos" value="(default)" />
      <DetailRow label="Ubicación" value="nam5 (multi-región)" />
      <DetailRow label="Conexión" value={check.message || 'OK'} color="#10b981" />
      <DetailRow label="Colecciones principales" value="config, analysis, alerts, notifications, groups, subscriptions, finance" />
      <DetailRow label="Reglas de seguridad" value="Abiertas (desarrollo)" color="#f59e0b" />
 </div>
 );
}

function renderAccountRegistryDetails(check) {
 return (
 <div className="status-detail-info">
      <DetailRow label="Total de cuentas" value={check.count ?? '?'} />
      <DetailRow label="Documento" value="config/account-registry" />
      <DetailRow label="Datos por cuenta" value="ID, nombre, alias, email Gmail, WhatsApp, notas" />
      <DetailRow label="Uso" value="Registro maestro de todas las cuentas Lank del negocio" />
 </div>
 );
}

function renderImapCredentialsDetails(check) {
 return (
 <div className="status-detail-info">
      <DetailRow label="App Passwords configuradas" value={check.count ?? '?'} color={check.count > 0 ? '#10b981' : '#f59e0b'} />
      <DetailRow label="Documento" value="config/imap-credentials" />
      <DetailRow label="Proveedor" value="Gmail (IMAP4 SSL)" />
      <DetailRow label="Puerto" value="993 (imap.gmail.com)" />
      <DetailRow label="Propósito" value="Lectura automática de correos para detectar eventos de suscripción" />
 </div>
 );
}

function renderImapConnectivityDetails(check) {
 return (
 <>
      {check.details && (
        <div className="status-detail-grid">
          {check.details.map((d, i) => {
            const ds = d.status === 'ok' ? STATUS_CONFIG.ok : STATUS_CONFIG.error;
            return (
              <div key={i} className="status-detail-item" style={{ borderLeft: `3px solid ${ds.color}` }}>
                <span className="status-detail-email">{d.email}</span>
                <span className="status-detail-status" style={{ color: ds.color }}>
                  {d.status === 'ok' ? <><CheckIcon size={14} /> OK</> : <><CloseIcon size={16} /> {d.error || 'Error'}</>}
                </span>
              </div>
            );
          })}
          {check.total > check.tested && (
            <div className="status-detail-note">
              Se verificaron {check.tested} de {check.total} cuentas (muestreo)
            </div>
          )}
        </div>
      )}
      <div className="status-detail-info" style={{ marginTop: check.details ? '10px' : 0 }}>
        <DetailRow label="Método de prueba" value="Login IMAP (sin descargar correos)" />
        <DetailRow label="Cuentas testeadas" value={`${check.tested || 0} de ${check.total || 0}`} />
        <DetailRow label="Servidor" value="imap.gmail.com:993 (SSL)" />
      </div>
 </>
 );
}

function renderScheduleDetails(check, realtimeSchedule) {
 const sched = realtimeSchedule || check;
 const enabled = sched.enabled;
 const freq = sched.frequencyHours;
 const startTime = sched.startTime;
 return (
 <div className="status-detail-info">
      <DetailRow label="Estado" value={enabled ? 'Activado' : 'Desactivado'} color={enabled ? '#10b981' : '#6b7280'} />
      <DetailRow label="Frecuencia" value={freq ? `Cada ${freq} hora(s)` : 'No configurada'} />
      <DetailRow label="Hora de inicio" value={startTime ? formatDate(startTime) : 'No configurada'} />
      <DetailRow label="Motor" value="Cloud Scheduler → Cloud Function (cada 6h)" />
      <DetailRow label="Ventana de ejecución" value="~6 horas después del slot programado" />
      <DetailRow label="Configuración" value="config/schedule en Firestore" />
 </div>
 );
}

function renderLastAnalysisDetails(check) {
 return (
 <div className="status-detail-info">
      <DetailRow label="Última ejecución" value={check.lastRun ? formatDate(check.lastRun) : 'Nunca'} />
      <DetailRow label="Antigüedad" value={check.hoursAgo !== undefined ? `${check.hoursAgo} horas` : '—'} color={check.hoursAgo > 48 ? '#f59e0b' : '#10b981'} />
      <DetailRow label="Documento" value="analysis/state" />
      <DetailRow label="Datos almacenados" value="Último UID procesado por cuenta, timestamp última ejecución" />
      <DetailRow label="Umbral de advertencia" value="Si pasan más de 48h sin análisis" />
 </div>
 );
}

function renderLatestReportDetails(check) {
 return (
 <>
      <div className="status-detail-report">
        <div className="status-detail-stat">
          <span className="status-detail-stat-value">{check.totalAccounts ?? '?'}</span>
          <span className="status-detail-stat-label">Cuentas</span>
        </div>
        <div className="status-detail-stat">
          <span className="status-detail-stat-value">{check.totalEmails ?? '?'}</span>
          <span className="status-detail-stat-label">Correos</span>
        </div>
        <div className="status-detail-stat">
          <span className="status-detail-stat-value" style={{ color: check.failedAccounts > 0 ? '#ef4444' : '#10b981' }}>
            {check.failedAccounts ?? '?'}
          </span>
          <span className="status-detail-stat-label">Fallidas</span>
        </div>
        {check.generatedAt && (
          <div className="status-detail-stat">
            <span className="status-detail-stat-value" style={{ fontSize: '14px' }}>
              {formatTimeAgo(check.generatedAt)}
            </span>
            <span className="status-detail-stat-label">Generado</span>
          </div>
        )}
      </div>
      <div className="status-detail-info" style={{ marginTop: '10px' }}>
        <DetailRow label="Documento" value="analysis/latest-report" />
        <DetailRow label="Generado" value={check.generatedAt ? formatDate(check.generatedAt) : '—'} />
      </div>
 </>
 );
}

function renderAlertsDetails(check, realtimeAlerts) {
 const total = realtimeAlerts?.total ?? check.total ?? 0;
 const pending = realtimeAlerts?.pending ?? check.pending ?? 0;
 const completed = total - pending;
 return (
 <div className="status-detail-info">
      <DetailRow label="Total de alertas" value={total} />
      <DetailRow label="Pendientes" value={pending} color={pending > 0 ? '#f59e0b' : '#10b981'} />
      <DetailRow label="Completadas/Descartadas" value={completed} color="#10b981" />
      <DetailRow label="Colección" value="alerts/" />
      <DetailRow label="Generación" value="Automática por el pipeline de análisis" />
      <DetailRow label="Tipos" value="Renovación, ingreso de usuario, salida, transferencia" />
 </div>
 );
}

function renderNotificationsDetails(check, realtimeNotifs) {
 const total = realtimeNotifs?.total ?? check.total ?? 0;
 return (
 <div className="status-detail-info">
      <DetailRow label="Total almacenadas" value={total} />
      <DetailRow label="Retención" value="7 días (limpieza automática)" />
      <DetailRow label="Colección" value="notifications/" />
      <DetailRow label="Contenido" value="Correos crudos recibidos por cada cuenta Lank" />
      <DetailRow label="Acumulación" value="Se acumulan entre análisis, se limpian tras 7 días" />
 </div>
 );
}

function renderGroupsDetails(check) {
 return (
 <>
      {check.groups && (
        <div className="status-detail-groups">
          {check.groups.map(g => (
            <span key={g} className="status-detail-group-tag">{g}</span>
          ))}
        </div>
      )}
      <div className="status-detail-info" style={{ marginTop: check.groups ? '10px' : 0 }}>
        <DetailRow label="Total de grupos" value={check.count ?? '?'} />
        <DetailRow label="Colección" value="groups/{serviceKey}" />
        <DetailRow label="Datos por grupo" value="Cuentas Lank asignadas, usuarios, estados, cupos" />
        <DetailRow label="Servicios" value="ChatGPT, YouTube, HBO, Spotify, F1 TV, etc." />
      </div>
 </>
 );
}

/* ── Main component ───────────────────────────────────────────────────────── */

export default function Status() {
 const adminbotState = useAdminbotState();
 const [healthData, setHealthData] = useState(null);
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState(null);
 const [lastChecked, setLastChecked] = useState(null);
 const [expandedService, setExpandedService] = useState(null);

 const { data: scheduleDoc } = useDocument('config/schedule');
 const { data: alerts } = useCollection('alerts', {
  constraints: [limit(100)],
  deps: [],
 });
 const { data: notifications } = useCollection('notifications', {
  constraints: [limit(50)],
  deps: [],
 });

 const runHealthCheck = useCallback(async () => {
 setLoading(true);
 setError(null);
 let lastErr = null;
 for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await authenticatedFetch(`${CLOUD_FN_BASE}/health_check`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${resp.statusText}`);
        const data = await resp.json();
        setHealthData(data);
        setLastChecked(new Date().toISOString());
        setLoading(false);
        return;
      } catch (e) {
        lastErr = e.message;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
 }
 setError(lastErr);
 setLoading(false);
 }, []);

 useEffect(() => { runHealthCheck(); }, [runHealthCheck]);

 // Real-time overrides
 const realtimeAlerts = alerts.length > 0
 ? { total: alerts.length, pending: alerts.filter(a => a.status === 'pending').length }
 : null;
 const realtimeNotifs = notifications.length > 0 ? { total: notifications.length } : null;
 const realtimeSchedule = scheduleDoc || null;

 const overall = healthData?.overall || (error ? 'degraded' : 'unknown');
 const overallCfg = OVERALL_CONFIG[overall] || OVERALL_CONFIG.unknown;
 const checks = healthData?.checks || {};

 const hostingCheck = { status: 'ok', message: 'La página cargó correctamente' };
 const cfCheck = healthData
 ? { status: 'ok', message: `Respuesta en ${healthData.elapsedMs || '?'}ms` }
 : loading
      ? { status: 'checking', message: 'Verificando...' }
      : error
        ? { status: 'error', message: error }
        : { status: 'checking', message: 'Pendiente' };

 const allServices = [
 { key: 'hosting', icon: <GlobeIcon size={16} />, label: 'Firebase Hosting', desc: 'Sitio web del dashboard', check: hostingCheck },
 { key: 'cloud_functions', icon: <LightningIcon size={16} />, label: 'Cloud Functions', desc: 'Backend serverless', check: cfCheck },
 ...Object.entries(SERVICE_META).map(([key, meta]) => ({
      key, icon: meta.icon, label: meta.label, desc: meta.desc,
      check: checks[key] || (loading ? { status: 'checking', message: 'Verificando...' } : { status: 'checking', message: 'No verificado' }),
 })),
 ];

 /** Render the expanded details panel for a given service key */
 const renderDetailsForKey = (key, check) => {
 switch (key) {
      case 'hosting': return renderHostingDetails();
      case 'cloud_functions': return renderCloudFunctionsDetails(check, healthData?.elapsedMs);
      case 'firestore': return renderFirestoreDetails(check);
      case 'account_registry': return renderAccountRegistryDetails(check);
      case 'imap_credentials': return renderImapCredentialsDetails(check);
      case 'imap_connectivity': return renderImapConnectivityDetails(check);
      case 'schedule': return renderScheduleDetails(check, realtimeSchedule);
      case 'last_analysis': return renderLastAnalysisDetails(check);
      case 'latest_report': return renderLatestReportDetails(check);
      case 'alerts': return renderAlertsDetails(check, realtimeAlerts);
      case 'notifications': return renderNotificationsDetails(check, realtimeNotifs);
      case 'subscription_groups': return renderGroupsDetails(check);
      default: return <DetailRow label="Estado" value={check.message || '—'} />;
 }
 };

 const renderServiceCard = (service) => {
 const { key, icon, label, desc, check } = service;
 const st = STATUS_CONFIG[check.status] || STATUS_CONFIG.checking;
 const isExpanded = expandedService === key;

 return (
      <div
        key={key}
        className={`status-service-card ${isExpanded ? 'expanded' : ''}`}
        onClick={() => setExpandedService(isExpanded ? null : key)}
        style={{ cursor: 'pointer' }}
      >
        <div className="status-service-row">
          <div className="status-service-info">
            <span className="status-service-icon">{icon}</span>
            <div>
              <div className="status-service-label">{label}</div>
              <div className="status-service-desc">{desc}</div>
            </div>
          </div>
          <div className="status-service-right">
            <span className="status-service-msg" style={{ color: st.color }}>
              {check.message || st.label}
            </span>
            <span
              className="status-badge"
              style={{ background: st.bg, color: st.color, borderColor: st.border }}
            >
              <span className="status-badge-icon">{st.icon}</span>
              {st.label}
            </span>
            <span className={`status-chevron ${isExpanded ? 'open' : ''}`}>▸</span>
          </div>
        </div>

        {isExpanded && (
          <div className="status-service-details" onClick={e => e.stopPropagation()}>
            {renderDetailsForKey(key, check)}
          </div>
        )}
      </div>
 );
 };

 return (
 <>
      {/* Overall Status Banner */}
      <div className="status-banner" style={{ background: overallCfg.bg, borderColor: overallCfg.color }}>
        <div className="status-banner-left">
          <span className="status-banner-icon">{overallCfg.icon}</span>
          <div>
            <span className="status-banner-label" style={{ color: overallCfg.color }}>
              {loading ? 'Verificando todos los servicios...' : overallCfg.label}
            </span>
            <span className="status-banner-time">
              {lastChecked ? `Última verificación: ${formatTimeAgo(lastChecked)}` : 'Sin verificar'}
              {healthData?.elapsedMs && ` • ${healthData.elapsedMs}ms`}
            </span>
          </div>
        </div>
        <button
          className={`status-refresh-btn ${loading ? 'spinning' : ''}`}
          onClick={runHealthCheck}
          disabled={loading}
        >
          {loading ? '⟳ Verificando...' : <><RefreshIcon size={16} /> Verificar todo</>}
        </button>
      </div>

      {error && !healthData && (
        <div className="status-error-box">
          <span><WarningIcon size={16} /></span>
          <div>
            <strong>Error al conectar con el backend</strong>
            <p style={{ margin: '4px 0' }}>{error}</p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Esto puede ocurrir si el plan de Firebase no es Blaze, si las Cloud Functions están
              inactivas por un cambio de plan, o si hay un problema temporal de red. Verifica tu
              plan en la <a href="***REMOVED***" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>consola de Firebase</a>.
            </p>
            <button
              className="status-refresh-btn"
              onClick={runHealthCheck}
              disabled={loading}
              style={{ marginTop: '8px', fontSize: '12px' }}
            >
              {loading ? '⟳ Reintentando...' : <><RefreshIcon size={16} /> Reintentar conexión</>}
            </button>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="status-stats-row">
        <div className="status-stat-card">
          <div className="status-stat-value">{checks.account_registry?.count ?? '...'}</div>
          <div className="status-stat-label">Cuentas Registradas</div>
        </div>
        <div className="status-stat-card">
          <div className="status-stat-value">{realtimeAlerts?.pending ?? checks.alerts?.pending ?? '...'}</div>
          <div className="status-stat-label">Alertas Pendientes</div>
        </div>
        <div className="status-stat-card">
          <div className="status-stat-value">{realtimeNotifs?.total ?? checks.notifications?.total ?? '...'}</div>
          <div className="status-stat-label">Notificaciones</div>
        </div>
        <div className="status-stat-card">
          <div className="status-stat-value" style={{
            color: (realtimeSchedule?.enabled ?? checks.schedule?.enabled) ? '#10b981' : '#6b7280'
          }}>
            {(realtimeSchedule?.enabled ?? checks.schedule?.enabled) ? 'Activo' : 'Off'}
          </div>
          <div className="status-stat-label">Análisis Auto.</div>
        </div>
      </div>

      {/* Sections */}
      <div className="status-section">
        <h3 className="status-section-title"><span className="status-section-icon"><BuildIcon size={16} /></span> Infraestructura</h3>
        <div className="status-services-list">{allServices.slice(0, 4).map(renderServiceCard)}</div>
      </div>

      <div className="status-section">
        <h3 className="status-section-title"><span className="status-section-icon"><SaveIcon size={16} /></span> Datos y Almacenamiento</h3>
        <div className="status-services-list">{allServices.slice(4, 7).map(renderServiceCard)}</div>
      </div>

      <div className="status-section">
        <h3 className="status-section-title"><span className="status-section-icon"><InboxIcon size={16} /></span> Pipeline de Análisis</h3>
        <div className="status-services-list">{allServices.slice(7, 10).map(renderServiceCard)}</div>
      </div>

      <div className="status-section">
        <h3 className="status-section-title"><span className="status-section-icon"><TrendUpIcon size={16} /></span> Datos Operativos</h3>
        <div className="status-services-list">{allServices.slice(10).map(renderServiceCard)}</div>
      </div>

      {adminbotState.data && (
        <div className="status-section">
          <h3 className="status-section-title"><span className="status-section-icon"><SatelliteIcon size={16} /></span> AdminBot Hermes</h3>
          <div className="status-services-list">
            <div className="status-service-card" style={{ borderLeftColor: adminbotState.data.status === 'completed' ? '#10b981' : adminbotState.data.status === 'pending' ? '#f59e0b' : '#8b5cf6' }}>
              <div className="status-service-header">
                <span className="status-service-name">Estado del operador</span>
                <span className="status-service-badge" style={{ color: '#8b5cf6', background: 'rgba(139,92,246,0.1)' }}>{adminbotState.data.statusLabel}</span>
              </div>
              <div className="status-detail-info">
                <DetailRow label="Último análisis" value={adminbotState.data.analysisGeneratedAt ? formatDate(adminbotState.data.analysisGeneratedAt) : '—'} />
                <DetailRow label="Fuente" value={adminbotState.data.runSource === 'scheduler' ? 'Programado' : 'Dashboard'} />
                <DetailRow label="Job ID" value={adminbotState.data.jobId || '—'} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="status-uptime-bar">
        <div className="status-uptime-label">
          <span><SatelliteIcon size={16} /> Monitoreo on-demand</span>
          <span className="status-uptime-note">
            Las verificaciones no consumen quota Firebase adicional excepto IMAP (3 cuentas de muestra)
          </span>
        </div>
      </div>
 </>
 );
}
