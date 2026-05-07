import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDocument } from '../hooks/useFirestore';
import { collection, getDocs, doc, getDoc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { formatMXN, getBankMeta, getProfileImage, BANKS, setCustomBankAccounts } from '../config/services';
import { confirmRecurringExpense, generateRecurringExpenses, logManualChange } from '../hooks/firestoreActions';
import EditModal, { ConfirmDialog, Toast } from '../components/EditModal';
import { BankIcon, BarChartIcon, CalendarIcon, CheckCircleIcon, ClipboardIcon, ClockIcon, CloseIcon, CreditCardIcon, DepositIcon, EditIcon, ExpenseIcon, FolderIcon, HourglassIcon, KeyIcon, LinkIcon, MoneyIcon, PlusIcon, ReceiptIcon, RefreshIcon, SaveIcon, TrashIcon, TrendUpIcon, WarningIcon } from '../components/Icons';

const MONTH_NAMES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTH_NAMES_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function getMonthKey(year, month) {
 // month: 0-11
 return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function getMonthLabel(year, month) {
 return `${MONTH_NAMES_ES[month]} ${year}`;
}

function formatDateTime(dateStr) {
 if (!dateStr) return ' Pendiente';
 const d = new Date(dateStr);
 return d.toLocaleDateString('es-MX', {
 day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
 });
}

function buildLegacyManualEntryIdentifier(entry) {
 if (!entry || entry.entryId) return entry?.entryId || null;
 return [
  'legacy',
  entry.type || '',
  entry.effectiveAt || '',
  entry.description || '',
  String(entry.amount ?? ''),
  entry.subscription || '',
  entry.bankAccount || '',
  entry.cardId || '',
  entry.status || '',
 ].join('|');
}

export default function Finance() {
 const { data: overview, loading: loadingOverview, error: errorOverview } = useDocument('finance', 'overview');
 const { data: ledger, loading: loadingLedger } = useDocument('finance', 'manual-ledger');
 const [withdrawals, setWithdrawals] = useState([]);
 const [wTab, setWTab] = useState('all');
 const [withdrawalsCollapsed, setWithdrawalsCollapsed] = useState(true); // colapsado por defecto en móvil
 const [expandedBank, setExpandedBank] = useState(null);
 const [expandedAccount, setExpandedAccount] = useState(null);

 const now = new Date();
 const currentMonth = now.getMonth();
 const currentYear = now.getFullYear();
 const currentMonthKey = getMonthKey(currentYear, currentMonth);
 const currentMonthLabel = getMonthLabel(currentYear, currentMonth);

 // Gastos manuales
 const [addExpenseModal, setAddExpenseModal] = useState(false);
 const [editExpenseModal, setEditExpenseModal] = useState(null); // { index, entry }
 const [removeExpenseConfirm, setRemoveExpenseConfirm] = useState(null);
 const [confirmingExpenseIdx, setConfirmingExpenseIdx] = useState(null); // Prevenir doble-clic en confirmar cobro
 const [pendingAmounts, setPendingAmounts] = useState({}); // Montos editables para cobros pendientes
 const [expenseToast, setExpenseToast] = useState({ visible: false, message: '', type: 'success' });

 // Depósitos/Ingresos
 const [addDepositModal, setAddDepositModal] = useState(false);
 const [editDepositModal, setEditDepositModal] = useState(null); // { index, entry }
 const [removeDepositConfirm, setRemoveDepositConfirm] = useState(null);
 const [depositToast, setDepositToast] = useState({ visible: false, message: '', type: 'success' });

 const [ledgerFilter, setLedgerFilter] = useState('all'); // 'all' | 'expenses' | 'income'

 const showDepositToast = useCallback((msg, type = 'success') => {
   setDepositToast({ visible: true, message: msg, type });
 }, []);

 // Credit accounts state
 const [creditAccounts, setCreditAccounts] = useState([]);
 const [loadingCredit, setLoadingCredit] = useState(true);
 const [vaultCards, setVaultCards] = useState({});
 const [creditExpandSection, setCreditExpandSection] = useState({});

 const showExpenseToast = useCallback((msg, type = 'success') => {
 setExpenseToast({ visible: true, message: msg, type });
 }, []);

 // Rango permitido de fechas: mes anterior al mes siguiente
 const minDate = useMemo(() => {
 const d = new Date(currentYear, currentMonth - 1, 1);
 return d.toISOString().slice(0, 10);
 }, [currentYear, currentMonth]);
 const maxDate = useMemo(() => {
 const d = new Date(currentYear, currentMonth + 2, 0);
 return d.toISOString().slice(0, 10);
 }, [currentYear, currentMonth]);

 // CLABEs state
 const [clabes, setClabes] = useState([]);
 const [, setLoadingClabes] = useState(true);
 const [copiedClabe, setCopiedClabe] = useState(null);

 const bankAccountOptions = useMemo(() => {
   const debitClabes = clabes.filter(c => c.type !== 'credito');
   const bankNames = [...new Set(debitClabes.map(c => c.bank))];
   return bankNames.map(b => ({ value: b, label: b }));
 }, [clabes]);

 // Historial de meses
 const [monthlyHistory, setMonthlyHistory] = useState([]);
 const [expandedHistMonth, setExpandedHistMonth] = useState(null);
 const [historyWithdrawals, setHistoryWithdrawals] = useState({});

 // Cargar retiros del MES ACTUAL
 useEffect(() => {
 const monthName = MONTH_NAMES_EN[currentMonth];
 const colRef = collection(db, `finance/withdrawals-${monthName}/records`);
 getDocs(colRef).then(snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setWithdrawals(docs.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')));
 }).catch(err => console.error('Error cargando retiros:', err));
 }, [currentMonth, currentYear]);

 // Cargar historial de meses anteriores
 useEffect(() => {
 if (!overview) return;
 const months = overview.months || [];
 // Filtrar solo meses anteriores al actual
 const pastMonths = months.filter(m => m < currentMonthKey).sort((a, b) => b.localeCompare(a));

 async function loadHistory() {
      const results = [];
      for (const m of pastMonths) {
        try {
          const snap = await getDoc(doc(db, 'finance', `monthly-${m}`));
          if (snap.exists()) {
            const data = snap.data();
            results.push({ key: m, ...data });
          }
        } catch (err) {
          console.error(`Error cargando monthly-${m}:`, err);
        }
      }
      setMonthlyHistory(results);
 }
 loadHistory();
 }, [overview, currentMonthKey]);

 // Cargar retiros de un mes histórico cuando se expande
 useEffect(() => {
 if (!expandedHistMonth) return;
 if (historyWithdrawals[expandedHistMonth]) return;

 const [, monthStr] = expandedHistMonth.split('-');
 const monthIndex = parseInt(monthStr, 10) - 1;
 const monthName = MONTH_NAMES_EN[monthIndex];
 const colRef = collection(db, `finance/withdrawals-${monthName}/records`);

 getDocs(colRef).then(snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setHistoryWithdrawals(prev => ({
        ...prev,
        [expandedHistMonth]: docs.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')),
      }));
 });
 }, [expandedHistMonth, historyWithdrawals]);

 // Ref: si la colección banks tiene datos, es fuente primaria (post-migración)
 const banksSourceRef = useRef(false);

 // Cargar colección banks — fuente primaria post-migración (tiempo real)
 useEffect(() => {
   const unsub = onSnapshot(collection(db, 'banks'), (snap) => {
     if (!snap.empty) {
       banksSourceRef.current = true;
       const derivedClabes = [];
       const derivedCredit = [];

       snap.docs.forEach(d => {
         const bank = { id: d.id, ...d.data() };
         if (bank.debitAccount?.clabe) {
           derivedClabes.push({
             bank: bank.name,
             clabe: bank.debitAccount.clabe,
             type: 'debito',
             note: bank.debitAccount.note || '',
           });
         }
         if (bank.creditAccount) {
           derivedCredit.push({
             id: bank.id,
             bank: bank.name,
             ...bank.creditAccount,
            });
           if (bank.creditAccount.paymentClabe) {
             derivedClabes.push({
               bank: bank.name,
               clabe: bank.creditAccount.paymentClabe,
               type: 'credito',
               note: bank.creditAccount.paymentClabeNote || 'sólo para pagar',
             });
           }
         }
       });

       setClabes(derivedClabes);
       setLoadingClabes(false);
       setCreditAccounts(derivedCredit);
       setLoadingCredit(false);
     }
   });
   return () => unsub();
 }, []);

 // Cargar CLABEs bancarias (fallback pre-migración)
 useEffect(() => {
 const clabeRef = doc(db, 'finance', 'bank-clabes');
 getDoc(clabeRef).then(snap => {
      if (banksSourceRef.current) return;
      if (snap.exists()) {
        const data = snap.data();
        setClabes(data.accounts || []);
      } else {
        setClabes([]);
      }
      setLoadingClabes(false);
 }).catch(() => setLoadingClabes(false));
 }, []);

 // Cargar cuentas bancarias custom (con logos subidos)
 useEffect(() => {
   const bankAccRef = doc(db, 'finance', 'bank-accounts');
   getDoc(bankAccRef).then(snap => {
     if (snap.exists()) {
       setCustomBankAccounts(snap.data().accounts || {});
     } else {
       setCustomBankAccounts({});
     }
   }).catch(() => {
     setCustomBankAccounts({});
   });
 }, []);

 // Cargar cuentas de crédito (fallback pre-migración)
 useEffect(() => {
   const creditRef = doc(db, 'finance', 'credit-accounts');
   getDoc(creditRef).then(snap => {
     if (banksSourceRef.current) return;
     if (snap.exists()) {
       setCreditAccounts(snap.data().accounts || []);
     } else {
       setCreditAccounts([]);
     }
     setLoadingCredit(false);
   }).catch(err => {
     console.warn('credit-accounts fetch error:', err);
     if (!banksSourceRef.current) {
       setCreditAccounts([]);
       setLoadingCredit(false);
     }
   });
 }, []);

 // Cargar vault-cards (para vincular tarjetas con cuentas de crédito)
 useEffect(() => {
   const unsub = onSnapshot(collection(db, 'vault-cards'), (snap) => {
     const cards = {};
     snap.docs.forEach(d => { cards[d.id] = { id: d.id, ...d.data() }; });
     setVaultCards(cards);
   }, (err) => {
     console.warn('vault-cards fetch error:', err);
     setVaultCards({});
   });
   return () => unsub();
 }, []);

 // Generar cobros recurrentes pendientes al cargar vault-cards
 useEffect(() => {
   if (Object.keys(vaultCards).length === 0) return;
   generateRecurringExpenses(vaultCards).catch(err =>
     console.warn('Error generating recurring expenses:', err)
   );
 }, [vaultCards]);

 const getEntryIdentifier = useCallback((entry) => entry?.entryId || buildLegacyManualEntryIdentifier(entry), []);

 const findLedgerEntryIndex = useCallback((entries, entry) => {
  const entryId = getEntryIdentifier(entry);
  return entries.findIndex(currentEntry => getEntryIdentifier(currentEntry) === entryId);
 }, [getEntryIdentifier]);

 // CLABE handlers
 const handleCopyClabe = (clabe) => {
 navigator.clipboard.writeText(clabe).then(() => {
      setCopiedClabe(clabe);
      setTimeout(() => setCopiedClabe(null), 2000);
 });
 };

 // Helper: determinar el monthKey de una fecha
 const getEntryMonthKey = (dateStr) => {
 if (!dateStr) return currentMonthKey;
 return dateStr.slice(0, 7); // "YYYY-MM"
 };

 // Helper: actualizar totales del mes correcto en Firestore
 const updateMonthTotals = async (monthKey, amountDelta, entryType, sign = 1) => {
 // sign: +1 para agregar, -1 para revertir
 const delta = amountDelta * sign;
 const isExpenseType = entryType === 'expense' || entryType === 'investment';

 if (monthKey === currentMonthKey) {
      // Actualizar overview (mes actual)
      const overviewRef = doc(db, 'finance', 'overview');
      const overviewSnap = await getDoc(overviewRef);
      if (overviewSnap.exists()) {
        const ov = overviewSnap.data();
        const totals = { ...(ov.totals || {}) };
        if (entryType === 'expense' || entryType === 'investment') {
          totals.manualExpensesGross = Math.max(0, (totals.manualExpensesGross || 0) + delta);
        } else if (entryType === 'deposit') {
          totals.manualDepositsGross = Math.max(0, (totals.manualDepositsGross || 0) + delta);
        }
        totals.bankNetAfterExpenses = (totals.withdrawalCompletedGross || 0)
          + (totals.manualDepositsGross || 0)
          - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);
        totals.estimatedNetWallet = (totals.walletCreditsGross || 0)
          + (totals.manualDepositsGross || 0)
          - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);
        await updateDoc(overviewRef, { totals });
      }
 } else {
      // Actualizar monthly-{monthKey} (mes pasado o futuro)
      const monthRef = doc(db, 'finance', `monthly-${monthKey}`);
      const monthSnap = await getDoc(monthRef);
      if (monthSnap.exists()) {
        const mData = monthSnap.data();
        const totals = { ...(mData.totals || {}) };
        if (entryType === 'expense' || entryType === 'investment') {
          totals.manualExpensesGross = Math.max(0, (totals.manualExpensesGross || 0) + delta);
        } else if (entryType === 'deposit') {
          totals.manualDepositsGross = Math.max(0, (totals.manualDepositsGross || 0) + delta);
        }
        totals.bankNetAfterExpenses = (totals.withdrawalCompletedGross || 0)
          + (totals.manualDepositsGross || 0)
          - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);
        totals.estimatedNetWallet = (totals.walletCreditsGross || 0)
          + (totals.manualDepositsGross || 0)
          - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);
        await updateDoc(monthRef, { totals });
      } else {
        // Crear monthly para mes futuro
        const newMonth = {
          month: monthKey,
          generatedAt: new Date().toISOString(),
          accountCount: 0,
          totals: {
            walletCreditsGross: 0,
            withdrawalRequestedGross: 0,
            withdrawalCompletedGross: 0,
            manualExpensesGross: isExpenseType ? Math.max(0, delta) : 0,
            manualDepositsGross: entryType === 'deposit' ? Math.max(0, delta) : 0,
            manualInvestmentsGross: 0,
            estimatedNetWallet: entryType === 'deposit' ? Math.max(0, delta) : (isExpenseType ? -Math.max(0, delta) : 0),
            bankNetAfterExpenses: entryType === 'deposit' ? Math.max(0, delta) : (isExpenseType ? -Math.max(0, delta) : 0),
            completedWithdrawals: 0,
            pendingWithdrawals: 0,
          },
        };
        await setDoc(monthRef, newMonth);
        // Asegurar que el mes aparezca en overview.months
        const overviewRef = doc(db, 'finance', 'overview');
        const overviewSnap = await getDoc(overviewRef);
        if (overviewSnap.exists()) {
          const months = overviewSnap.data().months || [];
          if (!months.includes(monthKey)) {
            await updateDoc(overviewRef, { months: [...months, monthKey].sort() });
          }
        }
      }
 }
 };

 // Validacion de fecha compartida (se pasa como prop validate a los modales)
 const validateExpenseDate = useCallback((values) => {
 const today = new Date().toISOString().slice(0, 10);
 const effectiveAt = values.effectiveAt || today;
 if (effectiveAt < minDate || effectiveAt > maxDate) {
      return `La fecha debe estar entre ${minDate} y ${maxDate}`;
 }
 return null;
 }, [minDate, maxDate]);

 // Agregar gasto manual
 const handleAddExpense = async (values) => {
 const amount = parseFloat(values.amount);
 if (!values.description?.trim() || isNaN(amount) || amount <= 0) return;

 const entryType = values.type || 'expense';
 const today = new Date().toISOString().slice(0, 10);
 const effectiveAt = values.effectiveAt || today;

 const newEntry = {
      entryId: `manual:${effectiveAt}:${Date.now()}`,
      type: entryType,
      description: values.description.trim(),
      amount,
      effectiveAt,
      status: 'confirmed',
      createdAt: new Date().toISOString(),
 };
 if (values.subscription?.trim()) newEntry.subscription = values.subscription.trim();
 if (values.note?.trim()) newEntry.notes = [values.note.trim()];

 // Guardar en manual-ledger
 const ledgerRef = doc(db, 'finance', 'manual-ledger');
 const currentEntries = ledger?.entries || [];
 await updateDoc(ledgerRef, { entries: [...currentEntries, newEntry] });

 // Actualizar totales del mes correspondiente
 const monthKey = getEntryMonthKey(effectiveAt);
 await updateMonthTotals(monthKey, amount, entryType, 1);

 const typeLabels = { expense: 'Gasto', investment: 'Gasto (inversi\u00f3n)', income_adjustment: 'Ajuste positivo', expense_refund: 'Devoluci\u00f3n' };
 const monthLabel = monthKey === currentMonthKey ? '' : ` (${monthKey})`;
 showExpenseToast(`${typeLabels[entryType] || 'Entrada'} de ${formatMXN(amount)} registrado${monthLabel}`);
 };

 // Editar gasto manual
 const handleEditExpense = async (values) => {
 if (!editExpenseModal) return;
 const { entry: oldEntry } = editExpenseModal;
 const amount = parseFloat(values.amount);
 if (!values.description?.trim() || isNaN(amount) || amount <= 0) return;

 const entryType = values.type || 'expense';
 const today = new Date().toISOString().slice(0, 10);
 const effectiveAt = values.effectiveAt || today;

 const updatedEntry = {
      ...oldEntry,
      type: entryType,
      description: values.description.trim(),
      amount,
      effectiveAt,
      updatedAt: new Date().toISOString(),
 };
 if (values.subscription?.trim()) updatedEntry.subscription = values.subscription.trim();
 else delete updatedEntry.subscription;
 if (values.note?.trim()) updatedEntry.notes = [values.note.trim()];
 else delete updatedEntry.notes;

 const ledgerRef = doc(db, 'finance', 'manual-ledger');
 const currentEntries = ledger?.entries || [];
 const entryIndex = findLedgerEntryIndex(currentEntries, oldEntry);
 if (entryIndex < 0) {
      showExpenseToast('No se encontró el gasto a editar. Recarga la página e intenta de nuevo.', 'error');
      return;
 }

 const updatedEntries = [...currentEntries];
 updatedEntries[entryIndex] = updatedEntry;
 await updateDoc(ledgerRef, { entries: updatedEntries });

 // Revertir totales del mes viejo y aplicar al mes nuevo
 const oldMonthKey = getEntryMonthKey(oldEntry.effectiveAt);
 const newMonthKey = getEntryMonthKey(effectiveAt);
 await updateMonthTotals(oldMonthKey, oldEntry.amount || 0, oldEntry.type || 'expense', -1);
 await updateMonthTotals(newMonthKey, amount, entryType, 1);

 showExpenseToast(`Gasto actualizado: ${values.description.trim()}`);
 };

 // Eliminar gasto manual
 const handleRemoveExpenseConfirm = async () => {
 if (removeExpenseConfirm === null) return;
 const { entry } = removeExpenseConfirm;
 try {
 const ledgerRef = doc(db, 'finance', 'manual-ledger');
 const currentEntries = ledger?.entries || [];
 const entryIndex = findLedgerEntryIndex(currentEntries, entry);
 if (entryIndex < 0) {
        showExpenseToast('No se encontró el gasto a eliminar. Recarga la página e intenta de nuevo.', 'error');
        setRemoveExpenseConfirm(null);
        return;
 }

 const updatedEntries = currentEntries.filter((_, i) => i !== entryIndex);
 await updateDoc(ledgerRef, { entries: updatedEntries });

 // Revertir totales del mes correspondiente
 const monthKey = getEntryMonthKey(entry.effectiveAt);
 await updateMonthTotals(monthKey, entry.amount || 0, entry.type || 'expense', -1);

 showExpenseToast(`Entrada eliminada: ${entry.description}`);
 setRemoveExpenseConfirm(null);
 } catch (err) {
 showExpenseToast(`Error al eliminar: ${err.message}`, 'error');
 throw err; // Re-throw para que ConfirmDialog muestre el error
 }
 };

 // ─── Depósitos / Ingresos ─────────────────────────────────────────

 // Agregar depósito/ingreso
 const handleAddDeposit = async (values) => {
   const amount = parseFloat(values.amount);
   if (!values.description?.trim() || isNaN(amount) || amount <= 0) return;

   const today = new Date().toISOString().slice(0, 10);
   const effectiveAt = values.effectiveAt || today;

   const newEntry = {
     entryId: `deposit:${effectiveAt}:${Date.now()}`,
     type: 'deposit',
     description: values.description.trim(),
     amount,
     effectiveAt,
     status: 'confirmed',
     createdAt: new Date().toISOString(),
   };
   if (values.bankAccount?.trim()) newEntry.bankAccount = values.bankAccount.trim();
   if (values.note?.trim()) newEntry.notes = [values.note.trim()];

   const ledgerRef = doc(db, 'finance', 'manual-ledger');
   const currentEntries = ledger?.entries || [];
   await updateDoc(ledgerRef, { entries: [...currentEntries, newEntry] });

   const monthKey = getEntryMonthKey(effectiveAt);
   await updateMonthTotals(monthKey, amount, 'deposit', 1);

   const monthLabel = monthKey === currentMonthKey ? '' : ` (${monthKey})`;
   showDepositToast(`Ingreso de ${formatMXN(amount)} registrado${monthLabel}`);

   logManualChange('add_deposit', `Ingreso registrado: ${values.description.trim()} — ${formatMXN(amount)}`, {
     collection: 'finance', documentId: 'manual-ledger',
     after: { description: values.description.trim(), amount, bankAccount: values.bankAccount, effectiveAt },
   });
 };

 // Editar depósito/ingreso
 const handleEditDeposit = async (values) => {
   if (!editDepositModal) return;
   const { entry: oldEntry } = editDepositModal;
   const amount = parseFloat(values.amount);
   if (!values.description?.trim() || isNaN(amount) || amount <= 0) return;

   const today = new Date().toISOString().slice(0, 10);
   const effectiveAt = values.effectiveAt || today;

   const updatedEntry = {
     ...oldEntry,
     type: 'deposit',
     description: values.description.trim(),
     amount,
     effectiveAt,
     updatedAt: new Date().toISOString(),
   };
   if (values.bankAccount?.trim()) updatedEntry.bankAccount = values.bankAccount.trim();
   else delete updatedEntry.bankAccount;
   if (values.note?.trim()) updatedEntry.notes = [values.note.trim()];
   else delete updatedEntry.notes;

   const ledgerRef = doc(db, 'finance', 'manual-ledger');
   const currentEntries = ledger?.entries || [];
   const entryIndex = findLedgerEntryIndex(currentEntries, oldEntry);
   if (entryIndex < 0) {
     showDepositToast('No se encontró el ingreso a editar. Recarga la página e intenta de nuevo.', 'error');
     return;
   }

   const updatedEntries = [...currentEntries];
   updatedEntries[entryIndex] = updatedEntry;
   await updateDoc(ledgerRef, { entries: updatedEntries });

   const oldMonthKey = getEntryMonthKey(oldEntry.effectiveAt);
   const newMonthKey = getEntryMonthKey(effectiveAt);
   await updateMonthTotals(oldMonthKey, oldEntry.amount || 0, 'deposit', -1);
   await updateMonthTotals(newMonthKey, amount, 'deposit', 1);

   showDepositToast(`Ingreso actualizado: ${values.description.trim()}`);

   logManualChange('edit_deposit', `Ingreso editado: ${values.description.trim()}`, {
     collection: 'finance', documentId: 'manual-ledger',
     before: { description: oldEntry.description, amount: oldEntry.amount },
     after: { description: values.description.trim(), amount, bankAccount: values.bankAccount, effectiveAt },
   });
 };

 // Eliminar depósito/ingreso
 const handleRemoveDepositConfirm = async () => {
   if (removeDepositConfirm === null) return;
   const { entry } = removeDepositConfirm;
   try {
     const ledgerRef = doc(db, 'finance', 'manual-ledger');
     const currentEntries = ledger?.entries || [];
     const entryIndex = findLedgerEntryIndex(currentEntries, entry);
     if (entryIndex < 0) {
       showDepositToast('No se encontró el ingreso a eliminar. Recarga la página e intenta de nuevo.', 'error');
       setRemoveDepositConfirm(null);
       return;
     }

     const updatedEntries = currentEntries.filter((_, i) => i !== entryIndex);
     await updateDoc(ledgerRef, { entries: updatedEntries });

     const monthKey = getEntryMonthKey(entry.effectiveAt);
     await updateMonthTotals(monthKey, entry.amount || 0, 'deposit', -1);

     showDepositToast(`Ingreso eliminado: ${entry.description}`);
     setRemoveDepositConfirm(null);

     logManualChange('remove_deposit', `Ingreso eliminado: ${entry.description} — ${formatMXN(entry.amount)}`, {
       collection: 'finance', documentId: 'manual-ledger',
       before: { description: entry.description, amount: entry.amount, bankAccount: entry.bankAccount },
     });
   } catch (err) {
     showDepositToast(`Error al eliminar: ${err.message}`, 'error');
     throw err;
   }
 };

 if (loadingOverview || loadingLedger) return <div className="empty-state"><div className="loading-spinner" /></div>;
 if (!overview) return (
    <div className="empty-state">
      <div className="empty-state-icon"><WarningIcon size={20} /></div>
      <p>No se pudo cargar los datos financieros</p>
      {errorOverview && <p style={{ fontSize: '11px', color: 'var(--accent-danger)', marginTop: '4px', wordBreak: 'break-all' }}>Error: {errorOverview}</p>}
      <button
        className="alert-action-btn edit"
        onClick={() => window.location.reload()}
        style={{ marginTop: '12px', fontSize: '13px' }}
      >
        <RefreshIcon size={16} /> Reintentar
      </button>
    </div>
  );

 const t = overview.totals || {};
 const allEntries = ledger?.entries || [];
 const entries = allEntries.filter(e => getEntryMonthKey(e.effectiveAt) === currentMonthKey);
 const depositEntries = entries.filter(e => e.type === 'deposit');
 const expenseEntries = entries.filter(e => e.type !== 'deposit');

 // Cálculos principales — solo del mes actual
 const pendingAmount = (t.withdrawalRequestedGross || 0) - (t.withdrawalCompletedGross || 0);
 const grossWithdrawn = t.withdrawalCompletedGross || 0;
 const totalDeposits = t.manualDepositsGross || 0;
 const totalExpenses = (t.manualExpensesGross || 0) + (t.manualInvestmentsGross || 0);
 const netProfit = grossWithdrawn + totalDeposits - totalExpenses;

 const kpis = [
 { label: 'Pendiente por retirar', value: pendingAmount, color: '#f59e0b', icon: <HourglassIcon size={16} />, isAmount: true },
 { label: 'Retirado bruto', value: grossWithdrawn, color: '#3b82f6', icon: <BankIcon size={16} />, isAmount: true },
 { label: 'Ingresos / Depósitos', value: totalDeposits, color: '#10b981', icon: <DepositIcon size={16} />, isAmount: true },
 { label: 'Gastos totales', value: totalExpenses, color: '#ef4444', icon: <ExpenseIcon size={16} />, isAmount: true, negative: true },
 { label: 'Ganancia neta', value: netProfit, color: netProfit >= 0 ? '#10b981' : '#ef4444', icon: <TrendUpIcon size={16} />, isAmount: true, isNet: true },
 ];

 const resolveBankName = (w) => {
   if (w.knownBankAccount?.bank) return w.knownBankAccount.bank;
   if (w.accountNumber) {
     const match = clabes.find(c => c.clabe === w.accountNumber);
     if (match) return match.type === 'credito' ? `${match.bank} Crédito` : match.bank;
   }
   return w.bank || 'Desconocido';
 };

 // Agrupar retiros por banco — resolver nombre vía knownBankAccount o CLABE
 const byBank = {};
 withdrawals.forEach(w => {
 const bank = resolveBankName(w);
 if (!byBank[bank]) byBank[bank] = { total: 0, count: 0, items: [] };
 byBank[bank].total += w.amount || 0;
 byBank[bank].count += 1;
 byBank[bank].items.push(w);
 });

 // Agrupar retiros por cuenta
 const byAccount = {};
 withdrawals.forEach(w => {
 const key = `${w.accountId}-${w.accountAlias}`;
 if (!byAccount[key]) byAccount[key] = { alias: w.accountAlias, accountId: w.accountId, total: 0, count: 0, items: [] };
 byAccount[key].total += w.amount || 0;
 byAccount[key].count += 1;
 byAccount[key].items.push(w);
 });

 // Determinar si un mes histórico es "reciente" (mes anterior) o "antiguo" (2+ meses)
 const isRecentMonth = (monthKey) => {
 const [y, m] = monthKey.split('-').map(Number);
 const monthDate = new Date(y, m - 1); // primer día del mes
 const prevMonth = new Date(currentYear, currentMonth - 1); // primer día del mes anterior
 return monthDate.getFullYear() === prevMonth.getFullYear() && monthDate.getMonth() === prevMonth.getMonth();
 };

 // ─── Credit account helpers ─────────────────────────────────────────

 const getLinkedCardLabel = (cardId) => {
   const card = vaultCards[cardId];
   if (!card) return cardId;
   return `${card.bank || ''} ****${card.lastFour || ''}`.trim();
 };

 const getLinkedCreditCardIds = (bankId) => Object.values(vaultCards)
   .filter(card => card.bankId === bankId && card.accountType === 'credit')
   .map(card => card.id);

 return (
 <>
      <div className="section-header">
        <div className="section-title"> Panel Financiero — {currentMonthLabel}</div>
        <span className="badge badge-info">
          {overview.transactionCount || 0} transacciones | {overview.daysScanned || 0} días
        </span>
      </div>

      {/* 5 KPIs principales */}
      <div className="finance-kpis-5">
        {kpis.map((kpi, i) => (
          <div className="kpi-card" key={i} style={{ '--kpi-color': kpi.color }}>
            <div className="kpi-label">{kpi.icon} {kpi.label}</div>
            <div className={`kpi-value ${kpi.negative ? 'negative' : ''} ${kpi.isNet ? (netProfit >= 0 ? 'positive' : 'negative') : ''}`}>
              {kpi.isAmount ? formatMXN(kpi.value) : kpi.value}
            </div>
            {kpi.isNet && (
              <div className="kpi-sub">
                {netProfit >= 0 ? <><CheckCircleIcon size={16} /> Ganancia</> : <><WarningIcon size={16} /> Pérdida</>} — Bruto menos gastos
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ═══ CUENTAS DE CRÉDITO ═══ */}
      <div className="finance-section" style={{ marginTop: '24px' }}>
        <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span><CreditCardIcon size={16} /> Cuentas de Crédito</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>Editar en Bóveda → Bancos</span>
        </div>

        {loadingCredit ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : creditAccounts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
            No hay cuentas de crédito registradas. Administra bancos desde Bóveda → Bancos.
          </div>
        ) : (
          <div className="credit-accounts-grid">
            {creditAccounts.map(acct => {
              const bankMeta = getBankMeta(acct.bank);
              const utilPct = acct.creditLimit > 0 ? Math.min(100, Math.round((acct.currentBalance / acct.creditLimit) * 100)) : 0;
              const utilClass = utilPct <= 30 ? 'low' : utilPct <= 70 ? 'medium' : 'high';
              const available = Math.max(0, (acct.creditLimit || 0) - (acct.currentBalance || 0));
              const expandSection = creditExpandSection[acct.id] || null;
              const installments = acct.installments || [];
              const statements = [...(acct.monthlyStatements || [])].sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
              const totalMSIMonthly = installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);
              const linkedCardIds = getLinkedCreditCardIds(acct.id);

              return (
                <div className="credit-account-card" key={acct.id} style={{ '--bank-color': bankMeta.color }}>
                  {/* Header */}
                  <div className="credit-account-header">
                    <div className="credit-account-bank">
                      {bankMeta.logo && <img src={bankMeta.logo} alt="" className="bank-logo-xl" onError={e => { e.target.style.display = 'none'; }} />}
                      <div>
                        <div className="credit-account-name">{acct.bank}</div>
                        <div className="credit-account-sub">
                          Límite: {formatMXN(acct.creditLimit)}
                          {acct.annualRate > 0 && ` · TAE ${acct.annualRate}%`}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                    </div>
                  </div>

                  <div style={{ padding: '0 20px 16px' }}>
                  {/* Utilization bar */}
                  <div className="credit-util-bar-wrap">
                    <div className="credit-util-bar-labels">
                      <span>Usado: {formatMXN(acct.currentBalance)}</span>
                      <span>Disponible: {formatMXN(available)}</span>
                    </div>
                    <div className="credit-util-bar">
                      <div className={`credit-util-fill ${utilClass}`} style={{ width: `${utilPct}%` }} />
                    </div>
                    <div className={`credit-util-pct`} style={{ color: utilClass === 'low' ? '#10b981' : utilClass === 'medium' ? '#f59e0b' : '#ef4444' }}>
                      {utilPct}% utilizado
                    </div>
                  </div>

                  {/* Key dates */}
                  <div className="credit-dates-row">
                    <div className="credit-date-item">
                      <div>
                        <div className="credit-date-label">Fecha de corte</div>
                        <div className="credit-date-value">Día {acct.cutoffDay}</div>
                      </div>
                    </div>
                    <div className="credit-date-item">
                      <div>
                        <div className="credit-date-label">Límite de pago</div>
                        <div className="credit-date-value">Día {acct.paymentDueDay}</div>
                      </div>
                    </div>
                    {acct.minimumPayment > 0 && (
                      <div className="credit-date-item">
                        <div>
                          <div className="credit-date-label">Pago mínimo</div>
                          <div className="credit-date-value">{formatMXN(acct.minimumPayment)}</div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Linked resources */}
                  <div className="credit-links-row">
                    {linkedCardIds.map(cid => (
                      <span className="credit-link-chip" key={cid}><CreditCardIcon size={12} /> {getLinkedCardLabel(cid)}</span>
                    ))}
                    {acct.paymentClabe && (
                      <span className="credit-link-chip"><BankIcon size={12} /> CLABE: {acct.paymentClabe.slice(-6)}{acct.paymentClabeNote ? ` · ${acct.paymentClabeNote}` : ''}</span>
                    )}
                    {installments.length > 0 && (
                      <span className="credit-link-chip"><ReceiptIcon size={12} /> {installments.length} MSI · {formatMXN(totalMSIMonthly)}/mes</span>
                    )}
                  </div>

                  {/* Expand: Installments */}
                  {installments.length > 0 && (
                    <>
                      <div
                        className="credit-expand-toggle"
                        onClick={() => setCreditExpandSection(prev => ({ ...prev, [acct.id]: prev[acct.id] === 'installments' ? null : 'installments' }))}
                      >
                        <span><ReceiptIcon size={14} /> Compras a meses ({installments.length})</span>
                        <span style={{ fontSize: '12px', transition: 'transform 0.3s', transform: expandSection === 'installments' ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                      </div>
                      <div className={`credit-expand-body ${expandSection === 'installments' ? 'expanded' : ''}`}>
                        <div style={{ padding: '8px 0' }}>
                          {installments.map(inst => (
                            <div className="credit-installment-row" key={inst.id}>
                              <div style={{ flex: 1 }}>
                                <div className="credit-installment-desc">{inst.description}</div>
                                <div className="credit-installment-detail">
                                  {inst.months} meses{inst.withInterest ? ' (con intereses)' : ' sin intereses'} · Quedan {inst.remainingMonths} · Desde {inst.startDate}
                                </div>
                              </div>
                              <div className="credit-installment-amount">
                                <div>{formatMXN(inst.monthlyPayment)}/mes</div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Total: {formatMXN(inst.totalAmount)}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Expand: Monthly Statements */}
                  {statements.length > 0 && (
                    <>
                      <div
                        className="credit-expand-toggle"
                        onClick={() => setCreditExpandSection(prev => ({ ...prev, [acct.id]: prev[acct.id] === 'statements' ? null : 'statements' }))}
                      >
                        <span><CalendarIcon size={14} /> Historial de estados de cuenta ({statements.length})</span>
                        <span style={{ fontSize: '12px', transition: 'transform 0.3s', transform: expandSection === 'statements' ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                      </div>
                      <div className={`credit-expand-body ${expandSection === 'statements' ? 'expanded' : ''}`}>
                        <div style={{ padding: '8px 0' }}>
                          {statements.map(stmt => {
                            const [y, m] = (stmt.monthKey || '').split('-').map(Number);
                            const monthLabel = MONTH_NAMES_ES[m - 1] ? `${MONTH_NAMES_ES[m - 1]} ${y}` : stmt.monthKey;
                            const paid = (stmt.paymentMade || 0) >= (stmt.minimumPayment || 0) && stmt.paymentMade > 0;
                            return (
                              <div className="credit-statement-row" key={stmt.monthKey}>
                                <span className="credit-statement-month">{monthLabel}</span>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Corte: {formatMXN(stmt.balanceAtCutoff)}</span>
                                {stmt.interestCharged > 0 && <span style={{ fontSize: '11px', color: '#ef4444' }}>Int: {formatMXN(stmt.interestCharged)}</span>}
                                <span className={paid ? 'credit-statement-paid' : 'credit-statement-unpaid'}>
                                  {stmt.paymentMade > 0 ? `Pagado: ${formatMXN(stmt.paymentMade)}` : 'Sin pago'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Action buttons — read-only in Finance, edit in Bóveda → Bancos */}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══ DOS COLUMNAS: Historial de Retiros | Gastos e Ingresos ═══ */}
      <div className="finance-two-cols">
        {/* COLUMNA IZQUIERDA: Historial de Retiros */}
        <div className="finance-col">
          <div
            className="finance-section-title finance-withdrawal-toggle"
            onClick={() => setWithdrawalsCollapsed(c => !c)}
          >
             Historial de Retiros
            <span className="badge badge-info" style={{ marginLeft: '8px' }}>{withdrawals.length}</span>
            <span className="finance-withdrawal-chevron" style={{ transform: withdrawalsCollapsed ? 'rotate(0)' : 'rotate(180deg)' }}>▼</span>
          </div>

          <div className={`finance-withdrawal-body ${withdrawalsCollapsed ? '' : 'expanded'}`} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

          {/* Sub-tabs: Todos / Por cuenta */}
          <div className="alerts-tabs" style={{ marginBottom: '12px' }}>
            <button className={`alert-tab ${wTab === 'all' ? 'active' : ''}`} onClick={() => setWTab('all')}>
              Todos
            </button>
            <button className={`alert-tab ${wTab === 'byAccount' ? 'active' : ''}`} onClick={() => setWTab('byAccount')}>
              Por cuenta
            </button>
          </div>

          {/* Vista: Todos */}
          {wTab === 'all' && (
            <div className="withdrawal-list">
              {withdrawals.map((w, i) => {
                const wBankName = resolveBankName(w);
                const bankMeta = getBankMeta(wBankName);
                const dateDisplay = formatDateTime(w.completedAt || w.requestedAt);
                const isPending = !w.completedAt;
                return (
                  <div className="withdrawal-row" key={i}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                      {w.accountId && (
                        <img src={getProfileImage(w.accountId)} className="w-avatar-lg" alt="" onError={e => { e.target.style.display = 'none'; }} />
                      )}
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{w.accountAlias}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span>#{w.accountId}</span>
                          <span>•</span>
                          <span style={{ color: isPending ? 'var(--accent-warning)' : 'var(--text-secondary)' }}>
                             {dateDisplay}
                          </span>
                          {isPending && <span className="badge badge-warning" style={{ fontSize: '10px', padding: '1px 6px' }}>Pendiente</span>}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="bank-badge" style={{ '--bank-color': bankMeta.color }}>
                        {bankMeta.logo && <img src={bankMeta.logo} className="bank-logo-lg-fin" alt="" onError={e => { e.target.style.display = 'none'; }} />}
                        <span>{wBankName}</span>
                      </div>
                      <div style={{ fontWeight: 700, fontSize: '16px', minWidth: '80px', textAlign: 'right' }}>{formatMXN(w.amount)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Vista: Por cuenta */}
          {wTab === 'byAccount' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Object.values(byAccount)
                .sort((a, b) => b.total - a.total)
                .map(data => {
                  const isOpen = expandedAccount === data.accountId;
                  return (
                    <div className="acct-withdrawal-accordion" key={data.accountId}>
                      <div
                        className={`acct-withdrawal-header ${isOpen ? 'expanded' : ''}`}
                        onClick={() => setExpandedAccount(isOpen ? null : data.accountId)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <img src={getProfileImage(data.accountId)} className="w-avatar-lg" alt="" style={{ borderRadius: '50%' }} onError={e => { e.target.style.display = 'none'; }} />
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '15px' }}>{data.alias}</div>
                            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                              #{data.accountId} • {data.count} retiro{data.count !== 1 ? 's' : ''}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ fontWeight: 800, fontSize: '17px' }}>{formatMXN(data.total)}</div>
                          <span style={{ fontSize: '13px', color: 'var(--text-muted)', transition: 'transform 0.3s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="acct-withdrawal-body">
                          {data.items
                            .sort((a, b) => (b.completedAt || b.requestedAt || '').localeCompare(a.completedAt || a.requestedAt || ''))
                            .map((w, wi) => {
                              const wBankName = resolveBankName(w);
                              const bankMeta = getBankMeta(wBankName);
                              const isPending = !w.completedAt;
                              return (
                                <div className="acct-withdrawal-row" key={wi}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                                    <span className="acct-w-date" style={isPending ? { color: 'var(--accent-warning)' } : {}}>
                                      <ClockIcon size={16} /> {formatDateTime(w.completedAt || w.requestedAt)}
                                    </span>
                                    {isPending && <span className="badge badge-warning" style={{ fontSize: '10px', padding: '1px 5px' }}>Pendiente</span>}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className="bank-badge" style={{ '--bank-color': bankMeta.color, fontSize: '12px', padding: '3px 8px' }}>
                                      {bankMeta.logo && <img src={bankMeta.logo} style={{ width: '18px', height: '18px', borderRadius: '3px', objectFit: 'cover' }} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                      <span>{wBankName}</span>
                                    </div>
                                    <div style={{ fontWeight: 700, fontSize: '15px', minWidth: '70px', textAlign: 'right' }}>{formatMXN(w.amount)}</div>
                                  </div>
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
          </div>{/* fin finance-withdrawal-body */}
        </div>

        {/* COLUMNA DERECHA: Gastos e Ingresos */}
        <div className="finance-col">
          <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <span>
              <ReceiptIcon size={16} /> Gastos e Ingresos
              <span className="badge badge-info" style={{ marginLeft: '8px' }}>{entries.length}</span>
              {expenseEntries.filter(e => e.status === 'pending').length > 0 && (
                <span className="badge badge-warning" style={{ marginLeft: '4px' }}>{expenseEntries.filter(e => e.status === 'pending').length} pendiente{expenseEntries.filter(e => e.status === 'pending').length !== 1 ? 's' : ''}</span>
              )}
            </span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="alert-action-btn edit" onClick={() => setAddExpenseModal(true)} style={{ fontSize: '12px' }}>
                <PlusIcon size={14} /> Gasto
              </button>
              <button className="alert-action-btn edit" onClick={() => setAddDepositModal(true)} style={{ fontSize: '12px', background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>
                <PlusIcon size={14} /> Ingreso
              </button>
            </div>
          </div>

          {/* Filtros */}
          <div className="alerts-tabs" style={{ marginBottom: '8px' }}>
            <button className={`alert-tab ${ledgerFilter === 'all' ? 'active' : ''}`} onClick={() => setLedgerFilter('all')}>
              Todos ({entries.length})
            </button>
            <button className={`alert-tab ${ledgerFilter === 'expenses' ? 'active' : ''}`} onClick={() => setLedgerFilter('expenses')}>
              <ExpenseIcon size={12} /> Gastos ({expenseEntries.length})
            </button>
            <button className={`alert-tab ${ledgerFilter === 'income' ? 'active' : ''}`} onClick={() => setLedgerFilter('income')}>
              <DepositIcon size={12} /> Ingresos ({depositEntries.length})
            </button>
          </div>

          {(() => {
            const filteredEntries = ledgerFilter === 'expenses' ? expenseEntries
              : ledgerFilter === 'income' ? depositEntries
              : entries;

            const sortedEntries = [...filteredEntries].sort((a, b) => (b.effectiveAt || '').localeCompare(a.effectiveAt || ''));

            const pendingEntries = sortedEntries.filter(e => e.status === 'pending');
            const confirmedEntries = sortedEntries.filter(e => e.status !== 'pending');

            if (sortedEntries.length === 0) {
              return (
                <div className="empty-state" style={{ padding: '20px' }}>
                  <p>{ledgerFilter === 'expenses' ? 'Sin gastos este mes' : ledgerFilter === 'income' ? 'Sin ingresos este mes' : 'Sin movimientos este mes'}</p>
                </div>
              );
            }

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '500px', overflowY: 'auto' }}>
                {/* Pendientes */}
                {pendingEntries.length > 0 && (
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent-warning)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 0' }}>
                    <HourglassIcon size={14} /> Cobros pendientes de confirmación
                  </div>
                )}
                {pendingEntries.map((entry, i) => {
                  const entryId = getEntryIdentifier(entry);
                  const editedAmount = entryId ? pendingAmounts[entryId] : undefined;
                  const displayAmount = editedAmount !== undefined ? editedAmount : (entry.amount || '');
                  const finalAmount = editedAmount !== undefined ? parseFloat(editedAmount) : (entry.amount || 0);
                  const needsAmount = !entry.amount || entry.amount <= 0;
                  const cardLabel = entry.cardLabel || (entry.cardId && entry.notes?.[0]?.startsWith('Cobro automático — ')
                    ? entry.notes[0].replace('Cobro automático — ', '') : '');
                  const entryBankMeta = entry.bankAccount ? getBankMeta(entry.bankAccount) : null;
                  return (
                    <div className="ledger-entry" key={`pending-${i}`} style={{ borderLeft: '3px solid var(--accent-warning)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: '14px' }}>
                            {entry.description}
                            <span className="badge badge-warning" style={{ marginLeft: '8px', fontSize: '10px' }}>Pendiente</span>
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {entry.effectiveAt && <span><CalendarIcon size={12} /> {entry.effectiveAt}</span>}
                            {entry.subscription && <span>· {entry.subscription}</span>}
                            {entry.isRecurring && <span>· <RefreshIcon size={12} /> Recurrente</span>}
                            {cardLabel && <span>· <CreditCardIcon size={12} /> {cardLabel}</span>}
                            {entryBankMeta && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                                · {entryBankMeta.logo && <img src={entryBankMeta.logo} style={{ width: '14px', height: '14px', borderRadius: '3px', objectFit: 'cover' }} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                {entry.bankAccount}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>$</span>
                              <input
                                type="number"
                                value={displayAmount}
                                onChange={e => {
                                  if (!entryId) return;
                                  setPendingAmounts(prev => ({ ...prev, [entryId]: e.target.value }));
                                }}
                                placeholder={needsAmount ? 'Monto' : '0.00'}
                                style={{
                                  width: '100%', maxWidth: needsAmount ? '100px' : '80px', minWidth: '60px',
                                  fontWeight: 700, fontSize: '15px',
                                  color: needsAmount ? 'var(--accent-warning)' : 'var(--text-primary)',
                                  background: 'var(--bg-input)', border: '1px solid var(--border-color)',
                                  borderRadius: 'var(--radius-sm)', padding: '3px 6px', textAlign: 'right',
                                }}
                              />
                            </div>
                            {needsAmount && <div style={{ fontSize: '10px', color: 'var(--accent-warning)', marginTop: '2px' }}>Requerido</div>}
                          </div>
                          <button
                            className="alert-action-btn edit"
                            disabled={confirmingExpenseIdx === entryId || (finalAmount <= 0 && !editedAmount)}
                            onClick={async () => {
                              const amountToConfirm = parseFloat(displayAmount);
                              if (!amountToConfirm || amountToConfirm <= 0) {
                                showExpenseToast('Ingresa un monto válido antes de confirmar', 'error');
                                return;
                              }
                              if (!entryId) {
                                showExpenseToast('No se pudo identificar el cobro a confirmar', 'error');
                                return;
                              }
                              if (confirmingExpenseIdx !== null) return;
                              setConfirmingExpenseIdx(entryId);
                              try {
                                await confirmRecurringExpense(entryId, amountToConfirm !== entry.amount ? amountToConfirm : null);
                                showExpenseToast(`Cobro "${entry.description}" confirmado — ${formatMXN(amountToConfirm)}`);
                                setPendingAmounts(prev => { const next = {...prev}; delete next[entryId]; return next; });
                              } catch (err) {
                                showExpenseToast('Error: ' + err.message, 'error');
                              } finally {
                                setConfirmingExpenseIdx(null);
                              }
                            }}
                            title="Confirmar cobro"
                            style={{ fontSize: '11px', whiteSpace: 'nowrap' }}
                          >
                            {confirmingExpenseIdx === entryId
                              ? <><span className="spinner" /> ...</>
                              : <><CheckCircleIcon size={14} /> OK</>
                            }
                          </button>
                          <button
                            className="clabe-remove-btn"
                            onClick={() => setRemoveExpenseConfirm({ entry })}
                            title="Eliminar cobro"
                          >
                            <TrashIcon size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Confirmados / Registrados */}
                {pendingEntries.length > 0 && confirmedEntries.length > 0 && (
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 0' }}>
                    <CheckCircleIcon size={14} /> Registrados
                  </div>
                )}
                {confirmedEntries.map((entry, i) => {
                  const isDeposit = entry.type === 'deposit';
                  const typeLabels = { expense: <><ExpenseIcon size={14} /> Gasto</>, investment: <><ExpenseIcon size={14} /> Inversión</>, income_adjustment: <><MoneyIcon size={14} /> Ajuste +</>, expense_refund: <><RefreshIcon size={14} /> Devolución</>, deposit: <><DepositIcon size={14} /> Ingreso</> };
                  const typeBadge = { expense: 'badge-danger', investment: 'badge-danger', income_adjustment: 'badge-success', expense_refund: 'badge-info', deposit: 'badge-success' };
                  const cardLabel = entry.cardLabel || (entry.cardId && entry.notes?.[0]?.startsWith('Cobro automático — ')
                    ? entry.notes[0].replace('Cobro automático — ', '') : '');
                  const entryBankMeta = entry.bankAccount ? getBankMeta(entry.bankAccount) : null;
                  return (
                    <div className="ledger-entry" key={`confirmed-${i}`} style={{ borderLeft: `3px solid ${isDeposit ? '#10b981' : 'var(--accent-danger, #ef4444)'}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {entry.description}
                            <span className={`badge ${typeBadge[entry.type] || 'badge-danger'}`} style={{ fontSize: '10px' }}>{typeLabels[entry.type] || <><ExpenseIcon size={14} /> Gasto</>}</span>
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {entry.effectiveAt && <span><CalendarIcon size={12} /> {entry.effectiveAt}</span>}
                            {entry.subscription && <span>· {entry.subscription}</span>}
                            {entry.isRecurring && <span>· <RefreshIcon size={12} /> Recurrente</span>}
                            {cardLabel && <span>· <CreditCardIcon size={12} /> {cardLabel}</span>}
                            {entryBankMeta && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                                · {entryBankMeta.logo && <img src={entryBankMeta.logo} style={{ width: '14px', height: '14px', borderRadius: '3px', objectFit: 'cover' }} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                {entry.bankAccount}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <div style={{ fontWeight: 700, fontSize: '16px', color: isDeposit ? '#10b981' : 'inherit' }}>
                            {isDeposit ? '+' : '-'}{formatMXN(entry.amount)}
                          </div>
                          <button
                            className="clabe-remove-btn"
                            onClick={() => isDeposit ? setEditDepositModal({ entry }) : setEditExpenseModal({ entry })}
                            title="Editar"
                            style={{ fontSize: '11px' }}
                          >
                            <EditIcon size={14} />
                          </button>
                          <button
                            className="clabe-remove-btn"
                            onClick={() => isDeposit ? setRemoveDepositConfirm({ entry }) : setRemoveExpenseConfirm({ entry })}
                            title="Eliminar"
                          >
                            <TrashIcon size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ═══ CUENTAS BANCARIAS (unificado: CLABEs + Retiros) ═══ */}
      <div className="finance-section" style={{ marginTop: '24px' }}>
        <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span><BankIcon size={16} /> Cuentas Bancarias</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>Editar en Bóveda → Bancos</span>
        </div>

        {/* Cuentas de débito */}
        {(() => {
          // Construir lista unificada: todos los bancos (de CLABEs + retiros)
          const debitClabes = clabes.filter(c => c.type !== 'credito');
          const allDebitBanks = new Set([
            ...debitClabes.map(c => c.bank),
            ...Object.keys(byBank).filter(b => !clabes.find(c => c.type === 'credito' && c.bank === b)),
          ]);

          if (allDebitBanks.size === 0 && Object.keys(byBank).length === 0) return null;

          return (
            <>
              {allDebitBanks.size > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>
                    <CreditCardIcon size={16} /> Cuentas de débito
                  </div>
                  <div className="bank-grid-3">
                    {[...allDebitBanks].map(bankName => {
                      const bankMeta = getBankMeta(bankName);
                      const clabeEntry = debitClabes.find(c => c.bank === bankName);
                      const isCopied = clabeEntry && copiedClabe === clabeEntry.clabe;
                      const bankData = byBank[bankName];
                      const isOpen = expandedBank === bankName;

                      return (
                        <div className="clabe-card" key={bankName} style={{ '--bank-color': bankMeta.color }}>
                          <div className="clabe-card-header">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {bankMeta.logo && <img src={bankMeta.logo} className="bank-logo-xl" alt="" onError={e => { e.target.style.display = 'none'; }} />}
                              <div>
                                <div style={{ fontWeight: 700, fontSize: '14px' }}>{bankName}</div>
                                {bankData && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                    {bankData.count} retiro{bankData.count !== 1 ? 's' : ''} · {formatMXN(bankData.total)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* CLABE copiable */}
                          {clabeEntry && (
                            <div
                              className={`clabe-number ${isCopied ? 'copied' : ''}`}
                              onClick={() => handleCopyClabe(clabeEntry.clabe, bankName)}
                              title="Clic para copiar CLABE"
                            >
                              <span className="clabe-digits">{clabeEntry.clabe}</span>
                              <span className="clabe-copy-icon">{isCopied ? <CheckCircleIcon size={16} /> : <ClipboardIcon size={16} />}</span>
                            </div>
                          )}

                          {clabeEntry?.note && <div className="clabe-note"><WarningIcon size={16} /> {clabeEntry.note}</div>}

                          {/* Retiros del banco (accordion) */}
                          {bankData && bankData.items.length > 0 && (
                            <div style={{ marginTop: '8px' }}>
                              <div
                                className="bank-withdrawals-toggle"
                                onClick={() => setExpandedBank(isOpen ? null : bankName)}
                              >
                                <span><ReceiptIcon size={16} /> {bankData.count} retiro{bankData.count !== 1 ? 's' : ''}</span>
                                <span style={{ fontSize: '12px', color: 'var(--text-muted)', transition: 'transform 0.3s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                              </div>
                              {isOpen && (
                                <div className="bank-accordion-body" style={{ marginTop: '4px' }}>
                                  {bankData.items
                                    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
                                    .map((w, wi) => (
                                      <div className="bank-accordion-row" key={wi}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                          <span className="bank-accordion-date">
                                            {w.completedAt
                                              ? new Date(w.completedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                                              : 'Pendiente'}
                                          </span>
                                        </div>
                                        <div style={{ fontWeight: 700, fontSize: '15px' }}>{formatMXN(w.amount)}</div>
                                      </div>
                                    ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Cuentas de crédito */}
              {clabes.filter(c => c.type === 'credito').length > 0 && (
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>
                     Cuentas de crédito (solo para pagar)
                  </div>
                  <div className="bank-grid-3">
                    {clabes.filter(c => c.type === 'credito').map((c, idx) => {
                      const bankMeta = getBankMeta(c.bank);
                      const isCopied = copiedClabe === c.clabe;
                      const bankData = byBank[c.bank];
                      const isOpen = expandedBank === c.bank;

                      return (
                        <div className="clabe-card credit" key={`c-${idx}`} style={{ '--bank-color': bankMeta.color }}>
                          <div className="clabe-card-header">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              {bankMeta.logo && <img src={bankMeta.logo} className="bank-logo-xl" alt="" onError={e => { e.target.style.display = 'none'; }} />}
                              <div>
                                <div style={{ fontWeight: 700, fontSize: '14px' }}>{c.bank}</div>
                                {bankData && (
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                    {bankData.count} retiro{bankData.count !== 1 ? 's' : ''} · {formatMXN(bankData.total)}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`clabe-number ${isCopied ? 'copied' : ''}`}
                            onClick={() => handleCopyClabe(c.clabe, c.bank)}
                            title="Clic para copiar CLABE"
                          >
                            <span className="clabe-digits">{c.clabe}</span>
                            <span className="clabe-copy-icon">{isCopied ? <CheckCircleIcon size={16} /> : <ClipboardIcon size={16} />}</span>
                          </div>
                          {c.note && <div className="clabe-note"><WarningIcon size={16} /> {c.note}</div>}

                          {/* Retiros del banco de crédito (si existen) */}
                          {bankData && bankData.items.length > 0 && (
                            <div style={{ marginTop: '8px' }}>
                              <div
                                className="bank-withdrawals-toggle"
                                onClick={() => setExpandedBank(isOpen ? null : c.bank)}
                              >
                                <span><ReceiptIcon size={16} /> {bankData.count} retiro{bankData.count !== 1 ? 's' : ''}</span>
                                <span style={{ fontSize: '12px', color: 'var(--text-muted)', transition: 'transform 0.3s', transform: isOpen ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                              </div>
                              {isOpen && (
                                <div className="bank-accordion-body" style={{ marginTop: '4px' }}>
                                  {bankData.items
                                    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
                                    .map((w, wi) => (
                                      <div className="bank-accordion-row" key={wi}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                          <span className="bank-accordion-date">
                                            {w.completedAt
                                              ? new Date(w.completedAt).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                                              : 'Pendiente'}
                                          </span>
                                        </div>
                                        <div style={{ fontWeight: 700, fontSize: '15px' }}>{formatMXN(w.amount)}</div>
                                      </div>
                                    ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* ═══ HISTORIAL DE MESES ANTERIORES ═══ */}
      {monthlyHistory.length > 0 && (
        <div className="finance-section" style={{ marginTop: '32px' }}>
          <div className="finance-section-title"> Historial de Meses Anteriores</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {monthlyHistory.map(mData => {
              const [y, m] = mData.key.split('-').map(Number);
              const label = getMonthLabel(y, m - 1);
              const isRecent = isRecentMonth(mData.key);
              const isExpanded = expandedHistMonth === mData.key;
              const mt = mData.totals || {};
              const histDeposits = mt.manualDepositsGross || 0;
              const histExpenses = (mt.manualExpensesGross || 0) + (mt.manualInvestmentsGross || 0);
              const histNet = (mt.withdrawalCompletedGross || 0) + histDeposits - histExpenses;
              const histWds = historyWithdrawals[mData.key] || [];
              const histManualEntries = (() => {
                const fromLedger = allEntries.filter(e => getEntryMonthKey(e.effectiveAt) === mData.key);
                const fromMonth = mData.manualEntries || [];
                // Combinar: ledger + entries del doc mensual que no estén en ledger
                const seenIds = new Set(fromLedger.map(e => e.entryId).filter(Boolean));
                const extra = fromMonth.filter(e => !e.entryId || !seenIds.has(e.entryId));
                return [...fromLedger, ...extra];
              })();

              // Agrupar retiros por banco para meses no recientes
              const histByBank = {};
              histWds.forEach(w => {
                const bank = resolveBankName(w);
                if (!histByBank[bank]) histByBank[bank] = { total: 0, count: 0 };
                histByBank[bank].total += w.amount || 0;
                histByBank[bank].count += 1;
              });

              return (
                <div className="history-month-card" key={mData.key}>
                  <div
                    className={`history-month-header ${isExpanded ? 'expanded' : ''}`}
                    onClick={() => setExpandedHistMonth(isExpanded ? null : mData.key)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div className="history-month-icon">{isRecent ? <BarChartIcon size={16} /> : <FolderIcon size={16} />}</div>
                      <div>
                        <div className="history-month-label">{label}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          {mData.accountCount || 0} cuentas · {isRecent ? 'Mes anterior — detalle completo' : 'Resumen'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                      <div className="history-kpi">
                        <span className="history-kpi-label">Retirado</span>
                        <span className="history-kpi-value" style={{ color: '#3b82f6' }}>{formatMXN(mt.withdrawalCompletedGross || 0)}</span>
                      </div>
                      {histDeposits > 0 && (
                        <div className="history-kpi">
                          <span className="history-kpi-label">Ingresos</span>
                          <span className="history-kpi-value" style={{ color: '#10b981' }}>{formatMXN(histDeposits)}</span>
                        </div>
                      )}
                      <div className="history-kpi">
                        <span className="history-kpi-label">Gastos</span>
                        <span className="history-kpi-value" style={{ color: '#ef4444' }}>{formatMXN(histExpenses)}</span>
                      </div>
                      <div className="history-kpi">
                        <span className="history-kpi-label">Neto</span>
                        <span className="history-kpi-value" style={{ color: histNet >= 0 ? '#10b981' : '#ef4444' }}>{formatMXN(histNet)}</span>
                      </div>
                      <span style={{ fontSize: '14px', color: 'var(--text-muted)', transition: 'transform 0.3s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                    </div>
                  </div>

                  {/* Detalle expandido — disponible para TODOS los meses */}
                  {isExpanded && (
                    <div className="history-month-body">
                      {/* KPIs detallados */}
                      <div className="history-detail-grid">
                        <div className="history-detail-item">
                          <span className="history-detail-label"><BankIcon size={16} /> Retirado bruto</span>
                          <span className="history-detail-val">{formatMXN(mt.withdrawalCompletedGross || 0)}</span>
                        </div>
                        <div className="history-detail-item">
                          <span className="history-detail-label"><ExpenseIcon size={16} /> Gastos</span>
                          <span className="history-detail-val" style={{ color: '#ef4444' }}>{formatMXN(mt.manualExpensesGross || 0)}</span>
                        </div>
                        {(mt.manualInvestmentsGross || 0) > 0 && (
                          <div className="history-detail-item">
                            <span className="history-detail-label"><ExpenseIcon size={16} /> Gastos (inversión)</span>
                            <span className="history-detail-val" style={{ color: '#ef4444' }}>{formatMXN(mt.manualInvestmentsGross || 0)}</span>
                          </div>
                        )}
                        {(mt.manualDepositsGross || 0) > 0 && (
                          <div className="history-detail-item">
                            <span className="history-detail-label"><DepositIcon size={16} /> Ingresos</span>
                            <span className="history-detail-val" style={{ color: '#10b981' }}>{formatMXN(mt.manualDepositsGross || 0)}</span>
                          </div>
                        )}
                        <div className="history-detail-item">
                          <span className="history-detail-label"><CheckCircleIcon size={16} /> Retiros completados</span>
                          <span className="history-detail-val">{mt.completedWithdrawals || 0}</span>
                        </div>
                        <div className="history-detail-item">
                          <span className="history-detail-label"><TrendUpIcon size={16} /> Ganancia neta</span>
                          <span className="history-detail-val" style={{ color: histNet >= 0 ? '#10b981' : '#ef4444', fontWeight: 800 }}>
                            {formatMXN(histNet)}
                          </span>
                        </div>
                      </div>

                      {/* Gastos detallados del mes */}
                      {histManualEntries.length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            <ExpenseIcon size={16} /> Movimientos del mes ({histManualEntries.length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {histManualEntries.map((e, ei) => {
                              const entryIndex = findLedgerEntryIndex(allEntries, e);
                              const canEdit = entryIndex >= 0 && e.effectiveAt >= minDate && e.effectiveAt <= maxDate;
                              return (
                              <div key={ei} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '6px 10px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)',
                                fontSize: '13px',
                              }}>
                                <div>
                                  <span style={{ fontWeight: 600 }}>{e.description}</span>
                                  {e.subscription && <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>({e.subscription})</span>}
                                  {e.effectiveAt && <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '11px' }}><CalendarIcon size={12} /> {e.effectiveAt}</span>}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ fontWeight: 700, color: e.type === 'deposit' ? '#10b981' : '#ef4444' }}>{e.type === 'deposit' ? '+' : ''}{formatMXN(e.amount)}</span>
                                  {canEdit && (
                                    <>
                                      <button
                                        className="clabe-remove-btn"
                                        onClick={() => e.type === 'deposit' ? setEditDepositModal({ index: entryIndex, entry: e }) : setEditExpenseModal({ index: entryIndex, entry: e })}
                                        title={e.type === 'deposit' ? 'Editar ingreso' : 'Editar gasto'}
                                      >
                                        <EditIcon size={16} />
                                      </button>
                                      <button
                                        className="clabe-remove-btn"
                                        onClick={() => e.type === 'deposit' ? setRemoveDepositConfirm({ index: entryIndex, entry: e }) : setRemoveExpenseConfirm({ index: entryIndex, entry: e })}
                                        title={e.type === 'deposit' ? 'Eliminar ingreso' : 'Eliminar gasto'}
                                      >
                                        <TrashIcon size={16} />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Retiros por banco */}
                      {Object.keys(histByBank).length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            <BankIcon size={16} /> Retiros por banco
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {Object.entries(histByBank)
                              .sort(([,a], [,b]) => b.total - a.total)
                              .map(([bankName, data]) => {
                                const bankMeta = getBankMeta(bankName);
                                return (
                                  <div key={bankName} style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '6px 10px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)',
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                      <div className="bank-badge" style={{ '--bank-color': bankMeta.color, fontSize: '11px', padding: '2px 6px' }}>
                                        {bankMeta.logo && <img src={bankMeta.logo} style={{ width: '16px', height: '16px', borderRadius: '2px' }} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                        <span>{bankName}</span>
                                      </div>
                                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{data.count} retiro{data.count !== 1 ? 's' : ''}</span>
                                    </div>
                                    <span style={{ fontWeight: 700, fontSize: '14px' }}>{formatMXN(data.total)}</span>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      )}

                      {/* Lista completa de retiros — solo mes reciente */}
                      {isRecent && histWds.length > 0 && (
                        <div style={{ marginTop: '16px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            <ReceiptIcon size={16} /> Retiros del mes ({histWds.length})
                          </div>
                          <div className="withdrawal-list" style={{ maxHeight: '300px', overflow: 'auto' }}>
                            {histWds.map((w, i) => {
                              const wBankName = resolveBankName(w);
                              const bankMeta = getBankMeta(wBankName);
                              const isPending = !w.completedAt;
                              return (
                                <div className="withdrawal-row" key={i} style={{ padding: '8px 12px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                                    {w.accountId && (
                                      <img src={getProfileImage(w.accountId)} className="w-avatar-lg" alt="" style={{ width: '28px', height: '28px' }} onError={e => { e.target.style.display = 'none'; }} />
                                    )}
                                    <div>
                                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{w.accountAlias}</div>
                                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                        <ClockIcon size={16} /> {formatDateTime(w.completedAt || w.requestedAt)}
                                        {isPending && ' (pendiente)'}
                                      </div>
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div className="bank-badge" style={{ '--bank-color': bankMeta.color, fontSize: '11px', padding: '2px 6px' }}>
                                      {bankMeta.logo && <img src={bankMeta.logo} style={{ width: '16px', height: '16px', borderRadius: '2px' }} alt="" onError={e => { e.target.style.display = 'none'; }} />}
                                      <span>{wBankName}</span>
                                    </div>
                                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{formatMXN(w.amount)}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}



      {/* Modal: Agregar gasto/inversión manual */}
      <EditModal
        open={addExpenseModal}
        onClose={() => setAddExpenseModal(false)}
        onSave={handleAddExpense}
        validate={validateExpenseDate}
        title="Registrar gasto manual"
        icon=""
        fields={[
          { key: 'description', label: 'Descripción', required: true, placeholder: 'Ej: Pago mensual YouTube Premium' },
          { key: 'amount', label: 'Monto (MXN)', required: true, type: 'number', placeholder: '0.00' },
          { key: 'type', label: 'Tipo', type: 'select', options: [
            { value: 'expense', label: 'Gasto' },
            { value: 'investment', label: 'Gasto (inversión)' },
          ]},
          { key: 'effectiveAt', label: `Fecha efectiva (${minDate} a ${maxDate})`, type: 'date', hint: 'Dejar vacío = fecha de hoy. Si la fecha cae en otro mes, el gasto se aplica a ese mes.' },
          { key: 'subscription', label: 'Suscripción (opcional)', placeholder: 'Ej: YouTube Premium, ChatGPT Plus...' },
          { key: 'note', label: 'Nota (opcional)', placeholder: 'Contexto adicional del gasto' },
        ]}
        initialValues={{ description: '', amount: '', type: 'expense', effectiveAt: '', subscription: '', note: '' }}
        saveLabel={<><ExpenseIcon size={16} /> Registrar</>}
        confirmMessage="Se registrará este gasto y se actualizarán los totales del mes correspondiente."
      />

      {/* Modal: Editar gasto existente */}
      {editExpenseModal && (
        <EditModal
          open={true}
          onClose={() => setEditExpenseModal(null)}
          onSave={handleEditExpense}
          validate={validateExpenseDate}
          title="Editar gasto"
          icon=""
          resetKey={editExpenseModal.entry.entryId || editExpenseModal.index}
          fields={[
            { key: 'description', label: 'Descripción', required: true, placeholder: 'Ej: Pago mensual YouTube Premium' },
            { key: 'amount', label: 'Monto (MXN)', required: true, type: 'number', placeholder: '0.00' },
            { key: 'type', label: 'Tipo', type: 'select', options: [
              { value: 'expense', label: 'Gasto' },
              { value: 'investment', label: 'Gasto (inversión)' },
            ]},
            { key: 'effectiveAt', label: `Fecha efectiva (${minDate} a ${maxDate})`, type: 'date', hint: 'Si cambias a otro mes, el gasto se mueve a ese mes.' },
            { key: 'subscription', label: 'Suscripción (opcional)', placeholder: 'Ej: YouTube Premium, ChatGPT Plus...' },
            { key: 'note', label: 'Nota (opcional)', placeholder: 'Contexto adicional del gasto' },
          ]}
          initialValues={{
            description: editExpenseModal.entry.description || '',
            amount: editExpenseModal.entry.amount || '',
            type: editExpenseModal.entry.type || 'expense',
            effectiveAt: editExpenseModal.entry.effectiveAt || '',
            subscription: editExpenseModal.entry.subscription || '',
            note: (editExpenseModal.entry.notes || [])[0] || '',
          }}
          saveLabel="Guardar cambios"
          confirmMessage="Se actualizará este gasto y se recalcularán los totales."
        />
      )}

      {/* Diálogo: Confirmar eliminación de gasto */}
      <ConfirmDialog
        open={!!removeExpenseConfirm}
        onClose={() => setRemoveExpenseConfirm(null)}
        onConfirm={handleRemoveExpenseConfirm}
        title="Eliminar gasto"
        message={removeExpenseConfirm ? `¿Eliminar "${removeExpenseConfirm.entry.description}" por ${formatMXN(removeExpenseConfirm.entry.amount)}? Los totales del mes se actualizarán.` : ''}
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Toast gastos */}
      <Toast {...expenseToast} onClose={() => setExpenseToast(prev => ({ ...prev, visible: false }))} />

      {/* ═══ MODALES DE DEPÓSITOS ═══ */}

      {/* Modal: Registrar depósito/ingreso */}
      <EditModal
        open={addDepositModal}
        onClose={() => setAddDepositModal(false)}
        onSave={handleAddDeposit}
        validate={validateExpenseDate}
        title="Registrar ingreso / depósito"
        icon={<DepositIcon size={16} />}
        fields={[
          { key: 'description', label: 'Descripción', required: true, placeholder: 'Ej: Transferencia de nómina, Pago freelance...' },
          { key: 'amount', label: 'Monto (MXN)', required: true, type: 'number', placeholder: '0.00' },
          { key: 'bankAccount', label: 'Cuenta bancaria destino', type: 'select', options: bankAccountOptions.length > 0
            ? bankAccountOptions
            : [{ value: '', label: 'No hay cuentas registradas' }],
            placeholder: 'Seleccionar banco' },
          { key: 'effectiveAt', label: `Fecha efectiva (${minDate} a ${maxDate})`, type: 'date', hint: 'Dejar vacío = fecha de hoy. Si la fecha cae en otro mes, el ingreso se aplica a ese mes.' },
          { key: 'note', label: 'Nota (opcional)', placeholder: 'Contexto adicional del ingreso' },
        ]}
        initialValues={{ description: '', amount: '', bankAccount: '', effectiveAt: '', note: '' }}
        saveLabel={<><DepositIcon size={16} /> Registrar</>}
        confirmMessage="Se registrará este ingreso y se actualizarán los totales del mes correspondiente."
      />

      {/* Modal: Editar depósito/ingreso existente */}
      {editDepositModal && (
        <EditModal
          open={true}
          onClose={() => setEditDepositModal(null)}
          onSave={handleEditDeposit}
          validate={validateExpenseDate}
          title="Editar ingreso"
          icon={<DepositIcon size={16} />}
          resetKey={editDepositModal.entry.entryId || editDepositModal.index}
          fields={[
            { key: 'description', label: 'Descripción', required: true, placeholder: 'Ej: Transferencia de nómina...' },
            { key: 'amount', label: 'Monto (MXN)', required: true, type: 'number', placeholder: '0.00' },
            { key: 'bankAccount', label: 'Cuenta bancaria destino', type: 'select', options: bankAccountOptions.length > 0
              ? bankAccountOptions
              : [{ value: '', label: 'No hay cuentas registradas' }],
              placeholder: 'Seleccionar banco' },
            { key: 'effectiveAt', label: `Fecha efectiva (${minDate} a ${maxDate})`, type: 'date', hint: 'Si cambias a otro mes, el ingreso se mueve a ese mes.' },
            { key: 'note', label: 'Nota (opcional)', placeholder: 'Contexto adicional del ingreso' },
          ]}
          initialValues={{
            description: editDepositModal.entry.description || '',
            amount: editDepositModal.entry.amount || '',
            bankAccount: editDepositModal.entry.bankAccount || '',
            effectiveAt: editDepositModal.entry.effectiveAt || '',
            note: (editDepositModal.entry.notes || [])[0] || '',
          }}
          saveLabel="Guardar cambios"
          confirmMessage="Se actualizará este ingreso y se recalcularán los totales."
        />
      )}

      {/* Diálogo: Confirmar eliminación de depósito */}
      <ConfirmDialog
        open={!!removeDepositConfirm}
        onClose={() => setRemoveDepositConfirm(null)}
        onConfirm={handleRemoveDepositConfirm}
        title="Eliminar ingreso"
        message={removeDepositConfirm ? `¿Eliminar "${removeDepositConfirm.entry.description}" por ${formatMXN(removeDepositConfirm.entry.amount)}? Los totales del mes se actualizarán.` : ''}
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Toast depósitos */}
      <Toast {...depositToast} onClose={() => setDepositToast(prev => ({ ...prev, visible: false }))} />

 </>
 );
}
