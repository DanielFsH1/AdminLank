/**
 * Acciones de escritura a Firestore desde el dashboard.
 * Solo el admin (UID Ls1vtEv0rvY8DIyKKKmQY5SlOOQ2) puede escribir,
 * garantizado por las Firestore Security Rules.
 */
import { doc, updateDoc, setDoc, deleteDoc, deleteField, arrayUnion, Timestamp, getDoc as firestoreGetDoc, collection, addDoc, query, orderBy, getDocs, writeBatch, where, runTransaction } from 'firebase/firestore';
import { db } from '../firebase';
import { SERVICES, buildServiceConfig, getServiceMeta, normalizeServiceKey } from '../config/services';
import { encrypt } from '../utils/crypto';

// --- Helpers ---
function nowISO() {
  return new Date().toISOString();
}

function normalize(str) {
  return (str || '').trim().toLowerCase();
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

function findLedgerEntryIndex(entries, entryIdentifier) {
  return entries.findIndex((entry) => (
    entry.entryId === entryIdentifier
    || buildLegacyManualEntryIdentifier(entry) === entryIdentifier
  ));
}

function parseRecurringExpenseAmount(amount) {
  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error('Ingresa un monto válido mayor a cero');
  }

  return parsedAmount;
}

const SCHEDULED_ALERT_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

function isValidScheduledAlertDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return false;
  }

  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(`${dateString}T00:00:00Z`);

  return Number.isInteger(year)
    && Number.isInteger(month)
    && Number.isInteger(day)
    && date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

async function applyCreditCardBalanceAdjustment(transaction, cardId, amount, timestamp) {
  if (!cardId) return;

  const cardRef = doc(db, 'vault-cards', cardId);
  const cardSnap = await transaction.get(cardRef);
  if (!cardSnap.exists()) {
    throw new Error('No se encontró la tarjeta vinculada al cobro');
  }

  const card = cardSnap.data();
  if (card.accountType !== 'credit') return;
  if (!card.bankId) {
    throw new Error('La tarjeta de crédito no tiene una cuenta bancaria vinculada');
  }

  const bankRef = doc(db, 'banks', card.bankId);
  const bankSnap = await transaction.get(bankRef);
  if (!bankSnap.exists()) {
    throw new Error('No se encontró la cuenta bancaria vinculada a la tarjeta');
  }

  const bank = bankSnap.data();
  if (!bank.creditAccount) {
    throw new Error('La cuenta bancaria vinculada no tiene crédito configurado');
  }

  transaction.update(bankRef, {
    'creditAccount.currentBalance': Number(bank.creditAccount.currentBalance || 0) + amount,
    'creditAccount.updatedAt': timestamp,
    updatedAt: timestamp,
  });
}

function buildVaultEmailDocId(type, { email, lankAccountId }) {
  if (type === 'lank_google' && lankAccountId) {
    return `lank_google_${String(lankAccountId).trim()}`;
  }

  const localPart = normalize(email).split('@')[0];
  return `tertiary_${localPart || Date.now()}`;
}

function buildVaultPaypalDocId(lankAccountId, email) {
  const safeEmail = normalize(email)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `paypal_${String(lankAccountId).trim()}_${safeEmail || Date.now()}`;
}

export async function syncVaultEmailPassword(targetEmail, encryptedPassword, secretsSnapshot = null) {
  if (!targetEmail || !encryptedPassword) return;

  const normalEmail = normalize(targetEmail);
  const secrets = secretsSnapshot || await getDocs(collection(db, 'secrets'));
  const now = nowISO();
  const updates = [];

  secrets.docs.forEach((snap) => {
    const data = snap.data();
    const email = normalize(data.email);
    if (email !== normalEmail) return;

    if (data.type === 'lank_google') {
      if (data.googlePassword !== encryptedPassword) {
        updates.push(updateDoc(snap.ref, { googlePassword: encryptedPassword, updatedAt: now }));
      }
      return;
    }

    if (data.type === 'tertiary') {
      if (data.password !== encryptedPassword) {
        updates.push(updateDoc(snap.ref, { password: encryptedPassword, updatedAt: now }));
      }
      return;
    }

    if (data.googlePassword !== encryptedPassword) {
      updates.push(updateDoc(snap.ref, { googlePassword: encryptedPassword, updatedAt: now }));
    }
  });

  if (updates.length) {
    await Promise.all(updates);
  }
}

async function findVaultEmailByEmail(email, excludeId = null) {
  if (!email) return null;
  const normalized = normalize(email);
  const snap = await getDocs(collection(db, 'secrets'));

  for (const docSnap of snap.docs) {
    if (excludeId && docSnap.id === excludeId) continue;
    const data = docSnap.data();
    if ((data.type === 'lank_google' || data.type === 'tertiary') && normalize(data.email) === normalized) {
      return { id: docSnap.id, ...data };
    }
  }

  return null;
}

// --- Audit Log Manual ---

/**
 * Registra un cambio manual en la colección audit-log.
 * Se ejecuta de forma asíncrona (no bloquea la operación principal).
 * Auto-limpia entradas viejas si supera 100 registros.
 *
 * @param {string} action - Acción realizada (ej: 'add_user', 'remove_user')
 * @param {string} description - Descripción legible del cambio
 * @param {object} [opts] - { collection, documentId, field, before, after }
 */
export async function logManualChange(action, description, opts = {}) {
  try {
    const entry = {
      action,
      description,
      source: 'manual',
      actor: 'admin',
      timestamp: new Date().toISOString(),
      collection: opts.collection || null,
      documentId: opts.documentId || null,
      field: opts.field || null,
      before: opts.before !== undefined ? opts.before : null,
      after: opts.after !== undefined ? opts.after : null,
      aiInvolved: false,
    };
    // Filtrar nulls para no inflar el documento
    Object.keys(entry).forEach(k => entry[k] === null && delete entry[k]);

    const colRef = collection(db, 'audit-log');
    await addDoc(colRef, entry);

    // Auto-limpieza: si hay más de 100 entradas, eliminar las más viejas
    // Se hace ocasionalmente (1 de cada 10 llamadas) para no saturar
    if (Math.random() < 0.1) {
      const q = query(colRef, orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);
      if (snap.size > 200) {
        const toDelete = snap.docs.slice(200);
        const batch = writeBatch(db);
        toDelete.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  } catch (_) {
    // Silenciar errores de auditoría — no deben romper la operación principal
  }
}

// --- Historial por entidad ---

/**
 * Recorta un array de historial:
 * - Elimina entradas con más de `maxAgeDays` días de antigüedad
 * - Limita a `maxEntries` registros más recientes
 * @param {Array} history - Array de entradas con campo `timestamp`
 * @param {number} [maxEntries=10] - Máximo de entradas a conservar
 * @param {number} [maxAgeDays=30] - Máximo de días de antigüedad
 * @returns {Array} Array recortado
 */
function trimHistory(history, maxEntries = 10, maxAgeDays = 30) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const filtered = history.filter(e => {
    if (!e.timestamp) return true;
    return new Date(e.timestamp).getTime() > cutoff;
  });
  // Ordenar por timestamp desc y limitar
  filtered.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return filtered.slice(0, maxEntries);
}

/**
 * Agrega una entrada de historial al campo indicado de un documento Firestore.
 * Mantiene máximo 10 entradas y elimina las mayores a 30 días.
 * Se ejecuta de forma asíncrona (no bloquea la operación principal).
 *
 * @param {import('firebase/firestore').DocumentReference} docRef - Referencia al documento
 * @param {string} fieldName - Nombre del campo array (ej: 'slotHistory', 'userHistory')
 * @param {object} entry - Entrada de historial a agregar
 */
async function appendEntityHistory(docRef, fieldName, entry) {
  try {
    const { getDoc: getDocument } = await import('firebase/firestore');
    const snap = await getDocument(docRef);
    const data = snap.exists() ? snap.data() : {};
    const current = Array.isArray(data[fieldName]) ? data[fieldName] : [];
    const updated = trimHistory([{ ...entry, timestamp: nowISO() }, ...current]);
    await updateDoc(docRef, { [fieldName]: updated });
  } catch (_) {
    // Silenciar — el historial es secundario, no debe romper la operación
  }
}

// --- Alertas ---

/**
 * Marca una alerta como completada.
 * @param {string} alertId - ID del documento en la colección 'alerts'
 * @param {object} [extraData] - Campos adicionales a guardar (ej: assignedTo)
 */
export async function completeAlert(alertId, extraData = {}) {
  const ref = doc(db, 'alerts', alertId);
  const before = (await firestoreGetDoc(ref)).data();
  await updateDoc(ref, {
    status: 'completed',
    completedAt: nowISO(),
    ...extraData,
  });
  const title = before?.title || before?.alertType || alertId;
  const userAlias = before?.userAlias || '';
  const service = before?.service || '';
  const accountId = before?.accountId || '';
  const desc = `Alerta completada: ${title}${userAlias ? ` (${userAlias})` : ''}${service ? ` — ${service}` : ''}`;
  logManualChange('complete_alert', desc, {
    collection: 'alerts', documentId: alertId,
    before: { status: before?.status, title, type: before?.type, priority: before?.priority, userAlias, service, accountId },
    after: { status: 'completed' },
  });
}

/**
 * Descarta una alerta con razón.
 * @param {string} alertId - ID del documento
 * @param {string} reason - Razón del descarte
 */
export async function discardAlert(alertId, reason = '') {
  const ref = doc(db, 'alerts', alertId);
  const before = (await firestoreGetDoc(ref)).data();
  await updateDoc(ref, {
    status: 'discarded',
    discardedAt: nowISO(),
    discardReason: reason || 'Descartada manualmente',
  });
  const title = before?.title || before?.alertType || alertId;
  const userAlias = before?.userAlias || '';
  const service = before?.service || '';
  const accountId = before?.accountId || '';
  const desc = `Alerta descartada: ${title}${userAlias ? ` (${userAlias})` : ''}${service ? ` — ${service}` : ''}${reason ? ` — ${reason}` : ''}`;
  logManualChange('discard_alert', desc, {
    collection: 'alerts', documentId: alertId,
    before: { status: before?.status, title, type: before?.type, priority: before?.priority, userAlias, service, accountId, description: before?.description },
    after: { status: 'discarded', discardReason: reason || 'Descartada manualmente' },
  });
}

/**
 * Crea una alerta manual en la colección 'alerts'.
 * @param {object} alertData - Campos de la alerta
 * @returns {string} ID de la alerta creada
 */
export async function createManualAlert(alertData) {
  const alertId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ref = doc(db, 'alerts', alertId);
  await setDoc(ref, {
    source: 'manual',
    ...alertData,
    status: 'pending',
    createdAt: nowISO(),
  });
  logManualChange('create_alert', `Alerta creada manualmente: ${alertData.type || alertData.alertType || alertId}`, {
    collection: 'alerts', documentId: alertId,
    after: { ...alertData, status: 'pending' },
  });
  return alertId;
}

export async function createSlotDeletionAlert(alertData) {
  const userAlias = alertData.userAlias || 'usuario';
  const service = alertData.service || 'servicio';
  const serviceAccountRef = alertData.serviceAccountRef || 'cuenta real';
  const slotNumber = alertData.slotNumber || null;
  const reason = alertData.reason || `Dado de baja del grupo ${alertData.accountId || ''}`.trim();
  const slotText = slotNumber ? ` del cupo ${slotNumber}` : '';

  return createManualAlert({
    ...alertData,
    type: 'slot_pending_deletion',
    priority: alertData.priority || 'high',
    title: `Confirmar eliminacion de ${userAlias}`,
    description: `Confirmar que ${userAlias} fue eliminado${slotText} de ${serviceAccountRef} (${service}).`,
    reason,
    dependsOn: alertData.dependsOn ?? null,
  });
}

export async function createScheduledManualAlert({ title, note = '', scheduledDate, priority }) {
  const cleanTitle = (title || '').trim();
  const cleanNote = (note || '').trim();
  const cleanDate = (scheduledDate || '').trim();
  const cleanPriority = (priority || '').trim().toLowerCase();

  if (!cleanTitle) {
    throw new Error('Debes escribir un título');
  }
  if (!cleanPriority) {
    throw new Error('Debes elegir una prioridad');
  }
  if (!SCHEDULED_ALERT_PRIORITIES.has(cleanPriority)) {
    throw new Error('Debes elegir una prioridad válida');
  }
  if (!isValidScheduledAlertDate(cleanDate)) {
    throw new Error('Debes elegir una fecha futura válida');
  }

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (cleanDate <= todayKey) {
    throw new Error('Debes elegir una fecha futura válida');
  }

  const scheduledAlertId = `scheduled_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ref = doc(db, 'scheduled-alerts', scheduledAlertId);
  const payload = {
    title: cleanTitle,
    note: cleanNote,
    scheduledDate: cleanDate,
    priority: cleanPriority,
    status: 'scheduled',
    createdBy: 'manual_user',
    source: 'scheduled_manual_alert',
    generatedAlertId: null,
    createdAt: nowISO(),
    generatedAt: null,
    cancelledAt: null,
  };

  await setDoc(ref, payload);
  logManualChange('create_scheduled_alert', `Alerta programada creada: ${cleanTitle} (${cleanDate})`, {
    collection: 'scheduled-alerts',
    documentId: scheduledAlertId,
    after: {
      title: cleanTitle,
      scheduledDate: cleanDate,
      priority: cleanPriority,
      status: 'scheduled',
    },
  });

  return scheduledAlertId;
}

export async function cancelScheduledManualAlert(scheduledAlertId) {
  const ref = doc(db, 'scheduled-alerts', scheduledAlertId);
  const snapshot = await firestoreGetDoc(ref);
  if (!snapshot.exists()) {
    throw new Error('La alerta programada no existe');
  }

  const before = snapshot.data() || {};
  if (before.status !== 'scheduled') {
    throw new Error('Solo puedes cancelar alertas programadas pendientes');
  }

  const cancelledAt = nowISO();
  await updateDoc(ref, {
    status: 'cancelled',
    cancelledAt,
  });

  logManualChange('cancel_scheduled_alert', `Alerta programada cancelada: ${before.title || scheduledAlertId}`, {
    collection: 'scheduled-alerts',
    documentId: scheduledAlertId,
    before: {
      status: before.status,
      title: before.title,
      scheduledDate: before.scheduledDate,
    },
    after: {
      status: 'cancelled',
      cancelledAt,
    },
  });
}

// --- Edición de usuarios en grupo Lank ---

/**
 * Actualiza campos de un usuario dentro de un grupo Lank.
 * La estructura es: groups/{serviceKey}/lank-accounts/{accountId}
 * El documento tiene un array 'users' con objetos de usuario.
 * 
 * @param {string} serviceKey - ej: 'f1tv', 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {number} userIndex - Índice del usuario en el array
 * @param {object} updatedUser - Objeto usuario actualizado
 * @param {Array} currentUsers - Array completo de usuarios actual
 */
export async function updateGroupUser(serviceKey, accountId, userIndex, updatedUser, currentUsers) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const updatedUsers = [...currentUsers];
  const beforeUser = currentUsers[userIndex];
  updatedUsers[userIndex] = { ...updatedUsers[userIndex], ...updatedUser };
  await updateDoc(ref, { users: updatedUsers });
  const alias = beforeUser?.userAlias || `usuario-${userIndex}`;
  logManualChange('update_user', `Usuario editado: ${alias} en ${serviceKey} cuenta ${accountId}`, {
    collection: `groups/${serviceKey}/lank-accounts`, documentId: String(accountId),
    field: `users[${userIndex}]`, before: beforeUser, after: updatedUsers[userIndex],
  });
  // Historial por entidad
  appendEntityHistory(ref, 'userHistory', {
    action: 'updated',
    userAlias: alias,
    details: Object.keys(updatedUser).join(', '),
  });
}

/**
 * Elimina un usuario de un grupo Lank (baja manual).
 * Si el usuario tenia un slot en una cuenta real, genera una alerta para
 * confirmar eliminacion del slot. En servicios con contrasena compartida,
 * tambien genera una alerta de cambio de contrasena; access_verify se crea
 * despues de guardar la nueva contrasena en Boveda.
 * @param {string} serviceKey - ej: 'f1tv', 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {string} userAlias - Alias del usuario a eliminar
 * @param {Array} currentUsers - Array completo de usuarios actual
 * @param {string} [reason] - Razón de la baja
 */
export async function removeGroupUser(serviceKey, accountId, userAlias, currentUsers, reason = '') {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const filteredUsers = currentUsers.filter(
    u => normalize(typeof u === 'string' ? u : u.userAlias) !== normalize(userAlias)
  );
  const dateStr = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  const noteText = `${dateStr}: ${userAlias} salió del grupo (manual). ${reason}`.trim();

  await updateDoc(ref, {
    users: filteredUsers,
    hasUsers: filteredUsers.length > 0,
    // subscriptionActive NO se toca — un grupo puede estar activo sin usuarios
    notes: arrayUnion(noteText),
  });
  logManualChange('remove_user', `Usuario eliminado: ${userAlias} de ${serviceKey} cuenta ${accountId}${reason ? ` — ${reason}` : ''}`, {
    collection: `groups/${serviceKey}/lank-accounts`, documentId: String(accountId),
    before: { userAlias, usersCount: currentUsers.length }, after: { usersCount: filteredUsers.length },
  });
  // Historial por entidad
  const removedUser = currentUsers.find(u => normalize(typeof u === 'string' ? u : u.userAlias) === normalize(userAlias));
  appendEntityHistory(ref, 'userHistory', {
    action: 'left',
    userAlias,
    reason: reason || 'Baja manual',
    joinedAt: (typeof removedUser === 'object' ? removedUser?.addedAt : null) || null,
  });

  // --- Cancelar alertas pendientes de "dar acceso" si el usuario nunca tuvo acceso ---
  // También cancela alertas de renovación, teléfono faltante, etc. que ya no aplican
  const serviceMeta = getServiceMeta(serviceKey);
  const serviceName = serviceMeta.name || serviceKey;
  const acctIdStr = String(accountId);

  try {
    const alertsSnap = await getDocs(collection(db, 'alerts'));
    const batch = writeBatch(db);
    const cancelableTypes = [
      'user_needs_access',
      'missing_phone',
    ];
    let cancelledCount = 0;

    for (const alertDoc of alertsSnap.docs) {
      const a = alertDoc.data();
      if (a.status !== 'pending') continue;
      // Match por userAlias + accountId (evitar cancelar alertas de otro grupo)
      if (normalize(a.userAlias || '') !== normalize(userAlias)) continue;
      if (String(a.accountId || '') !== acctIdStr) continue;
      // Solo cancelar tipos que ya no aplican tras la baja
      const matchesType = cancelableTypes.some(t => a.type === t || (a.type || '').includes(t));
      if (!matchesType) continue;

      batch.update(alertDoc.ref, {
        status: 'cancelled_by_system',
        completedAt: nowISO(),
        resolution: `Usuario ${userAlias} dado de baja del grupo ${acctIdStr}. Alerta ya no aplica.`,
      });
      cancelledCount++;
    }

    if (cancelledCount > 0) {
      await batch.commit();
      logManualChange('alerts_auto_cancelled', `${cancelledCount} alerta(s) cancelada(s) automáticamente al dar de baja a ${userAlias} de ${serviceKey} grupo ${acctIdStr}`, {
        collection: 'alerts', documentId: acctIdStr,
        before: { cancelledCount }, after: { status: 'cancelled_by_system' },
      });
    }

  } catch (err) {
    // No bloquear la baja si falla la limpieza de alertas
    logManualChange('alert_cleanup_error', `Error limpiando alertas al dar de baja a ${userAlias}: ${err.message}`, {
      collection: `groups/${serviceKey}/lank-accounts`, documentId: acctIdStr,
    });
  }

  // --- Generar alertas de revocacion de acceso si aplica ---
  const accessType = serviceMeta.accessType || '';
  const isPasswordShared = accessType === 'credentials' || accessType === 'profile_project';

  if (serviceMeta.usesPool === false || serviceKey === 'microsoft365') return;

  // Buscar si el usuario tenía un slot activo en alguna cuenta real de este servicio
  try {
    const realAccountsSnap = await getDocs(collection(db, `service-pools/${serviceKey}/real-accounts`));
    const accountAlias = removedUser?.userAlias || userAlias;

    for (const realDoc of realAccountsSnap.docs) {
      const realData = realDoc.data();
      const slots = realData.slots || [];
      // Buscar slots asignados a este usuario desde este grupo Lank
      for (let idx = 0; idx < slots.length; idx++) {
        const slot = slots[idx];
        const slotMatchesGroup = String(slot.assignedFrom?.accountId) === acctIdStr;
        const slotMatchesUser = normalize(slot.memberAlias) === normalize(userAlias);

        if (slotMatchesGroup && slotMatchesUser && slot.status === 'active') {
          const acctLabel = realData.email
            ? `${realDoc.id} (${realData.email})`
            : realDoc.id;
          const slotNumber = slot.slotNumber || idx + 1;
          const alertReason = reason || `Dado de baja del grupo ${acctIdStr}`;

          const baseAlert = {
            service: serviceName,
            accountId: acctIdStr,
            accountAlias,
            userAlias,
            serviceAccountRef: realDoc.id,
            realAccountEmail: realData.email || null,
            realAccountExpires: realData.expires || null,
            slotNumber,
            reason: alertReason,
            source: 'user_removal',
          };

          await createSlotDeletionAlert(baseAlert);

          if (!isPasswordShared) continue;

          // Alerta de cambio de contraseña
          await createManualAlert({
            ...baseAlert,
            type: 'password_change',
            priority: 'high',
            title: `Cambiar contrasena - ${serviceName}`,
            description: `Cambiar contrasena de ${acctLabel}. El usuario ${userAlias} fue dado de baja del grupo ${acctIdStr} y tenia acceso.`,
          });
        }
      }
    }
  } catch (err) {
    // No bloquear la baja si falla la generación de alertas — loguear para debug
    logManualChange('alert_generation_error', `Error generando alertas de cambio de contraseña al dar de baja a ${userAlias}: ${err.message}`, {
      collection: `groups/${serviceKey}/lank-accounts`, documentId: acctIdStr,
    });
  }
}

// --- Edición de slots en cuentas reales ---

/**
 * Actualiza un slot en una cuenta real.
 * Estructura: service-pools/{serviceKey}/real-accounts/{accountRef}
 * El documento tiene un array 'slots'.
 * 
 * @param {string} serviceKey - ej: 'chatgpt', 'f1tv'
 * @param {string} accountRef - ej: 'chatgpt_1', 'f1tv_1'
 * @param {number} slotIndex - Índice del slot en el array
 * @param {object} updatedSlot - Objeto slot actualizado
 * @param {Array} currentSlots - Array completo de slots actual
 */
export async function updateSlot(serviceKey, accountRef, slotIndex, updatedSlot, currentSlots) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  const updatedSlots = [...currentSlots];
  const beforeSlot = currentSlots[slotIndex];
  updatedSlots[slotIndex] = { ...updatedSlots[slotIndex], ...updatedSlot };

  // Recalcular contadores
  const occupied = updatedSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;

  await updateDoc(ref, {
    slots: updatedSlots,
    occupiedSlots: occupied,
  });
  const slotLabel = `Cupo ${slotIndex + 1} en ${accountRef} (${serviceKey})`;
  const desc = updatedSlot.memberAlias
    ? `${slotLabel}: asignado a ${updatedSlot.memberAlias}`
    : `${slotLabel}: actualizado`;
  logManualChange('update_slot', desc, {
    collection: `service-pools/${serviceKey}/real-accounts`, documentId: accountRef,
    field: `slots[${slotIndex}]`, before: beforeSlot, after: updatedSlots[slotIndex],
  });
  // Historial por entidad
  const wasFree = !beforeSlot?.memberAlias || !beforeSlot.memberAlias.trim();
  const nowFree = !updatedSlot.memberAlias || !updatedSlot.memberAlias.trim();
  let action = 'updated';
  if (wasFree && !nowFree) action = 'assign';
  else if (!wasFree && nowFree) action = 'release';
  appendEntityHistory(ref, 'slotHistory', {
    action,
    slotNumber: slotIndex + 1,
    memberAlias: updatedSlot.memberAlias || beforeSlot?.memberAlias || '',
    previousUser: (!wasFree && action === 'assign') ? beforeSlot.memberAlias : null,
    lankAccountId: updatedSlot.assignedFrom?.accountId || beforeSlot?.assignedFrom?.accountId || null,
    projectName: updatedSlot.projectName || beforeSlot?.projectName || null,
  });
}

/**
 * Mueve un usuario de una cuenta real a otra.
 * 1) Libera el slot en la cuenta de origen
 * 2) Ocupa un slot libre en la cuenta de destino
 * 3) Actualiza serviceAccountRef del usuario en el grupo Lank
 * 
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {object} source - { accountRef, slotIndex, slot, allSlots }
 * @param {object} dest - { accountRef, freeSlotIndex, allSlots, accountLabel }
 * @param {object} [lankInfo] - { accountId, userAlias } para actualizar grupo Lank
 */
export async function moveUserBetweenAccounts(serviceKey, source, dest, lankInfo) {
  const { getDoc: getDocument } = await import('firebase/firestore');

  // 1. Copiar datos del usuario al slot destino
  const sourceSlot = source.slot;
  const destSlot = {
    ...dest.allSlots[dest.freeSlotIndex],
    status: 'active',
    memberAlias: sourceSlot.memberAlias || '',
    memberEmail: sourceSlot.memberEmail || '',
    profileName: sourceSlot.profileName || '',
    projectName: sourceSlot.projectName || '',
    assignedFrom: sourceSlot.assignedFrom || null,
    movedFrom: source.accountRef,
    movedAt: nowISO(),
  };

  // 2. Limpiar source slot
  const clearedSource = {
    slotNumber: sourceSlot.slotNumber || source.slotIndex + 1,
    status: 'free',
    memberAlias: '',
    memberEmail: '',
    profileName: '',
    projectName: '',
    assignedFrom: null,
  };

  // 3. Actualizar source
  const srcRef = doc(db, `service-pools/${serviceKey}/real-accounts/${source.accountRef}`);
  const srcSlots = [...source.allSlots];
  srcSlots[source.slotIndex] = clearedSource;
  const srcOccupied = srcSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;
  await updateDoc(srcRef, { slots: srcSlots, occupiedSlots: srcOccupied });

  // 4. Actualizar dest
  const dstRef = doc(db, `service-pools/${serviceKey}/real-accounts/${dest.accountRef}`);
  const dstSlots = [...dest.allSlots];
  dstSlots[dest.freeSlotIndex] = destSlot;
  const dstOccupied = dstSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;
  await updateDoc(dstRef, { slots: dstSlots, occupiedSlots: dstOccupied });

  // 5. Actualizar grupo Lank (serviceAccountRef del usuario)
  if (lankInfo && lankInfo.accountId && lankInfo.userAlias) {
    const groupRef = doc(db, `groups/${serviceKey}/lank-accounts/${lankInfo.accountId}`);
    const gSnap = await getDocument(groupRef);
    if (gSnap.exists()) {
      const users = gSnap.data().users || [];
      const updatedUsers = users.map(u => {
        if (typeof u !== 'object') return u;
        if (normalize(u.userAlias) === normalize(lankInfo.userAlias)) {
          return {
            ...u,
            serviceAccountRef: dest.accountRef,
            serviceLabel: dest.accountLabel || dest.accountRef,
          };
        }
        return u;
      });
      await updateDoc(groupRef, { users: updatedUsers });
    }
  }

  // Historial por entidad — origen (move_out)
  appendEntityHistory(srcRef, 'slotHistory', {
    action: 'move_out',
    slotNumber: source.slotIndex + 1,
    memberAlias: sourceSlot.memberAlias || '',
    destination: dest.accountRef,
    lankAccountId: lankInfo?.accountId || null,
  });
  // Historial por entidad — destino (move_in)
  appendEntityHistory(dstRef, 'slotHistory', {
    action: 'move_in',
    slotNumber: dest.freeSlotIndex + 1,
    memberAlias: sourceSlot.memberAlias || '',
    origin: source.accountRef,
    lankAccountId: lankInfo?.accountId || null,
  });
}

// --- Edición de cuenta Lank (datos generales) ---

/**
 * Actualiza campos de una cuenta Lank (documento principal).
 * Estructura: groups/{serviceKey}/lank-accounts/{accountId}
 * 
 * @param {string} serviceKey - ej: 'chatgpt', 'f1tv'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {object} fields - Campos a actualizar (ej: { cashback: true })
 */
export async function updateLankAccount(serviceKey, accountId, fields) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  await updateDoc(ref, fields);
}

export async function completeUnidentifiedAlert(alertId, serviceKey, accountId, userName, assignedTo, currentUsers) {
  const { getDoc: getDocument } = await import('firebase/firestore');

  // 1. Actualizar el array de usuarios en el grupo Lank
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const snap = await getDocument(ref);
  let updatedUsers = currentUsers;

  if (snap.exists()) {
    const liveUsers = snap.data().users || [];
    // Buscar el usuario "no informado" y actualizar su nombre
    const hasUnidentified = liveUsers.some(u => {
      const alias = typeof u === 'string' ? u : (u.userAlias || '');
      return normalize(alias) === normalize('usuario no informado') || normalize(alias) === normalize('?');
    });

    if (hasUnidentified) {
      updatedUsers = liveUsers.map(u => {
        const alias = typeof u === 'string' ? u : (u.userAlias || '');
        if (normalize(alias) === normalize('usuario no informado') || normalize(alias) === normalize('?')) {
          if (typeof u === 'string') return userName;
          return {
            ...u,
            userAlias: userName,
            ...(assignedTo ? { serviceAccountRef: assignedTo } : {}),
          };
        }
        return u;
      });
    } else {
      // El usuario no informado no existía; agregar el nuevo usuario al grupo
      updatedUsers = [...liveUsers, {
        userAlias: userName,
        serviceStatus: 'active',
        matchStatus: 'ok',
        ...(assignedTo ? { serviceAccountRef: assignedTo } : {}),
      }];
    }
    await updateDoc(ref, {
      users: updatedUsers,
      hasUsers: updatedUsers.length > 0,
    });
  }

  // 2. Si se asignó una cuenta real, ocupar un slot libre en ella
  if (assignedTo && serviceKey) {
    const realRef = doc(db, `service-pools/${serviceKey}/real-accounts/${assignedTo}`);
    const realSnap = await getDocument(realRef);
    if (realSnap.exists()) {
      const slots = realSnap.data().slots || [];
      const freeIdx = slots.findIndex(s => !s.memberAlias || s.memberAlias === '' || s.memberAlias === null || s.status === 'free');
      if (freeIdx !== -1) {
        const updatedSlots = [...slots];
        updatedSlots[freeIdx] = {
          ...updatedSlots[freeIdx],
          status: 'active',
          memberAlias: userName,
          assignedFrom: {
            accountId: typeof accountId === 'string' ? parseInt(accountId) : accountId,
            canonicalAlias: snap.exists() ? (snap.data().accountAlias || '') : '',
          },
          assignedAt: nowISO(),
        };
        const occupied = updatedSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;
        await updateDoc(realRef, {
          slots: updatedSlots,
          occupiedSlots: occupied,
        });
      }
    }
  }

  // 3. Marcar la alerta como completada
  if (alertId) {
    const alertRef = doc(db, 'alerts', alertId);
    await updateDoc(alertRef, {
      status: 'completed',
      completedAt: nowISO(),
      userAlias: userName,
      ...(assignedTo ? { assignedTo } : {}),
    });
  }
}

/**
 * Completa una alerta de teléfono faltante: guarda el número en el usuario del grupo Lank y marca la alerta como completada.
 *
 * @param {string} alertId - ID del documento de alerta
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {string} userAlias - Alias del usuario
 * @param {string} phone - Número de teléfono
 * @param {string} serviceKey - Clave del servicio (ej: 'chatgpt')
 */
export async function completeMissingPhone(alertId, accountId, userAlias, phone, serviceKey) {
  if (!phone || !phone.trim()) throw new Error('El número de teléfono es requerido');
  const cleanPhone = phone.trim();

  // Actualizar el usuario en el grupo Lank
  const groupRef = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const { getDoc: getDocument } = await import('firebase/firestore');
  const snap = await getDocument(groupRef);
  if (snap.exists()) {
    const users = snap.data().users || [];
    const updatedUsers = users.map(u => {
      if (typeof u === 'object' && normalize(u.userAlias) === normalize(userAlias)) {
        return { ...u, phone: cleanPhone };
      }
      return u;
    });
    await updateDoc(groupRef, { users: updatedUsers });
    logManualChange('update_user_phone', `Teléfono asignado a ${userAlias} en ${serviceKey} cuenta ${accountId}: ${cleanPhone}`, {
      collection: `groups/${serviceKey}/lank-accounts`, documentId: String(accountId),
      field: 'users.phone', before: { phone: '' }, after: { phone: cleanPhone },
    });
  }

  // Completar la alerta
  const alertRef = doc(db, 'alerts', alertId);
  await updateDoc(alertRef, {
    status: 'completed',
    completedAt: nowISO(),
    phone: cleanPhone,
  });
}

// --- CRUD de Cuentas Reales (Bóveda) ---

/**
 * Crea una cuenta real en service-pools/{svc}/real-accounts/{ref}
 * y opcionalmente un doc en secrets/{ref} con credenciales cifradas.
 */
export async function createRealAccount(serviceKey, accountRef, accountData, secretData = null) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  await setDoc(ref, {
    ...accountData,
    serviceAccountRef: accountRef,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  if (secretData) {
    const secretRef = doc(db, 'secrets', accountRef);
    await setDoc(secretRef, {
      ...secretData,
      passwordHistory: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  }
}

/**
 * Crea una cuenta real vinculada a una cuenta de correo de la bóveda.
 * Si vaultEmailId se proporciona, se copia la contraseña del correo como googlePassword
 * y se guarda el campo vaultEmailRef para mantener la sincronización.
 * Si se proporciona newEmailData, se crea primero la cuenta de correo secundaria
 * y luego se vincula a la cuenta real.
 */
export async function createLinkedRealAccount(serviceKey, accountRef, accountData, secretData, options = {}) {
  const { vaultEmailId, newEmailData } = options;
  let linkedEmailId = vaultEmailId || null;

  // Si se necesita crear una nueva cuenta de correo primero
  if (newEmailData && !vaultEmailId) {
    linkedEmailId = await createVaultEmailAccount({
      type: 'tertiary',
      email: newEmailData.email,
      password: newEmailData.emailPassword,
      notes: newEmailData.notes || '',
    });
  }

  // Agregar vaultEmailRef al secret si hay vinculación
  const enrichedSecretData = { ...secretData };
  if (linkedEmailId) {
    enrichedSecretData.vaultEmailRef = linkedEmailId;
  }

  await createRealAccount(serviceKey, accountRef, accountData, enrichedSecretData);

  logManualChange('create_linked_real_account', `Cuenta real vinculada creada: ${accountRef} → ${linkedEmailId || 'sin vínculo'}`, {
    collection: `service-pools/${serviceKey}/real-accounts`,
    documentId: accountRef,
    after: {
      serviceKey,
      accountRef,
      email: accountData.email || '',
      vaultEmailRef: linkedEmailId || null,
    },
  });

  return { accountRef, vaultEmailRef: linkedEmailId };
}

/**
 * Actualiza campos de una cuenta real y opcionalmente su secret.
 */
export async function updateRealAccount(serviceKey, accountRef, accountData, secretData = null) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  await updateDoc(ref, { ...accountData, updatedAt: nowISO() });
  if (secretData) {
    const secretRef = doc(db, 'secrets', accountRef);
    const { getDoc: getDocument } = await import('firebase/firestore');
    const snap = await getDocument(secretRef);
    if (snap.exists()) {
      await updateDoc(secretRef, { ...secretData, updatedAt: nowISO() });
    } else {
      await setDoc(secretRef, { ...secretData, passwordHistory: [], createdAt: nowISO(), updatedAt: nowISO() });
    }
  }
}

/**
 * Elimina una cuenta real y su secret asociado.
 */
export async function deleteRealAccount(serviceKey, accountRef) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  await deleteDoc(ref);
  // Intentar eliminar el secret asociado
  try {
    const secretRef = doc(db, 'secrets', accountRef);
    await deleteDoc(secretRef);
  } catch (_err) {
    /* secret may not exist */
  }
}

// --- CRUD de Tarjetas (Bóveda) ---

/**
 * Crea o actualiza una tarjeta en vault-cards/{id}.
 */
export async function createVaultCard(cardId, cardData) {
  const ref = doc(db, 'vault-cards', cardId);
  await setDoc(ref, {
    ...cardData,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
}

// --- CRUD de Cuentas de Correo (Bóveda) ---

export async function createVaultEmailAccount(accountData) {
  const now = nowISO();
  const type = accountData.type === 'lank_google' ? 'lank_google' : 'tertiary';
  const email = normalize(accountData.email);
  const existing = await findVaultEmailByEmail(email);
  if (existing) {
    throw new Error('Ya existe una cuenta con ese email');
  }

  const docId = buildVaultEmailDocId(type, accountData);
  const ref = doc(db, 'secrets', docId);
  const existingDoc = await firestoreGetDoc(ref);
  if (existingDoc.exists()) {
    throw new Error(type === 'lank_google'
      ? 'Ya existe una cuenta principal para esa cuenta Lank'
      : 'Ya existe una cuenta con ese identificador');
  }

  const passwordValue = accountData.password ? encrypt(accountData.password) : '';
  const payload = {
    email,
    notes: accountData.notes || '',
    type,
    passwordHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  if (type === 'lank_google') {
    payload.lankAccountId = String(accountData.lankAccountId || '');
    payload.fullName = accountData.fullName || '';
    payload.canonicalAlias = accountData.canonicalAlias || '';
    payload.googlePassword = passwordValue;
  } else {
    payload.password = passwordValue;
  }

  await setDoc(ref, payload);
  if (passwordValue) {
    await syncVaultEmailPassword(email, passwordValue);
  }

  // Sync to accounts collection for lank_google
  if (type === 'lank_google' && payload.lankAccountId) {
    try {
      const acctRef = doc(db, 'accounts', payload.lankAccountId);
      const acctSnap = await firestoreGetDoc(acctRef);
      const acctPayload = {
        lankGmailAddress: email,
        updatedAt: now,
      };
      if (payload.fullName) acctPayload.fullName = payload.fullName;
      if (payload.canonicalAlias) acctPayload.canonicalAlias = payload.canonicalAlias;
      if (acctSnap.exists()) {
        await updateDoc(acctRef, acctPayload);
      } else {
        acctPayload.id = parseInt(payload.lankAccountId, 10) || payload.lankAccountId;
        acctPayload.notes = [];
        acctPayload.whatsapp = '';
        acctPayload.createdAt = now;
        await setDoc(acctRef, acctPayload);
      }
    } catch (syncErr) {
      // Log but don't fail the vault creation
      console.error('Error syncing to accounts collection:', syncErr);
    }
  }

  logManualChange('create_vault_email_account', `Cuenta de correo creada: ${email}`, {
    collection: 'secrets',
    documentId: docId,
    after: {
      type,
      email,
      lankAccountId: payload.lankAccountId || null,
      canonicalAlias: payload.canonicalAlias || null,
      notes: payload.notes || '',
    },
  });

  return docId;
}

export async function deleteVaultEmailAccount(accountId) {
  const ref = doc(db, 'secrets', accountId);
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) {
    throw new Error('La cuenta de correo no existe');
  }
  const data = snap.data();

  if (data.type === 'lank_google' && data.lankAccountId) {
    await assertNoLinkedPaypalAccounts(data.lankAccountId);
  }

  await deleteDoc(ref);

  // Cascade: delete linked Lank account + SIM for lank_google
  if (data.type === 'lank_google' && data.lankAccountId) {
    const acctId = String(data.lankAccountId);
    try {
      const acctRef = doc(db, 'accounts', acctId);
      const acctSnap = await firestoreGetDoc(acctRef);
      if (acctSnap.exists()) await deleteDoc(acctRef);
    } catch (_) {
      /* linked Lank account may already be absent */
    }

    try {
      const numId = parseInt(acctId, 10) || acctId;
      const simSnap = await firestoreGetDoc(doc(db, 'config', 'sim-cards'));
      if (simSnap.exists()) {
        const currentSims = simSnap.data().sims || [];
        const filtered = currentSims.filter(s => s.lankAccountId !== numId);
        if (filtered.length !== currentSims.length) {
          await saveSimCardConfig({ sims: filtered });
        }
      }
    } catch (_) {
      /* linked SIM entry cleanup is best effort */
    }
  }

  logManualChange('delete_vault_email_account', `Cuenta de correo eliminada: ${data.email || accountId}`, {
    collection: 'secrets', documentId: accountId,
    before: { type: data.type, email: data.email, lankAccountId: data.lankAccountId || null },
  });
}

export async function updateVaultEmailAccount(accountId, updates, options = {}) {
  const ref = doc(db, 'secrets', accountId);
  const existingSnap = await firestoreGetDoc(ref);
  if (!existingSnap.exists()) {
    throw new Error('La cuenta de correo no existe');
  }

  const existing = existingSnap.data();
  const email = normalize(updates.email ?? existing.email);
  const duplicate = await findVaultEmailByEmail(email, accountId);
  if (duplicate) {
    throw new Error('Ya existe una cuenta con ese email');
  }

  const now = nowISO();
  const payload = {
    email,
    notes: updates.notes ?? existing.notes ?? '',
    updatedAt: now,
  };

  if (existing.type === 'lank_google') {
    payload.fullName = updates.fullName ?? existing.fullName ?? '';
    payload.canonicalAlias = updates.canonicalAlias ?? existing.canonicalAlias ?? '';
    payload.lankAccountId = String(updates.lankAccountId ?? existing.lankAccountId ?? '');
  }

  let encryptedPassword = null;
  if (typeof updates.password === 'string') {
    encryptedPassword = updates.password ? encrypt(updates.password) : '';
    if (existing.type === 'lank_google') {
      payload.googlePassword = encryptedPassword;
    } else {
      payload.password = encryptedPassword;
    }
  }

  await updateDoc(ref, payload);

  if (encryptedPassword) {
    await syncVaultEmailPassword(email, encryptedPassword, options.secretsSnapshot || null);
  }

  // Sync to accounts collection for lank_google
  if (existing.type === 'lank_google') {
    const acctId = payload.lankAccountId || existing.lankAccountId;
    if (acctId) {
      try {
        const acctRef = doc(db, 'accounts', String(acctId));
        const acctPayload = { updatedAt: nowISO() };
        if (email) acctPayload.lankGmailAddress = email;
        if (payload.fullName !== undefined) acctPayload.fullName = payload.fullName;
        if (payload.canonicalAlias !== undefined) acctPayload.canonicalAlias = payload.canonicalAlias;
        if (updates.whatsapp !== undefined) acctPayload.whatsapp = updates.whatsapp;
        await updateDoc(acctRef, acctPayload);
      } catch (syncErr) {
        console.error('Error syncing vault update to accounts:', syncErr);
      }

      // Sync to SIM cards for phone/name changes
      try {
        const simSnap = await firestoreGetDoc(doc(db, 'config', 'sim-cards'));
        if (simSnap.exists()) {
          const currentSims = simSnap.data().sims || [];
          const numId = parseInt(acctId, 10) || acctId;
          let changed = false;
          const updatedSims = currentSims.map(s => {
            if (s.lankAccountId === numId) {
              const updated = { ...s };
              if (updates.whatsapp !== undefined) { updated.phone = updates.whatsapp; changed = true; }
              if (payload.fullName !== undefined) { updated.fullName = payload.fullName; changed = true; }
              if (payload.canonicalAlias !== undefined) { updated.canonicalAlias = payload.canonicalAlias; changed = true; }
              return updated;
            }
            return s;
          });
          if (changed) await saveSimCardConfig({ sims: updatedSims });
        }
      } catch (_) {
        // SIM sync is best-effort
      }
    }
  }

  logManualChange('update_vault_email_account', `Cuenta de correo actualizada: ${email}`, {
    collection: 'secrets',
    documentId: accountId,
    before: {
      email: existing.email || '',
      notes: existing.notes || '',
      type: existing.type || '',
      lankAccountId: existing.lankAccountId || null,
    },
    after: {
      email,
      notes: payload.notes || '',
      type: existing.type || '',
      lankAccountId: payload.lankAccountId || existing.lankAccountId || null,
    },
  });
}

// --- CRUD de cuentas PayPal vinculadas a cuentas principales ---

async function getLinkedPrincipalForPaypal(lankAccountId) {
  const normalizedId = String(lankAccountId || '').trim();
  if (!normalizedId) {
    throw new Error('Selecciona una cuenta principal para vincular PayPal');
  }

  const principalRef = doc(db, 'secrets', `lank_google_${normalizedId}`);
  const principalSnap = await firestoreGetDoc(principalRef);
  if (!principalSnap.exists() || principalSnap.data()?.type !== 'lank_google') {
    throw new Error('La cuenta principal vinculada no existe');
  }

  return { id: normalizedId, data: principalSnap.data() };
}

async function getLinkedPaypalAccounts(lankAccountId) {
  const normalizedId = String(lankAccountId || '').trim();
  if (!normalizedId) return [];

  const snap = await getDocs(query(
    collection(db, 'secrets'),
    where('type', '==', 'paypal'),
    where('lankAccountId', '==', normalizedId),
  ));

  return snap.docs
    .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
    .filter(account => account.type === 'paypal' && String(account.lankAccountId || '').trim() === normalizedId);
}

async function assertNoLinkedPaypalAccounts(lankAccountId) {
  const linkedPaypal = await getLinkedPaypalAccounts(lankAccountId);
  if (linkedPaypal.length === 0) return;

  const emails = linkedPaypal
    .map(account => account.email || account.id)
    .filter(Boolean)
    .join(', ');

  throw new Error(`No puedes eliminar esta cuenta principal porque tiene PayPal vinculado: ${emails}`);
}

export async function createVaultPaypalAccount(accountData) {
  const now = nowISO();
  const email = normalize(accountData.email);
  if (!email) {
    throw new Error('El email de PayPal es obligatorio');
  }

  const principal = await getLinkedPrincipalForPaypal(accountData.lankAccountId);
  const docId = buildVaultPaypalDocId(principal.id, email);
  const ref = doc(db, 'secrets', docId);
  const existingDoc = await firestoreGetDoc(ref);
  if (existingDoc.exists()) {
    throw new Error('Ya existe una cuenta PayPal con ese email para esta cuenta principal');
  }

  const payload = {
    type: 'paypal',
    email,
    password: accountData.password ? encrypt(accountData.password) : '',
    notes: accountData.notes || '',
    lankAccountId: principal.id,
    principalEmail: principal.data.email || '',
    principalAlias: principal.data.canonicalAlias || principal.data.fullName || '',
    createdAt: now,
    updatedAt: now,
  };

  await setDoc(ref, payload);

  logManualChange('create_vault_paypal_account', `Cuenta PayPal creada: ${email}`, {
    collection: 'secrets',
    documentId: docId,
    after: {
      type: 'paypal',
      email,
      lankAccountId: principal.id,
      principalEmail: payload.principalEmail,
      principalAlias: payload.principalAlias,
      notes: payload.notes,
    },
  });

  return docId;
}

export async function updateVaultPaypalAccount(accountId, updates) {
  const ref = doc(db, 'secrets', accountId);
  const existingSnap = await firestoreGetDoc(ref);
  if (!existingSnap.exists() || existingSnap.data()?.type !== 'paypal') {
    throw new Error('La cuenta PayPal no existe');
  }

  const existing = existingSnap.data();
  const email = normalize(updates.email ?? existing.email);
  if (!email) {
    throw new Error('El email de PayPal es obligatorio');
  }

  const principal = await getLinkedPrincipalForPaypal(updates.lankAccountId ?? existing.lankAccountId);
  const payload = {
    email,
    notes: updates.notes ?? existing.notes ?? '',
    lankAccountId: principal.id,
    principalEmail: principal.data.email || '',
    principalAlias: principal.data.canonicalAlias || principal.data.fullName || '',
    updatedAt: nowISO(),
  };

  if (typeof updates.password === 'string') {
    payload.password = updates.password ? encrypt(updates.password) : '';
  }

  await updateDoc(ref, payload);

  logManualChange('update_vault_paypal_account', `Cuenta PayPal actualizada: ${email}`, {
    collection: 'secrets',
    documentId: accountId,
    before: {
      email: existing.email || '',
      lankAccountId: existing.lankAccountId || null,
      notes: existing.notes || '',
    },
    after: {
      email,
      lankAccountId: principal.id,
      notes: payload.notes,
    },
  });
}

export async function deleteVaultPaypalAccount(accountId) {
  const ref = doc(db, 'secrets', accountId);
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists() || snap.data()?.type !== 'paypal') {
    throw new Error('La cuenta PayPal no existe');
  }

  const data = snap.data();

  await deleteDoc(ref);

  logManualChange('delete_vault_paypal_account', `Cuenta PayPal eliminada: ${data.email || accountId}`, {
    collection: 'secrets',
    documentId: accountId,
    before: {
      type: 'paypal',
      email: data.email || '',
      lankAccountId: data.lankAccountId || null,
    },
  });
}

/**
 * Actualiza una cuenta Lank en accounts/{accountId}.
 * Sincroniza los campos de identidad con el secret lank_google correspondiente.
 */
export async function updateLankMasterAccount(accountId, fields) {
  const now = nowISO();
  const ref = doc(db, 'accounts', String(accountId));
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) {
    throw new Error(`La cuenta Lank #${accountId} no existe`);
  }

  const before = snap.data();
  const payload = { updatedAt: now };
  if (fields.canonicalAlias !== undefined) payload.canonicalAlias = fields.canonicalAlias;
  if (fields.fullName !== undefined) payload.fullName = fields.fullName;
  if (fields.lankGmailAddress !== undefined) payload.lankGmailAddress = fields.lankGmailAddress;
  if (fields.whatsapp !== undefined) payload.whatsapp = fields.whatsapp;

  await updateDoc(ref, payload);

  // Sync identity changes to the linked lank_google secret
  const secretDocId = `lank_google_${String(accountId).trim()}`;
  const secretRef = doc(db, 'secrets', secretDocId);
  const secretSnap = await firestoreGetDoc(secretRef);
  if (secretSnap.exists()) {
    const secretPayload = { updatedAt: now };
    if (fields.canonicalAlias !== undefined) secretPayload.canonicalAlias = fields.canonicalAlias;
    if (fields.fullName !== undefined) secretPayload.fullName = fields.fullName;
    if (fields.lankGmailAddress !== undefined) secretPayload.email = normalize(fields.lankGmailAddress);
    await updateDoc(secretRef, secretPayload);
  }

  logManualChange('update_lank_master_account', `Cuenta Lank #${accountId} actualizada`, {
    collection: 'accounts', documentId: String(accountId),
    before: { canonicalAlias: before.canonicalAlias, fullName: before.fullName, lankGmailAddress: before.lankGmailAddress, whatsapp: before.whatsapp },
    after: { ...payload },
  });

  // Sync identity/phone changes to the linked SIM card entry
  const simFields = {};
  if (fields.canonicalAlias !== undefined) simFields.canonicalAlias = fields.canonicalAlias;
  if (fields.fullName !== undefined) simFields.fullName = fields.fullName;
  if (fields.whatsapp !== undefined) simFields.phone = fields.whatsapp;
  if (Object.keys(simFields).length > 0) {
    try {
      const simSnap = await firestoreGetDoc(doc(db, 'config', 'sim-cards'));
      if (simSnap.exists()) {
        const currentSims = simSnap.data().sims || [];
        const numId = typeof accountId === 'string' ? parseInt(accountId, 10) : accountId;
        const updatedSims = currentSims.map(sim =>
          sim.lankAccountId === numId ? { ...sim, ...simFields } : sim
        );
        await saveSimCardConfig({ sims: updatedSims });
      }
    } catch (_) {
      // SIM sync is best-effort
    }
  }
}

/**
 * Crea una nueva cuenta Lank en accounts/{id}.
 * Retorna el ID numérico asignado.
 */
export async function createLankMasterAccount(accountData) {
  const now = nowISO();

  // Find the next available ID by scanning existing accounts
  const accountsSnap = await getDocs(collection(db, 'accounts'));
  let maxId = 0;
  accountsSnap.forEach(docSnap => {
    const data = docSnap.data();
    const num = parseInt(data.id ?? docSnap.id, 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  });
  const newId = maxId + 1;

  const ref = doc(db, 'accounts', String(newId));
  const payload = {
    id: newId,
    canonicalAlias: accountData.canonicalAlias || '',
    fullName: accountData.fullName || '',
    lankGmailAddress: accountData.lankGmailAddress || '',
    whatsapp: accountData.whatsapp || '',
    notes: accountData.notes || [],
    createdAt: now,
    updatedAt: now,
  };

  await setDoc(ref, payload);

  // Auto-add SIM card entry for the new account
  try {
    const simSnap = await firestoreGetDoc(doc(db, 'config', 'sim-cards'));
    const currentSims = simSnap.exists() ? (simSnap.data().sims || []) : [];
    const newSim = {
      lankAccountId: newId,
      phone: accountData.whatsapp || '',
      fullName: accountData.fullName || '',
      canonicalAlias: accountData.canonicalAlias || accountData.fullName || '',
      lastRechargeDate: null,
      nextRechargeDate: null,
    };
    await saveSimCardConfig({ sims: [...currentSims, newSim] });
  } catch (_) {
    // SIM auto-add is best-effort; account creation already succeeded
  }

  // Auto-create linked lank_google vault email entry
  if (payload.lankGmailAddress) {
    try {
      await createVaultEmailAccount({
        type: 'lank_google',
        lankAccountId: String(newId),
        email: payload.lankGmailAddress,
        fullName: payload.fullName,
        canonicalAlias: payload.canonicalAlias,
        password: accountData.googlePassword || '',
        notes: '',
      });
    } catch (_) {
      // Best-effort: vault entry may already exist for this email
    }
  }

  logManualChange('create_lank_master_account', `Cuenta Lank #${newId} creada: ${payload.canonicalAlias}`, {
    collection: 'accounts', documentId: String(newId),
    after: payload,
  });

  return newId;
}

/**
 * Elimina una tarjeta de vault-cards/{id}.
 */
export async function deleteVaultCard(cardId) {
  const ref = doc(db, 'vault-cards', cardId);
  await deleteDoc(ref);
}

// --- CRUD de Grupos Lank ---

/**
 * Agrega un usuario a un grupo Lank existente.
 * @param {string} serviceKey - ej: 'chatgpt', 'f1tv'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {object} newUser - Datos del nuevo usuario { userAlias, ... }
 * @param {Array} currentUsers - Array actual de usuarios
 */
export async function addGroupUser(serviceKey, accountId, newUser, currentUsers) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const updatedUsers = [...currentUsers, {
    ...newUser,
    serviceStatus: 'active',
    // matchStatus NO se establece aquí — lo escribe el sistema de análisis de correos
    addedAt: nowISO(),
  }];
  const dateStr = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  const noteText = `${dateStr}: ${newUser.userAlias} agregado al grupo (manual).`;

  await updateDoc(ref, {
    users: updatedUsers,
    hasUsers: true,
    notes: arrayUnion(noteText),
  });
  logManualChange('add_user', `Usuario agregado: ${newUser.userAlias} en ${serviceKey} cuenta ${accountId}`, {
    collection: `groups/${serviceKey}/lank-accounts`, documentId: String(accountId),
    after: { userAlias: newUser.userAlias, serviceAccountRef: newUser.serviceAccountRef || null },
  });
  // Historial por entidad
  appendEntityHistory(ref, 'userHistory', {
    action: 'joined',
    userAlias: newUser.userAlias,
    serviceAccountRef: newUser.serviceAccountRef || null,
    projectName: newUser.projectName || null,
  });
}

/**
 * Crea un grupo nuevo para una cuenta Lank en un servicio.
 * Estructura: groups/{serviceKey}/lank-accounts/{accountId}
 * @param {string} serviceKey - ej: 'f1tv', 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {object} accountData - { accountAlias, fullName, accountId }
 */
export async function createLankGroup(serviceKey, accountId, accountData) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  await setDoc(ref, {
    accountId: typeof accountId === 'string' ? parseInt(accountId) : accountId,
    accountAlias: accountData.accountAlias || '',
    fullName: accountData.fullName || '',
    groupStatus: 'active',
    subscriptionActive: true,
    cashback: accountData.cashback || false,
    hasUsers: false,
    users: [],
    notes: [`${new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}: Grupo creado manualmente.`],
    createdAt: nowISO(),
  });
  logManualChange('create_lank_group', `Grupo Lank creado: ${accountData.accountAlias || accountId} en ${serviceKey}`, {
    collection: `groups/${serviceKey}/lank-accounts`, documentId: String(accountId),
    after: { accountAlias: accountData.accountAlias, fullName: accountData.fullName },
  });
}

/**
 * Actualiza el estado de un grupo Lank (activar/desactivar, notas).
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {object} fields - { groupStatus, subscriptionActive, notes, ... }
 */
export async function updateLankGroupStatus(serviceKey, accountId, fields) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  await updateDoc(ref, { ...fields, updatedAt: nowISO() });
}

/**
 * Elimina un grupo Lank completo.
 * Antes de eliminar, libera los slots de cuentas reales asignados a este grupo
 * y crea alertas para revocar acceso (cambio de contraseña, eliminar perfil, etc.).
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 */
export async function deleteLankGroup(serviceKey, accountId) {
  const groupRef = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const before = (await firestoreGetDoc(groupRef)).data();
  const accountAlias = before?.accountAlias || String(accountId);
  const serviceMeta = getServiceMeta(serviceKey);
  const serviceName = serviceMeta.name || serviceKey;
  const acctIdStr = String(accountId);

  // --- 1. Buscar y liberar slots en cuentas reales asignados a este grupo ---
  const realAccountsRef = collection(db, `service-pools/${serviceKey}/real-accounts`);
  const realAccountsSnap = await getDocs(realAccountsRef);
  const batch = writeBatch(db);
  const freedSlots = []; // { accountRef, email, expires, slotIndex, memberAlias, otherUsers }

  for (const realDoc of realAccountsSnap.docs) {
    const realData = realDoc.data();
    const slots = realData.slots || [];
    let modified = false;
    const newSlots = slots.map((slot, idx) => {
      if (slot.assignedFrom?.accountId == acctIdStr && slot.status === 'active') {
        // Otros usuarios activos en esta misma cuenta real (para alerta access_verify)
        const otherUsers = slots
          .filter((s, i) => i !== idx && s.memberAlias && s.status === 'active')
          .map(s => s.memberAlias);

        freedSlots.push({
          accountRef: realDoc.id,
          email: realData.email || null,
          expires: realData.expires || null,
          slotIndex: idx,
          slotNumber: slot.slotNumber || idx + 1,
          memberAlias: slot.memberAlias || '?',
          otherUsers,
        });

        modified = true;
        return {
          ...slot,
          status: 'free',
          memberAlias: '',
          memberEmail: '',
          profileName: '',
          projectName: '',
          assignedFrom: null,
        };
      }
      return slot;
    });

    if (modified) {
      const occupied = newSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;
      const docRef = doc(db, `service-pools/${serviceKey}/real-accounts/${realDoc.id}`);
      batch.update(docRef, { slots: newSlots, occupiedSlots: occupied });
    }
  }

  if (freedSlots.length > 0) {
    await batch.commit();
  }

  // --- 2. Crear alertas de revocación de acceso por cada slot liberado ---
  const accessType = serviceMeta.accessType || '';
  const isPasswordShared = accessType === 'credentials' || accessType === 'profile_project';
  const isInvitationBased = accessType === 'email_invitation';

  for (const freed of freedSlots) {
    const acctLabel = freed.email
      ? `${freed.accountRef} (${freed.email})`
      : freed.accountRef;

    const baseAlert = {
      service: serviceName,
      accountId: acctIdStr,
      accountAlias,
      userAlias: freed.memberAlias,
      serviceAccountRef: freed.accountRef,
      realAccountEmail: freed.email,
      realAccountExpires: freed.expires,
      slotNumber: freed.slotNumber,
      reason: `Grupo ${accountAlias} eliminado`,
      source: 'group_deletion',
    };

    if (isPasswordShared) {
      await createManualAlert({
        ...baseAlert,
        type: 'profile_delete',
        priority: 'high',
        title: `Eliminar perfil de ${freed.memberAlias}`,
        description: `${freed.memberAlias} pertenecia al grupo ${accountAlias} de ${serviceName} que fue eliminado. Eliminar su perfil/proyecto de ${acctLabel}.`,
      });

      await createManualAlert({
        ...baseAlert,
        type: 'password_change',
        priority: 'high',
        title: `Cambiar contrasena - ${serviceName}`,
        description: `Cambiar contrasena de ${acctLabel}. El usuario ${freed.memberAlias} tenia acceso (grupo ${accountAlias} eliminado).`,
        dependsOn: 'profile_delete',
      });
    } else if (isInvitationBased) {
      await createManualAlert({
        ...baseAlert,
        type: 'revoke_invitation',
        priority: 'high',
        title: `Revocar acceso de ${freed.memberAlias}`,
        description: `${freed.memberAlias} pertenecia al grupo ${accountAlias} de ${serviceName} que fue eliminado. Eliminar su correo/invitacion de ${acctLabel}.`,
      });
    }
  }

  // --- 3. Eliminar el documento del grupo ---
  await deleteDoc(groupRef);

  logManualChange('delete_lank_group', `Grupo Lank eliminado: ${accountAlias} en ${serviceKey}`, {
    collection: `groups/${serviceKey}/lank-accounts`, documentId: acctIdStr,
    before: { accountAlias: before?.accountAlias, usersCount: before?.users?.length ?? 0 },
    after: { freedSlots: freedSlots.length, alertsCreated: freedSlots.length > 0 },
  });
}

// --- Configuración Maestra de Suscripciones ---

/**
 * Lee la configuración de servicios desde Firestore.
 * Documento: config/services
 * @returns {object|null} - Mapa de servicios o null si no existe
 */
export async function getServicesConfig() {
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data();
  return data.services || null;
}

/**
 * Lee la configuración maestra de suscripciones.
 * DEPRECATED: Ahora se lee desde config/services. Esta función mantiene compatibilidad.
 * @returns {object|null}
 */
export async function getSubscriptionMasterConfig() {
  // Intentar leer de config/services primero
  const servicesConfig = await getServicesConfig();
  if (servicesConfig) {
    // Convertir a formato master config
    const result = {};
    for (const [key, svc] of Object.entries(servicesConfig)) {
      result[key] = {
        maxSlotsPerRealAccount: svc.maxSlotsPerRealAccount || svc.maxSlots || 5,
        maxSlotsPerLankGroup: svc.maxSlotsPerLankGroup || svc.maxSlots || 5,
        accessType: svc.accessType || 'email_invitation',
        accessTypeLabel: svc.accessTypeLabel || svc.accessType || '',
      };
    }
    return result;
  }
  // Fallback al documento legacy
  const ref = doc(db, 'config', 'subscription-master');
  const snap = await firestoreGetDoc(ref);
  return snap.exists() ? snap.data() : null;
}

/**
 * Genera DEFAULT_MASTER_CONFIG dinámicamente desde SERVICES (seed).
 * Se mantiene como export para compatibilidad con componentes que lo importan.
 */
export const DEFAULT_MASTER_CONFIG = Object.fromEntries(
  Object.entries(SERVICES).map(([key, svc]) => [key, {
    maxSlotsPerRealAccount: svc.maxSlots || 5,
    maxSlotsPerLankGroup: svc.maxSlots || 5,
    accessType: svc.accessType || 'email_invitation',
    accessTypeLabel: svc.accessType === 'credentials' ? 'Credenciales compartidas'
      : svc.accessType === 'profile_project' ? 'Perfil compartido'
      : 'Invitación por correo',
  }])
);

/**
 * Inicializa config/services si no existe en Firestore.
 * Migra desde config/subscription-master si existe.
 * @returns {object} - Configuración de servicios
 */
export async function initServicesConfig() {
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  if (snap.exists()) {
    return snap.data().services || snap.data();
  }

  // Leer config legacy para migrar campos
  const legacyRef = doc(db, 'config', 'subscription-master');
  const legacySnap = await firestoreGetDoc(legacyRef);
  const legacyConfig = legacySnap.exists() ? legacySnap.data() : {};

  // Construir config completa desde SERVICES (seed) + legacy
  const services = {};
  for (const [key, svc] of Object.entries(SERVICES)) {
    const legacy = legacyConfig[key] || {};
    services[key] = {
      ...svc,
      maxSlotsPerRealAccount: legacy.maxSlotsPerRealAccount || svc.maxSlots || 5,
      maxSlotsPerLankGroup: legacy.maxSlotsPerLankGroup || svc.maxSlots || 5,
      accessType: legacy.accessType || svc.accessType || 'email_invitation',
      accessTypeLabel: legacy.accessTypeLabel || '',
      active: true,
    };
  }

  await setDoc(ref, { services, updatedAt: nowISO() });
  return services;
}

/**
 * Alias de initServicesConfig para compatibilidad con imports existentes.
 */
export async function initSubscriptionMasterConfig() {
  const services = await initServicesConfig();
  // Convertir a formato master config
  const result = {};
  for (const [key, svc] of Object.entries(services)) {
    result[key] = {
      maxSlotsPerRealAccount: svc.maxSlotsPerRealAccount || svc.maxSlots || 5,
      maxSlotsPerLankGroup: svc.maxSlotsPerLankGroup || svc.maxSlots || 5,
      accessType: svc.accessType || 'email_invitation',
      accessTypeLabel: svc.accessTypeLabel || '',
    };
  }
  return result;
}

/**
 * Guarda la configuración completa de servicios.
 * @param {object} servicesData - Mapa completo de servicios
 */
export async function saveServicesConfig(servicesData) {
  const ref = doc(db, 'config', 'services');
  await setDoc(ref, { services: servicesData, updatedAt: nowISO() });
}

/**
 * DEPRECATED: Usa saveServicesConfig en su lugar.
 */
export async function saveSubscriptionMasterConfig(configData) {
  // Actualizar config/services con los campos de master config
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  if (snap.exists()) {
    const current = snap.data().services || {};
    for (const [key, cfg] of Object.entries(configData)) {
      if (key === 'updatedAt' || key === 'id') continue;
      if (current[key]) {
        current[key] = { ...current[key], ...cfg };
      }
    }
    await setDoc(ref, { services: current, updatedAt: nowISO() });
  } else {
    // Fallback: guardar en legacy
    const legacyRef = doc(db, 'config', 'subscription-master');
    await setDoc(legacyRef, { ...configData, updatedAt: nowISO() });
  }
}

/**
 * Actualiza la configuración de un servicio específico en config/services.
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {object} serviceConfig - Campos a actualizar
 */
export async function updateServiceConfig(serviceKey, serviceConfig) {
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  const current = snap.exists() ? (snap.data().services || {}) : {};
  current[serviceKey] = { ...(current[serviceKey] || {}), ...serviceConfig };
  await setDoc(ref, { services: current, updatedAt: nowISO() });
}

/**
 * Crea o actualiza un servicio arbitrario en el catálogo dinámico.
 * También deja documentos padre para que el dashboard pueda listar el servicio
 * antes de que existan cuentas reales o grupos Lank.
 */
export async function upsertServiceCatalogEntry(serviceInput, options = {}) {
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  const current = snap.exists() ? (snap.data().services || {}) : {};
  const requestedKey = normalizeServiceKey(serviceInput.serviceKey || serviceInput.key || serviceInput.name);
  if (!requestedKey) {
    throw new Error('Define un nombre o serviceKey válido para el servicio');
  }
  const existingKey = options.previousKey || requestedKey;
  const existing = current[existingKey] || current[requestedKey] || {};
  const { key, config } = buildServiceConfig({ ...serviceInput, key: requestedKey }, existing);
  if (!config.name) {
    throw new Error('Define el nombre visible del servicio');
  }

  if (existingKey !== key && current[key] && !options.allowOverwrite) {
    throw new Error(`Ya existe un servicio con la clave ${key}`);
  }

  const next = { ...current };
  if (existingKey !== key) delete next[existingKey];
  next[key] = {
    ...config,
    serviceKey: key,
    updatedAt: nowISO(),
    createdAt: existing.createdAt || nowISO(),
  };

  await setDoc(ref, { services: next, updatedAt: nowISO() });

  const parentMeta = {
    serviceKey: key,
    name: next[key].name,
    active: next[key].active,
    usesPool: next[key].usesPool,
    accessType: next[key].accessType,
    updatedAt: nowISO(),
  };
  await setDoc(doc(db, 'groups', key), parentMeta, { merge: true });
  if (next[key].usesPool !== false) {
    await setDoc(doc(db, 'service-pools', key), {
      ...parentMeta,
      maxSlotsPerAccount: next[key].maxSlotsPerRealAccount || next[key].maxSlots || 5,
    }, { merge: true });
  }

  logManualChange(existingKey === key && current[key] ? 'update_service_catalog' : 'create_service_catalog', `Servicio ${next[key].name} (${key}) guardado`, {
    collection: 'config',
    documentId: 'services',
    before: existingKey !== key ? { previousKey: existingKey, service: existing } : existing,
    after: next[key],
  });

  return { serviceKey: key, service: next[key] };
}

/**
 * Activa/desactiva un servicio sin borrar sus datos historicos.
 */
export async function setServiceCatalogEntryActive(serviceKey, active) {
  const key = normalizeServiceKey(serviceKey);
  const ref = doc(db, 'config', 'services');
  const snap = await firestoreGetDoc(ref);
  const current = snap.exists() ? (snap.data().services || {}) : {};
  if (!current[key]) {
    throw new Error(`No existe el servicio ${key}`);
  }

  const nextService = { ...current[key], active: Boolean(active), updatedAt: nowISO() };
  await setDoc(ref, {
    services: { ...current, [key]: nextService },
    updatedAt: nowISO(),
  });
  await setDoc(doc(db, 'groups', key), {
    serviceKey: key,
    name: nextService.name || key,
    active: nextService.active,
    usesPool: nextService.usesPool,
    accessType: nextService.accessType,
    updatedAt: nowISO(),
  }, { merge: true });
  if (nextService.usesPool !== false) {
    await setDoc(doc(db, 'service-pools', key), {
      serviceKey: key,
      name: nextService.name || key,
      active: nextService.active,
      usesPool: true,
      accessType: nextService.accessType,
      updatedAt: nowISO(),
    }, { merge: true });
  }

  logManualChange(active ? 'activate_service_catalog' : 'deactivate_service_catalog', `${active ? 'Activado' : 'Desactivado'} servicio ${nextService.name || key}`, {
    collection: 'config',
    documentId: 'services',
    before: current[key],
    after: nextService,
  });

  return { serviceKey: key, service: nextService };
}

/**
 * DEPRECATED: Usa updateServiceConfig en su lugar.
 */
export async function updateServiceMasterConfig(serviceKey, serviceConfig) {
  await updateServiceConfig(serviceKey, serviceConfig);
}

/**
 * Propaga cambios de maxSlots a todas las cuentas reales de un servicio.
 * - Si se aumentan slots: agrega slots vacíos al final
 * - Si se reducen slots: solo permite si los slots a eliminar están libres
 *
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {number} newMaxSlots - Nuevo máximo de slots (1-10)
 * @param {Array} realAccounts - Array de cuentas reales actuales
 * @returns {object} - { success: boolean, updated: number, errors: string[] }
 */
export async function propagateSlotsToRealAccounts(serviceKey, newMaxSlots, realAccounts) {
  const errors = [];
  let updated = 0;

  for (const acct of realAccounts) {
    const currentSlots = acct.slots || [];
    const currentCount = currentSlots.length;

    if (currentCount === newMaxSlots) continue; // Sin cambio

    if (newMaxSlots > currentCount) {
      // Agregar slots vacíos
      const newSlots = [...currentSlots];
      for (let i = currentCount; i < newMaxSlots; i++) {
        newSlots.push({
          slotNumber: i + 1,
          status: 'free',
          memberAlias: '',
          memberEmail: '',
          profileName: '',
          projectName: '',
          assignedFrom: null,
        });
      }
      const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${acct.id}`);
      await updateDoc(ref, {
        slots: newSlots,
        totalSlots: newMaxSlots,
      });
      updated++;
    } else {
      // Reducir slots — verificar que los slots a eliminar estén libres
      const slotsToRemove = currentSlots.slice(newMaxSlots);
      const occupiedToRemove = slotsToRemove.filter(
        s => s.memberAlias && s.memberAlias.trim() && s.status !== 'free'
      );

      if (occupiedToRemove.length > 0) {
        errors.push(
          `${acct.label || acct.id}: ${occupiedToRemove.length} cupo(s) ocupado(s) en las posiciones a eliminar`
        );
        continue;
      }

      const newSlots = currentSlots.slice(0, newMaxSlots);
      const occupied = newSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;
      const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${acct.id}`);
      await updateDoc(ref, {
        slots: newSlots,
        totalSlots: newMaxSlots,
        occupiedSlots: occupied,
      });
      updated++;
    }
  }

  return { success: errors.length === 0, updated, errors };
}

export async function addSlotToRealAccount(serviceKey, accountRef, currentSlots) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  const newSlotNumber = currentSlots.length + 1;
  const newSlot = {
    slotNumber: newSlotNumber,
    status: 'free',
    memberAlias: '',
    memberEmail: '',
    profileName: '',
    projectName: '',
    assignedFrom: null,
  };
  const updatedSlots = [...currentSlots, newSlot];

  await updateDoc(ref, {
    slots: updatedSlots,
    totalSlots: updatedSlots.length,
  });
  logManualChange('add_slot', `Cupo ${newSlotNumber} agregado a ${accountRef} (${serviceKey})`, {
    collection: `service-pools/${serviceKey}/real-accounts`, documentId: accountRef,
    field: 'slots', after: newSlot,
  });
  appendEntityHistory(ref, 'slotHistory', {
    action: 'add_slot',
    slotNumber: newSlotNumber,
  });
}

export async function removeSlotFromRealAccount(serviceKey, accountRef, slotIndex, currentSlots) {
  const slot = currentSlots[slotIndex];
  if (slot.memberAlias && slot.memberAlias.trim() && slot.status !== 'free') {
    throw new Error('No se puede eliminar un cupo ocupado. Libera el cupo primero.');
  }

  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  const removedNumber = slot.slotNumber || slotIndex + 1;
  const updatedSlots = currentSlots.filter((_, i) => i !== slotIndex);
  updatedSlots.forEach((s, i) => { s.slotNumber = i + 1; });
  const occupied = updatedSlots.filter(s => s.memberAlias && s.memberAlias.trim()).length;

  await updateDoc(ref, {
    slots: updatedSlots,
    totalSlots: updatedSlots.length,
    occupiedSlots: occupied,
  });
  logManualChange('remove_slot', `Cupo ${removedNumber} eliminado de ${accountRef} (${serviceKey})`, {
    collection: `service-pools/${serviceKey}/real-accounts`, documentId: accountRef,
    field: 'slots', before: slot,
  });
  appendEntityHistory(ref, 'slotHistory', {
    action: 'remove_slot',
    slotNumber: removedNumber,
  });
}

/**
 * Habilita o deshabilita un slot individual en una cuenta real.
 * @param {string} serviceKey - ej: 'chatgpt'
 * @param {string} accountRef - ej: 'chatgpt_1'
 * @param {number} slotIndex - Índice del slot
 * @param {boolean} enabled - true para habilitar, false para deshabilitar
 * @param {Array} currentSlots - Array actual de slots
 */
export async function toggleSlotEnabled(serviceKey, accountRef, slotIndex, enabled, currentSlots) {
  const ref = doc(db, `service-pools/${serviceKey}/real-accounts/${accountRef}`);
  const updatedSlots = [...currentSlots];
  updatedSlots[slotIndex] = {
    ...updatedSlots[slotIndex],
    enabled: enabled,
    ...(enabled ? {} : { status: 'disabled' }),
    ...(!enabled && updatedSlots[slotIndex].status === 'disabled' ? {} :
      enabled && updatedSlots[slotIndex].status === 'disabled' ? { status: 'free' } : {}),
  };

  // Si se deshabilita un slot ocupado, no lo permite
  if (!enabled && updatedSlots[slotIndex].memberAlias && updatedSlots[slotIndex].memberAlias.trim()) {
    throw new Error('No se puede deshabilitar un cupo ocupado. Libera el cupo primero.');
  }

  // Si se habilita, restaurar status a 'free' si estaba disabled
  if (enabled && currentSlots[slotIndex].status === 'disabled') {
    updatedSlots[slotIndex].status = 'free';
  }
  // Si se deshabilita, marcar como disabled
  if (!enabled) {
    updatedSlots[slotIndex].status = 'disabled';
    updatedSlots[slotIndex].memberAlias = '';
    updatedSlots[slotIndex].memberEmail = '';
    updatedSlots[slotIndex].profileName = '';
    updatedSlots[slotIndex].projectName = '';
    updatedSlots[slotIndex].assignedFrom = null;
  }

  updatedSlots[slotIndex].enabled = enabled;
  const occupied = updatedSlots.filter(s => s.memberAlias && s.memberAlias.trim() && s.status !== 'disabled').length;

  await updateDoc(ref, {
    slots: updatedSlots,
    occupiedSlots: occupied,
  });
}

/**
 * Habilita o deshabilita un cupo individual en un grupo Lank.
 * Guarda las posiciones deshabilitadas en `disabledSlots`.
 *
 * @param {string} serviceKey - ej: 'microsoft365', 'chatgpt'
 * @param {string|number} accountId - ID de cuenta Lank
 * @param {number} slotIndex - Índice del cupo (base 0)
 * @param {boolean} enabled - true para habilitar, false para deshabilitar
 * @param {Array} currentUsers - Usuarios actuales del grupo
 * @param {Array} currentDisabledSlots - Índices deshabilitados actuales
 */
// --- Cobros Recurrentes en Tarjetas ---

/**
 * Agrega un cobro recurrente a una tarjeta, vinculado a una cuenta real.
 * Se guarda en vault-cards/{cardId}.recurringCharges[]
 * Además actualiza monthlyCost en la cuenta real vinculada.
 * @param {string} cardId - ID de la tarjeta
 * @param {object} charge - { description, amount, currency, billingDay, serviceKey, serviceAccountRef, accountLabel }
 */
export async function addRecurringCharge(cardId, charge) {
  const ref = doc(db, 'vault-cards', cardId);
  const snap = await firestoreGetDoc(ref);
  const currentCharges = snap.exists() ? (snap.data().recurringCharges || []) : [];

  // Validar: no permitir dos cobros para la misma cuenta real en esta tarjeta
  if (charge.serviceKey && charge.serviceAccountRef) {
    const duplicate = currentCharges.find(c =>
      c.serviceKey === charge.serviceKey &&
      c.serviceAccountRef === charge.serviceAccountRef
    );
    if (duplicate) {
      throw new Error(`La cuenta "${charge.accountLabel || charge.serviceAccountRef}" ya tiene un cobro en esta tarjeta ("${duplicate.description}").`);
    }
  }

  const newCharge = {
    ...charge,
    id: `rc_${Date.now()}`,
    active: true,
    createdAt: nowISO(),
  };
  const updatedCharges = [...currentCharges, newCharge].sort((a, b) => (a.billingDay || 0) - (b.billingDay || 0));
  if (snap.exists()) {
    await updateDoc(ref, { recurringCharges: updatedCharges, updatedAt: nowISO() });
  } else {
    await setDoc(ref, { recurringCharges: updatedCharges, createdAt: nowISO(), updatedAt: nowISO() });
  }
  // Sincronizar cardLabel, monthlyCost y billingDay en la cuenta real vinculada
  if (charge.serviceKey && charge.serviceAccountRef) {
    const acctRef = doc(db, `service-pools/${charge.serviceKey}/real-accounts/${charge.serviceAccountRef}`);
    const acctSnap = await firestoreGetDoc(acctRef);
    if (acctSnap.exists()) {
      const updates = {
        monthlyCost: charge.amount || 0,
        updatedAt: nowISO(),
      };
      if (charge.billingDay) updates.billingDay = charge.billingDay;
      if (charge.cardLabel) updates.cardLabel = charge.cardLabel;
      await updateDoc(acctRef, updates);
    }
  }
  return newCharge;
}

/**
 * Edita un cobro recurrente existente en una tarjeta.
 * Sincroniza monthlyCost y billingDay con la cuenta real vinculada.
 * @param {string} cardId - ID de la tarjeta
 * @param {string} chargeId - ID del cobro recurrente
 * @param {object} updates - Campos a actualizar { description, amount, currency, billingDay }
 */
export async function updateRecurringCharge(cardId, chargeId, updates) {
  const ref = doc(db, 'vault-cards', cardId);
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) return;
  const currentCharges = snap.data().recurringCharges || [];
  const chargeIndex = currentCharges.findIndex(c => c.id === chargeId);
  if (chargeIndex === -1) return;
  const oldCharge = currentCharges[chargeIndex];
  const updatedCharge = { ...oldCharge, ...updates, updatedAt: nowISO() };
  const updatedCharges = [...currentCharges];
  updatedCharges[chargeIndex] = updatedCharge;
  updatedCharges.sort((a, b) => (a.billingDay || 0) - (b.billingDay || 0));
  await updateDoc(ref, { recurringCharges: updatedCharges, updatedAt: nowISO() });
  // Sincronizar monthlyCost y billingDay con la cuenta real vinculada
  const svcKey = updatedCharge.serviceKey;
  const svcRef = updatedCharge.serviceAccountRef;
  if (svcKey && svcRef) {
    const acctRef = doc(db, `service-pools/${svcKey}/real-accounts/${svcRef}`);
    const acctSnap = await firestoreGetDoc(acctRef);
    if (acctSnap.exists()) {
      const acctUpdates = { updatedAt: nowISO() };
      if (updates.amount !== undefined) acctUpdates.monthlyCost = updates.amount;
      if (updates.billingDay !== undefined) acctUpdates.billingDay = updates.billingDay;
      await updateDoc(acctRef, acctUpdates);
    }
  }
  return updatedCharge;
}

/**
 * Elimina un cobro recurrente de una tarjeta.
 * Actualiza monthlyCost de la cuenta real a 0 si estaba vinculada.
 * @param {string} cardId - ID de la tarjeta
 * @param {string} chargeId - ID del cobro recurrente
 */
export async function removeRecurringCharge(cardId, chargeId) {
  const ref = doc(db, 'vault-cards', cardId);
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) return;
  const currentCharges = snap.data().recurringCharges || [];
  const chargeToRemove = currentCharges.find(c => c.id === chargeId);
  const updatedCharges = currentCharges.filter(c => c.id !== chargeId);
  await updateDoc(ref, { recurringCharges: updatedCharges, updatedAt: nowISO() });
  // Limpiar cardLabel, billingDay y monthlyCost en la cuenta real vinculada
  if (chargeToRemove?.serviceKey && chargeToRemove?.serviceAccountRef) {
    const acctRef = doc(db, `service-pools/${chargeToRemove.serviceKey}/real-accounts/${chargeToRemove.serviceAccountRef}`);
    const acctSnap = await firestoreGetDoc(acctRef);
    if (acctSnap.exists()) {
      await updateDoc(acctRef, { monthlyCost: 0, billingDay: deleteField(), cardLabel: deleteField(), updatedAt: nowISO() });
    }
  }
}

/**
 * Activa/desactiva un cobro recurrente.
 * @param {string} cardId - ID de la tarjeta
 * @param {string} chargeId - ID del cobro recurrente
 * @param {boolean} active - true/false
 */
export async function toggleRecurringCharge(cardId, chargeId, active) {
  const ref = doc(db, 'vault-cards', cardId);
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) return;
  const currentCharges = snap.data().recurringCharges || [];
  const updatedCharges = currentCharges.map(c =>
    c.id === chargeId ? { ...c, active, updatedAt: nowISO() } : c
  );
  await updateDoc(ref, { recurringCharges: updatedCharges, updatedAt: nowISO() });
}

/**
 * Genera gastos automáticos para cobros recurrentes que aún no se han generado este mes.
 * Lee de DOS fuentes:
 *   1. Cuentas reales (service-pools/{svc}/real-accounts) que tienen billingDay y monthlyCost
 *   2. vault-cards/{id}.recurringCharges[] (cobros manuales adicionales)
 * Los gastos se crean con status 'pending' para confirmación manual.
 * @param {object} allCards - Mapa de tarjetas { id: cardData }
 * @param {object} allPools - Mapa de pools { serviceKey: [accounts] }
 * @returns {object} - { generated: number, skipped: number }
 */
export async function generateRecurringExpenses(allCards, allPools = {}) {
  const now = new Date();
  const currentDay = now.getDate();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); // 28, 29, 30 o 31
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const ledgerRef = doc(db, 'finance', 'manual-ledger');
  const ledgerSnap = await firestoreGetDoc(ledgerRef);
  const currentEntries = ledgerSnap.exists() ? (ledgerSnap.data().entries || []) : [];

  // Limpieza: eliminar entries duplicados de FUENTE 1 (real-account) que tienen
  // un equivalente ya cubierto por FUENTE 2 (vault-card) para el mismo servicio+cuenta+mes.
  // Esto corrige duplicados históricos que se generaron antes del fix.
  const vaultCardEntryKeys = new Set();
  currentEntries.forEach(e => {
    if (e.sourceType === 'vault-card' && e.subscription && e.serviceAccountRef && e.entryId) {
      // Extraer el monthKey del entryId: "recurring:{cardId}:{chargeId}:{monthKey}"
      const parts = e.entryId.split(':');
      const mk = parts[parts.length - 1];
      vaultCardEntryKeys.add(`${e.subscription}:${e.serviceAccountRef}:${mk}`);
    }
  });
  const cleanedEntries = currentEntries.filter(e => {
    if (e.sourceType !== 'real-account' || !e.subscription || !e.serviceAccountRef || !e.entryId) return true;
    const parts = e.entryId.split(':');
    const mk = parts[parts.length - 1];
    const key = `${e.subscription}:${e.serviceAccountRef}:${mk}`;
    if (vaultCardEntryKeys.has(key) && e.status === 'pending') {
      // Hay un vault-card entry para lo mismo — eliminar este duplicado de real-account
      return false;
    }
    return true;
  });

  // Usar cleanedEntries para deduplicar
  const existingIds = new Set(cleanedEntries.map(e => e.entryId));

  const newEntries = [];

  // Construir un set de cuentas reales que ya están cubiertas por un recurringCharge
  // activo en vault-cards. Esto evita generar cobros duplicados cuando una cuenta real
  // tiene billingDay/monthlyCost Y además tiene un recurringCharge vinculado en Bóveda.
  const coveredByVaultCard = new Set();
  Object.values(allCards).forEach(card => {
    (card.recurringCharges || []).forEach(charge => {
      if (!charge.active) return;
      if (charge.serviceKey && charge.serviceAccountRef) {
        coveredByVaultCard.add(`${charge.serviceKey}:${charge.serviceAccountRef}`);
      }
    });
  });

  // FUENTE 1: Cuentas reales con billingDay y monthlyCost
  // Se salta cuentas que ya tienen un recurringCharge activo en vault-cards
  Object.entries(allPools).forEach(([serviceKey, accounts]) => {
    (accounts || []).forEach(acct => {
      const billingDay = acct.billingDay;
      const monthlyCost = acct.monthlyCost;
      if (!billingDay) return; // Sin día de cobro, no se puede generar
      // Si billingDay > días del mes (ej. 31 en febrero), usar último día del mes
      const effectiveBillingDay = Math.min(billingDay, lastDayOfMonth);
      if (effectiveBillingDay > currentDay) return; // El día no ha llegado aún

      // Saltar si ya está cubierto por un recurringCharge en vault-cards
      const acctKey = `${serviceKey}:${acct.serviceAccountRef || acct.id}`;
      if (coveredByVaultCard.has(acctKey)) return;

      const entryId = `recurring:${serviceKey}:${acct.serviceAccountRef || acct.id}:${monthKey}`;
      if (existingIds.has(entryId)) return; // Ya generado este mes

      const effectiveAt = `${monthKey}-${String(effectiveBillingDay).padStart(2, '0')}`;
      const entry = {
        entryId,
        type: 'expense',
        description: `${acct.label || acct.serviceAccountRef} — cobro mensual`,
        amount: monthlyCost || 0,
        effectiveAt,
        status: 'pending',
        createdAt: nowISO(),
        subscription: serviceKey,
        serviceAccountRef: acct.serviceAccountRef || acct.id,
        notes: [
          `Cobro automático de cuenta real`,
          acct.cardLabel ? `Tarjeta: ${acct.cardLabel}` : '',
          `Día ${billingDay} de cada mes`,
        ].filter(Boolean),
        isRecurring: true,
        sourceType: 'real-account',
      };
      if (acct.cardLabel) entry.cardLabel = acct.cardLabel;
      newEntries.push(entry);
    });
  });

  // FUENTE 2: vault-cards recurringCharges (cobros manuales adicionales)
  // Track de cuentas ya procesadas para evitar duplicados por misma cuenta en distintos cobros
  const processedAccounts = new Set();
  Object.entries(allCards).forEach(([cardId, card]) => {
    const charges = card.recurringCharges || [];
    charges.forEach(charge => {
      if (!charge.active) return;

      // Deduplicar: si ya se generó un gasto para esta cuenta real este mes, saltar
      if (charge.serviceKey && charge.serviceAccountRef) {
        const acctKey = `${charge.serviceKey}:${charge.serviceAccountRef}`;
        if (processedAccounts.has(acctKey)) return;
        processedAccounts.add(acctKey);
      }

      const billingDay = charge.billingDay || 1;
      // Si billingDay > días del mes (ej. 31 en febrero), usar último día del mes
      const effectiveBillingDay = Math.min(billingDay, lastDayOfMonth);
      if (effectiveBillingDay > currentDay) return;

      const entryId = `recurring:${cardId}:${charge.id}:${monthKey}`;
      if (existingIds.has(entryId)) return;

      const effectiveAt = `${monthKey}-${String(effectiveBillingDay).padStart(2, '0')}`;
      const cardLabel = [card.bank, card.lastFour ? `****${card.lastFour}` : ''].filter(Boolean).join(' ') || '';
      const entry = {
        entryId,
        type: 'expense',
        description: charge.description || 'Cobro recurrente',
        amount: charge.amount || 0,
        effectiveAt,
        status: 'pending',
        createdAt: nowISO(),
        subscription: charge.serviceKey || '',
        serviceAccountRef: charge.serviceAccountRef || '',
        notes: [`Cobro automático — ${card.bank || ''} ****${card.lastFour || ''}`, `Día ${billingDay} de cada mes`],
        isRecurring: true,
        recurringChargeId: charge.id,
        cardId,
        sourceType: 'vault-card',
      };
      if (cardLabel) entry.cardLabel = cardLabel;
      newEntries.push(entry);
    });
  });

  // Backfill: agregar cardLabel a entries existentes que tienen cardId pero no cardLabel
  let backfilled = 0;
  cleanedEntries.forEach(entry => {
    if (entry.cardLabel) return; // Ya tiene
    if (entry.cardId && allCards[entry.cardId]) {
      const card = allCards[entry.cardId];
      const label = [card.bank, card.lastFour ? `****${card.lastFour}` : ''].filter(Boolean).join(' ');
      if (label) { entry.cardLabel = label; backfilled++; }
    }
  });

  if (newEntries.length === 0 && currentEntries.length === cleanedEntries.length && backfilled === 0) {
    return { generated: 0, skipped: 0 };
  }

  const updatedEntries = [...cleanedEntries, ...newEntries];

  if (ledgerSnap.exists()) {
    await updateDoc(ledgerRef, { entries: updatedEntries });
  } else {
    await setDoc(ledgerRef, { entries: updatedEntries, createdAt: nowISO() });
  }

  // NO actualizar totales — se actualizan al confirmar manualmente

  const removed = currentEntries.length - cleanedEntries.length;
  return { generated: newEntries.length, skipped: 0, removed };
}

/**
 * Confirma un cobro recurrente pendiente.
 * Cambia status de 'pending' a 'confirmed' y actualiza los totales del mes.
 * @param {string} entryId - ID estable de la entrada en entries
 * @param {number|null} overrideAmount - Monto a usar (si el usuario lo editó al confirmar)
 */
export async function confirmRecurringExpense(entryId, overrideAmount = null) {
  if (!entryId) return;

  const ledgerRef = doc(db, 'finance', 'manual-ledger');

  await runTransaction(db, async (transaction) => {
    const ledgerSnap = await transaction.get(ledgerRef);
    if (!ledgerSnap.exists()) {
      throw new Error('No se encontró el ledger manual');
    }

    const currentEntries = ledgerSnap.data().entries || [];
    const entryIndex = findLedgerEntryIndex(currentEntries, entryId);
    if (entryIndex < 0) {
      throw new Error('No se encontró el cobro pendiente a confirmar');
    }

    const entry = currentEntries[entryIndex];
    if (!entry || entry.status !== 'pending') return;

    const finalAmount = parseRecurringExpenseAmount(overrideAmount !== null ? overrideAmount : (entry.amount || 0));
    const timestamp = nowISO();
    const entryMonth = (entry.effectiveAt || '').slice(0, 7);
    if (!entryMonth) {
      throw new Error('El cobro pendiente no tiene un mes válido');
    }

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const summaryRef = entryMonth === currentMonthKey
      ? doc(db, 'finance', 'overview')
      : doc(db, 'finance', `monthly-${entryMonth}`);
    const summarySnap = await transaction.get(summaryRef);
    if (!summarySnap.exists()) {
      throw new Error(`No existe el resumen financiero del mes ${entryMonth}`);
    }

    await applyCreditCardBalanceAdjustment(transaction, entry.cardId, finalAmount, timestamp);

    const updatedEntries = [...currentEntries];
    updatedEntries[entryIndex] = {
      ...entry,
      amount: finalAmount,
      status: 'confirmed',
      confirmedAt: timestamp,
    };
    transaction.update(ledgerRef, { entries: updatedEntries });

    const summaryData = summarySnap.data();
    const totals = { ...(summaryData.totals || {}) };
    totals.manualExpensesGross = (totals.manualExpensesGross || 0) + finalAmount;
    totals.bankNetAfterExpenses = (totals.withdrawalCompletedGross || 0)
      + (totals.manualDepositsGross || 0)
      - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);
    totals.estimatedNetWallet = (totals.walletCreditsGross || 0)
      + (totals.manualDepositsGross || 0)
      - (totals.manualExpensesGross || 0) - (totals.manualInvestmentsGross || 0);

    transaction.update(summaryRef, { totals });
  });
}

export async function updateGroupEnabledSlots(serviceKey, accountId, slotIndex, enabled, currentUsers = [], currentDisabledSlots = []) {
  const ref = doc(db, `groups/${serviceKey}/lank-accounts/${accountId}`);
  const hasUser = !!currentUsers[slotIndex];
  if (!enabled && hasUser) {
    throw new Error('No se puede deshabilitar un cupo ocupado en el grupo. Da de baja al usuario primero.');
  }

  const disabledSet = new Set(currentDisabledSlots || []);
  if (enabled) disabledSet.delete(slotIndex);
  else disabledSet.add(slotIndex);

  await updateDoc(ref, {
    disabledSlots: Array.from(disabledSet).sort((a, b) => a - b),
    updatedAt: nowISO(),
  });
}

// ─── CREDIT ACCOUNTS ───────────────────────────────────────────────────────

/**
 * Reads credit accounts from finance/credit-accounts.
 * Returns the accounts array (may be empty).
 */
export async function getCreditAccounts() {
  const ref = doc(db, 'finance', 'credit-accounts');
  const snap = await firestoreGetDoc(ref);
  return snap.exists() ? (snap.data().accounts || []) : [];
}

/**
 * Creates or updates a credit account.
 * @param {object} accountData - Full credit account object
 * @param {Array} currentAccounts - Current accounts array from state
 */
export async function saveCreditAccount(accountData, currentAccounts) {
  const ref = doc(db, 'finance', 'credit-accounts');
  const now = nowISO();
  const existing = currentAccounts.findIndex(a => a.id === accountData.id);

  const account = {
    ...accountData,
    updatedAt: now,
  };
  if (existing < 0) {
    account.createdAt = now;
  }

  const updatedAccounts = existing >= 0
    ? currentAccounts.map((a, i) => i === existing ? account : a)
    : [...currentAccounts, account];

  const snap = await firestoreGetDoc(ref);
  if (snap.exists()) {
    await updateDoc(ref, { accounts: updatedAccounts });
  } else {
    await setDoc(ref, { accounts: updatedAccounts, createdAt: now });
  }

  logManualChange(
    existing >= 0 ? 'update_credit_account' : 'create_credit_account',
    `Cuenta de crédito ${existing >= 0 ? 'actualizada' : 'creada'}: ${accountData.bank}`,
    { collection: 'finance', documentId: 'credit-accounts', after: { id: accountData.id, bank: accountData.bank } },
  );

  return updatedAccounts;
}

/**
 * Deletes a credit account by id.
 */
export async function deleteCreditAccount(accountId, currentAccounts) {
  const ref = doc(db, 'finance', 'credit-accounts');
  const account = currentAccounts.find(a => a.id === accountId);
  const updatedAccounts = currentAccounts.filter(a => a.id !== accountId);
  await updateDoc(ref, { accounts: updatedAccounts });

  logManualChange('delete_credit_account', `Cuenta de crédito eliminada: ${account?.bank || accountId}`, {
    collection: 'finance', documentId: 'credit-accounts', before: { id: accountId, bank: account?.bank },
  });

  return updatedAccounts;
}

/**
 * Adds an installment (MSI purchase) to a credit account.
 * @param {string} accountId - Credit account id
 * @param {object} installment - { id, description, totalAmount, months, monthlyPayment, startDate, remainingMonths }
 * @param {Array} currentAccounts - Current accounts array
 */
export async function addCreditInstallment(accountId, installment, currentAccounts) {
  const ref = doc(db, 'finance', 'credit-accounts');
  const now = nowISO();

  const updatedAccounts = currentAccounts.map(a => {
    if (a.id !== accountId) return a;
    const installments = [...(a.installments || []), {
      ...installment,
      id: installment.id || `msi_${Date.now()}`,
      status: installment.status || 'active',
      createdAt: now,
    }];
    return { ...a, installments, updatedAt: now };
  });

  await updateDoc(ref, { accounts: updatedAccounts });

  logManualChange('add_credit_installment', `MSI agregado a ${accountId}: ${installment.description}`, {
    collection: 'finance', documentId: 'credit-accounts', after: { accountId, installment: installment.description },
  });

  return updatedAccounts;
}

/**
 * Removes an installment from a credit account.
 */
export async function removeCreditInstallment(accountId, installmentId, currentAccounts) {
  const ref = doc(db, 'finance', 'credit-accounts');
  const now = nowISO();

  const updatedAccounts = currentAccounts.map(a => {
    if (a.id !== accountId) return a;
    const installments = (a.installments || []).filter(inst => inst.id !== installmentId);
    return { ...a, installments, updatedAt: now };
  });

  await updateDoc(ref, { accounts: updatedAccounts });

  logManualChange('remove_credit_installment', `MSI eliminado de ${accountId}: ${installmentId}`, {
    collection: 'finance', documentId: 'credit-accounts', after: { accountId, installmentId },
  });

  return updatedAccounts;
}

/**
 * Adds or updates a monthly statement for a credit account.
 * @param {string} accountId
 * @param {object} statement - { monthKey, balanceAtCutoff, minimumPayment, paymentMade, interestCharged, paidAt }
 * @param {Array} currentAccounts
 */
export async function saveCreditStatement(accountId, statement, currentAccounts) {
  const ref = doc(db, 'finance', 'credit-accounts');
  const now = nowISO();

  const updatedAccounts = currentAccounts.map(a => {
    if (a.id !== accountId) return a;
    const statements = [...(a.monthlyStatements || [])];
    const existingIdx = statements.findIndex(s => s.monthKey === statement.monthKey);
    if (existingIdx >= 0) {
      statements[existingIdx] = { ...statements[existingIdx], ...statement, updatedAt: now };
    } else {
      statements.push({ ...statement, createdAt: now });
    }
    return { ...a, monthlyStatements: statements, updatedAt: now };
  });

  await updateDoc(ref, { accounts: updatedAccounts });

  logManualChange('save_credit_statement', `Estado de cuenta ${statement.monthKey} — ${accountId}`, {
    collection: 'finance', documentId: 'credit-accounts', after: { accountId, monthKey: statement.monthKey },
  });

  return updatedAccounts;
}

// --- SIM Cards (Control de Recarga) ---

/**
 * Calcula la próxima fecha de recarga: suma 11 meses y redondea al día 15.
 * @param {string} rechargeDate - Fecha de recarga (YYYY-MM-DD)
 * @returns {string} YYYY-MM-DD con día 15
 */
function computeNextRechargeDate(rechargeDate) {
  const d = new Date(rechargeDate + 'T12:00:00');
  d.setMonth(d.getMonth() + 11);
  d.setDate(15);
  return d.toISOString().slice(0, 10);
}

/**
 * Lee la configuración de SIM Cards desde Firestore.
 * Documento: config/sim-cards
 * @returns {object|null} - { sims: [...], updatedAt }
 */
export async function getSimCardConfig() {
  const ref = doc(db, 'config', 'sim-cards');
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) return null;
  return snap.data();
}

/**
 * Guarda la configuración completa de SIM Cards.
 * @param {object} configData - { sims: [...] }
 */
export async function saveSimCardConfig(configData) {
  const ref = doc(db, 'config', 'sim-cards');
  await setDoc(ref, {
    ...configData,
    updatedAt: nowISO(),
  }, { merge: true });
  logManualChange('save_sim_config', 'Configuración de SIM Cards actualizada', {
    collection: 'config', documentId: 'sim-cards',
  });
}

/**
 * Marca la recarga individual de una SIM como realizada.
 * Suma 11 meses a la fecha de recarga y redondea al día 15.
 * @param {Array} sims - Array de SIMs actual
 * @param {number} lankAccountId - ID de la cuenta Lank
 * @param {string} rechargeDate - Fecha de recarga (YYYY-MM-DD), default hoy
 * @returns {Array} SIMs actualizadas
 */
export async function markSimRechargeComplete(sims, lankAccountId, rechargeDate = null) {
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const date = rechargeDate || localToday;
  const nextRecharge = computeNextRechargeDate(date);

  const updatedSims = sims.map(sim => {
    if (sim.lankAccountId !== lankAccountId) return sim;
    return {
      ...sim,
      lastRechargeDate: date,
      nextRechargeDate: nextRecharge,
    };
  });

  await saveSimCardConfig({ sims: updatedSims });

  const sim = updatedSims.find(s => s.lankAccountId === lankAccountId);
  const simName = sim?.canonicalAlias || sim?.fullName || '';
  const simPhone = sim?.phone || '';
  logManualChange('sim_recharge_individual', `Recarga número telefónico cuenta #${lankAccountId} ${simName} ${simPhone} el ${date}`, {
    collection: 'config', documentId: 'sim-cards',
    after: { lankAccountId, rechargeDate: date, nextRecharge },
  });

  // Auto-complete pending sim_recharge alerts for this account
  try {
    const alertsQuery = query(
      collection(db, 'alerts'),
      where('type', '==', 'sim_recharge'),
      where('status', '==', 'pending'),
      where('lankAccountId', '==', String(lankAccountId)),
    );
    const alertSnaps = await getDocs(alertsQuery);
    const completedAt = nowISO();
    for (const alertDoc of alertSnaps.docs) {
      await updateDoc(alertDoc.ref, { status: 'completed', completedAt });
    }
  } catch (_) {
    // Alert auto-completion is best-effort
  }

  return updatedSims;
}

/**
 * Agrega una nueva SIM Card al sistema.
 * @param {Array} sims - Array de SIMs actual
 * @param {object} simInfo - { lankAccountId, phone, fullName, canonicalAlias, lastRechargeDate }
 * @returns {Array} SIMs actualizadas
 */
export async function addSimCard(sims, simInfo) {
  const { lankAccountId, phone, fullName, canonicalAlias, lastRechargeDate } = simInfo;
  const nextRecharge = computeNextRechargeDate(lastRechargeDate);

  const newSim = {
    lankAccountId,
    phone,
    fullName,
    canonicalAlias: canonicalAlias || fullName,
    lastRechargeDate,
    nextRechargeDate: nextRecharge,
  };

  const updatedSims = [...sims, newSim];

  await saveSimCardConfig({ sims: updatedSims });
  logManualChange('add_sim_card', `SIM agregada: cuenta Lank #${lankAccountId} (${fullName})`, {
    collection: 'config', documentId: 'sim-cards',
    after: { lankAccountId, phone, nextRecharge },
  });
  return updatedSims;
}

/**
 * Elimina la SIM Card asociada a una cuenta Lank.
 * @param {Array} sims - Array de SIMs actual
 * @param {number} lankAccountId - ID de la cuenta Lank
 * @returns {Array} SIMs actualizadas (sin la eliminada)
 */
export async function removeSimCard(sims, lankAccountId) {
  const updatedSims = sims.filter(sim => sim.lankAccountId !== lankAccountId);
  await saveSimCardConfig({ sims: updatedSims });
  logManualChange('remove_sim_card', `SIM eliminada: cuenta Lank #${lankAccountId}`, {
    collection: 'config', documentId: 'sim-cards',
    after: { lankAccountId, removed: true },
  });
  return updatedSims;
}

/**
 * Elimina una cuenta Lank y su SIM asociada.
 * @param {number|string} accountId - ID de la cuenta Lank
 */
export async function deleteLankMasterAccount(accountId) {
  const numId = typeof accountId === 'string' ? parseInt(accountId, 10) : accountId;
  const ref = doc(db, 'accounts', String(numId));
  const snap = await firestoreGetDoc(ref);
  if (!snap.exists()) {
    throw new Error(`La cuenta Lank #${numId} no existe`);
  }
  const before = snap.data();

  await assertNoLinkedPaypalAccounts(String(numId));

  await deleteDoc(ref);

  // Auto-remove linked vault secret
  try {
    const secretDocId = `lank_google_${String(numId).trim()}`;
    const secretRef = doc(db, 'secrets', secretDocId);
    const secretSnap = await firestoreGetDoc(secretRef);
    if (secretSnap.exists()) await deleteDoc(secretRef);
  } catch (_) {
    /* linked vault secret cleanup is best effort */
  }

  // Auto-remove linked SIM card entry
  try {
    const simSnap = await firestoreGetDoc(doc(db, 'config', 'sim-cards'));
    if (simSnap.exists()) {
      const currentSims = simSnap.data().sims || [];
      const filtered = currentSims.filter(s => s.lankAccountId !== numId);
      if (filtered.length !== currentSims.length) {
        await saveSimCardConfig({ sims: filtered });
      }
    }
  } catch (_) {
    // SIM removal is best-effort
  }

  logManualChange('delete_lank_master_account', `Cuenta Lank #${numId} eliminada: ${before.canonicalAlias}`, {
    collection: 'accounts', documentId: String(numId),
    before,
  });
}

// ─── NOTES ───────────────────────────────────────────────────────────────────

export async function createNote({ title, content, color }) {
  const now = nowISO();
  const ref = await addDoc(collection(db, 'notes'), {
    title: (title || '').trim() || 'Sin título',
    content: (content || '').trim(),
    color: color || 'default',
    pinned: false,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function updateNote(noteId, fields) {
  const ref = doc(db, 'notes', noteId);
  await updateDoc(ref, { ...fields, updatedAt: nowISO() });
}

export async function deleteNote(noteId) {
  await deleteDoc(doc(db, 'notes', noteId));
}

export async function toggleNotePin(noteId, currentPinned) {
  const ref = doc(db, 'notes', noteId);
  await updateDoc(ref, { pinned: !currentPinned, updatedAt: nowISO() });
}
