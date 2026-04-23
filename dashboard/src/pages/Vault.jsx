import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { collection, onSnapshot, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useDocument } from '../hooks/useFirestore';
import { SERVICES, BANKS, getServiceMeta, getBankMeta, getPoolServiceKeys, getAllServiceKeys } from '../config/services';
import { encrypt, decrypt, encryptFields, decryptFields } from '../utils/crypto';
import { completeAlert, createManualAlert, createRealAccount, createLinkedRealAccount, deleteRealAccount, createVaultCard, deleteVaultCard, DEFAULT_MASTER_CONFIG, addRecurringCharge, removeRecurringCharge, toggleRecurringCharge, updateRecurringCharge, createVaultEmailAccount, updateVaultEmailAccount, syncVaultEmailPassword } from '../hooks/firestoreActions';
import { ConfirmDialog, Toast } from '../components/EditModal';
import { seedGooglePasswords } from '../utils/seedGooglePasswords';
import { BadgeIcon, BankIcon, CalendarIcon, CashIcon, CheckCircleIcon, ClipboardIcon, CloseIcon, CreditCardIcon, DotRed, EditIcon, EmailIcon, HashIcon, HourglassIcon, KeyIcon, LinkIcon, LockIcon, LockKeyIcon, NotesIcon, PhoneIcon, PlusIcon, ReceiptIcon, RefreshIcon, SaveIcon, SearchIcon, SeedlingIcon, ToggleOnIcon, ToggleOffIcon, TrashIcon, UserIcon, WarningIcon } from '../components/Icons';
import { normalizeSearch, nMatch } from '../utils/normalize';
import SearchBar from '../components/SearchBar';
import BankManager from '../components/BankManager';
import CryptoJS from 'crypto-js';

const SERVICE_SENSITIVE = ['password', 'googlePassword'];
const CARD_SENSITIVE = ['number', 'cvv'];
const VAULT_LOCK_TIMEOUT = 5 * 60 * 1000; // 5 min de inactividad => se bloquea
const REVEAL_TIMEOUT = 5000; // 5 segundos para ocultar campos revelados
const APP_PASSWORD_MAX_LEN = 16; // Google App Passwords son 16 caracteres sin espacios

// Hash PIN con salt fijo
function hashPin(pin) {
  return CryptoJS.SHA256(pin + '_AdminLank_VaultPIN_2026').toString();
}

// Formatear app password: "abcdefghijklmnop" → "abcd efgh ijkl mnop"
function formatAppPassword(raw) {
  if (!raw) return '';
  const clean = raw.replace(/\s/g, '');
  return clean.match(/.{1,4}/g)?.join(' ') || clean;
}

// Limpiar app password: quitar espacios y limitar a 16 chars
function cleanAppPassword(input) {
  return input.replace(/\s/g, '').slice(0, APP_PASSWORD_MAX_LEN).toLowerCase();
}

// Formatear número de tarjeta: "1234567890123456" → "1234 5678 9012 3456"
function formatCardNumber(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '').slice(0, 16);
  return digits.match(/.{1,4}/g)?.join(' ') || digits;
}

// Limpiar número de tarjeta: quitar todo lo que no sea dígito
function cleanCardNumber(input) {
  return input.replace(/\D/g, '').slice(0, 16);
}

// Extraer últimos 4 dígitos de un número de tarjeta
function getLast4(number) {
  const digits = (number || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits || '????';
}

function normalizeVaultEmail(email) {
 return (email || '').trim().toLowerCase();
}

export default function Vault({ onNavigate, navData, servicesConfig }) {
 const { data: masterConfigDoc } = useDocument('config', 'services');
 const [activeTab, setActiveTab] = useState('credentials');
 const [pools, setPools] = useState({});
 const [secrets, setSecrets] = useState({});
 const [cards, setCards] = useState({});
 const [alerts, setAlerts] = useState([]);
 const [revealedFields, setRevealedFields] = useState(new Set());
 const [searchQuery, setSearchQuery] = useState('');
 const [expandedServices, setExpandedServices] = useState(new Set());
 const [expandedCards, setExpandedCards] = useState(new Set());
 const [highlightRef, setHighlightRef] = useState(null);
 const highlightTimerRef = useRef(null);
 const mouseDownOnOverlayRef = useRef(false);

 // Modal states
 const [editModal, setEditModal] = useState(null);
 const [editValues, setEditValues] = useState({});
 const [cardEditModal, setCardEditModal] = useState(null);
 const [cardEditValues, setCardEditValues] = useState({});
 const [createModal, setCreateModal] = useState(null); // { serviceKey, mode: 'account' | 'card' }
 const [createValues, setCreateValues] = useState({});
 const [confirmDialog, setConfirmDialog] = useState(null);
 const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
 const [seeding, setSeeding] = useState(false);
 const [expandedGoogleAccounts, setExpandedGoogleAccounts] = useState(new Set());
 const [recurringModal, setRecurringModal] = useState(null); // { cardId, cardLabel, editChargeId? }
 const [recurringValues, setRecurringValues] = useState({ description: '', amount: '', billingDay: '', serviceKey: '', serviceAccountRef: '' });

 // ─── Cuentas de Correo (Google tab restructurado) ───
 const [googleEditModal, setGoogleEditModal] = useState(null); // { id, type, email, ... }
 const [googleEditValues, setGoogleEditValues] = useState({ email: '', password: '', notes: '', fullName: '', canonicalAlias: '', whatsapp: '' });
 const [googleCreateModal, setGoogleCreateModal] = useState(null); // { type: 'lank_google' | 'tertiary' }
 const [googleCreateValues, setGoogleCreateValues] = useState({ type: 'tertiary', lankAccountId: '', email: '', password: '', notes: '' });
 const [lankRegistry, setLankRegistry] = useState([]);

 // ─── SEGURIDAD: PIN de Bóveda ───
 const [vaultUnlocked, setVaultUnlocked] = useState(false);
 const [pinInput, setPinInput] = useState('');
 const [pinError, setPinError] = useState('');
 const [pinHash, setPinHash] = useState(null); // hash guardado en Firestore
 const [pinLoading, setPinLoading] = useState(true);
 const [settingPin, setSettingPin] = useState(false); // modo configurar PIN por primera vez
 const [pinConfirm, setPinConfirm] = useState('');
 const [changingPin, setChangingPin] = useState(false); // modo cambiar PIN
 const lastActivityRef = useRef(Date.now());
 const pinInputRefs = useRef([]);
 const lockTimerRef = useRef(null);

 // ─── App Passwords (IMAP) ───
 const [imapCredentials, setImapCredentials] = useState(null); // array de cuentas
 const [imapLoading, setImapLoading] = useState(false);
 const [editingAppPw, setEditingAppPw] = useState(null); // { index, email, appPassword, accountId, enabled }
 const [appPwSaving, setAppPwSaving] = useState(false);


 const masterConfig = useMemo(() => {
   if (masterConfigDoc) {
     const data = masterConfigDoc.services || masterConfigDoc;
     const { id, updatedAt, ...services } = data;
     return { ...DEFAULT_MASTER_CONFIG, ...services };
   }
   return DEFAULT_MASTER_CONFIG;
 }, [masterConfigDoc]);

 // Servicios con credenciales compartidas (password)
 const PASSWORD_SERVICES = useMemo(() =>
   getAllServiceKeys().filter(k => getServiceMeta(k).accessType === 'credentials'),
   [servicesConfig]);

 // Servicios con pool, ordenados por displayOrder
 const SERVICE_ORDER = useMemo(() =>
   getPoolServiceKeys(),
   [servicesConfig]);

 const getRealAccountSlots = useCallback((serviceKey) => {
   return masterConfig[serviceKey]?.maxSlotsPerRealAccount || getServiceMeta(serviceKey).maxSlots || 4;
 }, [masterConfig]);

 const buildEmptySlots = useCallback((serviceKey) => {
   const total = getRealAccountSlots(serviceKey);
   return Array.from({ length: total }, (_, i) => ({
     slotNumber: i + 1,
     status: 'free',
     enabled: true,
     memberAlias: '',
     memberEmail: '',
     profileName: '',
     projectName: '',
     assignedFrom: null,
   }));
 }, [getRealAccountSlots]);

 const showToast = useCallback((msg, type = 'success') => {
 setToast({ visible: true, message: msg, type });
 }, []);

 // ─── SEGURIDAD: Cargar PIN desde Firestore ───
 useEffect(() => {
   const loadPin = async () => {
     try {
       const pinDoc = await getDoc(doc(db, 'config', 'vault-security'));
       if (pinDoc.exists() && pinDoc.data().pinHash) {
         setPinHash(pinDoc.data().pinHash);
       } else {
         setPinHash(null); // No hay PIN configurado
         setSettingPin(true); // Activar modo de configuración
       }
     } catch (err) {
       console.error('Error cargando PIN de bóveda:', err);
       setPinHash(null);
       setSettingPin(true);
     }
     setPinLoading(false);
   };
   loadPin();
 }, []);

 // ─── SEGURIDAD: Auto-lock por inactividad ───
 useEffect(() => {
   if (!vaultUnlocked) return;
   const resetActivity = () => { lastActivityRef.current = Date.now(); };
   window.addEventListener('mousemove', resetActivity);
   window.addEventListener('keydown', resetActivity);
   window.addEventListener('click', resetActivity);
   window.addEventListener('scroll', resetActivity);

   lockTimerRef.current = setInterval(() => {
     if (Date.now() - lastActivityRef.current > VAULT_LOCK_TIMEOUT) {
       setVaultUnlocked(false);
       setRevealedFields(new Set());
       setPinInput('');
       showToast('Bóveda bloqueada por inactividad', 'error');
     }
   }, 10000); // chequear cada 10s

   return () => {
     window.removeEventListener('mousemove', resetActivity);
     window.removeEventListener('keydown', resetActivity);
     window.removeEventListener('click', resetActivity);
     window.removeEventListener('scroll', resetActivity);
     if (lockTimerRef.current) clearInterval(lockTimerRef.current);
   };
 }, [vaultUnlocked, showToast]);

 // ─── SEGURIDAD: Verificar PIN ───
 const handlePinSubmit = useCallback(async (pin) => {
   if (settingPin) {
     // Modo configuración: primer ingreso
     if (!pinConfirm) {
       if (pin.length !== 4) { setPinError('El PIN debe ser de 4 dígitos'); return; }
       setPinConfirm(pin);
       setPinInput('');
       setPinError('');
       return;
     }
     // Confirmar PIN
     if (pin !== pinConfirm) {
       setPinError('Los PIN no coinciden. Intenta de nuevo.');
       setPinConfirm('');
       setPinInput('');
       return;
     }
     // Guardar en Firestore
     const hashed = hashPin(pin);
     try {
       await setDoc(doc(db, 'config', 'vault-security'), {
         pinHash: hashed,
         createdAt: new Date().toISOString(),
         updatedAt: new Date().toISOString(),
       });
       setPinHash(hashed);
       setSettingPin(false);
       setPinConfirm('');
       setVaultUnlocked(true);
       lastActivityRef.current = Date.now();
       showToast('PIN de Bóveda configurado correctamente');
     } catch (err) {
       setPinError('Error al guardar PIN: ' + err.message);
     }
     return;
   }

   if (changingPin) {
     // Modo cambiar PIN
     if (!pinConfirm) {
       if (pin.length !== 4) { setPinError('El PIN debe ser de 4 dígitos'); return; }
       setPinConfirm(pin);
       setPinInput('');
       setPinError('');
       return;
     }
     if (pin !== pinConfirm) {
       setPinError('Los PIN no coinciden. Intenta de nuevo.');
       setPinConfirm('');
       setPinInput('');
       return;
     }
     const hashed = hashPin(pin);
     try {
       await updateDoc(doc(db, 'config', 'vault-security'), {
         pinHash: hashed,
         updatedAt: new Date().toISOString(),
       });
       setPinHash(hashed);
       setChangingPin(false);
       setPinConfirm('');
       setPinInput('');
       showToast('PIN actualizado correctamente');
     } catch (err) {
       setPinError('Error al actualizar PIN: ' + err.message);
     }
     return;
   }

   // Modo normal: verificar PIN
   const hashed = hashPin(pin);
   if (hashed === pinHash) {
     setVaultUnlocked(true);
     lastActivityRef.current = Date.now();
     setPinError('');
     setPinInput('');
   } else {
     setPinError('PIN incorrecto');
     setPinInput('');
   }
 }, [pinHash, settingPin, changingPin, pinConfirm, showToast]);

 // ─── SEGURIDAD: Captura de teclado para PIN ───
 const pinInputRef = useRef(pinInput);
 pinInputRef.current = pinInput;
 const handlePinSubmitRef = useRef(handlePinSubmit);
 handlePinSubmitRef.current = handlePinSubmit;

 useEffect(() => {
   // Solo escuchar cuando la pantalla del PIN está visible
   const showingPin = !pinLoading && (!vaultUnlocked || changingPin);
   if (!showingPin) return;

   const handleKeyDown = (e) => {
     if (e.key >= '0' && e.key <= '9' && pinInputRef.current.length < 4) {
       e.preventDefault();
       const newPin = pinInputRef.current + e.key;
       setPinInput(newPin);
       setPinError('');
       if (newPin.length === 4) {
         setTimeout(() => handlePinSubmitRef.current(newPin), 200);
       }
     } else if (e.key === 'Backspace') {
       e.preventDefault();
       setPinInput(prev => prev.slice(0, -1));
       setPinError('');
     }
   };

   document.addEventListener('keydown', handleKeyDown);
   return () => document.removeEventListener('keydown', handleKeyDown);
 }, [pinLoading, vaultUnlocked, changingPin]);

 // ─── SEGURIDAD: Bloquear bóveda manualmente ───
 const handleLockVault = useCallback(() => {
   setVaultUnlocked(false);
   setRevealedFields(new Set());
   setPinInput('');
   showToast('Bóveda bloqueada');
 }, [showToast]);

 // ─── SEGURIDAD: Ocultar todos los campos revelados ───
 const handleHideAll = useCallback(() => {
   setRevealedFields(new Set());
 }, []);

 // ─── App Passwords: cargar credenciales IMAP ───
 const loadImapCredentials = useCallback(async () => {
   setImapLoading(true);
   try {
     const imapDoc = await getDoc(doc(db, 'config', 'imap-credentials'));
     if (imapDoc.exists()) {
       setImapCredentials(imapDoc.data().accounts || []);
     } else {
       setImapCredentials([]);
     }
   } catch (err) {
     console.error('Error cargando credenciales IMAP:', err);
     showToast('Error cargando App Passwords', 'error');
   }
   setImapLoading(false);
 }, [showToast]);

 useEffect(() => {
   if (activeTab === 'apppasswords' && vaultUnlocked && imapCredentials === null) {
     loadImapCredentials();
   }
 }, [activeTab, vaultUnlocked, imapCredentials, loadImapCredentials]);

 // ─── App Passwords: guardar cambios ───
 const handleSaveAppPassword = useCallback(async () => {
   if (!editingAppPw || !imapCredentials) return;
   setAppPwSaving(true);
   try {
     const updated = [...imapCredentials];
     updated[editingAppPw.index] = {
       ...updated[editingAppPw.index],
       appPassword: cleanAppPassword(editingAppPw.appPassword),
       enabled: editingAppPw.enabled !== false,
     };
     await updateDoc(doc(db, 'config', 'imap-credentials'), { accounts: updated });
     setImapCredentials(updated);
     setEditingAppPw(null);
     showToast('App Password actualizada');
   } catch (err) {
     showToast('Error al guardar: ' + err.message, 'error');
   }
   setAppPwSaving(false);
 }, [editingAppPw, imapCredentials, showToast]);

 // Handle navData
 useEffect(() => {
 if (!navData) return;
 if (navData.tab) setActiveTab(navData.tab);
 if (navData.serviceKey) {
      setExpandedServices(new Set([navData.serviceKey]));
      setActiveTab('credentials');
 }
 if (navData.serviceAccountRef) {
      setHighlightRef(navData.serviceAccountRef);
      setTimeout(() => {
        const el = document.getElementById(`vault-${navData.serviceAccountRef}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('vault-highlight-pulse');
          highlightTimerRef.current = setTimeout(() => {
            el.classList.remove('vault-highlight-pulse');
            setHighlightRef(null);
          }, 4000);
        }
      }, 400);
 }
 return () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); };
 }, [navData]);

 // Load real accounts
 useEffect(() => {
 const serviceKeys = getPoolServiceKeys();
 const unsubs = serviceKeys.map(svc => {
      return onSnapshot(collection(db, `service-pools/${svc}/real-accounts`), snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setPools(prev => ({ ...prev, [svc]: docs }));
      });
 });
 return () => unsubs.forEach(u => u());
 }, []);

 // Load secrets
 useEffect(() => {
 const unsub = onSnapshot(collection(db, 'secrets'), snap => {
      const data = {};
      snap.docs.forEach(d => { data[d.id] = d.data(); });
      setSecrets(data);
 });
 return () => unsub();
 }, []);

 // Load Lank account registry for principal email accounts
 useEffect(() => {
   let cancelled = false;

   const loadRegistry = async () => {
     try {
       const registryDoc = await getDoc(doc(db, 'config', 'account-registry'));
       if (registryDoc.exists()) {
         const accounts = (registryDoc.data().accounts || []).map((account) => ({
           id: String(account.id ?? ''),
           fullName: account.fullName || '',
           canonicalAlias: account.canonicalAlias || '',
           lankGmailAddress: account.lankGmailAddress || '',
         }));

         if (!cancelled) {
           setLankRegistry(accounts.filter(account => account.id));
         }
         return;
       }

       const legacySnap = await getDocs(collection(db, 'accounts'));
       if (!cancelled) {
         setLankRegistry(legacySnap.docs.map((snap) => {
           const data = snap.data();
           return {
             id: String(data.id ?? snap.id),
             fullName: data.fullName || '',
             canonicalAlias: data.canonicalAlias || '',
             lankGmailAddress: data.lankGmailAddress || '',
           };
         }).filter(account => account.id));
       }
     } catch (err) {
       console.error('Error cargando registro de cuentas Lank:', err);
     }
   };

   loadRegistry();
   return () => { cancelled = true; };
 }, []);

 // Load cards
 useEffect(() => {
 const unsub = onSnapshot(collection(db, 'vault-cards'), snap => {
      const data = {};
      snap.docs.forEach(d => { data[d.id] = { id: d.id, ...d.data() }; });
      setCards(data);
 });
 return () => unsub();
 }, []);

 // Load pending password_change alerts
 useEffect(() => {
 const unsub = onSnapshot(collection(db, 'alerts'), snap => {
      const passwordAlerts = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(a => a.type === 'password_change' && a.status === 'pending');
      setAlerts(passwordAlerts);
 });
 return () => unsub();
 }, []);

 // Helpers
 const getEmailLabel = (email) => {
 if (!email) return 'Contraseña del email';
 const domain = email.split('@')[1]?.toLowerCase() || '';
 if (domain.includes('gmail')) return 'Contraseña Google';
 if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) return 'Contraseña Outlook';
 return 'Contraseña del email';
 };
 const getSecret = (ref) => {
 const s = secrets[ref];
 return s ? decryptFields(s, SERVICE_SENSITIVE) : null;
 };
 const getCard = (id) => {
 const c = cards[id];
 return c ? decryptFields(c, CARD_SENSITIVE) : null;
 };
 const getPendingAlert = (ref) => alerts.find(a => a.serviceAccountRef === ref);
 // Normalizar ID de tarjeta: misma lógica que handleCreateCard usa al crear
 const getCardIdFromLabel = (label) => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

 // All accounts grouped
 const accountsByService = useMemo(() => {
 const grouped = {};
 SERVICE_ORDER.forEach(svc => {
      const accounts = pools[svc] || [];
      grouped[svc] = [...accounts].sort((a, b) =>
        (a.serviceAccountRef || '').localeCompare(b.serviceAccountRef || '')
      );
 });
 return grouped;
 }, [pools]);

 // Search filter - searches EVERYTHING
 const filteredAccounts = useMemo(() => {
 if (!searchQuery || searchQuery.length < 2) return accountsByService;
 const q = normalizeSearch(searchQuery);
 const result = {};
 Object.entries(accountsByService).forEach(([svc, accts]) => {
      const meta = getServiceMeta(svc);
      // Match service name itself
      if (nMatch(meta.name, q)) {
        result[svc] = accts;
        return;
      }
      const filtered = accts.filter(a => {
        const secret = getSecret(a.serviceAccountRef);
        return (
          nMatch(a.email, q) ||
          nMatch(a.label, q) ||
          nMatch(a.serviceAccountRef, q) ||
          nMatch(a.cardLabel, q) ||
          nMatch(secret?.notes, q) ||
          nMatch(secret?.email, q) ||
          String(a.monthlyCost || '').includes(q)
        );
      });
      if (filtered.length > 0) result[svc] = filtered;
 });
 return result;
 }, [accountsByService, searchQuery, secrets]);

 // Unique cards from real accounts + standalone vault-cards
 // Key = cardId from Firestore, value = { id, label, cardData, linkedAccounts }
 const allCards = useMemo(() => {
 const cardMap = {};

 // First, build from vault-cards collection (the actual source of truth)
 Object.values(cards).forEach(c => {
      const label = `${c.bank || 'Tarjeta'} ****${c.lastFour || '????'}`;
      cardMap[c.id] = { id: c.id, label, cardData: c, linkedAccounts: [] };
 });

 // Then, match real accounts that have cardLabel
 Object.entries(pools).forEach(([svc, accts]) => {
      accts.forEach(acct => {
        if (acct.cardLabel) {
          // Find the vault-card whose label matches
          const matchingEntry = Object.values(cardMap).find(cm => cm.label === acct.cardLabel);
          if (matchingEntry) {
            matchingEntry.linkedAccounts.push({
              serviceKey: svc, serviceAccountRef: acct.serviceAccountRef,
              label: acct.label, email: acct.email,
              monthlyCost: acct.monthlyCost,
            });
          }
        }
      });
 });
 return cardMap;
 }, [pools, cards]);

 // Card labels for dropdown
 const cardLabels = useMemo(() => Object.values(allCards).map(c => c.label).sort(), [allCards]);

 const availablePrincipalAccounts = useMemo(() => {
   return lankRegistry
     .filter(account => !Object.values(secrets).some(secret =>
       secret.type === 'lank_google' && String(secret.lankAccountId || '') === String(account.id)
     ))
     .sort((a, b) => (parseInt(a.id, 10) || 999) - (parseInt(b.id, 10) || 999));
 }, [lankRegistry, secrets]);

 // All vault email accounts for the email picker in real account creation
 const vaultEmailOptions = useMemo(() => {
   return Object.entries(secrets)
     .filter(([, s]) => s.type === 'lank_google' || s.type === 'tertiary')
     .map(([id, s]) => ({
       id,
       email: s.email || '',
       type: s.type,
       label: s.type === 'lank_google'
         ? `#${s.lankAccountId} ${s.canonicalAlias || s.fullName || ''} — ${s.email}`
         : s.email,
       isPrincipal: s.type === 'lank_google',
       lankAccountId: s.lankAccountId || '',
       canonicalAlias: s.canonicalAlias || '',
     }))
     .sort((a, b) => {
       if (a.isPrincipal && !b.isPrincipal) return -1;
       if (!a.isPrincipal && b.isPrincipal) return 1;
       if (a.isPrincipal && b.isPrincipal) {
         return (parseInt(a.lankAccountId) || 999) - (parseInt(b.lankAccountId) || 999);
       }
       return a.email.localeCompare(b.email);
     });
 }, [secrets]);

 // Toggle service expand
 const toggleService = (svc) => {
 setExpandedServices(prev => {
      const next = new Set(prev);
      if (next.has(svc)) next.delete(svc);
      else next.add(svc);
      return next;
 });
 };

 // Toggle card expand
 const toggleCardExpand = (cardId) => {
 setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
 });
 };

 // Toggle reveal
 const toggleReveal = (key) => {
 setRevealedFields(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); }
      else {
        next.add(key);
        setTimeout(() => {
          setRevealedFields(p => { const n = new Set(p); n.delete(key); return n; });
        }, REVEAL_TIMEOUT);
      }
      return next;
 });
 };

 const copyToClipboard = async (text, label) => {
 try { await navigator.clipboard.writeText(text); showToast(`${label} copiado`); }
 catch { showToast('Error al copiar', 'error'); }
 };

 // ─── SAVE CREDENTIAL ───
 const handleSaveCredential = async (serviceAccountRef, values, alertToComplete = null) => {
 const encrypted = encryptFields(values, SERVICE_SENSITIVE);
 encrypted.updatedAt = new Date().toISOString();
 const ref = doc(db, 'secrets', serviceAccountRef);
 const existing = await getDoc(ref);
 if (existing.exists()) {
      const oldData = existing.data();
      const history = oldData.passwordHistory || [];
      if (oldData.password && values.password && oldData.password !== encrypt(values.password)) {
        history.push({ oldPassword: oldData.password, changedAt: new Date().toISOString() });
      }
      await updateDoc(ref, { ...encrypted, passwordHistory: history });
 } else {
      await setDoc(ref, { ...encrypted, passwordHistory: [], createdAt: new Date().toISOString() });
 }
 // Sync googlePassword bidireccionalmente
 if (values.googlePassword && values.email) {
      await syncVaultEmailPassword(values.email, encrypted.googlePassword);
 }
 // Update real account fields if changed (cardLabel, label, monthlyCost)
 if (values._accountUpdates && editModal?.acct) {
      const acctRef = doc(db, `service-pools/${editModal.acct.serviceKey}/real-accounts/${editModal.acct.serviceAccountRef}`);
      await updateDoc(acctRef, { ...values._accountUpdates, updatedAt: new Date().toISOString() });
 }
 if (alertToComplete) {
      await completeAlert(alertToComplete.id, { resolvedVia: 'vault' });

      // Generar alertas access_verify para usuarios restantes de esta cuenta real
      try {
        // Determinar el serviceKey desde el serviceAccountRef (ej: "chatgpt_1" → "chatgpt")
        const svcKey = serviceAccountRef.replace(/_\d+$/, '');
        const realAccountRef = doc(db, `service-pools/${svcKey}/real-accounts/${serviceAccountRef}`);
        const realSnap = await getDoc(realAccountRef);

        if (realSnap.exists()) {
          const realData = realSnap.data();
          const activeSlots = (realData.slots || []).filter(s => s.memberAlias && s.status === 'active');

          if (activeSlots.length > 0) {
            const svcMeta = getServiceMeta(svcKey);
            const serviceName = svcMeta.name || svcKey;
            const acctLabel = realData.email ? `${serviceAccountRef} (${realData.email})` : serviceAccountRef;
            const userNames = activeSlots.map(s => s.memberAlias);

            await createManualAlert({
              service: serviceName,
              serviceAccountRef,
              realAccountEmail: realData.email || null,
              source: 'password_changed',
              type: 'access_verify',
              priority: 'medium',
              title: `Verificar acceso - ${serviceName}`,
              description: `La contrasena de ${acctLabel} fue cambiada. Verificar que estos usuarios aun tengan acceso: ${userNames.join(', ')}`,
              dependsOn: 'password_change',
              affectedUsers: userNames,
            });
          }
        }
      } catch (err) {
        console.error('Error generando alertas access_verify:', err);
      }

      showToast('Contraseña actualizada y alerta completada ');
 } else {
      showToast('Credencial guardada correctamente');
 }
 };

 // ─── SAVE GOOGLE/EMAIL ACCOUNT ───
 const handleSaveGoogleAccount = async () => {
   if (!googleEditModal) return;

   try {
     const updatePayload = {
       email: googleEditValues.email,
       password: googleEditValues.password,
       notes: googleEditValues.notes,
     };
     // For lank_google accounts, also sync identity fields
     if (googleEditModal.isPrincipal) {
       updatePayload.fullName = googleEditValues.fullName;
       updatePayload.canonicalAlias = googleEditValues.canonicalAlias;
       updatePayload.whatsapp = googleEditValues.whatsapp;
     }
     await updateVaultEmailAccount(googleEditModal.id, updatePayload);
     showToast('Cuenta actualizada correctamente');
     setGoogleEditModal(null);
   } catch (err) {
     showToast(err.message || 'Error al actualizar la cuenta', 'error');
   }
 };

 const handleCreateGoogleAccount = async () => {
   if (!googleCreateModal) return;
   if (!googleCreateValues.email) {
     showToast('El email es obligatorio', 'error');
     return;
   }

   if (googleCreateModal.type === 'lank_google' && !googleCreateValues.lankAccountId) {
     showToast('Debes seleccionar una cuenta Lank', 'error');
     return;
   }

   const selectedAccount = googleCreateModal.type === 'lank_google'
     ? lankRegistry.find(account => account.id === String(googleCreateValues.lankAccountId))
     : null;

   try {
     await createVaultEmailAccount({
       type: googleCreateModal.type,
       lankAccountId: selectedAccount?.id || '',
       fullName: selectedAccount?.fullName || '',
       canonicalAlias: selectedAccount?.canonicalAlias || '',
       email: googleCreateValues.email,
       password: googleCreateValues.password,
       notes: googleCreateValues.notes,
     });

     const label = googleCreateModal.type === 'lank_google' ? 'Cuenta principal' : 'Cuenta secundaria';
     showToast(`${label} creada correctamente`);
     setGoogleCreateModal(null);
   } catch (err) {
     showToast(err.message || 'Error al crear la cuenta', 'error');
   }
 };

 // ─── SAVE CARD ───
 const handleSaveCard = async (cardId, values) => {
 const cleanNum = cleanCardNumber(values.number || '');
 const derivedLast4 = getLast4(cleanNum);
 const encrypted = encryptFields({
      ...values,
      number: cleanNum,
      lastFour: derivedLast4,
 }, CARD_SENSITIVE);
 encrypted.updatedAt = new Date().toISOString();
 const ref = doc(db, 'vault-cards', cardId);
 const existing = await getDoc(ref);
 if (existing.exists()) { await updateDoc(ref, encrypted); }
 else { await setDoc(ref, { ...encrypted, createdAt: new Date().toISOString() }); }
 showToast('Tarjeta guardada');
 };

 // ─── OPEN EDIT CREDENTIAL ───
 const openCredentialEdit = (acct, svc) => {
 const secret = getSecret(acct.serviceAccountRef);
 const pendingAlert = getPendingAlert(acct.serviceAccountRef);
 setEditValues({
      email: acct.email || '',
      password: secret?.password || '',
      googlePassword: secret?.googlePassword || '',
      notes: secret?.notes || '',
      label: acct.label || '',
 });
 setEditModal({ acct: { ...acct, serviceKey: svc }, secret, pendingAlert });
 };

 // ─── OPEN EDIT CARD ───
 const openCardEdit = (cardId, cardLabel) => {
 const card = getCard(cardId);
 setCardEditValues({
      bank: card?.bank || cardLabel.split(' ****')[0] || '',
      holder: card?.holder || '', number: card?.number || '',
      cvv: card?.cvv || '', expiry: card?.expiry || '',
      notes: card?.notes || '',
 });
 setCardEditModal({ cardLabel, cardId, card });
 };

 // ─── CONFIRM CREDENTIAL SAVE ───
 const confirmCredentialSave = async () => {
 const { acct, pendingAlert } = editModal;
 const secret = getSecret(acct.serviceAccountRef);
 const passwordChanged = secret?.password !== editValues.password;
 const accountUpdates = {};
 if (editValues.label !== (acct.label || '')) accountUpdates.label = editValues.label;
 const saveValues = { ...editValues };
 if (Object.keys(accountUpdates).length > 0) saveValues._accountUpdates = accountUpdates;

 try {
      if (pendingAlert && passwordChanged) {
        await handleSaveCredential(acct.serviceAccountRef, saveValues, pendingAlert);
      } else {
        await handleSaveCredential(acct.serviceAccountRef, saveValues);
      }
      setEditModal(null);
 } catch (err) {
      console.error('Error al guardar credencial:', err);
      showToast('Error al guardar: ' + err.message, 'error');
 }
 };

 // ─── CONFIRM CARD SAVE ───
 const confirmCardSave = () => {
 setConfirmDialog({
      title: <> Confirmar</>,
      message: `Se actualizará la tarjeta "${cardEditModal.cardLabel}". Los datos sensibles se cifrarán.`,
      confirmLabel: 'Guardar tarjeta',
      onConfirm: async () => {
        await handleSaveCard(cardEditModal.cardId, cardEditValues);
        setCardEditModal(null); setConfirmDialog(null);
      },
      onCancel: () => setConfirmDialog(null),
 });
 };

 // ─── CREATE REAL ACCOUNT ───
 const openCreateAccount = (svc) => {
 const meta = getServiceMeta(svc);
 setCreateValues({
      label: '', email: '', password: '', googlePassword: '',
      notes: '',
      // Email linking fields
      emailSource: '', // 'vault_<docId>' or 'new' or '' (manual)
      newEmailPassword: '', // for inline secondary email creation
      newEmailNotes: '', // notes for new email
 });
 setCreateModal({ serviceKey: svc, mode: 'account', accessType: meta.accessType || 'credentials' });
 };

 const handleCreateAccount = async () => {
 const { serviceKey, accessType } = createModal;
 const existingCount = (pools[serviceKey] || []).length;
 const newRef = `${serviceKey}_${existingCount + 1}`;
 const initialSlots = buildEmptySlots(serviceKey);
 const isCredentials = accessType === 'credentials';
 const emailSource = createValues.emailSource || '';

 // Determine email and passwords based on source
 let finalEmail = createValues.email || '';
 let finalGooglePassword = createValues.googlePassword || '';
 let vaultEmailId = null;
 let newEmailData = null;

 if (emailSource.startsWith('vault_')) {
   // Linked to existing vault email account
   vaultEmailId = emailSource.replace('vault_', '');
   const vaultSecret = secrets[vaultEmailId];
   if (vaultSecret) {
     finalEmail = vaultSecret.email || '';
     // googlePassword already comes encrypted from the vault
     const isLankGoogle = vaultSecret.type === 'lank_google';
     finalGooglePassword = isLankGoogle
       ? (vaultSecret.googlePassword || '')
       : (vaultSecret.password || '');
   }
 } else if (emailSource === 'new') {
   // Create new secondary email inline
   finalEmail = createValues.email || '';
   if (!finalEmail) {
     showToast('El email es obligatorio para crear una nueva cuenta de correo', 'error');
     return;
   }
   if (!createValues.newEmailPassword) {
     showToast('La contraseña del email es obligatoria', 'error');
     return;
   }
   // googlePassword will be the encrypted newEmailPassword
   finalGooglePassword = encrypt(createValues.newEmailPassword);
   newEmailData = {
     email: finalEmail,
     emailPassword: createValues.newEmailPassword,
     notes: createValues.newEmailNotes || '',
   };
 } else {
   // Manual entry (legacy behavior)
   if (isCredentials && createValues.googlePassword) {
     finalGooglePassword = encrypt(createValues.googlePassword);
   }
 }

 const accountData = {
      label: createValues.label || newRef,
      email: finalEmail,
      slots: initialSlots,
      occupiedSlots: 0,
      totalSlots: initialSlots.length,
 };

 const secretData = {
      email: finalEmail,
      password: createValues.password ? encrypt(createValues.password) : '',
      googlePassword: (emailSource && emailSource !== '') ? finalGooglePassword : (createValues.googlePassword ? encrypt(createValues.googlePassword) : ''),
      notes: createValues.notes || '',
 };

 try {
   if (vaultEmailId || newEmailData) {
     await createLinkedRealAccount(serviceKey, newRef, accountData, secretData, {
       vaultEmailId,
       newEmailData,
     });
   } else {
     await createRealAccount(serviceKey, newRef, accountData, secretData);
   }
   showToast(`Cuenta real "${accountData.label}" creada en ${getServiceMeta(serviceKey).name}`);
   setCreateModal(null);
 } catch (err) {
   showToast(err.message || 'Error al crear la cuenta', 'error');
 }
 };

 // ─── DELETE REAL ACCOUNT ───
 const handleDeleteAccount = (acct, svc) => {
 // Verificar si hay slots ocupados
 const slots = acct.slots || [];
 const occupied = slots.filter(s => s.memberAlias && s.memberAlias.trim() && s.status !== 'free');
 if (occupied.length > 0) {
      showToast(`No se puede eliminar: hay ${occupied.length} usuario(s) activo(s). Muévelos primero desde Suscripciones.`, 'error');
      return;
 }
 setConfirmDialog({
      title: <> Eliminar cuenta real</>,
      message: `¿Eliminar "${acct.label || acct.serviceAccountRef}" de ${getServiceMeta(svc).name}?\n\nEsta acción es IRREVERSIBLE. Se eliminará la cuenta y sus credenciales.`,
      confirmLabel: <> Sí, eliminar</>,
      onConfirm: async () => {
        await deleteRealAccount(svc, acct.serviceAccountRef || acct.id);
        showToast(`Cuenta "${acct.label}" eliminada`);
        setConfirmDialog(null);
      },
      onCancel: () => setConfirmDialog(null),
 });
 };

 // ─── CREATE CARD ───
 const openCreateCard = () => {
 setCreateValues({
      bank: '', number: '', cvv: '', expiry: '', holder: '', notes: '',
 });
 setCreateModal({ mode: 'card' });
 };

 const handleCreateCard = async () => {
 const cleanNum = cleanCardNumber(createValues.number || '');
 const derivedLast4 = getLast4(cleanNum);
 const label = `${createValues.bank || 'Tarjeta'} ****${derivedLast4}`;
 const id = getCardIdFromLabel(label);
 const data = {
      bank: createValues.bank, lastFour: derivedLast4,
      number: cleanNum ? encrypt(cleanNum) : '',
      cvv: createValues.cvv ? encrypt(createValues.cvv) : '',
      expiry: createValues.expiry, holder: createValues.holder, notes: createValues.notes,
 };
 await createVaultCard(id, data);
 showToast(`Tarjeta "${createValues.bank} ****${derivedLast4}" creada`);
 setCreateModal(null);
 };

 // ─── DELETE CARD ───
 const handleDeleteCard = (cardId, cardLabel) => {
 setConfirmDialog({
      title: <> Eliminar tarjeta</>,
      message: `¿Eliminar la tarjeta "${cardLabel}"?\n\nEsta acción es IRREVERSIBLE.`,
      confirmLabel: <> Sí, eliminar</>,
      onConfirm: async () => {
        await deleteVaultCard(cardId);
        showToast(`Tarjeta "${cardLabel}" eliminada`);
        setConfirmDialog(null);
      },
      onCancel: () => setConfirmDialog(null),
 });
 };

 // ─── COBROS RECURRENTES ───
 const openRecurringModal = (cardId, cardLabel) => {
 setRecurringValues({ description: '', amount: '', billingDay: '', serviceKey: '', serviceAccountRef: '' });
 setRecurringModal({ cardId, cardLabel });
 };

 const openEditRecurringModal = (cardId, cardLabel, charge) => {
 setRecurringValues({
      description: charge.description || '',
      amount: String(charge.amount || ''),
      billingDay: String(charge.billingDay || ''),
      serviceKey: charge.serviceKey || '',
      serviceAccountRef: charge.serviceAccountRef || '',
 });
 setRecurringModal({ cardId, cardLabel, editChargeId: charge.id });
 };

 const handleSaveRecurring = async () => {
 if (!recurringModal || !recurringValues.description?.trim() || !recurringValues.billingDay) {
      showToast('Completa descripción y día de cobro', 'error');
      return;
 }
 if (!recurringValues.serviceKey || !recurringValues.serviceAccountRef) {
      showToast('Debes vincular el cobro a una cuenta real', 'error');
      return;
 }
 const day = parseInt(recurringValues.billingDay);
 if (isNaN(day) || day < 1 || day > 31) {
      showToast('El día debe ser entre 1 y 31', 'error');
      return;
 }
 const svcAccounts = pools[recurringValues.serviceKey] || [];
 const realAcct = svcAccounts.find(a => a.serviceAccountRef === recurringValues.serviceAccountRef || a.id === recurringValues.serviceAccountRef);

 // Validación 1: cuenta ya vinculada a OTRA tarjeta
 if (realAcct?.cardLabel && realAcct.cardLabel !== recurringModal.cardLabel) {
      showToast(`Esa cuenta ya está vinculada a "${realAcct.cardLabel}". Una cuenta solo puede tener una tarjeta.`, 'error');
      return;
 }

 // Validación 2: cuenta ya tiene un cobro en ESTA tarjeta (duplicado)
 if (!recurringModal.editChargeId) {
      const existingCharges = cards[recurringModal.cardId]?.recurringCharges || [];
      const duplicate = existingCharges.find(c =>
        c.serviceKey === recurringValues.serviceKey &&
        c.serviceAccountRef === recurringValues.serviceAccountRef
      );
      if (duplicate) {
        showToast(`Esa cuenta ya tiene un cobro recurrente en esta tarjeta ("${duplicate.description}").`, 'error');
        return;
      }
 }

 // Validación 3: cuenta ya tiene un cobro en OTRA tarjeta
 if (!recurringModal.editChargeId) {
      for (const [otherId, otherCard] of Object.entries(cards)) {
        if (otherId === recurringModal.cardId) continue;
        const otherCharges = otherCard.recurringCharges || [];
        const conflict = otherCharges.find(c =>
          c.serviceKey === recurringValues.serviceKey &&
          c.serviceAccountRef === recurringValues.serviceAccountRef
        );
        if (conflict) {
          const otherLabel = `${otherCard.bank || 'Tarjeta'} ****${otherCard.lastFour || '????'}`;
          showToast(`Esa cuenta ya tiene un cobro en "${otherLabel}". Una cuenta real solo puede estar en una tarjeta.`, 'error');
          return;
        }
      }
 }

 const accountLabel = realAcct ? (realAcct.label || realAcct.serviceAccountRef) : recurringValues.serviceAccountRef;

 try {
      if (recurringModal.editChargeId) {
        // Editar cobro existente
        await updateRecurringCharge(recurringModal.cardId, recurringModal.editChargeId, {
          description: recurringValues.description.trim(),
          amount: parseFloat(recurringValues.amount) || 0,
          billingDay: day,
          accountLabel,
        });
        showToast(`Cobro recurrente "${recurringValues.description}" actualizado`);
      } else {
        // Agregar nuevo
        await addRecurringCharge(recurringModal.cardId, {
          description: recurringValues.description.trim(),
          amount: parseFloat(recurringValues.amount) || 0,
          billingDay: day,
          serviceKey: recurringValues.serviceKey,
          serviceAccountRef: recurringValues.serviceAccountRef,
          accountLabel,
          cardLabel: recurringModal.cardLabel,
        });
        showToast(`Cobro recurrente "${recurringValues.description}" añadido y cuenta real actualizada`);
      }
      setRecurringModal(null);
 } catch (err) {
      showToast('Error: ' + err.message, 'error');
 }
 };

 const handleRemoveRecurring = (cardId, charge) => {
 setConfirmDialog({
      title: <><TrashIcon size={16} /> Eliminar cobro recurrente</>,
      message: `¿Eliminar el cobro recurrente "${charge.description}"${charge.amount ? ` de $${charge.amount}/mes` : ''}?\n\nLos gastos ya generados no se eliminarán.`,
      confirmLabel: <><TrashIcon size={16} /> Sí, eliminar</>,
      onConfirm: async () => {
        await removeRecurringCharge(cardId, charge.id);
        showToast(`Cobro "${charge.description}" eliminado`);
        setConfirmDialog(null);
      },
      onCancel: () => setConfirmDialog(null),
 });
 };

 const handleToggleRecurring = async (cardId, charge) => {
 try {
      await toggleRecurringCharge(cardId, charge.id, !charge.active);
      showToast(`Cobro "${charge.description}" ${charge.active ? 'desactivado' : 'activado'}`);
 } catch (err) {
      showToast('Error: ' + err.message, 'error');
 }
 };

 const pendingAlertCount = alerts.length;

 // ─── PASSWORD REVEAL BUTTON (SVG) ───
 const EyeOpen = () => (
 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--vault-icon-color, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
 </svg>
 );
 const EyeClosed = () => (
 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--vault-icon-color, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
 </svg>
 );
 const CopyIcon = () => (
 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--vault-icon-color, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
 </svg>
 );
 const RevealBtn = ({ fieldKey }) => (
 <button
      className="vault-reveal-btn"
      onClick={() => toggleReveal(fieldKey)}
      title={revealedFields.has(fieldKey) ? 'Ocultar' : 'Mostrar'}
 >
      {revealedFields.has(fieldKey) ? <EyeClosed /> : <EyeOpen />}
 </button>
 );
 const CopyBtn = ({ text, label }) => (
 <button
      className="vault-copy-btn"
      onClick={() => copyToClipboard(text, label)}
      title={`Copiar ${label}`}
 >
      <CopyIcon />
 </button>
 );

 // ─── RENDER ───

 // Pantalla de carga del PIN
 if (pinLoading) {
   return (
     <div className="vault-pin-gate">
       <div className="vault-pin-card">
         <div className="loading-spinner" />
         <p style={{ color: 'var(--text-muted)', marginTop: '12px' }}>Verificando seguridad...</p>
       </div>
     </div>
   );
 }

 // Pantalla de configurar/ingresar PIN
 if (!vaultUnlocked || changingPin) {
   const isSetup = settingPin || changingPin;
   const needsConfirm = isSetup && pinConfirm;
   const title = changingPin
     ? (pinConfirm ? 'Confirma tu nuevo PIN' : 'Ingresa tu nuevo PIN')
     : settingPin
     ? (pinConfirm ? 'Confirma tu PIN' : 'Configura un PIN para la Bóveda')
     : 'Ingresa tu PIN';
   const subtitle = changingPin
     ? (pinConfirm ? 'Repite el nuevo PIN de 4 dígitos' : 'Elige un nuevo PIN de 4 dígitos')
     : settingPin
     ? (pinConfirm ? 'Repite el PIN de 4 dígitos para confirmar' : 'Elige un PIN de 4 dígitos para proteger tus credenciales')
     : 'Ingresa tu PIN de 4 dígitos para desbloquear';

   return (
     <div className="vault-pin-gate">
       <div className="vault-pin-card">
         <div className="vault-pin-icon">
           <LockIcon size={48} />
         </div>
         <h2 className="vault-pin-title">{title}</h2>
         <p className="vault-pin-subtitle">{subtitle}</p>

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
               className={`vault-pin-key ${key === null ? 'empty' : ''} ${key === 'del' ? 'del' : ''}`}
               disabled={key === null}
               onClick={() => {
                 if (key === 'del') {
                   setPinInput(prev => prev.slice(0, -1));
                   setPinError('');
                 } else if (key !== null && pinInput.length < 4) {
                   const newPin = pinInput + key;
                   setPinInput(newPin);
                   setPinError('');
                   if (newPin.length === 4) {
                     setTimeout(() => handlePinSubmit(newPin), 200);
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

         {changingPin && (
           <button
             className="vault-pin-cancel-btn"
             onClick={() => { setChangingPin(false); setPinConfirm(''); setPinInput(''); setPinError(''); }}
           >
             Cancelar
           </button>
         )}

         <div className="vault-pin-footer">
           <LockKeyIcon size={14} />
           <span>Protegido con PIN de 4 dígitos</span>
         </div>
       </div>
     </div>
   );
 }

 // ─── Contenido principal (desbloqueado) ───
 return (
 <>
      <div className="section-header">
        <div className="section-title"> Bóveda — Credenciales y Tarjetas</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {revealedFields.size > 0 && (
            <button className="vault-security-btn hide-all" onClick={handleHideAll} title="Ocultar todos los campos revelados">
              <EyeClosed /> Ocultar todo
            </button>
          )}
          <button className="vault-security-btn change-pin" onClick={() => { setChangingPin(true); setPinInput(''); setPinConfirm(''); setPinError(''); }} title="Cambiar PIN">
            <KeyIcon size={14} /> Cambiar PIN
          </button>
          <button className="vault-security-btn lock" onClick={handleLockVault} title="Bloquear Bóveda">
            <LockIcon size={14} /> Bloquear
          </button>
          {pendingAlertCount > 0 && (
            <span className="badge badge-danger" style={{ fontSize: '12px' }}>
              <DotRed /> {pendingAlertCount} cambio{pendingAlertCount !== 1 ? 's' : ''} pendiente{pendingAlertCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="vault-tabs">
        <button className={`vault-tab ${activeTab === 'credentials' ? 'active' : ''}`} onClick={() => setActiveTab('credentials')}>
           Credenciales de Servicios
          {pendingAlertCount > 0 && <span className="vault-tab-badge">{pendingAlertCount}</span>}
        </button>
        <button className={`vault-tab ${activeTab === 'banks' ? 'active' : ''}`} onClick={() => setActiveTab('banks')}>
          <BankIcon size={16} /> Bancos
        </button>
        <button className={`vault-tab ${activeTab === 'cards' ? 'active' : ''}`} onClick={() => setActiveTab('cards')}>
           Tarjetas de Pago ({Object.keys(allCards).length})
        </button>
        <button className={`vault-tab ${activeTab === 'google' ? 'active' : ''}`} onClick={() => setActiveTab('google')}>
          <EmailIcon size={16} /> Cuentas de Correo
        </button>
        <button className={`vault-tab ${activeTab === 'apppasswords' ? 'active' : ''}`} onClick={() => setActiveTab('apppasswords')}>
          <LockKeyIcon size={16} /> App Passwords
        </button>
      </div>

      {/* Search */}
      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Buscar por nombre, email, servicio, banco, notas, referencia..."
      />

      {/* ═══ TAB: BANCOS ═══ */}
      {activeTab === 'banks' && (
        <BankManager vaultCards={cards} />
      )}

      {/* ═══ TAB: CREDENCIALES ═══ */}
      {activeTab === 'credentials' && (
        <div className="vault-credentials-section">
          {SERVICE_ORDER.map(svc => {
            const accounts = filteredAccounts[svc];
            if (!accounts || accounts.length === 0) {
              // Still show the service header with create button
              if (searchQuery && searchQuery.length >= 2) return null;
            }
            const meta = getServiceMeta(svc);
            const isExpanded = expandedServices.has(svc);
            const isPasswordService = PASSWORD_SERVICES.includes(svc);
            const accts = accounts || [];
            const pendingForService = accts.filter(a => getPendingAlert(a.serviceAccountRef)).length;

            return (
              <div className="vault-service-group" key={svc}>
                <div
                  className={`vault-service-header ${isExpanded ? 'expanded' : ''}`}
                  style={{ '--svc-color': meta.color }}
                  onClick={() => toggleService(svc)}
                >
                  <div className="vault-service-header-left">
                    <img src={meta.logo} alt="" className="vault-service-logo" />
                    <div>
                      <div className="vault-service-name">{meta.name}</div>
                      <div className="vault-service-count">
                        {accts.length} cuenta{accts.length !== 1 ? 's' : ''} real{accts.length !== 1 ? 'es' : ''}
                        {isPasswordService ? ' · Contraseña compartida' : ' · Por invitación'}
                      </div>
                    </div>
                  </div>
                  <div className="vault-service-header-right">
                    {pendingForService > 0 && (
                      <span className="badge badge-danger" style={{ fontSize: '11px' }}>
                        <DotRed /> {pendingForService}
                      </span>
                    )}
                    <span className="vault-chevron">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="vault-accounts-grid">
                    {accts.map(acct => {
                      const secret = getSecret(acct.serviceAccountRef);
                      const pendingAlert = getPendingAlert(acct.serviceAccountRef);
                      const hasPassword = secret?.password;
                      const hasGooglePw = secret?.googlePassword;
                      const pwKey = `pw-${acct.serviceAccountRef}`;
                      const gpKey = `gp-${acct.serviceAccountRef}`;

                      return (
                        <div
                          className={`vault-credential-card ${pendingAlert ? 'has-pending-alert' : ''} ${highlightRef === acct.serviceAccountRef ? 'vault-highlight-pulse' : ''}`}
                          key={acct.id}
                          id={`vault-${acct.serviceAccountRef}`}
                        >
                          {pendingAlert && (
                            <div className="vault-pending-banner">
                              <DotRed /> Cambio de contraseña pendiente
                              <span className="vault-pending-reason">{pendingAlert.title}</span>
                            </div>
                          )}

                          <div className="vault-card-header">
                            <div
                              className="vault-card-label cross-nav-link"
                              onClick={() => onNavigate && onNavigate('subscriptions', { service: svc, accountRef: acct.serviceAccountRef || acct.id })}
                              title="Ir a Suscripciones"
                              style={{ cursor: 'pointer' }}
                            >
                              {acct.label || acct.serviceAccountRef}
                              <LinkIcon size={14} style={{ marginLeft: '6px', opacity: 0.5 }} />
                            </div>
                            <span className="vault-card-ref">{acct.serviceAccountRef}</span>
                          </div>

                          <div className="vault-card-body">
                            <div className="vault-field">
                              <label><EmailIcon size={16} /> Email</label>
                              <div className="vault-field-value">
                                <span>{acct.email || 'N/A'}</span>
                                {acct.email && <button className="vault-copy-btn" onClick={() => copyToClipboard(acct.email, 'Email')}><ClipboardIcon size={16} /></button>}
                              </div>
                            </div>

                            {/* Service password */}
                            {isPasswordService && (
                              <div className="vault-field">
                                <label> Contraseña del servicio</label>
                                <div className="vault-field-value">
                                  {hasPassword ? (
                                    <>
                                      <span className={`vault-password ${revealedFields.has(pwKey) ? 'revealed' : ''}`}>
                                        {revealedFields.has(pwKey) ? secret.password : '••••••••••••'}
                                      </span>
                                      <RevealBtn fieldKey={pwKey} />
                                      <CopyBtn text={secret.password} label="Contraseña" />
                                    </>
                                  ) : <span className="vault-no-data">Sin contraseña</span>}
                                </div>
                              </div>
                            )}

                            {/* Google password */}
                            {hasGooglePw && (
                              <div className="vault-field">
                                <label> {getEmailLabel(acct.email)}</label>
                                <div className="vault-field-value">
                                  <span className={`vault-password ${revealedFields.has(gpKey) ? 'revealed' : ''}`}>
                                    {revealedFields.has(gpKey) ? secret.googlePassword : '••••••••••••'}
                                  </span>
                                  <RevealBtn fieldKey={gpKey} />
                                  <CopyBtn text={secret.googlePassword} label={getEmailLabel(acct.email)} />
                                </div>
                              </div>
                            )}

                            {acct.cardLabel && (
                              <div className="vault-field">
                                <label><CreditCardIcon size={16} /> Tarjeta de cobro</label>
                                <div className="vault-field-value">
                                  <span className="vault-card-link" onClick={() => { setActiveTab('cards'); const matchId = Object.entries(allCards).find(([, c]) => c.label === acct.cardLabel)?.[0]; if (matchId) setExpandedCards(new Set([matchId])); }}>
                                    {acct.cardLabel}
                                  </span>
                                </div>
                              </div>
                            )}

                            {acct.monthlyCost > 0 && (
                              <div className="vault-field">
                                <label><CashIcon size={16} /> Costo</label>
                                <div className="vault-field-value">${acct.monthlyCost}/mes</div>
                              </div>
                            )}

                            {secret?.notes && (
                              <div className="vault-field">
                                <label> Notas</label>
                                <div className="vault-field-value vault-notes">{secret.notes}</div>
                              </div>
                            )}
                          </div>

                          <div className="vault-card-actions">
                            <button
                              className={`vault-action-btn ${pendingAlert ? 'urgent' : 'edit'}`}
                              onClick={() => openCredentialEdit(acct, svc)}
                            >
                              {pendingAlert ? <><LockKeyIcon size={16} /> Cambiar contraseña</> : <><EditIcon size={16} /> Editar</>}
                            </button>
                            <button
                              className="vault-action-btn view"
                              onClick={() => onNavigate && onNavigate('subscriptions', { service: svc, accountRef: acct.serviceAccountRef || acct.id })}
                            >
                              <LinkIcon size={16} /> Suscripciones
                            </button>
                            <button className="vault-action-btn delete" onClick={() => handleDeleteAccount(acct, svc)}>
                              <TrashIcon size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {/* Create new account */}
                    <div className="vault-create-card" onClick={() => openCreateAccount(svc)}>
                       Nueva cuenta real
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ TAB: TARJETAS ═══ */}
      {activeTab === 'cards' && (
        <div className="vault-cards-section">
          {Object.entries(allCards)
            .filter(([cardId, info]) => {
              if (!searchQuery || searchQuery.length < 2) return true;
              const q = normalizeSearch(searchQuery);
              return nMatch(info.label, q) ||
                (info.cardData?.recurringCharges || []).some(c => nMatch(c.description, q) || nMatch(c.accountLabel, q));
            })
            .sort(([, a], [, b]) => a.label.localeCompare(b.label))
            .map(([cardId, info]) => {
              const cardLabel = info.label;
              const card = getCard(cardId);
              const bankName = cardLabel.split(' ****')[0] || cardLabel;
              const bankMeta = getBankMeta(bankName);
              const lastFour = (cardLabel.match(/\*{4}(\d{4})/) || [])[1] || '????';
              const isExpanded = expandedCards.has(cardId);

              return (
                <div className="vault-card-payment" key={cardId}>
                  <div className="vault-payment-header vault-payment-toggle" style={{ '--bank-color': bankMeta.color }} onClick={() => toggleCardExpand(cardId)}>
                    <div className="vault-payment-top">
                      {bankMeta.logo && <img src={bankMeta.logo} alt="" className="vault-bank-logo" onError={e => { e.target.style.display = 'none'; }} />}
                      <div>
                        <div className="vault-payment-bank">{bankName}</div>
                        <div className="vault-payment-last4">**** **** **** {lastFour}</div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {(() => { const charges = cards[cardId]?.recurringCharges || []; const activeCount = charges.filter(c => c.active).length; return activeCount > 0 ? `${activeCount} cobro${activeCount !== 1 ? 's' : ''} recurrente${activeCount !== 1 ? 's' : ''}` : 'Sin cobros recurrentes'; })()}
                          {card?.expiry && ` · Exp: ${card.expiry}`}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="vault-chevron">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  <div className={`vault-payment-body ${isExpanded ? 'expanded' : ''}`}>
                    {card && (
                      <div className="vault-payment-details">
                        <div className="vault-field">
                          <label> Número de tarjeta</label>
                          <div className="vault-field-value">
                            <span className={`vault-password ${revealedFields.has(`card-num-${cardId}`) ? 'revealed' : ''}`}>
                              {revealedFields.has(`card-num-${cardId}`) ? formatCardNumber(card.number) || 'No registrado' : `**** **** **** ${lastFour}`}
                            </span>
                            {card.number && (
                              <>
                                <RevealBtn fieldKey={`card-num-${cardId}`} />
                                <CopyBtn text={card.number} label="Número" />
                              </>
                            )}
                          </div>
                        </div>
                        <div className="vault-field">
                          <label> CVV</label>
                          <div className="vault-field-value">
                            <span className={`vault-password ${revealedFields.has(`card-cvv-${cardId}`) ? 'revealed' : ''}`}>
                              {revealedFields.has(`card-cvv-${cardId}`) ? card.cvv || 'N/A' : '•••'}
                            </span>
                            {card.cvv && (
                              <>
                                <RevealBtn fieldKey={`card-cvv-${cardId}`} />
                                <CopyBtn text={card.cvv} label="CVV" />
                              </>
                            )}
                          </div>
                        </div>
                        {card.expiry && <div className="vault-field"><label><CalendarIcon size={16} /> Expiración</label><div className="vault-field-value">{card.expiry}</div></div>}
                        {card.holder && <div className="vault-field"><label><UserIcon size={16} /> Titular</label><div className="vault-field-value">{card.holder}</div></div>}
                        {card.notes && <div className="vault-field"><label><NotesIcon size={16} /> Notas</label><div className="vault-field-value vault-notes">{card.notes}</div></div>}
                      </div>
                    )}

                    {/* Cobros recurrentes (unifica cuentas vinculadas + cobros) */}
                    {(() => {
                      const rawCard = cards[cardId];
                      const charges = [...(rawCard?.recurringCharges || [])].sort((a, b) => (a.billingDay || 0) - (b.billingDay || 0));
                      const totalRecurring = charges.filter(c => c.active).reduce((s, c) => s + (c.amount || 0), 0);
                      return (
                        <div className="vault-linked-section">
                          <div className="vault-linked-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span><RefreshIcon size={16} /> Cobros recurrentes ({charges.length}){totalRecurring > 0 && <span style={{ fontWeight: 400, fontSize: '12px', color: 'var(--text-muted)', marginLeft: '6px' }}>· ${totalRecurring.toFixed(2)}/mes</span>}</span>
                            <button className="vault-action-btn edit" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => openRecurringModal(cardId, cardLabel)}>
                              <PlusIcon size={14} /> Agregar
                            </button>
                          </div>
                          {charges.length > 0 ? (
                            <div className="vault-linked-list">
                              {charges.map((charge, ci) => (
                                <div className={`vault-linked-item ${!charge.active ? 'vault-recurring-inactive' : ''}`} key={charge.id || ci} style={{ flexWrap: 'wrap', gap: '6px' }}>
                                  {charge.serviceKey && <img src={getServiceMeta(charge.serviceKey).logo} alt="" className="vault-linked-logo" />}
                                  <div className="vault-linked-info" style={{ flex: 1 }}>
                                    <span className="vault-linked-label">{charge.description}</span>
                                    <span className="vault-linked-email">
                                      <CalendarIcon size={14} /> Día {charge.billingDay} de cada mes
                                      {charge.serviceKey && <> · {getServiceMeta(charge.serviceKey).name}</>}
                                      {charge.accountLabel && <> · {charge.accountLabel}</>}
                                    </span>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span className={`vault-linked-cost ${!charge.active ? 'vault-cost-inactive' : ''}`}>
                                      {charge.amount > 0 ? `$${charge.amount}/mes` : 'Monto pendiente'}
                                    </span>
                                    <button
                                      className="vault-copy-btn"
                                      onClick={() => openEditRecurringModal(cardId, cardLabel, charge)}
                                      title="Editar cobro"
                                    >
                                      <EditIcon size={14} />
                                    </button>
                                    <button
                                      className="vault-copy-btn"
                                      onClick={() => handleToggleRecurring(cardId, charge)}
                                      title={charge.active ? 'Desactivar' : 'Activar'}
                                    >
                                      {charge.active ? <ToggleOnIcon size={16} /> : <ToggleOffIcon size={16} />}
                                    </button>
                                    <button
                                      className="vault-copy-btn"
                                      onClick={() => handleRemoveRecurring(cardId, charge)}
                                      title="Eliminar cobro"
                                    >
                                      <TrashIcon size={14} />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 12px' }}>
                              Sin cobros recurrentes. Agrega uno para generar gastos automáticos cada mes.
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Card actions */}
                    <div className="vault-card-actions">
                      <button className="vault-action-btn edit" onClick={() => openCardEdit(cardId, cardLabel)}><EditIcon size={16} /> Editar</button>
                      <button className="vault-action-btn delete" onClick={() => handleDeleteCard(cardId, cardLabel)}><TrashIcon size={16} /> Eliminar</button>
                    </div>
                  </div>
                </div>
              );
            })}

          {/* Create new card */}
          <div className="vault-create-card" onClick={openCreateCard}>
             Nueva tarjeta de pago
          </div>
        </div>
      )}

      {/* ═══ TAB: CUENTAS DE CORREO ═══ */}
      {activeTab === 'google' && (() => {
        // Unificar todas las cuentas de correo: lank_google + tertiary
        const allEmailAccounts = Object.entries(secrets)
          .filter(([, s]) => s.type === 'lank_google' || s.type === 'tertiary')
          .map(([id, s]) => ({
            id,
            email: s.email || '',
            fullName: s.fullName || '',
            canonicalAlias: s.canonicalAlias || '',
            lankAccountId: s.lankAccountId || '',
            password: s.type === 'lank_google'
              ? (s.googlePassword ? decrypt(s.googlePassword) : '')
              : (s.password ? decrypt(s.password) : ''),
            notes: s.notes || '',
            type: s.type,
            isPrincipal: s.type === 'lank_google' && !!s.lankAccountId,
            updatedAt: s.updatedAt || '',
          }))
          .sort((a, b) => {
            // Principales primero (por lankAccountId), luego secundarias alfabéticamente
            if (a.isPrincipal && !b.isPrincipal) return -1;
            if (!a.isPrincipal && b.isPrincipal) return 1;
            if (a.isPrincipal && b.isPrincipal) {
              return (parseInt(a.lankAccountId) || 999) - (parseInt(b.lankAccountId) || 999);
            }
            return a.email.localeCompare(b.email);
          });

        // Filtrar por búsqueda
        const filteredAccts = searchQuery && searchQuery.length >= 2
          ? allEmailAccounts.filter(s => {
              const q = normalizeSearch(searchQuery);
              return nMatch(s.email, q) || nMatch(s.fullName, q) ||
                     nMatch(s.canonicalAlias, q) || nMatch(s.notes, q);
            })
          : allEmailAccounts;

        // Agrupar: principales vs secundarias
        const principals = filteredAccts.filter(a => a.isPrincipal);
        const secondaries = filteredAccts.filter(a => !a.isPrincipal);

        // Encontrar servicios vinculados para cada email
        const getLinkedServices = (email) => {
          if (!email) return [];
          const normalEmail = normalizeVaultEmail(email);
          const linked = [];
          for (const [svc, accts] of Object.entries(pools)) {
            for (const acct of accts) {
              if (normalizeVaultEmail(acct.email) === normalEmail) {
                linked.push({ serviceKey: svc, label: acct.label || acct.serviceAccountRef, ref: acct.serviceAccountRef });
              }
            }
          }
          return linked;
        };

        // Render de una card de cuenta de correo
        const renderEmailCard = (s) => {
          const pwKey = `em-${s.id}`;
          const linkedServices = getLinkedServices(s.email);
          return (
            <div className="vault-credential-card" key={s.id}>
              <div className="vault-card-header">
                <div className="vault-card-label">{s.fullName || s.canonicalAlias || s.email}</div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  {s.isPrincipal && <span className="vault-card-ref">Lank #{s.lankAccountId}</span>}
                  {!s.isPrincipal && <span className="vault-card-ref" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Secundaria</span>}
                </div>
              </div>
              <div className="vault-card-body">
                <div className="vault-field">
                  <label><EmailIcon size={16} /> Email</label>
                  <div className="vault-field-value">
                    <span>{s.email}</span>
                    <button className="vault-copy-btn" onClick={() => copyToClipboard(s.email, 'Email')}><ClipboardIcon size={16} /></button>
                  </div>
                </div>
                <div className="vault-field">
                  <label> Contraseña del correo</label>
                  <div className="vault-field-value">
                    {s.password ? (
                      <>
                        <span className={`vault-password ${revealedFields.has(pwKey) ? 'revealed' : ''}`}>
                          {revealedFields.has(pwKey) ? s.password : '••••••••••••'}
                        </span>
                        <RevealBtn fieldKey={pwKey} />
                        <CopyBtn text={s.password} label="Contraseña" />
                      </>
                    ) : <span className="vault-no-data">Sin contraseña</span>}
                  </div>
                </div>
                {s.notes && (
                  <div className="vault-field">
                    <label><NotesIcon size={16} /> Notas</label>
                    <div className="vault-field-value vault-notes">{s.notes}</div>
                  </div>
                )}
                {linkedServices.length > 0 && (
                  <div className="vault-field">
                    <label><LinkIcon size={16} /> Servicios vinculados</label>
                    <div className="vault-linked-services">
                      {linkedServices.map(ls => (
                        <span key={ls.ref} className="vault-linked-chip" title={ls.ref}>
                          {getServiceMeta(ls.serviceKey).name} — {ls.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="vault-card-actions">
                <button className="vault-action-btn edit" onClick={() => {
                  setGoogleEditValues({ email: s.email, password: s.password, notes: s.notes, fullName: s.fullName || '', canonicalAlias: s.canonicalAlias || '', whatsapp: s.whatsapp || '' });
                  setGoogleEditModal({ id: s.id, type: s.type, email: s.email, isPrincipal: s.isPrincipal, lankAccountId: s.lankAccountId });
                }}>
                  <EditIcon size={16} /> Editar
                </button>
                {s.isPrincipal && (
                  <button className="vault-action-btn view" onClick={() => onNavigate && onNavigate('accounts', s.lankAccountId)}>
                     Ver cuenta Lank
                  </button>
                )}
              </div>
            </div>
          );
        };

        return (
          <div className="vault-credentials-section">
            {/* Barra de acciones superior */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
              {/* Seed button — solo si no hay cuentas */}
              {allEmailAccounts.filter(a => a.isPrincipal).length === 0 && (
                <button
                  className="vault-action-btn create"
                  style={{ padding: '10px 20px', fontSize: '13px' }}
                  onClick={async () => {
                    if (seeding) return;
                    setSeeding(true);
                    try {
                      const res = await seedGooglePasswords();
                      showToast(`Cuentas Google: ${res.created} creadas, ${res.updated} actualizadas`);
                    } catch (err) {
                      showToast('Error: ' + err.message, 'error');
                    }
                    setSeeding(false);
                  }}
                  disabled={seeding}
                >
                  {seeding ? <><HourglassIcon size={16} /> Cargando...</> : <><SeedlingIcon size={16} /> Cargar cuentas Lank</>}
                </button>
              )}
              <button
                className="vault-action-btn create"
                style={{ padding: '10px 20px', fontSize: '13px' }}
                onClick={() => {
                  setGoogleCreateValues({ type: 'lank_google', lankAccountId: '', email: '', password: '', notes: '' });
                  setGoogleCreateModal({ type: 'lank_google' });
                }}
              >
                <PlusIcon size={16} /> Nueva cuenta principal
              </button>
              <button
                className="vault-action-btn create"
                style={{ padding: '10px 20px', fontSize: '13px' }}
                onClick={() => {
                  setGoogleCreateValues({ type: 'tertiary', lankAccountId: '', email: '', password: '', notes: '' });
                  setGoogleCreateModal({ type: 'tertiary' });
                }}
              >
                <PlusIcon size={16} /> Nueva cuenta secundaria
              </button>
            </div>

            {/* Cuentas Principales (Lank) */}
            <div className="vault-service-group">
              <div
                className={`vault-service-header ${expandedGoogleAccounts.has('lank') ? 'expanded' : ''}`}
                style={{ '--svc-color': '#4285f4' }}
                onClick={() => {
                  setExpandedGoogleAccounts(prev => {
                    const next = new Set(prev);
                    if (next.has('lank')) next.delete('lank');
                    else next.add('lank');
                    return next;
                  });
                }}
              >
                <div className="vault-service-header-left">
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: 'linear-gradient(135deg, #4285f4, #34a853, #fbbc04, #ea4335)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 18 }}>G</div>
                  <div>
                    <div className="vault-service-name">Cuentas Principales</div>
                    <div className="vault-service-count">{principals.length} cuentas · Vinculadas a Lank</div>
                  </div>
                </div>
                <div className="vault-service-header-right">
                  <span className="vault-chevron">{expandedGoogleAccounts.has('lank') ? '▲' : '▼'}</span>
                </div>
              </div>

              {expandedGoogleAccounts.has('lank') && (
                <div className="vault-accounts-grid">
                  {principals.length > 0 ? principals.map(renderEmailCard) : (
                    <div className="empty-state" style={{ padding: '20px' }}>
                      <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No hay cuentas principales. Usa el botón "Nueva cuenta principal" o "Cargar cuentas Lank".</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Cuentas Secundarias */}
            <div className="vault-service-group">
              <div
                className={`vault-service-header ${expandedGoogleAccounts.has('tertiary') ? 'expanded' : ''}`}
                style={{ '--svc-color': '#f59e0b' }}
                onClick={() => {
                  setExpandedGoogleAccounts(prev => {
                    const next = new Set(prev);
                    if (next.has('tertiary')) next.delete('tertiary');
                    else next.add('tertiary');
                    return next;
                  });
                }}
              >
                <div className="vault-service-header-left">
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>S</div>
                  <div>
                    <div className="vault-service-name">Cuentas Secundarias</div>
                    <div className="vault-service-count">{secondaries.length} cuentas · Correos auxiliares sin Lank</div>
                  </div>
                </div>
                <div className="vault-service-header-right">
                  <span className="vault-chevron">{expandedGoogleAccounts.has('tertiary') ? '▲' : '▼'}</span>
                </div>
              </div>

              {expandedGoogleAccounts.has('tertiary') && (
                <div className="vault-accounts-grid">
                  {secondaries.length > 0 ? secondaries.map(renderEmailCard) : (
                    <div className="empty-state" style={{ padding: '20px' }}>
                      <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No hay cuentas secundarias. Usa el botón "Nueva cuenta secundaria" para crear una.</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {filteredAccts.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon"><EmailIcon size={16} /></div>
                <p>No se encontraron cuentas de correo. Utiliza "Cargar cuentas Lank" para poblar los datos o crea una cuenta principal o secundaria.</p>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ TAB: APP PASSWORDS ═══ */}
      {activeTab === 'apppasswords' && (() => {
        if (imapLoading || imapCredentials === null) {
          return (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div className="loading-spinner" />
              <p style={{ color: 'var(--text-muted)', marginTop: '12px' }}>Cargando App Passwords...</p>
            </div>
          );
        }

        // Match IMAP accounts with Lank Google secrets
        const googleSecrets = Object.entries(secrets)
          .filter(([, s]) => s.type === 'lank_google')
          .map(([id, s]) => ({
            id, email: s.email || '', fullName: s.fullName || '',
            canonicalAlias: s.canonicalAlias || '', lankAccountId: s.lankAccountId || '',
          }));

        const filteredImap = searchQuery && searchQuery.length >= 2
          ? imapCredentials.filter(a => {
              const q = normalizeSearch(searchQuery);
              const linked = googleSecrets.find(g =>
                g.email === a.email || g.lankAccountId === String(a.accountId)
              );
              return nMatch(a.email, q) ||
                     String(a.accountId || '').includes(q) ||
                     nMatch(linked?.canonicalAlias, q) ||
                     nMatch(linked?.fullName, q) ||
                     (linked?.lankAccountId || '').includes(q);
            })
          : imapCredentials;

        return (
          <div className="vault-credentials-section">
            <div className="vault-service-group">
              <div className="vault-service-header expanded" style={{ '--svc-color': '#4285f4', cursor: 'default' }}>
                <div className="vault-service-header-left">
                  <img src="/assets/Gmail.png" alt="Gmail" className="vault-service-logo" onError={e => { e.target.style.display = 'none'; }} />
                  <div>
                    <div className="vault-service-name">App Passwords de Gmail (IMAP)</div>
                    <div className="vault-service-count">{imapCredentials.length} cuentas configuradas — Usadas para analizar correos</div>
                  </div>
                </div>
                <div className="vault-service-header-right">
                  <button
                    className="vault-action-btn edit"
                    style={{ fontSize: '12px', padding: '4px 10px' }}
                    onClick={(e) => { e.stopPropagation(); loadImapCredentials(); }}
                    title="Recargar"
                  >
                    <RefreshIcon size={14} />
                  </button>
                </div>
              </div>

              <div className="vault-accounts-grid" style={{ display: 'grid' }}>
                {filteredImap.map((account, idx) => {
                  const isEditing = editingAppPw?.index === idx;
                  const pwKey = `appPw-${idx}`;
                  const isRevealed = revealedFields.has(pwKey);
                  const linkedGoogle = googleSecrets.find(g =>
                    g.email === account.email || g.lankAccountId === String(account.accountId)
                  );
                  const isEnabled = account.enabled !== false;

                  return (
                    <div
                      key={idx}
                      className={`vault-credential-card ${!isEnabled ? 'vault-recurring-inactive' : ''}`}
                      style={{ opacity: isEnabled ? 1 : 0.6 }}
                    >
                      <div className="vault-card-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                          <EmailIcon size={16} />
                          <div className="vault-card-label" style={{ fontSize: '13px' }}>{account.email}</div>
                        </div>
                        {!isEnabled && (
                          <span style={{ fontSize: '10px', color: '#ef4444', fontWeight: 600, background: 'rgba(239,68,68,.1)', padding: '2px 6px', borderRadius: '4px' }}>
                            Deshabilitada
                          </span>
                        )}
                      </div>
                      <div className="vault-card-body">
                        <div className="vault-field">
                          <label><HashIcon size={12} /> Account ID</label>
                          <span>{account.accountId}</span>
                        </div>
                        {linkedGoogle && (
                          <div className="vault-field">
                            <label><UserIcon size={12} /> Cuenta Lank</label>
                            <span>
                              {linkedGoogle.canonicalAlias || linkedGoogle.fullName}
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '6px' }}>
                                (#{linkedGoogle.lankAccountId})
                              </span>
                            </span>
                          </div>
                        )}
                        <div className="vault-field">
                          <label><LockKeyIcon size={12} /> App Password</label>
                          <div className="vault-field-value">
                            <span className={`vault-password ${isRevealed ? 'revealed' : ''}`}>
                              {isRevealed ? formatAppPassword(account.appPassword || '') : '•••• •••• •••• ••••'}
                            </span>
                            <RevealBtn fieldKey={pwKey} />
                            {isRevealed && <CopyBtn text={cleanAppPassword(account.appPassword || '')} label="App Password" />}
                          </div>
                        </div>
                      </div>
                      <div className="vault-card-actions">
                        <button
                          className="vault-action-btn edit"
                          onClick={() => setEditingAppPw({
                            index: idx,
                            email: account.email,
                            appPassword: account.appPassword || '',
                            accountId: account.accountId,
                            enabled: account.enabled !== false,
                          })}
                        >
                          <EditIcon size={14} /> Editar
                        </button>
                        <button
                          className={`vault-action-btn ${isEnabled ? 'view' : 'edit'}`}
                          onClick={async () => {
                            const updated = [...imapCredentials];
                            updated[idx] = { ...updated[idx], enabled: !isEnabled };
                            try {
                              await updateDoc(doc(db, 'config', 'imap-credentials'), { accounts: updated });
                              setImapCredentials(updated);
                              showToast(isEnabled ? 'Cuenta deshabilitada' : 'Cuenta habilitada');
                            } catch (err) {
                              showToast('Error: ' + err.message, 'error');
                            }
                          }}
                        >
                          {isEnabled ? <><ToggleOnIcon size={14} /> Habilitada</> : <><ToggleOffIcon size={14} /> Deshabilitada</>}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {filteredImap.length === 0 && (
              <div className="vault-no-data">
                <LockKeyIcon size={24} />
                <span>No hay App Passwords configuradas</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ MODAL: Editar App Password ═══ */}
      {editingAppPw && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onMouseUp={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setEditingAppPw(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3><LockKeyIcon size={18} /> Editar App Password</h3>
              <button className="vault-modal-close" onClick={() => setEditingAppPw(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-body">
              <div className="vault-form-group">
                <label><EmailIcon size={16} /> Email</label>
                <input type="text" value={editingAppPw.email} readOnly style={{ opacity: 0.6 }} />
              </div>
              <div className="vault-form-group">
                <label><HashIcon size={16} /> Account ID</label>
                <input type="text" value={editingAppPw.accountId} readOnly style={{ opacity: 0.6 }} />
              </div>
              <div className="vault-form-group">
                <label><LockKeyIcon size={16} /> App Password</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('modal-appPw') ? 'text' : 'password'}
                    value={revealedFields.has('modal-appPw') ? formatAppPassword(editingAppPw.appPassword) : editingAppPw.appPassword}
                    onChange={e => {
                      const cleaned = cleanAppPassword(e.target.value);
                      setEditingAppPw(p => ({ ...p, appPassword: cleaned }));
                    }}
                    placeholder="xxxx xxxx xxxx xxxx"
                    maxLength={19}
                    autoComplete="off"
                  />
                  <RevealBtn fieldKey="modal-appPw" />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Google Account → Seguridad → Contraseñas de aplicación
                  </span>
                  <span style={{ fontSize: '11px', color: cleanAppPassword(editingAppPw.appPassword).length === 16 ? '#10b981' : 'var(--text-muted)', fontWeight: 500 }}>
                    {cleanAppPassword(editingAppPw.appPassword).length}/16
                  </span>
                </div>
              </div>
              <div className="vault-form-group">
                <label><ToggleOnIcon size={16} /> Estado</label>
                <select
                  value={editingAppPw.enabled ? 'true' : 'false'}
                  onChange={e => setEditingAppPw(p => ({ ...p, enabled: e.target.value === 'true' }))}
                >
                  <option value="true">Habilitada</option>
                  <option value="false">Deshabilitada</option>
                </select>
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setEditingAppPw(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveAppPassword} disabled={appPwSaving}>
                {appPwSaving ? <><HourglassIcon size={16} /> Guardando...</> : <><SaveIcon size={16} /> Guardar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Editar Credencial ═══ */}
      {editModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setEditModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3>{editModal.pendingAlert ? <><LockKeyIcon size={16} /> Cambiar contraseña</> : <><EditIcon size={16} /> Editar credencial</>}</h3>
              <button className="vault-modal-close" onClick={() => setEditModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-meta">
              <span><EmailIcon size={16} /> {editModal.acct.email}</span>
              <span><LinkIcon size={16} /> {editModal.acct.serviceAccountRef}</span>
            </div>
            {editModal.pendingAlert && (
              <div className="vault-modal-alert-banner"><WarningIcon size={16} /> <strong>Alerta pendiente:</strong> {editModal.pendingAlert.description}</div>
            )}
            <div className="vault-modal-form">
              <div className="vault-form-row">
                <div className="vault-form-group">
                  <label><BadgeIcon size={16} /> Nombre / Label</label>
                  <input type="text" value={editValues.label} onChange={e => setEditValues(p => ({ ...p, label: e.target.value }))} placeholder="Nombre de la cuenta" />
                </div>
                <div className="vault-form-group">
                  <label><EmailIcon size={16} /> Email</label>
                  <input type="email" value={editValues.email} onChange={e => setEditValues(p => ({ ...p, email: e.target.value }))} placeholder="correo@ejemplo.com" />
                </div>
              </div>
              <div className="vault-form-group">
                <label><LockKeyIcon size={16} /> Contraseña del servicio</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('modal-pw') ? 'text' : 'password'}
                    value={editValues.password}
                    onChange={e => setEditValues(p => ({ ...p, password: e.target.value }))}
                    placeholder="Contraseña del servicio" autoComplete="off"
                  />
                  <RevealBtn fieldKey="modal-pw" />
                </div>
              </div>
              <div className="vault-form-group">
                <label> {getEmailLabel(editModal.acct.email)}</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('modal-gp') ? 'text' : 'password'}
                    value={editValues.googlePassword}
                    onChange={e => setEditValues(p => ({ ...p, googlePassword: e.target.value }))}
                    placeholder={`${getEmailLabel(editModal.acct.email)}`} autoComplete="off"
                  />
                  <RevealBtn fieldKey="modal-gp" />
                </div>
              </div>
              <div className="vault-form-group">
                <label><NotesIcon size={16} /> Notas</label>
                <textarea value={editValues.notes} onChange={e => setEditValues(p => ({ ...p, notes: e.target.value }))} placeholder="Notas..." rows={2} />
              </div>
              {editModal.secret?.passwordHistory?.length > 0 && (
                <div className="vault-history-section">
                  <label> Historial ({editModal.secret.passwordHistory.length})</label>
                  <div className="vault-history-list">
                    {editModal.secret.passwordHistory.slice(-5).reverse().map((h, i) => (
                      <div className="vault-history-item" key={i}>
                        <span className="vault-history-date">
                          {new Date(h.changedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="vault-history-label">Contraseña cambiada</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setEditModal(null)}>Cancelar</button>
              <button className={`vault-modal-btn ${editModal.pendingAlert ? 'urgent' : 'save'}`} onClick={confirmCredentialSave}>
                {editModal.pendingAlert ? <><LockKeyIcon size={16} /> Cambiar y completar</> : <><SaveIcon size={16} /> Guardar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Editar Tarjeta ═══ */}
      {cardEditModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setCardEditModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3><CreditCardIcon size={16} /> Editar tarjeta</h3>
              <button className="vault-modal-close" onClick={() => setCardEditModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-meta"><span><CreditCardIcon size={16} /> {cardEditModal.cardLabel}</span></div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label><BankIcon size={16} /> Banco / Emisor</label>
                <input type="text" value={cardEditValues.bank} onChange={e => setCardEditValues(p => ({ ...p, bank: e.target.value }))} placeholder="Nu Crédito" />
              </div>
              <div className="vault-form-group">
                <label><CreditCardIcon size={16} /> Número de tarjeta</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('modal-card-num') ? 'text' : 'password'}
                    value={revealedFields.has('modal-card-num') ? formatCardNumber(cardEditValues.number) : cardEditValues.number}
                    onChange={e => {
                      const cleaned = cleanCardNumber(e.target.value);
                      setCardEditValues(p => ({ ...p, number: cleaned }));
                    }}
                    placeholder="1234 5678 9012 3456" autoComplete="off"
                  />
                  <RevealBtn fieldKey="modal-card-num" />
                </div>
                {cardEditValues.number && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Últimos 4: {getLast4(cardEditValues.number)} · {cleanCardNumber(cardEditValues.number).length}/16 dígitos
                  </span>
                )}
              </div>
              <div className="vault-form-row">
                <div className="vault-form-group">
                  <label><CalendarIcon size={16} /> Expiración</label>
                  <input type="text" value={cardEditValues.expiry} onChange={e => setCardEditValues(p => ({ ...p, expiry: e.target.value }))} placeholder="MM/AA" />
                </div>
                <div className="vault-form-group">
                  <label><LockIcon size={16} /> CVV</label>
                  <div className="vault-password-input-group">
                    <input type={revealedFields.has('modal-card-cvv') ? 'text' : 'password'} value={cardEditValues.cvv} maxLength={4} onChange={e => setCardEditValues(p => ({ ...p, cvv: e.target.value }))} placeholder="•••" autoComplete="off" />
                    <RevealBtn fieldKey="modal-card-cvv" />
                  </div>
                </div>
              </div>
              <div className="vault-form-group">
                <label><UserIcon size={16} /> Titular</label>
                <input type="text" value={cardEditValues.holder} onChange={e => setCardEditValues(p => ({ ...p, holder: e.target.value }))} placeholder="Nombre del titular" />
              </div>
              <div className="vault-form-group">
                <label><NotesIcon size={16} /> Notas</label>
                <textarea value={cardEditValues.notes} onChange={e => setCardEditValues(p => ({ ...p, notes: e.target.value }))} placeholder="Notas..." rows={2} />
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setCardEditModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={confirmCardSave}><SaveIcon size={16} /> Guardar tarjeta</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Crear Cuenta Real / Tarjeta ═══ */}
      {createModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setCreateModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3>{createModal.mode === 'card' ? ' Nueva tarjeta de pago' : <><PlusIcon size={16} /> Nueva cuenta real — {getServiceMeta(createModal.serviceKey).name}</>}</h3>
              <button className="vault-modal-close" onClick={() => setCreateModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form" style={{ paddingTop: '16px' }}>
              {createModal.mode === 'account' ? (
                <>
                  <div className="vault-form-row">
                    <div className="vault-form-group">
                      <label><BadgeIcon size={16} /> Label / Nombre</label>
                      <input type="text" value={createValues.label} onChange={e => setCreateValues(p => ({ ...p, label: e.target.value }))} placeholder="Mi cuenta ChatGPT" />
                    </div>
                  </div>

                  {/* ─── Email Source Selector ─── */}
                  <div className="vault-form-group">
                    <label><LinkIcon size={16} /> Cuenta de correo</label>
                    <select
                      value={createValues.emailSource}
                      onChange={e => {
                        const val = e.target.value;
                        setCreateValues(p => ({
                          ...p,
                          emailSource: val,
                          // Auto-fill email when selecting a vault email
                          email: val.startsWith('vault_')
                            ? (secrets[val.replace('vault_', '')]?.email || '')
                            : (val === 'new' ? '' : p.email),
                          googlePassword: '', // Reset - will be auto-filled from vault
                          newEmailPassword: '',
                          newEmailNotes: '',
                        }));
                      }}
                    >
                      <option value="">Ingresar manualmente</option>
                      <optgroup label="📧 Cuentas principales (Lank)">
                        {vaultEmailOptions.filter(e => e.isPrincipal).map(opt => (
                          <option key={opt.id} value={`vault_${opt.id}`}>
                            {opt.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="📬 Cuentas secundarias">
                        {vaultEmailOptions.filter(e => !e.isPrincipal).map(opt => (
                          <option key={opt.id} value={`vault_${opt.id}`}>
                            {opt.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="➕ Crear nueva">
                        <option value="new">Email no listado (crear nuevo)</option>
                      </optgroup>
                    </select>
                    {createValues.emailSource && createValues.emailSource.startsWith('vault_') && (
                      <span style={{ fontSize: '11px', color: 'var(--accent)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <LinkIcon size={12} /> Vinculada — la contraseña del email se sincroniza automáticamente desde la bóveda
                      </span>
                    )}
                  </div>

                  {/* ─── Conditional fields based on emailSource ─── */}
                  {createValues.emailSource === 'new' ? (
                    <>
                      {/* Creating a new secondary email inline */}
                      <div className="vault-form-group">
                        <label><EmailIcon size={16} /> Email del servicio</label>
                        <input type="email" value={createValues.email} onChange={e => setCreateValues(p => ({ ...p, email: e.target.value }))} placeholder="correo@gmail.com" autoComplete="off" />
                      </div>
                      <div className="vault-form-group">
                        <label><KeyIcon size={16} /> {getEmailLabel(createValues.email)}</label>
                        <div className="vault-password-input-group">
                          <input type={revealedFields.has('create-new-ep') ? 'text' : 'password'} value={createValues.newEmailPassword} onChange={e => setCreateValues(p => ({ ...p, newEmailPassword: e.target.value }))} placeholder="Contraseña del proveedor de correo" autoComplete="off" />
                          <RevealBtn fieldKey="create-new-ep" />
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          Se creará una nueva cuenta de correo secundaria en la bóveda automáticamente
                        </span>
                      </div>
                      {createModal.accessType === 'credentials' && (
                        <div className="vault-form-group">
                          <label><LockKeyIcon size={16} /> Contraseña del servicio</label>
                          <div className="vault-password-input-group">
                            <input type={revealedFields.has('create-pw') ? 'text' : 'password'} value={createValues.password} onChange={e => setCreateValues(p => ({ ...p, password: e.target.value }))} placeholder="Contraseña del servicio" autoComplete="off" />
                            <RevealBtn fieldKey="create-pw" />
                          </div>
                        </div>
                      )}
                      <div className="vault-form-group">
                        <label><NotesIcon size={16} /> Notas del email</label>
                        <textarea value={createValues.newEmailNotes} onChange={e => setCreateValues(p => ({ ...p, newEmailNotes: e.target.value }))} placeholder="Para qué se usa esta cuenta de correo..." rows={2} />
                      </div>
                    </>
                  ) : createValues.emailSource && createValues.emailSource.startsWith('vault_') ? (
                    <>
                      {/* Linked to existing vault email - email is auto-filled and read-only */}
                      <div className="vault-form-group">
                        <label><EmailIcon size={16} /> Email (vinculado)</label>
                        <input
                          type="email"
                          value={secrets[createValues.emailSource.replace('vault_', '')]?.email || ''}
                          readOnly
                          style={{ opacity: 0.7, cursor: 'not-allowed' }}
                        />
                      </div>
                      {createModal.accessType === 'credentials' && (
                        <div className="vault-form-group">
                          <label><LockKeyIcon size={16} /> Contraseña del servicio</label>
                          <div className="vault-password-input-group">
                            <input type={revealedFields.has('create-pw') ? 'text' : 'password'} value={createValues.password} onChange={e => setCreateValues(p => ({ ...p, password: e.target.value }))} placeholder="Contraseña del servicio" autoComplete="off" />
                            <RevealBtn fieldKey="create-pw" />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Manual entry (legacy behavior) */}
                      <div className="vault-form-group">
                        <label><EmailIcon size={16} /> Email</label>
                        <input type="email" value={createValues.email} onChange={e => setCreateValues(p => ({ ...p, email: e.target.value }))} placeholder="correo@gmail.com" />
                      </div>
                      {createModal.accessType === 'credentials' && (
                        <>
                          <div className="vault-form-group">
                            <label><LockKeyIcon size={16} /> Contraseña del servicio</label>
                            <div className="vault-password-input-group">
                              <input type={revealedFields.has('create-pw') ? 'text' : 'password'} value={createValues.password} onChange={e => setCreateValues(p => ({ ...p, password: e.target.value }))} placeholder="Contraseña" autoComplete="off" />
                              <RevealBtn fieldKey="create-pw" />
                            </div>
                          </div>
                          <div className="vault-form-group">
                            <label><KeyIcon size={16} /> {getEmailLabel(createValues.email)}</label>
                            <div className="vault-password-input-group">
                              <input type={revealedFields.has('create-gp') ? 'text' : 'password'} value={createValues.googlePassword} onChange={e => setCreateValues(p => ({ ...p, googlePassword: e.target.value }))} placeholder="Contraseña del email" autoComplete="off" />
                              <RevealBtn fieldKey="create-gp" />
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}

                  <div className="vault-form-group">
                    <label><NotesIcon size={16} /> Notas</label>
                    <textarea value={createValues.notes} onChange={e => setCreateValues(p => ({ ...p, notes: e.target.value }))} placeholder="Notas..." rows={2} />
                  </div>
                </>
              ) : (
                <>
                  <div className="vault-form-group">
                    <label><BankIcon size={16} /> Banco / Emisor</label>
                    <input type="text" value={createValues.bank} onChange={e => setCreateValues(p => ({ ...p, bank: e.target.value }))} placeholder="Nu Crédito" />
                  </div>
                  <div className="vault-form-group">
                    <label><CreditCardIcon size={16} /> Número de tarjeta</label>
                    <div className="vault-password-input-group">
                      <input
                        type={revealedFields.has('create-card-num') ? 'text' : 'password'}
                        value={revealedFields.has('create-card-num') ? formatCardNumber(createValues.number) : createValues.number}
                        onChange={e => {
                          const cleaned = cleanCardNumber(e.target.value);
                          setCreateValues(p => ({ ...p, number: cleaned }));
                        }}
                        placeholder="1234 5678 9012 3456" autoComplete="off"
                      />
                      <RevealBtn fieldKey="create-card-num" />
                    </div>
                    {createValues.number && (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Últimos 4: {getLast4(createValues.number)} · {cleanCardNumber(createValues.number).length}/16 dígitos
                      </span>
                    )}
                  </div>
                  <div className="vault-form-row">
                    <div className="vault-form-group">
                      <label><CalendarIcon size={16} /> Expiración</label>
                      <input type="text" value={createValues.expiry} onChange={e => setCreateValues(p => ({ ...p, expiry: e.target.value }))} placeholder="MM/AA" />
                    </div>
                    <div className="vault-form-group">
                      <label><LockIcon size={16} /> CVV</label>
                      <div className="vault-password-input-group">
                        <input type={revealedFields.has('create-card-cvv') ? 'text' : 'password'} value={createValues.cvv} maxLength={4} onChange={e => setCreateValues(p => ({ ...p, cvv: e.target.value }))} placeholder="•••" autoComplete="off" />
                        <RevealBtn fieldKey="create-card-cvv" />
                      </div>
                    </div>
                  </div>
                  <div className="vault-form-group">
                    <label><UserIcon size={16} /> Titular</label>
                    <input type="text" value={createValues.holder} onChange={e => setCreateValues(p => ({ ...p, holder: e.target.value }))} placeholder="Nombre del titular" />
                  </div>
                  <div className="vault-form-group">
                    <label><NotesIcon size={16} /> Notas</label>
                    <textarea value={createValues.notes} onChange={e => setCreateValues(p => ({ ...p, notes: e.target.value }))} placeholder="Notas..." rows={2} />
                  </div>
                </>
              )}
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setCreateModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={createModal.mode === 'card' ? handleCreateCard : handleCreateAccount}>
                <PlusIcon size={16} /> Crear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Agregar Cobro Recurrente ═══ */}
      {recurringModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setRecurringModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal" style={{ maxWidth: '480px' }}>
            <div className="vault-modal-header">
              <h3><RefreshIcon size={16} /> {recurringModal.editChargeId ? 'Editar cobro recurrente' : 'Nuevo cobro recurrente'}</h3>
              <button className="vault-modal-close" onClick={() => setRecurringModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-meta">
              <span><CreditCardIcon size={16} /> {recurringModal.cardLabel}</span>
            </div>
            <div className="vault-modal-form" style={{ paddingTop: '16px' }}>
              <div className="vault-form-group">
                <label><ReceiptIcon size={16} /> Descripción del cobro</label>
                <input type="text" value={recurringValues.description} onChange={e => setRecurringValues(p => ({ ...p, description: e.target.value }))} placeholder="Ej: ChatGPT Plus, YouTube Premium..." />
              </div>
              <div className="vault-form-row">
                <div className="vault-form-group">
                  <label><CashIcon size={16} /> Monto (opcional)</label>
                    <input type="number" value={recurringValues.amount} onChange={e => setRecurringValues(p => ({ ...p, amount: e.target.value }))} placeholder="Dejar vacío para ingresar al confirmar" />
                </div>
                <div className="vault-form-group">
                  <label><CalendarIcon size={16} /> Día del mes (1-31)</label>
                  <input type="number" min="1" max="31" value={recurringValues.billingDay} onChange={e => setRecurringValues(p => ({ ...p, billingDay: e.target.value }))} placeholder="15" />
                </div>
              </div>
              <div className="vault-form-group">
                <label><LinkIcon size={16} /> Cuenta real vinculada (requerido)</label>
                <select value={recurringValues.serviceKey} onChange={e => setRecurringValues(p => ({ ...p, serviceKey: e.target.value, serviceAccountRef: '' }))} disabled={!!recurringModal.editChargeId}>
                  <option value="">— Seleccionar servicio —</option>
                  {SERVICE_ORDER.map(svc => <option key={svc} value={svc}>{getServiceMeta(svc).name}</option>)}
                </select>
              </div>
              {recurringValues.serviceKey && (pools[recurringValues.serviceKey] || []).length > 0 && (() => {
                const currentCardId = recurringModal.cardId;
                const currentCardLabel = recurringModal.cardLabel;
                const isEditing = !!recurringModal.editChargeId;
                const svcAccounts = (pools[recurringValues.serviceKey] || []);

                // Cobros ya existentes en ESTA tarjeta para el servicio seleccionado
                const thisCardCharges = (cards[currentCardId]?.recurringCharges || []);
                const thisCardUsedRefs = new Set(
                  thisCardCharges
                    .filter(c => c.serviceKey === recurringValues.serviceKey)
                    // Si estamos editando, excluir el cobro actual para que su cuenta siga apareciendo
                    .filter(c => !isEditing || c.id !== recurringModal.editChargeId)
                    .map(c => c.serviceAccountRef)
                );

                // Cobros en OTRAS tarjetas (cualquier servicio, la cuenta no puede estar en 2 tarjetas)
                const otherCardsUsedRefs = new Set();
                for (const [otherId, otherCard] of Object.entries(cards)) {
                  if (otherId === currentCardId) continue;
                  for (const c of (otherCard.recurringCharges || [])) {
                    if (c.serviceKey === recurringValues.serviceKey) {
                      otherCardsUsedRefs.add(c.serviceAccountRef);
                    }
                  }
                }

                const availableAccounts = svcAccounts.filter(acct => {
                  const ref = acct.serviceAccountRef || acct.id;
                  // Ya tiene cobro en ESTA tarjeta → no duplicar
                  if (thisCardUsedRefs.has(ref)) return false;
                  // Ya tiene cobro en OTRA tarjeta → no permitir
                  if (otherCardsUsedRefs.has(ref)) return false;
                  // Tiene cardLabel de otra tarjeta (asignado fuera de cobros) → no permitir
                  if (acct.cardLabel && acct.cardLabel !== currentCardLabel) return false;
                  return true;
                });

                const hiddenCount = svcAccounts.length - availableAccounts.length;
                return (
                <div className="vault-form-group">
                  <label><CreditCardIcon size={16} /> Cuenta real</label>
                  <select value={recurringValues.serviceAccountRef} onChange={e => setRecurringValues(p => ({ ...p, serviceAccountRef: e.target.value }))} disabled={isEditing}>
                    <option value="">— Seleccionar cuenta —</option>
                    {availableAccounts.map(acct => (
                      <option key={acct.id} value={acct.serviceAccountRef || acct.id}>
                        {acct.label || acct.serviceAccountRef} ({acct.email || 'sin email'})
                      </option>
                    ))}
                  </select>
                  {hiddenCount > 0 && (
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>
                      {hiddenCount} cuenta(s) no disponible(s) — ya vinculada(s) a una tarjeta.
                    </span>
                  )}
                  {availableAccounts.length === 0 && svcAccounts.length > 0 && (
                    <span style={{ fontSize: '11px', color: 'var(--accent-warning)', marginTop: '2px', display: 'block' }}>
                      No hay cuentas disponibles para vincular en este servicio.
                    </span>
                  )}
                </div>
                );
              })()}
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0', lineHeight: 1.5 }}>
                <CalendarIcon size={14} /> Cada mes, al llegar al día indicado, se genera un cobro pendiente en Finanzas que debes confirmar manualmente. Si no ingresas monto, lo podrás ingresar al confirmar. Al vincular, se actualiza la info en Suscripciones.
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setRecurringModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveRecurring}>
                {recurringModal.editChargeId ? <><SaveIcon size={16} /> Guardar cambios</> : <><PlusIcon size={16} /> Agregar cobro</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Editar Cuenta de Correo ═══ */}
      {googleEditModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setGoogleEditModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3><EditIcon size={16} /> Editar cuenta de correo</h3>
              <button className="vault-modal-close" onClick={() => setGoogleEditModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-meta">
              {googleEditModal.isPrincipal && <span><EmailIcon size={16} /> Lank #{googleEditModal.lankAccountId}</span>}
              {!googleEditModal.isPrincipal && <span style={{ color: '#f59e0b' }}>Secundaria</span>}
            </div>
            <div className="vault-modal-form">
              {googleEditModal.isPrincipal && (
                <>
                  <div className="vault-form-group">
                    <label><UserIcon size={16} /> Alias</label>
                    <input
                      type="text"
                      value={googleEditValues.canonicalAlias}
                      onChange={e => setGoogleEditValues(p => ({ ...p, canonicalAlias: e.target.value }))}
                      placeholder="Alias canónico"
                      autoComplete="off"
                    />
                  </div>
                  <div className="vault-form-group">
                    <label><UserIcon size={16} /> Nombre completo</label>
                    <input
                      type="text"
                      value={googleEditValues.fullName}
                      onChange={e => setGoogleEditValues(p => ({ ...p, fullName: e.target.value }))}
                      placeholder="Nombre completo"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
              <div className="vault-form-group">
                <label><EmailIcon size={16} /> Email</label>
                <input
                  type="email"
                  value={googleEditValues.email}
                  onChange={e => setGoogleEditValues(p => ({ ...p, email: e.target.value }))}
                  placeholder="correo@gmail.com"
                  autoComplete="off"
                />
              </div>
              <div className="vault-form-group">
                <label><LockKeyIcon size={16} /> Contraseña del correo</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('modal-google-pw') ? 'text' : 'password'}
                    value={googleEditValues.password}
                    onChange={e => setGoogleEditValues(p => ({ ...p, password: e.target.value }))}
                    placeholder="Contraseña del correo" autoComplete="off"
                  />
                  <RevealBtn fieldKey="modal-google-pw" />
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Al cambiar esta contraseña se sincroniza con todos los servicios que usen este email.
                </span>
              </div>
              {googleEditModal.isPrincipal && (
                <div className="vault-form-group">
                  <label><PhoneIcon size={16} /> WhatsApp</label>
                  <input
                    type="text"
                    value={googleEditValues.whatsapp}
                    onChange={e => setGoogleEditValues(p => ({ ...p, whatsapp: e.target.value }))}
                    placeholder="+52 1234567890"
                    autoComplete="off"
                  />
                </div>
              )}
              <div className="vault-form-group">
                <label><NotesIcon size={16} /> Notas / Comentarios</label>
                <textarea value={googleEditValues.notes} onChange={e => setGoogleEditValues(p => ({ ...p, notes: e.target.value }))} placeholder="Notas sobre esta cuenta (para que existe, uso, etc.)" rows={3} />
              </div>
              {googleEditModal.isPrincipal && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Los cambios de alias, nombre, correo y WhatsApp se sincronizan automáticamente con la cuenta Lank #{googleEditModal.lankAccountId}.
                </span>
              )}
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setGoogleEditModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveGoogleAccount}>
                <SaveIcon size={16} /> Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ MODAL: Crear Cuenta de Correo ═══ */}
      {googleCreateModal && (
        <div className="vault-modal-overlay"
          onMouseDown={e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; }}
          onClick={e => { if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) setGoogleCreateModal(null); mouseDownOnOverlayRef.current = false; }}
        >
          <div className="vault-modal">
            <div className="vault-modal-header">
              <h3><PlusIcon size={16} /> {googleCreateModal.type === 'lank_google' ? 'Nueva cuenta principal' : 'Nueva cuenta secundaria'}</h3>
              <button className="vault-modal-close" onClick={() => setGoogleCreateModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              {googleCreateModal.type === 'lank_google' && (
                <div className="vault-form-group">
                  <label><UserIcon size={16} /> Cuenta Lank</label>
                  <select
                    value={googleCreateValues.lankAccountId}
                    onChange={e => setGoogleCreateValues(p => ({ ...p, lankAccountId: e.target.value }))}
                    disabled={availablePrincipalAccounts.length === 0}
                  >
                    <option value="">{availablePrincipalAccounts.length === 0 ? 'No hay cuentas disponibles' : 'Selecciona una cuenta'}</option>
                    {availablePrincipalAccounts.map(account => (
                      <option key={account.id} value={account.id}>
                        #{account.id} — {account.canonicalAlias || account.fullName}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Solo se muestran cuentas Lank que aún no tienen una cuenta principal registrada en la Bóveda.
                  </span>
                </div>
              )}
              <div className="vault-form-group">
                <label><EmailIcon size={16} /> Email</label>
                <input type="email" value={googleCreateValues.email} onChange={e => setGoogleCreateValues(p => ({ ...p, email: e.target.value }))} placeholder="correo@gmail.com" autoComplete="off" />
              </div>
              <div className="vault-form-group">
                <label><LockKeyIcon size={16} /> Contraseña del correo</label>
                <div className="vault-password-input-group">
                  <input
                    type={revealedFields.has('create-sec-pw') ? 'text' : 'password'}
                    value={googleCreateValues.password}
                    onChange={e => setGoogleCreateValues(p => ({ ...p, password: e.target.value }))}
                    placeholder="Contraseña del proveedor de correo" autoComplete="off"
                  />
                  <RevealBtn fieldKey="create-sec-pw" />
                </div>
              </div>
              <div className="vault-form-group">
                <label><NotesIcon size={16} /> Notas / Comentarios</label>
                <textarea value={googleCreateValues.notes} onChange={e => setGoogleCreateValues(p => ({ ...p, notes: e.target.value }))} placeholder="Para que se usa esta cuenta, quien la creo, etc." rows={3} />
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setGoogleCreateModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleCreateGoogleAccount}>
                <PlusIcon size={16} /> Crear cuenta
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmDialog && (
        <ConfirmDialog
          open={!!confirmDialog}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onClose={confirmDialog.onCancel}
        />
      )}

      {/* Toast */}
      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onClose={() => setToast(prev => ({ ...prev, visible: false }))}
      />
 </>
 );
}
