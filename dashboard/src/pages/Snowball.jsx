import { useMemo, useState } from 'react';
import { useCollection, useDocument } from '../hooks/useFirestore';
import { saveSnowballConfig, normalizeClabe } from '../hooks/firestoreActions';
import { BankIcon, CheckCircleIcon, EditIcon, LinkIcon, PlusIcon, SaveIcon, ToggleOffIcon, ToggleOnIcon, TrashIcon, WarningIcon } from '../components/Icons';

const EMPTY_CONFIG = { wallets: {}, connections: {} };

function accountLabel(account) {
  if (!account) return 'Cuenta no encontrada';
  return `#${account.id} ${account.canonicalAlias || account.fullName || account.email || 'Cuenta Lank'}`;
}

function activeConnections(config) {
  return Object.entries(config.connections || {})
    .map(([id, connection]) => ({ id, ...connection }))
    .filter(connection => connection.active !== false);
}

function buildChains(config, accountById, bankById) {
  const connections = activeConnections(config);
  const byFrom = new Map(connections.map(connection => [String(connection.fromAccountId), connection]));
  const internalIncoming = new Set(
    connections
      .filter(connection => connection.destinationType === 'lank_wallet')
      .map(connection => String(connection.toAccountId))
  );
  const starts = connections
    .map(connection => String(connection.fromAccountId))
    .filter(accountId => !internalIncoming.has(accountId))
    .filter((accountId, idx, arr) => arr.indexOf(accountId) === idx)
    .sort((a, b) => Number(a) - Number(b));

  return starts.map((start) => {
    const nodes = [];
    const seen = new Set();
    let current = start;
    let terminal = null;

    while (current && !seen.has(current)) {
      seen.add(current);
      nodes.push({
        type: 'account',
        accountId: current,
        label: accountLabel(accountById.get(String(current))),
        walletClabe: config.wallets?.[current]?.walletClabe || '',
      });

      const connection = byFrom.get(String(current));
      if (!connection) break;
      if (connection.destinationType === 'external_bank') {
        const bank = bankById.get(connection.destinationBankId);
        terminal = {
          type: 'bank',
          label: bank?.name || connection.destinationBankName || 'Banco externo',
          clabe: connection.destinationClabe,
        };
        break;
      }
      current = String(connection.toAccountId);
    }

    return { start, nodes, terminal };
  });
}

function SnowballModal({ title, children, onClose, onSave, saving }) {
  return (
    <div className="edit-modal-overlay" onMouseDown={onClose}>
      <div className="edit-modal snowball-modal" onMouseDown={event => event.stopPropagation()}>
        <div className="edit-modal-header">
          <div className="edit-modal-title"><LinkIcon size={20} /> {title}</div>
          <button className="edit-modal-close" onClick={onClose}>x</button>
        </div>
        <div className="edit-modal-body">{children}</div>
        <div className="edit-modal-actions">
          <button className="edit-modal-btn cancel" onClick={onClose}>Cancelar</button>
          <button className="edit-modal-btn primary" onClick={onSave} disabled={saving}>
            <SaveIcon size={16} /> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Snowball() {
  const { data: registryDoc } = useDocument('config', 'account-registry', { realtime: true });
  const { data: snowballDoc, loading: snowballLoading } = useDocument('config', 'snowball', { realtime: true });
  const { data: banks } = useCollection('banks', { realtime: true });
  const [walletModal, setWalletModal] = useState(null);
  const [connectionModal, setConnectionModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const accounts = useMemo(() => {
    return (registryDoc?.accounts || [])
      .map(account => ({ ...account, id: String(account.id) }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }, [registryDoc]);

  const config = useMemo(() => ({
    wallets: snowballDoc?.wallets || EMPTY_CONFIG.wallets,
    connections: snowballDoc?.connections || EMPTY_CONFIG.connections,
  }), [snowballDoc]);

  const accountById = useMemo(() => new Map(accounts.map(account => [String(account.id), account])), [accounts]);
  const bankOptions = useMemo(() => banks
    .map(bank => ({
      id: bank.id,
      name: bank.name || bank.id,
      clabe: normalizeClabe(bank.debitAccount?.clabe || bank.clabe),
    }))
    .filter(bank => bank.clabe)
    .sort((a, b) => a.name.localeCompare(b.name)), [banks]);
  const bankById = useMemo(() => new Map(bankOptions.map(bank => [bank.id, bank])), [bankOptions]);
  const connections = useMemo(() => Object.entries(config.connections || {}).map(([id, c]) => ({ id, ...c })), [config]);
  const chains = useMemo(() => buildChains(config, accountById, bankById), [config, accountById, bankById]);
  const activeCount = connections.filter(connection => connection.active !== false).length;

  async function persist(nextConfig, description) {
    setSaving(true);
    try {
      await saveSnowballConfig(nextConfig, description);
      setToast({ type: 'success', message: 'Snowball actualizado' });
      setWalletModal(null);
      setConnectionModal(null);
    } catch (error) {
      setToast({ type: 'error', message: error.message || 'No se pudo guardar Snowball' });
    } finally {
      setSaving(false);
    }
  }

  function saveWallet() {
    const accountId = String(walletModal.accountId || '').trim();
    const clabe = normalizeClabe(walletModal.walletClabe);
    if (!accountId || clabe.length !== 18) {
      setToast({ type: 'error', message: 'Selecciona cuenta Lank y captura una CLABE interna de 18 dígitos' });
      return;
    }
    const account = accountById.get(accountId);
    const nextConfig = {
      ...config,
      wallets: {
        ...config.wallets,
        [accountId]: {
          accountId,
          accountAlias: account?.canonicalAlias || account?.fullName || '',
          walletClabe: clabe,
          active: walletModal.active !== false,
          notes: walletModal.notes || '',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    persist(nextConfig, `CLABE interna Snowball actualizada para Lank #${accountId}`);
  }

  function saveConnection() {
    const fromAccountId = String(connectionModal.fromAccountId || '').trim();
    const destinationType = connectionModal.destinationType || 'lank_wallet';
    const id = connectionModal.id || `snowball_${fromAccountId}_${Date.now()}`;
    let payload = {
      id,
      fromAccountId,
      destinationType,
      active: connectionModal.active !== false,
      notes: connectionModal.notes || '',
      updatedAt: new Date().toISOString(),
    };

    if (destinationType === 'lank_wallet') {
      const toAccountId = String(connectionModal.toAccountId || '').trim();
      const wallet = config.wallets?.[toAccountId];
      payload = {
        ...payload,
        toAccountId,
        destinationClabe: normalizeClabe(wallet?.walletClabe),
        destinationBankId: null,
        destinationBankName: null,
      };
    } else {
      const bank = bankById.get(connectionModal.destinationBankId);
      payload = {
        ...payload,
        toAccountId: null,
        destinationBankId: bank?.id || '',
        destinationBankName: bank?.name || '',
        destinationClabe: bank?.clabe || '',
      };
    }

    const nextConfig = {
      ...config,
      connections: {
        ...config.connections,
        [id]: payload,
      },
    };
    persist(nextConfig, `Conexión Snowball guardada desde Lank #${fromAccountId}`);
  }

  function toggleConnection(connection) {
    const nextConfig = {
      ...config,
      connections: {
        ...config.connections,
        [connection.id]: {
          ...connection,
          active: connection.active === false,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    persist(nextConfig, `Conexión Snowball ${connection.active === false ? 'activada' : 'desactivada'}`);
  }

  function deleteConnection(connection) {
    const nextConnections = { ...config.connections };
    delete nextConnections[connection.id];
    persist({ ...config, connections: nextConnections }, `Conexión Snowball eliminada desde Lank #${connection.fromAccountId}`);
  }

  return (
    <div className="snowball-page">
      {toast && (
        <div className={`snowball-toast ${toast.type}`} onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}

      <div className="finance-kpis-4">
        <div className="stat-card">
          <div className="stat-card-icon"><LinkIcon size={24} /></div>
          <div className="stat-card-value">{chains.length}</div>
          <div className="stat-card-label">Bolas activas</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon"><CheckCircleIcon size={24} /></div>
          <div className="stat-card-value">{activeCount}</div>
          <div className="stat-card-label">Conexiones activas</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon"><BankIcon size={24} /></div>
          <div className="stat-card-value">{bankOptions.length}</div>
          <div className="stat-card-label">Bancos destino</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-icon"><WarningIcon size={24} /></div>
          <div className="stat-card-value">{accounts.filter(a => config.wallets?.[a.id]?.walletClabe).length}</div>
          <div className="stat-card-label">Billeteras internas</div>
        </div>
      </div>

      <section className="snowball-section">
        <div className="snowball-section-header">
          <div>
            <h2>Flujo Snowball</h2>
            <p>Cadenas lineales de cuentas Lank y retiro final hacia banco externo.</p>
          </div>
          <button className="vault-action-btn create" onClick={() => setConnectionModal({ destinationType: 'lank_wallet', active: true })}>
            <PlusIcon size={16} /> Nueva conexión
          </button>
        </div>

        {snowballLoading ? (
          <div className="empty-state"><p>Cargando Snowball...</p></div>
        ) : chains.length === 0 ? (
          <div className="empty-state"><p>No hay cadenas activas configuradas.</p></div>
        ) : (
          <div className="snowball-chain-list">
            {chains.map(chain => (
              <div className="snowball-chain" key={chain.start}>
                {chain.nodes.map((node, index) => (
                  <div className="snowball-chain-part" key={`${chain.start}-${node.accountId}`}>
                    {index > 0 && <div className="snowball-arrow">-&gt;</div>}
                    <div className="snowball-node">
                      <strong>{node.label}</strong>
                      <span>{node.walletClabe || 'CLABE interna pendiente'}</span>
                    </div>
                  </div>
                ))}
                {chain.terminal && (
                  <div className="snowball-chain-part">
                    <div className="snowball-arrow">-&gt;</div>
                    <div className="snowball-node terminal">
                      <strong>{chain.terminal.label}</strong>
                      <span>{chain.terminal.clabe}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="snowball-grid">
        <div className="snowball-section">
          <div className="snowball-section-header">
            <div>
              <h2>Billeteras Lank</h2>
              <p>CLABEs internas de Lank. No son cuentas bancarias externas.</p>
            </div>
            <button className="vault-action-btn create" onClick={() => setWalletModal({ active: true })}>
              <PlusIcon size={16} /> CLABE interna
            </button>
          </div>
          <div className="snowball-table-wrap">
            <table className="analyze-table">
              <thead><tr><th>Cuenta</th><th>CLABE interna</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {accounts.map(account => {
                  const wallet = config.wallets?.[account.id];
                  return (
                    <tr key={account.id}>
                      <td>{accountLabel(account)}</td>
                      <td>{wallet?.walletClabe || 'Sin CLABE'}</td>
                      <td>{wallet?.active === false ? 'Inactiva' : wallet?.walletClabe ? 'Activa' : 'Pendiente'}</td>
                      <td>
                        <button className="vault-action-btn edit" onClick={() => setWalletModal({ accountId: account.id, ...(wallet || { active: true }) })}>
                          <EditIcon size={14} /> Editar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="snowball-section">
          <div className="snowball-section-header">
            <div>
              <h2>Conexiones</h2>
              <p>Una entrada y una salida activa por cuenta Lank.</p>
            </div>
          </div>
          <div className="snowball-table-wrap">
            <table className="analyze-table">
              <thead><tr><th>Origen</th><th>Destino</th><th>CLABE</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {connections.length === 0 ? (
                  <tr><td colSpan="5">Sin conexiones configuradas.</td></tr>
                ) : connections.map(connection => {
                  const from = accountById.get(String(connection.fromAccountId));
                  const to = connection.destinationType === 'lank_wallet'
                    ? accountById.get(String(connection.toAccountId))
                    : bankById.get(connection.destinationBankId);
                  return (
                    <tr key={connection.id}>
                      <td>{accountLabel(from)}</td>
                      <td>{connection.destinationType === 'lank_wallet' ? accountLabel(to) : to?.name || 'Banco externo'}</td>
                      <td>{connection.destinationClabe || 'Sin CLABE'}</td>
                      <td>{connection.active === false ? 'Inactiva' : 'Activa'}</td>
                      <td className="snowball-actions">
                        <button className="vault-action-btn edit" onClick={() => setConnectionModal(connection)}><EditIcon size={14} /></button>
                        <button className="vault-action-btn view" onClick={() => toggleConnection(connection)}>
                          {connection.active === false ? <ToggleOffIcon size={14} /> : <ToggleOnIcon size={14} />}
                        </button>
                        <button className="vault-action-btn delete" onClick={() => deleteConnection(connection)}><TrashIcon size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {walletModal && (
        <SnowballModal title="CLABE interna Lank" onClose={() => setWalletModal(null)} onSave={saveWallet} saving={saving}>
          <label className="edit-modal-field">
            <span className="edit-modal-label">Cuenta Lank</span>
            <select className="edit-modal-input" value={walletModal.accountId || ''} onChange={event => setWalletModal(p => ({ ...p, accountId: event.target.value }))}>
              <option value="">Seleccionar cuenta</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
            </select>
          </label>
          <label className="edit-modal-field">
            <span className="edit-modal-label">CLABE interna de billetera Lank</span>
            <input className="edit-modal-input" value={walletModal.walletClabe || ''} maxLength={23} onChange={event => setWalletModal(p => ({ ...p, walletClabe: event.target.value }))} />
          </label>
          <label className="snowball-check">
            <input type="checkbox" checked={walletModal.active !== false} onChange={event => setWalletModal(p => ({ ...p, active: event.target.checked }))} />
            Activa
          </label>
          <label className="edit-modal-field">
            <span className="edit-modal-label">Notas</span>
            <textarea className="edit-modal-input edit-modal-textarea" value={walletModal.notes || ''} onChange={event => setWalletModal(p => ({ ...p, notes: event.target.value }))} />
          </label>
        </SnowballModal>
      )}

      {connectionModal && (
        <SnowballModal title="Conexión Snowball" onClose={() => setConnectionModal(null)} onSave={saveConnection} saving={saving}>
          <label className="edit-modal-field">
            <span className="edit-modal-label">Cuenta origen</span>
            <select className="edit-modal-input" value={connectionModal.fromAccountId || ''} onChange={event => setConnectionModal(p => ({ ...p, fromAccountId: event.target.value }))}>
              <option value="">Seleccionar cuenta</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
            </select>
          </label>
          <label className="edit-modal-field">
            <span className="edit-modal-label">Tipo de destino</span>
            <select className="edit-modal-input" value={connectionModal.destinationType || 'lank_wallet'} onChange={event => setConnectionModal(p => ({ ...p, destinationType: event.target.value, toAccountId: '', destinationBankId: '' }))}>
              <option value="lank_wallet">Transferencia interna Lank</option>
              <option value="external_bank">Retiro externo bancario</option>
            </select>
          </label>
          {(connectionModal.destinationType || 'lank_wallet') === 'lank_wallet' ? (
            <label className="edit-modal-field">
              <span className="edit-modal-label">Cuenta destino</span>
              <select className="edit-modal-input" value={connectionModal.toAccountId || ''} onChange={event => setConnectionModal(p => ({ ...p, toAccountId: event.target.value }))}>
                <option value="">Seleccionar cuenta destino</option>
                {accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
              </select>
            </label>
          ) : (
            <label className="edit-modal-field">
              <span className="edit-modal-label">Banco externo final</span>
              <select className="edit-modal-input" value={connectionModal.destinationBankId || ''} onChange={event => setConnectionModal(p => ({ ...p, destinationBankId: event.target.value }))}>
                <option value="">Seleccionar banco</option>
                {bankOptions.map(bank => <option key={bank.id} value={bank.id}>{bank.name} · {bank.clabe}</option>)}
              </select>
            </label>
          )}
          <label className="snowball-check">
            <input type="checkbox" checked={connectionModal.active !== false} onChange={event => setConnectionModal(p => ({ ...p, active: event.target.checked }))} />
            Activa
          </label>
          <label className="edit-modal-field">
            <span className="edit-modal-label">Notas</span>
            <textarea className="edit-modal-input edit-modal-textarea" value={connectionModal.notes || ''} onChange={event => setConnectionModal(p => ({ ...p, notes: event.target.value }))} />
          </label>
        </SnowballModal>
      )}
    </div>
  );
}
