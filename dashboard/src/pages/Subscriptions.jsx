import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { collection, doc, getDoc, getDocs, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useCollection, useDocument } from '../hooks/useFirestore';
import { SERVICES, getServiceMeta, getProfileImage, getPoolServiceKeys, getNonPoolServiceKeys, getAllServiceKeys, getSlotFields, getExpectedSlotFields, getUserFields } from '../config/services';
import {
  updateSlot, updateGroupUser, removeGroupUser, moveUserBetweenAccounts,
  updateServiceMasterConfig, updateServiceConfig, propagateSlotsToRealAccounts, DEFAULT_MASTER_CONFIG,
  initSubscriptionMasterConfig, toggleSlotEnabled, updateGroupEnabledSlots, createManualAlert,
} from '../hooks/firestoreActions';
import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import { BlockIcon, CalendarIcon, CashIcon, CheckCircleIcon, ClockIcon, CloseIcon, CreditCardIcon, DotGray, DotGreen, EditIcon, EmailIcon, FolderIcon, KeyIcon, LinkIcon, LockKeyIcon, NotesIcon, PlusIcon, PointUpIcon, RefreshIcon, SaveIcon, SearchIcon, SettingsIcon, SlidersIcon, ToggleOnIcon, ToggleOffIcon, TrashIcon, UserIcon, WarningIcon } from '../components/Icons';
import { normalizeSearch, nMatch } from '../utils/normalize';
import SearchBar from '../components/SearchBar';
import EntityHistory from '../components/EntityHistory';

// Campos esperados y editables se derivan dinámicamente desde config/services
function getExpectedFieldsForService(svcId) {
 return getExpectedSlotFields(svcId);
}

function getEditableFieldsForService(svcId) {
 return getSlotFields(svcId);
}

const MASTER_CONFIG_FIELDS = [
 { key: 'maxSlotsPerRealAccount', label: 'Máx. cupos por cuenta real', type: 'number', required: true, placeholder: '1-10', hint: 'No puede exceder 10.' },
 { key: 'maxSlotsPerLankGroup', label: 'Máx. cupos por grupo Lank', type: 'number', required: true, placeholder: '1-10', hint: 'No puede exceder 10.' },
 {
  key: 'accessType',
  label: 'Tipo de acceso',
  type: 'select',
  required: true,
  options: [
    { value: 'credentials', label: 'Credenciales compartidas' },
    { value: 'email_invitation', label: 'Invitación por correo' },
    { value: 'profile_project', label: 'Perfil / proyecto' },
  ],
 },
];

const ACCESS_TYPE_LABELS = {
 credentials: 'Credenciales compartidas',
 email_invitation: 'Invitación por correo',
 profile_project: 'Perfil / proyecto',
};

function getDisplayAccessTypeLabel(serviceKey, config) {
 const accessType = config?.accessType;
 // Si el servicio tiene un label personalizado, usarlo
 if (config?.accessTypeLabel) return config.accessTypeLabel;
 // Fallback al servicio meta si tiene accessTypeLabel definido
 const meta = getServiceMeta(serviceKey);
 if (meta?.accessTypeLabel) return meta.accessTypeLabel;
 return ACCESS_TYPE_LABELS[accessType] || 'Sin definir';
}

function getMissingFields(svcId, slot) {
 if (!slot || slot.status !== 'active') return [];
 const expected = getExpectedFieldsForService(svcId);
 const missing = [];
 expected.forEach(field => {
 const val = slot[field];
 if (!val || val === 'N/D' || val === '' || (Array.isArray(val) && val.length === 0)) {
      const labels = {
        memberAlias: 'Alias',
        memberEmail: 'Correo invitación',
        profileName: 'Perfil',
        projectName: 'Proyecto',
      };
      missing.push(labels[field] || field);
 }
 });
 return missing;
}

export default function Subscriptions({ onNavigate, navData, servicesConfig }) {
 const { data: pools } = useCollection('service-pools', { realtime: false });
 const { data: masterConfigDoc, loading: masterConfigLoading } = useDocument('config', 'services', { realtime: false });
 const [poolDetails, setPoolDetails] = useState({});
 const [groupDetails, setGroupDetails] = useState({});
 const [selectedService, setSelectedService] = useState(null);
 const [showStickyBar, setShowStickyBar] = useState(false);
 const [highlightRef, setHighlightRef] = useState(null);
 const [highlightUser, setHighlightUser] = useState(null);
 const [pendingUserAliases, setPendingUserAliases] = useState(new Set());
 const [searchQuery, setSearchQuery] = useState('');
 const [searchResults, setSearchResults] = useState(null);

 // Modal states para edición de slots
 const [editSlotModal, setEditSlotModal] = useState(null); // { serviceKey, accountRef, slotIndex, slot, allSlots }
 const [clearSlotConfirm, setClearSlotConfirm] = useState(null); // { serviceKey, accountRef, slotIndex, slot, allSlots }
 const [moveSlotModal, setMoveSlotModal] = useState(null); // { serviceKey, sourceAcct, slotIndex, slot }
 const [groupEditModal, setGroupEditModal] = useState(null); // { serviceKey, groupId, userIndex, user, allUsers, accountLabel, accountId }
 const [groupBajaConfirm, setGroupBajaConfirm] = useState(null); // { serviceKey, groupId, userIndex, userAlias, allUsers, accountLabel, accountId }
 const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });

 // Configuración maestra
 const [showMasterConfig, setShowMasterConfig] = useState(false);
 const [editMasterModal, setEditMasterModal] = useState(null); // { serviceKey, config }
 const [propagateConfirm, setPropagateConfirm] = useState(null); // { serviceKey, oldMax, newMax }

 // Gestión de suscripciones (crear/editar servicio)
 const [svcModal, setSvcModal] = useState(null); // null | { mode: 'create' } | { mode: 'edit', key: string }
 const [svcForm, setSvcForm] = useState({});
 const [svcSaving, setSvcSaving] = useState(false);
 const [svcError, setSvcError] = useState('');
 const [svcAliasInput, setSvcAliasInput] = useState('');
 const [svcSlotFields, setSvcSlotFields] = useState([]);
 const [svcUserFields, setSvcUserFields] = useState([]);

 // Configuración maestra resuelta (Firestore > defaults)
 const masterConfig = useMemo(() => {
   if (masterConfigDoc) {
     const data = masterConfigDoc.services || masterConfigDoc;
     const { id, updatedAt, ...services } = data;
     return { ...DEFAULT_MASTER_CONFIG, ...services };
   }
   return DEFAULT_MASTER_CONFIG;
 }, [masterConfigDoc]);

 // Inicializar config maestra si no existe
 useEffect(() => {
   if (masterConfigLoading) return;
   if (!masterConfigDoc) {
     initSubscriptionMasterConfig().catch(err => {
       console.error('Error inicializando config maestra:', err);
     });
   }
 }, [masterConfigDoc, masterConfigLoading]);

 // Helper para obtener maxSlots de un servicio desde config maestra
 const getMaxSlots = useCallback((svcId, type = 'realAccount') => {
   const cfg = masterConfig[svcId];
   if (!cfg) return getServiceMeta(svcId).maxSlots || 5;
   return type === 'realAccount'
     ? (cfg.maxSlotsPerRealAccount || cfg.maxSlots || 5)
     : (cfg.maxSlotsPerLankGroup || cfg.maxSlots || 5);
 }, [masterConfig]);

 // Estados para vincular cupo a cuenta Lank al llenar
 const [fillLankAccountId, setFillLankAccountId] = useState('');
 const [fillLankUserAlias, setFillLankUserAlias] = useState('');

 const showToast = useCallback((msg, type = 'success') => {
 setToast({ visible: true, message: msg, type });
 }, []);

 const overviewRef = useRef(null);
 const detailRef = useRef(null);

 // Recibir navData
 useEffect(() => {
 if (!navData) return;
 if (typeof navData === 'string') {
      setSelectedService(navData);
      setHighlightUser(null);
 } else if (navData.service) {
      setSelectedService(navData.service);
      if (navData.accountRef) setHighlightRef(navData.accountRef);
      setHighlightUser(navData.highlightUser || null);
 }
 }, [navData]);

 // Derivar aliases con acción pendiente desde alertas pendientes
 useEffect(() => {
 async function loadPendingUsers() {
      try {
        const { query, where, getDocs: fetchDocs } = await import('firebase/firestore');
        const q = query(collection(db, 'alerts'), where('status', '==', 'pending'));
        const snap = await fetchDocs(q);
        const aliases = new Set();
        snap.docs.forEach(d => {
          const alias = (d.data().userAlias || '').toLowerCase();
          if (alias) aliases.add(alias);
        });
        setPendingUserAliases(aliases);
      } catch (err) { console.error('Error cargando alertas pendientes:', err); }
 }
 loadPendingUsers();
 }, []);

 // Alertas password_change pendientes — query filtrada en lugar de descargar todas
 const { data: pendingPasswordAlerts } = useCollection('alerts', {
   constraints: [where('type', '==', 'password_change'), where('status', '==', 'pending')],
 });

 // Helper: ¿tiene esta cuenta real una alerta de password_change pendiente?
 const getPasswordAlert = useCallback((serviceAccountRef) => {
   return pendingPasswordAlerts.find(a => a.serviceAccountRef === serviceAccountRef);
 }, [pendingPasswordAlerts]);

 // Scroll a cuenta real
 useEffect(() => {
 if (!highlightRef || !selectedService) return;
 const timeout = setTimeout(() => {
      const el = document.getElementById(`real-account-${highlightRef}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 3000);
      }
      if (highlightUser) {
        setTimeout(() => {
          const userEl = document.querySelector(`[data-user-alias="${highlightUser.toLowerCase()}"]`);
          if (userEl) {
            userEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            userEl.classList.add('highlight-user-pulse');
            setTimeout(() => userEl.classList.remove('highlight-user-pulse'), 4000);
          }
        }, 600);
      }
 }, 300);
 return () => clearTimeout(timeout);
 }, [highlightRef, selectedService, poolDetails, highlightUser]);

 // IntersectionObserver
 useEffect(() => {
 if (!overviewRef.current) return;
 const observer = new IntersectionObserver(
      ([entry]) => setShowStickyBar(!entry.isIntersecting),
      { threshold: 0, rootMargin: '-60px 0px 0px 0px' }
 );
 observer.observe(overviewRef.current);
 return () => observer.disconnect();
 }, [selectedService]);

 // ─── Data loading functions ───
 const loadPoolDetailsFn = useCallback(async () => {
   if (pools.length === 0) return;
   const results = {};
   await Promise.all(pools.map(async pool => {
     const snap = await getDocs(collection(db, `service-pools/${pool.id}/real-accounts`));
     results[pool.id] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
   }));
   setPoolDetails(results);
 }, [pools]);

 const loadGroupDetailsFn = useCallback(async () => {
   const svcs = getAllServiceKeys();
   const results = {};
   await Promise.all(svcs.map(async svc => {
     const snap = await getDocs(collection(db, `groups/${svc}/lank-accounts`));
     results[svc] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
   }));
   setGroupDetails(results);
 }, []);

 const refreshSubscriptionsData = useCallback(async () => {
   await Promise.all([loadPoolDetailsFn(), loadGroupDetailsFn()]);
 }, [loadPoolDetailsFn, loadGroupDetailsFn]);

 // Cargar cuentas reales
 useEffect(() => {
 loadPoolDetailsFn().catch(() => {});
 }, [loadPoolDetailsFn]);

 // Cargar grupos Lank
 useEffect(() => {
 loadGroupDetailsFn().catch(() => {});
 }, [loadGroupDetailsFn]);

 // Estadísticas por servicio
 const getStats = (svcId) => {
 const accounts = poolDetails[svcId] || [];
 const groups = groupDetails[svcId] || [];
 let totalSlots = 0, usedSlots = 0, freeSlots = 0;
 accounts.forEach(a => {
      const slots = a.slots || [];
      totalSlots += slots.length;
      usedSlots += slots.filter(s => s.status === 'active').length;
      freeSlots += slots.filter(s => s.status === 'free').length;
 });
 const totalUsers = groups.reduce((s, g) => s + (g.users?.length || 0), 0);

 if (!getServiceMeta(svcId).usesPool) {
      // Un grupo activo puede tener 0, algunos o todos los cupos llenos
      const activeGroups = groups.filter(g => g.groupStatus === 'active');
      const maxPerGroup = getMaxSlots(svcId, 'lankGroup');
      return {
        realAccountCount: 0, groupCount: activeGroups.length,
        usedSlots: totalUsers,
        totalSlots: groups.length * maxPerGroup,
        totalUsers,
        freeSlots: (groups.length * maxPerGroup) - totalUsers,
        hasDiscrepancy: false, isNonPoolService: true,
      };
 }
 return {
      realAccountCount: accounts.length, groupCount: groups.length,
      usedSlots, totalSlots, totalUsers, freeSlots,
      hasDiscrepancy: totalUsers !== usedSlots, isNonPoolService: false,
 };
 };

 const allServiceIds = useMemo(() => {
 const fromPools = pools.map(p => p.id);
 const nonPoolKeys = getNonPoolServiceKeys();
 const all = [...new Set([...fromPools, ...nonPoolKeys])];
 // Ordenar: servicios con pool primero, sin pool al final, ambos por displayOrder
 return all.sort((a, b) => {
      const aMeta = getServiceMeta(a);
      const bMeta = getServiceMeta(b);
      const aIsPool = aMeta.usesPool !== false;
      const bIsPool = bMeta.usesPool !== false;
      if (aIsPool && !bIsPool) return -1;
      if (!aIsPool && bIsPool) return 1;
      return (aMeta.displayOrder || 99) - (bMeta.displayOrder || 99);
 });
 }, [pools]);

 // ─── Cuentas Lank disponibles para vincular al llenar cupo ───
 const fillLankAccounts = useMemo(() => {
 if (!editSlotModal || editSlotModal.slot.status !== 'free') return [];
 const svc = editSlotModal.serviceKey;
 return (groupDetails[svc] || [])
      .filter(g => g.groupStatus === 'active' && (g.users || []).length > 0)
      .sort((a, b) => (a.accountId || 0) - (b.accountId || 0));
 }, [editSlotModal, groupDetails]);

 // Usuarios de la cuenta Lank seleccionada
 const fillLankUsers = useMemo(() => {
 if (!fillLankAccountId || !fillLankAccounts.length) return [];
 const acct = fillLankAccounts.find(a => String(a.accountId) === String(fillLankAccountId) || a.id === fillLankAccountId);
 if (!acct) return [];
 return (acct.users || []).map(u => typeof u === 'string' ? { userAlias: u } : u);
 }, [fillLankAccountId, fillLankAccounts]);

 // Valores iniciales del modal (auto-llenados si hay Lank user seleccionado)
 const editSlotInitialValues = useMemo(() => {
 if (!editSlotModal) return {};
 const svc = editSlotModal.serviceKey;
 const fieldDefs = getEditableFieldsForService(svc);
 const vals = {};
 fieldDefs.forEach(f => {
      vals[f.key] = editSlotModal.slot[f.key] || '';
 });

 // Auto-llenar desde usuario Lank seleccionado
 if (editSlotModal.slot.status === 'free' && fillLankUserAlias) {
      const selectedUser = fillLankUsers.find(u =>
        (u.userAlias || '').toLowerCase() === fillLankUserAlias.toLowerCase()
      );
      if (selectedUser) {
        vals.memberAlias = selectedUser.userAlias || '';
        if (selectedUser.userEmail || selectedUser.email) {
          vals.memberEmail = selectedUser.userEmail || selectedUser.email || '';
        }
        if (selectedUser.profileName) {
          vals.profileName = selectedUser.profileName;
        }
      }
 }

 return vals;
 }, [editSlotModal, fillLankUserAlias, fillLankUsers]);

 // Detectar si el usuario Lank seleccionado ya ocupa un cupo en alguna cuenta real
 const existingSlotInfo = useMemo(() => {
 if (!fillLankUserAlias || !editSlotModal) return null;
 const svc = editSlotModal.serviceKey;
 const accounts = poolDetails[svc] || [];
 const normalizedAlias = fillLankUserAlias.toLowerCase();

 for (const acct of accounts) {
      const slots = acct.slots || [];
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.memberAlias && s.memberAlias.toLowerCase() === normalizedAlias
            && s.status === 'active') {
          // No reportar si es el mismo slot que estamos llenando
          if (acct.id === editSlotModal.accountRef && i === editSlotModal.slotIndex) continue;
          return {
            accountRef: acct.id,
            accountLabel: acct.label || acct.serviceAccountRef || acct.id,
            accountEmail: acct.email || '',
            slotIndex: i,
            slot: s,
            allSlots: slots,
            isSameAccount: acct.id === editSlotModal.accountRef,
          };
        }
      }
 }
 return null;
 }, [fillLankUserAlias, editSlotModal, poolDetails]);

 // ─── SEARCH LOGIC ───
 useEffect(() => {
 if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults(null);
      return;
 }
 const q = normalizeSearch(searchQuery);
 const results = {};
 const matchedSlots = new Set();

 Object.entries(poolDetails).forEach(([svcId, accounts]) => {
      accounts.forEach(acct => {
        let acctMatches = false;
        if (nMatch(acct.email, q)) acctMatches = true;
        if (nMatch(acct.label, q)) acctMatches = true;
        if (nMatch(acct.serviceAccountRef, q)) acctMatches = true;
        if (nMatch(acct.cardLabel, q)) acctMatches = true;

        (acct.slots || []).forEach((slot, idx) => {
          let slotMatches = false;
          if (nMatch(slot.memberAlias, q)) slotMatches = true;
          if (nMatch(slot.memberEmail, q)) slotMatches = true;
          if (nMatch(slot.profileName, q)) slotMatches = true;
          if (nMatch(slot.projectName, q)) slotMatches = true;
          if (slot.assignedFrom) {
            if (nMatch(slot.assignedFrom.canonicalAlias, q)) slotMatches = true;
            if (nMatch(slot.assignedFrom.lankOwnerAlias, q)) slotMatches = true;
            if (String(slot.assignedFrom.accountId || '').includes(q)) slotMatches = true;
          }
          if (slotMatches) {
            acctMatches = true;
            matchedSlots.add(`${svcId}:${acct.id}:${idx}`);
          }
        });

        if (acctMatches) {
          if (!results[svcId]) results[svcId] = new Set();
          results[svcId].add(acct.id);
        }
      });
 });

 // Buscar en grupos de servicios sin pool (como Microsoft 365)
 getNonPoolServiceKeys().forEach(npSvc => {
   (groupDetails[npSvc] || []).forEach(group => {
      let groupMatches = false;
      if (nMatch(group.accountAlias, q)) groupMatches = true;
      if (nMatch(group.fullName, q)) groupMatches = true;
      if (String(group.accountId || '').includes(q)) groupMatches = true;
      (group.users || []).forEach((u, idx) => {
        const alias = typeof u === 'string' ? u : (u?.userAlias || '');
        const email = typeof u === 'object' ? (u?.invitationEmail || u?.email || '') : '';
        if (nMatch(alias, q) || nMatch(email, q)) {
          groupMatches = true;
          matchedSlots.add(`${npSvc}:${group.id}:${idx}`);
        }
      });
      if (groupMatches) {
        if (!results[npSvc]) results[npSvc] = new Set();
        results[npSvc].add(group.id);
      }
   });
 });

 Object.entries(groupDetails).forEach(([svcId, groups]) => {
      if (!getServiceMeta(svcId).usesPool) return;
      groups.forEach(group => {
        (group.users || []).forEach(u => {
          if (typeof u === 'string') {
            if (nMatch(u, q)) {
              if (!results[svcId]) results[svcId] = new Set();
            }
            return;
          }
          const fields = [u.userAlias, u.userEmail, u.email, u.phone, u.memberPhone, u.profileName, u.serviceAccountRef];
          const projName = typeof u.projectName === 'string' ? u.projectName : '';
          fields.push(projName);
          if (fields.some(f => nMatch(f, q))) {
            if (u.serviceAccountRef && poolDetails[svcId]) {
              const realAcct = poolDetails[svcId].find(pa => pa.serviceAccountRef === u.serviceAccountRef || pa.id === u.serviceAccountRef);
              if (realAcct) {
                if (!results[svcId]) results[svcId] = new Set();
                results[svcId].add(realAcct.id);
              }
            }
          }
        });
      });
 });

 const totalMatches = Object.values(results).reduce((s, set) => s + set.size, 0);
 if (totalMatches > 0) {
      setSearchResults({ matches: results, slots: matchedSlots, total: totalMatches });
      if (!selectedService || !results[selectedService]) {
        const firstSvc = Object.keys(results)[0];
        if (firstSvc) setSelectedService(firstSvc);
      }
 } else {
      setSearchResults({ matches: {}, slots: new Set(), total: 0 });
 }
 }, [searchQuery, poolDetails, groupDetails]);

 const clearSearch = () => {
 setSearchQuery('');
 setSearchResults(null);
 };

 const handleStickySelect = (svcId) => {
 setSelectedService(svcId);
 setHighlightRef(null);
 setTimeout(() => {
      if (detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
 }, 50);
 };

 // ─── SLOT EDIT HANDLERS ───

 const handleSlotEdit = (serviceKey, acct, slotIndex) => {
 const slot = acct.slots[slotIndex];
 setFillLankAccountId('');
 setFillLankUserAlias('');
 setEditSlotModal({
      serviceKey,
      accountRef: acct.id,
      slotIndex,
      slot,
      allSlots: acct.slots,
      accountLabel: acct.label || acct.serviceAccountRef || acct.id,
 });
 };

 const handleSlotEditSave = async (values) => {
 if (!editSlotModal) return;
 const { serviceKey, accountRef, slotIndex, allSlots, slot } = editSlotModal;

 // Construir slot actualizado
 const updatedSlot = { ...slot };
 const editableKeys = getEditableFieldsForService(serviceKey).map(f => f.key);
 editableKeys.forEach(key => {
      if (values[key] !== undefined) updatedSlot[key] = values[key];
 });

 // Si se le puso un alias y estaba libre, marcarlo como activo
 if (updatedSlot.memberAlias?.trim() && slot.status === 'free') {
      updatedSlot.status = 'active';
 }

 // Si se vinculó a una cuenta Lank, agregar assignedFrom
 if (fillLankAccountId && fillLankUserAlias) {
      const lankAcct = fillLankAccounts.find(a => a.id === fillLankAccountId);
      updatedSlot.assignedFrom = {
        accountId: lankAcct?.accountId || parseInt(fillLankAccountId),
        canonicalAlias: lankAcct?.accountAlias || lankAcct?.fullName || '',
      };
      updatedSlot.assignedAt = new Date().toISOString();
 }

 await updateSlot(serviceKey, accountRef, slotIndex, updatedSlot, allSlots);

 // Si el usuario ya tenía un cupo en otra cuenta, liberarlo (migración)
 if (existingSlotInfo) {
      try {
        const clearedSlot = {
          slotNumber: existingSlotInfo.slot.slotNumber || existingSlotInfo.slotIndex + 1,
          status: 'free',
          memberAlias: '',
          memberEmail: '',
          profileName: '',
          projectName: '',
          assignedFrom: null,
        };
        await updateSlot(serviceKey, existingSlotInfo.accountRef, existingSlotInfo.slotIndex, clearedSlot, existingSlotInfo.allSlots);
      } catch (err) {
        console.error('Error liberando cupo anterior:', err);
      }
 }

 // Sincronizar datos al grupo Lank
 if (fillLankAccountId && fillLankUserAlias) {
      // Caso: llenando cupo libre desde un usuario Lank
      try {
        const lankAcct = fillLankAccounts.find(a => a.id === fillLankAccountId);
        if (lankAcct) {
          const users = lankAcct.users || [];
          const userIdx = users.findIndex(u => {
            const alias = typeof u === 'string' ? u : (u.userAlias || '');
            return alias.toLowerCase() === fillLankUserAlias.toLowerCase();
          });
          if (userIdx !== -1) {
            const acctLabel = editSlotModal.accountLabel || accountRef;
            const syncData = { serviceAccountRef: accountRef, serviceAccountLabel: acctLabel };
            if (values.projectName) syncData.projectName = values.projectName;
            if (values.profileName) syncData.profileName = values.profileName;
            await updateGroupUser(serviceKey, lankAcct.id, userIdx, syncData, users);
          }
        }
      } catch (err) {
        console.error('Error actualizando serviceAccountRef en grupo Lank:', err);
      }
 } else if (slot.status !== 'free' && slot.assignedFrom?.accountId) {
      // Caso: editando cupo existente que ya está vinculado — sincronizar cambios al grupo
      try {
        const groups = groupDetails[serviceKey] || [];
        const lankAcct = groups.find(g => String(g.accountId) === String(slot.assignedFrom.accountId) || g.id === String(slot.assignedFrom.accountId));
        if (lankAcct) {
          const users = lankAcct.users || [];
          const memberAlias = updatedSlot.memberAlias || slot.memberAlias;
          const userIdx = users.findIndex(u => {
            const alias = typeof u === 'string' ? u : (u.userAlias || '');
            return alias.toLowerCase() === memberAlias.toLowerCase();
          });
          if (userIdx !== -1) {
            const syncData = {};
            if (values.projectName !== undefined) syncData.projectName = values.projectName;
            if (values.profileName !== undefined) syncData.profileName = values.profileName;
            if (values.memberEmail !== undefined) syncData.userEmail = values.memberEmail;
            if (Object.keys(syncData).length > 0) {
              await updateGroupUser(serviceKey, lankAcct.id, userIdx, syncData, users);
            }
          }
        }
      } catch (err) {
        console.error('Error sincronizando datos al grupo Lank:', err);
      }
 }

 showToast(`Cupo #${slotIndex + 1} actualizado en ${editSlotModal.accountLabel}`);
 };

 const handleSlotClear = (serviceKey, acct, slotIndex) => {
 const slot = acct.slots[slotIndex];
 setClearSlotConfirm({
      serviceKey,
      accountRef: acct.id,
      slotIndex,
      slot,
      allSlots: acct.slots,
      memberAlias: slot.memberAlias || 'usuario',
      accountLabel: acct.label || acct.serviceAccountRef || acct.id,
 });
 };

 const handleSlotClearConfirm = async () => {
 if (!clearSlotConfirm) return;
 const { serviceKey, accountRef, slotIndex, allSlots, slot } = clearSlotConfirm;
 const oldSlot = allSlots[slotIndex];

 const clearedSlot = {
      slotNumber: oldSlot.slotNumber || slotIndex + 1,
      status: 'free',
      memberAlias: '',
      memberEmail: '',
      profileName: '',
      projectName: '',
      assignedFrom: null,
 };

 await updateSlot(serviceKey, accountRef, slotIndex, clearedSlot, allSlots);

 // Limpiar serviceAccountRef del usuario en el grupo Lank
 if (oldSlot.assignedFrom?.accountId && oldSlot.memberAlias) {
      try {
        const groups = groupDetails[serviceKey] || [];
        const lankAcct = groups.find(g => String(g.accountId) === String(oldSlot.assignedFrom.accountId) || g.id === String(oldSlot.assignedFrom.accountId));
        if (lankAcct) {
          const users = lankAcct.users || [];
          const userIdx = users.findIndex(u => {
            const alias = typeof u === 'string' ? u : (u.userAlias || '');
            return alias.toLowerCase() === oldSlot.memberAlias.toLowerCase();
          });
          if (userIdx !== -1) {
            await updateGroupUser(serviceKey, lankAcct.id, userIdx, {
              serviceAccountRef: '',
              serviceAccountLabel: '',
            }, users);
          }
        }
      } catch (err) {
        console.error('Error limpiando serviceAccountRef en grupo Lank:', err);
      }
 }

 // --- Generar alertas de cambio de contraseña si aplica ---
 if (oldSlot.memberAlias && oldSlot.status === 'active') {
   const svcMeta = getServiceMeta(serviceKey);
   const accessType = svcMeta.accessType || '';
   const isPasswordShared = accessType === 'credentials' || accessType === 'profile_project';

   if (isPasswordShared) {
     try {
       const serviceName = svcMeta.name || serviceKey;
       const acctIdStr = oldSlot.assignedFrom?.accountId ? String(oldSlot.assignedFrom.accountId) : '';
       // Buscar la cuenta real completa para obtener email
       const realAccounts = poolDetails[serviceKey] || [];
       const realAcct = realAccounts.find(a => a.id === accountRef);
       const realEmail = realAcct?.email || null;

       const otherUsers = allSlots
         .filter((s, i) => i !== slotIndex && s.memberAlias && s.status === 'active')
         .map(s => s.memberAlias);

       const acctLabel = realEmail ? `${accountRef} (${realEmail})` : accountRef;

       const baseAlert = {
         service: serviceName,
         accountId: acctIdStr,
         userAlias: oldSlot.memberAlias,
         serviceAccountRef: accountRef,
         realAccountEmail: realEmail,
         source: 'slot_cleared',
       };

       await createManualAlert({
         ...baseAlert,
         type: 'password_change',
         priority: 'high',
         title: `Cambiar contrasena - ${serviceName}`,
         description: `Cambiar contrasena de ${acctLabel}. El cupo de ${oldSlot.memberAlias} fue liberado manualmente.`,
       });

       if (otherUsers.length > 0) {
         await createManualAlert({
           ...baseAlert,
           type: 'access_verify',
           priority: 'medium',
           title: `Verificar acceso - ${serviceName}`,
           description: `Despues de cambiar la contrasena de ${acctLabel}, verificar que estos usuarios aun tengan acceso: ${otherUsers.join(', ')}`,
           dependsOn: 'password_change',
           affectedUsers: otherUsers,
         });
       }
     } catch (err) {
       console.error('Error generando alertas de cambio de contraseña al liberar cupo:', err);
     }
   }
 }

 showToast(`Cupo #${slotIndex + 1} liberado de ${clearSlotConfirm.accountLabel}`);
 setClearSlotConfirm(null);
 };

 // ─── MOVE USER BETWEEN REAL ACCOUNTS ───

 const handleSlotMove = (serviceKey, acct, slotIndex) => {
 const slot = acct.slots[slotIndex];
 // Obtener cuentas reales del mismo servicio con cupos libres, excluyendo la actual
 const allAccounts = poolDetails[serviceKey] || [];
 const destinations = allAccounts
      .filter(a => a.id !== acct.id) // excluir la cuenta actual
      .map(a => {
        const freeSlots = (a.slots || []).map((s, i) => ({ ...s, idx: i })).filter(s => s.status === 'free');
        return { ...a, freeSlots, freeCount: freeSlots.length };
      })
      .filter(a => a.freeCount > 0); // solo las que tienen cupos libres

 if (destinations.length === 0) {
      showToast('No hay cuentas reales con cupos disponibles para mover este usuario.', 'error');
      return;
 }

 setMoveSlotModal({
      serviceKey,
      sourceAcct: acct,
      slotIndex,
      slot,
      destinations,
      accountLabel: acct.label || acct.serviceAccountRef || acct.id,
 });
 };

 const handleMoveConfirm = async (destAccountId) => {
 if (!moveSlotModal) return;
 const { serviceKey, sourceAcct, slotIndex, slot, destinations } = moveSlotModal;
 const destAcct = destinations.find(d => d.id === destAccountId);
 if (!destAcct || destAcct.freeSlots.length === 0) {
      showToast('Esa cuenta ya no tiene cupos libres.', 'error');
      return;
 }

 const firstFreeSlot = destAcct.freeSlots[0]; // tomar el primer slot libre

 // Obtener lankInfo del slot origen (assignedFrom)
 const lankInfo = slot.assignedFrom ? {
      accountId: slot.assignedFrom.accountId,
      userAlias: slot.memberAlias,
 } : null;

 try {
      await moveUserBetweenAccounts(
        serviceKey,
        { accountRef: sourceAcct.id, slotIndex, slot, allSlots: sourceAcct.slots },
        { accountRef: destAcct.id, freeSlotIndex: firstFreeSlot.idx, allSlots: destAcct.slots, accountLabel: destAcct.label || destAcct.serviceAccountRef || destAcct.id },
        lankInfo,
      );
      showToast(`${slot.memberAlias} movido de ${moveSlotModal.accountLabel} a ${destAcct.label || destAcct.id}`);
 } catch (err) {
      showToast(`Error al mover: ${err.message}`, 'error');
 }
 setMoveSlotModal(null);
 };

 // ─── NON-POOL SERVICE HANDLERS (grupos Lank) ───
 const getGroupEditFields = (serviceKey) => getUserFields(serviceKey);

 const handleGroupEditSave = async (values) => {
 if (!groupEditModal) return;
 const { serviceKey, accountId, userIndex, allUsers } = groupEditModal;
 const fields = getGroupEditFields(serviceKey);
 const updatedUser = {};
 fields.forEach(f => {
      if (values[f.key] !== undefined) updatedUser[f.key] = values[f.key];
 });
 await updateGroupUser(serviceKey, accountId, userIndex, updatedUser, allUsers);
 const svcName = getServiceMeta(serviceKey).name;
 showToast(`Usuario ${svcName} actualizado en ${groupEditModal.accountLabel}`);
 };

 const handleGroupBajaConfirm = async () => {
 if (!groupBajaConfirm) return;
 const { serviceKey, accountId, userAlias, allUsers } = groupBajaConfirm;
 await removeGroupUser(serviceKey, accountId, userAlias, allUsers, 'Baja manual desde Suscripciones');
 const svcName = getServiceMeta(serviceKey).name;
 showToast(`${userAlias} dado de baja de ${svcName} en ${groupBajaConfirm.accountLabel}`);
 setGroupBajaConfirm(null);
 };

 const selectedMeta = selectedService ? getServiceMeta(selectedService) : null;

 // ─── Gestión de suscripciones: crear/editar/desactivar ───
 const allSvcKeys = useMemo(() => getAllServiceKeys(), [servicesConfig]);

 const generateKey = (name) => {
   return name.toLowerCase()
     .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
     .replace(/[^a-z0-9]+/g, '')
     .slice(0, 30);
 };

 const openCreateSvcModal = () => {
   setSvcForm({
     name: '', color: '#6366f1', logo: '', maxSlots: 4,
     usesPool: true, accessType: 'credentials', accessTypeLabel: '',
     displayOrder: allSvcKeys.length + 1, active: true,
     isRenewalBased: false,
     maxSlotsPerRealAccount: 4, maxSlotsPerLankGroup: 4,
   });
   setSvcSlotFields([
     { key: 'memberAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre del usuario' },
   ]);
   setSvcUserFields([
     { key: 'userAlias', label: 'Alias del usuario', required: true, placeholder: 'Nombre visible del usuario' },
   ]);
   setSvcAliasInput('');
   setSvcError('');
   setSvcModal({ mode: 'create' });
 };

 const openEditSvcModal = (key) => {
   const meta = getServiceMeta(key);
   setSvcForm({
     name: meta.name || '', color: meta.color || '#666', logo: meta.logo || '',
     maxSlots: meta.maxSlots || 4, usesPool: meta.usesPool !== false,
     accessType: meta.accessType || 'credentials',
     accessTypeLabel: meta.accessTypeLabel || '',
     displayOrder: meta.displayOrder || 1, active: meta.active !== false,
     isRenewalBased: meta.isRenewalBased || false,
     maxSlotsPerRealAccount: meta.maxSlotsPerRealAccount || meta.maxSlots || 4,
     maxSlotsPerLankGroup: meta.maxSlotsPerLankGroup || meta.maxSlots || 4,
   });
   setSvcSlotFields(meta.slotFields || []);
   setSvcUserFields(meta.userFields || []);
   setSvcAliasInput((meta.nameAliases || []).join(', '));
   setSvcError('');
   setSvcModal({ mode: 'edit', key });
 };

 const handleSvcSave = async () => {
   setSvcError('');
   const { name, color, maxSlots, accessType } = svcForm;
   if (!name.trim()) { setSvcError('El nombre es obligatorio'); return; }
   if (!accessType) { setSvcError('Debes elegir el tipo de acceso'); return; }
   if (Number(maxSlots) < 1 || Number(maxSlots) > 20) { setSvcError('Los cupos deben estar entre 1 y 20'); return; }

   const serviceKey = svcModal.mode === 'edit' ? svcModal.key : generateKey(name);
   if (!serviceKey) { setSvcError('No se pudo generar una clave válida'); return; }

   if (svcModal.mode === 'create') {
     const existing = getServiceMeta(serviceKey);
     if (existing && existing.name !== serviceKey) {
       setSvcError(`Ya existe un servicio con la clave "${serviceKey}"`); return;
     }
   }

   const nameAliases = svcAliasInput.split(',').map(a => a.trim()).filter(Boolean);
   if (!nameAliases.includes(name.trim())) nameAliases.unshift(name.trim());

   const config = {
     name: name.trim(), color, logo: svcForm.logo || '',
     maxSlots: Number(maxSlots), usesPool: svcForm.usesPool,
     accessType, accessTypeLabel: svcForm.accessTypeLabel || '',
     displayOrder: Number(svcForm.displayOrder) || 1,
     active: svcForm.active !== false,
     isRenewalBased: svcForm.isRenewalBased || false,
     maxSlotsPerRealAccount: Number(svcForm.maxSlotsPerRealAccount) || Number(maxSlots),
     maxSlotsPerLankGroup: Number(svcForm.maxSlotsPerLankGroup) || Number(maxSlots),
     nameAliases,
     slotFields: svcSlotFields.filter(f => f.key && f.label),
     userFields: svcUserFields.filter(f => f.key && f.label),
   };

   setSvcSaving(true);
   try {
     await updateServiceConfig(serviceKey, config);
     showToast(svcModal.mode === 'create' ? `Servicio "${name}" creado` : `${name} actualizado`);
     setSvcModal(null);
   } catch (err) {
     setSvcError('Error al guardar: ' + err.message);
   } finally {
     setSvcSaving(false);
   }
 };

 const handleSvcToggleActive = async (key) => {
   const meta = getServiceMeta(key);
   try {
     await updateServiceConfig(key, { active: meta.active === false });
     showToast(`${meta.name} ${meta.active === false ? 'activado' : 'desactivado'}`);
   } catch (err) {
     showToast('Error: ' + err.message, 'error');
   }
 };

 const addDynField = (setter) => setter(prev => [...prev, { key: '', label: '', required: false, placeholder: '' }]);
 const updateDynField = (setter, idx, field, value) => setter(prev => prev.map((f, i) => i === idx ? { ...f, [field]: value } : f));
 const removeDynField = (setter, idx) => setter(prev => prev.filter((_, i) => i !== idx));

 const handleMasterConfigSave = async (values) => {
   if (!editMasterModal) return;
   const { serviceKey, currentConfig } = editMasterModal;
   const nextConfig = {
     maxSlotsPerRealAccount: Number(values.maxSlotsPerRealAccount),
     maxSlotsPerLankGroup: Number(values.maxSlotsPerLankGroup),
     accessType: values.accessType,
     accessTypeLabel: ACCESS_TYPE_LABELS[values.accessType] || values.accessType,
   };

   await updateServiceMasterConfig(serviceKey, nextConfig);

   const oldMax = Number(currentConfig?.maxSlotsPerRealAccount || 0);
   const newMax = Number(nextConfig.maxSlotsPerRealAccount || 0);
   if (oldMax !== newMax) {
     const accounts = poolDetails[serviceKey] || [];
     const result = await propagateSlotsToRealAccounts(serviceKey, newMax, accounts);
     if (!result.success) {
       throw new Error(`No se pudo propagar a todas las cuentas: ${result.errors.join(' | ')}`);
     }
   }

   showToast(`Configuración actualizada para ${getServiceMeta(serviceKey).name}`);
   setEditMasterModal(null);
 };

 const validateMasterConfig = (values) => {
   const real = Number(values.maxSlotsPerRealAccount);
   const group = Number(values.maxSlotsPerLankGroup);
   if (!Number.isInteger(real) || real < 1 || real > 10) return 'La cuenta real debe tener entre 1 y 10 cupos.';
   if (!Number.isInteger(group) || group < 1 || group > 10) return 'El grupo Lank debe tener entre 1 y 10 cupos.';
   if (!values.accessType) return 'Debes seleccionar el tipo de acceso.';
   return '';
 };

 const handleToggleRealSlot = async (serviceKey, acct, idx, slot) => {
   try {
     const enabled = slot.enabled !== false;
     await toggleSlotEnabled(serviceKey, acct.id, idx, !enabled, acct.slots || []);
     showToast(`${enabled ? 'Cupo deshabilitado' : 'Cupo habilitado'} en ${acct.label || acct.id}`);
   } catch (err) {
     showToast(err.message, 'error');
   }
 };

 const handleToggleGroupSlot = async (serviceKey, group, idx) => {
   try {
     const disabledSlots = group.disabledSlots || [];
     const enabled = !disabledSlots.includes(idx);
     await updateGroupEnabledSlots(serviceKey, group.id, idx, !enabled, group.users || [], disabledSlots);
     showToast(`${enabled ? 'Cupo deshabilitado' : 'Cupo habilitado'} en grupo #${group.accountId}`);
   } catch (err) {
     showToast(err.message, 'error');
   }
 };

 // ─── Render slot con botones de edición ───
 const renderSlot = (slot, idx, acct, serviceKey) => {
 const isDisabled = slot.enabled === false || slot.status === 'disabled';
 const hasMember = !!slot.memberAlias?.trim();
 const isOccupied = slot.status === 'active' || hasMember;
 const isEmpty = !isOccupied;
 const hasLink = isOccupied && slot.assignedFrom?.accountId;
 const acctId = slot.assignedFrom?.accountId;
 const missing = getMissingFields(serviceKey, slot);
 const isUserHighlighted = highlightUser && slot.memberAlias &&
      slot.memberAlias.toLowerCase() === highlightUser.toLowerCase();
 const hasPendingAction = slot.memberAlias &&
      pendingUserAliases.has(slot.memberAlias.toLowerCase());
 const isSearchMatch = searchResults && searchResults.slots.has(`${serviceKey}:${acct.id}:${idx}`);
 const primaryLabel = isEmpty ? 'Llenar' : 'Editar';

 return (
      <div
        key={idx}
        className={`slot-item ${isOccupied ? 'occupied' : ''} ${isEmpty ? 'free' : ''} ${isDisabled ? 'disabled' : ''} ${hasLink ? 'clickable' : ''} ${isUserHighlighted ? 'highlight-user-pulse' : ''} ${hasPendingAction ? 'pending-action-slot' : ''} ${isSearchMatch ? 'search-match-slot' : ''}`}
        data-user-alias={slot.memberAlias ? slot.memberAlias.toLowerCase() : ''}
        onClick={() => hasLink && onNavigate && onNavigate('accounts', { accountId: acctId, serviceKey, userAlias: slot.memberAlias || slot.assignedFrom?.canonicalAlias || null })}
        style={hasLink ? { cursor: 'pointer' } : {}}
        title={hasLink ? `Clic para ir a Cuenta Lank #${acctId}` : ''}
      >
        {isOccupied && acctId && (
          <img
            src={getProfileImage(acctId)}
            className="slot-avatar"
            alt=""
            onError={e => { e.target.style.display = 'none'; }}
          />
        )}
        <div className="slot-info">
          <div className="slot-number">Cupo #{slot.slotNumber || idx + 1}</div>
          <div className="slot-user" style={{ color: isDisabled ? 'var(--text-muted)' : isEmpty ? 'var(--text-muted)' : 'var(--text-primary)' }}>
            {isDisabled && isEmpty ? 'Cupo deshabilitado' : slot.memberAlias || (isEmpty ? 'Disponible' : 'Ocupado')}
          </div>
          {/* Campos extra dinámicos del slot */}
          {(() => {
            const fields = getSlotFields(serviceKey);
            return fields.filter(f => f.key !== 'memberAlias' && slot[f.key]).map(f => (
              <div key={f.key} className="slot-detail">
                {f.type === 'email' ? <EmailIcon size={16} /> : f.key === 'profileName' ? <UserIcon size={16} /> : f.key === 'projectName' ? <FolderIcon size={16} /> : null}
                {' '}{slot[f.key]}
              </div>
            ));
          })()}
          {slot.assignedFrom && (
            <div className="slot-from">
              ← {slot.assignedFrom.canonicalAlias || slot.assignedFrom.lankOwnerAlias} (#{acctId})
            </div>
          )}
          {isOccupied && missing.length > 0 && (
            <div className="slot-missing-info">
              <WarningIcon size={16} /> Falta: {missing.join(', ')}
            </div>
          )}

          <div className="alert-actions slot-actions-compact" style={{ marginTop: '6px' }}>
            <button
              className="alert-action-btn edit"
              onClick={(e) => { e.stopPropagation(); handleSlotEdit(serviceKey, acct, idx); }}
              title={isEmpty ? 'Llenar cupo manualmente' : 'Editar información del cupo'}
              disabled={isDisabled}
            >
              <EditIcon size={16} /> {primaryLabel}
            </button>
            {isEmpty && (
              <button
                className="alert-action-btn assign"
                onClick={(e) => { e.stopPropagation(); handleToggleRealSlot(serviceKey, acct, idx, slot); }}
                title={isDisabled ? 'Habilitar este cupo' : 'Deshabilitar este cupo'}
              >
                {isDisabled ? <ToggleOffIcon size={16} /> : <ToggleOnIcon size={16} />} {isDisabled ? 'Habilitar' : 'Deshabilitar'}
              </button>
            )}
            {isOccupied && !isDisabled && (
              <div className="slot-secondary-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="crud-icon-btn"
                  onClick={() => handleSlotMove(serviceKey, acct, idx)}
                  title="Mover a otra cuenta real"
                >
                  <RefreshIcon size={14} />
                </button>
                <button
                  className="crud-icon-btn danger"
                  onClick={() => handleSlotClear(serviceKey, acct, idx)}
                  title="Liberar este cupo"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
 );
 };

 return (
 <>
      <div className="section-header">
        <div className="section-title"><KeyIcon size={16} /> Suscripciones — Pools de cuentas reales</div>
        <button className="tools-btn tools-btn-secondary" onClick={() => setShowMasterConfig(v => !v)}>
          <SettingsIcon size={16} /> {showMasterConfig ? 'Ocultar configuración' : 'Configurar suscripciones'}
        </button>
      </div>

      {showMasterConfig && (
        <div className="master-config-panel">
          <div className="master-config-header">
            <div>
              <div className="section-title" style={{ gap: '8px' }}><SlidersIcon size={16} /> Gestionar suscripciones</div>
              <div className="header-subtitle">Cupos, tipo de acceso, campos y reglas globales. Crea nuevos servicios o edita los existentes.</div>
            </div>
            <button className="tools-btn tools-btn-primary" onClick={openCreateSvcModal}>
              <PlusIcon size={16} /> Nueva suscripción
            </button>
          </div>
          <div className="master-config-grid">
            {allServiceIds.map(svcId => {
              const meta = getServiceMeta(svcId);
              const cfg = masterConfig[svcId] || DEFAULT_MASTER_CONFIG[svcId];
              const isActive = meta.active !== false;
              return (
                <div key={svcId} className={`master-config-card ${!isActive ? 'master-config-inactive' : ''}`} style={{ '--svc-color': meta.color }}>
                  <div className="master-config-card-top">
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      {meta.logo && <img src={meta.logo} alt={meta.name} className="svc-logo" style={{ width: '36px', height: '36px' }} onError={e => { e.target.style.display = 'none'; }} />}
                      <div>
                        <div className="master-config-name">
                          {meta.name}
                          {!isActive && <span className="badge badge-danger" style={{ fontSize: '9px', marginLeft: '6px' }}>Inactivo</span>}
                        </div>
                        <div className="master-config-access">{getDisplayAccessTypeLabel(svcId, cfg)}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button className="alert-action-btn edit" onClick={() => openEditSvcModal(svcId)} title="Editar servicio completo">
                        <SettingsIcon size={14} />
                      </button>
                      <button className="alert-action-btn edit" onClick={() => setEditMasterModal({ serviceKey: svcId, currentConfig: cfg })} title="Editar cupos y acceso">
                        <EditIcon size={14} />
                      </button>
                      <button
                        className={`alert-action-btn ${isActive ? 'danger' : 'assign'}`}
                        onClick={() => handleSvcToggleActive(svcId)}
                        title={isActive ? 'Desactivar servicio' : 'Activar servicio'}
                      >
                        {isActive ? <ToggleOffIcon size={14} /> : <ToggleOnIcon size={14} />}
                      </button>
                    </div>
                  </div>
                  <div className="master-config-stats">
                    <div className="master-config-stat">
                      <span className="master-config-stat-label">Cuenta real</span>
                      <strong>{cfg?.maxSlotsPerRealAccount || 0} cupos</strong>
                    </div>
                    <div className="master-config-stat">
                      <span className="master-config-stat-label">Grupo Lank</span>
                      <strong>{cfg?.maxSlotsPerLankGroup || 0} cupos</strong>
                    </div>
                    <div className="master-config-stat">
                      <span className="master-config-stat-label">Tipo</span>
                      <strong style={{ fontSize: '11px' }}>{meta.usesPool !== false ? 'Pool' : 'Grupo'}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ BUSCADOR GLOBAL ═══ */}
      <SearchBar
        value={searchQuery}
        onChange={v => { setSearchQuery(v); if (!v) clearSearch(); }}
        placeholder="Buscar por usuario, correo, proyecto, perfil, cuenta real..."
        resultCount={searchResults && searchQuery.length >= 2 ? searchResults.total : undefined}
      >
        {searchResults && searchQuery.length >= 2 && searchResults.total > 0 && (
          Object.entries(searchResults.matches).map(([svcId, ids]) => (
            <button
              key={svcId}
              className={`search-svc-chip ${selectedService === svcId ? 'active' : ''}`}
              onClick={() => setSelectedService(svcId)}
            >
              <img src={getServiceMeta(svcId).logo} alt="" className="search-svc-chip-logo" />
              {ids.size}
            </button>
          ))
        )}
      </SearchBar>

      {/* Tarjetas de resumen por servicio */}
      <div className="svc-overview-grid" ref={overviewRef}>
        {allServiceIds.map(svcId => {
          const m = getServiceMeta(svcId);
          const stats = getStats(svcId);
          const isActive = selectedService === svcId;
          const isNonPoolService = !getServiceMeta(svcId).usesPool;

          return (
            <div
              key={svcId}
              className={`svc-overview-card ${isActive ? 'selected' : ''} ${selectedService && !isActive ? 'dimmed' : ''}`}
              style={{ '--svc-color': m.color }}
              onClick={() => { setSelectedService(isActive ? null : svcId); setHighlightRef(null); }}
            >
              <div className="svc-overview-top">
                <img src={m.logo} alt={m.name} className="svc-logo" />
                <div>
                  <div className="svc-overview-name">{m.name}</div>
                  <div className="svc-overview-sub">
                    {isNonPoolService
                      ? `${stats.groupCount} grupo${stats.groupCount !== 1 ? 's' : ''} activo${stats.groupCount !== 1 ? 's' : ''}`
                      : `${stats.realAccountCount} cuenta${stats.realAccountCount !== 1 ? 's' : ''} real${stats.realAccountCount !== 1 ? 'es' : ''}`
                    }
                  </div>
                </div>
              </div>
              <div className="svc-stats-row">
                <div className="svc-stat-box">
                  <div className="svc-stat-val">{isNonPoolService ? stats.groupCount : stats.realAccountCount}</div>
                  <div className="svc-stat-lbl">{isNonPoolService ? 'Grupos' : 'Cuentas'}</div>
                </div>
                <div className="svc-stat-box">
                  <div className="svc-stat-val">{stats.usedSlots}<span>/{stats.totalSlots}</span></div>
                  <div className="svc-stat-lbl">Cupos</div>
                </div>
                <div className={`svc-stat-box ${stats.hasDiscrepancy ? 'warn' : ''}`}>
                  <div className="svc-stat-val">{stats.totalUsers}</div>
                  <div className="svc-stat-lbl">Usuarios</div>
                </div>
                <div className="svc-stat-box">
                  <div className="svc-stat-val">{stats.freeSlots}</div>
                  <div className="svc-stat-lbl">Libres</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ═══ STICKY BAR ═══ */}
      {selectedService && showStickyBar && (
        <div className="svc-sticky-bar-flush">
          {allServiceIds.map(svcId => {
            const m = getServiceMeta(svcId);
            const isActive = selectedService === svcId;
            return (
              <button
                key={svcId}
                className={`svc-sticky-btn ${isActive ? 'active' : ''}`}
                style={isActive ? { '--svc-color': m.color } : {}}
                onClick={() => handleStickySelect(svcId)}
              >
                <img src={m.logo} alt="" className="svc-sticky-logo" />
                <span>{m.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ═══ DETALLE: Cuentas reales ═══ */}
      {selectedService && getServiceMeta(selectedService).usesPool !== false && poolDetails[selectedService] && (
        <div ref={detailRef} style={{ marginTop: '12px' }}>
          <div className="section-header">
            <div className="section-title" style={{ gap: '10px' }}>
              <img src={selectedMeta.logo} className="svc-logo-sm" alt="" />
              {selectedMeta.name} — Cuentas reales
            </div>
            <span className="badge badge-info">
              {poolDetails[selectedService].length} cuenta{poolDetails[selectedService].length !== 1 ? 's' : ''}
            </span>
          </div>

          {poolDetails[selectedService]
            .filter(acct => {
              if (!searchResults || !searchQuery) return true;
              const svcMatches = searchResults.matches[selectedService];
              return svcMatches && svcMatches.has(acct.id);
            })
            .sort((a, b) => (a.serviceAccountRef || '').localeCompare(b.serviceAccountRef || ''))
            .map(acct => {
              const slots = acct.slots || [];
              const active = slots.filter(s => s.status === 'active').length;
              const free = slots.filter(s => s.status === 'free').length;
              const m = getServiceMeta(selectedService);
              const isHighlighted = highlightRef && (acct.id === highlightRef || acct.serviceAccountRef === highlightRef);
              const pwAlert = getPasswordAlert(acct.serviceAccountRef || acct.id);

              return (
                <div
                  className={`real-account-card ${isHighlighted ? 'highlight-pulse' : ''} ${pwAlert ? 'password-change-pending' : ''}`}
                  key={acct.id}
                  id={`real-account-${acct.id}`}
                >
                  <div className="real-account-header" style={{ borderLeft: `4px solid ${pwAlert ? '#ef4444' : m.color}` }}>
                    <div>
                      <div
                        className="real-account-title cross-nav-link"
                        onClick={() => onNavigate && onNavigate('vault', { serviceKey: selectedService, serviceAccountRef: acct.serviceAccountRef || acct.id })}
                        title="Ir a Bóveda"
                        style={{ cursor: 'pointer' }}
                      >
                        {acct.label || acct.serviceAccountRef}
                        <LinkIcon size={14} style={{ marginLeft: '6px', opacity: 0.5 }} />
                      </div>
                      {pwAlert && (
                        <div
                          className="password-change-banner"
                          onClick={() => onNavigate && onNavigate('vault', { service: selectedService, accountRef: acct.serviceAccountRef || acct.id })}
                          style={{ cursor: 'pointer' }}
                        >
                          <LockKeyIcon size={14} />
                          <span>Cambio de contraseña pendiente</span>
                          <span style={{ fontSize: '10px', opacity: 0.8 }}>— Ir a Bóveda</span>
                        </div>
                      )}
                      <div className="real-account-meta">
                        <span><EmailIcon size={16} /> {acct.email || 'N/A'}</span>
                        {acct.billingDay && <span><CalendarIcon size={16} /> Día {acct.billingDay}</span>}
                        {acct.cardLabel && <span><CreditCardIcon size={16} /> {acct.cardLabel}</span>}
                        {acct.billingDay && <span><CashIcon size={16} /> {acct.monthlyCost > 0 ? `$${acct.monthlyCost}/mes` : 'Monto pendiente'}</span>}
                        {acct.expiresAt && <span><ClockIcon size={16} /> Expira: {acct.expiresAt}</span>}
                        {acct.cancelOn && <span><ClockIcon size={16} /> Cancela: {acct.cancelOn}</span>}
                        {acct.autoRenewEnabled === false && <span className="badge badge-warning" style={{ fontSize: '10px' }}>Sin renovación</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span className="badge badge-success"><DotGreen /> {active}</span>
                      <span className="badge badge-muted"><DotGray /> {free}</span>
                    </div>
                  </div>
                  <div className="real-account-body">
                    <div className="slot-grid">
                      {slots.map((slot, idx) => renderSlot(slot, idx, acct, selectedService))}
                    </div>
                    {acct.notes && acct.notes.length > 0 && (
                      <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
                         {acct.notes.join(' | ')}
                      </div>
                    )}
                    <EntityHistory history={acct.slotHistory} label="Historial de cupos" searchKey={acct.serviceAccountRef || acct.id} onNavigate={onNavigate} />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* ═══ DETALLE: Servicios sin pool (grupos Lank) ═══ */}
      {selectedService && getServiceMeta(selectedService).usesPool === false && (
        <div ref={detailRef} style={{ marginTop: '12px' }}>
          <div className="section-header">
            <div className="section-title" style={{ gap: '10px' }}>
              <img src={selectedMeta.logo} className="svc-logo-sm" alt="" />
              {selectedMeta.name} — Grupos de cuentas Lank
            </div>
            <span className="badge badge-info">
              {(groupDetails[selectedService] || []).length} grupo{(groupDetails[selectedService] || []).length !== 1 ? 's' : ''}
            </span>
          </div>

          {(groupDetails[selectedService] || [])
            .filter(g => g.groupStatus === 'active')
            .filter(g => {
              if (!searchResults || !searchQuery) return true;
              const svcMatches = searchResults.matches[selectedService];
              return svcMatches && svcMatches.has(g.id);
            })
            .sort((a, b) => (a.accountId || 0) - (b.accountId || 0))
            .map(group => {
              const users = group.users || [];
              const disabledSlots = group.disabledSlots || [];
              const maxSlots = getMaxSlots(selectedService, 'lankGroup');
              const m = getServiceMeta(selectedService);
              const svcUserFields = getUserFields(selectedService);

              return (
                <div className="real-account-card" key={group.id}>
                  <div className="real-account-header" style={{ borderLeft: `4px solid ${m.color}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <img
                        src={getProfileImage(group.accountId)}
                        className="lank-avatar"
                        alt=""
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <div>
                        <div className="real-account-title">
                          #{group.accountId} — {group.accountAlias || group.fullName}
                        </div>
                        <div className="real-account-meta">
                          <span> {group.fullName}</span>
                          {group.groupStatus === 'active' && <span className="badge badge-success" style={{ fontSize: '10px' }}>Activo</span>}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span className="badge badge-success"><DotGreen /> {users.length}</span>
                      <span className="badge badge-muted"><DotGray /> {maxSlots - users.length}</span>
                    </div>
                  </div>
                  <div className="real-account-body">
                    <div className="slot-grid">
                      {Array.from({ length: maxSlots }).map((_, idx) => {
                        const user = users[idx];
                        const slotDisabled = disabledSlots.includes(idx);
                        const userAlias = typeof user === 'string' ? user : user?.userAlias || null;
                        const isOccupied = !!userAlias;

                        // Calcular campos faltantes dinámicamente desde userFields
                        const missingFields = [];
                        if (isOccupied) {
                          svcUserFields.forEach(field => {
                            if (field.key === 'userAlias') return; // ya validado por isOccupied
                            const val = typeof user === 'object' ? user?.[field.key] : null;
                            if (!val) missingFields.push(field.label);
                          });
                        }

                        // Extraer valores dinámicos para mostrar en el slot
                        const displayValues = {};
                        if (typeof user === 'object' && user) {
                          svcUserFields.forEach(field => {
                            if (field.key !== 'userAlias' && user[field.key]) {
                              displayValues[field.key] = { value: user[field.key], label: field.label, type: field.type };
                            }
                          });
                        }

                        return (
                          <div
                            key={idx}
                            className={`slot-item ${isOccupied ? 'occupied' : 'free'} ${slotDisabled ? 'disabled' : ''}`}
                          >
                            <div className="slot-info">
                              <div className="slot-number">Cupo #{idx + 1}</div>
                              <div className="slot-user" style={{ color: slotDisabled ? 'var(--text-muted)' : isOccupied ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                {slotDisabled ? 'Deshabilitado' : userAlias || 'Disponible'}
                              </div>
                              {Object.entries(displayValues).map(([key, { value, label, type }]) => (
                                <div key={key} className={type === 'email' ? 'slot-detail' : 'slot-from'}>
                                  {type === 'email' ? <EmailIcon size={16} /> : <CalendarIcon size={16} />}
                                  {' '}{type === 'select-day' ? `${label}: día ${value} de cada mes` : value}
                                </div>
                              ))}
                              {isOccupied && (
                                <div className="slot-from">
                                  ← {group.accountAlias} (#{group.accountId})
                                </div>
                              )}
                              {isOccupied && missingFields.length > 0 && (
                                <div className="slot-missing-info">
                                   Falta: {missingFields.join(', ')}
                                </div>
                              )}

                              <div className="alert-actions slot-actions-compact" style={{ marginTop: '6px' }}>
                                <button
                                  className="alert-action-btn edit"
                                  onClick={() => setGroupEditModal({
                                    serviceKey: selectedService,
                                    groupId: group.id,
                                    userIndex: idx,
                                    user: typeof user === 'object' ? user : { userAlias: user },
                                    allUsers: users,
                                    accountLabel: `${group.accountAlias || group.fullName} (#${group.accountId})`,
                                    accountId: group.accountId,
                                  })}
                                  title={isOccupied ? 'Editar información del usuario' : 'Llenar cupo manualmente'}
                                  disabled={slotDisabled}
                                >
                                   <EditIcon size={16} /> {isOccupied ? 'Editar' : 'Llenar'}
                                </button>
                                {!isOccupied && (
                                  <button
                                    className="alert-action-btn assign"
                                    onClick={() => handleToggleGroupSlot(selectedService, group, idx)}
                                    title={slotDisabled ? 'Habilitar este cupo' : 'Deshabilitar este cupo'}
                                  >
                                    {slotDisabled ? <ToggleOffIcon size={16} /> : <ToggleOnIcon size={16} />} {slotDisabled ? 'Habilitar' : 'Deshabilitar'}
                                  </button>
                                )}
                                {isOccupied && !slotDisabled && (
                                  <div className="slot-secondary-actions">
                                    <button
                                      className="crud-icon-btn danger"
                                      onClick={() => setGroupBajaConfirm({
                                        serviceKey: selectedService,
                                        groupId: group.id,
                                        userIndex: idx,
                                        userAlias,
                                        allUsers: users,
                                        accountLabel: `${group.accountAlias || group.fullName} (#${group.accountId})`,
                                        accountId: group.accountId,
                                      })}
                                      title="Dar de baja a este usuario"
                                    >
                                      <BlockIcon size={14} />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <EntityHistory history={group.userHistory} label="Historial de usuarios" searchKey={`${group.accountAlias || group.accountId}`} onNavigate={onNavigate} />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {!selectedService && (
        <div className="empty-state" style={{ marginTop: '32px' }}>
          <div className="empty-state-icon"><PointUpIcon size={16} /></div>
          <p>Selecciona un servicio para ver sus cuentas reales y cupos</p>
        </div>
      )}

      {/* ═══ MODALES ═══ */}

      {/* Modal: Editar / llenar cupo */}
      <EditModal
        open={!!editSlotModal}
        onClose={() => setEditSlotModal(null)}
        onSave={handleSlotEditSave}
        title={editSlotModal?.slot?.status === 'free' ? 'Llenar cupo manualmente' : 'Editar información del cupo'}
        icon={editSlotModal?.slot?.status === 'free' ? <PlusIcon size={16} /> : <EditIcon size={16} />}
        fields={editSlotModal ? getEditableFieldsForService(editSlotModal.serviceKey) : []}
        initialValues={editSlotInitialValues}
        resetKey={fillLankUserAlias}
        saveLabel={editSlotModal?.slot?.status === 'free' ? <><PlusIcon size={16} /> Asignar cupo</> : ' Guardar cambios'}
        confirmMessage={
          editSlotModal?.slot?.status === 'free'
            ? (fillLankAccountId && fillLankUserAlias
                ? `Se asignará este cupo a "${fillLankUserAlias}" de la cuenta Lank #${fillLankAccounts.find(a => a.id === fillLankAccountId)?.accountId || fillLankAccountId}.`
                  + (existingSlotInfo
                    ? ` Se liberará automáticamente su cupo actual en ${existingSlotInfo.accountLabel} (cupo #${existingSlotInfo.slotIndex + 1}).`
                    : '')
                  + ' Se actualizará la referencia en el grupo Lank automáticamente.'
                : 'Se asignará este cupo al usuario indicado. Asegúrate de que la información sea correcta.')
            : 'Se actualizará la información de este cupo en Firestore.'
        }
      >
        {editSlotModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{editSlotModal.accountLabel}</strong> — Cupo #{editSlotModal.slotIndex + 1}
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Servicio: <span style={{ fontWeight: 600 }}>{getServiceMeta(editSlotModal.serviceKey).name}</span>
            </div>

            {/* ── Selectores de cuenta Lank al llenar cupo libre ── */}
            {editSlotModal.slot.status === 'free' && fillLankAccounts.length > 0 && (
              <div className="fill-lank-section">
                <div className="fill-lank-header">
                  <span></span> Vincular a cuenta Lank <span className="fill-lank-optional">(opcional)</span>
                </div>
                <div className="fill-lank-selectors">
                  <div className="fill-lank-field">
                    <label className="fill-lank-label">Cuenta Lank</label>
                    <select
                      className="edit-modal-input"
                      value={fillLankAccountId}
                      onChange={e => {
                        setFillLankAccountId(e.target.value);
                        setFillLankUserAlias('');
                      }}
                    >
                      <option value="">— Sin vincular —</option>
                      {fillLankAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          #{a.accountId} — {a.accountAlias || a.fullName} ({(a.users || []).length} usuario{(a.users || []).length !== 1 ? 's' : ''})
                        </option>
                      ))}
                    </select>
                  </div>

                  {fillLankAccountId && fillLankUsers.length > 0 && (
                    <div className="fill-lank-field">
                      <label className="fill-lank-label">Usuario del grupo</label>
                      <select
                        className="edit-modal-input"
                        value={fillLankUserAlias}
                        onChange={e => setFillLankUserAlias(e.target.value)}
                      >
                        <option value="">— Seleccionar usuario —</option>
                        {fillLankUsers.map((u, i) => {
                          const alias = u.userAlias || '';
                          const hasRef = u.serviceAccountRef;
                          return (
                            <option key={i} value={alias}>
                              {alias}{hasRef ? ` (ya en ${hasRef})` : ''}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  {fillLankAccountId && fillLankUserAlias && (
                    <div className={`fill-lank-preview ${existingSlotInfo ? 'fill-lank-preview-migrate' : ''}`}>
                      {existingSlotInfo ? (
                        <>
                          <div className="fill-lank-warning">
                            <span><WarningIcon size={16} /></span> <strong>{fillLankUserAlias}</strong> ya ocupa el cupo #{existingSlotInfo.slotIndex + 1} en <strong>{existingSlotInfo.accountLabel}</strong>
                            {existingSlotInfo.accountEmail && (
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}> ({existingSlotInfo.accountEmail})</span>
                            )}
                          </div>
                          <div className="fill-lank-migrate-info">
                            <RefreshIcon size={16} /> Al confirmar, se <strong>migrará</strong> al usuario: se liberará el cupo anterior y se asignará aquí.
                          </div>
                        </>
                      ) : (
                        <>
                           Se vinculará <strong>{fillLankUserAlias}</strong> de cuenta Lank <strong>#{fillLankAccounts.find(a => a.id === fillLankAccountId)?.accountId}</strong>
                        </>
                      )}
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Los campos se auto-llenaron con los datos del usuario. Puedes modificarlos abajo si es necesario.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </EditModal>

      {/* Diálogo: Confirmar liberación de cupo */}
      <ConfirmDialog
        open={!!clearSlotConfirm}
        onClose={() => setClearSlotConfirm(null)}
        onConfirm={handleSlotClearConfirm}
        title="Liberar cupo"
        message={
          clearSlotConfirm
            ? `¿Estás seguro de liberar el cupo de "${clearSlotConfirm.memberAlias}" en ${clearSlotConfirm.accountLabel}? Esta acción es irreversible.`
              + (getServiceMeta(clearSlotConfirm.serviceKey).accessType === 'credentials'
                ? '\n\nRECORDATORIO: Este servicio usa contraseña compartida. Recuerda cambiar la contraseña de la cuenta real.'
                : '')
            : ''
        }
        confirmLabel={<><TrashIcon size={16} /> Sí, liberar cupo</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Modal: Editar usuario de grupo Lank */}
      <EditModal
        open={!!groupEditModal}
        onClose={() => setGroupEditModal(null)}
        onSave={handleGroupEditSave}
        title={groupEditModal?.user?.userAlias ? `Editar usuario ${getServiceMeta(groupEditModal?.serviceKey).name}` : `Llenar cupo ${getServiceMeta(groupEditModal?.serviceKey).name}`}
        icon={groupEditModal?.user?.userAlias ? <EditIcon size={16} /> : <PlusIcon size={16} />}
        fields={groupEditModal ? getGroupEditFields(groupEditModal.serviceKey) : []}
        initialValues={groupEditModal ? (() => {
          const fields = getGroupEditFields(groupEditModal.serviceKey);
          const vals = {};
          fields.forEach(f => {
            vals[f.key] = groupEditModal.user?.[f.key] || '';
          });
          return vals;
        })() : {}}
        saveLabel={groupEditModal?.user?.userAlias ? <><SaveIcon size={16} /> Guardar cambios</> : ' Asignar cupo'}
        confirmMessage={`Se actualizará la información del usuario ${groupEditModal ? getServiceMeta(groupEditModal.serviceKey).name : ''} en el grupo Lank.`}
      >
        {groupEditModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{groupEditModal.accountLabel}</strong> — Cupo #{groupEditModal.userIndex + 1}
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Servicio: <span style={{ fontWeight: 600 }}>{getServiceMeta(groupEditModal.serviceKey).name}</span>
            </div>
          </div>
        )}
      </EditModal>

      {/* Diálogo: Confirmar baja de grupo Lank */}
      <ConfirmDialog
        open={!!groupBajaConfirm}
        onClose={() => setGroupBajaConfirm(null)}
        onConfirm={handleGroupBajaConfirm}
        title={`Dar de baja — ${groupBajaConfirm ? getServiceMeta(groupBajaConfirm.serviceKey).name : ''}`}
        message={groupBajaConfirm ? `¿Estás seguro de dar de baja a "${groupBajaConfirm.userAlias}" del grupo ${getServiceMeta(groupBajaConfirm.serviceKey).name} de ${groupBajaConfirm.accountLabel}? Esta acción es irreversible.` : ''}
        confirmLabel={<><BlockIcon size={16} /> Sí, dar de baja</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Modal: Mover usuario a otra cuenta real */}
      {moveSlotModal && (
        <div className="edit-modal-overlay" onClick={() => setMoveSlotModal(null)}>
          <div className="edit-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="edit-modal-header">
              <span className="edit-modal-icon"><RefreshIcon size={16} /></span>
              <h3 className="edit-modal-title">Mover usuario entre cuentas</h3>
              <button className="edit-modal-close" onClick={() => setMoveSlotModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '16px', padding: '0 20px' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{moveSlotModal.slot.memberAlias}</strong>
              <span> — actualmente en <strong>{moveSlotModal.accountLabel}</strong></span>
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                Servicio: <span style={{ fontWeight: 600 }}>{getServiceMeta(moveSlotModal.serviceKey).name}</span>
              </div>
            </div>
            <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
                Seleccionar destino ({moveSlotModal.destinations.length} cuenta{moveSlotModal.destinations.length !== 1 ? 's' : ''} disponible{moveSlotModal.destinations.length !== 1 ? 's' : ''})
              </div>
              {moveSlotModal.destinations.map(dest => (
                <button
                  key={dest.id}
                  className="alert-card-v2"
                  style={{
                    cursor: 'pointer', border: '1px solid var(--border-color)',
                    borderRadius: '8px', padding: '12px 16px', textAlign: 'left',
                    background: 'rgba(99,102,241,0.03)', transition: 'all 0.2s',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                  onClick={() => handleMoveConfirm(dest.id)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.background = 'rgba(99,102,241,0.03)'; }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                      {dest.label || dest.serviceAccountRef || dest.id}
                    </div>
                    {dest.email && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        <EmailIcon size={16} /> {dest.email}
                      </div>
                    )}
                  </div>
                  <div style={{
                    fontSize: '12px', fontWeight: 700, padding: '4px 10px',
                    borderRadius: '6px', background: 'rgba(16,185,129,0.1)', color: '#10b981',
                  }}>
                    {dest.freeCount} libre{dest.freeCount !== 1 ? 's' : ''}
                  </div>
                </button>
              ))}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px', lineHeight: 1.4 }}>
                <WarningIcon size={16} /> Al mover, se liberará el cupo en la cuenta de origen y se ocupará uno en la cuenta destino. El grupo Lank se actualiza automáticamente.
              </div>
            </div>
          </div>
        </div>
      )}

      <EditModal
        open={!!editMasterModal}
        onClose={() => setEditMasterModal(null)}
        onSave={handleMasterConfigSave}
        title={editMasterModal ? `Configurar ${getServiceMeta(editMasterModal.serviceKey).name}` : 'Configurar suscripción'}
        icon={<SettingsIcon size={16} />}
        fields={MASTER_CONFIG_FIELDS}
        initialValues={editMasterModal?.currentConfig || {}}
        saveLabel={<><SaveIcon size={16} /> Guardar configuración</>}
        validate={validateMasterConfig}
        confirmMessage="Se actualizará la configuración global del servicio y, si cambian los cupos de cuenta real, se propagará a todas las cuentas reales existentes."
      >
        {editMasterModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{getServiceMeta(editMasterModal.serviceKey).name}</strong>
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Límite absoluto: 10 cupos. Los cambios en cuentas reales se aplican inmediatamente si no hay cupos ocupados fuera del nuevo rango.
            </div>
          </div>
        )}
      </EditModal>

      {/* ═══ Modal: Crear/Editar Suscripción ═══ */}
      {svcModal && (
        <div className="edit-modal-overlay" onClick={() => setSvcModal(null)}>
          <div className="edit-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '720px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div className="edit-modal-header">
              <span className="edit-modal-icon">{svcModal.mode === 'create' ? <PlusIcon size={16} /> : <SettingsIcon size={16} />}</span>
              <h3 className="edit-modal-title">{svcModal.mode === 'create' ? 'Crear suscripción' : `Editar ${svcForm.name}`}</h3>
              <button className="edit-modal-close" onClick={() => setSvcModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {svcError && <div style={{ background: 'rgba(239,68,68,.1)', color: '#ef4444', padding: '8px 12px', borderRadius: '8px', fontSize: '13px' }}><WarningIcon size={14} /> {svcError}</div>}

              {/* Nombre y clave */}
              <div className="tools-svc-field-row">
                <div className="tools-svc-field" style={{ flex: 2 }}>
                  <label>Nombre del servicio *</label>
                  <input type="text" className="edit-modal-input" value={svcForm.name} onChange={e => setSvcForm(f => ({ ...f, name: e.target.value }))} placeholder="Ej: Netflix Premium" />
                </div>
                <div className="tools-svc-field" style={{ flex: 1 }}>
                  <label>Clave {svcModal.mode === 'create' ? '(auto)' : ''}</label>
                  <input type="text" className="edit-modal-input" value={svcModal.mode === 'edit' ? svcModal.key : generateKey(svcForm.name)} disabled style={{ opacity: 0.6 }} />
                </div>
              </div>

              {/* Color y Logo */}
              <div className="tools-svc-field-row">
                <div className="tools-svc-field">
                  <label>Color</label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input type="color" value={svcForm.color} onChange={e => setSvcForm(f => ({ ...f, color: e.target.value }))} style={{ width: '40px', height: '32px', border: 'none', cursor: 'pointer', borderRadius: '6px' }} />
                    <input type="text" className="edit-modal-input" value={svcForm.color} onChange={e => setSvcForm(f => ({ ...f, color: e.target.value }))} style={{ flex: 1 }} />
                  </div>
                </div>
                <div className="tools-svc-field" style={{ flex: 2 }}>
                  <label>Logo (ruta o URL)</label>
                  <input type="text" className="edit-modal-input" value={svcForm.logo} onChange={e => setSvcForm(f => ({ ...f, logo: e.target.value }))} placeholder="/assets/Servicio.png" />
                </div>
              </div>

              {/* Cupos y orden */}
              <div className="tools-svc-field-row">
                <div className="tools-svc-field">
                  <label>Max cupos</label>
                  <input type="number" className="edit-modal-input" value={svcForm.maxSlots} onChange={e => setSvcForm(f => ({ ...f, maxSlots: e.target.value }))} min={1} max={20} />
                </div>
                <div className="tools-svc-field">
                  <label>Max cuenta real</label>
                  <input type="number" className="edit-modal-input" value={svcForm.maxSlotsPerRealAccount} onChange={e => setSvcForm(f => ({ ...f, maxSlotsPerRealAccount: e.target.value }))} min={1} max={20} />
                </div>
                <div className="tools-svc-field">
                  <label>Max grupo Lank</label>
                  <input type="number" className="edit-modal-input" value={svcForm.maxSlotsPerLankGroup} onChange={e => setSvcForm(f => ({ ...f, maxSlotsPerLankGroup: e.target.value }))} min={1} max={20} />
                </div>
                <div className="tools-svc-field">
                  <label>Orden</label>
                  <input type="number" className="edit-modal-input" value={svcForm.displayOrder} onChange={e => setSvcForm(f => ({ ...f, displayOrder: e.target.value }))} min={1} />
                </div>
              </div>

              {/* Tipo de acceso */}
              <div className="tools-svc-field-row">
                <div className="tools-svc-field" style={{ flex: 1 }}>
                  <label>Tipo de acceso *</label>
                  <select className="edit-modal-input" value={svcForm.accessType} onChange={e => setSvcForm(f => ({ ...f, accessType: e.target.value }))}>
                    <option value="credentials">Credenciales compartidas</option>
                    <option value="email_invitation">Invitación por correo</option>
                    <option value="profile_project">Perfil / proyecto</option>
                  </select>
                </div>
                <div className="tools-svc-field" style={{ flex: 1 }}>
                  <label>Label personalizado</label>
                  <input type="text" className="edit-modal-input" value={svcForm.accessTypeLabel} onChange={e => setSvcForm(f => ({ ...f, accessTypeLabel: e.target.value }))} placeholder="Ej: Perfil / proyecto" />
                </div>
              </div>

              {/* Toggles */}
              <div className="tools-svc-field-row">
                <label className="tools-svc-toggle"><input type="checkbox" checked={svcForm.usesPool} onChange={e => setSvcForm(f => ({ ...f, usesPool: e.target.checked }))} /><span>Usa pool de cuentas reales</span></label>
                <label className="tools-svc-toggle"><input type="checkbox" checked={svcForm.isRenewalBased} onChange={e => setSvcForm(f => ({ ...f, isRenewalBased: e.target.checked }))} /><span>Basado en renovación</span></label>
                <label className="tools-svc-toggle"><input type="checkbox" checked={svcForm.active !== false} onChange={e => setSvcForm(f => ({ ...f, active: e.target.checked }))} /><span>Activo</span></label>
              </div>

              {/* Aliases */}
              <div className="tools-svc-field">
                <label>Aliases de nombre (separados por coma)</label>
                <input type="text" className="edit-modal-input" value={svcAliasInput} onChange={e => setSvcAliasInput(e.target.value)} placeholder="ChatGPT Plus, ChatGPT, GPT" />
                <span className="tools-svc-hint">Nombres alternativos para detectar en correos de Lank</span>
              </div>

              {/* Campos de cupo (slotFields) */}
              <div className="tools-svc-fields-section">
                <div className="tools-svc-fields-header">
                  <label>Campos de cupo (cuentas reales)</label>
                  <button className="tools-btn tools-btn-secondary" onClick={() => addDynField(setSvcSlotFields)} style={{ padding: '4px 10px', fontSize: '12px' }}><PlusIcon size={12} /> Campo</button>
                </div>
                {svcSlotFields.map((f, idx) => (
                  <div key={idx} className="tools-svc-dyn-field">
                    <input type="text" className="edit-modal-input" placeholder="key" value={f.key} onChange={e => updateDynField(setSvcSlotFields, idx, 'key', e.target.value)} style={{ flex: 1 }} />
                    <input type="text" className="edit-modal-input" placeholder="Label" value={f.label} onChange={e => updateDynField(setSvcSlotFields, idx, 'label', e.target.value)} style={{ flex: 2 }} />
                    <input type="text" className="edit-modal-input" placeholder="Placeholder" value={f.placeholder || ''} onChange={e => updateDynField(setSvcSlotFields, idx, 'placeholder', e.target.value)} style={{ flex: 2 }} />
                    <label className="tools-svc-toggle" style={{ minWidth: 'auto' }}><input type="checkbox" checked={f.required || false} onChange={e => updateDynField(setSvcSlotFields, idx, 'required', e.target.checked)} /><span style={{ fontSize: '11px' }}>Req</span></label>
                    <button className="crud-icon-btn danger" onClick={() => removeDynField(setSvcSlotFields, idx)} title="Eliminar"><TrashIcon size={12} /></button>
                  </div>
                ))}
              </div>

              {/* Campos de usuario (userFields) */}
              <div className="tools-svc-fields-section">
                <div className="tools-svc-fields-header">
                  <label>Campos de usuario (grupos Lank)</label>
                  <button className="tools-btn tools-btn-secondary" onClick={() => addDynField(setSvcUserFields)} style={{ padding: '4px 10px', fontSize: '12px' }}><PlusIcon size={12} /> Campo</button>
                </div>
                {svcUserFields.map((f, idx) => (
                  <div key={idx} className="tools-svc-dyn-field">
                    <input type="text" className="edit-modal-input" placeholder="key" value={f.key} onChange={e => updateDynField(setSvcUserFields, idx, 'key', e.target.value)} style={{ flex: 1 }} />
                    <input type="text" className="edit-modal-input" placeholder="Label" value={f.label} onChange={e => updateDynField(setSvcUserFields, idx, 'label', e.target.value)} style={{ flex: 2 }} />
                    <input type="text" className="edit-modal-input" placeholder="Placeholder" value={f.placeholder || ''} onChange={e => updateDynField(setSvcUserFields, idx, 'placeholder', e.target.value)} style={{ flex: 2 }} />
                    <select className="edit-modal-input" value={f.type || 'text'} onChange={e => updateDynField(setSvcUserFields, idx, 'type', e.target.value === 'text' ? undefined : e.target.value)} style={{ flex: 1 }}>
                      <option value="text">Texto</option>
                      <option value="email">Email</option>
                      <option value="select-day">Día mes</option>
                    </select>
                    <label className="tools-svc-toggle" style={{ minWidth: 'auto' }}><input type="checkbox" checked={f.required || false} onChange={e => updateDynField(setSvcUserFields, idx, 'required', e.target.checked)} /><span style={{ fontSize: '11px' }}>Req</span></label>
                    <button className="crud-icon-btn danger" onClick={() => removeDynField(setSvcUserFields, idx)} title="Eliminar"><TrashIcon size={12} /></button>
                  </div>
                ))}
              </div>

              {/* Vista previa */}
              {svcForm.name && (
                <div className="tools-svc-preview">
                  <span className="tools-svc-preview-label">Vista previa:</span>
                  <div className="tools-svc-preview-card" style={{ borderLeftColor: svcForm.color }}>
                    {svcForm.logo && <img src={svcForm.logo} alt="" style={{ width: '24px', height: '24px', borderRadius: '4px' }} onError={e => { e.target.style.display = 'none'; }} />}
                    <span style={{ fontWeight: 600 }}>{svcForm.name}</span>
                    <span className={`tools-svc-badge ${svcForm.active !== false ? 'tools-svc-badge-active' : 'tools-svc-badge-inactive'}`}>{svcForm.active !== false ? 'Activo' : 'Inactivo'}</span>
                    <span className="tools-svc-badge tools-svc-badge-type">{svcForm.usesPool ? 'Pool' : 'Grupo'}</span>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid var(--border-color)' }}>
              <button className="tools-btn tools-btn-secondary" onClick={() => setSvcModal(null)}>Cancelar</button>
              <button className="tools-btn tools-btn-primary" onClick={handleSvcSave} disabled={svcSaving}>
                {svcSaving ? 'Guardando...' : <><SaveIcon size={14} /> {svcModal.mode === 'create' ? 'Crear servicio' : 'Guardar cambios'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <Toast {...toast} onClose={() => setToast(prev => ({ ...prev, visible: false }))} />
 </>
 );
}
