import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useDocument } from '../hooks/useFirestore';
import { getServiceMeta, getProfileImage, getSlotFields, getExpectedSlotFields, getUserFields } from '../config/services';
import {
  updateSlot, updateGroupUser, removeGroupUser, moveUserBetweenAccounts,
  DEFAULT_MASTER_CONFIG, initSubscriptionMasterConfig,
  addSlotToRealAccount, removeSlotFromRealAccount,
  updateGroupEnabledSlots, createManualAlert, completeAlert,
} from '../hooks/firestoreActions';
import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import { ModalActions, ModalShell } from '../components/Modal';
import { BlockIcon, CalendarIcon, CashIcon, ClockIcon, CreditCardIcon, DotGray, DotGreen, EditIcon, EmailIcon, FolderIcon, KeyIcon, LinkIcon, LockKeyIcon, PlusIcon, PointUpIcon, RefreshIcon, SaveIcon, ToggleOnIcon, ToggleOffIcon, TrashIcon, UserIcon, WarningIcon } from '../components/Icons';
import { normalizeSearch, nMatch } from '../utils/normalize';
import {
  buildAssignableLankAccountsForSlot,
  getGroupUserAccessState,
  getGroupUserAlias,
  isGroupUserAssignedToRealAccount,
} from '../utils/subscriptionAssignments';
import SearchBar from '../components/SearchBar';
import EntityHistory from '../components/EntityHistory';

// Campos esperados y editables se derivan dinámicamente desde config/services
function getExpectedFieldsForService(svcId) {
 return getExpectedSlotFields(svcId);
}

function getEditableFieldsForService(svcId) {
 return getSlotFields(svcId);
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

export default function Subscriptions({ onNavigate, navData }) {
 const { data: masterConfigDoc, loading: masterConfigLoading } = useDocument('config', 'services');
 const [poolDetails, setPoolDetails] = useState({});
 const [groupDetails, setGroupDetails] = useState({});
 const [selectedService, setSelectedService] = useState(null);
 const [showStickyBar, setShowStickyBar] = useState(false);
 const [highlightRef, setHighlightRef] = useState(null);
 const [highlightUser, setHighlightUser] = useState(null);
 const [pendingUserAliases, setPendingUserAliases] = useState(new Set());
 const [slotAlerts, setSlotAlerts] = useState([]);
 const [searchQuery, setSearchQuery] = useState('');
 const [searchResults, setSearchResults] = useState(null);

 // Modal states para edición de slots
 const [editSlotModal, setEditSlotModal] = useState(null); // { serviceKey, accountRef, slotIndex, slot, allSlots }
 const [clearSlotConfirm, setClearSlotConfirm] = useState(null); // { serviceKey, accountRef, slotIndex, slot, allSlots }
 const [moveSlotModal, setMoveSlotModal] = useState(null); // { serviceKey, sourceAcct, slotIndex, slot }
 const [groupEditModal, setGroupEditModal] = useState(null); // { serviceKey, groupId, userIndex, user, allUsers, accountLabel, accountId }
 const [groupBajaConfirm, setGroupBajaConfirm] = useState(null); // { serviceKey, groupId, userIndex, userAlias, allUsers, accountLabel, accountId }
 const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
 const poolDetailsRequestIdRef = useRef(0);
 const groupDetailsRequestIdRef = useRef(0);
 const pendingAlertsRequestIdRef = useRef(0);

 // Confirm para eliminar cupo
 const [removeSlotConfirm, setRemoveSlotConfirm] = useState(null); // { serviceKey, accountRef, slotIndex, slot, allSlots, accountLabel }

 // Configuración maestra resuelta (Firestore > defaults)
 const masterConfig = useMemo(() => {
   if (masterConfigDoc) {
     const data = masterConfigDoc.services || masterConfigDoc;
     const services = Object.fromEntries(
       Object.entries(data).filter(([key]) => key !== 'id' && key !== 'updatedAt'),
     );
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

 const activeServiceIds = useMemo(() => {
   return Object.keys(masterConfig)
     .filter(key => masterConfig[key]?.active !== false)
     .sort((a, b) => {
       const aMeta = masterConfig[a] || getServiceMeta(a);
       const bMeta = masterConfig[b] || getServiceMeta(b);
       const aIsPool = aMeta.usesPool !== false;
       const bIsPool = bMeta.usesPool !== false;
       if (aIsPool && !bIsPool) return -1;
       if (!aIsPool && bIsPool) return 1;
       return (aMeta.displayOrder || 99) - (bMeta.displayOrder || 99);
     });
 }, [masterConfig]);

 const poolServiceIds = useMemo(
   () => activeServiceIds.filter(key => (masterConfig[key] || getServiceMeta(key)).usesPool !== false),
   [activeServiceIds, masterConfig],
 );

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
 } else {
      const serviceKey = navData.serviceKey || navData.service;
      const serviceAccountRef = navData.serviceAccountRef || navData.accountRef;
      if (serviceKey) setSelectedService(serviceKey);
      if (serviceAccountRef) setHighlightRef(serviceAccountRef);
      setHighlightUser(navData.userAlias || navData.highlightUser || null);
 }
 }, [navData]);

 const [pendingAlerts, setPendingAlerts] = useState([]);

 const loadPendingAlerts = useCallback(async () => {
   const requestId = ++pendingAlertsRequestIdRef.current;
   const snap = await getDocs(query(collection(db, 'alerts'), where('status', '==', 'pending')));
   const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
   const aliases = new Set();
   const slotRelatedAlerts = [];
   alerts.forEach((data) => {
     const alias = (data.userAlias || '').toLowerCase();
     if (alias) aliases.add(alias);
     if (data.type === 'slot_pending_deletion' || data.type === 'access_verify') {
       slotRelatedAlerts.push(data);
     }
   });
   if (requestId !== pendingAlertsRequestIdRef.current) return;
   setPendingAlerts(alerts);
   setPendingUserAliases(aliases);
   setSlotAlerts(slotRelatedAlerts);
 }, []);

 const pendingPasswordAlerts = useMemo(
   () => pendingAlerts.filter((a) => a.type === 'password_change'),
   [pendingAlerts],
 );

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
 const loadPoolDetails = useCallback(async () => {
   const requestId = ++poolDetailsRequestIdRef.current;
   if (poolServiceIds.length === 0) {
     if (requestId !== poolDetailsRequestIdRef.current) return;
     setPoolDetails({});
     return;
   }
   const entries = await Promise.all(poolServiceIds.map(async (svcId) => {
     const snap = await getDocs(collection(db, `service-pools/${svcId}/real-accounts`));
     return [svcId, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
   }));
   if (requestId !== poolDetailsRequestIdRef.current) return;
   setPoolDetails(Object.fromEntries(entries));
 }, [poolServiceIds]);

 const loadGroupDetails = useCallback(async () => {
   const requestId = ++groupDetailsRequestIdRef.current;
   const entries = await Promise.all(activeServiceIds.map(async (svc) => {
     const snap = await getDocs(collection(db, `groups/${svc}/lank-accounts`));
     return [svc, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
   }));
   if (requestId !== groupDetailsRequestIdRef.current) return;
   setGroupDetails(Object.fromEntries(entries));
 }, [activeServiceIds]);

 const refreshSubscriptionsData = useCallback(async () => {
   const results = await Promise.allSettled([loadPoolDetails(), loadGroupDetails(), loadPendingAlerts()]);
   if (results.some(result => result.status === 'rejected')) {
     showToast('Algunos datos no se pudieron recargar; puede que veas información desactualizada.', 'error');
   }
 }, [loadPoolDetails, loadGroupDetails, loadPendingAlerts, showToast]);

 useEffect(() => {
   loadPoolDetails().catch((err) => {
     console.error('Error cargando cuentas reales:', err);
   });
 }, [loadPoolDetails]);

 useEffect(() => {
   loadGroupDetails().catch((err) => {
     console.error('Error cargando grupos Lank:', err);
   });
 }, [loadGroupDetails]);

 useEffect(() => {
   loadPendingAlerts().catch((err) => {
     console.error('Error cargando alertas pendientes:', err);
   });
 }, [loadPendingAlerts]);

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

 const allServiceIds = activeServiceIds;

 // ─── Cuentas Lank disponibles para vincular al llenar cupo ───
 const fillLankAccounts = useMemo(() => {
 if (!editSlotModal || editSlotModal.slot.status !== 'free') return [];
 const svc = editSlotModal.serviceKey;
 return buildAssignableLankAccountsForSlot({
      groups: groupDetails[svc] || [],
      realAccounts: poolDetails[svc] || [],
 });
 }, [editSlotModal, groupDetails, poolDetails]);

 // Usuarios de la cuenta Lank seleccionada
 const fillLankUsers = useMemo(() => {
 if (!fillLankAccountId || !fillLankAccounts.length) return [];
 const acct = fillLankAccounts.find(a => String(a.accountId) === String(fillLankAccountId) || a.id === fillLankAccountId);
 if (!acct) return [];
 return acct.users || [];
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
        getGroupUserAlias(u).toLowerCase() === fillLankUserAlias.toLowerCase()
      );
      if (selectedUser) {
        vals.memberAlias = getGroupUserAlias(selectedUser);
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

 // Buscar también en grupos Lank de todos los servicios.
 // En servicios con pool esto es clave: puede haber usuarios dentro del grupo
 // que aún no tienen cuenta real asignada y, por tanto, no aparecen en slots.
 Object.entries(groupDetails).forEach(([svcId, groups]) => {
   (groups || []).forEach(group => {
      let groupMatches = false;
      if (nMatch(group.accountAlias, q)) groupMatches = true;
      if (nMatch(group.fullName, q)) groupMatches = true;
      if (String(group.accountId || '').includes(q)) groupMatches = true;
      (group.users || []).forEach((u, idx) => {
        const alias = getGroupUserAlias(u);
        const fields = [alias];
        if (typeof u === 'object' && u) {
          fields.push(
            u.userEmail,
            u.email,
            u.invitationEmail,
            u.phone,
            u.memberPhone,
            u.profileName,
            u.projectName,
            u.serviceAccountRef,
            u.serviceAccountLabel,
            u.serviceLabel,
          );
        }
        if (fields.some(f => nMatch(f, q))) {
          groupMatches = true;
          matchedSlots.add(`${svcId}:${group.id}:${idx}`);
        }
      });
      if (groupMatches) {
        if (!results[svcId]) results[svcId] = new Set();
        results[svcId].add(group.id);
      }
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
 }, [searchQuery, poolDetails, groupDetails, selectedService]);

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

 if (slot.status === 'free' && fillLankAccountId && fillLankUserAlias) {
      const selectedUser = fillLankUsers.find(u =>
        getGroupUserAlias(u).toLowerCase() === fillLankUserAlias.toLowerCase()
      );
      if (!selectedUser || isGroupUserAssignedToRealAccount(selectedUser) || existingSlotInfo) {
        showToast('Ese usuario ya tiene un cupo real asignado. Usa "Mover usuario entre cuentas" para cambiarlo de cuenta real.', 'error');
        return;
      }
 }

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

 // Sincronizar datos al grupo Lank
 if (fillLankAccountId && fillLankUserAlias) {
      // Caso: llenando cupo libre desde un usuario Lank
      try {
        const lankAcct = fillLankAccounts.find(a => a.id === fillLankAccountId);
        if (lankAcct) {
          const users = lankAcct.users || [];
          const userIdx = users.findIndex(u => {
            const alias = getGroupUserAlias(u);
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
            const alias = getGroupUserAlias(u);
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
 await refreshSubscriptionsData();
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
 const { serviceKey, accountRef, slotIndex, allSlots } = clearSlotConfirm;
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
            const alias = getGroupUserAlias(u);
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
         reason: `Cupo #${oldSlot.slotNumber || slotIndex + 1} liberado manualmente`,
         slotNumber: oldSlot.slotNumber || slotIndex + 1,
       });

       void otherUsers;
     } catch (err) {
       console.error('Error generando alertas de cambio de contraseña al liberar cupo:', err);
     }
   }
 }

 showToast(`Cupo #${slotIndex + 1} liberado de ${clearSlotConfirm.accountLabel}`);
 await refreshSubscriptionsData();
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
      await refreshSubscriptionsData();
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
 await refreshSubscriptionsData();
 };

 const handleGroupBajaConfirm = async () => {
 if (!groupBajaConfirm) return;
 const { serviceKey, accountId, userAlias, allUsers } = groupBajaConfirm;
 await removeGroupUser(serviceKey, accountId, userAlias, allUsers, 'Baja manual desde Suscripciones');
 const svcName = getServiceMeta(serviceKey).name;
 showToast(`${userAlias} dado de baja de ${svcName} en ${groupBajaConfirm.accountLabel}`);
 await refreshSubscriptionsData();
 setGroupBajaConfirm(null);
 };

 const selectedMeta = selectedService ? getServiceMeta(selectedService) : null;

 // ─── HANDLERS: Añadir / Eliminar cupos individuales en cuentas reales ───

 const handleAddSlot = async (serviceKey, acct) => {
   try {
     await addSlotToRealAccount(serviceKey, acct.id, acct.slots || []);
     showToast(`Cupo #${(acct.slots || []).length + 1} agregado a ${acct.label || acct.id}`);
     await refreshSubscriptionsData();
   } catch (err) {
     showToast(err.message, 'error');
   }
 };

 const handleRemoveSlot = (serviceKey, acct, slotIndex) => {
   const slot = acct.slots[slotIndex];
   setRemoveSlotConfirm({
     serviceKey,
     accountRef: acct.id,
     slotIndex,
     slot,
     allSlots: acct.slots,
     accountLabel: acct.label || acct.serviceAccountRef || acct.id,
   });
 };

 const handleRemoveSlotConfirm = async () => {
   if (!removeSlotConfirm) return;
   const { serviceKey, accountRef, slotIndex, allSlots } = removeSlotConfirm;
   try {
     await removeSlotFromRealAccount(serviceKey, accountRef, slotIndex, allSlots);
     showToast(`Cupo eliminado de ${removeSlotConfirm.accountLabel}`);
     await refreshSubscriptionsData();
   } catch (err) {
     showToast(err.message, 'error');
   }
   setRemoveSlotConfirm(null);
 };

 const handleToggleGroupSlot = async (serviceKey, group, idx) => {
   try {
     const disabledSlots = group.disabledSlots || [];
     const enabled = !disabledSlots.includes(idx);
     await updateGroupEnabledSlots(serviceKey, group.id, idx, !enabled, group.users || [], disabledSlots);
     showToast(`${enabled ? 'Cupo deshabilitado' : 'Cupo habilitado'} en grupo #${group.accountId}`);
     await refreshSubscriptionsData();
   } catch (err) {
     showToast(err.message, 'error');
   }
 };

 // ─── HELPERS Y HANDLERS PARA ALERTAS DE SLOT ───

 const getSlotAlert = useCallback((serviceAccountRef, slotNumber, memberAlias, type) => {
   return slotAlerts.find(a =>
     a.serviceAccountRef === serviceAccountRef &&
     a.type === type &&
     (a.slotNumber === slotNumber ||
       (a.userAlias || '').toLowerCase() === (memberAlias || '').toLowerCase())
   );
 }, [slotAlerts]);

 const handleConfirmSlotDeletion = async (alert, serviceKey, accountRef, slotIndex, allSlots) => {
   try {
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
     await completeAlert(alert.id, { resolvedVia: 'subscriptions' });

     // Fix HIGH #2: Also complete any orphaned access_verify alerts for this user+account
     const orphanedVerifyAlerts = slotAlerts.filter(a =>
       a.type === 'access_verify' &&
       a.serviceAccountRef === accountRef &&
       (a.userAlias || '').toLowerCase() === (oldSlot.memberAlias || '').toLowerCase() &&
       a.id !== alert.id
     );
     for (const orphan of orphanedVerifyAlerts) {
       await completeAlert(orphan.id, { resolvedVia: 'subscriptions', cancelReason: 'user_deleted' });
     }

      showToast(`Eliminación de ${oldSlot.memberAlias} confirmada`);
      await refreshSubscriptionsData();
   } catch (err) {
     showToast(`Error confirmando eliminación: ${err.message}`, 'error');
   }
 };

 const handleVerifyAccess = async (alert) => {
   try {
     await completeAlert(alert.id, { resolvedVia: 'subscriptions' });
      showToast(`Acceso verificado para ${alert.userAlias}`);
      await refreshSubscriptionsData();
   } catch (err) {
     showToast(`Error verificando acceso: ${err.message}`, 'error');
   }
 };

 const renderLankGroupDetails = (serviceKey, { attachRef = false } = {}) => {
   const groups = groupDetails[serviceKey] || [];
   const m = getServiceMeta(serviceKey);
   const isPoolService = m.usesPool !== false;
   const realAccounts = poolDetails[serviceKey] || [];
   const filteredGroups = groups
     .filter(g => g.groupStatus === 'active')
     .filter(g => {
       if (!searchResults || !searchQuery) return true;
       const svcMatches = searchResults.matches[serviceKey];
       return svcMatches && svcMatches.has(g.id);
     })
     .sort((a, b) => (a.accountId || 0) - (b.accountId || 0));

   return (
     <div ref={attachRef ? detailRef : undefined} style={{ marginTop: isPoolService ? '20px' : '12px' }}>
       <div className="section-header">
         <div className="section-title" style={{ gap: '10px' }}>
           <img src={m.logo} className="svc-logo-sm" alt="" />
           {isPoolService ? `${m.name} — Grupos Lank y usuarios` : `${m.name} — Grupos de cuentas Lank`}
         </div>
         <span className="badge badge-info">
           {filteredGroups.length} grupo{filteredGroups.length !== 1 ? 's' : ''}
         </span>
       </div>

       {filteredGroups.length === 0 && (
         <div className="empty-state" style={{ marginTop: '12px' }}>
           <p>No se encontraron grupos Lank activos para este servicio</p>
         </div>
       )}

       {filteredGroups.map(group => {
         const users = group.users || [];
         const disabledSlots = group.disabledSlots || [];
         const maxSlots = Math.max(getMaxSlots(serviceKey, 'lankGroup'), users.length);
         const svcUserFields = getUserFields(serviceKey);

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
                     <span>{group.fullName}</span>
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
                   const userAlias = getGroupUserAlias(user) || null;
                   const isOccupied = !!userAlias;
                   const accessState = isPoolService && isOccupied
                     ? getGroupUserAccessState({ user, group, realAccounts })
                     : null;
                   const accessBadgeClass = accessState?.state === 'assigned' ? 'badge-success' : 'badge-warning';
                   const isSearchMatch = searchResults && searchResults.slots.has(`${serviceKey}:${group.id}:${idx}`);

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
                       className={`slot-item ${isOccupied ? 'occupied' : 'free'} ${slotDisabled ? 'disabled' : ''} ${isSearchMatch ? 'search-match-slot' : ''}`}
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
                         {isPoolService && accessState && (
                           <div className="slot-from">
                             <span className={`badge ${accessBadgeClass}`} style={{ fontSize: '10px' }}>
                               {accessState.state === 'assigned' ? 'Cuenta real' : 'Pendiente'}
                             </span>
                             {' '}{accessState.label}
                             {accessState.match && (
                               <button
                                 className="crud-icon-btn"
                                 style={{ marginLeft: '6px' }}
                                 onClick={() => setHighlightRef(accessState.match.accountId)}
                                 title="Resaltar cuenta real"
                               >
                                 <LinkIcon size={12} />
                               </button>
                             )}
                           </div>
                         )}
                         {!isPoolService && isOccupied && (
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
                               serviceKey,
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
                               onClick={() => handleToggleGroupSlot(serviceKey, group, idx)}
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
                                   serviceKey,
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
   );
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
 const slotNum = slot.slotNumber || idx + 1;
 const deletionAlert = isOccupied ? getSlotAlert(acct.id, slotNum, slot.memberAlias, 'slot_pending_deletion') : null;
 const verifyAlert = isOccupied ? getSlotAlert(acct.id, slotNum, slot.memberAlias, 'access_verify') : null;
 const hasPendingAction = slot.memberAlias &&
      pendingUserAliases.has(slot.memberAlias.toLowerCase());
 const isSearchMatch = searchResults && searchResults.slots.has(`${serviceKey}:${acct.id}:${idx}`);
 const primaryLabel = isEmpty ? 'Llenar' : 'Editar';

 let slotColorClass = '';
 if (deletionAlert) slotColorClass = 'slot-pending-deletion';
 else if (verifyAlert) slotColorClass = 'slot-access-verify';
 else if (hasPendingAction) slotColorClass = 'pending-action-slot';

 return (
      <div
        key={idx}
        className={`slot-item ${isOccupied ? 'occupied' : ''} ${isEmpty ? 'free' : ''} ${isDisabled ? 'disabled' : ''} ${hasLink ? 'clickable' : ''} ${isUserHighlighted ? 'highlight-user-pulse' : ''} ${slotColorClass} ${isSearchMatch ? 'search-match-slot' : ''}`}
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
          <div className="slot-number">Cupo #{slotNum}</div>
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
          {deletionAlert && (
            <div className="slot-alert-reason red">
              <WarningIcon size={14} /> {deletionAlert.reason || 'Eliminacion pendiente'}
            </div>
          )}
          {!deletionAlert && verifyAlert && (
            <div className="slot-alert-reason blue">
              <KeyIcon size={14} /> {verifyAlert.reason || 'Verificar acceso tras cambio de contrasena'}
            </div>
          )}
          {deletionAlert && (
            <div className="slot-alert-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="slot-action-btn red"
                onClick={() => handleConfirmSlotDeletion(deletionAlert, serviceKey, acct.id, idx, acct.slots)}
              >
                <TrashIcon size={14} /> Confirmar eliminacion
              </button>
            </div>
          )}
          {!deletionAlert && verifyAlert && (
            <div className="slot-alert-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="slot-action-btn blue"
                onClick={() => handleVerifyAccess(verifyAlert)}
              >
                <KeyIcon size={14} /> Verificar acceso
              </button>
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
                className="alert-action-btn danger"
                onClick={(e) => { e.stopPropagation(); handleRemoveSlot(serviceKey, acct, idx); }}
                title="Eliminar este cupo"
              >
                <TrashIcon size={16} /> Eliminar cupo
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
      </div>


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
              onClick={() => {
                const newSvc = isActive ? null : svcId;
                setSelectedService(newSvc);
                setHighlightRef(null);
                if (newSvc) setTimeout(() => { if (detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
              }}
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
                          onClick={() => onNavigate && onNavigate('vault', { serviceKey: selectedService, serviceAccountRef: acct.serviceAccountRef || acct.id, tab: 'credentials' })}
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
                        {acct.autoRenewEnabled === false && <span className="badge badge-warning" style={{ fontSize: '10px' }}>Sin renovación</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span className="badge badge-success"><DotGreen /> {active}</span>
                      <span className="badge badge-muted"><DotGray /> {free}</span>
                      <button className="alert-action-btn assign" onClick={(e) => { e.stopPropagation(); handleAddSlot(selectedService, acct); }} title="Añadir cupo"><PlusIcon size={14} /> Cupo</button>
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

      {/* ═══ DETALLE: Grupos Lank de servicios con pool ═══ */}
      {selectedService && getServiceMeta(selectedService).usesPool !== false && groupDetails[selectedService] && (
        renderLankGroupDetails(selectedService)
      )}

      {/* ═══ DETALLE: Servicios sin pool (grupos Lank) ═══ */}
      {selectedService && getServiceMeta(selectedService).usesPool === false && (
        renderLankGroupDetails(selectedService, { attachRef: true })
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
                  <span></span> Vincular a cuenta Lank <span className="fill-lank-optional">(solo usuarios sin cupo real)</span>
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
                          #{a.accountId} — {a.accountAlias || a.fullName} ({(a.users || []).length} disponible{(a.users || []).length !== 1 ? 's' : ''})
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
                          const alias = getGroupUserAlias(u);
                          return (
                            <option key={i} value={alias}>
                              {alias}
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
                            <RefreshIcon size={16} /> Para cambiarlo de cuenta real, usa <strong>Mover usuario entre cuentas</strong> desde su cupo actual.
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

            {editSlotModal.slot.status === 'free' && fillLankAccounts.length === 0 && (
              <div className="fill-lank-section">
                <div className="fill-lank-warning">
                  <span><WarningIcon size={16} /></span>
                  No hay usuarios de grupos activos disponibles para vincular. Los usuarios que ya tienen cuenta real asignada no aparecen aquí; para cambiarlos, usa <strong>Mover usuario entre cuentas</strong>.
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
              + (['credentials', 'profile_project'].includes(getServiceMeta(clearSlotConfirm.serviceKey).accessType)
                ? '\n\nSe creará una alerta para cambiar la contraseña desde Bóveda.'
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
        <ModalShell open onCancel={() => setMoveSlotModal(null)} title="Mover usuario entre cuentas" icon={<RefreshIcon size={16} />} className="edit-modal">
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
            <ModalActions onCancel={() => setMoveSlotModal(null)} />
        </ModalShell>
      )}

      <ConfirmDialog
        open={!!removeSlotConfirm}
        onClose={() => setRemoveSlotConfirm(null)}
        onConfirm={handleRemoveSlotConfirm}
        title="Eliminar cupo"
        message={removeSlotConfirm ? `¿Eliminar cupo #${(removeSlotConfirm.slot?.slotNumber || removeSlotConfirm.slotIndex + 1)} de ${removeSlotConfirm.accountLabel}? Esta acción no se puede deshacer.` : ''}
        confirmLabel="Eliminar"
        danger
      />

      {/* Toast */}
      <Toast {...toast} onClose={() => setToast(prev => ({ ...prev, visible: false }))} />
 </>
 );
}
