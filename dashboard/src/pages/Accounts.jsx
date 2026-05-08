import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useDocument } from '../hooks/useFirestore';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { getServiceMeta, getProfileImage, getUserFields } from '../config/services';
import { updateGroupUser, removeGroupUser, addGroupUser, createLankGroup, deleteLankGroup, DEFAULT_MASTER_CONFIG, updateGroupEnabledSlots, updateLankGroupStatus, updateSlot, createManualAlert, updateLankMasterAccount } from '../hooks/firestoreActions';
import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import { BlockIcon, CalendarIcon, CashIcon, ClipboardIcon, CloseIcon, EditIcon, EmailIcon, FolderIcon, LinkIcon, PhoneIcon, PlusIcon, SaveIcon, SearchIcon, ToggleOnIcon, ToggleOffIcon, TrashIcon, UserIcon, UsersIcon, WarningIcon } from '../components/Icons';
import { normalizeSearch, nMatch } from '../utils/normalize';
import SearchBar from '../components/SearchBar';
import EntityHistory from '../components/EntityHistory';

// Cashback se lee directamente del campo `cashback` del documento del grupo en Firestore.

// Campos editables por servicio — se derivan dinámicamente desde config
function getUserEditableFields(svcId) {
 return getUserFields(svcId);
}

export default function Accounts({ navData, onNavigate }) {
 // Support both legacy string (accountId) and rich object { accountId, serviceKey, userAlias }
 const highlightAccountId = typeof navData === 'string' ? navData : navData?.accountId || null;
 const highlightServiceKey = typeof navData === 'object' ? navData?.serviceKey : null;
 const highlightUserAlias = typeof navData === 'object' ? navData?.userAlias : null;

 const { data: masterConfigDoc } = useDocument('config', 'services');
 const [accounts, setAccounts] = useState([]);
 const [loading, setLoading] = useState(true);
 const [search, setSearch] = useState('');
 const [expandedId, setExpandedId] = useState(highlightAccountId || null);
 const [filterService, setFilterService] = useState(new Set()); // empty = all, else set of service keys
 const [groups, setGroups] = useState({});
 const [poolDetails, setPoolDetails] = useState({}); // Cuentas reales (service-pools) para sincronización
 const [pendingUserAliases, setPendingUserAliases] = useState(new Set());

 // Modal states
 const [editUserModal, setEditUserModal] = useState(null); // { svcId, acctId, userIndex, user, currentUsers }
 const [removeUserConfirm, setRemoveUserConfirm] = useState(null); // { svcId, acctId, userAlias, currentUsers }
 const [addUserModal, setAddUserModal] = useState(null); // { svcId, acctId, currentUsers, accountAlias }
 const [createGroupModal, setCreateGroupModal] = useState(null); // { acctId, accountAlias, fullName }
 const [deleteGroupConfirm, setDeleteGroupConfirm] = useState(null); // { svcId, acctId, serviceName, userCount }
 const [editAccountModal, setEditAccountModal] = useState(null); // { acctId, canonicalAlias, fullName, email, whatsapp }
 const [editAccountValues, setEditAccountValues] = useState({ canonicalAlias: '', fullName: '', email: '', whatsapp: '' });
 const [savingAccount] = useState(false);
 const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
 const accountsRequestIdRef = useRef(0);
 const groupsRequestIdRef = useRef(0);
 const poolDetailsRequestIdRef = useRef(0);
 const pendingUsersRequestIdRef = useRef(0);

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

 const getMaxSlots = useCallback((svcId) => {
   return masterConfig[svcId]?.maxSlotsPerLankGroup || getServiceMeta(svcId).maxSlots || 5;
 }, [masterConfig]);

 const activeServiceIds = useMemo(() => {
   return Object.keys(masterConfig)
     .filter(key => masterConfig[key]?.active !== false)
     .sort((a, b) => {
       const aMeta = masterConfig[a] || getServiceMeta(a);
       const bMeta = masterConfig[b] || getServiceMeta(b);
       return (aMeta.displayOrder || 99) - (bMeta.displayOrder || 99);
     });
 }, [masterConfig]);

 const poolServiceIds = useMemo(
   () => activeServiceIds.filter(key => (masterConfig[key] || getServiceMeta(key)).usesPool !== false),
   [activeServiceIds, masterConfig],
 );

 const showToast = useCallback((msg, type = 'success') => {
 setToast({ visible: true, message: msg, type });
 }, []);

 // ─── Data loading functions ───
 const loadAccounts = useCallback(async () => {
   const requestId = ++accountsRequestIdRef.current;
   const snap = await getDocs(collection(db, 'accounts'));
   if (requestId !== accountsRequestIdRef.current) return;
   setAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
   setLoading(false);
 }, []);

 const loadGroups = useCallback(async () => {
   const requestId = ++groupsRequestIdRef.current;
   const results = {};
   await Promise.all(activeServiceIds.map(async svc => {
     const snap = await getDocs(collection(db, `groups/${svc}/lank-accounts`));
     const docs = {};
     snap.docs.forEach(d => { docs[d.id] = d.data(); });
     results[svc] = docs;
   }));
   if (requestId !== groupsRequestIdRef.current) return;
   setGroups(results);
 }, [activeServiceIds]);

 const loadPoolDetails = useCallback(async () => {
   const requestId = ++poolDetailsRequestIdRef.current;
   const results = {};
   await Promise.all(poolServiceIds.map(async svc => {
     const snap = await getDocs(collection(db, `service-pools/${svc}/real-accounts`));
     results[svc] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
   }));
   if (requestId !== poolDetailsRequestIdRef.current) return;
   setPoolDetails(results);
 }, [poolServiceIds]);

 const loadPendingUsers = useCallback(async () => {
   const requestId = ++pendingUsersRequestIdRef.current;
   const snap = await getDocs(query(collection(db, 'alerts'), where('status', '==', 'pending')));
   const aliases = new Set();
   snap.docs.forEach(d => {
     const alias = (d.data().userAlias || '').toLowerCase();
     if (alias) aliases.add(alias);
   });
   if (requestId !== pendingUsersRequestIdRef.current) return;
   setPendingUserAliases(aliases);
 }, []);

 const refreshAccountsData = useCallback(async () => {
   setLoading(true);
   try {
     const results = await Promise.allSettled([loadAccounts(), loadGroups(), loadPoolDetails(), loadPendingUsers()]);
     if (results.some(result => result.status === 'rejected')) {
       showToast('Algunos datos no se pudieron recargar; puede que veas información desactualizada.', 'error');
     }
   } finally {
     setLoading(false);
   }
 }, [loadAccounts, loadGroups, loadPoolDetails, loadPendingUsers, showToast]);

 useEffect(() => {
   refreshAccountsData().catch((err) => {
     console.error('Error cargando cuentas Lank:', err);
   });
 }, [refreshAccountsData]);

 useEffect(() => {
 if (highlightAccountId) {
      setExpandedId(highlightAccountId);
      setTimeout(() => {
        const el = document.getElementById(`lank-card-${highlightAccountId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });

          // If we have a specific user to highlight, scroll to them after the card expands
          if (highlightUserAlias) {
            setTimeout(() => {
              const targetAttr = highlightServiceKey
                ? `${highlightServiceKey}-${highlightUserAlias.toLowerCase()}`
                : highlightUserAlias.toLowerCase();
              const userEl = el.querySelector(`[data-lank-user="${targetAttr}"]`);
              if (userEl) {
                userEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                userEl.classList.add('highlight-user-pulse');
                setTimeout(() => userEl.classList.remove('highlight-user-pulse'), 5000);
              }
            }, 500);
          } else {
            // No specific user — just pulse the card
            el.classList.add('highlight-pulse');
            setTimeout(() => el.classList.remove('highlight-pulse'), 4000);
          }
        }
      }, 200);
 }
 }, [highlightAccountId, highlightUserAlias, highlightServiceKey]);

 // IntersectionObserver para mostrar sticky-name solo cuando el header sale de la pantalla
 useEffect(() => {
   if (!expandedId) return;
   const headerEl = document.querySelector(`#lank-card-${expandedId} .lank-card-v2-header`);
   const stickyEl = document.querySelector(`#lank-card-${expandedId} .accordion-sticky-name`);
   if (!headerEl || !stickyEl) return;
   const observer = new IntersectionObserver(
     ([entry]) => {
       if (entry.isIntersecting) {
         stickyEl.classList.remove('visible');
       } else {
         stickyEl.classList.add('visible');
       }
     },
     { threshold: 0, rootMargin: '-60px 0px 0px 0px' }
   );
   observer.observe(headerEl);
   return () => observer.disconnect();
 }, [expandedId]);

 const getAcctId = (acct) => acct.id || acct.accountId;
 const getAlias = (acct) => acct.canonicalAlias || acct.alias || acct.fullName;
 const getEmail = (acct) => acct.lankGmailAddress || acct.email || '';
 const getPhone = (acct) => acct.whatsapp || acct.phone || '';

 const getActiveServices = (acctId) => {
 const services = [];
 Object.entries(groups).forEach(([svc, accts]) => {
      const data = accts[String(acctId)];
      if (data && data.groupStatus === 'active') {
        services.push({ id: svc, data });
      }
 });
 return services;
 };

 // Servicios disponibles para crear grupo nuevo (todo lo que no tiene grupo activo)
 const getAvailableServicesForCreate = (acctId) => {
 const activeSet = new Set(getActiveServices(acctId).map(s => s.id));
 return activeServiceIds
      .filter(id => !activeSet.has(id))
      .map(id => {
        const meta = getServiceMeta(id);
        return { id, name: meta.name, logo: meta.logo };
      });
 };

 const matchesDeepSearch = useCallback((acctId, q) => {
 for (const [, accts] of Object.entries(groups)) {
      const data = accts[String(acctId)];
      if (!data || !data.users) continue;
      for (const u of data.users) {
        if (typeof u === 'string') { if (nMatch(u, q)) return true; continue; }
        if (nMatch(u.userAlias, q)) return true;
        if (nMatch(u.userEmail || u.email || u.invitationEmail, q)) return true;
        if (nMatch(u.phone || u.memberPhone, q)) return true;
        if (nMatch(u.profileName, q)) return true;
        if (nMatch(u.projectName, q)) return true;
        if (nMatch(u.serviceAccountRef || u.serviceAccountLabel, q)) return true;
      }
 }
 return false;
 }, [groups]);

 const isUserMatch = (user, q) => {
 if (!user || !q) return false;
 if (typeof user === 'string') return nMatch(user, q);
 return (
      nMatch(user.userAlias, q) ||
      nMatch(user.userEmail || user.email || user.invitationEmail, q) ||
      nMatch(user.phone || user.memberPhone, q) ||
      nMatch(user.profileName, q) ||
      nMatch(user.projectName, q) ||
      nMatch(user.serviceAccountRef || user.serviceAccountLabel, q)
 );
 };

 const isAccountDirectMatch = useCallback((acct, q) => {
 if (!q) return false;
 const acctId = acct.id || acct.accountId;
 const alias = acct.canonicalAlias || acct.alias || acct.fullName;
 const email = acct.lankGmailAddress || acct.email || '';
 const phone = acct.whatsapp || acct.phone || '';
 return (
      nMatch(alias, q) ||
      nMatch(acct.fullName, q) ||
      String(acctId).includes(q) ||
      nMatch(email, q) ||
      nMatch(phone, q)
 );
 }, []);

 const filtered = useMemo(() => {
 let list = accounts;
 if (search) {
      const q = normalizeSearch(search);
      list = list.filter(a => isAccountDirectMatch(a, q) || matchesDeepSearch(getAcctId(a), q));
 }
 if (filterService.size > 0) {
      list = list.filter(a => {
        const acctId = getAcctId(a);
        return [...filterService].some(svcKey => {
          const svcGroups = groups[svcKey] || {};
          const data = svcGroups[String(acctId)];
          return data && data.groupStatus === 'active';
        });
      });
 }
 return list.sort((a, b) => (getAcctId(a) || 0) - (getAcctId(b) || 0));
 }, [accounts, search, filterService, groups, isAccountDirectMatch, matchesDeepSearch]);

 const searchQ = search ? normalizeSearch(search) : '';
 const shouldAutoExpand = (acctId, acct) => {
 if (!searchQ || searchQ.length < 2) return false;
 return !isAccountDirectMatch(acct, searchQ) && matchesDeepSearch(acctId, searchQ);
 };

 // Buscar el cupo vinculado de un usuario en las cuentas reales
 const findUserSlotInPool = useCallback((svcId, user) => {
   if (!user || typeof user === 'string') return null;
   const serviceAccountRef = user.serviceAccountRef;
   const alias = user.userAlias;
   if (!alias) return null;
   const accounts = poolDetails[svcId] || [];
   // Buscar primero por serviceAccountRef (vínculo directo)
   if (serviceAccountRef) {
     const acct = accounts.find(a => a.id === serviceAccountRef || a.serviceAccountRef === serviceAccountRef);
     if (acct) {
       const slotIdx = (acct.slots || []).findIndex(s =>
         s.memberAlias && s.memberAlias.toLowerCase() === alias.toLowerCase()
       );
       if (slotIdx !== -1) return { acct, slotIdx, slot: acct.slots[slotIdx] };
     }
   }
   // Fallback: buscar en todas las cuentas reales del servicio
   for (const acct of accounts) {
     const slotIdx = (acct.slots || []).findIndex(s =>
       s.memberAlias && s.memberAlias.toLowerCase() === alias.toLowerCase()
     );
     if (slotIdx !== -1) return { acct, slotIdx, slot: acct.slots[slotIdx] };
   }
   return null;
 }, [poolDetails]);

 const getUserContextInfo = (svcId, user) => {
 if (!user || typeof user === 'string') return null;
 const parts = [];
 if (user.phone || user.memberPhone) parts.push({ label: 'Teléfono', value: user.phone || user.memberPhone, icon: <PhoneIcon size={16} /> });
 if (user.userEmail) parts.push({ label: 'Correo', value: user.userEmail, icon: <EmailIcon size={16} /> });
 if (user.email && !user.userEmail) parts.push({ label: 'Correo', value: user.email, icon: <EmailIcon size={16} /> });
 if (user.invitationEmail && !user.userEmail && !user.email) parts.push({ label: 'Correo invitación', value: user.invitationEmail, icon: <EmailIcon size={16} /> });
 if (user.profileName) parts.push({ label: 'Perfil', value: user.profileName, icon: <UserIcon size={16} /> });
 // Proyecto: buscar primero en el grupo, luego en el cupo de la cuenta real
 const localProject = user.projectName && !Array.isArray(user.projectName) ? user.projectName : '';
 if (localProject) {
   parts.push({ label: 'Proyecto', value: localProject, icon: <FolderIcon size={16} /> });
 } else {
   // Buscar en el cupo vinculado de la cuenta real
   const poolMatch = findUserSlotInPool(svcId, user);
   if (poolMatch?.slot?.projectName) {
     parts.push({ label: 'Proyecto', value: poolMatch.slot.projectName, icon: <FolderIcon size={16} /> });
   }
 }
 if (user.serviceAccountRef) {
      const refLabel = user.serviceLabel || user.serviceAccountLabel || user.serviceAccountRef;
      parts.push({ label: 'Cuenta real', value: refLabel, icon: <LinkIcon size={16} /> });
 }
 if (user.serviceStatus) parts.push({ label: 'Estado', value: user.serviceStatus, icon: <ClipboardIcon size={16} /> });
 return parts.length > 0 ? parts : null;
 };

 const handleUserClick = (svcId, user) => {
 if (!onNavigate || !user.serviceAccountRef) return;
 onNavigate('subscriptions', {
      service: svcId,
      accountRef: user.serviceAccountRef,
      highlightUser: user.userAlias || null,
 });
 };

 // ─── ACCIONES DE EDICIÓN ───

 const handleEditUser = (svcId, acctId, userIndex, user, currentUsers) => {
 setEditUserModal({ svcId, acctId, userIndex, user, currentUsers });
 };

 const handleEditUserSave = async (values) => {
 if (!editUserModal) return;
 const { svcId, acctId, userIndex, user, currentUsers } = editUserModal;
 await updateGroupUser(svcId, acctId, userIndex, values, currentUsers);

 // Sincronizar cambios al cupo en la cuenta real (bidireccional)
 try {
   const updatedUser = { ...user, ...values };
   const poolMatch = findUserSlotInPool(svcId, updatedUser);
   if (poolMatch) {
     const syncSlot = {};
     // Sincronizar campos relevantes del grupo → cupo real
     if (values.projectName !== undefined) syncSlot.projectName = values.projectName;
     if (values.profileName !== undefined) syncSlot.profileName = values.profileName;
     if (values.userEmail !== undefined) syncSlot.memberEmail = values.userEmail;
     if (values.userAlias !== undefined) syncSlot.memberAlias = values.userAlias;
     if (Object.keys(syncSlot).length > 0) {
       await updateSlot(svcId, poolMatch.acct.id, poolMatch.slotIdx, syncSlot, poolMatch.acct.slots);
     }
   }
 } catch (err) {
   console.error('Error sincronizando datos al cupo real:', err);
 }

 showToast(`Usuario actualizado en cuenta #${acctId}`);
 await refreshAccountsData();
 };

 const handleRemoveUser = (svcId, acctId, userAlias, currentUsers) => {
 // Buscar si el usuario tiene cuenta real asignada
 const user = currentUsers.find(u => {
      const alias = typeof u === 'string' ? u : u?.userAlias;
      return alias === userAlias;
 });
 const hasRealAccount = typeof user === 'object' && user?.serviceAccountRef;
 setRemoveUserConfirm({ svcId, acctId, userAlias, currentUsers, hasRealAccount, serviceAccountRef: user?.serviceAccountRef });
 };

 const handleRemoveUserConfirm = async () => {
 if (!removeUserConfirm) return;
 const { svcId, acctId, userAlias, currentUsers, serviceAccountRef } = removeUserConfirm;
 try {
      await removeGroupUser(svcId, acctId, userAlias, currentUsers, 'Baja manual desde dashboard');

      // Si el usuario tenía cupo en una cuenta real, crear alerta para limpiar el acceso
      if (serviceAccountRef) {
        try {
          const svcMeta = getServiceMeta(svcId);
          const svcConfig = masterConfig[svcId];
          const accessType = svcConfig?.accessType || 'credentials';

          // Determinar tipo de alerta según el tipo de acceso
          let alertType, alertTitle, alertDesc;
          if (accessType === 'email_invitation') {
            alertType = 'revoke_invitation';
            alertTitle = `Revocar invitación de ${userAlias}`;
            alertDesc = `${userAlias} salió del grupo Lank de ${svcMeta.name} (cuenta #${acctId}). Revoca su invitación en la cuenta real ${serviceAccountRef} y libera el cupo.`;
          } else if (accessType === 'profile_project') {
            alertType = 'profile_delete';
            alertTitle = `Eliminar perfil/proyecto de ${userAlias}`;
            alertDesc = `${userAlias} salió del grupo Lank de ${svcMeta.name} (cuenta #${acctId}). Elimina su perfil o proyecto en la cuenta real ${serviceAccountRef} y libera el cupo.`;
          } else {
            // Credenciales compartidas — requiere cambio de contraseña
            alertType = 'password_change';
            alertTitle = `Cambiar contraseña — ${userAlias} salió`;
            alertDesc = `${userAlias} salió del grupo Lank de ${svcMeta.name} (cuenta #${acctId}). Cambia la contraseña de la cuenta real ${serviceAccountRef}, libera el cupo de ${userAlias}, y re-confirma el acceso de los demás usuarios.`;
          }

          await createManualAlert({
            title: alertTitle,
            description: alertDesc,
            type: alertType,
            priority: 'high',
            service: svcMeta.name,
            serviceAccountRef: serviceAccountRef,
            accountId: parseInt(acctId) || acctId,
            accountAlias: currentUsers.find(u => u?.userAlias === userAlias)?.userAlias || userAlias,
            userAlias: userAlias,
          });
        } catch (err) {
          console.error('Error creando alerta de baja:', err);
        }
      }

      showToast(`${userAlias} eliminado de la cuenta #${acctId}${serviceAccountRef ? '. Se creó una alerta para limpiar su acceso.' : ''}`);
      await refreshAccountsData();
 } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
 }
 setRemoveUserConfirm(null);
 };

 // ─── CRUD: Agregar usuario a grupo ───

 const handleAddUser = (svcId, acctId, currentUsers, accountAlias) => {
 setAddUserModal({ svcId, acctId, currentUsers, accountAlias });
 };

 const handleAddUserSave = async (values) => {
 if (!addUserModal) return;
 const { svcId, acctId, currentUsers } = addUserModal;
 await addGroupUser(svcId, acctId, values, currentUsers);
 showToast(`${values.userAlias} agregado al grupo ${getServiceMeta(svcId).name} de cuenta #${acctId}`);
 await refreshAccountsData();
 };

 // ─── CRUD: Crear grupo nuevo ───

 const handleCreateGroup = (acctId, accountAlias, fullName) => {
 setCreateGroupModal({ acctId, accountAlias, fullName });
 };

 const handleCreateGroupSave = async (values) => {
 if (!createGroupModal) return;
 const { acctId, accountAlias, fullName } = createGroupModal;
 if (!values.serviceKey) throw new Error('Debes seleccionar un servicio');
 await createLankGroup(values.serviceKey, String(acctId), {
      accountAlias: accountAlias || '',
      fullName: fullName || '',
      accountId: acctId,
      cashback: values.cashback === 'true',
 });
 showToast(`Grupo ${getServiceMeta(values.serviceKey).name} creado para cuenta #${acctId}`);
 await refreshAccountsData();
 };

 // ─── CRUD: Eliminar grupo ───

 const handleDeleteGroup = (svcId, acctId, userCount) => {
 const serviceName = getServiceMeta(svcId).name;
 setDeleteGroupConfirm({ svcId, acctId, serviceName, userCount });
 };

 const handleDeleteGroupConfirm = async () => {
 if (!deleteGroupConfirm) return;
 const { svcId, acctId, serviceName } = deleteGroupConfirm;
 try {
      await deleteLankGroup(svcId, String(acctId));
      showToast(`Grupo ${serviceName} eliminado de cuenta #${acctId}`);
      await refreshAccountsData();
 } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
 }
 setDeleteGroupConfirm(null);
 };

 // ─── CRUD: Editar cuenta Lank maestra ───


 const handleEditAccount = (acctId, acct) => {
   setEditAccountModal({ acctId });
   setEditAccountValues({
     canonicalAlias: getAlias(acct) || '',
     fullName: acct.fullName || '',
     email: getEmail(acct) || '',
     whatsapp: getPhone(acct) || '',
   });
 };

 const handleToggleGroupSlot = async (svcId, acctId, slotIndex, currentUsers, currentDisabledSlots = []) => {
   try {
     const enabled = !currentDisabledSlots.includes(slotIndex);
     await updateGroupEnabledSlots(svcId, String(acctId), slotIndex, !enabled, currentUsers, currentDisabledSlots);
     showToast(`${enabled ? 'Cupo deshabilitado' : 'Cupo habilitado'} en cuenta #${acctId}`);
     await refreshAccountsData();
   } catch (err) {
     showToast(`Error: ${err.message}`, 'error');
   }
 };

 if (loading) return <div className="empty-state"><div className="loading-spinner" /></div>;

 return (
 <>
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="section-title"><UsersIcon size={16} /> Cuentas Lank ({filtered.length})</div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Crear / eliminar desde Bóveda → Cuentas de Correo</span>
      </div>

      {/* Buscador y filtros */}
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Buscar por nombre, alias, usuario, teléfono, email, proyecto..."
        resultCount={search && search.length >= 2 ? filtered.length : undefined}
      />
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap' }}>
          <button
            className={`alert-tab ${filterService.size === 0 ? 'active' : ''}`}
            onClick={() => setFilterService(new Set())}
          >
            Todos
          </button>
          {activeServiceIds.map((id) => {
            const meta = getServiceMeta(id);
            const isActive = filterService.has(id);
            return (
              <button
                key={id}
                className={`alert-tab ${isActive ? 'active-tint' : ''}`}
                onClick={() => {
                  setFilterService(prev => {
                    const next = new Set(prev);
                    if (next.has(id)) {
                      next.delete(id);
                    } else {
                      next.add(id);
                    }
                    return next;
                  });
                }}
                style={isActive ? { '--tint-color': meta.color } : {}}
              >
                <img src={meta.logo} alt="" className="filter-btn-logo" />
                {' '}{meta.name}
              </button>
            );
          })}
        </div>

      {/* Lista de cuentas */}
      <div className="lank-cards-list">
        {filtered.map(acct => {
          const acctId = getAcctId(acct);
          const alias = getAlias(acct);
          const email = getEmail(acct);
          const phone = getPhone(acct);
          const autoExpand = shouldAutoExpand(acctId, acct);
          const isExpanded = expandedId == acctId || autoExpand;
          const activeServices = getActiveServices(acctId);
          // When filtering by service, only show matching groups inside each card
          const visibleServices = filterService.size > 0
            ? activeServices.filter(svc => filterService.has(svc.id))
            : activeServices;
          const totalUsers = visibleServices.reduce((s, svc) => {
            const users = svc.data.users || [];
            return s + (Array.isArray(users) ? users.length : 0);
          }, 0);
          const isHighlighted = highlightAccountId == acctId;
          const hasSearchMatch = searchQ && searchQ.length >= 2 && matchesDeepSearch(acctId, searchQ) && !isAccountDirectMatch(acct, searchQ);

          return (
            <div
              id={`lank-card-${acctId}`}
              className={`lank-card-v2 ${isExpanded ? 'expanded' : ''} ${hasSearchMatch ? 'search-deep-match' : ''}`}
              key={acct.firestoreId || acctId}
              style={isHighlighted ? { borderColor: 'var(--accent-primary)', boxShadow: 'var(--shadow-glow)' } : {}}
            >
              {/* Header clickeable */}
              <div className="lank-card-v2-header" onClick={() => {
                const newId = isExpanded ? null : acctId;
                setExpandedId(newId);
                if (newId != null) {
                  setTimeout(() => {
                    const el = document.getElementById(`lank-card-${newId}`);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 150);
                }
              }}>
                <span className="lank-card-id-left">#{acctId}</span>
                <div className="lank-card-v2-identity">
                  <img
                    src={getProfileImage(acctId)}
                    className="lank-avatar-lg"
                    alt={alias}
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                  <div className="lank-card-v2-info">
                    <div className="lank-card-v2-name">{alias}</div>
                    {email && <div className="lank-card-v2-email"><EmailIcon size={16} /> {email}</div>}
                  </div>
                </div>
                <div className="lank-card-v2-meta">
                  {!isExpanded && visibleServices.length > 0 && (
                    <div className="lank-card-v2-services">
                      {visibleServices.map(svc => (
                        <img
                          key={svc.id}
                          src={getServiceMeta(svc.id).logo}
                          title={getServiceMeta(svc.id).name}
                          className="lank-svc-icon"
                          alt=""
                        />
                      ))}
                      <span className="badge badge-info">{visibleServices.length} svc</span>
                      {totalUsers > 0 && <span className="badge badge-success">{totalUsers} usr</span>}
                    </div>
                  )}
                  {!isExpanded && visibleServices.length === 0 && (
                    <span className="badge badge-muted">Sin suscripciones</span>
                  )}
                </div>
              </div>

              {/* Acordeón expandido */}
              {isExpanded && (
                <div className="accordion-content" onClick={e => e.stopPropagation()}>
                  {/* Sticky banner con nombre de la cuenta (visible al hacer scroll) */}
                  <div className="accordion-sticky-name">
                    <img
                      src={getProfileImage(acctId)}
                      className="accordion-sticky-avatar"
                      alt=""
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                    <span>#{acctId} — {alias}</span>
                    <button
                      className="accordion-sticky-close"
                      onClick={() => setExpandedId(null)}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </div>
                  <div className="accordion-expanded-info">
                    {acct.fullName && alias !== acct.fullName && (
                      <span><UserIcon size={16} /> {acct.fullName}</span>
                    )}
                    {phone && <span><PhoneIcon size={16} /> {phone}</span>}
                    <button
                      className="alert-action-btn edit"
                      style={{ marginLeft: 'auto', fontSize: '12px', padding: '4px 10px' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditAccount(acctId, acct);
                      }}
                      title="Editar datos de esta cuenta Lank"
                    >
                      <EditIcon size={14} /> Editar cuenta
                    </button>
                  </div>

                  {visibleServices.length > 0 ? (
                    visibleServices.map(svc => {
                      const meta = getServiceMeta(svc.id);
                      const rawUsers = svc.data.users || [];
                      const users = rawUsers.map(u => typeof u === 'string' ? { userAlias: u } : u);
                      const configuredMax = getMaxSlots(svc.id) || users.length;
                      // Never truncate existing users — show at least as many slots as users exist
                      const maxSlots = Math.max(configuredMax, users.length);
                      const cashback = !!svc.data.cashback;
                      const disabledSlots = svc.data.disabledSlots || [];

                      const slots = [];
                      for (let i = 0; i < maxSlots; i++) {
                        const disabled = disabledSlots.includes(i);
                        if (i < users.length) {
                          slots.push({ occupied: true, user: users[i], index: i, disabled });
                        } else {
                          slots.push({ occupied: false, user: null, index: i, disabled });
                        }
                      }

                      return (
                        <div className="accordion-service" key={svc.id}>
                          <div className="accordion-service-header">
                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <img src={meta.logo} className="accordion-svc-logo" alt="" />
                              <span>{meta.name}</span>
                              {cashback && (
                                <span className="badge badge-cashback"> Cashback</span>
                              )}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                {users.length}/{maxSlots} cupos
                              </span>
                              <button
                                className={`crud-icon-btn ${cashback ? 'success' : ''}`}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    await updateLankGroupStatus(svc.id, String(acctId), { cashback: !cashback });
                                    showToast(`Cashback ${!cashback ? 'activado' : 'desactivado'} para ${meta.name} cuenta #${acctId}`);
                                    await refreshAccountsData();
                                  } catch (err) {
                                    showToast(`Error: ${err.message}`, 'error');
                                  }
                                }}
                                title={cashback ? 'Desactivar cashback' : 'Activar cashback'}
                              >
                                <CashIcon size={14} />
                              </button>
                              <button
                                className="crud-icon-btn danger"
                                onClick={() => handleDeleteGroup(svc.id, acctId, users.length)}
                                title="Eliminar grupo"
                              >
                                <TrashIcon size={14} />
                              </button>
                            </span>
                          </div>
                          <div className="accordion-service-users">
                            {slots.map((slot, si) => {
                              if (slot.occupied) {
                                const user = slot.user;
                                const contextInfo = getUserContextInfo(svc.id, user);
                                const hasRef = !!user.serviceAccountRef;
                                const hasPendingAction = user.userAlias &&
                                  pendingUserAliases.has(user.userAlias.toLowerCase());
                                const isSearchHit = searchQ && searchQ.length >= 2 && isUserMatch(user, searchQ);
                                return (
                                  <div
                                    className={`accordion-slot occupied ${slot.disabled ? 'disabled' : ''} ${hasRef ? 'clickable-user' : ''} ${hasPendingAction ? 'pending-action-slot' : ''} ${isSearchHit ? 'search-match-slot' : ''}`}
                                    key={si}
                                    data-lank-user={user.userAlias ? `${svc.id}-${user.userAlias.toLowerCase()}` : ''}
                                    title={hasRef ? `Clic para ir a la cuenta real ${user.serviceAccountRef}` : ''}
                                    onClick={() => hasRef && !slot.disabled && handleUserClick(svc.id, user)}
                                    style={hasRef && !slot.disabled ? { cursor: 'pointer' } : {}}
                                  >
                                    <span className="accordion-slot-number">Cupo {si + 1}</span>
                                    <div className="accordion-slot-info">
                                      <div className="accordion-user-main">
                                        <span className="accordion-slot-alias">{user.userAlias}</span>
                                        {user.matchStatus && (
                                          <span className={`badge ${user.matchStatus === 'ok' ? 'badge-success' : 'badge-warning'}`} style={{ fontSize: '11px' }}>
                                            {user.matchStatus}
                                          </span>
                                        )}
                                      </div>
                                      {contextInfo && (
                                        <div className="accordion-user-context">
                                          {contextInfo.map((info, ci) => (
                                            <span key={ci} className="context-tag">
                                              {info.icon} {info.value}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                      {hasRef && (
                                        <span className="goto-real-hint">
                                          → {user.serviceAccountRef}
                                        </span>
                                      )}

                                      <div className="alert-actions slot-actions-compact" style={{ marginTop: '6px' }}>
                                        <button
                                          className="alert-action-btn edit"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleEditUser(svc.id, acctId, si, user, rawUsers);
                                          }}
                                          title="Editar información del usuario"
                                          disabled={slot.disabled}
                                        >
                                          <EditIcon size={16} /> Editar
                                        </button>
                                        <div className="slot-secondary-actions" onClick={(e) => e.stopPropagation()}>
                                          <button
                                            className="crud-icon-btn danger"
                                            onClick={() => handleRemoveUser(svc.id, acctId, user.userAlias, rawUsers)}
                                            title="Dar de baja a este usuario"
                                            disabled={slot.disabled}
                                          >
                                            <BlockIcon size={14} />
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              } else {
                                return (
                                  <div className={`accordion-slot empty ${slot.disabled ? 'disabled' : ''}`} key={si}>
                                    <span className="accordion-slot-number">Cupo {si + 1}</span>
                                    <div className="accordion-slot-info" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                                      <span className="accordion-slot-empty">{slot.disabled ? '— Deshabilitado —' : '— Libre —'}</span>
                                      <div className="alert-actions slot-actions-compact" style={{ marginTop: 0 }}>
                                        <button
                                          className="alert-action-btn edit"
                                          onClick={() => handleAddUser(svc.id, acctId, rawUsers, alias)}
                                          title="Agregar usuario a este cupo"
                                          disabled={slot.disabled}
                                        >
                                          <PlusIcon size={14} /> Agregar
                                        </button>
                                        <button
                                          className="alert-action-btn assign"
                                          onClick={() => handleToggleGroupSlot(svc.id, acctId, si, rawUsers, disabledSlots)}
                                          title={slot.disabled ? 'Habilitar este cupo' : 'Deshabilitar este cupo'}
                                        >
                                          {slot.disabled ? <ToggleOffIcon size={14} /> : <ToggleOnIcon size={14} />} {slot.disabled ? 'Habilitar' : 'Deshabilitar'}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              }
                            })}
                          </div>
                          <EntityHistory history={svc.data.userHistory} label="Historial" searchKey={`${alias} ${svc.id}`} onNavigate={onNavigate} />
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '14px', color: 'var(--text-muted)', padding: '12px' }}>
                      Esta cuenta no tiene suscripciones
                    </div>
                  )}

                  {/* Botón agregar suscripción — solo cuando no hay filtro activo */}
                  {filterService.size === 0 && getAvailableServicesForCreate(acctId).length > 0 && (
                    <button
                      className="crud-add-service-btn"
                      onClick={() => handleCreateGroup(acctId, alias, acct.fullName)}
                    >
                      <PlusIcon size={14} /> Agregar suscripción
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon"><SearchIcon size={16} /></div>
          <p>No se encontraron cuentas con ese filtro</p>
        </div>
      )}

      {/* ═══ MODALES ═══ */}

      {/* Modal: Editar usuario de grupo Lank */}
      <EditModal
        open={!!editUserModal}
        onClose={() => setEditUserModal(null)}
        onSave={handleEditUserSave}
        title="Editar usuario"
        icon={<EditIcon size={16} />}
        fields={editUserModal ? getUserEditableFields(editUserModal.svcId) : []}
        initialValues={editUserModal ? (() => {
          const vals = {};
          const fields = getUserEditableFields(editUserModal.svcId);
          // Buscar datos del cupo vinculado para pre-llenar campos vacíos
          const poolMatch = findUserSlotInPool(editUserModal.svcId, editUserModal.user);
          fields.forEach(f => {
            let value = editUserModal.user[f.key] || '';
            // Si el campo local está vacío, buscar en el cupo real
            if (!value && poolMatch?.slot) {
              if (f.key === 'projectName') value = poolMatch.slot.projectName || '';
              if (f.key === 'profileName') value = poolMatch.slot.profileName || '';
              if (f.key === 'userEmail' || f.key === 'email') value = poolMatch.slot.memberEmail || '';
            }
            vals[f.key] = value;
          });
          return vals;
        })() : {}}
        saveLabel={<><SaveIcon size={16} /> Guardar cambios</>}
        confirmMessage="Se actualizará la información de este usuario en Firestore."
      >
        {editUserModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>
              {getServiceMeta(editUserModal.svcId).name}
            </strong> — Cuenta Lank #{editUserModal.acctId}
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Usuario actual: <span style={{ fontWeight: 600 }}>{editUserModal.user.userAlias}</span>
            </div>
          </div>
        )}
      </EditModal>

      {/* Diálogo: Confirmar baja de usuario */}
      <ConfirmDialog
        open={!!removeUserConfirm}
        onClose={() => setRemoveUserConfirm(null)}
        onConfirm={handleRemoveUserConfirm}
        title="Dar de baja usuario"
        message={
          removeUserConfirm
            ? `¿Estás seguro de eliminar a "${removeUserConfirm.userAlias}" de la cuenta Lank #${removeUserConfirm.acctId}? Esta acción es IRREVERSIBLE.`
              + (removeUserConfirm.hasRealAccount
                ? `\n\nEste usuario tiene cupo asignado en la cuenta real "${removeUserConfirm.serviceAccountRef}". Se creará una alerta automática para que limpies su acceso (el cupo NO se liberará automáticamente).`
                : '')
            : ''
        }
        confirmLabel={<><BlockIcon size={16} /> Sí, dar de baja</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Modal: Agregar usuario a grupo */}
      <EditModal
        open={!!addUserModal}
        onClose={() => setAddUserModal(null)}
        onSave={handleAddUserSave}
        title="Agregar usuario"
        icon={<PlusIcon size={16} />}
        fields={addUserModal ? getUserEditableFields(addUserModal.svcId) : []}
        initialValues={{}}
        saveLabel={<><PlusIcon size={16} /> Agregar usuario</>}
        confirmMessage="Se agregará un nuevo usuario a este grupo."
      >
        {addUserModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>
              {getServiceMeta(addUserModal.svcId).name}
            </strong> — Cuenta Lank #{addUserModal.acctId}
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Cuenta: <span style={{ fontWeight: 600 }}>{addUserModal.accountAlias}</span>
              {' '} — {addUserModal.currentUsers.length} usuario{addUserModal.currentUsers.length !== 1 ? 's' : ''} actual{addUserModal.currentUsers.length !== 1 ? 'es' : ''}
            </div>
          </div>
        )}
      </EditModal>

      {/* Modal: Crear grupo / suscripción nueva */}
      <EditModal
        open={!!createGroupModal}
        onClose={() => setCreateGroupModal(null)}
        onSave={handleCreateGroupSave}
        title="Agregar suscripción"
        icon={<PlusIcon size={16} />}
        fields={[
          {
            key: 'serviceKey',
            label: 'Servicio',
            type: 'select',
            required: true,
            placeholder: 'Seleccionar servicio...',
            options: createGroupModal
              ? getAvailableServicesForCreate(createGroupModal.acctId).map(s => ({
                  value: s.id,
                  label: s.name,
                }))
              : [],
          },
          {
            key: 'cashback',
            label: 'Cashback',
            type: 'select',
            placeholder: 'Seleccionar...',
            options: [
              { value: 'true', label: 'Si — tiene cashback' },
              { value: 'false', label: 'No — sin cashback' },
            ],
          },
        ]}
        initialValues={{ cashback: 'false' }}
        saveLabel={<><PlusIcon size={16} /> Crear grupo</>}
        confirmMessage="Se creará un nuevo grupo de suscripción para esta cuenta."
      >
        {createGroupModal && (
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '4px' }}>
            Cuenta Lank <strong style={{ color: 'var(--text-primary)' }}>#{createGroupModal.acctId} — {createGroupModal.accountAlias}</strong>
            {createGroupModal.fullName && createGroupModal.fullName !== createGroupModal.accountAlias && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {createGroupModal.fullName}
              </div>
            )}
          </div>
        )}
      </EditModal>

      {/* Diálogo: Confirmar eliminación de grupo */}
      <ConfirmDialog
        open={!!deleteGroupConfirm}
        onClose={() => setDeleteGroupConfirm(null)}
        onConfirm={handleDeleteGroupConfirm}
        title="Eliminar grupo"
        message={
          deleteGroupConfirm
            ? `¿Estás seguro de eliminar el grupo "${deleteGroupConfirm.serviceName}" de la cuenta Lank #${deleteGroupConfirm.acctId}? Esta acción es IRREVERSIBLE.`
              + (deleteGroupConfirm.userCount > 0
                ? `\n\nADVERTENCIA: Este grupo tiene ${deleteGroupConfirm.userCount} usuario${deleteGroupConfirm.userCount !== 1 ? 's' : ''} registrado${deleteGroupConfirm.userCount !== 1 ? 's' : ''}. Se perderán todos los datos.`
                : '')
            : ''
        }
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar grupo</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Modal: Crear cuenta Lank — ahora se gestiona desde Bóveda → Cuentas de Correo */}

      {/* Modal: Editar cuenta Lank maestra */}
      <EditModal
        open={!!editAccountModal}
        onClose={() => !savingAccount && setEditAccountModal(null)}
        onSave={async (values) => {
          await updateLankMasterAccount(editAccountModal.acctId, {
            canonicalAlias: values.canonicalAlias,
            fullName: values.fullName,
            lankGmailAddress: values.email,
            whatsapp: values.whatsapp,
          });
          showToast(`Cuenta #${editAccountModal.acctId} actualizada`);
          await refreshAccountsData();
          setEditAccountModal(null);
        }}
        title={editAccountModal ? `Editar Cuenta Lank #${editAccountModal.acctId}` : 'Editar cuenta'}
        icon={<EditIcon size={16} />}
        fields={[
          { key: 'canonicalAlias', label: 'Alias', placeholder: 'Alias canónico' },
          { key: 'fullName', label: 'Nombre completo', placeholder: 'Nombre completo' },
          { key: 'email', label: 'Correo Gmail Lank', type: 'email', placeholder: 'correo@gmail.com' },
          { key: 'whatsapp', label: 'WhatsApp', placeholder: '+52 1234567890' },
        ]}
        initialValues={editAccountValues}
        saveLabel={<><SaveIcon size={16} /> Guardar cambios</>}
        confirmMessage="Los cambios de alias, nombre y correo se sincronizan automáticamente con la Bóveda (cuenta lank_google vinculada)."
        resetKey={editAccountModal?.acctId}
      />

      {/* Toast */}
      <Toast {...toast} onClose={() => setToast(prev => ({ ...prev, visible: false }))} />
 </>
 );
}
