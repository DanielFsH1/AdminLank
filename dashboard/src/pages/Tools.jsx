import { useState, useCallback, useEffect, useRef } from 'react';

import { collection, getDocs, doc, getDoc, deleteDoc, addDoc } from 'firebase/firestore';

import { db, storage } from '../firebase';
import { useDocument } from '../hooks/useFirestore';
import { ACCESS_TYPES, buildServiceConfig, normalizeServiceKey } from '../config/services';
import { setServiceCatalogEntryActive, upsertServiceCatalogEntry } from '../hooks/firestoreActions';
import { authenticatedFetch, ensureAdminFunctionResponse } from '../utils/authenticatedFetch';
import { buildCloudFunctionUrl } from '../config/runtime';
import { uploadLogoFile } from '../utils/logoUploads';

import { AnalyzeIcon, BankIcon, BarChartIcon, BellIcon, CheckCircleIcon, CheckboxChecked, CheckboxEmpty, CleanIcon, ClockIcon, ContainerIcon, CreditCardIcon, DollarIcon, DownloadIcon, EditIcon, EmailIcon, FileStorageIcon, HourglassIcon, ImageIcon, KeyIcon, LightbulbIcon, LockIcon, LockKeyIcon, MailboxIcon, MoneyIcon, PackageIcon, PlusIcon, SaveIcon, ShieldCheckIcon, ToggleOnIcon, ToggleOffIcon, TrashIcon, TrendUpIcon, UploadIcon, UsersIcon, WarningIcon, XCircleIcon } from '../components/Icons';
import { ModalActions, ModalShell } from '../components/Modal';

import CryptoJS from 'crypto-js';

function hashPin(pin) {
  return CryptoJS.SHA256(pin + '_AdminLank_VaultPIN_2026').toString();
}

/* ─── Collection map ───────────────────────────────────────────────────────── */

const COLLECTIONS = [

 { key: 'config/account-registry', label: 'Registro de Cuentas', icon: <UsersIcon size={16} />, type: 'doc', desc: 'Cuentas configuradas' },
 { key: 'config/imap-credentials', label: 'Credenciales IMAP', icon: <LockKeyIcon size={16} />, type: 'doc', desc: 'App Passwords de Gmail', sensitive: true },
 { key: 'config/rates', label: 'Tarifas', icon: <DollarIcon size={16} />, type: 'doc', desc: 'Precios de suscripciones' },
 { key: 'config/services', label: 'Catálogo de Servicios', icon: <PackageIcon size={16} />, type: 'doc', desc: 'Servicios dinámicos y reglas operativas' },
 { key: 'config/schedule', label: 'Configuración Schedule', icon: <ClockIcon size={16} />, type: 'doc', desc: 'Análisis programado' },
 { key: 'config/subscription-master', label: 'Suscripción Master', icon: <KeyIcon size={16} />, type: 'doc', desc: 'Config de slots por servicio' },
 { key: 'config/vault-security', label: 'Seguridad Bóveda', icon: <LockIcon size={16} />, type: 'doc', desc: 'PIN hasheado de la Bóveda', sensitive: true },
 { key: 'secrets', label: 'Secretos (Bóveda)', icon: <LockKeyIcon size={16} />, type: 'collection', desc: 'Contraseñas cifradas de servicios', sensitive: true },
 { key: 'vault-cards', label: 'Tarjetas (Bóveda)', icon: <CreditCardIcon size={16} />, type: 'collection', desc: 'Datos de tarjetas de pago', sensitive: true },
 { key: 'analysis/state', label: 'Estado de Análisis', icon: <AnalyzeIcon size={16} />, type: 'doc', desc: 'UIDs procesados' },
 { key: 'analysis/latest-report', label: 'Último Reporte', icon: <BarChartIcon size={16} />, type: 'doc', desc: 'Resumen del análisis' },
 { key: 'analysis/raw-emails', label: 'Correos Crudos', icon: <EmailIcon size={16} />, type: 'doc', desc: 'Emails sin procesar' },
 { key: 'alerts', label: 'Alertas', icon: <BellIcon size={16} />, type: 'collection', desc: 'Alertas del sistema' },
 { key: 'notifications', label: 'Notificaciones', icon: <MailboxIcon size={16} />, type: 'collection', desc: 'Correos detectados (7 días)' },
 { key: 'groups', label: 'Grupos de Suscripción', icon: <KeyIcon size={16} />, type: 'collection-deep', desc: 'Pools con sub-colecciones', subs: ['lank-accounts'] },
 { key: 'service-pools', label: 'Cuentas Reales', icon: <BankIcon size={16} />, type: 'collection-deep', desc: 'Real accounts con sub-colecciones', subs: ['real-accounts'], sensitive: true },
 { key: 'subscriptions', label: 'Suscripciones', icon: <CreditCardIcon size={16} />, type: 'collection', desc: 'Datos de suscripciones' },
 { key: 'finance', label: 'Finanzas', icon: <MoneyIcon size={16} />, type: 'collection-deep', desc: 'Datos financieros', subs: ['history'] },
 { key: 'accounts', label: 'Cuentas', icon: <UsersIcon size={16} />, type: 'collection', desc: 'Registro original de cuentas Lank' },
 { key: 'audit-log', label: 'Historial de Cambios', icon: <ClockIcon size={16} />, type: 'collection', desc: 'Registro de todas las acciones del sistema' },
];

const ALL_KEY = '__ALL__';

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

function timestamp() {

 const d = new Date();

 return `${d.getFullYear()}${(d.getMonth()+1).toString().padStart(2,'0')}${d.getDate().toString().padStart(2,'0')}_${d.getHours().toString().padStart(2,'0')}${d.getMinutes().toString().padStart(2,'0')}`;

}

function downloadJson(data, filename) {

 const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });

 const url = URL.createObjectURL(blob);

 const a = document.createElement('a');

 a.href = url;
 a.download = filename;
 document.body.appendChild(a);
 a.click();
 document.body.removeChild(a);
 URL.revokeObjectURL(url);

}

function downloadCsv(rows, filename) {

 if (!rows.length) return;

 const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];

 const escape = v => {

 if (v == null) return '';

 const s = typeof v === 'object' ? JSON.stringify(v) : String(v);

 return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;

 };

 const csv = [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');

 const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });

 const url = URL.createObjectURL(blob);

 const a = document.createElement('a');

 a.href = url;
 a.download = filename;
 document.body.appendChild(a);
 a.click();
 document.body.removeChild(a);
 URL.revokeObjectURL(url);

}

/** Fetch a single Firestore doc path */

async function fetchDoc(path) {

 const parts = path.split('/');

 const snap = await getDoc(doc(db, ...parts));

 return snap.exists() ? { id: snap.id, ...snap.data() } : null;

}

/** Fetch all docs in a collection */

async function fetchCollection(path) {

 const snap = await getDocs(collection(db, path));

 return snap.docs.map(d => ({ id: d.id, ...d.data() }));

}

/** Fetch collection + sub-collections */

async function fetchDeep(path, subs) {

 const parentDocs = await fetchCollection(path);

 const result = {};

 for (const parentDoc of parentDocs) {
 result[parentDoc.id] = { ...parentDoc };
 for (const sub of subs) {
      const subDocs = await fetchCollection(`${path}/${parentDoc.id}/${sub}`);
      if (subDocs.length) result[parentDoc.id][`_${sub}`] = subDocs;
 }

 }

 return result;

}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/* ─── Main component ────────────────────────────────────────────────────────── */

export default function Tools() {
 const { data: servicesDoc } = useDocument('config', 'services');

 const [selected, setSelected] = useState(new Set());

 const [progress, setProgress] = useState(null);

 const [lastExport, setLastExport] = useState(null);

 const [stats, setStats] = useState(null);

 const [statsLoading, setStatsLoading] = useState(false);

 const [purgeConfirm, setPurgeConfirm] = useState(null);

 const [purgeProgress, setPurgeProgress] = useState(null);

 const [pinModal, setPinModal] = useState(null); // { format?, purpose: 'export'|'cleanup_cs'|'cleanup_ar'|'cleanup_all'|'save_policies' }

 const [pinInput, setPinInput] = useState('');

 const [pinError, setPinError] = useState('');

 // Deploy Storage (Cloud Storage + Artifact Registry)

 const [storageData, setStorageData] = useState(null);

 const [storageLoading, setStorageLoading] = useState(false);

 const [storageError, setStorageError] = useState(null);

 const [cleanupResult, setCleanupResult] = useState(null);

 const [cleanupLoading, setCleanupLoading] = useState(false);

 // Policies

 const [policies, setPolicies] = useState(null);

 const [policiesDirty, setPoliciesDirty] = useState(false);

 const [policySaving, setPolicySaving] = useState(false);

 const [serviceModal, setServiceModal] = useState(null);
 const [serviceForm, setServiceForm] = useState(null);
 const [serviceSaving, setServiceSaving] = useState(false);
 const [serviceError, setServiceError] = useState('');
 const [serviceLogoUploading, setServiceLogoUploading] = useState(false);
 const serviceLogoInputRef = useRef(null);

 const serviceCatalog = servicesDoc?.services || {};
 const serviceEntries = Object.entries(serviceCatalog)
   .filter(([key]) => key !== 'id' && key !== 'updatedAt')
   .sort(([, a], [, b]) => {
     const aActive = a.active !== false;
     const bActive = b.active !== false;
     if (aActive && !bActive) return -1;
     if (!aActive && bActive) return 1;
     return (a.displayOrder || 99) - (b.displayOrder || 99);
   });

 const openServiceModal = (serviceKey = null) => {
   const existing = serviceKey ? serviceCatalog[serviceKey] : {};
   const accessType = existing?.accessType || 'email_invitation';
   setServiceModal({ serviceKey, mode: serviceKey ? 'edit' : 'create' });
   setServiceForm({
     serviceKey: serviceKey || '',
     name: existing?.name || '',
     active: existing?.active !== false,
     usesPool: existing?.usesPool !== false,
     accessType,
     color: existing?.color || '#64748b',
     logo: existing?.logo || '',
     maxSlotsPerRealAccount: existing?.maxSlotsPerRealAccount || existing?.maxSlots || 5,
     maxSlotsPerLankGroup: existing?.maxSlotsPerLankGroup || existing?.maxSlots || 5,
     displayOrder: existing?.displayOrder || serviceEntries.length + 1,
     nameAliases: (existing?.nameAliases || []).join(', '),
   });
   setServiceError('');
 };

 const updateServiceForm = (field, value) => {
   setServiceForm(prev => {
     const next = { ...prev, [field]: value };
     if (field === 'name' && serviceModal?.mode === 'create') {
       next.serviceKey = normalizeServiceKey(value);
     }
     return next;
   });
 };

 const handleSaveService = async () => {
   if (!serviceForm) return;
   setServiceSaving(true);
   setServiceError('');
   try {
     const payload = {
       ...serviceForm,
       nameAliases: serviceForm.nameAliases
         .split(',')
         .map(alias => alias.trim())
         .filter(Boolean),
     };
     await upsertServiceCatalogEntry(payload, { previousKey: serviceModal?.serviceKey || undefined });
     setServiceModal(null);
     setServiceForm(null);
   } catch (err) {
     setServiceError(err.message || 'No se pudo guardar el servicio');
   } finally {
     setServiceSaving(false);
   }
 };

 const handleUploadServiceLogo = async (file) => {
   if (!file || !serviceForm) return;
   setServiceLogoUploading(true);
   setServiceError('');
   try {
     const keyOrName = serviceForm.serviceKey || serviceForm.name || file.name;
     const logo = await uploadLogoFile(storage, file, {
       folder: 'service-logos',
       displayName: keyOrName,
     });
     updateServiceForm('logo', logo.url);
   } catch (err) {
     setServiceError(err.message || 'No se pudo subir el logo');
   } finally {
     setServiceLogoUploading(false);
   }
 };

 const handleToggleService = async (serviceKey, active) => {
   setServiceSaving(true);
   setServiceError('');
   try {
     await setServiceCatalogEntryActive(serviceKey, active);
   } catch (err) {
     setServiceError(err.message || 'No se pudo cambiar el estado del servicio');
   } finally {
     setServiceSaving(false);
   }
 };

 const toggleSelect = (key) => {

 setSelected(prev => {
      const next = new Set(prev);
      if (key === ALL_KEY) {
        return next.size === COLLECTIONS.length ? new Set() : new Set(COLLECTIONS.map(c => c.key));
      }
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
 });

 };

 /* ─── Export ─────────────────────────────────────────────────────────────── */

 const hasSensitiveSelected = COLLECTIONS.some(c => selected.has(c.key) && c.sensitive);

 const handleExportRequest = (format) => {
   if (!selected.size) return;
   if (COLLECTIONS.some(c => selected.has(c.key) && c.sensitive)) {
     setPinModal({ format, purpose: 'export' });
     setPinInput('');
     setPinError('');
   } else {
     doExport(format);
   }
 };

 /* ─── PIN verification (recibe el PIN como argumento para evitar closure stale) ─── */

 const verifyPin = async (pin) => {
   if (!pin || pin.length !== 4) { setPinError('Ingresa 4 dígitos'); return; }
   const hashed = hashPin(pin);
   try {
     const pinDoc = await getDoc(doc(db, 'config', 'vault-security'));
     if (pinDoc.exists() && pinDoc.data().pinHash === hashed) {
       const purpose = pinModal?.purpose;
       const format = pinModal?.format;
       setPinModal(null);
       setPinInput('');
       setPinError('');
       if (purpose === 'export' && format) doExport(format);
       else if (purpose === 'save_policies') savePolicies(hashed);
       else if (purpose?.startsWith('cleanup_')) doCleanup(purpose, hashed);
     } else {
       setPinError('PIN incorrecto');
       setPinInput('');
     }
   } catch (err) {
     setPinError('Error verificando PIN: ' + err.message);
   }
 };

 const pinInputRef = useRef(pinInput);

 pinInputRef.current = pinInput;

 const verifyPinRef = useRef(verifyPin);

 verifyPinRef.current = verifyPin;

 // Soporte de teclado físico para el PIN modal
 useEffect(() => {
   if (!pinModal) return;
   const handleKeyDown = (e) => {
     if (e.key >= '0' && e.key <= '9' && pinInputRef.current.length < 4) {
       e.preventDefault();
       const newPin = pinInputRef.current + e.key;
       setPinInput(newPin);
       setPinError('');
       if (newPin.length === 4) {
         setTimeout(() => verifyPinRef.current(newPin), 200);
       }
     } else if (e.key === 'Backspace') {
       e.preventDefault();
       setPinInput(prev => prev.slice(0, -1));
       setPinError('');
     } else if (e.key === 'Escape') {
       setPinModal(null);
     }
   };
   document.addEventListener('keydown', handleKeyDown);
   return () => document.removeEventListener('keydown', handleKeyDown);
 }, [pinModal]);

 const doExport = useCallback(async (format) => {

 if (!selected.size) return;

 const toExport = COLLECTIONS.filter(c => selected.has(c.key));

 setProgress({ current: 0, total: toExport.length, label: 'Preparando...' });

 const result = {};

 try {
      for (let i = 0; i < toExport.length; i++) {
        const col = toExport[i];
        setProgress({ current: i + 1, total: toExport.length, label: col.label });
        if (col.type === 'doc') {
          result[col.key] = await fetchDoc(col.key);
        } else if (col.type === 'collection') {
          result[col.key] = await fetchCollection(col.key);
        } else if (col.type === 'collection-deep') {
          result[col.key] = await fetchDeep(col.key, col.subs || []);
        }
      }
      const ts = timestamp();
      if (format === 'json') {
        downloadJson(result, `adminlank_export_${ts}.json`);
      } else {
        for (const [key, data] of Object.entries(result)) {
          const rows = Array.isArray(data) ? data : data ? [data] : [];
          if (rows.length) downloadCsv(rows, `adminlank_${key.replace(/\//g, '_')}_${ts}.csv`);
        }
      }
      setLastExport({ time: new Date().toLocaleString('es-MX'), count: toExport.length, format });
 } catch (err) {
      console.error('Export error:', err);
      alert(`Error en la exportación: ${err.message}`);
 } finally {
      setProgress(null);
 }

 }, [selected]);

 /* ─── Stats ──────────────────────────────────────────────────────────────── */

 const loadStats = useCallback(async () => {

 setStatsLoading(true);

 const result = [];

 for (const col of COLLECTIONS) {
      try {
        if (col.type === 'doc') {
          const data = await fetchDoc(col.key);
          const fields = data ? Object.keys(data).filter(k => k !== 'id').length : 0;
          const size = data ? JSON.stringify(data).length : 0;
          result.push({ ...col, docCount: data ? 1 : 0, fields, size });
        } else if (col.type === 'collection') {
          const docs = await fetchCollection(col.key);
          const size = JSON.stringify(docs).length;
          result.push({ ...col, docCount: docs.length, fields: null, size });
        } else if (col.type === 'collection-deep') {
          const parentDocs = await fetchCollection(col.key);
          let totalSubs = 0;
          for (const pd of parentDocs) {
            for (const sub of (col.subs || [])) {
              const subDocs = await fetchCollection(`${col.key}/${pd.id}/${sub}`);
              totalSubs += subDocs.length;
            }
          }
          result.push({ ...col, docCount: parentDocs.length, subDocs: totalSubs, size: null });
        }
      } catch (err) {
        result.push({ ...col, docCount: '·', error: err.message });
      }
 }

 setStats(result);
 setStatsLoading(false);

 }, []);

 /* ─── Purge ──────────────────────────────────────────────────────────────── */

 const handlePurge = useCallback(async (action) => {

 setPurgeConfirm(null);
 setPurgeProgress({ label: 'Procesando...', detail: '' });
 try {
      if (action === 'notifications') {
        const docs = await fetchCollection('notifications');
        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        let deleted = 0;
        for (const d of docs) {
          const createdAt = d.createdAt?.toDate?.() ? d.createdAt.toDate().getTime() :
                           d.createdAt ? new Date(d.createdAt).getTime() : 0;
          if (createdAt && (now - createdAt) > sevenDays) {
            await deleteDoc(doc(db, 'notifications', d.id));
            deleted++;
          }
        }
        setPurgeProgress({ label: 'Completado', detail: `${deleted} notificaciones antiguas eliminadas de ${docs.length} totales` });
      }
      else if (action === 'completed-alerts') {
        const docs = await fetchCollection('alerts');
        const now = Date.now();
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        let deleted = 0;
        for (const d of docs) {
          if (d.status === 'completed' || d.status === 'done' || d.status === 'discarded' || d.status === 'cancelled_by_ai' || d.status === 'cancelled_by_system' || d.status === 'resolved') {
            const doneAt = (d.completedAt || d.discardedAt);
            const doneTime = doneAt?.toDate?.() ? doneAt.toDate().getTime() :
                            doneAt ? new Date(doneAt).getTime() : 0;
            if (doneTime && (now - doneTime) > thirtyDays) {
              await deleteDoc(doc(db, 'alerts', d.id));
              deleted++;
            }
          }
        }
        setPurgeProgress({ label: 'Completado', detail: `${deleted} alertas antiguas eliminadas` });
        if (deleted > 0) {
          try {
            await addDoc(collection(db, 'audit-log'), {
              action: 'purge_alerts', source: 'manual', actor: 'admin',
              timestamp: new Date().toISOString(),
              description: `Limpieza manual: ${deleted} alertas resueltas eliminadas (más de 30 días)`,
              collection: 'alerts', after: { deleted_count: deleted },
            });
          } catch (_) { /* silenciar */ }

        }
      }
      else if (action === 'raw-emails') {
        const snap = await getDoc(doc(db, 'analysis', 'raw-emails'));
        if (snap.exists()) {
          await deleteDoc(doc(db, 'analysis', 'raw-emails'));
          setPurgeProgress({ label: 'Completado', detail: 'Documento analysis/raw-emails eliminado' });
        } else {
          setPurgeProgress({ label: 'Completado', detail: 'No existía analysis/raw-emails' });
        }
      }
 } catch (err) {
      setPurgeProgress({ label: 'Error', detail: err.message });
 }
  }, []);

  /* ─── Deploy Storage (Cloud Storage + Artifact Registry) ──────────────────── */

  const loadStorageData = useCallback(async () => {
    setStorageLoading(true);
    setStorageError(null);
    try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('manage_storage'));
      await ensureAdminFunctionResponse(res);
      const data = await res.json();
      setStorageData(data);
      if (data.policies) {
        setPolicies(data.policies);
        setPoliciesDirty(false);
      }
    } catch (err) {
      setStorageError(err.message);
    } finally {
      setStorageLoading(false);
    }
  }, []);
  const requestCleanup = useCallback((action) => {
    setPinModal({ purpose: action });
    setPinInput('');
    setPinError('');
  }, []);
  const doCleanup = useCallback(async (action, pinHash) => {
    setCleanupLoading(true);
    setCleanupResult(null);
    try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('manage_storage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, pinHash }),
      });
      await ensureAdminFunctionResponse(res);
      const data = await res.json();
      setCleanupResult(data);
      setTimeout(() => loadStorageData(), 1500);
    } catch (err) {
      setCleanupResult({ error: err.message });
    } finally {
      setCleanupLoading(false);
    }
  }, [loadStorageData]);
  const updatePolicy = useCallback((storageType, field, value) => {
    setPolicies(prev => ({
      ...prev,
      [storageType]: { ...prev?.[storageType], [field]: value },
    }));
    setPoliciesDirty(true);
  }, []);
  const savePolicies = useCallback(async (pinHash) => {
    setPolicySaving(true);
    try {
      const res = await authenticatedFetch(buildCloudFunctionUrl('manage_storage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_policies', policies, pinHash }),
      });
      await ensureAdminFunctionResponse(res);
      setPoliciesDirty(false);
    } catch (err) {
      setStorageError(`Error guardando políticas: ${err.message}`);
    } finally {
      setPolicySaving(false);
    }
  }, [policies]);

  /* ─── Render ──────────────────────────────────────────────────────────────── */

 const allSelected = selected.size === COLLECTIONS.length;
 const FREE_LIMIT_GB = 5;
  const csTotalBytes = storageData?.cloudStorage?.totalSizeBytes || 0;
  const arTotalBytes = storageData?.artifactRegistry?.totalSizeBytes || 0;
  const totalStorageBytes = csTotalBytes + arTotalBytes;
 const usagePct = (totalStorageBytes / (FREE_LIMIT_GB * 1024 * 1024 * 1024)) * 100;
 const servicePreview = serviceForm ? buildServiceConfig(serviceForm).config : null;
 return (
 <>
      {/* ─── Service Catalog ────────────────────────────────────────────── */}

      <div className="tools-section">
        <div className="tools-section-header">
          <div>
            <h3 className="tools-section-title">
              <span className="tools-section-icon"><KeyIcon size={16} /></span>
              Catálogo de servicios
            </h3>
            <p className="tools-section-desc">Alta, pausa y reglas operativas para suscripciones dinámicas</p>
          </div>
          <button className="tools-btn tools-btn-primary" onClick={() => openServiceModal()}>
            <PlusIcon size={16} /> Nuevo servicio
          </button>
        </div>
        {serviceError && (
          <div className="tools-result tools-result-error">
            <XCircleIcon size={16} /> {serviceError}
          </div>
        )}
        <div className="tools-svc-grid">
          {serviceEntries.map(([serviceKey, service]) => (
            <div key={serviceKey} className={`tools-svc-card ${service.active === false ? 'tools-svc-inactive' : ''}`}>
              <div className="tools-svc-card-header" style={{ borderLeftColor: service.color || '#64748b' }}>
                {service.logo ? (
                  <img src={service.logo} alt="" className="tools-svc-logo" />
                ) : (
                  <div className="tools-svc-logo" style={{ background: service.color || '#64748b' }} />
                )}
                <div className="tools-svc-card-info">
                  <div className="tools-svc-card-name">{service.name || serviceKey}</div>
                  <div className="tools-svc-card-meta">
                    <span className="tools-svc-card-key">{serviceKey}</span>
                    <span className={`tools-svc-badge ${service.active === false ? 'tools-svc-badge-inactive' : 'tools-svc-badge-active'}`}>
                      {service.active === false ? 'Pausado' : 'Activo'}
                    </span>
                    <span className="tools-svc-badge tools-svc-badge-type">
                      {ACCESS_TYPES[service.accessType]?.label || service.accessType || 'Invitacion'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="tools-svc-card-details">
                <span>{service.usesPool === false ? 'Sin pool' : 'Con pool'}</span>
                <span>{service.maxSlotsPerRealAccount || service.maxSlots || 5} cupos/cuenta</span>
                <span>{service.maxSlotsPerLankGroup || service.maxSlots || 5} cupos/grupo</span>
              </div>
              <div className="tools-svc-card-actions">
                <button className="tools-btn tools-btn-secondary" onClick={() => openServiceModal(serviceKey)}>
                  <EditIcon size={14} /> Editar
                </button>
                <button
                  className={`tools-btn ${service.active === false ? 'tools-btn-primary' : 'tools-btn-warning'}`}
                  onClick={() => handleToggleService(serviceKey, service.active === false)}
                  disabled={serviceSaving}
                >
                  {service.active === false ? <><ToggleOnIcon size={14} /> Activar</> : <><ToggleOffIcon size={14} /> Pausar</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>


      {/* ─── Export Section ─────────────────────────────────────────────── */}

      <div className="tools-section">
        <div className="tools-section-header">
          <div>
            <h3 className="tools-section-title">
              <span className="tools-section-icon"><PackageIcon size={16} /></span>
              Exportar Base de Datos
            </h3>
            <p className="tools-section-desc">Selecciona las colecciones a exportar y elige el formato de descarga</p>
          </div>
          <div className="tools-export-actions">
            <button
              className="tools-btn tools-btn-primary"
              onClick={() => handleExportRequest('json')}
              disabled={!selected.size || progress}
            >
              <DownloadIcon size={16} /> Exportar JSON
            </button>
            <button
              className="tools-btn tools-btn-secondary"
              onClick={() => handleExportRequest('csv')}
              disabled={!selected.size || progress}
            >
               Exportar CSV
            </button>
            {hasSensitiveSelected && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#f59e0b', fontWeight: 500 }}>
                <LockIcon size={12} /> Requiere PIN
              </span>
            )}
          </div>
        </div>
        {progress && (
          <div className="tools-progress">
            <div className="tools-progress-bar">
              <div className="tools-progress-fill" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
            <span className="tools-progress-text">
              {progress.label} ({progress.current}/{progress.total})
            </span>
          </div>
        )}
        {lastExport && !progress && (
          <div className="tools-result tools-result-ok">
             Se exportaron {lastExport.count} colecci&oacute;n(es) en formato {lastExport.format.toUpperCase()} &mdash; {lastExport.time}
          </div>
        )}
        <div className="tools-collection-list">
          <div
            className={`tools-collection-item tools-collection-all ${allSelected ? 'selected' : ''}`}
            onClick={() => toggleSelect(ALL_KEY)}
          >
            <div className="tools-collection-check">{allSelected ? <CheckboxChecked size={16} /> : <CheckboxEmpty size={16} />}</div>
            <span className="tools-collection-icon"></span>
            <div className="tools-collection-info">
              <div className="tools-collection-label">Seleccionar todo</div>
              <div className="tools-collection-desc">{COLLECTIONS.length} colecciones disponibles</div>
            </div>
          </div>
          {COLLECTIONS.map(col => {
            const isSelected = selected.has(col.key);
            return (
              <div
                key={col.key}
                className={`tools-collection-item ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleSelect(col.key)}
              >
                <div className="tools-collection-check">{isSelected ? <CheckboxChecked size={16} /> : <CheckboxEmpty size={16} />}</div>
                <span className="tools-collection-icon">{col.icon}</span>
                <div className="tools-collection-info">
                  <div className="tools-collection-label">
                    {col.label}
                    {col.sensitive && <span className="tools-sensitive-badge"><LockIcon size={16} /> Sensible</span>}
                  </div>
                  <div className="tools-collection-desc">{col.desc}</div>
                </div>
                <span className="tools-collection-path">{col.key}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Almacenamiento de Deploy ───────────────────────────────────── */}

      <div className="tools-section">
        <div className="tools-section-header">
          <div>
            <h3 className="tools-section-title">
              <span className="tools-section-icon"><FileStorageIcon size={16} /></span>
              Almacenamiento de Deploy
            </h3>
            <p className="tools-section-desc">Gestiona Cloud Storage (ZIPs) y Artifact Registry (Docker) generados por cada deploy de Cloud Functions.</p>
          </div>
          <button
            className="tools-btn tools-btn-primary"
            onClick={loadStorageData}
            disabled={storageLoading}
          >
            {storageLoading ? '\u27F3 Cargando...' : <><BarChartIcon size={16} /> Cargar uso</>}
          </button>
        </div>
        {storageError && (
          <div className="tools-result tools-result-error">
            <XCircleIcon size={16} /> Error: {storageError}
          </div>
        )}
        {storageData && (
          <>
            {/* Resumen combinado */}

            <div className="tools-storage-summary">
              <div className="tools-storage-gauge">
                <div className="tools-storage-gauge-bar">
                  <div
                    className="tools-storage-gauge-fill"
                    style={{
                      width: `${Math.min(usagePct, 100)}%`,
                      background: usagePct > 80 ? 'linear-gradient(90deg, #ef4444, #dc2626)' : usagePct > 50 ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary, #6366f1))',
                    }}
                  />
                </div>
                <div className="tools-storage-gauge-labels">
                  <span>{formatBytes(totalStorageBytes)} usados</span>
                  <span>{FREE_LIMIT_GB} GB gratis</span>
                </div>
              </div>
              <div className="tools-storage-stats">
                <div className="tools-storage-stat-item">
                  <span className="tools-storage-stat-value">{formatBytes(csTotalBytes)}</span>
                  <span className="tools-storage-stat-label"><FileStorageIcon size={12} /> Cloud Storage</span>
                </div>
                <div className="tools-storage-stat-item">
                  <span className="tools-storage-stat-value">{formatBytes(arTotalBytes)}</span>
                  <span className="tools-storage-stat-label"><ContainerIcon size={12} /> Artifact Registry</span>
                </div>
                <div className="tools-storage-stat-item">
                  <span className="tools-storage-stat-value" style={{ color: ((storageData?.cloudStorage?.cleanableSizeBytes || 0) + (storageData?.artifactRegistry?.cleanableSizeBytes || 0)) > 0 ? '#f59e0b' : 'var(--text-muted)' }}>
                    {formatBytes((storageData?.cloudStorage?.cleanableSizeBytes || 0) + (storageData?.artifactRegistry?.cleanableSizeBytes || 0))}
                  </span>
                  <span className="tools-storage-stat-label">Eliminable total</span>
                </div>
                <div className="tools-storage-stat-item">
                  <span className="tools-storage-stat-value" style={{
                    color: usagePct > 80 ? '#ef4444' : usagePct > 50 ? '#f59e0b' : 'var(--accent-primary)',
                  }}>{usagePct.toFixed(1)}%</span>
                  <span className="tools-storage-stat-label">Cuota usada</span>
                </div>
              </div>
            </div>

            {/* ─── Cloud Storage (ZIPs) ─── */}

            {storageData.cloudStorage && !storageData.cloudStorage.error && (
              <div className="tools-storage-subsection">
                <h4 className="tools-storage-subsection-title">
                  <FileStorageIcon size={14} /> Cloud Storage
                  <span className="tools-storage-subsection-meta">

                    ── {storageData.cloudStorage.buckets?.length || 0} bucket(s), {storageData.cloudStorage.totalObjects || 0} objetos

                  </span>
                </h4>
                {storageData.cloudStorage.buckets?.map(bucket => (
                  <div key={bucket.name} className="tools-storage-bucket">
                    <div className="tools-storage-bucket-header">
                      <div>
                        <span className="tools-storage-bucket-type">
                          {bucket.type === 'sources' ? <><PackageIcon size={12} /> Código Fuente</> : <><CleanIcon size={12} /> Builds Compilados</>}
                        </span>
                        <span className="tools-storage-bucket-name">{bucket.name}</span>
                      </div>
                      <span className="tools-storage-bucket-size">
                        {formatBytes(bucket.totalSizeBytes)}
                        {bucket.cleanableSizeBytes > 0 && (
                          <span style={{ color: '#f59e0b', fontSize: '11px', marginLeft: '4px' }}>
                            ({formatBytes(bucket.cleanableSizeBytes)} eliminable)
                          </span>
                        )}
                      </span>
                    </div>
                    {bucket.folders?.length > 0 && (
                      <div className="tools-storage-folder-list">
                        {bucket.folders.map(f => (
                          <div key={f.name} className="tools-storage-folder-item">
                            <span className="tools-storage-folder-name">{f.name}</span>
                            <span className="tools-storage-folder-meta">
                              {formatBytes(f.totalSizeBytes)} {'·'} {f.objects} ver{f.objects !== 1 ? 'siones' : 'sión'}
                              {f.cleanableObjects > 0 && (
                                <span style={{ color: '#f59e0b', marginLeft: '6px' }}>
                                  ({f.cleanableObjects} antigua{f.cleanableObjects !== 1 ? 's' : ''})
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {storageData.cloudStorage.cleanableSizeBytes > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      className="tools-btn tools-btn-warning"
                      onClick={() => requestCleanup('cleanup_cs')}
                      disabled={cleanupLoading}
                      style={{ fontSize: '12px' }}
                    >
                      {cleanupLoading ? '\u27F3 ...' : <><CleanIcon size={14} /> Limpiar ZIPs</>}
                      <span style={{ fontSize: '10px', opacity: 0.7, marginLeft: '4px' }}><LockIcon size={10} /> PIN</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ─── Artifact Registry (Docker) ─── */}

            {storageData.artifactRegistry && !storageData.artifactRegistry.error && (
              <div className="tools-storage-subsection">
                <h4 className="tools-storage-subsection-title">
                  <ContainerIcon size={14} /> Artifact Registry
                  <span className="tools-storage-subsection-meta">

                    ── {storageData.artifactRegistry.totalImages || 0} imágenes, {storageData.artifactRegistry.totalVersions || 0} versiones

                  </span>
                </h4>
                {storageData.artifactRegistry.repositories?.map(repo => (
                  <div key={repo.fullName} className="tools-storage-bucket">
                    <div className="tools-storage-bucket-header">
                      <div>
                        <span className="tools-storage-bucket-type"><ContainerIcon size={12} /> {repo.name}</span>
                        <span className="tools-storage-bucket-name">{repo.region} · {repo.format}</span>
                      </div>
                      <span className="tools-storage-bucket-size">
                        {formatBytes(repo.totalSizeBytes)}
                        {repo.cleanableSizeBytes > 0 && (
                          <span style={{ color: '#f59e0b', fontSize: '11px', marginLeft: '4px' }}>
                            ({formatBytes(repo.cleanableSizeBytes)} eliminable)
                          </span>
                        )}
                      </span>
                    </div>
                    {repo.images?.length > 0 && (
                      <div className="tools-storage-folder-list">
                        {repo.images.map(img => (
                          <div key={img.name} className="tools-storage-folder-item">
                            <span className="tools-storage-folder-name">{img.name}</span>
                            <span className="tools-storage-folder-meta">
                              {formatBytes(img.totalSizeBytes)} {'·'} {img.versions} versión{img.versions !== 1 ? 'es' : ''}
                              {img.cleanableVersions > 0 && (
                                <span style={{ color: '#f59e0b', marginLeft: '6px' }}>
                                  ({img.cleanableVersions} antigua{img.cleanableVersions !== 1 ? 's' : ''})
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {storageData.artifactRegistry.cleanableSizeBytes > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      className="tools-btn tools-btn-warning"
                      onClick={() => requestCleanup('cleanup_ar')}
                      disabled={cleanupLoading}
                      style={{ fontSize: '12px' }}
                    >
                      {cleanupLoading ? '\u27F3 ...' : <><CleanIcon size={14} /> Limpiar Docker</>}
                      <span style={{ fontSize: '10px', opacity: 0.7, marginLeft: '4px' }}><LockIcon size={10} /> PIN</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ─── Acción de limpieza combinada ─── */}

            {((storageData?.cloudStorage?.cleanableSizeBytes || 0) + (storageData?.artifactRegistry?.cleanableSizeBytes || 0)) > 0 && (
              <div className="tools-storage-cleanup" style={{ marginTop: '16px' }}>
                <div className="tools-storage-cleanup-info">
                  <WarningIcon size={16} />
                  <span>
                    Se pueden liberar <strong>{formatBytes((storageData?.cloudStorage?.cleanableSizeBytes || 0) + (storageData?.artifactRegistry?.cleanableSizeBytes || 0))}</strong> eliminando versiones anteriores de ambos almacenes.
                  </span>
                </div>
                <button
                  className="tools-btn tools-btn-warning"
                  onClick={() => requestCleanup('cleanup_all')}
                  disabled={cleanupLoading}
                >
                  {cleanupLoading ? '\u27F3 Limpiando...' : <><CleanIcon size={16} /> Limpiar todo</>}
                  <span style={{ fontSize: '10px', opacity: 0.7, marginLeft: '4px' }}><LockIcon size={10} /> PIN</span>
                </button>
              </div>
            )}
            {((storageData?.cloudStorage?.cleanableSizeBytes || 0) + (storageData?.artifactRegistry?.cleanableSizeBytes || 0)) === 0 && (
              <div className="tools-result tools-result-ok" style={{ marginTop: '12px' }}>
                <CheckCircleIcon size={16} /> No hay artefactos antiguos que limpiar. Todo está optimizado.
              </div>
            )}

            {/* ─── Políticas de Limpieza Automática ─── */}

            {policies && (
              <div className="tools-storage-policies">
                <h4 className="tools-storage-policies-title">
                  <ShieldCheckIcon size={14} /> Políticas de Limpieza Automática
                </h4>
                <p className="tools-storage-policies-desc">
                  Si están activas, la limpieza se ejecuta automáticamente en cada análisis programado (cada 12h).
                </p>
                <div className="tools-storage-policies-grid">
                  {/* Cloud Storage policy */}

                  <div className="tools-storage-policy-card">
                    <div className="tools-storage-policy-header">
                      <span className="tools-storage-policy-label">
                        <FileStorageIcon size={12} /> Cloud Storage
                      </span>
                      <button
                        className="tools-storage-policy-toggle"
                        onClick={() => updatePolicy('cloudStorage', 'autoCleanup', !policies.cloudStorage?.autoCleanup)}
                        title={policies.cloudStorage?.autoCleanup ? 'Desactivar' : 'Activar'}
                      >
                        {policies.cloudStorage?.autoCleanup
                          ? <ToggleOnIcon size={22} color="#10b981" />
                          : <ToggleOffIcon size={22} color="var(--text-muted)" />
                        }
                      </button>
                    </div>
                    <span className="tools-storage-policy-status" style={{ color: policies.cloudStorage?.autoCleanup ? '#10b981' : 'var(--text-muted)' }}>

                      {policies.cloudStorage?.autoCleanup ? 'Activa ── limpia ZIPs automáticamente' : 'Inactiva ── limpieza manual solamente'}

                    </span>
                  </div>
                  {/* Artifact Registry policy */}

                  <div className="tools-storage-policy-card">
                    <div className="tools-storage-policy-header">
                      <span className="tools-storage-policy-label">
                        <ContainerIcon size={12} /> Artifact Registry
                      </span>
                      <button
                        className="tools-storage-policy-toggle"
                        onClick={() => updatePolicy('artifactRegistry', 'autoCleanup', !policies.artifactRegistry?.autoCleanup)}
                        title={policies.artifactRegistry?.autoCleanup ? 'Desactivar' : 'Activar'}
                      >
                        {policies.artifactRegistry?.autoCleanup
                          ? <ToggleOnIcon size={22} color="#10b981" />
                          : <ToggleOffIcon size={22} color="var(--text-muted)" />
                        }
                      </button>
                    </div>
                    <span className="tools-storage-policy-status" style={{ color: policies.artifactRegistry?.autoCleanup ? '#10b981' : 'var(--text-muted)' }}>

                      {policies.artifactRegistry?.autoCleanup ? 'Activa ── limpia Docker automáticamente' : 'Inactiva ── limpieza manual solamente'}

                    </span>
                  </div>
                </div>
                {policiesDirty && (
                  <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: '11px', color: '#f59e0b' }}>Cambios sin guardar</span>
                    <button
                      className="tools-btn tools-btn-primary"
                      onClick={() => { setPinModal({ purpose: 'save_policies' }); setPinInput(''); setPinError(''); }}
                      disabled={policySaving}
                      style={{ fontSize: '12px' }}
                    >
                      {policySaving ? '\u27F3 Guardando...' : <><ShieldCheckIcon size={14} /> Guardar políticas</>}
                      <span style={{ fontSize: '10px', opacity: 0.7, marginLeft: '4px' }}><LockIcon size={10} /> PIN</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Resultado de limpieza */}

            {cleanupResult && (
              <div className={`tools-result ${cleanupResult.error ? 'tools-result-error' : 'tools-result-ok'}`} style={{ marginTop: '8px' }}>
                {cleanupResult.error ? (
                  <><XCircleIcon size={16} /> Error: {cleanupResult.error}</>
                ) : (
                  <><CheckCircleIcon size={16} /> Limpieza completada: {cleanupResult.totalDeleted} objetos eliminados, {cleanupResult.totalFreedMB} MB liberados</>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Database Stats ─────────────────────────────────────────────── */}

      <div className="tools-section">
        <div className="tools-section-header">
          <div>
            <h3 className="tools-section-title">
              <span className="tools-section-icon"><TrendUpIcon size={16} /></span>
              Estadísticas de Base de Datos
            </h3>
            <p className="tools-section-desc">Conteo de documentos, campos y tamaño estimado por colección</p>
          </div>
          <button
            className="tools-btn tools-btn-primary"
            onClick={loadStats}
            disabled={statsLoading}
          >
            {statsLoading ? '\u27F3 Cargando...' : <><BarChartIcon size={16} /> Cargar estadísticas</>}
          </button>
        </div>
        {stats && (
          <div className="tools-stats-grid">
            {stats.map(s => (
              <div key={s.key} className="tools-stat-card">
                <div className="tools-stat-header">
                  <span>{s.icon}</span>
                  <span className="tools-stat-name">{s.label}</span>
                </div>
                <div className="tools-stat-body">
                  <div className="tools-stat-kv">
                    <span>Documentos</span>
                    <span className="tools-stat-num">{s.docCount}</span>
                  </div>
                  {s.fields !== null && s.fields !== undefined && (
                    <div className="tools-stat-kv">
                      <span>Campos</span>
                      <span className="tools-stat-num">{s.fields}</span>
                    </div>
                  )}
                  {s.subDocs !== undefined && (
                    <div className="tools-stat-kv">
                      <span>Sub-documentos</span>
                      <span className="tools-stat-num">{s.subDocs}</span>
                    </div>
                  )}
                  {s.size && (
                    <div className="tools-stat-kv">
                      <span>Tamaño est.</span>
                      <span className="tools-stat-num">{(s.size / 1024).toFixed(1)} KB</span>
                    </div>
                  )}
                  {s.error && (
                    <div className="tools-stat-kv" style={{ color: '#ef4444' }}>
                      <span>Error</span>
                      <span>{s.error}</span>
                    </div>
                  )}
                </div>
                <div className="tools-stat-path">{s.key}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Maintenance ────────────────────────────────────────────────── */}

      <div className="tools-section">
        <div className="tools-section-header">
          <div>
            <h3 className="tools-section-title">
              <span className="tools-section-icon"><CleanIcon size={16} /></span>
              Mantenimiento
            </h3>
            <p className="tools-section-desc">Limpieza de datos antiguos y tareas de mantenimiento</p>
          </div>
        </div>
        <div className="tools-maint-grid">
          <div className="tools-maint-card">
            <div className="tools-maint-info">
              <div className="tools-maint-icon"><MailboxIcon size={16} /></div>
              <div>
                <div className="tools-maint-title">Purgar notificaciones antiguas</div>
                <div className="tools-maint-desc">Elimina notificaciones con más de 7 días. Esta limpieza se hace automáticamente durante cada análisis.</div>
              </div>
            </div>
            <button
              className="tools-btn tools-btn-warning"
              onClick={() => setPurgeConfirm('notifications')}
              disabled={purgeProgress?.label === 'Procesando...'}
            >
              <TrashIcon size={16} /> Purgar
            </button>
          </div>
          <div className="tools-maint-card">
            <div className="tools-maint-info">
              <div className="tools-maint-icon"><BellIcon size={16} /></div>
              <div>
                <div className="tools-maint-title">Limpiar alertas resueltas</div>
                <div className="tools-maint-desc">Elimina alertas completadas o descartadas con más de 30 días desde su resolución.</div>
              </div>
            </div>
            <button
              className="tools-btn tools-btn-warning"
              onClick={() => setPurgeConfirm('completed-alerts')}
              disabled={purgeProgress?.label === 'Procesando...'}
            >
              <TrashIcon size={16} /> Limpiar
            </button>
          </div>
          <div className="tools-maint-card">
            <div className="tools-maint-info">
              <div className="tools-maint-icon"><EmailIcon size={16} /></div>
              <div>
                <div className="tools-maint-title">Eliminar raw-emails</div>
                <div className="tools-maint-desc">Elimina el documento analysis/raw-emails que ya no se utiliza en el pipeline actual.</div>
              </div>
            </div>
            <button
              className="tools-btn tools-btn-danger"
              onClick={() => setPurgeConfirm('raw-emails')}
              disabled={purgeProgress?.label === 'Procesando...'}
            >
               Eliminar
            </button>
          </div>
        </div>
        {purgeProgress && purgeProgress.label !== 'Procesando...' && (
          <div className={`tools-result ${purgeProgress.label === 'Error' ? 'tools-result-error' : 'tools-result-ok'}`}>
            {purgeProgress.label === 'Error' ? <XCircleIcon size={16} /> : <CheckCircleIcon size={16} />} {purgeProgress.detail}
          </div>
        )}
        {purgeProgress?.label === 'Procesando...' && (
          <div className="tools-result tools-result-info"><HourglassIcon size={16} /> {purgeProgress.label}</div>
        )}
      </div>

      {/* ─── Quick info ──────────────────────────────────────────────────── */}

      <div className="tools-info-bar">
        <span><LightbulbIcon size={16} /></span>
        <div>
          <strong>Nota:</strong> Los datos exportados son una copia de lectura. Los archivos JSON pueden re-importarse
          a Firestore manualmente. Los archivos CSV son ideales para revisión en hojas de cálculo.
          Las operaciones de mantenimiento respetan las políticas de retención del sistema.
        </div>
      </div>

      {serviceModal && serviceForm && (
        <ModalShell
          open
          onCancel={() => setServiceModal(null)}
          title={serviceModal.mode === 'create' ? 'Nuevo servicio' : `Editar ${serviceForm.name}`}
          icon={<KeyIcon size={16} />}
          size="xl"
          className="tools-svc-modal"
        >
            <div className="tools-svc-modal-body">
              <div className="tools-svc-field-row">
                <div className="tools-svc-field">
                  <label>Nombre</label>
                  <input className="edit-modal-input" value={serviceForm.name} onChange={e => updateServiceForm('name', e.target.value)} placeholder="Disney Plus, VPN, Netflix..." />
                </div>
                <div className="tools-svc-field">
                  <label>Clave</label>
                  <input
                    className="edit-modal-input"
                    value={serviceForm.serviceKey}
                    onChange={e => updateServiceForm('serviceKey', normalizeServiceKey(e.target.value))}
                    disabled={serviceModal.mode === 'edit'}
                    placeholder="disney_plus"
                  />
                  <span className="tools-svc-hint">Identificador Firestore. En edición no se cambia para no mover datos.</span>
                </div>
              </div>
              <div className="tools-svc-field-row">
                <div className="tools-svc-field">
                  <label>Tipo de acceso</label>
                  <select className="edit-modal-input" value={serviceForm.accessType} onChange={e => updateServiceForm('accessType', e.target.value)}>
                    {Object.entries(ACCESS_TYPES).map(([key, meta]) => (
                      <option key={key} value={key}>{meta.label}</option>
                    ))}
                  </select>
                </div>
                <div className="tools-svc-field">
                  <label>Color</label>
                  <input className="edit-modal-input" type="color" value={serviceForm.color} onChange={e => updateServiceForm('color', e.target.value)} />
                </div>
                <div className="tools-svc-field">
                  <label>Orden</label>
                  <input className="edit-modal-input" type="number" min="1" value={serviceForm.displayOrder} onChange={e => updateServiceForm('displayOrder', e.target.value)} />
                </div>
              </div>
              <div className="tools-svc-field-row">
                <label className="tools-svc-toggle">
                  <input type="checkbox" checked={serviceForm.active} onChange={e => updateServiceForm('active', e.target.checked)} />
                  Servicio activo
                </label>
                <label className="tools-svc-toggle">
                  <input type="checkbox" checked={serviceForm.usesPool} onChange={e => updateServiceForm('usesPool', e.target.checked)} />
                  Usa cuentas reales / pool
                </label>
              </div>
              <div className="tools-svc-field-row">
                <div className="tools-svc-field">
                  <label>Cupos por cuenta real</label>
                  <input className="edit-modal-input" type="number" min="1" max="20" value={serviceForm.maxSlotsPerRealAccount} onChange={e => updateServiceForm('maxSlotsPerRealAccount', e.target.value)} disabled={!serviceForm.usesPool} />
                </div>
                <div className="tools-svc-field">
                  <label>Cupos por grupo Lank</label>
                  <input className="edit-modal-input" type="number" min="1" max="20" value={serviceForm.maxSlotsPerLankGroup} onChange={e => updateServiceForm('maxSlotsPerLankGroup', e.target.value)} />
                </div>
                <div className="tools-svc-field">
                  <label>Logo</label>
                  <div className="tools-svc-logo-row">
                    <input className="edit-modal-input" value={serviceForm.logo} onChange={e => updateServiceForm('logo', e.target.value)} placeholder="https://... o /assets/..." />
                    <input
                      ref={serviceLogoInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp"
                      style={{ display: 'none' }}
                      onChange={e => {
                        if (e.target.files?.[0]) handleUploadServiceLogo(e.target.files[0]);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="tools-btn tools-btn-secondary"
                      onClick={() => serviceLogoInputRef.current?.click()}
                      disabled={serviceLogoUploading}
                    >
                      {serviceLogoUploading ? <><span className="spinner" /> Subiendo...</> : <><UploadIcon size={14} /> Subir</>}
                    </button>
                  </div>
                  {serviceForm.logo && (
                    <div className="tools-svc-logo-preview">
                      <img src={serviceForm.logo} alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />
                      <span><ImageIcon size={12} /> Logo actual</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="tools-svc-field">
                <label>Aliases</label>
                <input className="edit-modal-input" value={serviceForm.nameAliases} onChange={e => updateServiceForm('nameAliases', e.target.value)} placeholder="Disney+, Disney Plus Premium" />
                <span className="tools-svc-hint">Separados por coma. El parser de correos y AdminBot usan estos nombres para resolver el servicio.</span>
              </div>
              {servicePreview && (
                <div className="tools-svc-preview">
                  <span className="tools-svc-preview-label">Vista previa operativa</span>
                  <div className="tools-svc-preview-card" style={{ borderLeftColor: servicePreview.color }}>
                    <span className="tools-svc-badge tools-svc-badge-type">{ACCESS_TYPES[servicePreview.accessType]?.label}</span>
                    <span>{servicePreview.usesPool ? 'Con pool de cuentas reales' : 'Solo grupos Lank'}</span>
                    <span>{servicePreview.maxSlotsPerRealAccount} / {servicePreview.maxSlotsPerLankGroup} cupos</span>
                  </div>
                </div>
              )}
              {serviceError && <div className="tools-result tools-result-error"><XCircleIcon size={16} /> {serviceError}</div>}
            </div>
            <ModalActions
              onCancel={() => setServiceModal(null)}
              primaryLabel={<><SaveIcon size={16} /> Guardar servicio</>}
              onPrimary={handleSaveService}
              loading={serviceSaving}
            />
        </ModalShell>
      )}

      {/* ─── Purge Confirm Modal ────────────────────────────────────────── */}

      {purgeConfirm && (
        <ModalShell open onCancel={() => setPurgeConfirm(null)} size="sm" title="Confirmar operación" icon={<WarningIcon size={16} />}>
          <div className="tools-confirm-copy">
            <p>
              {purgeConfirm === 'notifications' && '¿Eliminar notificaciones con más de 7 días? Esta acción no se puede deshacer.'}
              {purgeConfirm === 'completed-alerts' && '¿Eliminar alertas completadas/descartadas con más de 30 días? Esta acción no se puede deshacer.'}
              {purgeConfirm === 'raw-emails' && '¿Eliminar el documento analysis/raw-emails?'}
            </p>
          </div>
          <ModalActions
            onCancel={() => setPurgeConfirm(null)}
            primaryLabel="Sí, eliminar"
            onPrimary={() => handlePurge(purgeConfirm)}
            danger
          />
        </ModalShell>
      )}

      {/* ─── PIN Modal (misma estructura visual que la Bóveda) ─────── */}

      {pinModal && (
        <div className="vault-pin-gate" style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
        }}>
          <div className="vault-pin-card">
            <div className="vault-pin-icon">
              <LockIcon size={48} />
            </div>
            <h2 className="vault-pin-title">PIN de Seguridad</h2>
            <p className="vault-pin-subtitle">
              {pinModal.purpose?.startsWith('cleanup_')
                ? 'Vas a eliminar artefactos de deploy. Ingresa tu PIN de Bóveda.'
                : pinModal.purpose === 'save_policies'
                ? 'Vas a modificar políticas de limpieza. Ingresa tu PIN de Bóveda.'
                : 'La exportación incluye datos sensibles. Ingresa tu PIN de Bóveda.'
              }
            </p>
            <div className="vault-pin-dots">
              {[0, 1, 2, 3].map(i => (
                <div
                  key={i}
                  className={`vault-pin-dot ${pinInput.length > i ? 'filled' : ''} ${pinError ? 'error' : ''}`}
                />
              ))}
            </div>
            {pinError && <p className="vault-pin-error">{pinError}</p>}
            <div className="vault-pin-keypad">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, 'del'].map((key, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`vault-pin-key ${key === null ? 'empty' : ''} ${key === 'del' ? 'del' : ''}`}
                  disabled={key === null}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (key === 'del') {
                      setPinInput(prev => prev.slice(0, -1));
                      setPinError('');
                    } else if (key !== null && pinInput.length < 4) {
                      const newPin = pinInput + String(key);
                      setPinInput(newPin);
                      setPinError('');
                      if (newPin.length === 4) {
                        setTimeout(() => verifyPin(newPin), 200);
                      }
                    }
                  }}
                >
                  {key === 'del' ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
                    </svg>
                  ) : key}
                </button>
              ))}
            </div>
            <button className="vault-pin-cancel-btn" onClick={() => setPinModal(null)}>
              Cancelar
            </button>
            <div className="vault-pin-footer">
              <LockKeyIcon size={14} />
              <span>Protegido con PIN de 4 dígitos</span>
            </div>
          </div>
        </div>
      )}
 </>
 );

}
