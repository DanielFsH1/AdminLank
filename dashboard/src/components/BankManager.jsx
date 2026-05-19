import { useState, useEffect, useMemo, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { BANKS, formatMXN } from '../config/services';
import {
  createBank, updateBank, deleteBank,
  updateDebitAccount,
  createCreditAccount, updateCreditAccount, deleteCreditAccount,
  addCreditInstallment, removeCreditInstallment, saveCreditStatement,
  unlinkCardFromBank,
  getLogoGallery, uploadBankLogo, deleteBankLogo,
} from '../hooks/bankActions';
import { createVaultCard } from '../hooks/firestoreActions';
import { encrypt } from '../utils/crypto';
import { normalizeCardExpiryInput } from '../utils/cardExpiry';
import { ConfirmDialog, Toast } from './EditModal';
import {
  BankIcon, PlusIcon, EditIcon, TrashIcon, CloseIcon, SaveIcon,
  CreditCardIcon, CalendarIcon, ReceiptIcon, NotesIcon,
  CheckCircleIcon, WarningIcon, ImageIcon, UploadIcon,
} from './Icons';
import SearchBar from './SearchBar';

const MONTH_NAMES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

export default function BankManager({ vaultCards = {} }) {
  const [banks, setBanks] = useState({});
  const [expandedBanks, setExpandedBanks] = useState(new Set());
  const [creditExpandSection, setCreditExpandSection] = useState({});
  const [searchQuery, setSearchQuery] = useState('');

  // ─── Modals ───
  const [bankModal, setBankModal] = useState(null);
  const [bankValues, setBankValues] = useState({ name: '', color: '#64748b', logoUrl: '', clabe: '', note: '' });
  const [debitModal, setDebitModal] = useState(null);
  const [debitValues, setDebitValues] = useState({ clabe: '', note: '' });
  const [creditModal, setCreditModal] = useState(null);
  const [creditValues, setCreditValues] = useState({});
  const [msiModal, setMsiModal] = useState(null);
  const [msiValues, setMsiValues] = useState({ description: '', totalAmount: '', months: '', monthlyPayment: '', remainingMonths: '', startDate: '', withInterest: false });
  const [statementModal, setStatementModal] = useState(null);
  const [statementValues, setStatementValues] = useState({ monthKey: '', balanceAtCutoff: '', paymentMade: '', interestCharged: '' });
  const [logoModal, setLogoModal] = useState(null);
  const [logoGallery, setLogoGallery] = useState([]);
  const [logoUploading, setLogoUploading] = useState(false);

  const [cardCreateModal, setCardCreateModal] = useState(null);
  const [cardCreateValues, setCardCreateValues] = useState({ number: '', cvv: '', expiry: '', holder: '', notes: '' });

  const [confirmDialog, setConfirmDialog] = useState(null);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });
  const [saving, setSaving] = useState(false);
  const mouseDownOnOverlayRef = useRef(false);
  const fileInputRef = useRef(null);

  const showToast = (message, type = 'success') => setToast({ visible: true, message, type });

  // ─── Load banks from Firestore ───
  useEffect(() => {
    getDocs(collection(db, 'banks')).then(snap => {
      const data = {};
      snap.docs.forEach(d => { data[d.id] = { id: d.id, ...d.data() }; });
      setBanks(data);
    }).catch(() => {});
  }, []);

  // ─── Derived data ───
  const cardsByBank = useMemo(() => {
    const map = {};
    Object.values(vaultCards).forEach(card => {
      if (card.bankId) {
        if (!map[card.bankId]) map[card.bankId] = [];
        map[card.bankId].push(card);
      }
    });
    return map;
  }, [vaultCards]);

  const sortedBanks = useMemo(() => {
    return Object.values(banks)
      .filter(b => {
        if (!searchQuery || searchQuery.length < 2) return true;
        const q = searchQuery.toLowerCase();
        return b.name?.toLowerCase().includes(q) ||
          b.debitAccount?.clabe?.includes(q);
      })
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }, [banks, searchQuery]);

  // ─── Toggle helpers ───
  const toggleBank = (bankId) => {
    setExpandedBanks(prev => {
      const next = new Set(prev);
      next.has(bankId) ? next.delete(bankId) : next.add(bankId);
      return next;
    });
  };

  const toggleCreditSection = (bankId, section) => {
    setCreditExpandSection(prev => ({
      ...prev,
      [bankId]: prev[bankId] === section ? null : section,
    }));
  };

  // ─── Bank CRUD ───
  const openCreateBank = () => {
    setBankValues({ name: '', color: '#64748b', logoUrl: '', clabe: '', note: '' });
    setBankModal('create');
  };

  const openEditBank = (bank) => {
    setBankValues({ name: bank.name, color: bank.color || '#64748b', logoUrl: bank.logoUrl || '' });
    setBankModal(bank);
  };

  const handleSaveBank = async () => {
    if (!bankValues.name?.trim()) return;
    setSaving(true);
    try {
      if (bankModal === 'create') {
        await createBank(bankValues);
        showToast(`Banco "${bankValues.name}" creado`);
      } else {
        await updateBank(bankModal.id, { name: bankValues.name.trim(), color: bankValues.color, logoUrl: bankValues.logoUrl });
        showToast(`Banco "${bankValues.name}" actualizado`);
      }
      setBankModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  const handleDeleteBank = (bank) => {
    const linkedCards = cardsByBank[bank.id] || [];
    const hasActive = linkedCards.some(c => (c.recurringCharges || []).some(rc => rc.active));
    setConfirmDialog({
      title: `Eliminar ${bank.name}`,
      message: hasActive
        ? 'Este banco tiene tarjetas con cobros recurrentes activos. Se desactivarán todas las vinculaciones.'
        : `Se eliminará "${bank.name}" y se desvincularán ${linkedCards.length} tarjeta(s). Esta acción no se puede deshacer.`,
      danger: true,
      confirmLabel: 'Eliminar banco',
      onConfirm: async () => {
        await deleteBank(bank.id);
        showToast(`Banco "${bank.name}" eliminado`);
      },
    });
  };

  // ─── Debit account ───
  const openDebitEdit = (bank) => {
    setDebitValues({ clabe: bank.debitAccount?.clabe || '', note: bank.debitAccount?.note || '' });
    setDebitModal(bank.id);
  };

  const handleSaveDebit = async () => {
    setSaving(true);
    try {
      await updateDebitAccount(debitModal, debitValues);
      showToast('CLABE actualizada');
      setDebitModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  // ─── Credit account ───
  const openCreateCredit = (bankId) => {
    setCreditValues({ creditLimit: '', currentBalance: '0', cutoffDay: '', daysAfterCutoff: '20', alertDaysBefore: '1', paymentClabe: '', paymentClabeNote: '' });
    setCreditModal({ bankId, mode: 'create' });
  };

  const openEditCredit = (bank) => {
    const c = bank.creditAccount;
    setCreditValues({
      creditLimit: c.creditLimit || '', currentBalance: c.currentBalance || '0',
      cutoffDay: c.cutoffDay || '', daysAfterCutoff: c.daysAfterCutoff || (c.paymentDueDay && c.cutoffDay ? Math.min(30, Math.max(10, c.paymentDueDay - c.cutoffDay + (c.paymentDueDay <= c.cutoffDay ? 30 : 0))) : '20'), alertDaysBefore: c.alertDaysBefore || '1',
      paymentClabe: c.paymentClabe || '', paymentClabeNote: c.paymentClabeNote || '',
    });
    setCreditModal({ bankId: bank.id, mode: 'edit' });
  };

  const handleSaveCredit = async () => {
    setSaving(true);
    try {
      if (creditModal.mode === 'create') {
        await createCreditAccount(creditModal.bankId, creditValues);
        showToast('Cuenta de crédito creada');
      } else {
        await updateCreditAccount(creditModal.bankId, creditValues);
        showToast('Cuenta de crédito actualizada');
      }
      setCreditModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  const handleDeleteCredit = (bank) => {
    setConfirmDialog({
      title: 'Eliminar cuenta de crédito',
      message: `Se eliminará la cuenta de crédito de ${bank.name}. Las tarjetas de crédito vinculadas se desvincularán.`,
      danger: true,
      confirmLabel: 'Eliminar',
      onConfirm: async () => {
        await deleteCreditAccount(bank.id);
        showToast('Cuenta de crédito eliminada');
      },
    });
  };

  // ─── MSI / Statements ───
  const openMsiModal = (bankId) => {
    setMsiValues({ description: '', totalAmount: '', months: '', monthlyPayment: '', remainingMonths: '', startDate: '', withInterest: false });
    setMsiModal(bankId);
  };

  const handleSaveMsi = async () => {
    setSaving(true);
    try {
      const inst = {
        ...msiValues,
        totalAmount: parseFloat(msiValues.totalAmount) || 0,
        months: parseInt(msiValues.months, 10) || 0,
        monthlyPayment: parseFloat(msiValues.monthlyPayment) || 0,
        remainingMonths: parseInt(msiValues.remainingMonths, 10) || parseInt(msiValues.months, 10) || 0,
      };
      await addCreditInstallment(msiModal, inst);
      showToast('MSI agregado');
      setMsiModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  const handleRemoveMsi = (bankId, instId, desc) => {
    setConfirmDialog({
      title: 'Eliminar MSI',
      message: `¿Eliminar "${desc}"?`,
      danger: true,
      confirmLabel: 'Eliminar',
      onConfirm: async () => {
        await removeCreditInstallment(bankId, instId);
        showToast('MSI eliminado');
      },
    });
  };

  const openStatementModal = (bankId) => {
    const now = new Date();
    setStatementValues({ monthKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, balanceAtCutoff: '', paymentMade: '', interestCharged: '' });
    setStatementModal(bankId);
  };

  const handleSaveStatement = async () => {
    setSaving(true);
    try {
      const stmt = {
        monthKey: statementValues.monthKey,
        balanceAtCutoff: parseFloat(statementValues.balanceAtCutoff) || 0,
        paymentMade: parseFloat(statementValues.paymentMade) || 0,
        interestCharged: parseFloat(statementValues.interestCharged) || 0,
      };
      await saveCreditStatement(statementModal, stmt);
      showToast('Estado de cuenta guardado');
      setStatementModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  // ─── Card linking ───
  const handleUnlinkCard = (cardId, label) => {
    setConfirmDialog({
      title: 'Desvincular tarjeta',
      message: `¿Desvincular "${label}" de este banco?`,
      confirmLabel: 'Desvincular',
      onConfirm: async () => {
        await unlinkCardFromBank(cardId);
        showToast('Tarjeta desvinculada');
      },
    });
  };

  // ─── Logo gallery ───
  const openLogoGallery = async (bankId) => {
    setLogoModal(bankId);
    try {
      const logos = await getLogoGallery();
      setLogoGallery(logos);
    } catch (_err) {
      showToast('Error cargando galería de logos', 'error');
    }
  };

  const handleSelectLogo = async (url) => {
    try {
      await updateBank(logoModal, { logoUrl: url });
      showToast('Logo actualizado');
      setLogoModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleUploadLogo = async (file) => {
    if (!file || file.size > 2 * 1024 * 1024) {
      showToast('El archivo debe ser menor a 2MB', 'error');
      return;
    }
    setLogoUploading(true);
    try {
      const logo = await uploadBankLogo(file, file.name.replace(/\.[^.]+$/, ''));
      setLogoGallery(prev => [...prev, { ...logo, isDefault: false }]);
      showToast('Logo subido');
    } catch (err) {
      showToast(err.message, 'error');
    }
    setLogoUploading(false);
  };

  const handleDeleteLogo = async (logoId) => {
    try {
      await deleteBankLogo(logoId);
      setLogoGallery(prev => prev.filter(l => l.id !== logoId));
      showToast('Logo eliminado');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ─── Card creation helpers ───
  const cleanCardNumber = (input) => input.replace(/\D/g, '').slice(0, 16);
  const getLast4 = (number) => {
    const digits = (number || '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : digits || '????';
  };
  const getCardIdFromLabel = (label) => label.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  const formatCardInput = (raw) => {
    const digits = (raw || '').replace(/\D/g, '').slice(0, 16);
    return digits.match(/.{1,4}/g)?.join(' ') || digits;
  };

  const openCardCreate = (bankId, accountType) => {
    setCardCreateValues({ number: '', cvv: '', expiry: '', holder: '', notes: '' });
    setCardCreateModal({ bankId, accountType });
  };

  const handleCardCreate = async () => {
    const modal = cardCreateModal;
    if (!modal) return;
    const bankName = banks[modal.bankId]?.name || 'Tarjeta';
    const cleanNum = cleanCardNumber(cardCreateValues.number || '');
    const derivedLast4 = getLast4(cleanNum);
    const label = `${bankName} ****${derivedLast4}`;
    const id = getCardIdFromLabel(label);
    const normalizedExpiry = normalizeCardExpiryInput(cardCreateValues.expiry);
    setSaving(true);
    try {
      const data = {
        bank: bankName,
        lastFour: derivedLast4,
        number: cleanNum ? encrypt(cleanNum) : '',
        cvv: cardCreateValues.cvv ? encrypt(cardCreateValues.cvv) : '',
        expiry: normalizedExpiry,
        holder: cardCreateValues.holder,
        notes: cardCreateValues.notes,
        bankId: modal.bankId,
        accountType: modal.accountType,
      };
      await createVaultCard(id, data);
      showToast(`Tarjeta "${bankName} ****${derivedLast4}" creada y vinculada`);
      setCardCreateModal(null);
    } catch (err) {
      showToast(err.message, 'error');
    }
    setSaving(false);
  };

  // ─── Modal overlay handler ───
  const overlayProps = (onClose) => ({
    onMouseDown: e => { mouseDownOnOverlayRef.current = e.target === e.currentTarget; },
    onClick: e => {
      if (mouseDownOnOverlayRef.current && e.target === e.currentTarget) onClose();
      mouseDownOnOverlayRef.current = false;
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  return (
    <div className="bank-manager">
      <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Buscar banco por nombre o CLABE..." />

      {/* Bank list */}
      <div className="credit-accounts-grid" style={{ marginTop: '12px' }}>
        {sortedBanks.map(bank => {
          const isExpanded = expandedBanks.has(bank.id);
          const linkedCards = cardsByBank[bank.id] || [];
          const debitCards = linkedCards.filter(c => c.accountType !== 'credit');
          const creditCards = linkedCards.filter(c => c.accountType === 'credit');
          const credit = bank.creditAccount;
          const expandSection = creditExpandSection[bank.id] || null;

          return (
            <div className="credit-account-card" key={bank.id} style={{ '--bank-color': bank.color || '#64748b' }} onClick={() => toggleBank(bank.id)}>
              {/* Header */}
              <div className="credit-account-header">
                <div className="credit-account-bank">
                  {bank.logoUrl
                    ? <img src={bank.logoUrl} alt="" className="bank-logo-xl" onError={e => { e.target.style.display = 'none'; }} />
                    : <div className="bank-logo-xl" style={{ background: bank.color || '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '18px' }}>{(bank.name || '?')[0]}</div>
                  }
                  <div>
                    <div className="credit-account-name">{bank.name}</div>
                    <div className="credit-account-sub">
                      {linkedCards.length} tarjeta{linkedCards.length !== 1 ? 's' : ''}
                      {bank.debitAccount?.clabe && ` · CLABE: ...${bank.debitAccount.clabe.slice(-4)}`}
                      {credit && ` · Crédito: ${formatMXN(credit.creditLimit)}`}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button className="clabe-remove-btn" style={{ opacity: 1 }} onClick={e => { e.stopPropagation(); openEditBank(bank); }} title="Editar banco">
                    <EditIcon size={16} />
                  </button>
                  <button className="clabe-remove-btn" style={{ opacity: 1 }} onClick={e => { e.stopPropagation(); openLogoGallery(bank.id); }} title="Cambiar logo">
                    <ImageIcon size={16} />
                  </button>
                  <span className="vault-chevron">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </div>

              {isExpanded && (
                <div onClick={e => e.stopPropagation()} style={{ cursor: 'default' }}>
                  {/* ── Cuenta Débito ── */}
                  <div className="vault-linked-section" style={{ marginTop: '8px' }}>
                    <div className="vault-linked-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span><BankIcon size={14} /> Cuenta Débito</span>
                      <button className="vault-action-btn edit" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => openDebitEdit(bank)}>
                        <EditIcon size={12} /> Editar CLABE
                      </button>
                    </div>
                    <div style={{ padding: '8px 12px', fontSize: '13px' }}>
                      {bank.debitAccount?.clabe ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div><span style={{ color: 'var(--text-muted)' }}>CLABE:</span> <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{bank.debitAccount.clabe}</span></div>
                          {bank.debitAccount.note && <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{bank.debitAccount.note}</div>}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Sin CLABE registrada</div>
                      )}
                      {debitCards.length > 0 && (
                        <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {debitCards.map(c => (
                            <span className="credit-link-chip" key={c.id}>
                              <CreditCardIcon size={12} /> {c.bank} ****{c.lastFour}
                              <button
                                type="button"
                                className="vault-chip-remove-btn"
                                onClick={() => handleUnlinkCard(c.id, `${c.bank} ****${c.lastFour}`)}
                                title="Quitar tarjeta vinculada"
                              >
                                <CloseIcon size={10} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <button className="vault-action-btn edit" style={{ marginTop: '6px', padding: '3px 8px', fontSize: '11px' }} onClick={() => openCardCreate(bank.id, 'debit')}>
                        <CreditCardIcon size={12} /> Nueva tarjeta débito
                      </button>
                    </div>
                  </div>

                  {/* ── Cuenta Crédito ── */}
                  {credit ? (
                    <div className="vault-linked-section" style={{ marginTop: '12px' }}>
                      <div className="vault-linked-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span><CreditCardIcon size={14} /> Cuenta de Crédito</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button className="vault-action-btn edit" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => openEditCredit(bank)}>
                            <EditIcon size={12} /> Editar
                          </button>
                          <button className="vault-action-btn delete" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => handleDeleteCredit(bank)}>
                            <TrashIcon size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Utilization bar */}
                      {renderCreditDetails(bank, credit, expandSection, creditCards)}
                    </div>
                  ) : (
                    <div style={{ marginTop: '12px', textAlign: 'center', padding: '16px', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Sin cuenta de crédito</div>
                      <button className="vault-action-btn edit" style={{ padding: '4px 12px', fontSize: '12px' }} onClick={() => openCreateCredit(bank.id)}>
                        <PlusIcon size={14} /> Agregar cuenta de crédito
                      </button>
                    </div>
                  )}

                  {/* ── Bank actions ── */}
                  <div className="credit-actions-row" style={{ marginTop: '12px', justifyContent: 'flex-end' }}>
                    <button className="alert-action-btn edit" style={{ fontSize: '11px', color: '#ef4444', borderColor: '#ef4444' }} onClick={() => handleDeleteBank(bank)}>
                      <TrashIcon size={14} /> Eliminar banco
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create bank button */}
      <div className="vault-create-card" onClick={openCreateBank} style={{ marginTop: '12px' }}>
        <PlusIcon size={16} /> Nuevo banco
      </div>

      {/* ═══ MODALS ═══ */}

      {/* Create/Edit Bank Modal */}
      {bankModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setBankModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '480px' }}>
            <div className="vault-modal-header">
              <h3><BankIcon size={16} /> {bankModal === 'create' ? 'Nuevo banco' : `Editar ${bankModal.name}`}</h3>
              <button className="vault-modal-close" onClick={() => setBankModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>Nombre del banco *</label>
                <input type="text" value={bankValues.name} onChange={e => setBankValues(p => ({ ...p, name: e.target.value }))} placeholder="Ej: BBVA, Nu, Klar..." autoComplete="off" />
              </div>
              <div className="vault-form-group">
                <label>Color identificador</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input type="color" value={bankValues.color} onChange={e => setBankValues(p => ({ ...p, color: e.target.value }))} style={{ width: '40px', height: '32px', padding: '2px', cursor: 'pointer' }} />
                  <input type="text" value={bankValues.color} onChange={e => setBankValues(p => ({ ...p, color: e.target.value }))} style={{ flex: 1 }} placeholder="#64748b" />
                </div>
              </div>
              <div className="vault-form-group">
                <label>URL del logo</label>
                <input type="text" value={bankValues.logoUrl} onChange={e => setBankValues(p => ({ ...p, logoUrl: e.target.value }))} placeholder="https://... o /assets/..." />
                {bankValues.logoUrl && <img src={bankValues.logoUrl} alt="" style={{ width: '40px', height: '40px', borderRadius: '6px', objectFit: 'cover', marginTop: '4px' }} onError={e => { e.target.style.display = 'none'; }} />}
              </div>
              {bankModal === 'create' && (
                <>
                  <div className="vault-form-group">
                    <label>CLABE interbancaria (débito)</label>
                    <input type="text" value={bankValues.clabe} onChange={e => setBankValues(p => ({ ...p, clabe: e.target.value.replace(/\D/g, '').slice(0, 18) }))} placeholder="18 dígitos" maxLength={18} />
                  </div>
                  <div className="vault-form-group">
                    <label>Nota (opcional)</label>
                    <input type="text" value={bankValues.note} onChange={e => setBankValues(p => ({ ...p, note: e.target.value }))} placeholder="Ej: Cuenta principal, nómina..." />
                  </div>
                </>
              )}
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setBankModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveBank} disabled={saving || !bankValues.name?.trim()}>
                {saving ? <><span className="spinner" /> Guardando...</> : <><SaveIcon size={14} /> {bankModal === 'create' ? 'Crear banco' : 'Guardar'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Debit CLABE Modal */}
      {debitModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setDebitModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '420px' }}>
            <div className="vault-modal-header">
              <h3><BankIcon size={16} /> Editar CLABE</h3>
              <button className="vault-modal-close" onClick={() => setDebitModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>CLABE interbancaria</label>
                <input type="text" value={debitValues.clabe} onChange={e => setDebitValues(p => ({ ...p, clabe: e.target.value.replace(/\D/g, '').slice(0, 18) }))} placeholder="18 dígitos" maxLength={18} />
              </div>
              <div className="vault-form-group">
                <label>Nota</label>
                <input type="text" value={debitValues.note} onChange={e => setDebitValues(p => ({ ...p, note: e.target.value }))} placeholder="Opcional..." />
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setDebitModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveDebit} disabled={saving}>
                {saving ? <><span className="spinner" /> Guardando...</> : <><SaveIcon size={14} /> Guardar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credit Account Modal */}
      {creditModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setCreditModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '500px' }}>
            <div className="vault-modal-header">
              <h3><CreditCardIcon size={16} /> {creditModal.mode === 'create' ? 'Nueva cuenta de crédito' : 'Editar cuenta de crédito'}</h3>
              <button className="vault-modal-close" onClick={() => setCreditModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>Límite de crédito *</label>
                <input type="number" value={creditValues.creditLimit} onChange={e => setCreditValues(p => ({ ...p, creditLimit: e.target.value }))} placeholder="50000" />
              </div>
              <div className="vault-form-group">
                <label>Saldo actual</label>
                <input type="number" value={creditValues.currentBalance} onChange={e => setCreditValues(p => ({ ...p, currentBalance: e.target.value }))} placeholder="0" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Día de corte</label>
                  <select value={creditValues.cutoffDay} onChange={e => setCreditValues(p => ({ ...p, cutoffDay: e.target.value }))}>
                    <option value="">Día...</option>
                    {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>Día {i + 1}</option>)}
                  </select>
                </div>
                <div className="vault-form-group">
                  <label>Días después del corte</label>
                  <input type="number" value={creditValues.daysAfterCutoff} onChange={e => setCreditValues(p => ({ ...p, daysAfterCutoff: e.target.value }))} placeholder="20" min="10" max="30" />
                  {creditValues.cutoffDay && creditValues.daysAfterCutoff && (
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Día de pago: {((parseInt(creditValues.cutoffDay, 10) + parseInt(creditValues.daysAfterCutoff, 10) - 1) % 31) + 1}
                    </div>
                  )}
                </div>
                <div className="vault-form-group">
                  <label>Alerta (días)</label>
                  <input type="number" value={creditValues.alertDaysBefore} onChange={e => setCreditValues(p => ({ ...p, alertDaysBefore: e.target.value }))} placeholder="1" min="0" max="15" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>CLABE para pagar</label>
                  <input type="text" value={creditValues.paymentClabe} onChange={e => setCreditValues(p => ({ ...p, paymentClabe: e.target.value }))} placeholder="18 dígitos" maxLength={18} style={{ fontFamily: 'monospace' }} />
                </div>
                <div className="vault-form-group">
                  <label>Nota CLABE pago</label>
                  <input type="text" value={creditValues.paymentClabeNote} onChange={e => setCreditValues(p => ({ ...p, paymentClabeNote: e.target.value }))} placeholder="sólo para pagar" />
                </div>
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setCreditModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveCredit} disabled={saving || !creditValues.creditLimit}>
                {saving ? <><span className="spinner" /> Guardando...</> : <><SaveIcon size={14} /> {creditModal.mode === 'create' ? 'Crear' : 'Guardar'}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MSI Modal */}
      {msiModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setMsiModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '460px' }}>
            <div className="vault-modal-header">
              <h3><ReceiptIcon size={16} /> Agregar compra a meses</h3>
              <button className="vault-modal-close" onClick={() => setMsiModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>Descripción *</label>
                <input type="text" value={msiValues.description} onChange={e => setMsiValues(p => ({ ...p, description: e.target.value }))} placeholder="Ej: MacBook Pro, Refrigerador..." />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Monto total</label>
                  <input type="number" value={msiValues.totalAmount} onChange={e => setMsiValues(p => ({ ...p, totalAmount: e.target.value }))} placeholder="15000" />
                </div>
                <div className="vault-form-group">
                  <label>Meses</label>
                  <input type="number" value={msiValues.months} onChange={e => setMsiValues(p => ({ ...p, months: e.target.value }))} placeholder="12" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Pago mensual</label>
                  <input type="number" value={msiValues.monthlyPayment} onChange={e => setMsiValues(p => ({ ...p, monthlyPayment: e.target.value }))} placeholder="1250" />
                </div>
                <div className="vault-form-group">
                  <label>Meses restantes</label>
                  <input type="number" value={msiValues.remainingMonths} onChange={e => setMsiValues(p => ({ ...p, remainingMonths: e.target.value }))} placeholder="12" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Fecha inicio</label>
                  <input type="date" value={msiValues.startDate} onChange={e => setMsiValues(p => ({ ...p, startDate: e.target.value }))} />
                </div>
                <div className="vault-form-group" style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '4px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' }}>
                    <input type="checkbox" checked={msiValues.withInterest} onChange={e => setMsiValues(p => ({ ...p, withInterest: e.target.checked }))} />
                    Con intereses
                  </label>
                </div>
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setMsiModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveMsi} disabled={saving || !msiValues.description}>
                {saving ? <><span className="spinner" /> Guardando...</> : <><SaveIcon size={14} /> Agregar MSI</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Statement Modal */}
      {statementModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setStatementModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '420px' }}>
            <div className="vault-modal-header">
              <h3><CalendarIcon size={16} /> Estado de cuenta</h3>
              <button className="vault-modal-close" onClick={() => setStatementModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>Mes (YYYY-MM) *</label>
                <input type="month" value={statementValues.monthKey} onChange={e => setStatementValues(p => ({ ...p, monthKey: e.target.value }))} />
              </div>
              <div className="vault-form-group">
                <label>Saldo al corte</label>
                <input type="number" value={statementValues.balanceAtCutoff} onChange={e => setStatementValues(p => ({ ...p, balanceAtCutoff: e.target.value }))} placeholder="0" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Pago realizado</label>
                  <input type="number" value={statementValues.paymentMade} onChange={e => setStatementValues(p => ({ ...p, paymentMade: e.target.value }))} placeholder="0" />
                </div>
              </div>
              <div className="vault-form-group">
                <label>Intereses cobrados</label>
                <input type="number" value={statementValues.interestCharged} onChange={e => setStatementValues(p => ({ ...p, interestCharged: e.target.value }))} placeholder="0" />
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setStatementModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleSaveStatement} disabled={saving || !statementValues.monthKey}>
                {saving ? <><span className="spinner" /> Guardando...</> : <><SaveIcon size={14} /> Guardar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logo Gallery Modal */}
      {logoModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setLogoModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '560px' }}>
            <div className="vault-modal-header">
              <h3><ImageIcon size={16} /> Galería de logos</h3>
              <button className="vault-modal-close" onClick={() => setLogoModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div style={{ padding: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '10px', marginBottom: '16px' }}>
                {logoGallery.map(logo => (
                  <div key={logo.id} style={{ position: 'relative', textAlign: 'center' }}>
                    <img
                      src={logo.url}
                      alt={logo.name}
                      onClick={() => handleSelectLogo(logo.url)}
                      style={{ width: '64px', height: '64px', borderRadius: '10px', objectFit: 'cover', cursor: 'pointer', border: '2px solid var(--border-color)', transition: 'border-color 0.2s' }}
                      onMouseOver={e => { e.target.style.borderColor = 'var(--accent-primary)'; }}
                      onMouseOut={e => { e.target.style.borderColor = 'var(--border-color)'; }}
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{logo.name}</div>
                    {!logo.isDefault && (
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteLogo(logo.id); }}
                        style={{ position: 'absolute', top: '-4px', right: '4px', background: '#ef4444', border: 'none', borderRadius: '50%', width: '18px', height: '18px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                      >
                        <CloseIcon size={10} color="#fff" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input type="file" ref={fileInputRef} accept="image/*" style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) handleUploadLogo(e.target.files[0]); e.target.value = ''; }} />
                <button className="vault-action-btn edit" style={{ fontSize: '12px' }} onClick={() => fileInputRef.current?.click()} disabled={logoUploading}>
                  {logoUploading ? <><span className="spinner" /> Subiendo...</> : <><UploadIcon size={14} /> Subir nuevo logo</>}
                </button>
                <button className="vault-action-btn edit" style={{ fontSize: '12px' }} onClick={() => { handleSelectLogo(''); }}>
                  <TrashIcon size={14} /> Quitar logo
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Card Create Modal */}
      {cardCreateModal && (
        <div className="vault-modal-overlay" {...overlayProps(() => setCardCreateModal(null))}>
          <div className="vault-modal" style={{ maxWidth: '460px' }}>
            <div className="vault-modal-header">
              <h3><CreditCardIcon size={16} /> Nueva tarjeta ({cardCreateModal.accountType === 'credit' ? 'crédito' : 'débito'})</h3>
              <button className="vault-modal-close" onClick={() => setCardCreateModal(null)}><CloseIcon size={16} /></button>
            </div>
            <div className="vault-modal-form">
              <div className="vault-form-group">
                <label>Banco</label>
                <input type="text" value={banks[cardCreateModal.bankId]?.name || ''} disabled style={{ opacity: 0.7 }} />
              </div>
              <div className="vault-form-group">
                <label>Número de tarjeta</label>
                <input type="text" value={formatCardInput(cardCreateValues.number)} onChange={e => setCardCreateValues(p => ({ ...p, number: e.target.value.replace(/\D/g, '').slice(0, 16) }))} placeholder="1234 5678 9012 3456" maxLength={19} autoComplete="off" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div className="vault-form-group">
                  <label>Vencimiento</label>
                  <input
                    type="text"
                    value={cardCreateValues.expiry}
                    onChange={e => setCardCreateValues(p => ({
                      ...p,
                      expiry: normalizeCardExpiryInput(e.target.value),
                    }))}
                    placeholder="MM/YYYY"
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
                <div className="vault-form-group">
                  <label>CVV</label>
                  <input type="password" value={cardCreateValues.cvv} onChange={e => setCardCreateValues(p => ({ ...p, cvv: e.target.value.replace(/\D/g, '').slice(0, 4) }))} placeholder="···" maxLength={4} autoComplete="off" />
                </div>
              </div>
              <div className="vault-form-group">
                <label>Titular</label>
                <input type="text" value={cardCreateValues.holder} onChange={e => setCardCreateValues(p => ({ ...p, holder: e.target.value }))} placeholder="Nombre como aparece en la tarjeta" />
              </div>
              <div className="vault-form-group">
                <label>Notas (opcional)</label>
                <input type="text" value={cardCreateValues.notes} onChange={e => setCardCreateValues(p => ({ ...p, notes: e.target.value }))} placeholder="Ej: tarjeta principal, respaldo..." />
              </div>
            </div>
            <div className="vault-modal-actions">
              <button className="vault-modal-btn cancel" onClick={() => setCardCreateModal(null)}>Cancelar</button>
              <button className="vault-modal-btn save" onClick={handleCardCreate} disabled={saving || !cardCreateValues.number || cardCreateValues.number.replace(/\D/g, '').length < 4}>
                {saving ? <><span className="spinner" /> Creando...</> : <><SaveIcon size={14} /> Crear tarjeta</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm + Toast */}
      <ConfirmDialog
        open={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        onConfirm={confirmDialog?.onConfirm}
        title={confirmDialog?.title}
        message={confirmDialog?.message}
        confirmLabel={confirmDialog?.confirmLabel}
        danger={confirmDialog?.danger}
      />
      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onClose={() => setToast(t => ({ ...t, visible: false }))}
      />
    </div>
  );

  // ─── Credit account details render ───
  function renderCreditDetails(bank, credit, expandSection, creditCards) {
    const utilPct = credit.creditLimit > 0 ? Math.min(100, Math.round((credit.currentBalance / credit.creditLimit) * 100)) : 0;
    const utilClass = utilPct <= 30 ? 'low' : utilPct <= 70 ? 'medium' : 'high';
    const available = Math.max(0, (credit.creditLimit || 0) - (credit.currentBalance || 0));
    const installments = credit.installments || [];
    const statements = [...(credit.monthlyStatements || [])].sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
    const totalMSIMonthly = installments.reduce((s, i) => s + (i.monthlyPayment || 0), 0);

    return (
      <div style={{ padding: '8px 12px' }}>
        {/* Utilization bar */}
        <div className="credit-util-bar-wrap">
          <div className="credit-util-bar-labels">
            <span>Usado: {formatMXN(credit.currentBalance)}</span>
            <span>Disponible: {formatMXN(available)}</span>
          </div>
          <div className="credit-util-bar">
            <div className={`credit-util-fill ${utilClass}`} style={{ width: `${utilPct}%` }} />
          </div>
          <div style={{ fontSize: '11px', textAlign: 'right', color: utilClass === 'low' ? '#10b981' : utilClass === 'medium' ? '#f59e0b' : '#ef4444' }}>
            {utilPct}% utilizado
          </div>
        </div>

        {/* Key dates */}
        <div className="credit-dates-row">
          {credit.paymentClabe && (
            <div className="credit-date-item" style={{ gridColumn: '1 / -1' }}>
              <div>
                <div className="credit-date-label">CLABE para pagar</div>
                <div className="credit-date-value" style={{ fontFamily: 'monospace', fontSize: '13px' }}>{credit.paymentClabe}</div>
                {credit.paymentClabeNote && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{credit.paymentClabeNote}</div>}
              </div>
            </div>
          )}
          <div className="credit-date-item">
            <div>
              <div className="credit-date-label">Fecha de corte</div>
              <div className="credit-date-value">Día {credit.cutoffDay}</div>
            </div>
          </div>
          <div className="credit-date-item">
            <div>
              <div className="credit-date-label">Límite de pago</div>
              <div className="credit-date-value">Día {credit.daysAfterCutoff ? ((parseInt(credit.cutoffDay || 1, 10) + parseInt(credit.daysAfterCutoff, 10) - 1) % 31) + 1 : credit.paymentDueDay} <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>({credit.daysAfterCutoff || '?'}d después corte)</span></div>
            </div>
          </div>
        </div>

        {/* Linked credit cards */}
        {creditCards.length > 0 && (
          <div className="credit-links-row">
            {creditCards.map(c => (
              <span className="credit-link-chip" key={c.id}>
                <CreditCardIcon size={12} /> {c.bank} ****{c.lastFour}
                <button
                  type="button"
                  className="vault-chip-remove-btn"
                  onClick={() => handleUnlinkCard(c.id, `${c.bank} ****${c.lastFour}`)}
                  title="Quitar tarjeta vinculada"
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <button className="vault-action-btn edit" style={{ marginTop: '4px', padding: '3px 8px', fontSize: '11px' }} onClick={() => openCardCreate(bank.id, 'credit')}>
          <CreditCardIcon size={12} /> Nueva tarjeta crédito
        </button>

        {/* MSI chips */}
        {installments.length > 0 && (
          <div className="credit-links-row" style={{ marginTop: '6px' }}>
            <span className="credit-link-chip"><ReceiptIcon size={12} /> {installments.length} MSI · {formatMXN(totalMSIMonthly)}/mes</span>
          </div>
        )}

        {/* Installments expandable */}
        {installments.length > 0 && (
          <>
            <div className="credit-expand-toggle" onClick={() => toggleCreditSection(bank.id, 'installments')}>
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
                    <button className="clabe-remove-btn" style={{ opacity: 0.7, marginLeft: '4px' }} onClick={() => handleRemoveMsi(bank.id, inst.id, inst.description)} title="Eliminar MSI">
                      <TrashIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Statements expandable */}
        {statements.length > 0 && (
          <>
            <div className="credit-expand-toggle" onClick={() => toggleCreditSection(bank.id, 'statements')}>
              <span><CalendarIcon size={14} /> Historial de estados de cuenta ({statements.length})</span>
              <span style={{ fontSize: '12px', transition: 'transform 0.3s', transform: expandSection === 'statements' ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
            </div>
            <div className={`credit-expand-body ${expandSection === 'statements' ? 'expanded' : ''}`}>
              <div style={{ padding: '8px 0' }}>
                {statements.map(stmt => {
                  const [y, m] = (stmt.monthKey || '').split('-').map(Number);
                  const monthLabel = MONTH_NAMES_ES[m - 1] ? `${MONTH_NAMES_ES[m - 1]} ${y}` : stmt.monthKey;
                  const paid = (stmt.paymentMade || 0) > 0;
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
          <button className="alert-action-btn edit" style={{ fontSize: '11px' }} onClick={() => openMsiModal(bank.id)}>
            <PlusIcon size={14} /> MSI
          </button>
          <button className="alert-action-btn edit" style={{ fontSize: '11px' }} onClick={() => openStatementModal(bank.id)}>
            <PlusIcon size={14} /> Estado de cuenta
          </button>
        </div>
      </div>
    );
  }
}
