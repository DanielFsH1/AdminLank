import { useState, useMemo, useEffect, useCallback } from 'react';
import { useCollection } from '../hooks/useFirestore';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { getServiceMeta, getServiceKeyByName, getPoolServiceKeys, getAllServiceKeys } from '../config/services';
import { completeAlert, discardAlert, completeUnidentifiedAlert, removeGroupUser, completeMissingPhone } from '../hooks/firestoreActions';

import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import { BellIcon, CalendarIcon, CelebrationIcon, ChatIcon, CheckCircleIcon, ClipboardIcon, CreditCardIcon, DotBlue, DotOrange, DotRed, DotYellow, EditIcon, EmailIcon, EmptyMailIcon, HourglassIcon, KeyIcon, LinkIcon, LockKeyIcon, PhoneIcon, PinIcon, SearchIcon, SparkleIcon, TargetIcon, TrashIcon, WarningIcon, XCircleIcon } from '../components/Icons';
import SearchBar from '../components/SearchBar';
import { normalizeSearch, nMatch } from '../utils/normalize';

// Mapeo dinámico de serviceAccountRef → servicio interno para navegación
function parseServiceKey(ref) {
 if (!ref) return null;
 const key = ref.split('_')[0];
 // Intentar resolver la key directamente (chatgpt, youtube, etc.)
 return getServiceKeyByName(key) || getAllServiceKeys().find(k => k === key) || null;
}

function serviceNameToKey(name) {
 return getServiceKeyByName(name);
}

const KIND_TO_TYPE = {
 user_left_self: 'profile_delete',
 user_left_transferred: 'profile_delete',
 user_join_direct: 'user_needs_access',
 user_join_transferred: 'user_needs_access',
 group_deactivated: 'group_deactivated',
};

const KIND_TO_PRIORITY = {
 user_left_self: 'high',
 user_left_transferred: 'high',
 user_join_direct: 'medium',
 user_join_transferred: 'medium',
 group_deactivated: 'critical',
};

const PRIORITY_META = {
 critical: { label: 'Crítica', color: '#dc2626', bg: 'rgba(220,38,38,0.18)', border: 'rgba(220,38,38,0.6)', badge: 'badge-critical', icon: <DotRed />, order: 0 },
 high:     { label: 'Alta', color: '#ea580c', bg: 'rgba(234,88,12,0.15)', border: 'rgba(234,88,12,0.5)', badge: 'badge-high', icon: <DotOrange />, order: 1 },
 medium: { label: 'Media', color: '#d97706', bg: 'rgba(217,119,6,0.12)', border: 'rgba(217,119,6,0.4)', badge: 'badge-warning', icon: <DotYellow />, order: 2 },
 low:      { label: 'Baja', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)', border: 'rgba(14,165,233,0.4)', badge: 'badge-info', icon: <DotBlue />, order: 3 },
};

const TYPE_LABELS = {
 user_needs_access: <><KeyIcon size={16} /> Dar acceso</>,
 profile_delete: <><TrashIcon size={16} /> Eliminar perfil</>,
 password_change: <><LockKeyIcon size={16} /> Cambiar contraseña</>,
 access_verify: <><CheckCircleIcon size={16} /> Verificar acceso</>,
 group_deactivated: <><WarningIcon size={16} /> Grupo desactivado</>,
 user_left_expired: <><ClipboardIcon size={16} /> Salida (expirada)</>,
 revoke_invitation: <><EmailIcon size={16} /> Revocar invitación</>,
 missing_phone: <><PhoneIcon size={16} /> Falta teléfono</>,
 credit_cutoff: <><CalendarIcon size={16} /> Corte de crédito</>,
 credit_payment_due: <><CreditCardIcon size={16} /> Pago de crédito</>,
};

function buildRichDescription(alert) {
 const desc = alert.description || '';
 const highlights = [];
 if (alert.serviceAccountRef) highlights.push({ label: 'Cuenta real', value: alert.serviceAccountRef, icon: <LinkIcon size={16} /> });
 if (alert.realAccountEmail) highlights.push({ label: 'Correo', value: alert.realAccountEmail, icon: <EmailIcon size={16} /> });
 if (alert.assignedTo) highlights.push({ label: 'Asignado a', value: alert.assignedTo, icon: <PinIcon size={16} /> });
 if (alert.realAccountExpires) highlights.push({ label: 'Expira', value: alert.realAccountExpires, icon: <CalendarIcon size={16} /> });
 return { desc, highlights };
}

function getProfileImg(accountId) {
 return `/assets/profiles/account_${accountId}.png`;
}

export default function Alerts({ onNavigate, navData, servicesConfig }) {
 const { data: alerts, loading } = useCollection('alerts');
 const [activeTab, setActiveTab] = useState('pending');
 const [filterPriority, setFilterPriority] = useState('all');
 const [searchQuery, setSearchQuery] = useState('');
 const [realAccounts, setRealAccounts] = useState({});
 const [groupUsers, setGroupUsers] = useState({}); // {serviceKey_accountId: [users]}
 const [liveAccountNames, setLiveAccountNames] = useState({}); // {accountId: currentAlias}

 // Modal states
 const [discardModal, setDiscardModal] = useState(null); // { alertId, title }
 const [confirmComplete, setConfirmComplete] = useState(null); // { alert }
 const [editUserModal, setEditUserModal] = useState(null); // { alert, users }
 const [selectUserModal, setSelectUserModal] = useState(null); // { alert, users }
 const [missingPhoneModal, setMissingPhoneModal] = useState(null); // { alert }
 const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
 const [collapsedGroups, setCollapsedGroups] = useState(new Set()); // IDs de grupos colapsados

 const showToast = useCallback((message, type = 'success') => {
 setToast({ visible: true, message, type });
 }, []);

 useEffect(() => {
 async function fetchRealAccounts() {
      try {
        const serviceKeys = getPoolServiceKeys();
        const realAcctMap = {};
        for (const svc of serviceKeys) {
          try {
            const snap = await getDocs(collection(db, `service-pools/${svc}/real-accounts`));
            realAcctMap[svc] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          } catch { realAcctMap[svc] = []; }
        }
        setRealAccounts(realAcctMap);
      } catch (err) { console.error('Error cargando cuentas reales:', err); }
 }
 fetchRealAccounts();
 }, []);

 // Cargar usuarios de grupos Lank cuando hay alertas pendientes
 useEffect(() => {
 async function fetchGroupUsers() {
      const pendingAlerts = alerts.filter(a => a.status === 'pending');
      const toFetch = new Set();
      for (const a of pendingAlerts) {
        const svcKey = serviceNameToKey(a.service) || parseServiceKey(a.serviceAccountRef);
        if (svcKey && a.accountId) toFetch.add(`${svcKey}_${a.accountId}`);
      }

      const usersMap = {};
      for (const key of toFetch) {
        if (groupUsers[key]) { usersMap[key] = groupUsers[key]; continue; }
        const [svcKey, accId] = key.split('_');
        try {
          const snap = await getDoc(doc(db, `groups/${svcKey}/lank-accounts/${accId}`));
          if (snap.exists()) usersMap[key] = snap.data().users || [];
        } catch { usersMap[key] = []; }
      }
      if (Object.keys(usersMap).length > 0) {
        setGroupUsers(prev => ({ ...prev, ...usersMap }));
      }
 }
 if (alerts.length > 0) fetchGroupUsers();
 }, [alerts]);

 // Resolver nombres actuales de cuentas Lank (evitar alias stale en alertas)
 useEffect(() => {
   async function fetchLiveAccountNames() {
     const accountIds = new Set();
     for (const a of alerts) {
       if (a.accountId != null && a.accountId !== '') accountIds.add(String(a.accountId));
     }
     if (accountIds.size === 0) return;
     const namesMap = {};
     for (const accId of accountIds) {
       if (liveAccountNames[accId]) { namesMap[accId] = liveAccountNames[accId]; continue; }
       try {
         const snap = await getDoc(doc(db, 'accounts', accId));
         if (snap.exists()) {
           const d = snap.data();
           namesMap[accId] = d.canonicalAlias || d.alias || d.fullName || '';
         }
       } catch { /* non-blocking */ }
     }
     if (Object.keys(namesMap).length > 0) {
       setLiveAccountNames(prev => ({ ...prev, ...namesMap }));
     }
   }
   fetchLiveAccountNames();
 }, [alerts]);

 // Obtener cuentas reales disponibles para asignación
 const getAvailableRealAccounts = useCallback((serviceKey) => {
 const accounts = realAccounts[serviceKey] || [];
 return accounts.map(acct => ({
      value: acct.id,
      label: `${acct.id} — ${acct.email || 'Sin correo'}`,
      freeSlots: (acct.slots || []).filter(s => !s.memberAlias || !s.memberAlias.trim()).length,
 })).filter(a => a.freeSlots > 0);
 }, [realAccounts]);

 const findRealAccountForUser = (serviceKey, userAlias) => {
 const accounts = realAccounts[serviceKey] || [];
 for (const acct of accounts) {
      for (const slot of (acct.slots || [])) {
        if (slot.memberAlias && slot.memberAlias.toLowerCase() === (userAlias || '').toLowerCase()) {
          return acct.id || acct.serviceAccountRef;
        }
      }
 }
 return null;
 };

 const categorized = useMemo(() => {
 const pending = alerts.filter(a => a.status === 'pending');
 const completed = alerts.filter(a => a.status === 'completed' || a.status === 'done');
 const discarded = alerts.filter(a => a.status === 'discarded' || a.status === 'cancelled_by_ai' || a.status === 'cancelled_by_system' || a.status === 'resolved');
 return { pending, completed, discarded };
 }, [alerts]);

 const groupedAlerts = useMemo(() => {
 let list = categorized[activeTab] || [];
 if (filterPriority !== 'all') {
      list = list.filter(a => a.priority === filterPriority);
 }
 // Filtro de búsqueda
 const q = normalizeSearch(searchQuery);
 if (q.length >= 2) {
      list = list.filter(a => {
        const liveAlias = a.accountId != null ? (liveAccountNames[String(a.accountId)] || '') : '';
        return nMatch(a.title || '', q) ||
        nMatch(a.description || '', q) ||
        nMatch(a.userAlias || '', q) ||
        nMatch(a.service || '', q) ||
        nMatch(a.accountAlias || '', q) ||
        nMatch(liveAlias, q) ||
        nMatch(a.serviceAccountRef || '', q) ||
        nMatch(a.realAccountEmail || '', q) ||
        nMatch(String(a.accountId || ''), q);
      });
 }
 const groups = {};
 const ungrouped = [];
 for (const alert of list) {
      const accId = alert.accountId;
      if (accId != null && accId !== '') {
        const key = String(accId);
        const liveName = liveAccountNames[key];
        const displayAlias = liveName || alert.accountAlias || `Cuenta #${accId}`;
        if (!groups[key]) {
          groups[key] = {
            accountId: accId, accountAlias: displayAlias,
            alerts: [], highestPriority: 4,
          };
        }
        if (liveName) {
          groups[key].accountAlias = liveName;
        } else if (alert.accountAlias && alert.accountAlias !== `Cuenta #${accId}`) {
          groups[key].accountAlias = alert.accountAlias;
        }
        groups[key].alerts.push(alert);
        const pOrder = PRIORITY_META[alert.priority]?.order ?? 4;
        if (pOrder < groups[key].highestPriority) groups[key].highestPriority = pOrder;
      } else {
        ungrouped.push(alert);
      }
 }
 const sortByPriority = (a, b) => (PRIORITY_META[a.priority]?.order ?? 4) - (PRIORITY_META[b.priority]?.order ?? 4);
 for (const g of Object.values(groups)) g.alerts.sort(sortByPriority);
 ungrouped.sort(sortByPriority);
 const sortedGroups = Object.values(groups).sort((a, b) => {
      if (a.highestPriority !== b.highestPriority) return a.highestPriority - b.highestPriority;
      return b.alerts.length - a.alerts.length;
 });
 return { groups: sortedGroups, ungrouped };
 }, [categorized, activeTab, filterPriority, searchQuery, liveAccountNames]);

 const totalCount = useMemo(() => {
 return groupedAlerts.groups.reduce((s, g) => s + g.alerts.length, 0) + groupedAlerts.ungrouped.length;
 }, [groupedAlerts]);

 // Contadores por prioridad (sobre la pestaña activa, sin filtros de prioridad ni búsqueda)
 const priorityCounts = useMemo(() => {
   const list = categorized[activeTab] || [];
   const counts = { critical: 0, high: 0, medium: 0, low: 0 };
   for (const a of list) {
     if (counts[a.priority] !== undefined) counts[a.priority]++;
   }
   return counts;
 }, [categorized, activeTab]);

 useEffect(() => {
 if (!navData || !navData.focusUser) return;
 setActiveTab('pending');
 setFilterPriority('all');
 setTimeout(() => {
      const targetUser = navData.focusUser.toLowerCase();
      const el = document.querySelector(`[data-alert-user="${targetUser}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 3000);
      }
 }, 400);
 }, [navData]);

 const handleAlertClick = (alert, e) => {
 // Si se hizo clic en un botón de acción, no navegar
 if (e?.target?.closest('.alert-actions')) return;
 if (!onNavigate) return;
 if (alert.accountId) {
      if (alert.serviceAccountRef || alert.service) {
        const svcKey = serviceNameToKey(alert.service) || parseServiceKey(alert.serviceAccountRef);
        if (svcKey) {
          onNavigate('subscriptions', { service: svcKey, accountRef: alert.serviceAccountRef || null, highlightUser: alert.userAlias || null });
        } else {
          onNavigate('subscriptions');
        }
      } else {
        onNavigate('accounts', String(alert.accountId));
      }
 } else if (alert.service) {
      const svcKey = serviceNameToKey(alert.service);
      onNavigate(svcKey ? 'subscriptions' : 'subscriptions', svcKey ? { service: svcKey } : undefined);
 }
 };

 const isClickable = (alert) => {
 if (!(alert.accountId || alert.service || alert.serviceAccountRef)) return false;
 // Alertas completadas/descartadas de remoción: el usuario ya no existe, no tiene sentido navegar
 if (alert.status === 'completed' || alert.status === 'done' || alert.status === 'discarded' || alert.status === 'cancelled_by_ai' || alert.status === 'cancelled_by_system' || alert.status === 'resolved') {
      const removalTypes = ['profile_delete', 'user_left_expired', 'group_deactivated', 'revoke_invitation'];
      if (removalTypes.includes(alert.type)) return false;
 }
 return true;
 };

 // --- Acciones ---

 const handleComplete = (alert) => {
 setConfirmComplete({ alert });
 };

 const handleConfirmComplete = async () => {
 if (!confirmComplete) return;
 const { alert } = confirmComplete;
 try {
      await completeAlert(alert.id || alert.firestoreId);
      showToast(` Alerta completada: ${alert.title}`);
 } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
 }
 setConfirmComplete(null);
 };

 // --- Missing Phone ---
 const handleMissingPhone = (alert) => {
   setMissingPhoneModal({ alert });
 };

 const handleMissingPhoneSave = async (values) => {
   if (!missingPhoneModal) return;
   const { alert } = missingPhoneModal;
   const phone = (values.phone || '').trim();
   if (!phone) {
     showToast('Debes ingresar el número de teléfono', 'error');
     return;
   }
   const serviceKey = alert.serviceKey || serviceNameToKey(alert.service) || '';
   try {
     await completeMissingPhone(
       alert.id || alert.firestoreId,
       alert.accountId,
       alert.userAlias,
       phone,
       serviceKey,
     );
     showToast(`Teléfono guardado: ${phone} para ${alert.userAlias}`);
   } catch (err) {
     showToast(`Error: ${err.message}`, 'error');
   }
 };

 const handleDiscard = (alert) => {
 setDiscardModal({
      alertId: alert.id || alert.firestoreId,
      title: alert.title,
 });
 };

 const handleDiscardConfirm = async (values) => {
 if (!discardModal) return;
 try {
      await discardAlert(discardModal.alertId, values.reason);
      showToast(`Alerta descartada: ${discardModal.title}`);
 } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
 }
 setDiscardModal(null);
 };

 const handleEditUnidentified = (alert) => {
 const svcKey = serviceNameToKey(alert.service) || parseServiceKey(alert.serviceAccountRef) || alert._serviceKey;
 const usersKey = `${svcKey}_${alert.accountId}`;
 const users = groupUsers[usersKey] || [];
 const availableAccounts = svcKey ? getAvailableRealAccounts(svcKey) : [];

 setEditUserModal({
      alert,
      users,
      serviceKey: svcKey,
      availableAccounts,
 });
 };

 const handleEditUnidentifiedSave = async (values) => {
 if (!editUserModal) return;
 const { alert, users, serviceKey } = editUserModal;

 try {
      await completeUnidentifiedAlert(
        alert.id || alert.firestoreId,
        serviceKey,
        alert.accountId,
        values.userName,
        values.assignedTo,
        users,
      );
      showToast(` Usuario identificado: ${values.userName}${values.assignedTo ? ` → asignado a ${values.assignedTo}` : ''}`);
 } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
 }
 };

 // Determinar si la alerta tiene un usuario "no informado"
 const isUnidentified = (alert) => {
 const alias = (alert.userAlias || '').toLowerCase();
 return alias === 'usuario no informado' || alias === '?' || alias === 'desconocido';
 };

 // Renderizar botones de acción según el estado de la alerta
 const renderActions = (alert) => {
 if (alert.status === 'completed' || alert.status === 'done' || alert.status === 'discarded' || alert.status === 'cancelled_by_ai' || alert.status === 'cancelled_by_system' || alert.status === 'resolved') return null;

 return (
      <div className="alert-actions" onClick={e => e.stopPropagation()}>
        {/* Botón completar */}
        {alert.type === 'access_verify' ? (
          <button className="alert-action-btn complete" onClick={() => handleComplete(alert)}>
            <CheckCircleIcon size={16} /> Acceso verificado
          </button>
        ) : alert.type === 'missing_phone' ? (
          <button className="alert-action-btn assign" onClick={() => handleMissingPhone(alert)}>
            <PhoneIcon size={16} /> Escribir número
          </button>
        ) : alert.type === 'sim_recharge' ? (
          <button className="alert-action-btn complete" onClick={() => onNavigate?.('sim-cards')}>
            <CheckCircleIcon size={16} /> Ir a SIM Cards
          </button>
        ) : isUnidentified(alert) ? (
          <button className="alert-action-btn assign" onClick={() => handleEditUnidentified(alert)}>
            <EditIcon size={16} /> Completar info
          </button>
        ) : (
          <button className="alert-action-btn complete" onClick={() => handleComplete(alert)}>
            <CheckCircleIcon size={16} /> Completar
          </button>
        )}

        {/* Botón descartar */}
        <button className="alert-action-btn discard" onClick={() => handleDiscard(alert)}>
          <XCircleIcon size={16} /> Descartar
        </button>

        {/* Botón ir al servicio */}
        {isClickable(alert) && (
          <button className="alert-action-btn edit" onClick={() => handleAlertClick(alert)}>
            <LinkIcon size={16} /> Ver servicio
          </button>
        )}

        {/* Botón ir a Bóveda (para cambio de contraseña) */}
        {alert.type === 'password_change' && (
          <button
            className="alert-action-btn assign"
            onClick={() => onNavigate && onNavigate('vault', {
              serviceKey: serviceNameToKey(alert.service) || parseServiceKey(alert.serviceAccountRef),
              serviceAccountRef: alert.serviceAccountRef,
              tab: 'credentials',
            })}
          >
             Ir a Bóveda
          </button>
        )}
      </div>
 );
 };

 // Renderizar una tarjeta de alerta individual
 const renderAlertCard = (alert) => {
 const pm = PRIORITY_META[alert.priority] || PRIORITY_META.low;
 const { desc, highlights } = buildRichDescription(alert);
 const clickable = isClickable(alert);
 const svcKey = serviceNameToKey(alert.service) || parseServiceKey(alert.serviceAccountRef);
 const svcMeta = svcKey ? getServiceMeta(svcKey) : null;
 const isPending = alert.status === 'pending';

 return (
      <div
        className={`alert-card-v2 ${clickable && !isPending ? 'clickable' : ''}`}
        key={alert.id || alert.firestoreId}
        data-alert-user={alert.userAlias ? alert.userAlias.toLowerCase() : ''}
        style={{ '--alert-color': pm.color, '--alert-bg': pm.bg, '--alert-border': pm.border }}
        onClick={(e) => !isPending && clickable && handleAlertClick(alert, e)}
      >
        <div className="alert-v2-priority-bar" />
        <div className="alert-v2-content">
          <div className="alert-v2-top">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span className="alert-v2-priority-badge" style={{ background: pm.bg, color: pm.color, borderColor: pm.border }}>
                {pm.icon} {pm.label}
              </span>
              <span className="badge badge-muted">{TYPE_LABELS[alert.type] || alert.type}</span>
              {svcMeta && (
                <span className="alert-v2-svc-badge">
                  <img src={svcMeta.logo} alt="" style={{ width: '18px', height: '18px', borderRadius: '3px', objectFit: 'cover' }} />
                  {svcMeta.name}
                </span>
              )}
              {alert.aiGenerated && (
                <span className="alert-ai-badge" title={`Generada por IA${alert.confidence ? ` — Confianza: ${Math.round(alert.confidence * 100)}%` : ''}`}>
                  <SparkleIcon size={12} /> IA
                  {alert.confidence != null && <span className="alert-ai-confidence">{Math.round(alert.confidence * 100)}%</span>}
                </span>
              )}
              {isUnidentified(alert) && isPending && (
                <span className="missing-info-tag"><WarningIcon size={16} /> Sin nombre</span>
              )}
            </div>
            {clickable && !isPending && <span className="alert-v2-action-hint">Ir al servicio →</span>}
          </div>
          <div className="alert-v2-title">{alert.title}</div>
          <div className="alert-v2-desc">{desc}</div>
          {highlights.length > 0 && (
            <div className="alert-v2-highlights">
              {highlights.map((h, i) => (
                <span key={i} className="alert-v2-highlight">
                  {h.icon} <strong>{h.label}:</strong> <code>{h.value}</code>
                </span>
              ))}
            </div>
          )}

          {/* Botones de acción para alertas pendientes */}
          {isPending && renderActions(alert)}

          <div className="alert-v2-meta">
            {alert.userAlias && <span className="alert-v2-meta-tag"><TargetIcon size={16} /> {alert.userAlias}</span>}
            {alert.createdAt && (
              <span className="meta-dim"><CalendarIcon size={16} /> {new Date(alert.createdAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            )}
            {alert.completedAt && (
              <span style={{ color: 'var(--accent-success)' }}><CheckCircleIcon size={16} /> {new Date(alert.completedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</span>
            )}
            {alert.discardedAt && (
              <span style={{ color: 'var(--text-muted)' }}><XCircleIcon size={16} /> {new Date(alert.discardedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}</span>
            )}
            {alert.discardReason && <span className="alert-v2-discard-reason"><ChatIcon size={16} /> {alert.discardReason}</span>}
            {alert.source && alert.source !== 'system' && (
              <span className="badge badge-muted" style={{ fontSize: '11px', marginLeft: '6px', background: 'rgba(139,92,246,0.1)', color: '#8b5cf6' }}>
                {alert.source === 'adminbot' ? 'AdminBot' : alert.source}
              </span>
            )}
          </div>
        </div>
      </div>
 );
 };

 if (loading) return <div className="empty-state"><div className="loading-spinner" /></div>;

 return (
 <>
      <div className="section-header">
        <div className="section-title"> Centro de Alertas</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {['all', 'critical', 'high', 'medium', 'low'].map(p => {
            const meta = PRIORITY_META[p];
            const isActive = filterPriority === p;
            const count = p === 'all' ? null : priorityCounts[p];
            return (
              <button
                key={p}
                className={`alert-tab ${isActive ? 'active-tint' : ''}`}
                onClick={() => setFilterPriority(p)}
                style={isActive && p !== 'all' ? { '--tint-color': meta?.color, filter: 'none', background: meta?.color } : {}}
              >
                {p === 'all' ? 'Todas' : <>{meta?.icon} {meta?.label}</>}
                {count != null && count > 0 && (
                  <span className="alert-priority-count">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Buscador */}
      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Buscar por usuario, servicio, cuenta, descripción..."
        resultCount={searchQuery.length >= 2 ? totalCount : undefined}
      />

      {/* Tabs */}
      <div className="alerts-tabs">
        {[
          { key: 'pending', label: <><HourglassIcon size={16} /> Pendientes</>, count: categorized.pending.length },
          { key: 'completed', label: <><CheckCircleIcon size={16} /> Completadas</>, count: categorized.completed.length },
          { key: 'discarded', label: <><XCircleIcon size={16} /> Descartadas</>, count: categorized.discarded.length },
        ].map(tab => (
          <button
            key={tab.key}
            className={`alert-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}<span className="tab-count">({tab.count})</span>
          </button>
        ))}
      </div>

      {/* Alertas agrupadas */}
      {totalCount === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{activeTab === 'pending' ? <CelebrationIcon size={16} /> : <EmptyMailIcon size={16} />}</div>
          <p>{activeTab === 'pending' ? 'No hay alertas pendientes' : 'Sin alertas en esta categoría'}</p>
        </div>
      ) : (
        <>
          {groupedAlerts.groups.map(group => {
            const highestPm = Object.values(PRIORITY_META).find(p => p.order === group.highestPriority) || PRIORITY_META.low;
            const isCollapsed = collapsedGroups.has(String(group.accountId));
            const toggleCollapse = (e) => {
              e.stopPropagation();
              setCollapsedGroups(prev => {
                const next = new Set(prev);
                const key = String(group.accountId);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              });
            };
            return (
              <div className={`alerts-account-group${isCollapsed ? ' collapsed' : ''}`} key={group.accountId}>
                <div className="alerts-account-header" onClick={toggleCollapse} style={{ cursor: 'pointer' }}>
                  <div className="alerts-account-identity">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`alerts-chevron${isCollapsed ? '' : ' open'}`}><polyline points="6 9 12 15 18 9"/></svg>
                    <img
                      src={getProfileImg(group.accountId)}
                      className="alerts-account-avatar"
                      alt=""
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                    <div>
                      <div className="alerts-account-name">
                        <span className="alerts-account-id">#{group.accountId}</span>
                        {group.accountAlias}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="badge" style={{ background: highestPm.bg, color: highestPm.color, borderColor: highestPm.border, border: '1px solid' }}>
                      {highestPm.icon} {highestPm.label}
                    </span>
                    <span className="badge badge-info">{group.alerts.length} alerta{group.alerts.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="alerts-account-list">
                    {group.alerts.map(renderAlertCard)}
                  </div>
                )}
              </div>
            );
          })}

          {groupedAlerts.ungrouped.length > 0 && (
            <div className="alerts-account-group alerts-ungrouped">
              <div className="alerts-account-header">
                <div className="alerts-account-identity">
                  <span style={{ fontSize: '24px' }}><ClipboardIcon size={16} /></span>
                  <div>
                    <div className="alerts-account-name">Sin cuenta asignada</div>
                  </div>
                </div>
                <span className="badge badge-muted">{groupedAlerts.ungrouped.length} alerta{groupedAlerts.ungrouped.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="alerts-account-list">
                {groupedAlerts.ungrouped.map(renderAlertCard)}
              </div>
            </div>
          )}
        </>
      )}

      {/* Modal: Descartar alerta */}
      <EditModal
        open={!!discardModal}
        onClose={() => setDiscardModal(null)}
        onSave={handleDiscardConfirm}
        title="Descartar alerta"
        icon={<XCircleIcon size={16} />}
        fields={[
          { key: 'reason', label: 'Razón del descarte', type: 'textarea', placeholder: 'Ej: Ya no es relevante, la cuenta expiró...', required: true },
        ]}
        initialValues={{ reason: '' }}
        saveLabel="Descartar"
        danger
      />

      {/* Modal: Completar info de usuario no identificado */}
      <EditModal
        open={!!editUserModal}
        onClose={() => setEditUserModal(null)}
        onSave={handleEditUnidentifiedSave}
        title="Completar información"
        icon=""
        fields={[
          { key: 'userName', label: 'Nombre del usuario', placeholder: 'Ej: Juan Pérez', required: true },
          ...(editUserModal?.availableAccounts?.length > 0 ? [{
            key: 'assignedTo', label: 'Asignar a cuenta real', type: 'select',
            placeholder: 'Seleccionar cuenta real...',
            options: editUserModal.availableAccounts,
            hint: 'Selecciona la cuenta real donde le darás acceso',
          }] : []),
        ]}
        initialValues={{ userName: '', assignedTo: '' }}
        saveLabel="Guardar y completar"
      >
        {editUserModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{editUserModal.alert.service}</strong> — Cuenta Lank #{editUserModal.alert.accountId} ({editUserModal.alert.accountAlias})
            {editUserModal.users.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Usuarios actuales:</span>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                  {editUserModal.users.map((u, i) => {
                    const alias = typeof u === 'string' ? u : (u.userAlias || '?');
                    return <span key={i} className="badge badge-info">{alias}</span>;
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </EditModal>

      {/* Diálogo: Confirmar completación de alerta */}
      <ConfirmDialog
        open={!!confirmComplete}
        onClose={() => setConfirmComplete(null)}
        onConfirm={handleConfirmComplete}
        title="Completar alerta"
        message={confirmComplete ? `¿Marcar como completada la alerta "${confirmComplete.alert.title}"?` : ''}
        confirmLabel={<><CheckCircleIcon size={16} /> Sí, completar</>}
        icon={<CheckCircleIcon size={16} />}
      />
      {/* Modal: Teléfono faltante */}
      <EditModal
        open={!!missingPhoneModal}
        onClose={() => setMissingPhoneModal(null)}
        onSave={handleMissingPhoneSave}
        title={`Agregar teléfono — ${missingPhoneModal?.alert?.service || 'Servicio'}`}
        icon=""
        fields={[
          {
            key: 'phone',
            label: 'Número de teléfono / WhatsApp',
            required: true,
            placeholder: '+525512345678',
            hint: 'Formato con código de país. Ej: +52 para México.',
          },
        ]}
        initialValues={{ phone: '' }}
        saveLabel="Guardar teléfono"
        confirmMessage={
          missingPhoneModal
            ? `¿Guardar número de teléfono para "${missingPhoneModal.alert.userAlias}" del grupo #${missingPhoneModal.alert.accountId}?`
            : ''
        }
      >
        {missingPhoneModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{missingPhoneModal.alert.userAlias}</strong>
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Grupo #{missingPhoneModal.alert.accountId} — {missingPhoneModal.alert.accountAlias}
              {missingPhoneModal.alert.service && ` — ${missingPhoneModal.alert.service}`}
            </div>
          </div>
        )}
      </EditModal>

      {/* Toast */}
      <Toast {...toast} onClose={() => setToast(prev => ({ ...prev, visible: false }))} />
 </>
 );
}
