import { useState, useEffect, useMemo, useCallback } from 'react';
import { useDocument } from '../hooks/useFirestore';
import { collection, onSnapshot, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatMXN, getBankMeta, getProfileImage, BANKS } from '../config/services';
import { confirmRecurringExpense, saveCreditAccount, deleteCreditAccount, addCreditInstallment, removeCreditInstallment, saveCreditStatement, logManualChange } from '../hooks/firestoreActions';
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

 const showDepositToast = useCallback((msg, type = 'success') => {
   setDepositToast({ visible: true, message: msg, type });
 }, []);

 // Credit accounts state
 const [creditAccounts, setCreditAccounts] = useState([]);
 const [loadingCredit, setLoadingCredit] = useState(true);
 const [vaultCards, setVaultCards] = useState({});
 const [expandedCredit, setExpandedCredit] = useState(null);
 const [creditExpandSection, setCreditExpandSection] = useState({}); // { [accountId]: 'installments' | 'statements' | null }
 const [creditModal, setCreditModal] = useState(null); // null | 'create' | { ...account }
 const [installmentModal, setInstallmentModal] = useState(null); // null | accountId
 const [statementModal, setStatementModal] = useState(null); // null | accountId
 const [deleteCreditConfirm, setDeleteCreditConfirm] = useState(null);
 const [deleteInstallmentConfirm, setDeleteInstallmentConfirm] = useState(null);
 const [creditToast, setCreditToast] = useState({ visible: false, message: '', type: 'success' });
 const showCreditToast = useCallback((msg, type = 'success') => {
   setCreditToast({ visible: true, message: msg, type });
 }, []);

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
 const [loadingClabes, setLoadingClabes] = useState(true);
 const [copiedClabe, setCopiedClabe] = useState(null);
 const [addClabeModal, setAddClabeModal] = useState(false);
 const [removeClabeConfirm, setRemoveClabeConfirm] = useState(null);
 const [clabeToast, setClabeToast] = useState({ visible: false, message: '', type: 'success' });

 const showClabeToast = useCallback((msg, type = 'success') => {
 setClabeToast({ visible: true, message: msg, type });
 }, []);

 // Available vault cards for linking (build options list)
 const vaultCardOptions = useMemo(() => {
   return Object.entries(vaultCards).map(([id, card]) => ({
     value: id,
     label: `${card.bank || ''} ****${card.lastFour || ''}`.trim(),
   }));
 }, [vaultCards]);

 // Available CLABEs de crédito for linking
 const creditClabeOptions = useMemo(() => {
   return clabes
     .map((c, idx) => c.type === 'credito' ? { value: idx, label: `${c.bank} — ${c.clabe}` } : null)
     .filter(Boolean);
 }, [clabes]);

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
 const unsub = onSnapshot(colRef, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setWithdrawals(docs.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')));
 });
 return () => unsub();
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
 if (historyWithdrawals[expandedHistMonth]) return; // ya cargados

 const [year, monthStr] = expandedHistMonth.split('-');
 const monthIndex = parseInt(monthStr, 10) - 1;
 const monthName = MONTH_NAMES_EN[monthIndex];
 const colRef = collection(db, `finance/withdrawals-${monthName}/records`);

 const unsub = onSnapshot(colRef, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setHistoryWithdrawals(prev => ({
        ...prev,
        [expandedHistMonth]: docs.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')),
      }));
 });

 return () => unsub();
 }, [expandedHistMonth]);

 // Cargar CLABEs bancarias
 useEffect(() => {
 const clabeRef = doc(db, 'finance', 'bank-clabes');
 const unsub = onSnapshot(clabeRef, snap => {
      if (snap.exists()) {
        const data = snap.data();
        setClabes(data.accounts || []);
      } else {
        setClabes([]);
      }
      setLoadingClabes(false);
 });
 return () => unsub();
 }, []);

 // Cargar cuentas de crédito
 useEffect(() => {
   const creditRef = doc(db, 'finance', 'credit-accounts');
   const unsub = onSnapshot(creditRef, snap => {
     if (snap.exists()) {
       setCreditAccounts(snap.data().accounts || []);
     } else {
       setCreditAccounts([]);
     }
     setLoadingCredit(false);
   }, (err) => {
     console.warn('credit-accounts listener error:', err);
     setCreditAccounts([]);
     setLoadingCredit(false);
   });
   return () => unsub();
 }, []);

 // Cargar vault-cards (para vincular tarjetas con cuentas de crédito)
 useEffect(() => {
   const unsub = onSnapshot(collection(db, 'vault-cards'), snap => {
     const cards = {};
     snap.docs.forEach(d => { cards[d.id] = { id: d.id, ...d.data() }; });
     setVaultCards(cards);
   }, (err) => {
     console.warn('vault-cards listener error:', err);
     setVaultCards({});
   });
   return () => unsub();
 }, []);

 // CLABE handlers
 const handleCopyClabe = (clabe, bank) => {
 navigator.clipboard.writeText(clabe).then(() => {
      setCopiedClabe(clabe);
      setTimeout(() => setCopiedClabe(null), 2000);
 });
 };

 const handleAddClabe = async (values) => {
 if (!values.bank?.trim() || !values.clabe?.trim()) return;
 const newEntry = {
      bank: values.bank.trim(),
      clabe: values.clabe.trim(),
      type: values.type || 'debito',
 };
 if (values.note?.trim()) newEntry.note = values.note.trim();

 const ref = doc(db, 'finance', 'bank-clabes');
 const updatedAccounts = [...clabes, newEntry];
 await updateDoc(ref, { accounts: updatedAccounts });
 showClabeToast(`CLABE de ${newEntry.bank} agregada`);
 };

 const handleRemoveClabeConfirm = async () => {
 if (removeClabeConfirm === null) return;
 try {
 const ref = doc(db, 'finance', 'bank-clabes');
 const updatedAccounts = clabes.filter((_, i) => i !== removeClabeConfirm.index);
 await updateDoc(ref, { accounts: updatedAccounts });
 showClabeToast(`CLABE de ${removeClabeConfirm.bank} eliminada`);
 setRemoveClabeConfirm(null);
 } catch (err) {
 showClabeToast(`Error al eliminar: ${err.message}`, 'error');
 throw err;
 }
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
 const { index, entry: oldEntry } = editExpenseModal;
 if (index < 0) return; // Protección: entry no encontrada en ledger
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

 // Actualizar en manual-ledger
 const ledgerRef = doc(db, 'finance', 'manual-ledger');
 const currentEntries = ledger?.entries || [];
 const updatedEntries = [...currentEntries];
 updatedEntries[index] = updatedEntry;
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
 const { index, entry } = removeExpenseConfirm;
 if (index < 0) return; // Protección: entry no encontrada en ledger
 try {
 const ledgerRef = doc(db, 'finance', 'manual-ledger');
 const currentEntries = ledger?.entries || [];
 const updatedEntries = currentEntries.filter((_, i) => i !== index);
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
   const { index, entry: oldEntry } = editDepositModal;
   if (index < 0) return;
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
   const updatedEntries = [...currentEntries];
   updatedEntries[index] = updatedEntry;
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
   const { index, entry } = removeDepositConfirm;
   if (index < 0) return;
   try {
     const ledgerRef = doc(db, 'finance', 'manual-ledger');
     const currentEntries = ledger?.entries || [];
     const updatedEntries = currentEntries.filter((_, i) => i !== index);
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

 // Agrupar retiros por banco — usar nombre de la CLABE conocida si existe
 const byBank = {};
 withdrawals.forEach(w => {
 const bank = w.knownBankAccount?.bank || w.bank || 'Desconocido';
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
 const buildCreditId = (bank) => bank.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

 const getLinkedCardLabel = (cardId) => {
   const card = vaultCards[cardId];
   if (!card) return cardId;
   return `${card.bank || ''} ****${card.lastFour || ''}`.trim();
 };

 const getLinkedClabe = (clabeIdx) => {
   if (clabeIdx == null || clabeIdx < 0 || clabeIdx >= clabes.length) return null;
   return clabes[clabeIdx];
 };

 const handleSaveCreditAccount = async (values) => {
   try {
     const id = values.id || buildCreditId(values.bank);
     const vaultCardIds = Array.isArray(values.vaultCardIds)
       ? values.vaultCardIds
       : (values.vaultCardIds || '').split(',').map(s => s.trim()).filter(Boolean);
     const parsedClabeIndex = values.clabeIndex == null || values.clabeIndex === '' || values.clabeIndex === '-1'
       ? -1
       : parseInt(values.clabeIndex, 10);
     const account = {
       id,
       bank: values.bank?.trim() || '',
       creditLimit: parseFloat(values.creditLimit) || 0,
       currentBalance: parseFloat(values.currentBalance) || 0,
       cutoffDay: parseInt(values.cutoffDay, 10) || 1,
       paymentDueDay: parseInt(values.paymentDueDay, 10) || 15,
       annualRate: parseFloat(values.annualRate) || 0,
       minimumPayment: parseFloat(values.minimumPayment) || 0,
       alertDaysBefore: parseInt(values.alertDaysBefore, 10) || 1,
       vaultCardIds,
       clabeIndex: Number.isNaN(parsedClabeIndex) ? -1 : parsedClabeIndex,
       installments: values.installments || (creditModal?.installments) || [],
       monthlyStatements: values.monthlyStatements || (creditModal?.monthlyStatements) || [],
     };
     await saveCreditAccount(account, creditAccounts);
     showCreditToast(`${account.bank} ${creditModal === 'create' ? 'creada' : 'actualizada'}`);
     setCreditModal(null);
   } catch (err) {
     showCreditToast('Error: ' + err.message, 'error');
   }
 };

 const handleDeleteCredit = async () => {
   if (!deleteCreditConfirm) return;
   try {
     await deleteCreditAccount(deleteCreditConfirm.id, creditAccounts);
     showCreditToast(`${deleteCreditConfirm.bank} eliminada`);
     setDeleteCreditConfirm(null);
   } catch (err) {
     showCreditToast('Error: ' + err.message, 'error');
     throw err;
   }
 };

 const handleAddInstallment = async (values) => {
   if (!installmentModal) return;
   try {
     const inst = {
       description: values.description?.trim() || '',
       totalAmount: parseFloat(values.totalAmount) || 0,
       months: parseInt(values.months, 10) || 1,
       monthlyPayment: parseFloat(values.monthlyPayment) || 0,
       startDate: values.startDate || new Date().toISOString().slice(0, 7),
       remainingMonths: parseInt(values.remainingMonths || values.months, 10) || 1,
       withInterest: values.withInterest === 'true' || values.withInterest === true,
       status: 'active',
     };
     if (!inst.monthlyPayment && inst.totalAmount && inst.months) {
       inst.monthlyPayment = Math.round((inst.totalAmount / inst.months) * 100) / 100;
     }
     await addCreditInstallment(installmentModal, inst, creditAccounts);
     showCreditToast(`MSI agregado: ${inst.description}`);
     setInstallmentModal(null);
   } catch (err) {
     showCreditToast('Error: ' + err.message, 'error');
   }
 };

 const handleDeleteInstallment = async () => {
   if (!deleteInstallmentConfirm) return;
   try {
     await removeCreditInstallment(deleteInstallmentConfirm.accountId, deleteInstallmentConfirm.installmentId, creditAccounts);
     showCreditToast('MSI eliminado');
     setDeleteInstallmentConfirm(null);
   } catch (err) {
     showCreditToast('Error: ' + err.message, 'error');
     throw err;
   }
 };

 const handleSaveStatement = async (values) => {
   if (!statementModal) return;
   try {
     const stmt = {
       monthKey: values.monthKey || currentMonthKey,
       balanceAtCutoff: parseFloat(values.balanceAtCutoff) || 0,
       minimumPayment: parseFloat(values.minimumPayment) || 0,
       paymentMade: parseFloat(values.paymentMade) || 0,
       interestCharged: parseFloat(values.interestCharged) || 0,
       paidAt: values.paidAt || '',
       notes: values.notes?.trim() || '',
     };
     await saveCreditStatement(statementModal, stmt, creditAccounts);
     showCreditToast(`Estado de cuenta ${stmt.monthKey} guardado`);
     setStatementModal(null);
   } catch (err) {
     showCreditToast('Error: ' + err.message, 'error');
   }
 };

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
          <button
            className="alert-action-btn edit"
            onClick={() => setCreditModal('create')}
            style={{ fontSize: '12px' }}
          >
            <PlusIcon size={16} /> Agregar cuenta
          </button>
        </div>

        {loadingCredit ? (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>Cargando...</div>
        ) : creditAccounts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
            No hay cuentas de crédito registradas. Haz clic en "Agregar cuenta" para comenzar.
          </div>
        ) : (
          <div className="credit-accounts-grid">
            {creditAccounts.map(acct => {
              const bankMeta = getBankMeta(acct.bank);
              const utilPct = acct.creditLimit > 0 ? Math.min(100, Math.round((acct.currentBalance / acct.creditLimit) * 100)) : 0;
              const utilClass = utilPct <= 30 ? 'low' : utilPct <= 70 ? 'medium' : 'high';
              const available = Math.max(0, (acct.creditLimit || 0) - (acct.currentBalance || 0));
              const isExpanded = expandedCredit === acct.id;
              const expandSection = creditExpandSection[acct.id] || null;
              const installments = acct.installments || [];
              const statements = [...(acct.monthlyStatements || [])].sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
              const totalMSIMonthly = installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);
              const linkedClabe = getLinkedClabe(acct.clabeIndex);

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
                      <button className="clabe-remove-btn" style={{ opacity: 1 }} onClick={() => setCreditModal({ ...acct })} title="Editar">
                        <EditIcon size={16} />
                      </button>
                      <button className="clabe-remove-btn" style={{ opacity: 1 }} onClick={() => setDeleteCreditConfirm(acct)} title="Eliminar">
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </div>

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
                    {(acct.vaultCardIds || []).map(cid => (
                      <span className="credit-link-chip" key={cid}><CreditCardIcon size={12} /> {getLinkedCardLabel(cid)}</span>
                    ))}
                    {linkedClabe && (
                      <span className="credit-link-chip"><BankIcon size={12} /> CLABE: {linkedClabe.clabe?.slice(-6)}</span>
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
                              <button
                                className="clabe-remove-btn"
                                style={{ opacity: 0.7, marginLeft: '4px' }}
                                onClick={() => setDeleteInstallmentConfirm({ accountId: acct.id, installmentId: inst.id, description: inst.description })}
                                title="Eliminar MSI"
                              >
                                <TrashIcon size={14} />
                              </button>
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

                  {/* Action buttons */}
                  <div className="credit-actions-row">
                    <button className="alert-action-btn edit" style={{ fontSize: '11px' }} onClick={() => setInstallmentModal(acct.id)}>
                      <PlusIcon size={14} /> MSI
                    </button>
                    <button className="alert-action-btn edit" style={{ fontSize: '11px' }} onClick={() => setStatementModal(acct.id)}>
                      <PlusIcon size={14} /> Estado de cuenta
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══ DOS COLUMNAS: Historial de Retiros | Gastos ═══ */}
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

          <div className={`finance-withdrawal-body ${withdrawalsCollapsed ? '' : 'expanded'}`}>

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
                const wBankName = w.knownBankAccount?.bank || w.bank;
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
                              const wBankName = w.knownBankAccount?.bank || w.bank;
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

        {/* COLUMNA DERECHA: Gastos */}
        <div className="finance-col">
          <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              <ExpenseIcon size={16} /> Gastos
              <span className="badge badge-danger" style={{ marginLeft: '8px' }}>{expenseEntries.length}</span>
              {expenseEntries.filter(e => e.status === 'pending').length > 0 && (
                <span className="badge badge-warning" style={{ marginLeft: '4px' }}>{expenseEntries.filter(e => e.status === 'pending').length} pendiente{expenseEntries.filter(e => e.status === 'pending').length !== 1 ? 's' : ''}</span>
              )}
            </span>
            <button
              className="alert-action-btn edit"
              onClick={() => setAddExpenseModal(true)}
              style={{ fontSize: '12px' }}
            >
              <PlusIcon size={16} /> Agregar gasto
            </button>
          </div>

          {expenseEntries.length === 0 ? (
            <div className="empty-state" style={{ padding: '20px' }}><p>Sin gastos registrados este mes</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Pendientes primero */}
              {expenseEntries.filter(e => e.status === 'pending').length > 0 && (
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-warning)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 0' }}>
                  <HourglassIcon size={14} /> Cobros pendientes de confirmación
                </div>
              )}
              {expenseEntries.filter(e => e.status === 'pending').map((entry, i) => {
                const globalIdx = allEntries.indexOf(entry);
                const editedAmount = pendingAmounts[globalIdx];
                const displayAmount = editedAmount !== undefined ? editedAmount : (entry.amount || '');
                const finalAmount = editedAmount !== undefined ? parseFloat(editedAmount) : (entry.amount || 0);
                const needsAmount = !entry.amount || entry.amount <= 0;
                // Derive cardLabel from notes if not stored directly (backcompat)
                const cardLabel = entry.cardLabel || (entry.cardId && entry.notes?.[0]?.startsWith('Cobro automático — ')
                  ? entry.notes[0].replace('Cobro automático — ', '') : '');
                return (
                  <div className="ledger-entry" key={`pending-${i}`} style={{ borderLeft: '3px solid var(--accent-warning)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>
                          {entry.description}
                          <span className="badge badge-warning" style={{ marginLeft: '8px', fontSize: '10px' }}>Pendiente</span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {entry.effectiveAt && <span><CalendarIcon size={16} /> {entry.effectiveAt}</span>}
                          {entry.subscription && <span> | {entry.subscription}</span>}
                          {entry.isRecurring && <span> | <RefreshIcon size={12} /> Cobro recurrente</span>}
                          {cardLabel && <span> | <CreditCardIcon size={12} /> {cardLabel}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>$</span>
                            <input
                              type="number"
                              value={displayAmount}
                              onChange={e => setPendingAmounts(prev => ({ ...prev, [globalIdx]: e.target.value }))}
                              placeholder={needsAmount ? 'Ingresa monto' : '0.00'}
                              style={{
                                width: '100%', maxWidth: needsAmount ? '120px' : '90px', minWidth: '70px',
                                fontWeight: 700, fontSize: '16px',
                                color: needsAmount ? 'var(--accent-warning)' : 'var(--text-primary)',
                                background: 'var(--bg-input)', border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-sm)', padding: '4px 8px',
                                textAlign: 'right',
                              }}
                            />
                          </div>
                          {needsAmount && <div style={{ fontSize: '10px', color: 'var(--accent-warning)', marginTop: '2px' }}>Monto requerido</div>}
                        </div>
                        <button
                          className="alert-action-btn edit"
                          disabled={confirmingExpenseIdx === globalIdx || (finalAmount <= 0 && !editedAmount)}
                          onClick={async () => {
                            const amountToConfirm = parseFloat(displayAmount);
                            if (!amountToConfirm || amountToConfirm <= 0) {
                              showExpenseToast('Ingresa un monto válido antes de confirmar', 'error');
                              return;
                            }
                            if (confirmingExpenseIdx !== null) return;
                            setConfirmingExpenseIdx(globalIdx);
                            try {
                              await confirmRecurringExpense(globalIdx, allEntries, amountToConfirm !== entry.amount ? amountToConfirm : null);
                              showExpenseToast(`Cobro "${entry.description}" confirmado — ${formatMXN(amountToConfirm)}`);
                              setPendingAmounts(prev => { const next = {...prev}; delete next[globalIdx]; return next; });
                            } catch (err) {
                              showExpenseToast('Error: ' + err.message, 'error');
                            } finally {
                              setConfirmingExpenseIdx(null);
                            }
                          }}
                          title="Confirmar que el cobro se realizó"
                          style={{ fontSize: '11px', whiteSpace: 'nowrap' }}
                        >
                          {confirmingExpenseIdx === globalIdx
                            ? <><span className="spinner" /> Confirmando...</>
                            : <><CheckCircleIcon size={16} /> Confirmar</>
                          }
                        </button>
                        <button
                          className="clabe-remove-btn"
                          onClick={() => setRemoveExpenseConfirm({ index: globalIdx, entry })}
                          title="Eliminar cobro"
                        >
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* Confirmados */}
              {expenseEntries.filter(e => e.status !== 'pending').length > 0 && expenseEntries.filter(e => e.status === 'pending').length > 0 && (
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 0' }}>
                  <CheckCircleIcon size={14} /> Gastos confirmados
                </div>
              )}
              {expenseEntries.filter(e => e.status !== 'pending').map((entry, i) => {
                const typeLabels = { expense: <><ExpenseIcon size={16} /> Gasto</>, investment: <><ExpenseIcon size={16} /> Gasto (inversión)</>, income_adjustment: <><MoneyIcon size={16} /> Ajuste +</>, expense_refund: <><RefreshIcon size={16} /> Devolución</> };
                const typeBadge = { expense: 'badge-danger', investment: 'badge-danger', income_adjustment: 'badge-success', expense_refund: 'badge-info' };
                const globalIdx = allEntries.indexOf(entry);
                // Derive cardLabel from notes if not stored directly (backcompat)
                const cardLabel = entry.cardLabel || (entry.cardId && entry.notes?.[0]?.startsWith('Cobro automático — ')
                  ? entry.notes[0].replace('Cobro automático — ', '') : '');
                return (
                  <div className="ledger-entry" key={`confirmed-${i}`}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{entry.description}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {entry.effectiveAt && <span><CalendarIcon size={16} /> {entry.effectiveAt}</span>}
                          {entry.subscription && <span> | {entry.subscription}</span>}
                          {entry.isRecurring && <span> | <RefreshIcon size={12} /> Recurrente</span>}
                          {cardLabel && <span> | <CreditCardIcon size={12} /> {cardLabel}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ textAlign: 'right' }}>
                          <span className={`badge ${typeBadge[entry.type] || 'badge-danger'}`}>{typeLabels[entry.type] || <><ExpenseIcon size={16} /> Gasto</>}</span>
                          <div style={{ fontWeight: 700, fontSize: '17px', marginTop: '4px' }}>{formatMXN(entry.amount)}</div>
                        </div>
                        <button
                          className="clabe-remove-btn"
                          onClick={() => setEditExpenseModal({ index: globalIdx, entry })}
                          title="Editar gasto"
                          style={{ marginLeft: '2px', fontSize: '11px' }}
                        >
                          <EditIcon size={16} />
                        </button>
                        <button
                          className="clabe-remove-btn"
                          onClick={() => setRemoveExpenseConfirm({ index: globalIdx, entry })}
                          title="Eliminar gasto"
                        >
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ─── Depósitos / Ingresos ─── */}
        <div className="finance-col">
          <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>
              <DepositIcon size={16} /> Ingresos
              <span className="badge badge-success" style={{ marginLeft: '8px' }}>{depositEntries.length}</span>
            </span>
            <button
              className="alert-action-btn edit"
              onClick={() => setAddDepositModal(true)}
              style={{ fontSize: '12px' }}
            >
              <PlusIcon size={16} /> Agregar ingreso
            </button>
          </div>

          {depositEntries.length === 0 ? (
            <div className="empty-state" style={{ padding: '20px' }}><p>Sin ingresos registrados este mes</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {depositEntries.map((entry, i) => {
                const globalIdx = allEntries.indexOf(entry);
                return (
                  <div className="ledger-entry" key={`deposit-${i}`} style={{ borderLeft: '3px solid #10b981' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{entry.description}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {entry.effectiveAt && <span><CalendarIcon size={16} /> {entry.effectiveAt}</span>}
                          {entry.bankAccount && <span> | <BankIcon size={12} /> {entry.bankAccount}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ textAlign: 'right' }}>
                          <span className="badge badge-success"><DepositIcon size={16} /> Ingreso</span>
                          <div style={{ fontWeight: 700, fontSize: '17px', marginTop: '4px', color: '#10b981' }}>+{formatMXN(entry.amount)}</div>
                        </div>
                        <button
                          className="clabe-remove-btn"
                          onClick={() => setEditDepositModal({ index: globalIdx, entry })}
                          title="Editar ingreso"
                          style={{ marginLeft: '2px', fontSize: '11px' }}
                        >
                          <EditIcon size={16} />
                        </button>
                        <button
                          className="clabe-remove-btn"
                          onClick={() => setRemoveDepositConfirm({ index: globalIdx, entry })}
                          title="Eliminar ingreso"
                        >
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ═══ CUENTAS BANCARIAS (unificado: CLABEs + Retiros) ═══ */}
      <div className="finance-section" style={{ marginTop: '24px' }}>
        <div className="finance-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span><BankIcon size={16} /> Cuentas Bancarias</span>
          <button
            className="alert-action-btn edit"
            onClick={() => setAddClabeModal(true)}
            style={{ fontSize: '12px' }}
          >
            <PlusIcon size={16} /> Agregar cuenta
          </button>
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
                      const clabeGlobalIdx = clabeEntry ? clabes.indexOf(clabeEntry) : -1;
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
                            {clabeEntry && (
                              <button
                                className="clabe-remove-btn"
                                onClick={() => setRemoveClabeConfirm({ index: clabeGlobalIdx, bank: bankName })}
                                title="Eliminar CLABE"
                              >
                                <TrashIcon size={16} />
                              </button>
                            )}
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
                      const globalIdx = clabes.indexOf(c);
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
                            <button
                              className="clabe-remove-btn"
                              onClick={() => setRemoveClabeConfirm({ index: globalIdx, bank: c.bank })}
                              title="Eliminar CLABE"
                            >
                              <TrashIcon size={16} />
                            </button>
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
                const bank = w.knownBankAccount?.bank || w.bank || 'Desconocido';
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
                              const globalIdx = allEntries.indexOf(e);
                              const canEdit = globalIdx >= 0 && e.effectiveAt >= minDate && e.effectiveAt <= maxDate;
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
                                        onClick={() => e.type === 'deposit' ? setEditDepositModal({ index: globalIdx, entry: e }) : setEditExpenseModal({ index: globalIdx, entry: e })}
                                        title={e.type === 'deposit' ? 'Editar ingreso' : 'Editar gasto'}
                                      >
                                        <EditIcon size={16} />
                                      </button>
                                      <button
                                        className="clabe-remove-btn"
                                        onClick={() => e.type === 'deposit' ? setRemoveDepositConfirm({ index: globalIdx, entry: e }) : setRemoveExpenseConfirm({ index: globalIdx, entry: e })}
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
                              const wBankName = w.knownBankAccount?.bank || w.bank;
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


      {/* Modal: Agregar CLABE */}
      <EditModal
        open={addClabeModal}
        onClose={() => setAddClabeModal(false)}
        onSave={handleAddClabe}
        title="Agregar cuenta CLABE"
        icon={<BankIcon size={16} />}
        fields={[
          { key: 'bank', label: 'Nombre del banco', required: true, placeholder: 'Ej: BBVA, Klar, Nu...' },
          { key: 'clabe', label: 'CLABE interbancaria (18 dígitos)', required: true, placeholder: '000000000000000000' },
          { key: 'type', label: 'Tipo de cuenta', type: 'select', options: [
            { value: 'debito', label: 'Débito' },
            { value: 'credito', label: 'Crédito (solo para pagar)' },
          ]},
          { key: 'note', label: 'Nota (opcional)', placeholder: 'Ej: solo para pagar' },
        ]}
        initialValues={{ bank: '', clabe: '', type: 'debito', note: '' }}
        saveLabel="Agregar CLABE"
        confirmMessage="Se agregará esta cuenta CLABE a la lista."
      />

      {/* Diálogo: Confirmar eliminación de CLABE */}
      <ConfirmDialog
        open={!!removeClabeConfirm}
        onClose={() => setRemoveClabeConfirm(null)}
        onConfirm={handleRemoveClabeConfirm}
        title="Eliminar CLABE"
        message={removeClabeConfirm ? `¿Estás seguro de eliminar la CLABE de "${removeClabeConfirm.bank}"? Esta acción es irreversible.` : ''}
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Toast CLABEs */}
      <Toast {...clabeToast} onClose={() => setClabeToast(prev => ({ ...prev, visible: false }))} />

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

      {/* ═══ MODALES DE CUENTAS DE CRÉDITO ═══ */}

      {/* Modal: Crear/editar cuenta de crédito */}
      <EditModal
        open={!!creditModal}
        onClose={() => setCreditModal(null)}
        onSave={handleSaveCreditAccount}
        title={creditModal === 'create' ? 'Nueva cuenta de crédito' : `Editar — ${creditModal?.bank || ''}`}
        icon={<CreditCardIcon size={16} />}
        initialValues={creditModal && creditModal !== 'create' ? {
          id: creditModal.id,
          bank: creditModal.bank,
          creditLimit: creditModal.creditLimit || '',
          currentBalance: creditModal.currentBalance || '',
          cutoffDay: creditModal.cutoffDay || '',
          paymentDueDay: creditModal.paymentDueDay || '',
          annualRate: creditModal.annualRate || '',
          minimumPayment: creditModal.minimumPayment || '',
          alertDaysBefore: creditModal.alertDaysBefore || 1,
          vaultCardIds: (creditModal.vaultCardIds || []).join(','),
          clabeIndex: creditModal.clabeIndex != null ? String(creditModal.clabeIndex) : '-1',
          installments: creditModal.installments,
          monthlyStatements: creditModal.monthlyStatements,
        } : {}}
        fields={[
          { key: 'bank', label: 'Banco', type: 'select', options: Object.keys(BANKS).filter(b => b.toLowerCase().includes('crédito') || b.toLowerCase().includes('credito')).map(b => ({ value: b, label: b })), required: true, placeholder: 'Seleccionar banco' },
          { key: 'creditLimit', label: 'Línea de crédito ($)', type: 'number', placeholder: '15000', required: true },
          { key: 'currentBalance', label: 'Saldo utilizado actual ($)', type: 'number', placeholder: '3200' },
          { key: 'cutoffDay', label: 'Día de corte (1-31)', type: 'number', placeholder: '15', required: true },
          { key: 'paymentDueDay', label: 'Día límite de pago (1-31)', type: 'number', placeholder: '5', required: true },
          { key: 'annualRate', label: 'Tasa de interés anual (%)', type: 'number', placeholder: '0' },
          { key: 'minimumPayment', label: 'Pago mínimo del mes ($)', type: 'number', placeholder: '0' },
          { key: 'alertDaysBefore', label: 'Alertar X días antes', type: 'number', placeholder: '1' },
          { key: 'vaultCardIds', label: 'Tarjetas vinculadas (IDs separados por coma)', type: 'text', placeholder: vaultCardOptions.map(o => o.label).join(', ') || 'ID de tarjeta en Bóveda' },
          { key: 'clabeIndex', label: 'CLABE de crédito vinculada', type: 'select', options: [{ value: '-1', label: 'Ninguna' }, ...creditClabeOptions.map(o => ({ value: String(o.value), label: o.label }))], placeholder: 'Seleccionar CLABE' },
        ]}
      />

      {/* Modal: Agregar MSI */}
      <EditModal
        open={!!installmentModal}
        onClose={() => setInstallmentModal(null)}
        onSave={handleAddInstallment}
        title="Agregar compra a meses"
        icon={<ReceiptIcon size={16} />}
        fields={[
          { key: 'description', label: 'Descripción', type: 'text', placeholder: 'Ej: Laptop Dell', required: true },
          { key: 'totalAmount', label: 'Monto total ($)', type: 'number', placeholder: '12000', required: true },
          { key: 'months', label: 'Plazo (meses)', type: 'number', placeholder: '12', required: true },
          { key: 'monthlyPayment', label: 'Pago mensual ($) — se calcula si se deja vacío', type: 'number', placeholder: 'Automático' },
          { key: 'remainingMonths', label: 'Meses restantes', type: 'number', placeholder: 'Igual al plazo si es nuevo' },
          { key: 'startDate', label: 'Mes de inicio (YYYY-MM)', type: 'text', placeholder: currentMonthKey },
          { key: 'withInterest', label: '¿Con intereses?', type: 'select', options: [{ value: 'false', label: 'Sin intereses (MSI)' }, { value: 'true', label: 'Con intereses' }] },
        ]}
      />

      {/* Modal: Registrar estado de cuenta */}
      <EditModal
        open={!!statementModal}
        onClose={() => setStatementModal(null)}
        onSave={handleSaveStatement}
        title="Registrar estado de cuenta"
        icon={<CalendarIcon size={16} />}
        fields={[
          { key: 'monthKey', label: 'Mes (YYYY-MM)', type: 'text', placeholder: currentMonthKey, required: true },
          { key: 'balanceAtCutoff', label: 'Saldo al corte ($)', type: 'number', placeholder: '3200', required: true },
          { key: 'minimumPayment', label: 'Pago mínimo ($)', type: 'number', placeholder: '500' },
          { key: 'paymentMade', label: 'Pago realizado ($)', type: 'number', placeholder: '3200' },
          { key: 'interestCharged', label: 'Intereses cobrados ($)', type: 'number', placeholder: '0' },
          { key: 'paidAt', label: 'Fecha de pago (YYYY-MM-DD)', type: 'text', placeholder: new Date().toISOString().slice(0, 10) },
          { key: 'notes', label: 'Notas', type: 'text', placeholder: 'Observaciones opcionales' },
        ]}
      />

      {/* Confirmar eliminación de cuenta de crédito */}
      <ConfirmDialog
        open={!!deleteCreditConfirm}
        onClose={() => setDeleteCreditConfirm(null)}
        onConfirm={handleDeleteCredit}
        title="Eliminar cuenta de crédito"
        message={deleteCreditConfirm ? `¿Eliminar la cuenta de ${deleteCreditConfirm.bank}? Se perderán todos los MSI y estados de cuenta registrados.` : ''}
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Confirmar eliminación de MSI */}
      <ConfirmDialog
        open={!!deleteInstallmentConfirm}
        onClose={() => setDeleteInstallmentConfirm(null)}
        onConfirm={handleDeleteInstallment}
        title="Eliminar compra a meses"
        message={deleteInstallmentConfirm ? `¿Eliminar "${deleteInstallmentConfirm.description}"?` : ''}
        confirmLabel={<><TrashIcon size={16} /> Sí, eliminar</>}
        danger
        icon={<WarningIcon size={16} />}
      />

      {/* Toast crédito */}
      <Toast {...creditToast} onClose={() => setCreditToast(prev => ({ ...prev, visible: false }))} />
 </>
 );
}
