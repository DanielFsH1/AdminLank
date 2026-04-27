"""
AdminLank — Sistema de Auditoría y Logging.

Registra todos los cambios del sistema en la colección 'audit-log/' de Firestore.
Cada documento registra: qué cambió, quién lo hizo, valores antes/después,
y si la IA estuvo involucrada.

Fuentes de cambios:
  - ai_analysis:  Segunda capa de análisis de correos con IA
  - ai_chat:      Acciones ejecutadas desde el chat con IA
  - manual:       Ediciones manuales desde el dashboard
  - system:       Cambios automáticos del sistema (scheduler, scripts)
  - adminbot:     Acciones ejecutadas por AdminBot Hermes (@lankadminbot)
"""
from datetime import datetime, timezone


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _generate_audit_id():
    """Genera un ID corto y legible: audit_MMDD_HHMMSS_XXXX."""
    import random
    import string
    now = datetime.now(timezone.utc)
    suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"audit_{now.strftime('%m%d_%H%M%S')}_{suffix}"


def log_change(db, *,
               source,
               action,
               description,
               collection=None,
               document_id=None,
               field=None,
               before=None,
               after=None,
               actor='system',
               ai_involved=False,
               ai_model=None,
               chat_message_id=None,
               confirmed=True,
               metadata=None):
    """Registra un cambio en el audit-log de Firestore.

    Args:
        db: Cliente de Firestore.
        source: Origen del cambio ('ai_analysis', 'ai_chat', 'manual', 'system').
        action: Tipo de acción ('create', 'update', 'delete', 'complete_alert', etc.).
        description: Descripción legible del cambio.
        collection: Colección de Firestore afectada (ej: 'groups/chatgpt/lank-accounts/1').
        document_id: ID del documento afectado.
        field: Campo específico que cambió (ej: 'users', 'slots').
        before: Valor anterior (dict, list, o valor simple). Puede ser None.
        after: Valor nuevo (dict, list, o valor simple). Puede ser None.
        actor: Quién hizo el cambio ('admin', 'system', 'ai').
        ai_involved: Si la IA participó en este cambio.
        ai_model: Modelo de IA usado (ej: 'gemini-3.1-flash-lite-preview').
        chat_message_id: ID del mensaje de chat que originó la acción.
        confirmed: Si el cambio fue confirmado por el admin.
        metadata: Datos adicionales opcionales (dict).

    Returns:
        str: ID del documento de audit-log creado.
    """
    audit_id = _generate_audit_id()

    entry = {
        'id': audit_id,
        'timestamp': _now_iso(),
        'source': source,
        'action': action,
        'description': description,
        'actor': actor,
        'aiInvolved': ai_involved,
        'confirmed': confirmed,
    }

    # Campos opcionales — solo incluir si tienen valor
    if collection:
        entry['collection'] = collection
    if document_id:
        entry['documentId'] = document_id
    if field:
        entry['field'] = field
    if before is not None:
        entry['before'] = _safe_serialize(before)
    if after is not None:
        entry['after'] = _safe_serialize(after)
    if ai_model:
        entry['aiModel'] = ai_model
    if chat_message_id:
        entry['chatMessageId'] = chat_message_id
    if metadata:
        entry['metadata'] = _safe_serialize(metadata)

    try:
        db.collection('audit-log').document(audit_id).set(entry)
        # Limpieza automática: max 200 registros
        _cleanup_old_entries(db, max_entries=200)
    except Exception as e:
        # El audit-log nunca debe romper el flujo principal
        print(f'[AUDIT] Error writing audit log: {e}')

    return audit_id


def _cleanup_old_entries(db, max_entries=200):
    """Elimina registros antiguos si hay mas del limite."""
    try:
        from google.cloud.firestore_v1 import Query
        # Contar docs por batch (Firestore no tiene count nativo barato)
        docs = list(
            db.collection('audit-log')
              .order_by('timestamp', direction=Query.DESCENDING)
              .offset(max_entries)
              .limit(50)  # Eliminar de a 50
              .stream()
        )
        if docs:
            batch = db.batch()
            for d in docs:
                batch.delete(d.reference)
            batch.commit()
            print(f'[AUDIT] Limpieza: {len(docs)} registros antiguos eliminados')
    except Exception as e:
        print(f'[AUDIT] Error en limpieza: {e}')


def log_analysis(db, *, account_id, account_alias, emails_found, events_classified,
                 alerts_generated, ai_enhanced=False, ai_summary=None, ai_model=None):
    """Registra un análisis de correos completo.

    Registra tanto el análisis de scripts como el de IA (si aplica).
    """
    description = (
        f"Análisis de correos — cuenta {account_id} ({account_alias}): "
        f"{emails_found} correos, {events_classified} eventos, "
        f"{alerts_generated} alertas."
    )
    if ai_enhanced and ai_summary:
        description += f" IA: {ai_summary}"

    return log_change(
        db,
        source='ai_analysis' if ai_enhanced else 'system',
        action='email_analysis',
        description=description,
        actor='system',
        ai_involved=ai_enhanced,
        ai_model=ai_model,
        metadata={
            'accountId': account_id,
            'accountAlias': account_alias,
            'emailsFound': emails_found,
            'eventsClassified': events_classified,
            'alertsGenerated': alerts_generated,
            'aiEnhanced': ai_enhanced,
        }
    )


def log_ai_chat_action(db, *, action, description, chat_message_id=None,
                        collection=None, document_id=None, field=None,
                        before=None, after=None, ai_model=None, confirmed=True):
    """Registra una acción ejecutada desde el chat con IA."""
    return log_change(
        db,
        source='ai_chat',
        action=action,
        description=description,
        collection=collection,
        document_id=document_id,
        field=field,
        before=before,
        after=after,
        actor='admin',
        ai_involved=True,
        ai_model=ai_model,
        chat_message_id=chat_message_id,
        confirmed=confirmed,
    )


def log_manual_action(db, *, action, description, collection=None,
                       document_id=None, field=None, before=None, after=None):
    """Registra una acción manual desde el dashboard."""
    return log_change(
        db,
        source='manual',
        action=action,
        description=description,
        collection=collection,
        document_id=document_id,
        field=field,
        before=before,
        after=after,
        actor='admin',
        ai_involved=False,
    )


def log_adminbot_action(db, *, action, description, collection=None,
                        document_id=None, field=None, before=None, after=None,
                        ai_model=None, confirmed=True, metadata=None):
    """Registra una acción ejecutada por AdminBot Hermes (@lankadminbot)."""
    return log_change(
        db,
        source='adminbot',
        action=action,
        description=description,
        collection=collection,
        document_id=document_id,
        field=field,
        before=before,
        after=after,
        actor='admin',
        ai_involved=True,
        ai_model=ai_model,
        confirmed=confirmed,
        metadata=metadata,
    )


def _safe_serialize(value):
    """Convierte valores a tipos serializables para Firestore.

    Firestore no acepta sets, datetime objects sin zona horaria, etc.
    """
    if isinstance(value, dict):
        return {k: _safe_serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_serialize(item) for item in value]
    if isinstance(value, set):
        return list(value)
    if isinstance(value, datetime):
        return value.isoformat()
    # bytes, etc. → string
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return value


# ─── LECTURA DE HISTORIAL PARA CONTEXTO IA ──────────────────────────────────

def load_recent_entries(db, limit=50):
    """Carga las entradas más recientes del audit log.

    Se usa para inyectar historial reciente en el contexto de la IA,
    permitiéndole saber qué acciones se han tomado recientemente.

    Args:
        db: Cliente de Firestore.
        limit: Número máximo de entradas a cargar.

    Returns:
        list[dict]: Entradas del audit log ordenadas de más reciente a más antigua.
    """
    from google.cloud.firestore_v1 import Query
    entries = []
    try:
        docs = (db.collection('audit-log')
                  .order_by('timestamp', direction=Query.DESCENDING)
                  .limit(limit)
                  .stream())
        for doc in docs:
            entries.append(doc.to_dict())
    except Exception as e:
        print(f'[AUDIT] Error loading recent entries: {e}')
    return entries


def summarize_for_ai(entries):
    """Resume las entradas del audit log para inyectar en el contexto de la IA.

    Formatea las entradas de forma concisa para que la IA pueda entender
    el historial reciente sin consumir demasiados tokens.

    Args:
        entries: Lista de dicts del audit log.

    Returns:
        str: Resumen formateado del historial.
    """
    if not entries:
        return "No hay historial de acciones recientes."
    lines = []
    for e in entries[:50]:  # Máximo 50 para dar buen contexto a la IA
        ts = e.get('timestamp', '?')[:16]
        actor = e.get('actor', '?')
        action = e.get('action', '?')
        source = e.get('source', '?')
        desc = e.get('description', '')[:150]
        ai_tag = ' [IA]' if e.get('aiInvolved') else ''
        lines.append(f"[{ts}] {source}/{actor}{ai_tag}: {action} — {desc}")
    return "\n".join(lines)
