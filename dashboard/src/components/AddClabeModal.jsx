import { useState, useEffect, useRef } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';
import { BANKS } from '../config/services';
import { CheckCircleIcon, WarningIcon, CloseIcon, CheckIcon, BankIcon, PlusIcon, UploadIcon, ImageIcon } from './Icons';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/jpg'];

export default function AddClabeModal({ open, onClose, onSave, customBankAccounts = {} }) {
  const [mode, setMode] = useState('select'); // 'select' | 'create'
  const [selectedBank, setSelectedBank] = useState('');
  const [clabe, setClabe] = useState('');
  const [accountType, setAccountType] = useState('debito');
  const [note, setNote] = useState('');

  // New bank fields
  const [newBankName, setNewBankName] = useState('');
  const [newBankColor, setNewBankColor] = useState('#3b82f6');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const fileInputRef = useRef(null);

  const allBanks = buildBankOptions(customBankAccounts);

  useEffect(() => {
    if (open) {
      setMode('select');
      setSelectedBank('');
      setClabe('');
      setAccountType('debito');
      setNote('');
      setNewBankName('');
      setNewBankColor('#3b82f6');
      setImageFile(null);
      setImagePreview('');
      setError('');
      setSuccess(false);
      setSaving(false);
      setConfirmStep(false);
    }
  }, [open]);

  if (!open) return null;

  function handleImageChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Solo se permiten imágenes PNG, JPG o WebP');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('La imagen no debe superar 2 MB');
      return;
    }
    setError('');
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target.result);
    reader.readAsDataURL(file);
  }

  function handleRequestSave() {
    setError('');
    if (!clabe.trim()) { setError('La CLABE es obligatoria'); return; }
    if (clabe.trim().length !== 18 || !/^\d+$/.test(clabe.trim())) {
      setError('La CLABE debe ser exactamente 18 dígitos numéricos');
      return;
    }

    if (mode === 'select') {
      if (!selectedBank) { setError('Selecciona una cuenta bancaria'); return; }
    } else {
      if (!newBankName.trim()) { setError('El nombre del banco es obligatorio'); return; }
      if (!imageFile && !imagePreview) { setError('Sube una imagen/logo del banco'); return; }
    }

    setConfirmStep(true);
  }

  async function handleConfirmSave() {
    setSaving(true);
    setError('');
    try {
      let bankName;
      let newBankData = null;

      if (mode === 'create') {
        bankName = newBankName.trim();
        let logoUrl = '';

        if (imageFile) {
          const ext = imageFile.name.split('.').pop();
          const safeName = bankName.replace(/[^a-zA-Z0-9]/g, '_');
          const ts = Date.now();
          const storageRef = ref(storage, `bank-logos/${safeName}_${ts}.${ext}`);
          await uploadBytes(storageRef, imageFile);
          logoUrl = await getDownloadURL(storageRef);
        }

        newBankData = {
          name: bankName,
          color: newBankColor,
          logo: logoUrl,
        };
      } else {
        bankName = selectedBank;
      }

      const clabeEntry = {
        bank: bankName,
        clabe: clabe.trim(),
        type: accountType,
      };
      if (note.trim()) clabeEntry.note = note.trim();

      await onSave(clabeEntry, newBankData);

      setSuccess(true);
      setTimeout(() => { onClose(); setSuccess(false); }, 800);
    } catch (err) {
      setError(err.message || 'Error al guardar');
      setSaving(false);
      setConfirmStep(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (confirmStep) setConfirmStep(false);
      else onClose();
    }
  }

  const selectedBankMeta = selectedBank
    ? (BANKS[selectedBank] || customBankAccounts[selectedBank] || {})
    : null;

  return (
    <div className="edit-modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="edit-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        {success ? (
          <div className="edit-modal-success">
            <span className="edit-modal-success-icon"><CheckCircleIcon size={48} /></span>
            <div className="edit-modal-success-text">CLABE agregada</div>
          </div>
        ) : confirmStep ? (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '12px' }}><WarningIcon size={40} /></div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>¿Estás seguro?</h3>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}>
              Se agregará esta cuenta CLABE a la lista.
            </p>

            <div style={{
              background: 'var(--bg-input)', border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: '20px',
              textAlign: 'left', fontSize: '13px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>Banco:</span>
                <span style={{ fontWeight: 600 }}>{mode === 'create' ? newBankName : selectedBank}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>CLABE:</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{clabe}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>Tipo:</span>
                <span style={{ fontWeight: 600 }}>{accountType === 'debito' ? 'Débito' : 'Crédito'}</span>
              </div>
              {mode === 'create' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Nuevo banco:</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {imagePreview && <img src={imagePreview} alt="" style={{ width: '20px', height: '20px', borderRadius: '4px', objectFit: 'cover' }} />}
                    <span style={{ fontWeight: 600 }}>Se creará</span>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button className="edit-modal-btn primary" onClick={handleConfirmSave} disabled={saving}>
                {saving ? (<><span className="spinner" /> Guardando...</>) : (<><CheckIcon size={16} /> Sí, confirmar</>)}
              </button>
              <button className="edit-modal-btn cancel" onClick={() => setConfirmStep(false)} disabled={saving}>
                ← Volver a editar
              </button>
            </div>
            {error && <div className="edit-modal-error" style={{ marginTop: '12px' }}><WarningIcon size={14} /> {error}</div>}
          </div>
        ) : (
          <>
            <div className="edit-modal-header">
              <span className="edit-modal-icon"><BankIcon size={16} /></span>
              <h3 className="edit-modal-title">Agregar cuenta CLABE</h3>
              <button className="edit-modal-close" onClick={onClose}><CloseIcon size={18} /></button>
            </div>

            <div className="edit-modal-body">
              {/* Bank selection mode toggle */}
              <div className="add-clabe-mode-toggle">
                <button
                  className={`add-clabe-mode-btn ${mode === 'select' ? 'active' : ''}`}
                  onClick={() => { setMode('select'); setError(''); }}
                >
                  <BankIcon size={14} /> Banco existente
                </button>
                <button
                  className={`add-clabe-mode-btn ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => { setMode('create'); setError(''); }}
                >
                  <PlusIcon size={14} /> Nuevo banco
                </button>
              </div>

              {mode === 'select' ? (
                /* ─── Select existing bank ─── */
                <div className="edit-modal-field">
                  <label className="edit-modal-label">Cuenta bancaria<span className="edit-modal-required">*</span></label>
                  <div className="add-clabe-bank-grid">
                    {allBanks.map(b => (
                      <button
                        key={b.name}
                        className={`add-clabe-bank-option ${selectedBank === b.name ? 'selected' : ''}`}
                        onClick={() => { setSelectedBank(b.name); setError(''); }}
                        style={{ '--bank-color': b.color }}
                      >
                        {b.logo ? (
                          <img src={b.logo} alt="" className="add-clabe-bank-logo" onError={e => { e.target.style.display = 'none'; }} />
                        ) : (
                          <div className="add-clabe-bank-placeholder"><BankIcon size={18} /></div>
                        )}
                        <span className="add-clabe-bank-name">{b.name}</span>
                        {selectedBank === b.name && (
                          <span className="add-clabe-bank-check"><CheckCircleIcon size={16} /></span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* ─── Create new bank ─── */
                <>
                  <div className="edit-modal-field">
                    <label className="edit-modal-label">Nombre del banco<span className="edit-modal-required">*</span></label>
                    <input
                      className="edit-modal-input"
                      value={newBankName}
                      onChange={e => { setNewBankName(e.target.value); setError(''); }}
                      placeholder="Ej: Banorte, HSBC, Revolut..."
                    />
                  </div>

                  <div className="edit-modal-field">
                    <label className="edit-modal-label">Color del banco</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <input
                        type="color"
                        value={newBankColor}
                        onChange={e => setNewBankColor(e.target.value)}
                        style={{ width: '40px', height: '36px', border: 'none', cursor: 'pointer', borderRadius: '6px', padding: 0 }}
                      />
                      <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{newBankColor}</span>
                    </div>
                  </div>

                  <div className="edit-modal-field">
                    <label className="edit-modal-label">Logo / imagen del banco<span className="edit-modal-required">*</span></label>
                    <div
                      className={`add-clabe-upload-zone ${imagePreview ? 'has-image' : ''}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {imagePreview ? (
                        <div className="add-clabe-upload-preview">
                          <img src={imagePreview} alt="Preview" />
                          <span className="add-clabe-upload-change">Cambiar imagen</span>
                        </div>
                      ) : (
                        <div className="add-clabe-upload-empty">
                          <UploadIcon size={28} />
                          <span>Clic para subir imagen</span>
                          <span className="add-clabe-upload-hint">PNG, JPG o WebP · máx 2 MB</span>
                        </div>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleImageChange}
                      style={{ display: 'none' }}
                    />
                  </div>
                </>
              )}

              {/* ─── Common CLABE fields ─── */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px', marginTop: '4px' }}>
                <div className="edit-modal-field">
                  <label className="edit-modal-label">CLABE interbancaria (18 dígitos)<span className="edit-modal-required">*</span></label>
                  <input
                    className="edit-modal-input"
                    value={clabe}
                    onChange={e => { setClabe(e.target.value.replace(/\D/g, '').slice(0, 18)); setError(''); }}
                    placeholder="000000000000000000"
                    maxLength={18}
                    inputMode="numeric"
                    style={{ fontFamily: 'monospace', letterSpacing: '1px' }}
                  />
                  {clabe.length > 0 && (
                    <span style={{ fontSize: '11px', color: clabe.length === 18 ? '#10b981' : 'var(--text-muted)' }}>
                      {clabe.length}/18 dígitos
                    </span>
                  )}
                </div>

                <div className="edit-modal-field" style={{ marginTop: '14px' }}>
                  <label className="edit-modal-label">Tipo de cuenta</label>
                  <select
                    className="edit-modal-input"
                    value={accountType}
                    onChange={e => setAccountType(e.target.value)}
                  >
                    <option value="debito">Débito</option>
                    <option value="credito">Crédito (solo para pagar)</option>
                  </select>
                </div>

                <div className="edit-modal-field" style={{ marginTop: '14px' }}>
                  <label className="edit-modal-label">Nota (opcional)</label>
                  <input
                    className="edit-modal-input"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Ej: solo para pagar servicios"
                  />
                </div>
              </div>
            </div>

            {error && <div className="edit-modal-error"><WarningIcon size={14} /> {error}</div>}

            <div className="edit-modal-actions">
              <button className="edit-modal-btn primary" onClick={handleRequestSave}>
                <BankIcon size={16} /> Agregar CLABE
              </button>
              <button className="edit-modal-btn cancel" onClick={onClose}>
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function buildBankOptions(customBankAccounts) {
  const options = [];
  for (const [name, meta] of Object.entries(BANKS)) {
    if (name.includes('Crédito')) continue;
    options.push({ name, color: meta.color, logo: meta.logo });
  }
  for (const [name, meta] of Object.entries(customBankAccounts)) {
    if (!options.find(o => o.name === name)) {
      options.push({ name, color: meta.color || '#64748b', logo: meta.logo || '' });
    }
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}
