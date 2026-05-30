import { useState, useEffect, useCallback } from 'react';
import { doc, getDoc, setDoc, updateDoc, collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { useAdminbotState } from '../hooks/adminbotState';
import { authenticatedFetch, ensureAdminFunctionResponse } from '../utils/authenticatedFetch';
import { buildCloudFunctionUrl } from '../config/runtime';
import { AnalyzeIcon, BarChartIcon, BellIcon, CheckCircleIcon, CheckIcon, CheckboxChecked, CheckboxEmpty, CleanIcon, ClipboardIcon, ClockIcon, CloudSunIcon, DoorIcon, EmailIcon, EmptyMailIcon, HourglassIcon, InboxIcon, LightningIcon, MoneyIcon, MoonIcon, PinIcon, RefreshIcon, SatelliteIcon, SearchIcon, SleepIcon, StopwatchIcon, TargetIcon, UsersIcon, WarningIcon, WrenchIcon, XCircleIcon } from '../components/Icons';
import LoadingState from '../components/LoadingState';
import { ModalActions, ModalShell } from '../components/Modal';

const KIND_LABELS = {
 user_left_self: <><DoorIcon size={16} /> Baja voluntaria</>,
 user_left_transferred: <><RefreshIcon size={16} /> Transferido fuera</>,
 user_join_direct: <><CheckCircleIcon size={16} /> Ingreso directo</>,
 user_join_transferred: <><RefreshIcon size={16} /> Ingreso por transferencia</>,
 withdrawal_requested: <><MoneyIcon size={16} /> Retiro solicitado</>,
 withdrawal_completed: <><CheckCircleIcon size={16} /> Retiro completado</>,
 group_deactivated: <><WarningIcon size={16} /> Grupo desactivado</>,
 group_validated: <><CheckIcon size={14} /> Grupo validado</>,
};

const KIND_EMOJI = {
 user_left_self: <DoorIcon size={16} />,
 user_left_transferred: <RefreshIcon size={16} />,
 user_join_direct: <CheckCircleIcon size={16} />,
 user_join_transferred: <RefreshIcon size={16} />,
 withdrawal_requested: <MoneyIcon size={16} />,
 withdrawal_completed: <CheckCircleIcon size={16} />,
 group_deactivated: <WarningIcon size={16} />,
 group_validated: <CheckIcon size={14} />,
};

function formatDate(dateStr) {
 if (!dateStr) return '—';
 try {
 const d = new Date(dateStr);
 if (isNaN(d)) return dateStr;
 return d.toLocaleString('es-MX', { 
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
 });
 } catch { return dateStr; }
}

function timeSince(dateStr) {
 if (!dateStr) return '';
 try {
 const d = new Date(dateStr);
 const now = new Date();
 const diff = Math.floor((now - d) / 1000);
 if (diff < 60) return `hace ${diff}s`;
 if (diff < 3600) return `hace ${Math.floor(diff/60)}min`;
 if (diff < 86400) return `hace ${Math.floor(diff/3600)}h`;
 return `hace ${Math.floor(diff/86400)}d`;
 } catch { return ''; }
}

function getProfileImg(accountId) {
 return `/assets/profiles/account_${accountId}.png`;
}

export default function Analyze({ navData }) {
 const adminbotState = useAdminbotState();
 const [report, setReport] = useState(null);
 const [notifications, setNotifications] = useState([]); // Firestore notifications with 7-day retention
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState(null);
 const [view, setView] = useState(navData?.view || 'resumen');
 const [expandedAccordions, setExpandedAccordions] = useState({});
 const [expandedNotifId, setExpandedNotifId] = useState(null); // 'accountId-idx' for expanded email
 const [readUids, setReadUids] = useState(new Set());
 // Analysis controls
 const [analysisRunning, setAnalysisRunning] = useState(false);
 const [analysisResult, setAnalysisResult] = useState(null);
 const [scheduleEnabled, setScheduleEnabled] = useState(false);
 const [scheduleFrequency, setScheduleFrequency] = useState(6);
 const [scheduleStartTime, setScheduleStartTime] = useState(null); // ISO string
 const [lastAnalysisTime, setLastAnalysisTime] = useState(null);
 const [nextRunCountdown, setNextRunCountdown] = useState('');
 const [scheduleModal, setScheduleModal] = useState(false); // confirm modal
 const [modalStartMode, setModalStartMode] = useState('now'); // 'now' | 'custom'
 const [modalCustomTime, setModalCustomTime] = useState(''); // HH:MM format
 const [modalFrequency, setModalFrequency] = useState(6);
 // Active hours window
 const [activeHoursEnabled, setActiveHoursEnabled] = useState(false);
 const [activeHoursStart, setActiveHoursStart] = useState(7);
 const [activeHoursEnd, setActiveHoursEnd] = useState(23);
 const [modalActiveHours, setModalActiveHours] = useState({ enabled: false, startHour: 7, endHour: 23 });

 const fetchData = useCallback(async () => {
 try {
      setLoading(true);
      const [reportSnap, schedSnap] = await Promise.all([
        getDoc(doc(db, 'analysis', 'latest-report')),
        getDoc(doc(db, 'config', 'schedule')),
      ]);
      if (reportSnap.exists()) {
        setReport(reportSnap.data());
        setLastAnalysisTime(reportSnap.data().generatedAt || null);
      }
      if (schedSnap.exists()) {
        const sched = schedSnap.data();
        setScheduleEnabled(sched.enabled || false);
        setScheduleFrequency(sched.frequencyHours || 6);
        setScheduleStartTime(sched.startTime || null);
        if (sched.activeHours) {
          setActiveHoursEnabled(sched.activeHours.enabled || false);
          setActiveHoursStart(sched.activeHours.startHour ?? 7);
          setActiveHoursEnd(sched.activeHours.endHour ?? 23);
        }
      }
 } catch (err) {
      console.error('Error cargando análisis:', err);
      setError(err.message);
 } finally {
      setLoading(false);
 }
 }, []);

 useEffect(() => { fetchData(); }, [fetchData]);

 const loadReadUids = useCallback(async () => {
   const snap = await getDoc(doc(db, 'config', 'notification-reads'));
   if (snap.exists()) setReadUids(new Set(snap.data().readUids || []));
 }, []);

 const loadNotifications = useCallback(async () => {
   const snap = await getDocs(collection(db, 'notifications'));
   const notifs = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
   notifs.sort((a, b) => {
     const aLatest = (a.items || []).reduce((max, i) => {
       const d = i.emailDate || i.date || '';
       return d > max ? d : max;
     }, '');
     const bLatest = (b.items || []).reduce((max, i) => {
       const d = i.emailDate || i.date || '';
       return d > max ? d : max;
     }, '');
     return bLatest.localeCompare(aLatest);
   });
   setNotifications(notifs);
 }, []);

 // ─── Cargar UIDs leídos ───
 useEffect(() => { loadReadUids(); }, [loadReadUids]);

 // ─── Cargar notificaciones (one-shot) ───
 useEffect(() => { loadNotifications(); }, [loadNotifications]);

 const markNotifAsRead = useCallback(async (uid) => {
   const newSet = new Set(readUids);
   newSet.add(String(uid));
   setReadUids(newSet);
   const ref = doc(db, 'config', 'notification-reads');
   const snap = await getDoc(ref);
   if (snap.exists()) {
     await updateDoc(ref, { readUids: [...newSet], updatedAt: new Date().toISOString() });
   } else {
     await setDoc(ref, { readUids: [...newSet], updatedAt: new Date().toISOString() });
   }
 }, [readUids]);

 const markAllNotifsAsRead = useCallback(async () => {
   const allUids = notifications.flatMap(n => (n.items || []).map(i => String(i.uid)));
   const newSet = new Set([...readUids, ...allUids]);
   setReadUids(newSet);
   const ref = doc(db, 'config', 'notification-reads');
   const snap = await getDoc(ref);
   if (snap.exists()) {
     await updateDoc(ref, { readUids: [...newSet], updatedAt: new Date().toISOString() });
   } else {
     await setDoc(ref, { readUids: [...newSet], updatedAt: new Date().toISOString() });
   }
 }, [readUids, notifications]);

 // ─── Next analysis countdown timer ───
 const getNextAnalysisTime = useCallback(() => {
 if (!scheduleEnabled || !scheduleStartTime) return null;
 try {
      const startDt = new Date(scheduleStartTime);
      if (isNaN(startDt.getTime())) return null;
      const now = new Date();
      // If start is in the future, that's the next run
      if (startDt > now) return startDt;
      // Calculate next slot in the grid
      const elapsedMs = now.getTime() - startDt.getTime();
      const intervalMs = scheduleFrequency * 3600 * 1000;
      const intervalsPassed = Math.floor(elapsedMs / intervalMs);
      const nextSlot = new Date(startDt.getTime() + (intervalsPassed + 1) * intervalMs);
      return nextSlot;
 } catch { return null; }
 }, [scheduleEnabled, scheduleFrequency, scheduleStartTime]);

 useEffect(() => {
 if (!scheduleEnabled) { setNextRunCountdown(''); return; }
 const update = () => {
      const nextTime = getNextAnalysisTime();
      if (!nextTime) { setNextRunCountdown('pendiente...'); return; }
      const now = new Date();
      const diff = nextTime.getTime() - now.getTime();
      if (diff <= 0) { setNextRunCountdown('en cualquier momento...'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      if (h > 0) setNextRunCountdown(`en ${h}h ${m}min`);
      else if (m > 0) setNextRunCountdown(`en ${m}min ${s}s`);
      else setNextRunCountdown(`en ${s}s`);
 };
 update();
 const interval = setInterval(update, 1000);
 return () => clearInterval(interval);
 }, [scheduleEnabled, lastAnalysisTime, scheduleFrequency, getNextAnalysisTime]);

 // ─── Run analysis via Cloud Function ───
 const handleRunAnalysis = async () => {
 if (analysisRunning) return;
 setAnalysisRunning(true);
 setAnalysisResult(null);
 try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('analyze_emails'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      await ensureAdminFunctionResponse(res);
      const data = await res.json();
      if (data.success) {
        setAnalysisResult({ type: 'success', ...data });
        // Refresh data
        await fetchData();
      } else {
        setAnalysisResult({ type: 'error', message: data.error || 'Error desconocido' });
      }
 } catch (err) {
      setAnalysisResult({ type: 'error', message: err.message });
 } finally {
      setAnalysisRunning(false);
 }
 };

 // ─── Update schedule config ───
 const handleScheduleToggle = () => {
 if (scheduleEnabled) {
      // Desactivar - directo sin confirmación
      setScheduleEnabled(false);
      setScheduleStartTime(null);
      authenticatedFetch(buildCloudFunctionUrl('update_schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, frequencyHours: scheduleFrequency }),
      }).then(ensureAdminFunctionResponse).catch(err => {
        console.error('Error actualizando schedule:', err);
        setScheduleEnabled(true); // revert
      });
 } else {
      // Activar - mostrar diálogo de configuración
      setModalStartMode('now');
      setModalFrequency(scheduleFrequency);
      setModalActiveHours({ enabled: activeHoursEnabled, startHour: activeHoursStart, endHour: activeHoursEnd });
      // Default custom time: next full hour
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      setModalCustomTime(`${String(nextHour.getHours()).padStart(2, '0')}:${String(nextHour.getMinutes()).padStart(2, '0')}`);
      setScheduleModal(true);
 }
 };

 const handleScheduleConfirm = async (runNow) => {
 setScheduleModal(false);
 const freq = modalFrequency;
 let startTimeISO;

 if (modalStartMode === 'now') {
      // Start now: first analysis runs immediately, next at now + freq
      startTimeISO = new Date().toISOString();
 } else {
      // Custom time: build a Date for today at the chosen time
      const [hh, mm] = modalCustomTime.split(':').map(Number);
      const startDt = new Date();
      startDt.setHours(hh, mm, 0, 0);
      // If the chosen time already passed today, it still starts today (first run at that time)
      // But if it's in the past, move to tomorrow
      if (startDt <= new Date()) {
        // Time already passed today — but the user chose it, so we keep it for the grid
        // The scheduler won't fire until the next slot
      }
      startTimeISO = startDt.toISOString();
 }

 // Build activeHours payload
 const activeHoursPayload = {
      enabled: modalActiveHours.enabled,
      startHour: modalActiveHours.startHour,
      endHour: modalActiveHours.endHour,
      tzOffset: new Date().getTimezoneOffset(), // minutes offset from UTC (e.g., 360 for UTC-6)
 };

 setScheduleEnabled(true);
 setScheduleFrequency(freq);
 setScheduleStartTime(startTimeISO);
 setActiveHoursEnabled(activeHoursPayload.enabled);
 setActiveHoursStart(activeHoursPayload.startHour);
 setActiveHoursEnd(activeHoursPayload.endHour);

 try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('update_schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          frequencyHours: freq,
          startTime: startTimeISO,
          activeHours: activeHoursPayload,
        }),
      });
      await ensureAdminFunctionResponse(res);
      if (runNow) {
        handleRunAnalysis();
      }
 } catch (err) {
      console.error('Error actualizando schedule:', err);
      setScheduleEnabled(false); // revert
      setScheduleStartTime(null);
 }
 };

 const handleFrequencyChange = async (e) => {
 const freq = parseInt(e.target.value);
 setScheduleFrequency(freq);
 // Recalculate startTime to maintain the same start hour but with new frequency
 try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('update_schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: scheduleEnabled,
          frequencyHours: freq,
          startTime: scheduleStartTime,
          activeHours: {
            enabled: activeHoursEnabled,
            startHour: activeHoursStart,
            endHour: activeHoursEnd,
            tzOffset: new Date().getTimezoneOffset(),
          },
        }),
      });
      await ensureAdminFunctionResponse(res);
 } catch (err) {
      console.error('Error actualizando frecuencia:', err);
 }
 };

 const toggleAccordion = (key) => {
 setExpandedAccordions(prev => ({ ...prev, [key]: !prev[key] }));
 };

 // Click en tarjeta de cuenta en 'Todas las Cuentas'
 const handleAccountCardClick = (acc) => {
 if ((acc.rawEmailCount || 0) > 0) {
      setView('notificaciones');
 }
 };

 if (loading) {
 return (
      <LoadingState variant="page" label="Cargando datos de análisis..." className="analyze-loading" />
 );
 }

 if (error) {
 return (
      <div className="analyze-error">
        <div className="section-header"><div className="section-title"><AnalyzeIcon size={16} /> Centro de Análisis</div></div>
        <div className="analyze-card" style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}><WarningIcon size={16} /></div>
          <h3>Error al cargar datos</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>{error}</p>
        </div>
      </div>
 );
 }

 if (!report) {
 return (
      <div>
        <div className="section-header"><div className="section-title"><AnalyzeIcon size={16} /> Centro de Análisis</div></div>
        {/* Analysis Controls */}
        <div className="analysis-controls">
          <button className="analysis-run-btn" onClick={handleRunAnalysis} disabled={analysisRunning}>
            {analysisRunning ? <><span className="spinner" /> Analizando...</> : <><SearchIcon size={16} /> Ejecutar Análisis</>}
          </button>
          <div className="analysis-status">
            <span className="analysis-last-run">Nunca se ha ejecutado un análisis</span>
          </div>
        </div>
        {analysisResult && (
          <div className="analyze-card" style={{ marginBottom: '16px', borderLeftColor: analysisResult.type === 'success' ? '#10b981' : '#ef4444', borderLeftWidth: '3px', borderLeftStyle: 'solid' }}>
            {analysisResult.type === 'success' ? (
              <>
              <p><CheckCircleIcon size={16} /> Análisis completado: <strong>{analysisResult.analyzedAccounts}</strong> cuentas, <strong>{analysisResult.totalRawEmails}</strong> correos, <strong>{analysisResult.alertsGenerated}</strong> alertas generadas</p>
              </>
            ) : (
              <p><XCircleIcon size={16} /> Error: {analysisResult.message}</p>
            )}
          </div>
        )}
        <div className="analyze-card" style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}><EmptyMailIcon size={16} /></div>
          <h3>Sin datos de análisis</h3>
          <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>
            Presiona el botón "Ejecutar Análisis" para analizar los correos de Lank.
          </p>
        </div>
      </div>
 );
 }
 const failedAccountsList = report.failedAccounts || [];

 // totalAccounts = total attempted, accountsOk = successful; backward compat with old reports
 const totalAccounts = report.totalAccounts || report.accountCount || 0;
 const accountsOk = report.accountsOk || report.accountCount || 0;
 const failedAccounts = totalAccounts - accountsOk;
 const totalRelevant = report.totalRelevant || 0;
 const totalRaw = report.totalRawEmails || 0;
 const totalEvents = report.totalEvents || report.totalParsedEvents || 0;
 const totalIgnored = report.totalIgnored || 0;
 const alertsGenerated = report.alertsGenerated || 0;
 const mode = report.mode || (report.usedUidTracking ? 'UID tracking' : 'Fecha');
 const generatedAt = report.generatedAt || '';
 const accounts = report.accounts || [];

 // Accounts with clean status
 const accountsAllClean = accounts.filter(a => a.relevant === 0 && a.access === 'ok');

 // Total notifications count
 const totalNotifications = notifications.reduce((sum, n) => sum + (n.count || n.items?.length || 0), 0);
 const totalUnread = notifications.reduce((sum, n) => sum + (n.items || []).filter(i => !readUids.has(String(i.uid))).length, 0);

 return (
 <>
      <div className="section-header">
        <div className="section-title"><AnalyzeIcon size={16} /> Centro de Análisis</div>
      </div>

      {/* Analysis Controls */}
      <div className="analysis-controls">
        <button className="analysis-run-btn" onClick={handleRunAnalysis} disabled={analysisRunning}>
          {analysisRunning ? <><span className="spinner" /> Analizando...</> : ' Ejecutar Análisis'}
        </button>
        <div className="analysis-status">
          <span className="analysis-last-run">Último: <strong>{formatDate(generatedAt)}</strong> <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>({timeSince(generatedAt)})</span></span>
        </div>
        <div className="analysis-schedule">
          <div className="schedule-toggle">
            <span>Análisis programado</span>
            <button
              className={`schedule-toggle-switch ${scheduleEnabled ? 'active' : ''}`}
              onClick={handleScheduleToggle}
              title={scheduleEnabled ? 'Desactivar' : 'Activar'}
            />
          </div>
          {scheduleEnabled && (
            <select className="schedule-freq-select" value={scheduleFrequency} onChange={handleFrequencyChange}>
              <option value={1}>Cada 1 hora</option>
              <option value={2}>Cada 2 horas</option>
              <option value={3}>Cada 3 horas</option>
              <option value={6}>Cada 6 horas</option>
              <option value={12}>Cada 12 horas</option>
              <option value={24}>Cada 24 horas</option>
            </select>
          )}
        </div>
      </div>

      {/* Next analysis indicator */}
      {scheduleEnabled && (
        <div className="schedule-next-run">
          <div className="schedule-next-main">
            <span className="schedule-next-icon"></span>
            <span className="schedule-next-label">Próximo análisis:</span>
            {(() => {
              const nextTime = getNextAnalysisTime();
              if (!nextTime) return <span className="schedule-next-value">pendiente configuración</span>;
              const now = new Date();
              const isPast = nextTime.getTime() <= now.getTime();
              // Check if we're currently outside active hours
              const outsideWindow = activeHoursEnabled && (() => {
                const h = now.getHours();
                if (activeHoursStart < activeHoursEnd) {
                  return h < activeHoursStart || h >= activeHoursEnd;
                } else {
                  return h < activeHoursStart && h >= activeHoursEnd;
                }
              })();
              return (
                <>
                  <span className={`schedule-next-value ${isPast && !outsideWindow ? 'schedule-imminent' : ''}`}>
                    {outsideWindow ? 'pausado (fuera de horario)' : isPast ? 'en cualquier momento...' : formatDate(nextTime.toISOString())}
                  </span>
                  {!isPast && !outsideWindow && <span className="schedule-next-countdown">({nextRunCountdown})</span>}
                  {outsideWindow && <span className="schedule-paused-badge"><MoonIcon size={16} /> Reanuda a las {activeHoursStart}:00</span>}
                  {activeHoursEnabled && !outsideWindow && <span className="schedule-active-hours-badge"><CloudSunIcon size={16} /> {activeHoursStart}:00-{activeHoursEnd}:00</span>}
                </>
              );
            })()}
          </div>
          <div className="schedule-precision-note">
            <ClockIcon size={12} /> La ejecución real puede variar hasta ±30 min respecto a la hora indicada
          </div>
        </div>
      )}

      {adminbotState.data && (
        <div className="schedule-next-run" style={{ marginTop: '8px' }}>
          <div className="schedule-next-main">
            <span className="schedule-next-label">AdminBot:</span>
            <span className="schedule-next-value">
              {adminbotState.data.statusLabel}
            </span>
          </div>
        </div>
      )}

      {/* Analysis result toast */}
      {analysisResult && (
        <div className="analyze-card" style={{ marginBottom: '16px', borderLeftColor: analysisResult.type === 'success' ? '#10b981' : '#ef4444', borderLeftWidth: '3px', borderLeftStyle: 'solid' }}>
          {analysisResult.type === 'success' ? (
            <>
            <p><CheckCircleIcon size={16} /> Análisis completado: <strong>{analysisResult.analyzedAccounts}</strong> cuentas, <strong>{analysisResult.totalRawEmails}</strong> correos, <strong>{analysisResult.alertsGenerated}</strong> alertas generadas</p>
            </>
          ) : (
            <p><XCircleIcon size={16} /> Error: {analysisResult.message}</p>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="analyze-status-bar">
        <div className="analyze-status-info">
          <span className="analyze-status-dot" style={{ background: failedAccounts === 0 ? '#10b981' : '#ef4444' }} />
          <span>Último análisis: <strong>{formatDate(generatedAt)}</strong></span>
          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>({timeSince(generatedAt)})</span>
        </div>
        <div className="analyze-status-meta">
          <span className="analyze-meta-tag"><SatelliteIcon size={16} /> {mode}</span>
          <span className="analyze-meta-tag"><EmailIcon size={16} /> {totalRaw} correos</span>
          <span className="analyze-meta-tag"><ClipboardIcon size={16} /> {totalEvents} eventos ({totalIgnored} ignorados)</span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="analyze-kpi-grid">
        <div className="analyze-kpi-card">
          <div className="analyze-kpi-icon" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}><CheckCircleIcon size={16} /></div>
          <div className="analyze-kpi-value" style={{ color: failedAccounts > 0 ? '#f59e0b' : '#10b981' }}>{accountsOk}/{totalAccounts}</div>
          <div className="analyze-kpi-label">Cuentas analizadas</div>
          {failedAccounts > 0 && (
            <div className="analyze-kpi-failed-detail">
              <div className="analyze-kpi-warn"><WarningIcon size={16} /> {failedAccounts} fallida{failedAccounts > 1 ? 's' : ''}</div>
              {failedAccountsList.length > 0 ? (
                <div className="analyze-failed-list">
                  {failedAccountsList.map((fa, i) => (
                    <div key={i} className="analyze-failed-item">
                      <span className="analyze-failed-id">#{fa.accountId}</span>
                      <span className="analyze-failed-alias">{fa.accountAlias || 'Sin alias'}</span>
                      <span className="analyze-failed-error">{fa.access}: {fa.error}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="analyze-failed-no-detail">Sin detalle disponible (ejecuta un nuevo analisis)</div>
              )}
            </div>
          )}
        </div>

        <div className="analyze-kpi-card">
          <div className="analyze-kpi-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}><BellIcon size={16} /></div>
          <div className="analyze-kpi-value" style={{ color: alertsGenerated > 0 ? '#ef4444' : '#10b981' }}>{alertsGenerated}</div>
          <div className="analyze-kpi-label">Alertas generadas</div>
          <div className="analyze-kpi-sub">En este análisis</div>
        </div>

        <div className="analyze-kpi-card">
          <div className="analyze-kpi-icon" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}><EmailIcon size={16} /></div>
          <div className="analyze-kpi-value" style={{ color: '#3b82f6' }}>{totalRaw}</div>
          <div className="analyze-kpi-label">Correos</div>
          <div className="analyze-kpi-sub">{totalRelevant} relevantes, {totalIgnored} ignorados</div>
        </div>

        <div className="analyze-kpi-card">
          <div className="analyze-kpi-icon" style={{ background: 'rgba(251, 191, 36, 0.15)', color: '#f59e0b' }}><LightningIcon size={16} /></div>
          <div className="analyze-kpi-value" style={{ color: '#f59e0b' }}>{alertsGenerated}</div>
          <div className="analyze-kpi-label">Alertas generadas</div>
          <div className="analyze-kpi-sub">En este análisis</div>
        </div>

        <div className="analyze-kpi-card">
          <div className="analyze-kpi-icon" style={{ background: 'rgba(167, 139, 250, 0.15)', color: '#a78bfa' }}><CleanIcon size={16} /></div>
          <div className="analyze-kpi-value" style={{ color: '#a78bfa' }}>{accountsAllClean.length}</div>
          <div className="analyze-kpi-label">Sin novedades</div>
          <div className="analyze-kpi-sub">Cuentas limpias</div>
        </div>
      </div>

      {/* AI Analysis Summary */}
      {/* NavTabs */}
      <div className="analyze-tabs">
        {[
          { key: 'resumen', label: <><BarChartIcon size={16} /> Resumen</>, count: null },
          { key: 'notificaciones', label: <><InboxIcon size={16} /> Notificaciones</>, count: totalNotifications, badge: totalUnread > 0 ? totalUnread : null },
          { key: 'cuentas', label: ' Todas las Cuentas', count: totalAccounts },
        ].map(t => (
          <button
            key={t.key}
            className={`analyze-tab ${view === t.key ? 'active' : ''}`}
            onClick={() => setView(t.key)}
          >
            {t.label}
            {t.count !== null && <span className="analyze-tab-badge">{t.count}</span>}
            {t.badge != null && <span className="notif-latest-count" style={{ marginLeft: '4px', fontSize: '10px' }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* ==================== RESUMEN ==================== */}
      {view === 'resumen' && (
        <div className="analyze-section">
          {/* Pipeline stats */}
          <div className="analyze-card">
            <h3 className="analyze-card-title"><WrenchIcon size={16} /> Pipeline de análisis</h3>
            <div className="analyze-pipeline-grid">
              <div className="analyze-pipeline-step">
                <div className="analyze-pipeline-num">1</div>
                <div>
                  <div className="analyze-pipeline-title">Conexión IMAP</div>
                  <div className="analyze-pipeline-desc">{accountsOk} cuentas Gmail conectadas</div>
                </div>
                <div className="analyze-pipeline-status ok"><CheckIcon size={14} /></div>
              </div>
              <div className="analyze-pipeline-arrow">→</div>
              <div className="analyze-pipeline-step">
                <div className="analyze-pipeline-num">2</div>
                <div>
                  <div className="analyze-pipeline-title">Correos crudos</div>
                  <div className="analyze-pipeline-desc">{totalRaw} correos de Lank detectados</div>
                </div>
                <div className="analyze-pipeline-status ok"><CheckIcon size={14} /></div>
              </div>
              <div className="analyze-pipeline-arrow">→</div>
              <div className="analyze-pipeline-step">
                <div className="analyze-pipeline-num">3</div>
                <div>
                  <div className="analyze-pipeline-title">Clasificación</div>
                  <div className="analyze-pipeline-desc">{totalEvents} eventos → {totalRelevant} relevantes, {totalIgnored} ignorados</div>
                </div>
                <div className="analyze-pipeline-status ok"></div>
              </div>
              <div className="analyze-pipeline-arrow">→</div>
              <div className="analyze-pipeline-step">
                <div className="analyze-pipeline-num">4</div>
                <div>
                  <div className="analyze-pipeline-title">Alertas directas</div>
                  <div className="analyze-pipeline-desc">{alertsGenerated} alertas generadas</div>
                </div>
                <div className={`analyze-pipeline-status ${alertsGenerated > 0 ? 'warn' : 'ok'}`}>
                  {alertsGenerated > 0 ? <WarningIcon size={16} /> : <CheckIcon size={14} />}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== NOTIFICACIONES (7-day retention from Firestore) ==================== */}
      {view === 'notificaciones' && (
        <div className="analyze-section">
          <div className="analyze-card" style={{ marginBottom: '12px' }}>
            <h3 className="analyze-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span><InboxIcon size={16} /> Notificaciones ({totalNotifications} correos en {notifications.length} cuentas)</span>
              {totalUnread > 0 && (
                <button
                  className="alert-action-btn"
                  onClick={markAllNotifsAsRead}
                  style={{ fontSize: '11px', padding: '3px 10px' }}
                >
                  <CheckboxChecked size={14} /> Marcar todo como leido
                </button>
              )}
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '-8px' }}>
              Se muestran correos de los ultimos 7 dias. Los mas antiguos se eliminan automaticamente.
              {totalUnread > 0 && (
                <> · <span className="notif-latest-badge">{totalUnread} sin leer</span></>
              )}
            </p>
          </div>
          
          {notifications.length === 0 ? (
            <div className="analyze-card" style={{ textAlign: 'center', padding: '40px' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}></div>
              <h3>Sin notificaciones recientes</h3>
              <p style={{ color: 'var(--text-secondary)', marginTop: '6px' }}>
                No hay correos de Lank en los últimos 7 días. Ejecuta un análisis para actualizar.
              </p>
            </div>
          ) : (
            <div>
              {notifications.map(acctNotif => {
                const items = acctNotif.items || [];
                const isExpanded = expandedAccordions[`notif-${acctNotif.accountId}`];
                if (items.length === 0) return null;
                const latestCount = items.filter(item => !readUids.has(String(item.uid))).length;
                return (
                  <div className="notif-account-section" key={acctNotif.accountId}>
                    <div
                      className="notif-account-header"
                      onClick={() => toggleAccordion(`notif-${acctNotif.accountId}`)}
                    >
                      <div className="notif-account-identity">
                        <img
                          src={getProfileImg(acctNotif.accountId)}
                          alt=""
                          className="notif-account-avatar"
                        />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '14px' }}>
                            <span style={{ opacity: 0.7, fontSize: '12px', marginRight: '6px' }}>#{acctNotif.accountId}</span>
                            {acctNotif.accountAlias}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            Actualizado: {formatDate(acctNotif.updatedAt)}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {latestCount > 0 && <span className="notif-latest-count" title="Correos sin leer">{latestCount} sin leer</span>}
                        <span className="analyze-tab-badge">{items.length}</span>
                        <span className={`analyze-raw-chevron ${isExpanded ? 'open' : ''}`}>▼</span>
                      </div>
                    </div>
                    
                    {isExpanded && (
                      <div className="notif-list">
                        {items.map((notif, idx) => {
                          const kindColor = notif.kind === 'user_left_self' || notif.kind === 'user_left_transferred' ? '#ef4444'
                            : notif.kind === 'user_join_direct' || notif.kind === 'user_join_transferred' ? '#10b981'
                            : notif.kind === 'withdrawal_requested' || notif.kind === 'withdrawal_completed' ? '#f59e0b'
                            : '#6b7280';
                          const isUnread = !readUids.has(String(notif.uid));
                          return (
                            <div
                              className={`notif-item${isUnread ? ' notif-latest' : ''}`}
                              key={idx}
                              style={{ cursor: 'pointer' }}
                            >
                              {isUnread && <div className="notif-latest-indicator" title="Sin leer" />}
                              <div
                                style={{ display: 'flex', flex: 1, gap: '12px', alignItems: 'flex-start', minWidth: 0 }}
                                onClick={() => setExpandedNotifId(prev => prev === `${acctNotif.accountId}-${idx}` ? null : `${acctNotif.accountId}-${idx}`)}
                              >
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center', minWidth: '70px' }}>
                                <span className="notif-kind" style={{ background: `${kindColor}22`, color: kindColor }}>
                                  {KIND_EMOJI[notif.kind] || <EmailIcon size={16} />} {(notif.kind || 'email').replace(/_/g, ' ')}
                                </span>
                                <span className="notif-date">{formatDate(notif.emailDate || notif.date)}</span>
                              </div>
                              <div className="notif-subject" style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '3px' }}>{notif.subject}</div>
                                {notif.bodySnippet && (
                                  expandedNotifId === `${acctNotif.accountId}-${idx}` ? (
                                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                      {notif.bodySnippet}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.4', maxHeight: '40px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                      {notif.bodySnippet.substring(0, 150)}...
                                    </div>
                                  )
                                )}
                              </div>
                              </div>
                              {isUnread && (
                                <button
                                  className="overview-notif-read-btn"
                                  onClick={(e) => { e.stopPropagation(); markNotifAsRead(notif.uid); }}
                                  title="Marcar como leido"
                                  style={{ flexShrink: 0 }}
                                >
                                  <CheckboxEmpty size={16} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================== TODAS LAS CUENTAS ==================== */}
      {view === 'cuentas' && (
        <div className="analyze-section">
          <div className="analyze-card">
            <h3 className="analyze-card-title"><UsersIcon size={16} /> Estado de las {totalAccounts} cuentas</h3>
            <div className="analyze-accounts-grid">
              {accounts.map(acc => {
                const hasIssue = acc.pending > 0 || acc.review > 0;
                const isClean = acc.relevant === 0 && acc.access === 'ok';
                const hasIgnored = (acc.ignored || 0) > 0;
                const statusIcon = acc.access !== 'ok' ? <XCircleIcon size={16} /> : hasIssue ? <BellIcon size={16} /> : hasIgnored ? <EmailIcon size={16} /> : isClean ? <CheckCircleIcon size={16} /> : '';
                const borderColor = acc.access !== 'ok' ? '#ef4444' : hasIssue ? '#f59e0b' : 'transparent';
                const isClickable = hasIssue || (acc.rawEmailCount || 0) > 0;
                return (
                  <div
                    className={`analyze-account-card ${hasIssue ? 'has-issue' : ''} ${isClean ? 'clean' : ''} ${isClickable ? 'clickable' : ''}`}
                    key={acc.accountId}
                    style={{ borderLeftColor: borderColor, cursor: isClickable ? 'pointer' : 'default' }}
                    onClick={() => isClickable && handleAccountCardClick(acc)}
                  >
                    <div className="analyze-acct-header">
                      <img src={getProfileImg(acc.accountId)} alt="" className="analyze-acct-avatar" />
                      <div>
                        <div className="analyze-acct-id">#{acc.accountId}</div>
                        <div className="analyze-acct-alias">{acc.accountAlias}</div>
                      </div>
                      <span className="analyze-acct-status-icon">{statusIcon}</span>
                    </div>
                    <div className="analyze-acct-stats">
                      <div className="analyze-acct-stat">
                        <span className="analyze-stat-val">{acc.rawEmailCount || 0}</span>
                        <span className="analyze-stat-lbl">correos</span>
                      </div>
                      <div className="analyze-acct-stat">
                        <span className="analyze-stat-val">{acc.parsedEventCount || 0}</span>
                        <span className="analyze-stat-lbl">eventos</span>
                      </div>
                      {acc.pending > 0 && (
                        <div className="analyze-acct-stat pending">
                          <span className="analyze-stat-val">{acc.pending}</span>
                          <span className="analyze-stat-lbl">pendientes</span>
                        </div>
                      )}
                      {(acc.ignored || 0) > 0 && (
                        <div className="analyze-acct-stat ignored">
                          <span className="analyze-stat-val">{acc.ignored}</span>
                          <span className="analyze-stat-lbl">ignorados</span>
                        </div>
                      )}
                    </div>
                    {acc.access !== 'ok' && (
                      <div className="analyze-acct-error">Error: {acc.access}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Schedule configuration modal */}
      {scheduleModal && (
        <ModalShell
          open
          onCancel={() => setScheduleModal(false)}
          title="Configurar análisis programado"
          icon={<ClockIcon size={20} />}
          className="schedule-modal"
        >

            {/* Frequency selector */}
            <div className="schedule-modal-section">
              <label className="schedule-modal-label">Frecuencia de análisis</label>
              <select
                className="schedule-modal-select"
                value={modalFrequency}
                onChange={e => setModalFrequency(parseInt(e.target.value))}
              >
                <option value={1}>Cada 1 hora</option>
                <option value={2}>Cada 2 horas</option>
                <option value={3}>Cada 3 horas</option>
                <option value={6}>Cada 6 horas</option>
                <option value={12}>Cada 12 horas</option>
                <option value={24}>Cada 24 horas</option>
              </select>
              <span className="schedule-modal-hint">
                {Math.floor(24 / modalFrequency)} análisis por día
              </span>
            </div>

            {/* Start mode selector */}
            <div className="schedule-modal-section">
              <label className="schedule-modal-label">¿Cuándo comenzar?</label>
              <div className="schedule-start-options">
                <label className={`schedule-start-option ${modalStartMode === 'now' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="startMode"
                    value="now"
                    checked={modalStartMode === 'now'}
                    onChange={() => setModalStartMode('now')}
                  />
                  <div className="schedule-start-option-content">
                    <span className="schedule-start-option-icon"></span>
                    <div>
                      <strong>Comenzar ahora</strong>
                      <span className="schedule-start-option-desc">
                        El primer análisis se ejecuta inmediatamente
                      </span>
                    </div>
                  </div>
                </label>
                <label className={`schedule-start-option ${modalStartMode === 'custom' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="startMode"
                    value="custom"
                    checked={modalStartMode === 'custom'}
                    onChange={() => setModalStartMode('custom')}
                  />
                  <div className="schedule-start-option-content">
                    <span className="schedule-start-option-icon"></span>
                    <div>
                      <strong>Elegir hora de inicio</strong>
                      <span className="schedule-start-option-desc">
                        El primer análisis se ejecuta a la hora elegida
                      </span>
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Custom time picker (visible only when custom) */}
            {modalStartMode === 'custom' && (
              <div className="schedule-modal-section">
                <label className="schedule-modal-label">Hora de inicio</label>
                <div className="custom-time-picker">
                  <div className="time-picker-col">
                    <button
                      className="time-picker-btn"
                      onClick={() => {
                        const [hh, mm] = (modalCustomTime || '13:00').split(':').map(Number);
                        const newH = (hh + 1) % 24;
                        setModalCustomTime(`${String(newH).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
                      }}
                    >▲</button>
                    <span className="time-picker-value">
                      {(() => {
                        const [hh] = (modalCustomTime || '13:00').split(':').map(Number);
                        return String(hh).padStart(2, '0');
                      })()}
                    </span>
                    <button
                      className="time-picker-btn"
                      onClick={() => {
                        const [hh, mm] = (modalCustomTime || '13:00').split(':').map(Number);
                        const newH = (hh - 1 + 24) % 24;
                        setModalCustomTime(`${String(newH).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
                      }}
                    >▼</button>
                    <span className="time-picker-unit">hora</span>
                  </div>
                  <span className="time-picker-separator">:</span>
                  <div className="time-picker-col">
                    <button
                      className="time-picker-btn"
                      onClick={() => {
                        const [hh, mm] = (modalCustomTime || '13:00').split(':').map(Number);
                        const newM = (mm + 15) % 60;
                        setModalCustomTime(`${String(hh).padStart(2, '0')}:${String(newM).padStart(2, '0')}`);
                      }}
                    >▲</button>
                    <span className="time-picker-value">
                      {(() => {
                        const parts = (modalCustomTime || '13:00').split(':');
                        return String(parts[1] || '00').padStart(2, '0');
                      })()}
                    </span>
                    <button
                      className="time-picker-btn"
                      onClick={() => {
                        const [hh, mm] = (modalCustomTime || '13:00').split(':').map(Number);
                        const newM = (mm - 15 + 60) % 60;
                        setModalCustomTime(`${String(hh).padStart(2, '0')}:${String(newM).padStart(2, '0')}`);
                      }}
                    >▼</button>
                    <span className="time-picker-unit">min</span>
                  </div>
                  <div className="time-picker-period">
                    {(() => {
                      const [hh] = (modalCustomTime || '13:00').split(':').map(Number);
                      return hh < 12 ? 'AM' : 'PM';
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* ─── Active Hours Window ─── */}
            <div className={`active-hours-section ${!modalActiveHours.enabled ? 'disabled' : ''}`}>
              <div
                className="active-hours-toggle"
                onClick={() => setModalActiveHours(prev => ({ ...prev, enabled: !prev.enabled }))}
              >
                <div className="active-hours-toggle-info">
                  <span className="active-hours-toggle-icon">{modalActiveHours.enabled ? <CloudSunIcon size={16} /> : ''}</span>
                  <div className="active-hours-toggle-text">
                    <strong>Horario activo</strong>
                    <span>{modalActiveHours.enabled
                      ? `Solo ejecutar entre ${modalActiveHours.startHour}:00 y ${modalActiveHours.endHour}:00`
                      : 'Ejecutar a cualquier hora del día'
                    }</span>
                  </div>
                </div>
                <button
                  className={`schedule-toggle-switch ${modalActiveHours.enabled ? 'active' : ''}`}
                  onClick={e => { e.stopPropagation(); setModalActiveHours(prev => ({ ...prev, enabled: !prev.enabled })); }}
                />
              </div>

              {modalActiveHours.enabled && (
                <div className="active-hours-config">
                  <div className="active-hours-pickers">
                    <div className="active-hours-picker">
                      <span className="active-hours-picker-label">Desde</span>
                      <select
                        className="active-hours-select"
                        value={modalActiveHours.startHour}
                        onChange={e => setModalActiveHours(prev => ({ ...prev, startHour: parseInt(e.target.value) }))}
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                        ))}
                      </select>
                    </div>
                    <span className="active-hours-arrow">→</span>
                    <div className="active-hours-picker">
                      <span className="active-hours-picker-label">Hasta</span>
                      <select
                        className="active-hours-select"
                        value={modalActiveHours.endHour}
                        onChange={e => setModalActiveHours(prev => ({ ...prev, endHour: parseInt(e.target.value) }))}
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* Visual bar showing active/inactive hours */}
                  <div className="active-hours-preview">
                    {(() => {
                      const s = modalActiveHours.startHour;
                      const e = modalActiveHours.endHour;
                      const activeH = s < e ? e - s : 24 - s + e;
                      const inactiveH = 24 - activeH;
                      return (
                        <>
                          <strong>{activeH}h activas</strong> · {inactiveH}h sin análisis
                          <div className="active-hours-bar">
                            {(() => {
                              if (s < e) {
                                return (<>
                                  <div className="active-hours-bar-segment inactive" style={{ width: `${(s/24)*100}%` }} />
                                  <div className="active-hours-bar-segment active" style={{ width: `${((e-s)/24)*100}%` }} />
                                  <div className="active-hours-bar-segment inactive" style={{ width: `${((24-e)/24)*100}%` }} />
                                </>);
                              } else {
                                return (<>
                                  <div className="active-hours-bar-segment active" style={{ width: `${(e/24)*100}%` }} />
                                  <div className="active-hours-bar-segment inactive" style={{ width: `${((s-e)/24)*100}%` }} />
                                  <div className="active-hours-bar-segment active" style={{ width: `${((24-s)/24)*100}%` }} />
                                </>);
                              }
                            })()}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Preview of schedule */}
            <div className="schedule-modal-preview">
              <span className="schedule-preview-label"> Vista previa de la programación:</span>
              <div className="schedule-preview-slots">
                {(() => {
                  const now = new Date();
                  let startDt;
                  if (modalStartMode === 'now') {
                    startDt = new Date(now);
                  } else {
                    const [hh, mm] = (modalCustomTime || '12:00').split(':').map(Number);
                    startDt = new Date(now);
                    startDt.setHours(hh, mm, 0, 0);
                    if (startDt <= now) {
                      // Show that it starts from this time in the grid
                    }
                  }
                  const intervalMs = modalFrequency * 3600 * 1000;
                  const ah = modalActiveHours;
                  // Helper: check if a local hour is within active window
                  const isInActiveWindow = (hour) => {
                    if (!ah.enabled) return true;
                    const h = hour + (hour < 0 ? 24 : 0);
                    if (ah.startHour < ah.endHour) {
                      return h >= ah.startHour && h < ah.endHour;
                    } else {
                      return h >= ah.startHour || h < ah.endHour;
                    }
                  };
                  const slots = [];
                  let shown = 0;
                  for (let i = 0; shown < 6 && i < 24; i++) {
                    const slot = new Date(startDt.getTime() + i * intervalMs);
                    const slotHour = slot.getHours();
                    const isFirstRun = i === 0;
                    const active = isInActiveWindow(slotHour);
                    shown++;
                    slots.push(
                      <span key={i} className={`schedule-preview-slot ${isFirstRun ? 'first' : ''}`} style={!active ? { opacity: 0.35, textDecoration: 'line-through' } : {}}>
                        {slot.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
                        {isFirstRun && modalStartMode === 'now' && <span className="schedule-slot-badge">ahora</span>}
                        {isFirstRun && modalStartMode === 'custom' && <span className="schedule-slot-badge">inicio</span>}
                        {!active && <span style={{ fontSize: '9px', marginLeft: '2px' }}><SleepIcon size={16} /></span>}
                      </span>
                    );
                  }
                  return slots;
                })()}
                <span className="schedule-preview-dots">...</span>
              </div>
              {modalActiveHours.enabled && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  <SleepIcon size={16} /> = fuera del horario activo ({modalActiveHours.startHour}:00 - {modalActiveHours.endHour}:00), se omite
                </div>
              )}
            </div>

            {/* Actions */}
            {modalStartMode === 'now' ? (
              <ModalActions
                onCancel={() => setScheduleModal(false)}
                secondaryLabel={<><HourglassIcon size={16} /> Activar sin analizar</>}
                onSecondary={() => handleScheduleConfirm(false)}
                primaryLabel={<><SearchIcon size={16} /> Activar y analizar ahora</>}
                onPrimary={() => handleScheduleConfirm(true)}
              />
            ) : (
              <ModalActions
                onCancel={() => setScheduleModal(false)}
                primaryLabel="Activar programación"
                onPrimary={() => handleScheduleConfirm(false)}
              />
            )}
        </ModalShell>
      )}
 </>
 );
}
