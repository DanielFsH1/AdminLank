"""
AdminLank Cloud Function -  AnÃ¡lisis de correos IMAP + sincronizaciÃ³n Firestore.

Endpoints:
  POST /analyze_emails   -  Ejecuta anÃ¡lisis completo de correos IMAP
  POST /update_schedule  -  Actualiza configuraciÃ³n de anÃ¡lisis programados
  POST /cleanup          -  Limpia notificaciones >7 dÃ­as y alertas >30 dÃ­as

Todas las credenciales IMAP se almacenan en Firestore (collection: config/imap-credentials).
El estado del anÃ¡lisis se guarda en Firestore (analysis/state, analysis/history).
"""
import json
import imaplib
import re
import unicodedata
import traceback
from datetime import datetime, timedelta, timezone
from email import message_from_bytes

from firebase_functions import https_fn, scheduler_fn, options
from firebase_admin import initialize_app, firestore
import google.cloud.firestore

import lank_mail_core as core
import lank_alerts
import lank_audit
import lank_ai
import lank_telegram

app = initialize_app()

LANK_FROM = '***REMOVED***'
IGNORED_EVENT_KINDS = {'payment_user', 'payment_cashback', 'monthly_summary', 'cashback_validated', 'unknown'}
JOIN_EVENT_KINDS = {'user_join_direct', 'user_join_transferred'}
LEAVE_EVENT_KINDS = {'user_left_self', 'user_left_transferred'}
WITHDRAWAL_EVENT_KINDS = {'withdrawal_requested', 'withdrawal_completed'}
# Servicios donde altas/bajas de usuarios no requieren acciÃ³n administrativa
# (no hay cuentas reales que gestionar, solo se monitorean renovaciones)
# Se deriva dinÃ¡micamente desde config/services (usesPool == false)
UNMANAGED_JOIN_LEAVE_SERVICES = {'Microsoft 365'}  # Fallback, se sobreescribe con config dinÃ¡mica

# Mapeo de nombres de servicio a claves de Firestore
# Fallback hardcodeado -  se sobreescribe con config dinÃ¡mica al inicio del anÃ¡lisis
SERVICE_TO_FS = {
    'ChatGPT Plus': 'chatgpt', 'YouTube Premium': 'youtube', 'HBO Max Platino': 'hbo',
    'Microsoft 365': 'microsoft365', 'Gemini AI': 'gemini', 'F1 TV Premium': 'f1tv',
}


def load_service_config(db):
    """Carga la configuraciÃ³n dinÃ¡mica de servicios desde Firestore.
    Retorna (services_dict, name_to_key_map, unmanaged_set).
    """
    doc = db.document('config/services').get()
    if not doc.exists:
        return {}, dict(SERVICE_TO_FS), set(UNMANAGED_JOIN_LEAVE_SERVICES)

    services = doc.to_dict().get('services', {})
    name_to_key = {}
    unmanaged = set()
    for key, svc in services.items():
        if svc.get('active') is False:
            continue
        # Mapear aliases y nombre principal a la key
        for alias in svc.get('nameAliases', []):
            name_to_key[alias] = key
        name_to_key[svc.get('name', key)] = key
        # Servicios sin pool â†’ unmanaged
        if svc.get('usesPool') is False:
            unmanaged.add(svc.get('name', key))
    return services, name_to_key, unmanaged


def _build_name_aliases(services_config):
    """Construye un diccionario {alias: nombre_canÃ³nico} para lank_mail_core."""
    if not services_config:
        return None
    aliases = {}
    for key, svc in services_config.items():
        canonical = svc.get('name', key)
        for alias in svc.get('nameAliases', []):
            aliases[alias] = canonical
        aliases[canonical] = canonical
    return aliases


# â"€â"€â"€ HELPERS â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def normalize_text(value):
    if value is None:
        return None
    value = unicodedata.normalize('NFKD', str(value))
    value = ''.join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold()
    value = re.sub(r'\s+', ' ', value).strip()
    return value or None


def normalize_alias(value):
    value = normalize_text(value)
    if not value:
        return None
    value = re.sub(r'[^a-z0-9]+', '', value)
    return value or None


def normalize_email(value):
    return normalize_text(value) or None


def non_empty(*values):
    for v in values:
        if v not in {None, ''}:
            return v
    return None


def is_lank_sender(sender):
    return LANK_FROM in (normalize_text(sender) or '')


def is_non_operational_lank_mail(subject, body):
    merged = normalize_text(f'{subject}\n{body}') or ''
    blocker_phrases = ['corona de plata', 'corona de oro', 'ahora eres corona', 'felicitaciones! ahora eres corona']
    return any(phrase in merged for phrase in blocker_phrases)


def action_for_event(event):
    kind = event['kind']
    actions = {
        'user_join_direct': 'dar acceso o invitar al usuario',
        'user_join_transferred': 'revisar acceso del usuario transferido',
        'user_left_self': 'quitar acceso del usuario',
        'user_left_transferred': 'quitar acceso y ajustar ingreso esperado',
        'payment_user': 'registrar ingreso; no hay acciÃ³n urgente',
        'payment_cashback': 'registrar ingreso; no hay acciÃ³n urgente',
        'withdrawal_requested': 'esperar confirmaciÃ³n del retiro',
        'withdrawal_completed': 'registrar retiro completado',
        'group_deactivated': 'revisar grupo y retirar accesos',
        'group_validated': 'sin acciÃ³n urgente; solo registrar estado',
        'cashback_validated': 'sin acciÃ³n urgente; solo registrar estado',
        'monthly_summary': 'sin acciÃ³n; solo registro',
    }
    return actions.get(kind, 'revisar manualmente')


def make_user_entry(alias=None, email=None, raw=None):
    return {
        'alias': alias, 'email': email,
        'aliasNorm': normalize_text(alias),
        'aliasLoose': normalize_alias(alias),
        'emailNorm': normalize_email(email),
        'raw': raw,
    }


def extract_user_entries(items):
    entries = []
    for item in items or []:
        if isinstance(item, str):
            if item.strip():
                entries.append(make_user_entry(alias=item.strip(), raw=item))
            continue
        if not isinstance(item, dict):
            continue
        alias = non_empty(item.get('userAlias'), item.get('userName'), item.get('name'),
                         item.get('memberAlias'), item.get('label'))
        email = non_empty(item.get('userEmail'), item.get('email'),
                         item.get('inviteEmail'), item.get('memberEmail'))
        if alias or email:
            entries.append(make_user_entry(alias=alias, email=email, raw=item))
    return entries


# â"€â"€â"€ FIRESTORE DATA LOADING â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def load_imap_credentials(db):
    """Load IMAP credentials from Firestore config/imap-credentials."""
    doc = db.document('config/imap-credentials').get()
    if not doc.exists:
        return []
    return doc.to_dict().get('accounts', [])


def load_account_registry(db):
    """Load account registry from Firestore config/account-registry."""
    doc = db.document('config/account-registry').get()
    if not doc.exists:
        return []
    return doc.to_dict().get('accounts', [])


def load_rates(db):
    """Load rates from Firestore config/rates."""
    doc = db.document('config/rates').get()
    return doc.to_dict() if doc.exists else {}


def load_current_state_context(db, name_to_key=None):
    """Load current-state data from Firestore groups/ collections."""
    if name_to_key is None:
        name_to_key = dict(SERVICE_TO_FS)
    context = {}
    # Construir el mapeo inverso: key â†’ nombre canÃ³nico
    key_to_name = {}
    for name, key in name_to_key.items():
        if key not in key_to_name:
            key_to_name[key] = name
    for fs_key, service_name in key_to_name.items():
        by_account = {}
        try:
            docs = db.collection(f'groups/{fs_key}/lank-accounts').stream()
            for doc in docs:
                data = doc.to_dict()
                aid = int(data.get('accountId', doc.id))
                by_account[aid] = {
                    'groupStatus': data.get('groupStatus'),
                    'subscriptionActive': data.get('subscriptionActive'),
                    'currentUsers': extract_user_entries(data.get('users', [])),
                    'staleUsers': extract_user_entries(data.get('staleServiceMembers', [])),
                    'raw': data,
                }
        except Exception:
            pass
        context[service_name] = {'service': service_name, 'accounts': by_account}
    return context


def load_pool_data(db, service):
    """Load service pool data for checking legacy accounts."""
    fs_key = SERVICE_TO_FS.get(service)
    if not fs_key:
        return {}
    try:
        docs = db.collection(f'service-pools/{fs_key}/real-accounts').stream()
        accounts = []
        for doc in docs:
            d = doc.to_dict()
            d['_docId'] = doc.id
            accounts.append(d)
        return {'accounts': accounts}
    except Exception:
        return {'accounts': []}


def load_analysis_state(db):
    doc = db.document('analysis/state').get()
    if doc.exists:
        return doc.to_dict()
    return {'lastRun': None, 'accounts': {}}


def save_analysis_state(db, state):
    db.document('analysis/state').set(state)


def load_alerts_from_firestore(db):
    """Load all alert documents from Firestore."""
    alerts = []
    try:
        docs = db.collection('alerts').stream()
        for doc in docs:
            d = doc.to_dict()
            d['_docId'] = doc.id
            alerts.append(d)
    except Exception:
        pass
    return {'version': 1, 'alerts': [a for a in alerts if a.get('status', 'pending') == 'pending'],
            'completedAlerts': [a for a in alerts if a.get('status') in ('completed', 'done', 'discarded', 'cancelled_by_ai', 'resolved')]}


def save_alert_to_firestore(db, alert):
    aid = alert.get('id')
    if aid:
        db.collection('alerts').document(aid).set(alert, merge=True)


# â"€â"€â"€ USER MATCHING â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def match_user(account_context, user_name, user_email):
    name_norm = normalize_text(user_name)
    name_loose = normalize_alias(user_name)
    email_norm = normalize_email(user_email)

    def collect_matches(entries):
        found = []
        for entry in entries:
            reasons = []
            if email_norm and entry.get('emailNorm') == email_norm:
                reasons.append('email')
            if name_norm and entry.get('aliasNorm') == name_norm:
                reasons.append('alias_exact')
            elif name_loose and entry.get('aliasLoose') == name_loose:
                reasons.append('alias_loose')
            if reasons:
                found.append({'alias': entry.get('alias'), 'email': entry.get('email'), 'matchBy': reasons})
        return found

    current_matches = collect_matches(account_context.get('currentUsers', []))
    stale_matches = collect_matches(account_context.get('staleUsers', []))
    return {
        'current': current_matches, 'stale': stale_matches,
        'currentFound': bool(current_matches), 'staleFound': bool(stale_matches),
    }


# â"€â"€â"€ EVENT CLASSIFICATION â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def classify_event(event, db_context, db=None):
    service = core.canonical_subscription(event.get('subscription')) or event.get('subscription')
    kind = event.get('kind')
    review = {
        'service': service, 'category': None, 'action': None, 'reason': None,
        'dbGroupStatus': None, 'matchStatus': None, 'matchesCurrent': [], 'matchesStale': [],
    }

    if kind in {'withdrawal_requested', 'withdrawal_completed'}:
        amount = core.parse_amount(event.get('amount'))
        bank = event.get('bank') or 'banco no informado'
        account_number = event.get('accountNumber') or 'cuenta no informada'
        if kind == 'withdrawal_requested':
            review['category'] = 'pending'
            review['action'] = 'esperar confirmaciÃ³n del retiro'
            review['reason'] = f'retiro solicitado por ${amount or event.get("amount") or "?"} hacia {bank} / {account_number}'
            review['matchStatus'] = 'awaiting_completion'
        else:
            review['category'] = 'info'
            review['action'] = 'retiro confirmado'
            review['reason'] = f'retiro completado por ${amount or event.get("amount") or "?"} hacia {bank} / {account_number}'
            review['matchStatus'] = 'completed'
        return review

    if kind in IGNORED_EVENT_KINDS:
        review['category'] = 'ignore'
        review['action'] = 'ignorar'
        review['reason'] = 'correo no operativo o informativo' if kind == 'unknown' else 'correo financiero/informativo'
        return review

    if not service:
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = 'no pude identificar la suscripciÃ³n'
        return review

    # Servicios no gestionados: altas/bajas no requieren acciÃ³n pero se registran
    if service in UNMANAGED_JOIN_LEAVE_SERVICES and kind in (JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS):
        review['category'] = 'info'
        review['action'] = 'sin acciÃ³n requerida'
        review['reason'] = f'{service}: altas y bajas se registran como referencia'
        review['matchStatus'] = 'unmanaged_service'
        return review

    service_context = db_context.get(service)
    if not service_context:
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = f'no existe datos para {service}'
        return review

    account_context = service_context['accounts'].get(int(event['accountId']))
    if account_context:
        review['dbGroupStatus'] = account_context.get('groupStatus')

    if kind in {'group_validated', 'cashback_validated'}:
        if not account_context or account_context.get('groupStatus') == 'no_group':
            review['category'] = 'review'
            review['action'] = 'revisar si debe activarse'
            review['reason'] = 'grupo validado pero no estÃ¡ activo en la base'
        else:
            review['category'] = 'info'
            review['action'] = 'sin acciÃ³n'
            review['reason'] = 'validaciÃ³n sin impacto'
        return review

    if kind == 'group_deactivated':
        review['category'] = 'pending'
        review['action'] = 'revisar grupo y accesos'
        review['reason'] = 'Lank reportÃ³ que el grupo fue dado de baja'
        return review

    if kind not in JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS:
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = 'tipo de evento no cubierto'
        return review

    if not account_context:
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = 'la cuenta no aparece en datos'
        return review

    if not event.get('userName') and not event.get('userEmail'):
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = 'correo sin identidad del usuario'
        return review

    match = match_user(account_context, event.get('userName'), event.get('userEmail'))
    review['matchesCurrent'] = match['current']
    review['matchesStale'] = match['stale']

    if kind in JOIN_EVENT_KINDS:
        if match['currentFound']:
            review['category'] = 'ignore'
            review['action'] = 'sin acciÃ³n'
            review['reason'] = 'usuario ya estaba en la base'
            review['matchStatus'] = 'already_present'
            return review
        review['category'] = 'pending'
        review['action'] = 'agregar o confirmar usuario pendiente'
        review['reason'] = 'usuario nuevo no presente en la base'
        review['matchStatus'] = 'missing_from_current_state'
        if match['staleFound']:
            review['reason'] += '; aparece en histÃ³rico'
        if account_context.get('groupStatus') in {'no_group', 'empty', 'deactivated'}:
            review['reason'] += f"; base marca groupStatus={account_context.get('groupStatus')}"
        return review

    # LEAVE events
    if match['currentFound']:
        # Check legacy accounts
        user_in_legacy = False
        if db:
            pool_data = load_pool_data(db, service)
            for pool_acc in pool_data.get('accounts', []):
                pool_status = pool_acc.get('status', '')
                if pool_status.startswith('legacy'):
                    for slot in pool_acc.get('slots', []):
                        slot_alias = slot.get('memberAlias')
                        if slot_alias and normalize_alias(slot_alias) == normalize_alias(event.get('userName')):
                            user_in_legacy = True
                            break
                if user_in_legacy:
                    break

        if user_in_legacy:
            review['category'] = 'ignore'
            review['action'] = 'sin acciÃ³n'
            review['reason'] = 'usuario en cuenta legacy; no requiere acciÃ³n'
            review['matchStatus'] = 'legacy_account_no_action'
            return review

        review['category'] = 'pending'
        review['action'] = 'quitar acceso o confirmar baja'
        review['reason'] = 'usuario sigue en la base'
        review['matchStatus'] = 'still_present_in_current_state'
        return review

    review['category'] = 'ignore'
    review['action'] = 'sin acciÃ³n'
    review['reason'] = 'usuario ya no estÃ¡ en la base'
    review['matchStatus'] = 'already_absent_from_current_state'
    if match['staleFound']:
        review['reason'] += '; solo aparece en histÃ³rico'
    return review


# â"€â"€â"€ EVENT RECONCILIATION â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def event_identity_key(row):
    kind = row['event'].get('kind')
    if kind in WITHDRAWAL_EVENT_KINDS:
        amount = core.parse_amount(row['event'].get('amount'))
        bank = normalize_text(row['event'].get('bank')) or 'sin-banco'
        account_number = core.normalize_account_number(row['event'].get('accountNumber')) or 'sin-cuenta'
        return f"withdrawal|{row['accountId']}|{amount}|{bank}|{account_number}"
    service = row['dbReview'].get('service') or core.canonical_subscription(row['event'].get('subscription'))
    alias_key = normalize_alias(row['event'].get('userName'))
    email_key = normalize_email(row['event'].get('userEmail'))
    user_key = alias_key or email_key
    if not service or not user_key:
        return None
    return f'{service}|{user_key}'


def reconcile_event_sequences(events):
    grouped = {}
    for idx, row in enumerate(events):
        kind = row['event'].get('kind')
        if kind not in JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS | WITHDRAWAL_EVENT_KINDS:
            continue
        key = event_identity_key(row)
        if not key:
            continue
        grouped.setdefault(key, []).append((idx, row))

    for items in grouped.values():
        items.sort(key=lambda item: item[1]['uid'])
        for pos, (_, row) in enumerate(items):
            kind = row['event'].get('kind')
            review = row['dbReview']
            later_rows = [lr for _, lr in items[pos + 1:]]
            later_join = any(lr['event'].get('kind') in JOIN_EVENT_KINDS for lr in later_rows)
            later_leave = any(lr['event'].get('kind') in LEAVE_EVENT_KINDS for lr in later_rows)
            later_withdraw_completed = any(lr['event'].get('kind') == 'withdrawal_completed' for lr in later_rows)

            if kind in JOIN_EVENT_KINDS and review.get('category') == 'pending' and review.get('matchStatus') == 'missing_from_current_state' and later_leave:
                review['category'] = 'ignore'
                review['action'] = 'sin acciÃ³n'
                review['reason'] = 'alta superada por baja posterior'
                review['matchStatus'] = 'superseded_by_later_leave'
            elif kind in LEAVE_EVENT_KINDS and review.get('category') == 'pending' and review.get('matchStatus') == 'still_present_in_current_state' and later_join:
                review['category'] = 'ignore'
                review['action'] = 'sin acciÃ³n'
                review['reason'] = 'baja superada por alta posterior'
                review['matchStatus'] = 'superseded_by_later_join'
            elif kind == 'withdrawal_requested' and review.get('category') == 'pending' and later_withdraw_completed:
                review['category'] = 'ignore'
                review['action'] = 'sin acciÃ³n'
                review['reason'] = 'retiro ya confirmado'
                review['matchStatus'] = 'superseded_by_withdrawal_completed'


def rebuild_summary(events):
    summary = {'relevant': 0, 'pending': 0, 'review': 0, 'info': 0, 'ignored': 0, 'totalEvents': 0}
    for row in events:
        summary['totalEvents'] += 1
        bucket = 'ignored' if row['dbReview'].get('category') == 'ignore' else row['dbReview'].get('category')
        if bucket in summary:
            summary[bucket] += 1
        # 'relevant' = solo eventos que requieren atenciÃ³n (pending + review + info)
        if bucket not in ('ignored',):
            summary['relevant'] += 1
    return summary


def merge_actionable_events(db, new_events, generated_at):
    """Merge new events with existing ones.
    Existing pending/review events are kept unless their alert has been completed/discarded.
    Info events are kept for 7 days then auto-cleaned.
    New events are added if they don't duplicate existing ones.
    """
    # Load existing events
    existing_doc = db.document('analysis/actionable-events').get()
    existing_events = []
    if existing_doc.exists:
        existing_events = existing_doc.to_dict().get('events', [])

    # Load all alerts to check which events are resolved
    resolved_keys = set()
    try:
        for doc in db.collection('alerts').stream():
            a = doc.to_dict()
            if a.get('status') in ('completed', 'done', 'discarded', 'cancelled_by_ai', 'resolved'):
                # Build a key to match against events
                s = a.get('service', '')
                aid = str(a.get('accountId', ''))
                u = a.get('userAlias', '')
                resolved_keys.add(f"{s}|{aid}|{u}")
    except Exception:
        pass

    # Filter out resolved events from existing
    def event_key(ev):
        return f"{ev.get('subscription', '')}|{ev.get('accountId', '')}|{ev.get('userName', '')}"

    # Clean up old info events (older than 7 days)
    cutoff_7d = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    kept = []
    for e in existing_events:
        if event_key(e) in resolved_keys:
            continue
        # Auto-expire info events after 7 days
        if e.get('category') == 'info':
            discovered = e.get('discoveredAt', e.get('date', ''))
            if discovered and discovered < cutoff_7d:
                continue
        kept.append(e)

    # Tag new info events with discoveredAt for TTL
    for ne in new_events:
        if ne.get('category') == 'info' and 'discoveredAt' not in ne:
            ne['discoveredAt'] = generated_at

    # Add new events that aren't duplicates of existing ones
    existing_keys = {event_key(e) for e in kept}
    for ne in new_events:
        k = event_key(ne)
        if k not in existing_keys and k not in resolved_keys:
            kept.append(ne)
            existing_keys.add(k)

    # Sort by date descending
    kept.sort(key=lambda e: e.get('date', ''), reverse=True)

    db.document('analysis/actionable-events').set({
        'count': len(kept),
        'events': kept,
        'generatedAt': generated_at,
    })
    return kept


def generate_alerts_for_accounts(db, ok_accounts, alerts_data, services_config=None):
    """Generate alerts for analyzed accounts. Returns (alerts_generated, updated_services, actionable_events)."""
    alerts_generated = 0
    updated_services = {}
    actionable = []

    for account_result in ok_accounts:
        if account_result['access'] != 'ok':
            continue
        for evt_row in account_result['events']:
            evt = evt_row.get('event', {})
            kind = evt.get('kind', '')
            service = evt_row.get('dbReview', {}).get('service') or evt.get('subscription')
            a_id = account_result['accountId']
            alias = account_result.get('accountAlias', '')
            user_alias = evt.get('userName', '?')

            if not service:
                continue

            cat = evt_row.get('dbReview', {}).get('category', '')

            # Build event entry (pending, review, and info -  all non-ignored events)
            if cat in ('pending', 'review', 'info'):
                actionable.append({
                    'accountId': a_id,
                    'accountAlias': alias,
                    'userName': evt.get('userName') or 'usuario no informado',
                    'subscription': service,
                    'kind': kind,
                    'category': cat,
                    'action': evt_row.get('dbReview', {}).get('action', ''),
                    'reason': evt_row.get('dbReview', {}).get('reason', ''),
                    'date': evt_row.get('date', ''),
                })

            if kind in ('user_left_self', 'user_left_transferred'):
                # Lookup serviceAccountRef
                svc_ref = None
                other_users = []
                fs_key = SERVICE_TO_FS.get(service)
                if fs_key:
                    try:
                        group_doc = db.document(f'groups/{fs_key}/lank-accounts/{a_id}').get()
                        if group_doc.exists:
                            gd = group_doc.to_dict()
                            for u in gd.get('users', []):
                                ua = u.get('userAlias') if isinstance(u, dict) else u
                                ref = u.get('serviceAccountRef') if isinstance(u, dict) else None
                                if ua == user_alias:
                                    svc_ref = ref
                                else:
                                    other_users.append(ua)
                    except Exception:
                        pass

                # Lookup real account details
                real_email = None
                real_expires = None
                real_status = None
                if svc_ref and fs_key:
                    pool_data = load_pool_data(db, service)
                    for pacc in pool_data.get('accounts', []):
                        if pacc.get('serviceAccountRef') == svc_ref:
                            real_email = pacc.get('email')
                            real_expires = pacc.get('cancelOn') or pacc.get('expiresAt') or pacc.get('renewalDate')
                            real_status = pacc.get('status', '')
                            break

                # Update group state
                leave_reason = 'Salida voluntaria.' if kind == 'user_left_self' else 'Transferido fuera del grupo.'
                if update_group_on_leave(db, service, a_id, user_alias, leave_reason):
                    if service not in updated_services:
                        updated_services[service] = set()
                    updated_services[service].add(a_id)

                # Check duplicates
                if cat not in ('pending', 'review'):
                    continue
                if (lank_alerts.find_duplicate(alerts_data['alerts'], 'profile_delete', service, a_id, user_alias)
                    or lank_alerts.find_duplicate(alerts_data['alerts'], 'user_left_expired', service, a_id, user_alias)):
                    continue
                if not svc_ref:
                    continue
                if real_status and real_status.startswith('legacy'):
                    continue

                new_alerts = lank_alerts.generate_user_left_alerts(
                    evt, service, a_id, alias, svc_ref, other_users,
                    real_account_email=real_email, real_account_expires=real_expires,
                    services_config=services_config
                )
                for na in new_alerts:
                    save_alert_to_firestore(db, na)
                alerts_data['alerts'].extend(new_alerts)
                alerts_generated += len(new_alerts)

            elif kind in ('user_join_direct', 'user_join_transferred'):
                if cat in ('pending', 'review'):
                    user_alias_join = user_alias if user_alias and user_alias != '?' else 'usuario no informado'
                    if not lank_alerts.find_duplicate(alerts_data['alerts'], 'user_needs_access', service, a_id, user_alias_join):
                        evt_copy = dict(evt)
                        if not evt_copy.get('userName'):
                            evt_copy['userName'] = 'usuario no informado'
                        new_alert = lank_alerts.generate_user_joined_alert(evt_copy, service, a_id, alias)
                        if cat == 'review':
                            new_alert['title'] = 'Dar acceso (revisar nombre)'
                            new_alert['description'] = (
                                f'Un usuario se unio al grupo de {service} '
                                f'(cuenta Lank #{a_id} {alias}). '
                                f'El correo no indica el nombre. Revisar manualmente.'
                            )
                        save_alert_to_firestore(db, new_alert)
                        alerts_data['alerts'].append(new_alert)
                        alerts_generated += 1

            elif kind == 'group_deactivated':
                if not lank_alerts.find_duplicate(alerts_data['alerts'], 'group_deactivated', service, a_id, None):
                    new_alert = lank_alerts.generate_group_deactivated_alert(evt, service, a_id, alias)
                    save_alert_to_firestore(db, new_alert)
                    alerts_data['alerts'].append(new_alert)
                    alerts_generated += 1

    return alerts_generated, updated_services, actionable


# â"€â"€â"€ IMAP ANALYSIS â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def search_recent_lank(mail, days, last_uid=None):
    if last_uid is not None:
        typ, data = mail.uid('search', None, f'(UID {last_uid + 1}:*)')
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%d-%b-%Y')
        typ, data = mail.uid('search', None, f'(SINCE {since})')
    if typ != 'OK' or not data or not data[0]:
        return []
    uids = [u.decode() for u in data[0].split()]
    if last_uid is not None:
        uids = [u for u in uids if int(u) > last_uid]
    return uids


def fetch_message(mail, uid):
    typ, data = mail.uid('fetch', uid, '(RFC822)')
    if typ != 'OK':
        raise RuntimeError(f'No pude traer uid {uid}')
    return message_from_bytes(data[0][1])


def analyze_account(account, rates, days, db_context, db, last_uid=None, services_config=None):
    result = {
        'accountId': account['id'],
        'accountAlias': account.get('canonicalAlias', ''),
        'email': account.get('email'),
        'access': 'ok', 'events': [], 'rawEmails': [],
        'summary': {'relevant': 0, 'pending': 0, 'review': 0, 'info': 0, 'ignored': 0},
        'maxUid': last_uid or 0,
    }

    mail = None
    try:
        mail = imaplib.IMAP4_SSL('imap.gmail.com', 993)
        mail.login(account['email'], account['appPassword'])
        opened = False
        for mailbox in ['"[Gmail]/Todos"', '"[Gmail]/All Mail"', 'INBOX']:
            try:
                typ, _ = mail.select(mailbox, readonly=True)
                if typ == 'OK':
                    opened = True
                    break
            except Exception:
                pass
        if not opened:
            raise RuntimeError('No pude abrir buzÃ³n Ãºtil')

        uids = search_recent_lank(mail, days, last_uid)
        seen = set()
        for uid in uids:
            msg = fetch_message(mail, uid)
            sender = core.decode_mime(msg.get('From', ''))
            if not is_lank_sender(sender):
                continue

            subject = core.decode_mime(msg.get('Subject', ''))
            date = core.decode_mime(msg.get('Date', ''))
            body = core.get_text(msg)
            uid_int = int(uid)

            if uid_int > result['maxUid']:
                result['maxUid'] = uid_int
            body_snippet = (body or '')[:2000].strip()
            result['rawEmails'].append({'uid': uid_int, 'date': date, 'subject': subject, 'bodySnippet': body_snippet})

            if is_non_operational_lank_mail(subject, body):
                continue

            event = core.parse_event(subject, body, account['id'], 'production', name_aliases=_build_name_aliases(services_config))
            amt = core.infer_amount(event, rates)
            if amt is not None:
                event['amount'] = amt

            review = classify_event(event, db_context, db)
            if review['category'] == 'ignore' and event.get('kind') in IGNORED_EVENT_KINDS:
                continue

            message_id = core.decode_mime(msg.get('Message-ID', '')).strip()
            dedupe_key = message_id or '|'.join([
                subject.strip().lower(), event.get('kind') or '',
                str(event.get('subscription') or ''), str(event.get('userName') or ''),
                str(event.get('userEmail') or ''), str(event.get('amount') or ''),
                str(event.get('accountNumber') or ''), date.strip().lower(),
            ])
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            result['events'].append({
                'accountId': account['id'], 'uid': uid_int, 'date': date,
                'sender': sender, 'subject': subject, 'event': event,
                'whatToDo': action_for_event(event),
                'messageId': message_id or None, 'dbReview': review,
            })

        reconcile_event_sequences(result['events'])
        result['summary'] = rebuild_summary(result['events'])
        mail.logout()
        mail = None
    except imaplib.IMAP4.error as e:
        result['access'] = 'auth_failed'
        result['error'] = str(e)
    except Exception as e:
        result['access'] = 'processing_failed'
        result['error'] = str(e)
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:
                pass
    return result


# â"€â"€â"€ NOTIFICATIONS (7-day retention) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def save_notifications(db, account_id, alias, raw_emails, analysis_timestamp=None):
    """Save raw email notifications to Firestore with 7-day expiry based on email date."""
    now = datetime.now(timezone.utc)
    cutoff_7d = now - timedelta(days=7)
    discovered_at = analysis_timestamp or now.isoformat()

    notifications = []
    for raw in raw_emails:
        # Parse email date for expiry calculation
        email_date = None
        try:
            from email.utils import parsedate_to_datetime
            email_date = parsedate_to_datetime(raw.get('date', ''))
        except Exception:
            email_date = now

        if email_date.tzinfo is None:
            email_date = email_date.replace(tzinfo=timezone.utc)

        # Skip if older than 7 days
        if email_date < cutoff_7d:
            continue

        expires_at = email_date + timedelta(days=7)
        kind = core.subject_kind(raw.get('subject', ''))
        notifications.append({
            'uid': raw.get('uid'),
            'date': raw.get('date', ''),
            'emailDate': email_date.isoformat(),
            'expiresAt': expires_at.isoformat(),
            'subject': raw.get('subject', ''),
            'bodySnippet': raw.get('bodySnippet', ''),
            'kind': kind,
            'discoveredAt': discovered_at,
        })

    if notifications:
        # Load existing, merge, and clean expired
        doc_ref = db.document(f'notifications/{account_id}')
        existing_doc = doc_ref.get()
        existing = []
        if existing_doc.exists:
            existing = existing_doc.to_dict().get('items', [])

        # Remove expired from existing
        existing = [n for n in existing if n.get('expiresAt', '') > cutoff_7d.isoformat()]

        # Merge: add new notifications that aren't duplicates
        existing_uids = {n.get('uid') for n in existing}
        for n in notifications:
            if n.get('uid') not in existing_uids:
                existing.append(n)

        # Sort newest first
        existing.sort(key=lambda n: n.get('emailDate', ''), reverse=True)

        doc_ref.set({
            'accountId': account_id,
            'accountAlias': alias,
            'items': existing,
            'updatedAt': now.isoformat(),
            'count': len(existing),
        })


def cleanup_old_data(db):
    """Clean notifications >7 days and completed/discarded alerts >30 days."""
    now = datetime.now(timezone.utc)
    cutoff_7d = (now - timedelta(days=7)).isoformat()
    cutoff_30d = (now - timedelta(days=30)).isoformat()

    # Clean notifications
    try:
        notif_docs = db.collection('notifications').stream()
        for doc in notif_docs:
            data = doc.to_dict()
            items = data.get('items', [])
            filtered = [n for n in items if n.get('expiresAt', '') > cutoff_7d]
            if len(filtered) != len(items):
                if filtered:
                    doc.reference.update({'items': filtered, 'count': len(filtered), 'updatedAt': now.isoformat()})
                else:
                    doc.reference.delete()
    except Exception as e:
        print(f'Cleanup notifications error: {e}')

    # Clean old completed/discarded alerts
    try:
        alerts_docs = db.collection('alerts').stream()
        for doc in alerts_docs:
            data = doc.to_dict()
            status = data.get('status', 'pending')
            if status in ('completed', 'done', 'discarded', 'cancelled_by_ai', 'resolved'):
                completed_at = data.get('completedAt') or data.get('discardedAt') or data.get('createdAt', '')
                if completed_at and completed_at < cutoff_30d:
                    doc.reference.delete()
    except Exception as e:
        print(f'Cleanup alerts error: {e}')


# â"€â"€â"€ FINANCE -  WITHDRAWAL TRACKING â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

MONTH_NAMES_EN = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
]


def _make_withdrawal_id(event, account_id, uid):
    """Generate a stable withdrawal ID from event data."""
    amount = core.parse_amount(event.get('amount'))
    bank = (event.get('bank') or 'unknown').strip()[:30]
    acct_num = core.normalize_account_number(event.get('accountNumber')) or ''
    import hashlib
    parts = [str(account_id), str(amount or ''), bank, acct_num]
    return hashlib.md5('|'.join(parts).encode()).hexdigest()


def _parse_email_date(date_str):
    """Parse email Date header to datetime."""
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return datetime.now(timezone.utc)


def update_finance_from_analysis(db, ok_accounts):
    """Extract withdrawal events from analysis and update finance documents.

    Updates:
      - finance/withdrawals-{month}/records/{id} -  individual withdrawal records
      - finance/overview -  recalculated totals for the current month

    Withdrawal pairing: if a 'withdrawal_completed' matches a pending
    'withdrawal_requested' (same account + amount + bank + accountNumber),
    the pending record is upgraded to 'completed' instead of creating a duplicate.
    """
    now = datetime.now(timezone.utc)
    current_month_idx = now.month - 1
    current_month_name = MONTH_NAMES_EN[current_month_idx]
    current_month_key = f'{now.year}-{str(now.month).zfill(2)}'

    withdrawal_events = []

    for account_result in ok_accounts:
        if account_result['access'] != 'ok':
            continue
        a_id = account_result['accountId']
        alias = account_result.get('accountAlias', '')

        for evt_row in account_result['events']:
            evt = evt_row.get('event', {})
            kind = evt.get('kind', '')
            if kind not in WITHDRAWAL_EVENT_KINDS:
                continue

            amount = core.parse_amount(evt.get('amount'))
            if not amount:
                continue

            email_dt = _parse_email_date(evt_row.get('date', ''))
            month_idx = email_dt.month - 1
            month_name = MONTH_NAMES_EN[month_idx]

            withdrawal_events.append({
                'kind': kind,
                'accountId': a_id,
                'accountAlias': alias,
                'amount': amount,
                'bank': (evt.get('bank') or '').strip()[:30] or None,
                'accountType': evt.get('accountType'),
                'accountNumber': evt.get('accountNumber'),
                'emailDate': email_dt.isoformat(),
                'monthName': month_name,
                'monthKey': f'{email_dt.year}-{str(email_dt.month).zfill(2)}',
                'uid': evt_row.get('uid'),
                'withdrawalId': _make_withdrawal_id(evt, a_id, evt_row.get('uid')),
            })

    if not withdrawal_events:
        return 0

    # Load known bank accounts for enrichment
    known_banks = []
    try:
        banks_doc = db.document('config/bank-accounts').get()
        if banks_doc.exists:
            known_banks = banks_doc.to_dict().get('accounts', [])
    except Exception:
        pass

    def match_known_bank(account_number):
        if not account_number:
            return None
        digits = re.sub(r'\D+', '', str(account_number))
        for kb in known_banks:
            kb_digits = re.sub(r'\D+', '', str(kb.get('clabe', '') or kb.get('accountNumber', '')))
            if kb_digits and digits and kb_digits == digits:
                return kb
        return None

    # Process by month
    months_affected = set()
    records_written = 0

    for we in withdrawal_events:
        month_name = we['monthName']
        parent_path = f'finance/withdrawals-{month_name}'
        record_ref = db.document(f'{parent_path}/records/{we["withdrawalId"]}')
        existing = record_ref.get()

        known = match_known_bank(we.get('accountNumber'))

        if we['kind'] == 'withdrawal_requested':
            if existing.exists:
                # Already tracked -  skip
                continue
            record_ref.set({
                'withdrawalId': we['withdrawalId'],
                'accountId': we['accountId'],
                'accountAlias': we['accountAlias'],
                'requestedAt': we['emailDate'],
                'completedAt': None,
                'amount': we['amount'],
                'bank': we['bank'],
                'accountType': we['accountType'],
                'accountNumber': we['accountNumber'],
                'knownBankAccount': known,
                'status': 'requested',
                'createdBy': 'cloud_function',
                'createdAt': now.isoformat(),
            })
            records_written += 1
            months_affected.add(we['monthKey'])

        elif we['kind'] == 'withdrawal_completed':
            if existing.exists:
                ex_data = existing.to_dict()
                if ex_data.get('status') == 'completed':
                    continue  # Already completed -  skip
                # Upgrade from requested to completed
                record_ref.update({
                    'completedAt': we['emailDate'],
                    'status': 'completed',
                    'updatedAt': now.isoformat(),
                })
            else:
                # Try to find a matching pending record to upgrade
                matched = False
                try:
                    pending_docs = db.collection(f'{parent_path}/records') \
                        .where('accountId', '==', we['accountId']) \
                        .where('status', '==', 'requested') \
                        .where('amount', '==', we['amount']) \
                        .stream()
                    for pdoc in pending_docs:
                        pdoc.reference.update({
                            'completedAt': we['emailDate'],
                            'status': 'completed',
                            'updatedAt': now.isoformat(),
                        })
                        matched = True
                        break
                except Exception:
                    pass

                if not matched:
                    # No matching pending -  create as completed directly
                    record_ref.set({
                        'withdrawalId': we['withdrawalId'],
                        'accountId': we['accountId'],
                        'accountAlias': we['accountAlias'],
                        'requestedAt': None,
                        'completedAt': we['emailDate'],
                        'amount': we['amount'],
                        'bank': we['bank'],
                        'accountType': we['accountType'],
                        'accountNumber': we['accountNumber'],
                        'knownBankAccount': known,
                        'status': 'completed',
                        'createdBy': 'cloud_function',
                        'createdAt': now.isoformat(),
                    })

            records_written += 1
            months_affected.add(we['monthKey'])

    # Recalculate overview totals if the current month was affected
    if current_month_key in months_affected:
        _recalculate_overview_totals(db, current_month_name, current_month_key)

    return records_written


def _recalculate_overview_totals(db, month_name, month_key):
    """Recalculate finance/overview totals from withdrawal records."""
    try:
        total_requested_gross = 0.0
        total_completed_gross = 0.0
        pending_count = 0
        completed_count = 0

        records = db.collection(f'finance/withdrawals-{month_name}/records').stream()
        for rec in records:
            rd = rec.to_dict()
            amount = float(rd.get('amount') or 0)
            status = rd.get('status', '')
            # Every withdrawal (requested or completed) contributes to requestedGross
            total_requested_gross += amount
            if status == 'completed':
                total_completed_gross += amount
                completed_count += 1
            else:
                pending_count += 1

        # Read existing overview to preserve manual ledger totals
        overview_ref = db.document('finance/overview')
        overview_doc = overview_ref.get()
        existing_totals = {}
        if overview_doc.exists:
            existing_totals = overview_doc.to_dict().get('totals', {})

        manual_expenses = existing_totals.get('manualExpensesGross', 0)
        manual_investments = existing_totals.get('manualInvestmentsGross', 0)
        wallet_credits = existing_totals.get('walletCreditsGross', 0)

        new_totals = {
            'withdrawalRequestedGross': round(total_requested_gross, 2),
            'withdrawalCompletedGross': round(total_completed_gross, 2),
            'manualExpensesGross': manual_expenses,
            'manualInvestmentsGross': manual_investments,
            'bankNetAfterExpenses': round(total_completed_gross - manual_expenses - manual_investments, 2),
            'walletCreditsGross': wallet_credits,
            'estimatedNetWallet': round(wallet_credits - manual_expenses - manual_investments, 2),
            'pendingWithdrawals': pending_count,
            'completedWithdrawals': completed_count,
        }

        # Usar update() para SOLO modificar totals, sin tocar months, access, notes, etc.
        overview_ref.update({
            'totals': new_totals,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'updatedBy': 'cloud_function',
        })

        print(f'Finance overview updated: requested=${total_requested_gross}, completed=${total_completed_gross}')
    except Exception as e:
        print(f'Error recalculating overview: {e}')


# â"€â"€â"€ UPDATE GROUP STATE â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def update_group_on_leave(db, service, account_id, user_alias, reason=''):
    """Remove user from Firestore group when they leave."""
    fs_key = SERVICE_TO_FS.get(service)
    if not fs_key:
        return False

    doc_ref = db.document(f'groups/{fs_key}/lank-accounts/{account_id}')
    doc = doc_ref.get()
    if not doc.exists:
        return False

    data = doc.to_dict()
    users = data.get('users', [])
    original_count = len(users)

    users = [u for u in users if normalize_alias(u.get('userAlias') if isinstance(u, dict) else u) != normalize_alias(user_alias)]

    if len(users) < original_count:
        date_str = datetime.now(timezone.utc).strftime('%d-%b')
        notes = data.get('notes', [])
        if not isinstance(notes, list):
            notes = []
        notes.append(f'{date_str}: {user_alias} saliÃ³ del grupo. {reason}'.strip())
        doc_ref.update({
            'users': users,
            'hasUsers': len(users) > 0,
            'notes': notes,
        })

        # Cancelar alertas pending de este usuario (renovaciÃ³n, telÃ©fono faltante, etc.)
        try:
            alias_lower = normalize_alias(user_alias)
            pending_alerts = db.collection('alerts').where('status', '==', 'pending').where(
                'userAlias', '==', user_alias
            ).stream()
            for alert_doc in pending_alerts:
                alert = alert_doc.to_dict()
                a_type = alert.get('type', '')
                # Solo cancelar alertas de renovaciÃ³n, telÃ©fono faltante y renewDay faltante
                if any(k in a_type for k in ('renewal', 'missing_phone', 'missing_renewal')):
                    alert_doc.reference.update({
                        'status': 'cancelled_by_system',
                        'completedAt': datetime.now(timezone.utc).isoformat(),
                        'resolution': f'Usuario {user_alias} se dio de baja del grupo.',
                    })
        except Exception as e:
            print(f'Warning: could not cancel pending alerts for {user_alias}: {e}')

        return True
    return False


# â"€â"€â"€ AI SECOND LAYER â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def run_ai_second_layer(db, ok_accounts, db_context, alerts_data, generated_at):
    """Ejecuta la segunda capa de anÃ¡lisis con Gemini AI.

    Toma los resultados de los scripts (correos crudos + eventos clasificados)
    y los envÃ­a a Gemini para un anÃ¡lisis inteligente.

    SIEMPRE registra el resultado en analysis/ai-report (incluso si no hay correos
    o la IA estÃ¡ deshabilitada) para que la webapp pueda mostrar el estado.

    Args:
        db: Cliente de Firestore.
        ok_accounts: Lista de cuentas con resultados de anÃ¡lisis exitosos.
        db_context: Contexto del sistema (estado actual de suscripciones).
        alerts_data: Datos de alertas existentes.
        generated_at: Timestamp del anÃ¡lisis.

    Returns:
        dict: Resultado de la IA o None si estÃ¡ deshabilitada/fallÃ³.
    """
    try:
        ai_client = lank_ai.GeminiClient(db)

        if not ai_client.is_analysis_enabled:
            print('[AI] Segunda capa: anÃ¡lisis con IA deshabilitado.')
            db.document('analysis/ai-report').set({
                'generatedAt': generated_at,
                'status': 'disabled',
                'reason': 'analysisEnabled=false o apiKey vacÃ­a',
            }, merge=True)
            return None

        # Recolectar todos los correos crudos de todas las cuentas
        all_raw_emails = []
        all_script_results = []

        for account in ok_accounts:
            aid = account['accountId']
            alias = account.get('accountAlias', '')

            for raw in account.get('rawEmails', []):
                all_raw_emails.append({
                    'accountId': aid,
                    'accountAlias': alias,
                    'subject': raw.get('subject', ''),
                    'body': raw.get('bodySnippet', ''),
                    'date': raw.get('date', ''),
                    'from': 'info@mylank.com',
                })

            for evt_row in account.get('events', []):
                evt_data = evt_row.get('event', {})
                db_review = evt_row.get('dbReview', {})
                event_kind = evt_data.get('kind', 'unknown')
                event_user = evt_data.get('userName', '')
                event_service = evt_data.get('subscription', '')

                # Determinar si el usuario tenÃ­a acceso real (proyecto/cupo)
                # buscando en el db_context (estado actual del sistema)
                had_real_access = False
                user_svc_ref = ''
                if event_user and event_service:
                    canonical_svc = core.canonical_subscription(event_service) or event_service
                    svc_ctx = db_context.get(canonical_svc, {}) if db_context else {}
                    for acc_ctx in svc_ctx.get('accounts', {}).values():
                        for cu in acc_ctx.get('currentUsers', []):
                            if cu.get('alias', '').lower() == event_user.lower():
                                if cu.get('serviceAccountRef') or cu.get('projectName'):
                                    had_real_access = True
                                    user_svc_ref = cu.get('serviceAccountRef', '')
                                break

                all_script_results.append({
                    'accountId': aid,
                    'accountAlias': alias,
                    'kind': event_kind,
                    'subscription': event_service,
                    'userName': event_user,
                    'userEmail': evt_data.get('userEmail', ''),
                    'category': db_review.get('category', ''),
                    'action': db_review.get('action', ''),
                    'reason': db_review.get('reason', ''),
                    'subject': evt_row.get('subject', ''),
                    'hadRealAccess': had_real_access,
                    'serviceAccountRef': user_svc_ref,
                })

        # Si no hay correos crudos, registrar y salir
        if not all_raw_emails:
            print(f'[AI] Segunda capa: sin correos nuevos ({len(ok_accounts)} cuentas analizadas, 0 correos crudos).')
            db.document('analysis/ai-report').set({
                'generatedAt': generated_at,
                'status': 'skipped',
                'reason': 'Sin correos nuevos para analizar (UID tracking activo)',
                'accountsChecked': len(ok_accounts),
                'emailsFound': 0,
                'model': ai_client.settings.get('analysisModel', 'unknown'),
            }, merge=True)
            return None

        print(f'[AI] Segunda capa: enviando {len(all_raw_emails)} correos crudos y '
              f'{len(all_script_results)} resultados de scripts a Gemini '
              f'(modelo: {ai_client.settings.get("analysisModel", "?")})...')

        # Cargar contexto adicional para la IA: audit log + alertas activas
        recent_audit = lank_audit.load_recent_entries(db, limit=50)
        audit_summary = lank_audit.summarize_for_ai(recent_audit)
        active_alerts = [a for a in alerts_data.get('alerts', []) if a.get('status') == 'pending']

        # Llamar a Gemini con contexto completo
        ai_result = ai_client.analyze_emails(
            raw_emails=all_raw_emails,
            script_results=all_script_results,
            system_context=db_context,
            active_alerts=active_alerts,
            audit_log=audit_summary,
        )

        if not ai_result or ai_result.get('error'):
            error_msg = ai_result.get('error', 'desconocido') if ai_result else 'respuesta vacÃ­a'
            print(f'[AI] Segunda capa: error en anÃ¡lisis: {error_msg}')
            db.document('analysis/ai-report').set({
                'generatedAt': generated_at,
                'status': 'error',
                'error': error_msg,
                'emailsAnalyzed': len(all_raw_emails),
                'model': ai_client.settings.get('analysisModel', 'unknown'),
            }, merge=True)
            return ai_result

        # Ejecutar las acciones decididas por la IA
        model_name = ai_client.settings.get('analysisModel', 'unknown')
        actions = ai_result.get('actions', [])
        exec_result = _execute_ai_actions(db, actions, alerts_data, generated_at, model_name)

        # Guardar reporte de IA en Firestore
        db.document('analysis/ai-report').set({
            'generatedAt': generated_at,
            'status': 'success',
            'model': model_name,
            'emailsAnalyzed': len(all_raw_emails),
            'eventsFromScripts': len(all_script_results),
            'totalActions': len(actions),
            'actionsExecuted': exec_result['executed'],
            'actionsSkipped': exec_result['skipped'],
            'alertsCreated': exec_result['alerts_created'],
            'alertsCancelled': exec_result['alerts_cancelled'],
            'corrections': exec_result['corrections'],
            'summary': ai_result.get('summary', ''),
            'overallConfidence': ai_result.get('overallConfidence', 0),
            'pendingQuestions': ai_result.get('pendingQuestions', []),
            'details': {
                'actions': actions[:20],  # Guardar mÃ¡ximo 20 para no exceder lÃ­mite
            },
        })

        print(f'[AI] Segunda capa completada: {exec_result["executed"]} acciones ejecutadas '
              f'({exec_result["alerts_created"]} alertas creadas, '
              f'{exec_result["alerts_cancelled"]} canceladas), '
              f'confianza: {ai_result.get("overallConfidence", 0):.0%}')
        print(f'[AI] Resumen: {ai_result.get("summary", "Sin resumen")[:200]}')
        # Inyectar conteo de alertas IA para notificaciÃ³n Telegram
        ai_result['_ai_alerts_created'] = exec_result['alerts_created']

        return ai_result

    except Exception as e:
        print(f'[AI] Error general en segunda capa: {e}')
        traceback.print_exc()
        try:
            db.document('analysis/ai-report').set({
                'generatedAt': generated_at,
                'status': 'error',
                'error': str(e),
            }, merge=True)
        except Exception:
            pass
        # Nunca romper el flujo principal
        return {'error': str(e)}


def _execute_ai_actions(db, actions, alerts_data, generated_at, model):
    """Ejecuta las acciones decididas por la IA.

    Procesa cada acciÃ³n del array 'actions' emitido por Gemini.
    Solo ejecuta acciones con confianza >= 0.75.

    Args:
        db: Cliente de Firestore.
        actions: Lista de acciones [{type, confidence, reason, ...}, ...].
        alerts_data: Datos de alertas existentes (para evitar duplicados).
        generated_at: Timestamp del anÃ¡lisis.
        model: Nombre del modelo de IA usado.

    Returns:
        dict: Resumen de ejecuciÃ³n con contadores.
    """
    result = {
        'executed': 0,
        'skipped': 0,
        'alerts_created': 0,
        'alerts_cancelled': 0,
        'corrections': 0,
    }

    for action in actions:
        action_type = action.get('type', '')
        confidence = action.get('confidence', 0)
        reason = action.get('reason', 'Sin razÃ³n proporcionada')

        # Umbral mÃ­nimo de confianza para ejecutar automÃ¡ticamente
        if confidence < 0.75:
            print(f'[AI] AcciÃ³n saltada (confianza {confidence:.0%} < 75%): '
                  f'{action_type} -  {reason[:80]}')
            result['skipped'] += 1
            # Registrar como acciÃ³n pendiente de revisiÃ³n
            lank_audit.log_change(
                db,
                source='ai_analysis',
                action=f'skipped_{action_type}',
                description=f'AcciÃ³n IA saltada (confianza {confidence:.0%}): {reason[:150]}',
                actor='ai',
                ai_involved=True,
                ai_model=model,
                confirmed=False,
                metadata={'action': action, 'reason': 'low_confidence'},
            )
            continue

        # â"€â"€ CREAR ALERTA â"€â"€
        if action_type == 'create_alert':
            data = action.get('data', {})
            alert_type = data.get('type', 'ai_insight')
            service = data.get('service', '')
            account_id = data.get('accountId')
            user_alias = data.get('userAlias', '')

            # Verificar duplicados contra alertas existentes
            existing = [a for a in alerts_data.get('alerts', [])
                        if a.get('type') == alert_type
                        and a.get('service') == service
                        and str(a.get('accountId', '')) == str(account_id or '')
                        and a.get('userAlias') == user_alias
                        and a.get('status') == 'pending']
            if existing:
                print(f'[AI] Alerta duplicada, saltando: {alert_type} {service} {user_alias}')
                result['skipped'] += 1
                continue

            ts_clean = generated_at.replace(':', '').replace('-', '')[:15]
            alert_id = f"ai_{alert_type}_{ts_clean}_{result['alerts_created']}"

            new_alert = {
                'id': alert_id,
                'type': alert_type,
                'title': data.get('title', f'IA: {alert_type}'),
                'description': data.get('description', reason),
                'service': service,
                'accountId': account_id,
                'accountAlias': data.get('accountAlias', ''),
                'userAlias': user_alias,
                'priority': data.get('priority', 'medium'),
                'status': 'pending',
                'createdAt': generated_at,
                'completedAt': None,
                'source': 'ai_analysis',
                'confidence': confidence,
                'aiGenerated': True,
                'aiReason': reason,
            }

            save_alert_to_firestore(db, new_alert)
            alerts_data.setdefault('alerts', []).append(new_alert)
            result['alerts_created'] += 1
            result['executed'] += 1

            lank_audit.log_change(
                db,
                source='ai_analysis',
                action='create_alert',
                description=f'IA creÃ³ alerta: {new_alert["title"]} -  {reason[:100]}',
                collection='alerts',
                document_id=alert_id,
                actor='ai',
                ai_involved=True,
                ai_model=model,
                metadata={'confidence': confidence, 'priority': new_alert['priority']},
            )

        # â"€â"€ CANCELAR ALERTA â"€â"€
        elif action_type == 'cancel_alert':
            alert_id = action.get('alertId', '')
            if not alert_id:
                result['skipped'] += 1
                continue

            # Cancelaciones requieren confianza mÃ¡s alta que creaciones
            if confidence < 0.85:
                print(f'[AI] CancelaciÃ³n saltada (confianza {confidence:.0%} < 85%): '
                      f'{alert_id} -  {reason[:80]}')
                result['skipped'] += 1
                lank_audit.log_change(
                    db, source='ai_analysis',
                    action='skipped_cancel_alert',
                    description=f'IA intentÃ³ cancelar alerta {alert_id} pero confianza insuficiente ({confidence:.0%}): {reason[:150]}',
                    actor='ai', ai_involved=True, ai_model=model,
                    confirmed=False,
                    metadata={'action': action, 'reason': 'low_confidence_cancel'},
                )
                continue

            try:
                alert_ref = db.collection('alerts').document(alert_id)
                alert_doc = alert_ref.get()
                if alert_doc.exists:
                    old_data = alert_doc.to_dict()
                    # Solo permitir cancelar alertas pending -  no tocar completadas/descartadas
                    if old_data.get('status') != 'pending':
                        print(f'[AI] CancelaciÃ³n saltada: alerta {alert_id} no estÃ¡ pending '
                              f'(status={old_data.get("status")})')
                        result['skipped'] += 1
                        continue

                    alert_ref.update({
                        'status': 'cancelled_by_ai',
                        'cancelledAt': generated_at,
                        'cancelReason': reason,
                        'aiConfidence': confidence,
                    })
                    result['alerts_cancelled'] += 1
                    result['executed'] += 1

                    # Actualizar en memoria
                    for a in alerts_data.get('alerts', []):
                        if a.get('id') == alert_id:
                            a['status'] = 'cancelled_by_ai'
                            break

                    lank_audit.log_change(
                        db,
                        source='ai_analysis',
                        action='cancel_alert',
                        description=f'IA cancelÃ³ alerta {alert_id}: {reason[:100]}',
                        collection='alerts',
                        document_id=alert_id,
                        before={'status': old_data.get('status')},
                        after={'status': 'cancelled_by_ai'},
                        actor='ai',
                        ai_involved=True,
                        ai_model=model,
                        metadata={'confidence': confidence},
                    )
                else:
                    print(f'[AI] Alerta a cancelar no encontrada: {alert_id}')
                    result['skipped'] += 1
            except Exception as e:
                print(f'[AI] Error cancelando alerta {alert_id}: {e}')
                result['skipped'] += 1

        # â"€â"€ CORREGIR CLASIFICACIÃ"N â"€â"€
        elif action_type == 'correct_classification':
            lank_audit.log_change(
                db,
                source='ai_analysis',
                action='correct_classification',
                description=(
                    f'IA corrigiÃ³ clasificaciÃ³n: '
                    f'{action.get("scriptValue", "?")} â†’ {action.get("correctedValue", "?")} -  '
                    f'{reason[:100]}'
                ),
                before=action.get('scriptValue'),
                after=action.get('correctedValue'),
                actor='ai',
                ai_involved=True,
                ai_model=model,
                metadata={
                    'emailIndex': action.get('emailIndex'),
                    'confidence': confidence,
                },
            )
            result['corrections'] += 1
            result['executed'] += 1

        # â"€â"€ TIPO DESCONOCIDO â"€â"€
        else:
            print(f'[AI] Tipo de acciÃ³n desconocido: {action_type}')
            result['skipped'] += 1

    return result


# â"€â"€â"€ MAIN ANALYSIS FUNCTION â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
    timeout_sec=540,
    memory=options.MemoryOption.MB_512,
)
def analyze_emails(req: https_fn.Request) -> https_fn.Response:
    """HTTP endpoint to trigger email analysis from the webapp."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()

        # Load dynamic service configuration
        services_config, name_to_key, unmanaged_services = load_service_config(db)
        # Update globals for this invocation
        global SERVICE_TO_FS, UNMANAGED_JOIN_LEAVE_SERVICES
        SERVICE_TO_FS = name_to_key
        UNMANAGED_JOIN_LEAVE_SERVICES = unmanaged_services

        # Load all data from Firestore
        credentials = load_imap_credentials(db)
        registry = load_account_registry(db)
        rates = load_rates(db)
        db_context = load_current_state_context(db, name_to_key)
        state = load_analysis_state(db)

        cred_by_id = {int(a['accountId']): a for a in credentials}
        days = 3

        # Build account list
        accounts = []
        for acc in registry:
            aid = int(acc['id'])
            cred = cred_by_id.get(aid)
            if not cred or not cred.get('enabled', True):
                continue
            accounts.append({
                'id': aid,
                'canonicalAlias': acc.get('canonicalAlias', ''),
                'fullName': acc.get('fullName', ''),
                'email': cred['email'],
                'appPassword': cred['appPassword'],
            })

        # Run analysis
        report = {
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'days': days,
            'usedUidTracking': state.get('lastRun') is not None,
            'accounts': [],
        }

        new_state_accounts = dict(state.get('accounts', {}))
        alerts_data = load_alerts_from_firestore(db)

        for account in accounts:
            aid = str(account['id'])
            last_uid = new_state_accounts.get(aid, {}).get('lastUid')
            account_result = analyze_account(account, rates, days, db_context, db, last_uid, services_config=services_config)
            report['accounts'].append(account_result)

            # Save notifications (7-day retention)
            if account_result['rawEmails']:
                save_notifications(db, account['id'], account.get('canonicalAlias', ''), account_result['rawEmails'], analysis_timestamp=report['generatedAt'])

            # Update state
            max_uid = account_result.get('maxUid', 0)
            prev_uid = new_state_accounts.get(aid, {}).get('lastUid', 0)
            if max_uid > prev_uid:
                new_state_accounts[aid] = {
                    'lastUid': max_uid,
                    'lastRun': datetime.now(timezone.utc).isoformat(),
                    'accountAlias': account.get('canonicalAlias'),
                }
            elif aid not in new_state_accounts:
                new_state_accounts[aid] = {
                    'lastUid': prev_uid,
                    'lastRun': datetime.now(timezone.utc).isoformat(),
                    'accountAlias': account.get('canonicalAlias'),
                }


        # Save state
        state['lastRun'] = datetime.now(timezone.utc).isoformat()
        state['accounts'] = new_state_accounts

        # Save report to Firestore
        ok_accounts = [a for a in report['accounts'] if a['access'] == 'ok']

        # Generate alerts and build actionable events using shared function
        alerts_generated, updated_services, actionable = generate_alerts_for_accounts(db, ok_accounts, alerts_data, services_config=services_config)

        # Save analysis state AFTER alert generation so a crash during alerts
        # doesn't permanently skip unprocessed emails (UIDs not yet committed).
        save_analysis_state(db, state)

        total_pending = sum(a['summary']['pending'] for a in ok_accounts)
        total_relevant = sum(a['summary']['relevant'] for a in ok_accounts)
        total_raw = sum(len(a.get('rawEmails', [])) for a in ok_accounts)

        # Report: totalEvents = todos los eventos parseados, relevant = los que no son ignored
        total_events = sum(a['summary']['totalEvents'] for a in ok_accounts)
        total_ignored = sum(a['summary']['ignored'] for a in ok_accounts)
        total_review = sum(a['summary']['review'] for a in ok_accounts)

        failed_accounts = [a for a in report['accounts'] if a['access'] != 'ok']

        db.document('analysis/latest-report').set({
            'generatedAt': report['generatedAt'],
            'mode': 'UID tracking' if report.get('usedUidTracking') else 'date fallback',
            'totalAccounts': len(report['accounts']),
            'accountsOk': len(ok_accounts),
            'accountCount': len(ok_accounts),
            'totalPending': total_pending,
            'totalRelevant': total_relevant,
            'totalRawEmails': total_raw,
            'totalEvents': total_events,
            'totalIgnored': total_ignored,
            'totalReview': total_review,
            'alertsGenerated': alerts_generated,
            'accounts': [{
                'accountId': a['accountId'],
                'accountAlias': a.get('accountAlias', ''),
                'access': 'ok',
                'rawEmailCount': a['summary'].get('rawEmailCount', len(a.get('rawEmails', []))),
                'pending': a['summary']['pending'],
                'review': a['summary']['review'],
                'relevant': a['summary']['relevant'],
            } for a in ok_accounts],
            'failedAccounts': [{
                'accountId': a['accountId'],
                'accountAlias': a.get('accountAlias', ''),
                'access': a.get('access', 'unknown'),
                'error': a.get('error', 'Error desconocido'),
            } for a in failed_accounts],
        })

        # Merge actionable events -  accumulate, don't overwrite
        merged = merge_actionable_events(db, actionable, report['generatedAt'])

        # â"€â"€â"€ AI SECOND LAYER â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
        ai_result = None
        try:
            ai_result = run_ai_second_layer(
                db, ok_accounts, db_context, alerts_data, report['generatedAt']
            )
            if ai_result and not ai_result.get('error'):
                db.document('analysis/latest-report').update({
                    'aiAnalysis': {
                        'enabled': True,
                        'status': 'success',
                        'summary': ai_result.get('summary', ''),
                        'totalActions': len(ai_result.get('actions', [])),
                        'confidence': ai_result.get('overallConfidence', 0),
                    }
                })
            elif ai_result and ai_result.get('error'):
                db.document('analysis/latest-report').update({
                    'aiAnalysis': {
                        'enabled': True,
                        'status': 'error',
                        'error': ai_result.get('error', ''),
                    }
                })
            else:
                # ai_result es None (deshabilitada o sin correos)
                db.document('analysis/latest-report').update({
                    'aiAnalysis': {
                        'enabled': bool(lank_ai.GeminiClient(db).is_analysis_enabled),
                        'status': 'skipped',
                    }
                })
        except Exception as ai_err:
            print(f'[AI] Error no fatal en segunda capa: {ai_err}')
        # â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

        # Update finance documents from withdrawal events
        finance_records = 0
        try:
            finance_records = update_finance_from_analysis(db, ok_accounts)
        except Exception as e:
            print(f'Warning: finance update failed: {e}')

        # Run cleanup
        cleanup_old_data(db)

        # Build response
        response_data = {
            'success': True,
            'analyzedAccounts': len(ok_accounts),
            'totalAccounts': len(report['accounts']),
            'totalRawEmails': total_raw,
            'totalPending': total_pending,
            'totalRelevant': total_relevant,
            'alertsGenerated': alerts_generated,
            'financeRecordsUpdated': finance_records,
            'generatedAt': report['generatedAt'],
        }

        # Agregar datos de IA si se ejecutÃ³
        if ai_result and not ai_result.get('error'):
            response_data['aiAnalysis'] = {
                'enabled': True,
                'status': 'success',
                'summary': ai_result.get('naturalSummary', ''),
                'corrections': len(ai_result.get('scriptCorrections', [])),
                'unrecognizedImportant': len(ai_result.get('unrecognizedImportant', [])),
                'confidence': ai_result.get('overallConfidence', 0),
            }
        elif ai_result and ai_result.get('error'):
            response_data['aiAnalysis'] = {
                'enabled': True,
                'status': 'error',
                'error': ai_result.get('error'),
            }
        else:
            response_data['aiAnalysis'] = {
                'enabled': False,
                'status': 'skipped',
            }

        # Detectar usuarios sin fecha de renovaciÃ³n en servicios renewal-based
        missing_renewal_count = lank_alerts.generate_missing_renewal_alerts(db, services_config)
        if missing_renewal_count > 0:
            print(f'Missing renewal date alerts generated: {missing_renewal_count}')
            alerts_generated += missing_renewal_count

        # Detectar usuarios sin telÃ©fono (preparaciÃ³n para WhatsApp)
        missing_phone_count = lank_alerts.generate_missing_phone_alerts(db, services_config)
        if missing_phone_count > 0:
            print(f'Missing phone alerts generated: {missing_phone_count}')
            alerts_generated += missing_phone_count

        # Alertas de cuentas de crédito (corte y pago)
        credit_alert_count = lank_alerts.generate_credit_alerts(db)
        if credit_alert_count > 0:
            print(f'Credit alerts generated: {credit_alert_count}')
            alerts_generated += credit_alert_count

        # Alertas de recarga de SIM Cards (7 días antes del 15 de cada mes)
        try:
            sim_alert_count = lank_alerts.generate_sim_recharge_alerts(db)
            if sim_alert_count > 0:
                print(f'SIM recharge alerts generated: {sim_alert_count}')
                alerts_generated += sim_alert_count
            else:
                print(f'SIM recharge alerts: 0 generated')
        except Exception as sim_err:
            import traceback as _tb
            print(f'[SIM Alerts] ERROR: {sim_err}')
            _tb.print_exc()

        # Actualizar response_data con total final de alertas
        response_data['alertsGenerated'] = alerts_generated

        # ─── Notificaciones de Telegram ─────────────────────────────────
        try:
            tg = lank_telegram.TelegramBot(db)
            if tg.is_enabled:
                notified = False

                # Calcular total de alertas (primera capa + segunda capa IA)
                ai_alerts_created = 0
                if ai_result and isinstance(ai_result, dict):
                    ai_alerts_created = ai_result.get('_ai_alerts_created', 0)
                total_alerts = alerts_generated + ai_alerts_created

                # 1. Alertas de Firestore con status pending (incluye primera capa + IA)
                if total_alerts > 0:
                    new_alerts = list(db.collection('alerts')
                                     .where('status', '==', 'pending')
                                     .order_by('createdAt', direction='DESCENDING')
                                     .limit(max(total_alerts, 10)).stream())
                    alert_dicts = [a.to_dict() for a in new_alerts]
                    if alert_dicts:
                        tg.send_alert_notification(alert_dicts)
                        notified = True
                        print(f'[Telegram] NotificaciÃ³n enviada: {len(alert_dicts)} alertas '
                              f'(scripts: {alerts_generated}, IA: {ai_alerts_created})')

                # 2. Fallback: buscar alertas pending recientes (Ãºltimos 10 min)
                if not notified:
                    try:
                        recent_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
                        recent_alerts = list(db.collection('alerts')
                                            .where('status', '==', 'pending')
                                            .where('createdAt', '>=', recent_cutoff)
                                            .order_by('createdAt', direction='DESCENDING')
                                            .limit(20).stream())
                        alert_dicts = [a.to_dict() for a in recent_alerts]
                        if alert_dicts:
                            tg.send_alert_notification(alert_dicts)
                            notified = True
                            print(f'[Telegram] Fallback: {len(alert_dicts)} alertas pending recientes notificadas')
                    except Exception as fb_err:
                        print(f'[Telegram] Error en fallback de alertas recientes: {fb_err}')

                # 3. Actionable-events como Ãºltimo recurso
                if not notified:
                    try:
                        ae_doc = db.document('analysis/actionable-events').get()
                        if ae_doc.exists:
                            ae_events = ae_doc.to_dict().get('events', [])
                            if ae_events:
                                pseudo_alerts = []
                                for evt in ae_events:
                                    pseudo_alerts.append({
                                        'title': f"{evt.get('userName', '?')} -  {evt.get('subscription', '?')}",
                                        'description': evt.get('action', 'AcciÃ³n requerida'),
                                        'priority': 'high' if 'join' in evt.get('kind', '') else 'medium',
                                        'service': evt.get('subscription', '?'),
                                        'accountId': evt.get('accountId', '?'),
                                        'accountAlias': evt.get('accountAlias', '?'),
                                    })
                                tg.send_alert_notification(pseudo_alerts)
                    except Exception as ae_err:
                        print(f'[Telegram] Error leyendo actionable-events: {ae_err}')

                # Notificar cuentas con error
                if failed_accounts:
                    tg.send_analysis_errors([{
                        'accountId': a['accountId'],
                        'accountAlias': a.get('accountAlias', ''),
                        'error': a.get('error', 'Error desconocido'),
                    } for a in failed_accounts])
        except Exception as tg_err:
            print(f'[Telegram] Error no fatal enviando notificaciÃ³n: {tg_err}')
        # â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

        return https_fn.Response(
            json.dumps(response_data),
            content_type='application/json',
        )

    except Exception as e:
        traceback.print_exc()
        return https_fn.Response(
            json.dumps({'success': False, 'error': str(e)}),
            status=500,
            content_type='application/json',
        )


# â"€â"€â"€ SCHEDULE CONFIG â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def update_schedule(req: https_fn.Request) -> https_fn.Response:
    """Update the scheduled analysis configuration."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        body = req.get_json(silent=True) or {}
        db = firestore.client()
        enabled = body.get('enabled', False)
        freq = body.get('frequencyHours', 6)
        start_time = body.get('startTime', None)  # ISO string for the first scheduled run
        active_hours = body.get('activeHours', None)  # { enabled, startHour, endHour, tzOffset }

        update_data = {
            'enabled': enabled,
            'frequencyHours': freq,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
        }

        if enabled and start_time:
            update_data['startTime'] = start_time
        elif not enabled:
            # When disabling, clear the startTime so it must be reconfigured
            update_data['startTime'] = None

        # Save active hours configuration
        if active_hours is not None:
            update_data['activeHours'] = active_hours

        db.document('config/schedule').set(update_data, merge=True)
        return https_fn.Response(json.dumps({'success': True}), content_type='application/json')
    except Exception as e:
        return https_fn.Response(json.dumps({'success': False, 'error': str(e)}), status=500, content_type='application/json')


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
)
def get_schedule(req: https_fn.Request) -> https_fn.Response:
    """Get the current schedule configuration."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)
    try:
        db = firestore.client()
        doc = db.document('config/schedule').get()
        data = doc.to_dict() if doc.exists else {'enabled': False, 'frequencyHours': 6}
        return https_fn.Response(json.dumps(data), content_type='application/json')
    except Exception as e:
        return https_fn.Response(json.dumps({'error': str(e)}), status=500, content_type='application/json')


# ─── HEALTH CHECK ────────────────────────────────────────────────────────

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
    timeout_sec=120,
    memory=options.MemoryOption.MB_256,
)
def health_check(req: https_fn.Request) -> https_fn.Response:
    """Lightweight health check for all AdminLank services.
    
    Checks:
    - Firestore connectivity + key collections
    - IMAP account connectivity (login only, no email download)
    - Schedule configuration
    - Account registry completeness
    - Last analysis state
    """
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    import time as _time
    start_ts = _time.time()
    checks = {}
    now = datetime.now(timezone.utc)

    db = None
    try:
        db = firestore.client()
        checks['firestore'] = {'status': 'ok', 'message': 'ConexiÃ³n exitosa'}
    except Exception as e:
        checks['firestore'] = {'status': 'error', 'message': str(e)}

    # --- Account Registry ---
    try:
        reg_doc = db.document('config/account-registry').get()
        if reg_doc.exists:
            reg = reg_doc.to_dict()
            accounts = reg.get('accounts', [])
            checks['account_registry'] = {
                'status': 'ok',
                'message': f'{len(accounts)} cuentas registradas',
                'count': len(accounts),
            }
        else:
            checks['account_registry'] = {'status': 'warning', 'message': 'Registro no encontrado'}
    except Exception as e:
        checks['account_registry'] = {'status': 'error', 'message': str(e)}

    # --- IMAP Credentials ---
    try:
        creds_doc = db.document('config/imap-credentials').get()
        if creds_doc.exists:
            creds = creds_doc.to_dict()
            cred_list = creds.get('accounts', [])
            checks['imap_credentials'] = {
                'status': 'ok' if len(cred_list) > 0 else 'warning',
                'message': f'{len(cred_list)} credenciales IMAP configuradas',
                'count': len(cred_list),
            }
        else:
            checks['imap_credentials'] = {'status': 'error', 'message': 'Credenciales no encontradas'}
    except Exception as e:
        checks['imap_credentials'] = {'status': 'error', 'message': str(e)}

    # --- IMAP Connectivity (login only, sample 3 accounts) ---
    imap_results = []
    try:
        creds_doc = db.document('config/imap-credentials').get()
        creds = (creds_doc.to_dict() or {}).get('accounts', []) if creds_doc.exists else []
        # Test a sample of 3 accounts to avoid timeouts
        sample = creds[:3] if len(creds) >= 3 else creds
        for cred in sample:
            email = cred.get('email', 'unknown')
            try:
                mail = imaplib.IMAP4_SSL('imap.gmail.com')
                mail.login(email, cred.get('appPassword', ''))
                mail.logout()
                imap_results.append({'email': email, 'status': 'ok'})
            except Exception as e:
                imap_results.append({'email': email, 'status': 'error', 'error': str(e)})

        failed = [r for r in imap_results if r['status'] != 'ok']
        if not failed:
            checks['imap_connectivity'] = {
                'status': 'ok',
                'message': f'{len(imap_results)}/{len(imap_results)} cuentas verificadas correctamente',
                'tested': len(imap_results),
                'total': len(creds),
                'details': imap_results,
            }
        else:
            checks['imap_connectivity'] = {
                'status': 'error',
                'message': f'{len(failed)}/{len(imap_results)} cuentas con error',
                'tested': len(imap_results),
                'total': len(creds),
                'details': imap_results,
            }
    except Exception as e:
        checks['imap_connectivity'] = {'status': 'error', 'message': str(e)}

    # --- Schedule Config ---
    try:
        sched_doc = db.document('config/schedule').get()
        if sched_doc.exists:
            sched = sched_doc.to_dict()
            enabled = sched.get('enabled', False)
            freq = sched.get('frequencyHours', 6)
            start_time = sched.get('startTime')
            checks['schedule'] = {
                'status': 'ok' if enabled else 'inactive',
                'enabled': enabled,
                'frequencyHours': freq,
                'startTime': start_time,
                'message': f'Activo cada {freq}h' if enabled else 'Desactivado',
            }
        else:
            checks['schedule'] = {'status': 'warning', 'message': 'No configurado'}
    except Exception as e:
        checks['schedule'] = {'status': 'error', 'message': str(e)}

    # --- Last Analysis State ---
    try:
        state_doc = db.document('analysis/state').get()
        if state_doc.exists:
            state = state_doc.to_dict()
            last_run = state.get('lastRun')
            if last_run:
                try:
                    last_dt = datetime.fromisoformat(last_run)
                    if last_dt.tzinfo is None:
                        last_dt = last_dt.replace(tzinfo=timezone.utc)
                    hours_ago = (now - last_dt).total_seconds() / 3600
                    checks['last_analysis'] = {
                        'status': 'ok' if hours_ago < 48 else 'warning',
                        'lastRun': last_run,
                        'hoursAgo': round(hours_ago, 1),
                        'message': f'Hace {hours_ago:.1f} horas',
                    }
                except Exception:
                    checks['last_analysis'] = {'status': 'ok', 'lastRun': last_run, 'message': last_run}
            else:
                checks['last_analysis'] = {'status': 'warning', 'message': 'Nunca se ha ejecutado'}
        else:
            checks['last_analysis'] = {'status': 'warning', 'message': 'Sin datos de anÃ¡lisis'}
    except Exception as e:
        checks['last_analysis'] = {'status': 'error', 'message': str(e)}

    # --- Latest Report ---
    try:
        report_doc = db.document('analysis/latest-report').get()
        if report_doc.exists:
            report = report_doc.to_dict()
            accts = report.get('accounts', [])
            failed_accts = [a for a in accts if a.get('access') != 'ok']
            total_emails = sum(a.get('rawEmailCount', 0) for a in accts)
            checks['latest_report'] = {
                'status': 'ok' if not failed_accts else 'warning',
                'totalAccounts': len(accts),
                'failedAccounts': len(failed_accts),
                'totalEmails': total_emails,
                'generatedAt': report.get('generatedAt', ''),
                'message': f'{len(accts)} cuentas, {total_emails} correos, {len(failed_accts)} fallidas',
            }
        else:
            checks['latest_report'] = {'status': 'warning', 'message': 'Sin reporte'}
    except Exception as e:
        checks['latest_report'] = {'status': 'error', 'message': str(e)}

    # --- Alerts Collection ---
    try:
        alerts_ref = db.collection('alerts')
        alerts_snap = alerts_ref.get()
        total_alerts = len(alerts_snap)
        pending = sum(1 for a in alerts_snap if a.to_dict().get('status', 'pending') == 'pending')
        checks['alerts'] = {
            'status': 'ok',
            'total': total_alerts,
            'pending': pending,
            'message': f'{total_alerts} alertas, {pending} pendientes',
        }
    except Exception as e:
        checks['alerts'] = {'status': 'error', 'message': str(e)}

    # --- Notifications Collection ---
    try:
        notifs_ref = db.collection('notifications')
        notifs_snap = notifs_ref.get()
        total_notifs = len(notifs_snap)
        checks['notifications'] = {
            'status': 'ok',
            'total': total_notifs,
            'message': f'{total_notifs} notificaciones almacenadas',
        }
    except Exception as e:
        checks['notifications'] = {'status': 'error', 'message': str(e)}

    # --- Subscription Groups ---
    try:
        groups_ref = db.collection('groups')
        groups_snap = groups_ref.get()
        group_names = [g.id for g in groups_snap]
        checks['subscription_groups'] = {
            'status': 'ok' if len(group_names) > 0 else 'warning',
            'count': len(group_names),
            'groups': group_names,
            'message': f'{len(group_names)} grupos configurados',
        }
    except Exception as e:
        checks['subscription_groups'] = {'status': 'error', 'message': str(e)}

    elapsed = round((_time.time() - start_ts) * 1000)

    # Overall status
    statuses = [c.get('status') for c in checks.values()]
    if 'error' in statuses:
        overall = 'degraded'
    elif 'warning' in statuses:
        overall = 'operational_with_warnings'
    else:
        overall = 'operational'

    result = {
        'overall': overall,
        'checkedAt': now.isoformat(),
        'elapsedMs': elapsed,
        'checks': checks,
    }

    return https_fn.Response(json.dumps(result), content_type='application/json')


# â"€â"€â"€ AI CONFIGURATION & TEST â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def test_ai(req: https_fn.Request) -> https_fn.Response:
    """Test the connection to Gemini AI API."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()
        client = lank_ai.GeminiClient(db)
        result = client.test_connection()
        return https_fn.Response(json.dumps(result), content_type='application/json')
    except Exception as e:
        return https_fn.Response(
            json.dumps({'success': False, 'message': str(e)}),
            status=500, content_type='application/json',
        )


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def update_ai_settings(req: https_fn.Request) -> https_fn.Response:
    """Update AI configuration settings."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        body = req.get_json(silent=True) or {}
        db = firestore.client()

        # Campos permitidos para actualizar
        allowed_fields = {
            'enabled', 'model', 'analysisModel', 'chatModel',
            'thinkingLevel', 'temperature', 'autoApproveActions',
            'maxContextTokens', 'analysisEnabled', 'chatEnabled',
            'apiKey', 'securityPin',
        }

        update_data = {k: v for k, v in body.items() if k in allowed_fields}
        update_data['updatedAt'] = datetime.now(timezone.utc).isoformat()

        # Verificar PIN si se cambia informaciÃ³n sensible
        sensitive_fields = {'apiKey', 'securityPin'}
        changing_sensitive = bool(sensitive_fields & set(body.keys()))

        if changing_sensitive:
            # Verificar PIN actual antes de cambiar datos sensibles
            current_pin = body.get('currentPin')
            if current_pin:
                settings_doc = db.document('config/ai-settings').get()
                if settings_doc.exists:
                    stored_pin = settings_doc.to_dict().get('securityPin')
                    if stored_pin and current_pin != stored_pin:
                        return https_fn.Response(
                            json.dumps({'success': False, 'error': 'PIN incorrecto'}),
                            status=403, content_type='application/json',
                        )

        # Registrar cambio en audit-log (sin incluir valores sensibles)
        safe_log = {k: ('***' if k in sensitive_fields else v) for k, v in update_data.items()}
        lank_audit.log_change(
            db,
            source='manual',
            action='update_ai_settings',
            description=f'ConfiguraciÃ³n de IA actualizada: {list(update_data.keys())}',
            actor='admin',
            after=safe_log,
        )

        db.document('config/ai-settings').set(update_data, merge=True)

        return https_fn.Response(
            json.dumps({'success': True, 'updated': list(update_data.keys())}),
            content_type='application/json',
        )
    except Exception as e:
        return https_fn.Response(
            json.dumps({'success': False, 'error': str(e)}),
            status=500, content_type='application/json',
        )


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
)
def get_ai_settings(req: https_fn.Request) -> https_fn.Response:
    """Get current AI configuration settings."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()
        doc = db.document('config/ai-settings').get()
        data = doc.to_dict() if doc.exists else dict(lank_ai.DEFAULT_AI_SETTINGS)

        # NUNCA devolver la API Key completa al frontend
        if 'apiKey' in data and data['apiKey']:
            key = data['apiKey']
            data['apiKeyMasked'] = f'{key[:8]}...{key[-4:]}' if len(key) > 12 else '****'
            data['apiKeySet'] = True
            del data['apiKey']
        else:
            data['apiKeyMasked'] = ''
            data['apiKeySet'] = False

        # No devolver PIN completo
        if 'securityPin' in data:
            data['pinSet'] = bool(data['securityPin'])
            del data['securityPin']

        # Incluir modelos personalizados
        models_doc = db.document('config/ai-models').get()
        if models_doc.exists:
            data['customModels'] = models_doc.to_dict().get('models', [])
        else:
            data['customModels'] = []

        # Incluir system prompts (para la pestaÃ±a de prompts)
        prompts_doc = db.document('config/ai-prompts').get()
        if prompts_doc.exists:
            data['customPrompts'] = prompts_doc.to_dict()
        else:
            data['customPrompts'] = None

        return https_fn.Response(json.dumps(data), content_type='application/json')
    except Exception as e:
        return https_fn.Response(
            json.dumps({'error': str(e)}),
            status=500, content_type='application/json',
        )


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
)
def get_ai_prompts(req: https_fn.Request) -> https_fn.Response:
    """Get system prompts (both default and custom overrides)."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()
        prompts_doc = db.document('config/ai-prompts').get()
        custom = prompts_doc.to_dict() if prompts_doc.exists else {}

        return https_fn.Response(json.dumps({
            'defaultChatPrompt': lank_ai.CHAT_SYSTEM_PROMPT,
            'defaultAnalysisPrompt': lank_ai.ANALYSIS_SYSTEM_PROMPT,
            'customChatPrompt': custom.get('chatPrompt', ''),
            'customAnalysisPrompt': custom.get('analysisPrompt', ''),
            'useCustomChat': custom.get('useCustomChat', False),
            'useCustomAnalysis': custom.get('useCustomAnalysis', False),
        }), content_type='application/json')
    except Exception as e:
        return https_fn.Response(
            json.dumps({'error': str(e)}),
            status=500, content_type='application/json',
        )


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def update_ai_prompts(req: https_fn.Request) -> https_fn.Response:
    """Update custom system prompts."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        body = req.get_json(silent=True) or {}
        db = firestore.client()

        update_data = {}
        for field in ('chatPrompt', 'analysisPrompt', 'useCustomChat', 'useCustomAnalysis'):
            if field in body:
                update_data[field] = body[field]

        update_data['updatedAt'] = datetime.now(timezone.utc).isoformat()
        db.document('config/ai-prompts').set(update_data, merge=True)

        lank_audit.log_change(
            db, source='manual', action='update_ai_prompts',
            description=f'System prompts actualizados: {list(update_data.keys())}',
            actor='admin',
        )

        return https_fn.Response(
            json.dumps({'success': True}),
            content_type='application/json',
        )
    except Exception as e:
        return https_fn.Response(
            json.dumps({'success': False, 'error': str(e)}),
            status=500, content_type='application/json',
        )


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def manage_ai_models(req: https_fn.Request) -> https_fn.Response:
    """Add or remove custom AI models from the list."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        body = req.get_json(silent=True) or {}
        action = body.get('action')  # 'add' | 'remove'
        model_id = body.get('modelId', '').strip()
        model_label = body.get('modelLabel', '').strip()
        db = firestore.client()

        models_doc = db.document('config/ai-models').get()
        models = models_doc.to_dict().get('models', []) if models_doc.exists else []

        if action == 'add':
            if not model_id:
                return https_fn.Response(
                    json.dumps({'success': False, 'error': 'modelId requerido'}),
                    status=400, content_type='application/json',
                )
            # No duplicados
            if any(m['value'] == model_id for m in models):
                return https_fn.Response(
                    json.dumps({'success': False, 'error': 'Modelo ya existe'}),
                    status=400, content_type='application/json',
                )
            models.append({
                'value': model_id,
                'label': model_label or model_id,
                'addedAt': datetime.now(timezone.utc).isoformat(),
            })

        elif action == 'remove':
            models = [m for m in models if m['value'] != model_id]

        else:
            return https_fn.Response(
                json.dumps({'success': False, 'error': 'action debe ser add o remove'}),
                status=400, content_type='application/json',
            )

        db.document('config/ai-models').set({'models': models, 'updatedAt': datetime.now(timezone.utc).isoformat()})

        lank_audit.log_change(
            db, source='manual', action=f'{action}_ai_model',
            description=f'Modelo IA {action}: {model_id}',
            actor='admin',
        )

        return https_fn.Response(
            json.dumps({'success': True, 'models': models}),
            content_type='application/json',
        )
    except Exception as e:
        return https_fn.Response(
            json.dumps({'success': False, 'error': str(e)}),
            status=500, content_type='application/json',
        )


# â"€â"€â"€ AUDIT LOG (Dashboard) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
    timeout_sec=30,
    memory=options.MemoryOption.MB_256,
)
def get_audit_log(req: https_fn.Request) -> https_fn.Response:
    """Lee las Ãºltimas entradas del audit-log para el dashboard.

    Filtra en memoria para evitar necesidad de Ã­ndices compuestos en Firestore.

    Query params:
        limit: int (default 50, max 200)
        source: str (filtro por fuente: ai_analysis, ai_chat, manual, system)
        actor: str (filtro por actor: admin, ai, system)
        action: str (filtro por acciÃ³n: create_alert, remove_user, etc.)
    """
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()
        limit = min(int(req.args.get('limit', 50)), 200)
        source_filter = req.args.get('source', '').strip()
        actor_filter = req.args.get('actor', '').strip()
        action_filter = req.args.get('action', '').strip()

        # Leer los Ãºltimos 100 docs sin filtros compuestos (evita error de Ã­ndice)
        from google.cloud.firestore_v1 import Query as FsQuery
        docs = list(
            db.collection('audit-log')
            .order_by('timestamp', direction=FsQuery.DESCENDING)
            .limit(200)
            .stream()
        )

        entries = []
        for d in docs:
            data = d.to_dict()
            data['id'] = d.id
            # Filtrar en memoria
            if source_filter and data.get('source', '') != source_filter:
                continue
            if actor_filter and data.get('actor', '') != actor_filter:
                continue
            if action_filter and data.get('action', '') != action_filter:
                continue
            entries.append(data)
            if len(entries) >= limit:
                break

        return https_fn.Response(
            json.dumps({'entries': entries, 'total': len(entries)}, default=str),
            content_type='application/json',
        )

    except Exception as e:
        traceback.print_exc()
        return https_fn.Response(
            json.dumps({'error': str(e)}),
            status=500, content_type='application/json',
        )


# â"€â"€â"€ AI CHAT â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
    timeout_sec=180,
    memory=options.MemoryOption.MB_256,
)
def chat_ai(req: https_fn.Request) -> https_fn.Response:
    """Chat interactivo con Gemini AI.

    Body: {
        message: str,           # Mensaje del usuario
        chatHistory: [ { role: str, content: str } ],  # Historial (opcional)
        includeContext: bool,    # Si incluir contexto del sistema (default: true)
    }
    """
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)

    try:
        db = firestore.client()
        body = req.get_json(silent=True) or {}
        message = body.get('message', '').strip()

        if not message:
            return https_fn.Response(
                json.dumps({'error': 'Mensaje vacÃ­o'}),
                status=400, content_type='application/json',
            )

        ai_client = lank_ai.GeminiClient(db)

        if not ai_client.is_chat_enabled:
            return https_fn.Response(
                json.dumps({
                    'response': 'El chat con IA estÃ¡ deshabilitado. ActÃ­valo en ConfiguraciÃ³n de IA.',
                    'error': True,
                }),
                content_type='application/json',
            )

        # Preparar el mensaje con contexto del sistema
        # Usar historial compartido de Firestore (no el del request)
        include_context = body.get('includeContext', True)
        original_message = message  # Guardar texto original antes de inyectar contexto

        # Leer historial compartido en vez de confiar solo en el frontend
        history_doc = db.document('chat/history').get()
        shared_messages = []
        if history_doc.exists:
            shared_messages = history_doc.to_dict().get('messages', [])

        # Construir chatHistory para la IA (Ãºltimos 20 mensajes)
        chat_history = [{'role': m.get('role', 'user'), 'content': m.get('content', '')}
                        for m in shared_messages[-20:]]

        if include_context:
            # Inyectar contexto actual del sistema en cada mensaje
            context_prefix = _build_chat_context(db)
            if context_prefix:
                message = f"[CONTEXTO DEL SISTEMA ACTUAL]\n{context_prefix}\n\n[MENSAJE DEL ADMIN]\n{message}"

        # Enviar a Gemini con el executor de herramientas reales
        result = ai_client.chat(
            message=message,
            chat_history=chat_history,
            tool_executor=lambda fcs: _execute_chat_functions(db, fcs),
        )

        # Guardar mensajes en historial compartido
        ai_response = result.get('response', '')
        user_msg = {'role': 'user', 'content': original_message, 'source': 'dashboard',
                    'timestamp': datetime.now(timezone.utc).isoformat()}
        ai_msg = {'role': 'assistant', 'content': ai_response, 'source': 'dashboard',
                  'timestamp': datetime.now(timezone.utc).isoformat(),
                  'thinking': result.get('thinking')}

        updated_messages = shared_messages + [user_msg, ai_msg]
        updated_messages = updated_messages[-50:]  # MÃ¡ximo 50 mensajes

        db.document('chat/history').set({
            'messages': updated_messages,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
        })

        # Registrar en audit-log
        lank_audit.log_change(
            db,
            source='ai_chat',
            action='chat_message',
            description=f'Chat: "{original_message[:80]}..."' if len(original_message) > 80 else f'Chat: "{original_message}"',
            actor='admin',
            ai_involved=True,
            ai_model=ai_client.settings.get('chatModel', 'unknown'),
        )

        # Los function calls ya se ejecutaron en el agentic loop dentro de ai_client.chat()
        # Solo registrar en el audit si hubo acciones de escritura

        return https_fn.Response(
            json.dumps(result, default=str),
            content_type='application/json',
        )

    except Exception as e:
        traceback.print_exc()
        return https_fn.Response(
            json.dumps({'response': f'Error interno: {str(e)}', 'error': True}),
            status=500, content_type='application/json',
        )


def _build_chat_context(db):
    """Construye un resumen completo del sistema para el contexto del chat.

    Lee datos reales de Firestore para que la IA tenga informaciÃ³n actualizada
    y no invente datos. Incluye: Ãºltimo anÃ¡lisis, alertas pendientes,
    servicios activos, y total de cuentas.
    """
    try:
        parts = []

        # â"€â"€ Hora actual en zona horaria fija UTC-6 (MÃ©xico) â"€â"€
        mx_tz = timezone(timedelta(hours=-6))
        now_mx = datetime.now(mx_tz)
        parts.append(
            f"FECHA Y HORA ACTUAL: {now_mx.strftime('%A %d de %B de %Y, %I:%M %p')} "
            f"(MÃ©xico, UTC-6)\n"
            f"NOTA: Todos los timestamps del sistema estÃ¡n almacenados en UTC. "
            f"SIEMPRE convierte a hora de MÃ©xico (UTC-6 fijo, sin horario de verano) "
            f"antes de mostrar cualquier hora al admin."
        )

        # â"€â"€ ConfiguraciÃ³n del anÃ¡lisis programado (schedule) â"€â"€
        try:
            sched_doc = db.document('config/schedule').get()
            if sched_doc.exists:
                sched = sched_doc.to_dict()
                sched_enabled = sched.get('enabled', False)
                freq_hours = sched.get('frequencyHours', 6)
                start_time_str = sched.get('startTime', '')
                active_hours = sched.get('activeHours', {})
                ah_enabled = active_hours.get('enabled', False)
                ah_start = active_hours.get('startHour', 6)
                ah_end = active_hours.get('endHour', 22)

                # Calcular prÃ³ximo anÃ¡lisis
                next_analysis_str = 'No calculable'
                if sched_enabled and start_time_str:
                    try:
                        start_dt = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
                        now_utc = datetime.now(timezone.utc)
                        # Calcular siguiente slot desde startTime
                        if start_dt > now_utc:
                            next_utc = start_dt
                        else:
                            elapsed = (now_utc - start_dt).total_seconds()
                            intervals = int(elapsed / (freq_hours * 3600)) + 1
                            next_utc = start_dt + timedelta(hours=freq_hours * intervals)

                        # Verificar si cae dentro del horario activo
                        if ah_enabled:
                            next_mx_h = next_utc.astimezone(mx_tz).hour
                            while next_mx_h < ah_start or next_mx_h >= ah_end:
                                next_utc += timedelta(hours=freq_hours)
                                next_mx_h = next_utc.astimezone(mx_tz).hour

                        next_analysis_str = next_utc.astimezone(mx_tz).strftime('%d/%m/%Y %I:%M %p') + ' (UTC-6)'
                    except Exception:
                        pass

                start_local = 'N/A'
                if start_time_str:
                    try:
                        st_dt = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
                        start_local = st_dt.astimezone(mx_tz).strftime('%d/%m/%Y %I:%M %p') + ' (UTC-6)'
                    except Exception:
                        start_local = start_time_str

                parts.append(
                    f"\nANÃLISIS PROGRAMADO:\n"
                    f"  Estado: {'âœ… Habilitado' if sched_enabled else 'âŒ Deshabilitado'}\n"
                    f"  Frecuencia: Cada {freq_hours} hora(s)\n"
                    f"  Hora de inicio configurada: {start_local}\n"
                    f"  Horario activo: {'SÃ­, de ' + str(ah_start) + ':00 a ' + str(ah_end) + ':00 (hora MX)' if ah_enabled else 'Desactivado (corre 24h)'}\n"
                    f"  PrÃ³ximo anÃ¡lisis estimado: {next_analysis_str}"
                )
            else:
                parts.append("\nANÃLISIS PROGRAMADO: No configurado.")
        except Exception as e:
            parts.append(f"\nANÃLISIS PROGRAMADO: Error al leer config: {e}")

        # â"€â"€ Ãšltimo reporte de anÃ¡lisis de correos â"€â"€
        report_doc = db.document('analysis/latest-report').get()
        if report_doc.exists:
            rpt = report_doc.to_dict()
            total = rpt.get('totalAccounts', 0)
            ok = rpt.get('accountsOk', 0)
            failed = total - ok
            gen_at = rpt.get('generatedAt', 'N/A')
            # Convertir generatedAt a hora local de MÃ©xico si es posible
            gen_at_local = gen_at
            try:
                if isinstance(gen_at, str) and gen_at != 'N/A':
                    dt = datetime.fromisoformat(gen_at.replace('Z', '+00:00'))
                    gen_at_local = dt.astimezone(mx_tz).strftime('%d/%m/%Y %I:%M %p') + ' (UTC-6)'
            except Exception:
                pass
            parts.append(
                f"ÃšLTIMO ANÃLISIS DE CORREOS (ejecutado: {gen_at_local}):\n"
                f"  Cuentas analizadas: {ok}/{total} OK\n"
                f"  Pendientes detectados: {rpt.get('totalPending', 0)}\n"
                f"  Alertas generadas: {rpt.get('alertsGenerated', 0)}"
            )
            # Detalle de cuentas fallidas
            failed_list = rpt.get('failedAccounts', [])
            if failed_list:
                parts.append(f"  CUENTAS CON FALLO ({len(failed_list)}):")
                for fa in failed_list:
                    parts.append(
                        f"    - Cuenta #{fa.get('accountId', '?')} ({fa.get('accountAlias', 'sin alias')}): "
                        f"{fa.get('access', '?')} -  {fa.get('error', 'sin detalle')}"
                    )
            elif failed > 0:
                parts.append(f"  NOTA: {failed} cuenta(s) fallaron pero no hay detalle almacenado.")
        else:
            parts.append("ÃšLTIMO ANÃLISIS DE CORREOS: No hay reportes disponibles.")

        # â"€â"€ Alertas pendientes (documentos individuales en coleccion alerts/) â"€â"€
        try:
            alerts_query = db.collection('alerts').where('status', '==', 'pending').stream()
            pending_alerts = []
            for doc in alerts_query:
                a = doc.to_dict()
                pending_alerts.append(a)

            if pending_alerts:
                parts.append(f"\nALERTAS PENDIENTES ({len(pending_alerts)}):")
                for a in pending_alerts:
                    account_info = f"Cuenta #{a.get('accountId', '?')} {a.get('accountAlias', '')}".strip()
                    parts.append(
                        f"  - [{a.get('priority', '?').upper()}] {a.get('title', 'Sin tÃ­tulo')}\n"
                        f"    Tipo: {a.get('type', '?')} | Servicio: {a.get('service', '?')} | {account_info}\n"
                        f"    Descripcion: {a.get('description', 'sin descripciÃ³n')}\n"
                        f"    Usuario: {a.get('userAlias', 'desconocido')} | Fuente: {a.get('source', '?')} | Fecha: {a.get('createdAt', '?')}"
                    )
            else:
                parts.append("\nALERTAS PENDIENTES: 0 alertas pendientes.")
        except Exception as e:
            parts.append(f"\nALERTAS: Error al leer alertas: {e}")

        # â"€â"€ Resumen de alertas por estado â"€â"€
        all_alerts_dicts = []
        try:
            all_alerts = list(db.collection('alerts').stream())
            all_alerts_dicts = [d.to_dict() for d in all_alerts]
            total_alerts = len(all_alerts_dicts)
            status_counts = {}
            for a in all_alerts_dicts:
                status = a.get('status', 'unknown')
                status_counts[status] = status_counts.get(status, 0) + 1
            parts.append(
                f"\nRESUMEN DE ALERTAS (total: {total_alerts}): "
                + ', '.join(f"{s}: {c}" for s, c in sorted(status_counts.items()))
            )
        except Exception:
            pass

        # â"€â"€ Historial de cambios reciente (Audit Log) â"€â"€
        try:
            recent_audit = lank_audit.load_recent_entries(db, limit=30)
            if recent_audit:
                parts.append(f"\nHISTORIAL DE CAMBIOS RECIENTE ({len(recent_audit)} Ãºltimas acciones):")
                for entry in recent_audit[:30]:
                    ts = entry.get('timestamp', '?')
                    actor = entry.get('actor', '?')
                    action = entry.get('action', '?')
                    desc = entry.get('description', '')
                    source = entry.get('source', '?')
                    parts.append(
                        f"  - [{ts}] ({actor}/{source}) {action}: {desc[:120]}"
                    )
                    # Mostrar before/after si existen (para cambios de datos)
                    before = entry.get('before')
                    after = entry.get('after')
                    if before or after:
                        parts.append(f"    Antes: {str(before)[:100]} â†’ DespuÃ©s: {str(after)[:100]}")
            else:
                parts.append("\nHISTORIAL DE CAMBIOS: Sin cambios registrados.")
        except Exception as e:
            parts.append(f"\nHISTORIAL: Error al leer audit-log: {e}")

        # â"€â"€ Eventos accionables del anÃ¡lisis de correos â"€â"€
        try:
            events_doc = db.document('analysis/actionable-events').get()
            if events_doc.exists:
                events = events_doc.to_dict().get('events', [])
                if events:
                    # Filtrar los que ya tienen alerta pendiente en Firestore
                    pending_dicts = [a for a in all_alerts_dicts
                                     if a.get('status') in (None, 'pending')]
                    extra_events = []
                    for evt in events:
                        already_exists = any(
                            a.get('userAlias') == evt.get('userName') and
                            str(a.get('accountId', '')) == str(evt.get('accountId', '')) and
                            a.get('service') == evt.get('subscription')
                            for a in pending_dicts
                        )
                        if not already_exists:
                            extra_events.append(evt)

                    if extra_events:
                        parts.append(f"\nEVENTOS PENDIENTES DEL ANÃLISIS ({len(extra_events)}):")
                        for evt in extra_events:
                            parts.append(
                                f"  - {evt.get('userName', '?')} -  {evt.get('subscription', '?')}\n"
                                f"    Cuenta #{evt.get('accountId', '?')} ({evt.get('accountAlias', '?')})\n"
                                f"    Accion: {evt.get('action', '?')} | Motivo: {evt.get('reason', '?')}\n"
                                f"    Fecha: {evt.get('date', '?')}"
                            )
        except Exception:
            pass

        # â"€â"€ Reporte de IA segunda capa â"€â"€
        try:
            ai_report_doc = db.document('analysis/ai-report').get()
            if ai_report_doc.exists:
                ai_rpt = ai_report_doc.to_dict()
                ai_status = ai_rpt.get('status', 'unknown')
                ai_gen = ai_rpt.get('generatedAt', 'N/A')
                if ai_status == 'success':
                    parts.append(
                        f"\nIA SEGUNDA CAPA (Ãºltima ejecuciÃ³n: {ai_gen}):\n"
                        f"  Estado: Exitoso\n"
                        f"  Modelo: {ai_rpt.get('model', '?')}\n"
                        f"  Correos analizados: {ai_rpt.get('emailsAnalyzed', 0)}\n"
                        f"  Resumen: {ai_rpt.get('naturalSummary', 'Sin resumen')}\n"
                        f"  Confianza: {ai_rpt.get('overallConfidence', 0):.0%}"
                    )
                elif ai_status == 'skipped':
                    parts.append(
                        f"\nIA SEGUNDA CAPA (Ãºltima ejecuciÃ³n: {ai_gen}):\n"
                        f"  Estado: Omitida -  {ai_rpt.get('reason', 'sin motivo')}"
                    )
                elif ai_status == 'error':
                    parts.append(
                        f"\nIA SEGUNDA CAPA (Ãºltima ejecuciÃ³n: {ai_gen}):\n"
                        f"  Estado: Error -  {ai_rpt.get('error', 'desconocido')}"
                    )
                elif ai_status == 'disabled':
                    parts.append(
                        f"\nIA SEGUNDA CAPA: Deshabilitada en configuraciÃ³n."
                    )
        except Exception:
            pass

        # â"€â"€ Servicios/grupos activos â"€â"€
        try:
            groups_docs = db.collection('groups').stream()
            services = []
            for doc in groups_docs:
                g = doc.to_dict()
                services.append({
                    'id': doc.id,
                    'name': g.get('serviceName', doc.id),
                    'totalAccounts': g.get('totalAccounts', 0),
                })
            if services:
                parts.append("\nSERVICIOS GESTIONADOS:")
                for s in services:
                    parts.append(f"  - {s['name']} (ID: {s['id']}, cuentas Lank: {s['totalAccounts']})")
        except Exception:
            pass

        # â"€â"€ Total de cuentas Lank en el registro â"€â"€
        try:
            registry_doc = db.document('config/account-registry').get()
            if registry_doc.exists:
                reg = registry_doc.to_dict().get('accounts', [])
                parts.append(f"\nTOTAL CUENTAS EN REGISTRO: {len(reg)}")
        except Exception:
            pass

        # â"€â"€ Recordatorio anti-alucinaciÃ³n â"€â"€
        parts.append(
            "\nIMPORTANTE: Toda la informaciÃ³n anterior es REAL y actualizada de Firestore. "
            "Si el admin pregunta algo que NO aparece en este contexto, NO inventes datos. "
            "Responde que no tienes esa informaciÃ³n disponible en el contexto actual."
        )

        return '\n'.join(parts) if parts else None
    except Exception as e:
        return f"Error al cargar contexto: {e}"


def _execute_chat_functions(db, function_calls):
    """Ejecuta function calls solicitadas por la IA.

    Soporta acciones de lectura y escritura con trazabilidad total (audit-log).
    Cada acciÃ³n de escritura se registra con before/after para reversibilidad.
    """
    results = []
    for fc in function_calls:
        name = fc.get('name', '')
        args = fc.get('args', {})

        try:
            # â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
            # LECTURA: Datos del sistema
            # â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

            if name == 'get_alerts':
                status_filter = args.get('status', 'pending')
                query = db.collection('alerts').where('status', '==', status_filter).stream()
                filtered = [{'id': d.id, **d.to_dict()} for d in query]
                results.append({'function': name, 'success': True, 'data': filtered[:30]})

            elif name == 'get_lank_accounts':
                # Lee todas las cuentas Lank de un servicio con detalle completo
                service = args.get('service', '')
                docs = list(db.collection(f'groups/{service}/lank-accounts').stream())
                accounts = []
                for d in docs:
                    data = d.to_dict()
                    # Convertir users en formato legible
                    users = data.get('users', [])
                    user_list = []
                    for u in (users if isinstance(users, list) else []):
                        user_list.append({
                            'alias': u.get('userAlias', ''),
                            'status': u.get('serviceStatus', ''),
                            'slot': u.get('serviceSlotNumber', ''),
                            'accountRef': u.get('serviceAccountRef', ''),
                            'label': u.get('serviceLabel', ''),
                            'cancelOn': u.get('cancelOn', ''),
                            'matchStatus': u.get('matchStatus', ''),
                            'phone': u.get('phone', ''),
                            'userEmail': u.get('userEmail', ''),
                            'profileName': u.get('profileName', ''),
                            'projectName': u.get('projectName', ''),
                            'invitationEmail': u.get('invitationEmail', ''),
                            'renewDay': u.get('renewDay', ''),
                        })
                    accounts.append({
                        'id': d.id,
                        'accountId': data.get('accountId'),
                        'alias': data.get('accountAlias', ''),
                        'fullName': data.get('fullName', ''),
                        'groupStatus': data.get('groupStatus', ''),
                        'cashback': data.get('cashback', False),
                        'hasUsers': data.get('hasUsers', False),
                        'subscriptionActive': data.get('subscriptionActive', False),
                        'users': user_list,
                        'notes': data.get('notes', []),
                    })
                results.append({'function': name, 'success': True, 'data': accounts, 'total': len(accounts)})

            elif name == 'get_lank_account':
                # Lee UNA cuenta Lank por ID
                service = args.get('service', '')
                account_id = str(args.get('accountId', ''))
                doc_ref = db.document(f'groups/{service}/lank-accounts/{account_id}')
                doc_snap = doc_ref.get()
                if doc_snap.exists:
                    data = doc_snap.to_dict()
                    results.append({'function': name, 'success': True, 'data': {'id': doc_snap.id, **data}})
                else:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta {account_id} no encontrada en {service}'})

            elif name == 'get_real_accounts':
                # Lee las cuentas reales (pools) de un servicio
                service = args.get('service', '')
                docs = list(db.collection(f'service-pools/{service}/real-accounts').stream())
                pools = []
                for d in docs:
                    data = d.to_dict()
                    slots = data.get('slots', [])
                    slot_summary = []
                    free_count = 0
                    for idx, s in enumerate(slots if isinstance(slots, list) else []):
                        slot_status = s.get('status', '')
                        if slot_status == 'free':
                            free_count += 1
                        slot_summary.append({
                            'slotIndex': idx,  # Ãndice 0-based para update_real_account_slot
                            'slotNumber': s.get('slotNumber', ''),
                            'status': slot_status,
                            'memberAlias': s.get('memberAlias', ''),
                            'memberEmail': s.get('memberEmail', ''),
                            'profileName': s.get('profileName', ''),
                            'projectName': s.get('projectName', ''),
                        })
                    # accountStatus distingue legacy de activa
                    account_status = data.get('status', 'unknown')
                    pools.append({
                        'id': d.id,
                        'ref': data.get('serviceAccountRef', d.id),
                        'label': data.get('label', ''),
                        'email': data.get('email', ''),
                        'accountStatus': account_status,
                        'isLegacy': account_status.startswith('legacy'),
                        'occupiedSlots': data.get('occupiedSlots', 0),
                        'actualCapacity': data.get('actualCapacity', 0),
                        'targetCapacity': data.get('targetCapacity', 0),
                        'freeSlots': free_count,
                        'slots': slot_summary,
                    })
                # Ordenar: activas primero, luego legacy
                pools.sort(key=lambda p: (p['isLegacy'], -p['freeSlots']))
                results.append({'function': name, 'success': True, 'data': pools, 'total': len(pools)})

            elif name == 'get_audit_log':
                # Obtener Ãºltimos N cambios
                limit = int(args.get('limit', 30))
                entries = lank_audit.load_recent_entries(db, limit=min(limit, 200))
                results.append({'function': name, 'success': True, 'data': entries, 'total': len(entries)})

            elif name == 'search_user':
                # Buscar usuario por alias en todas las cuentas Lank de todos los servicios
                alias = (args.get('alias', '') or '').lower().strip()
                if not alias:
                    results.append({'function': name, 'success': False, 'error': 'Se requiere el alias del usuario'})
                    continue
                found = []
                services = [d.id for d in db.collection('groups').stream()]
                for svc in services:
                    accounts = db.collection(f'groups/{svc}/lank-accounts').stream()
                    for acct_doc in accounts:
                        acct = acct_doc.to_dict()
                        for u in (acct.get('users', []) if isinstance(acct.get('users'), list) else []):
                            if alias in (u.get('userAlias', '') or '').lower():
                                found.append({
                                    'service': svc,
                                    'accountId': acct.get('accountId', acct_doc.id),
                                    'accountAlias': acct.get('accountAlias', ''),
                                    'user': u,
                                })
                results.append({'function': name, 'success': True, 'data': found, 'total': len(found)})

            # â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
            # ESCRITURA: Acciones con audit trail
            # â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

            elif name == 'complete_alert':
                alert_id = args.get('alertId', '')
                resolution = args.get('resolution', 'Completada por IA')
                doc_ref = db.document(f'alerts/{alert_id}')
                snap = doc_ref.get()
                if snap.exists:
                    before = snap.to_dict()
                    doc_ref.update({
                        'status': 'done',
                        'resolution': resolution,
                        'completedAt': datetime.now(timezone.utc).isoformat(),
                        'completedBy': 'ai_chat',
                    })
                    lank_audit.log_ai_chat_action(
                        db, action='complete_alert',
                        description=f'Alerta {alert_id} completada: {resolution}',
                        collection='alerts', document_id=alert_id,
                        before={'status': before.get('status')},
                        after={'status': 'done', 'resolution': resolution},
                    )
                    results.append({'function': name, 'success': True, 'message': f'Alerta {alert_id} completada'})
                else:
                    results.append({'function': name, 'success': False, 'error': f'Alerta {alert_id} no encontrada'})

            elif name == 'update_lank_account':
                # Actualiza campos de una cuenta Lank (alias, fullName, notes, etc.)
                service = args.get('service', '')
                account_id = str(args.get('accountId', ''))
                updates = args.get('updates', {})
                # Campos permitidos
                allowed = {'accountAlias', 'fullName', 'cashback', 'cashbackEligible',
                           'groupStatus', 'subscriptionActive', 'notes'}
                safe_updates = {k: v for k, v in updates.items() if k in allowed}
                if not safe_updates:
                    results.append({'function': name, 'success': False, 'error': 'No hay campos vÃ¡lidos para actualizar'})
                    continue
                path = f'groups/{service}/lank-accounts/{account_id}'
                doc_ref = db.document(path)
                snap = doc_ref.get()
                if snap.exists:
                    before = {k: snap.to_dict().get(k) for k in safe_updates}
                    safe_updates['updatedAt'] = datetime.now(timezone.utc).isoformat()
                    doc_ref.update(safe_updates)
                    lank_audit.log_ai_chat_action(
                        db, action='update_lank_account',
                        description=f'Cuenta Lank {account_id} ({service}) actualizada: {list(safe_updates.keys())}',
                        collection=path, document_id=account_id,
                        before=before, after=safe_updates,
                    )
                    results.append({'function': name, 'success': True, 'message': f'Cuenta {account_id} actualizada'})
                else:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta {account_id} no encontrada en {service}'})

            elif name == 'remove_user_from_account':
                # Elimina un usuario de una cuenta Lank
                service = args.get('service', '')
                account_id = str(args.get('accountId', ''))
                user_alias = args.get('userAlias', '')
                path = f'groups/{service}/lank-accounts/{account_id}'
                doc_ref = db.document(path)
                snap = doc_ref.get()
                if not snap.exists:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta {account_id} no encontrada en {service}'})
                    continue
                data = snap.to_dict()
                users = data.get('users', [])
                if not isinstance(users, list):
                    results.append({'function': name, 'success': False, 'error': 'Estructura de usuarios invÃ¡lida'})
                    continue
                # Encontrar usuario
                new_users = [u for u in users if (u.get('userAlias', '') or '').lower() != user_alias.lower()]
                if len(new_users) == len(users):
                    results.append({'function': name, 'success': False, 'error': f'Usuario {user_alias} no encontrado en cuenta {account_id}'})
                    continue
                removed = [u for u in users if (u.get('userAlias', '') or '').lower() == user_alias.lower()]
                doc_ref.update({
                    'users': new_users,
                    'hasUsers': len(new_users) > 0,
                    'updatedAt': datetime.now(timezone.utc).isoformat(),
                })
                lank_audit.log_ai_chat_action(
                    db, action='remove_user',
                    description=f'Usuario {user_alias} eliminado de cuenta {account_id} ({service})',
                    collection=path, document_id=account_id,
                    field='users',
                    before={'users': removed, 'totalUsers': len(users)},
                    after={'totalUsers': len(new_users)},
                )
                results.append({'function': name, 'success': True, 'message': f'Usuario {user_alias} eliminado de cuenta {account_id}'})

            elif name == 'add_user_to_account':
                # Agrega un usuario a una cuenta Lank
                service = args.get('service', '')
                account_id = str(args.get('accountId', ''))
                user_data = args.get('userData', {})
                if not user_data.get('userAlias'):
                    results.append({'function': name, 'success': False, 'error': 'Se requiere userAlias'})
                    continue
                path = f'groups/{service}/lank-accounts/{account_id}'
                doc_ref = db.document(path)
                snap = doc_ref.get()
                if not snap.exists:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta {account_id} no encontrada en {service}'})
                    continue
                data = snap.to_dict()
                users = data.get('users', [])
                if not isinstance(users, list):
                    users = []
                # Verificar que no exista ya
                if any((u.get('userAlias', '') or '').lower() == user_data['userAlias'].lower() for u in users):
                    results.append({'function': name, 'success': False, 'error': f'Usuario {user_data["userAlias"]} ya existe en cuenta {account_id}'})
                    continue
                new_user = {
                    'userAlias': user_data['userAlias'],
                    'serviceStatus': user_data.get('serviceStatus', 'active'),
                    'serviceAccountRef': user_data.get('serviceAccountRef', ''),
                    'serviceAccountLabel': user_data.get('serviceAccountLabel', ''),
                    'serviceLabel': user_data.get('serviceLabel', ''),
                    'serviceSlotNumber': user_data.get('serviceSlotNumber', 0),
                    'cancelOn': user_data.get('cancelOn', 'N/D'),
                    # matchStatus y matchConfidence LOS ESCRIBE SOLO el sistema de anÃ¡lisis
                    # automÃ¡tico de correos. NO los aÃ±adir aquÃ­ para no interferir con la UI.
                }
                # Agregar projectName solo si fue proporcionado
                if user_data.get('projectName'):
                    new_user['projectName'] = user_data['projectName']
                # Agregar renewDay si fue proporcionado (obligatorio para servicios renewal-based)
                if user_data.get('renewDay'):
                    new_user['renewDay'] = int(user_data['renewDay'])
                # Agregar invitationEmail si fue proporcionado
                if user_data.get('invitationEmail'):
                    new_user['invitationEmail'] = user_data['invitationEmail']
                # Agregar phone si fue proporcionado
                if user_data.get('phone'):
                    new_user['phone'] = user_data['phone']
                # Agregar userEmail si fue proporcionado
                if user_data.get('userEmail'):
                    new_user['userEmail'] = user_data['userEmail']
                # Agregar profileName si fue proporcionado
                if user_data.get('profileName'):
                    new_user['profileName'] = user_data['profileName']
                # Limpiar campos vacÃ­os opcionales
                new_user = {k: v for k, v in new_user.items() if v not in (None, '', 0) or k in ('userAlias', 'serviceStatus', 'cancelOn')}
                users.append(new_user)
                doc_ref.update({
                    'users': users,
                    'hasUsers': True,
                    'updatedAt': datetime.now(timezone.utc).isoformat(),
                })
                lank_audit.log_ai_chat_action(
                    db, action='add_user',
                    description=f'Usuario {new_user["userAlias"]} agregado a cuenta {account_id} ({service})',
                    collection=path, document_id=account_id,
                    field='users',
                    after={'addedUser': new_user, 'totalUsers': len(users)},
                )
                results.append({'function': name, 'success': True, 'message': f'Usuario {new_user["userAlias"]} agregado a cuenta {account_id}'})

            elif name == 'update_user_in_account':
                # Edita campos de un usuario existente en una cuenta Lank
                service = args.get('service', '')
                account_id = str(args.get('accountId', ''))
                current_alias = args.get('currentAlias', '')
                user_updates = args.get('updates', {})
                if not current_alias or not user_updates:
                    results.append({'function': name, 'success': False, 'error': 'Se requiere currentAlias y updates'})
                    continue
                path = f'groups/{service}/lank-accounts/{account_id}'
                doc_ref = db.document(path)
                snap = doc_ref.get()
                if not snap.exists:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta {account_id} no encontrada en {service}'})
                    continue
                data = snap.to_dict()
                users = data.get('users', [])
                # Encontrar el usuario por alias actual
                user_idx = None
                for i, u in enumerate(users):
                    if (u.get('userAlias', '') or '').lower() == current_alias.lower():
                        user_idx = i
                        break
                if user_idx is None:
                    results.append({'function': name, 'success': False, 'error': f'Usuario "{current_alias}" no encontrado en cuenta {account_id}'})
                    continue
                before_user = dict(users[user_idx])
                # Campos permitidos para actualizar (NO matchStatus ni matchConfidence)
                allowed_user_fields = {
                    'userAlias', 'projectName', 'serviceStatus', 'serviceAccountRef',
                    'serviceAccountLabel', 'serviceLabel', 'serviceSlotNumber', 'cancelOn',
                    'renewDay', 'invitationEmail', 'phone', 'userEmail', 'profileName'
                }
                for k, v in user_updates.items():
                    if k in allowed_user_fields and v is not None:
                        users[user_idx][k] = v
                doc_ref.update({
                    'users': users,
                    'updatedAt': datetime.now(timezone.utc).isoformat(),
                })
                new_alias = user_updates.get('userAlias', current_alias)
                lank_audit.log_ai_chat_action(
                    db, action='update_user',
                    description=f'Usuario "{current_alias}" actualizado en cuenta {account_id} ({service}): {list(user_updates.keys())}',
                    collection=path, document_id=account_id,
                    field='users',
                    before={'user': before_user},
                    after={'user': users[user_idx], 'updatedFields': list(user_updates.keys())},
                )
                # â"€â"€â"€ SincronizaciÃ³n bidireccional: grupo â†’ cupo real â"€â"€â"€
                try:
                    updated_user = users[user_idx]
                    svc_account_ref = updated_user.get('serviceAccountRef', '')
                    user_alias_for_sync = updated_user.get('userAlias', '') or new_alias
                    sync_fields = {}
                    if 'projectName' in user_updates:
                        sync_fields['projectName'] = user_updates['projectName']
                    if 'userAlias' in user_updates:
                        sync_fields['memberAlias'] = user_updates['userAlias']
                    if sync_fields and user_alias_for_sync:
                        # Buscar cupo vinculado por serviceAccountRef o por alias en todas las cuentas
                        pool_coll = db.collection(f'service-pools/{service}/real-accounts')
                        found_slot = None
                        if svc_account_ref:
                            pool_doc = pool_coll.document(svc_account_ref).get()
                            if pool_doc.exists:
                                pool_slots = pool_doc.to_dict().get('slots', [])
                                for si, sl in enumerate(pool_slots):
                                    search_alias = current_alias if 'userAlias' not in user_updates else current_alias
                                    if (sl.get('memberAlias', '') or '').lower() == search_alias.lower():
                                        found_slot = (pool_doc.reference, pool_slots, si)
                                        break
                        if not found_slot:
                            # Fallback: buscar en todas las cuentas reales del servicio
                            for pdoc in pool_coll.stream():
                                pdata = pdoc.to_dict()
                                pslots = pdata.get('slots', [])
                                for si, sl in enumerate(pslots):
                                    if (sl.get('memberAlias', '') or '').lower() == current_alias.lower():
                                        found_slot = (pdoc.reference, pslots, si)
                                        break
                                if found_slot:
                                    break
                        if found_slot:
                            pref, pslots, pidx = found_slot
                            for k, v in sync_fields.items():
                                pslots[pidx][k] = v
                            occupied = sum(1 for s in pslots if (s.get('memberAlias', '') or '').strip())
                            pref.update({'slots': pslots, 'occupiedSlots': occupied, 'updatedAt': datetime.now(timezone.utc).isoformat()})
                except Exception as sync_err:
                    # No bloquear la operaciÃ³n principal si la sincronizaciÃ³n falla
                    pass

                # â"€â"€â"€ Auto-completar alerta missing_phone si se agregÃ³ telÃ©fono â"€â"€â"€
                if 'phone' in user_updates and user_updates['phone']:
                    try:
                        pending_alerts = db.collection('alerts') \
                            .where('status', '==', 'pending') \
                            .where('type', '==', 'missing_phone') \
                            .where('userAlias', '==', current_alias) \
                            .where('accountId', '==', str(account_id)) \
                            .stream()
                        for alert_doc in pending_alerts:
                            alert_doc.reference.update({
                                'status': 'completed',
                                'completedAt': datetime.now(timezone.utc).isoformat(),
                                'completedBy': 'ai_chat',
                                'phone': user_updates['phone'],
                                'resolution': f'TelÃ©fono {user_updates["phone"]} registrado por IA',
                            })
                            lank_audit.log_ai_chat_action(
                                db, action='complete_alert',
                                description=f'Alerta missing_phone completada automÃ¡ticamente para {current_alias} (cuenta {account_id})',
                                collection='alerts', document_id=alert_doc.id,
                                before={'status': 'pending'}, after={'status': 'completed'},
                            )
                    except Exception:
                        pass

                results.append({'function': name, 'success': True, 'message': f'Usuario "{current_alias}" actualizado correctamente (ahora: "{new_alias}")'})

            elif name == 'restore_from_audit':
                # Restaura un valor anterior usando datos del audit log
                audit_id = args.get('auditId', '')
                audit_doc = db.document(f'audit-log/{audit_id}').get()
                if not audit_doc.exists:
                    results.append({'function': name, 'success': False, 'error': f'Registro de auditorÃ­a {audit_id} no encontrado'})
                    continue
                entry = audit_doc.to_dict()
                before_val = entry.get('before')
                coll_path = entry.get('collection', '')
                doc_id = entry.get('documentId', '')
                field = entry.get('field')
                if not before_val or not coll_path:
                    results.append({'function': name, 'success': False, 'error': 'El registro no tiene datos suficientes para restaurar (falta before o collection)'})
                    continue
                # Restaurar: escribir el before como el valor actual
                target_path = f'{coll_path}/{doc_id}' if doc_id and doc_id not in coll_path else coll_path
                target_ref = db.document(target_path)
                target_snap = target_ref.get()
                if not target_snap.exists:
                    results.append({'function': name, 'success': False, 'error': f'Documento {target_path} ya no existe'})
                    continue
                current = target_snap.to_dict()
                if field and isinstance(before_val, dict):
                    # Restaurar campo especÃ­fico
                    restore_data = {field: before_val.get(field, before_val)}
                elif isinstance(before_val, dict):
                    restore_data = before_val
                else:
                    restore_data = {field or 'value': before_val}
                restore_data['updatedAt'] = datetime.now(timezone.utc).isoformat()
                target_ref.update(restore_data)
                lank_audit.log_ai_chat_action(
                    db, action='restore',
                    description=f'RestauraciÃ³n desde audit {audit_id}: {target_path}',
                    collection=coll_path, document_id=doc_id, field=field,
                    before={k: current.get(k) for k in restore_data if k != 'updatedAt'},
                    after=restore_data,
                )
                results.append({'function': name, 'success': True, 'message': f'Datos restaurados desde audit {audit_id}'})

            elif name == 'create_alert':
                # Crea una nueva alerta
                alert_data = args.get('alertData', {})
                alert_id = f"ai_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
                alert_doc = {
                    'id': alert_id,
                    'title': alert_data.get('title', 'Alerta generada por IA'),
                    'description': alert_data.get('description', ''),
                    'type': alert_data.get('type', 'info'),
                    'priority': alert_data.get('priority', 'medium'),
                    'service': alert_data.get('service', ''),
                    'accountId': alert_data.get('accountId', ''),
                    'accountAlias': alert_data.get('accountAlias', ''),
                    'userAlias': alert_data.get('userAlias', ''),
                    'status': 'pending',
                    'source': 'ai_chat',
                    'createdAt': datetime.now(timezone.utc).isoformat(),
                }
                db.collection('alerts').document(alert_id).set(alert_doc)
                lank_audit.log_ai_chat_action(
                    db, action='create_alert',
                    description=f'Alerta creada por IA: {alert_doc["title"]}',
                    collection='alerts', document_id=alert_id,
                    after=alert_doc,
                )
                results.append({'function': name, 'success': True, 'message': f'Alerta {alert_id} creada', 'alertId': alert_id})

            elif name == 'update_real_account_slot':
                # Actualiza un slot/cupo especÃ­fico en una cuenta real de servicio
                service = args.get('service', '')
                account_ref = args.get('accountRef', '')
                slot_index = args.get('slotIndex')
                slot_updates = args.get('updates', {})

                if slot_index is None:
                    results.append({'function': name, 'success': False, 'error': 'Se requiere slotIndex'})
                    continue

                # Buscar el documento de la cuenta real por su serviceAccountRef o ID
                pool_ref = db.document(f'service-pools/{service}/real-accounts/{account_ref}')
                pool_snap = pool_ref.get()

                if not pool_snap.exists:
                    # Intentar buscar por campo serviceAccountRef
                    query = db.collection(f'service-pools/{service}/real-accounts') \
                               .where('serviceAccountRef', '==', account_ref).stream()
                    found_doc = None
                    for doc in query:
                        found_doc = doc
                        break
                    if found_doc:
                        pool_ref = found_doc.reference
                        pool_snap = found_doc
                    else:
                        results.append({'function': name, 'success': False,
                                       'error': f'Cuenta real {account_ref} no encontrada en {service}'})
                        continue

                pool_data = pool_snap.to_dict()
                slots = pool_data.get('slots', [])

                if not isinstance(slots, list) or slot_index >= len(slots):
                    results.append({'function': name, 'success': False,
                                   'error': f'slotIndex {slot_index} fuera de rango (la cuenta tiene {len(slots)} cupos)'})
                    continue

                before_slot = dict(slots[slot_index])

                # Campos permitidos para actualizar en un slot
                allowed_slot_fields = {'memberAlias', 'memberEmail', 'profileName', 'projectName',
                                       'status', 'assignedAt', 'assignedFrom', 'cancelOn', 'slotNumber'}
                for k, v in slot_updates.items():
                    if k in allowed_slot_fields:
                        slots[slot_index][k] = v

                # Actualizar ocupaciÃ³n -  el sistema usa 'active' para cupos ocupados (NO 'occupied')
                occupied = sum(1 for s in slots if s.get('status') in ('active', 'occupied'))

                pool_ref.update({
                    'slots': slots,
                    'occupiedSlots': occupied,
                    'updatedAt': datetime.now(timezone.utc).isoformat(),
                })

                lank_audit.log_ai_chat_action(
                    db, action='update_real_account_slot',
                    description=(
                        f'Cupo {slot_index + 1} de {account_ref} ({service}) actualizado: '
                        f'miembro={slot_updates.get("memberAlias", before_slot.get("memberAlias", "?"))}, '
                        f'proyecto={slot_updates.get("projectName", before_slot.get("projectName", "?"))}'
                    ),
                    collection=f'service-pools/{service}/real-accounts',
                    document_id=pool_ref.id,
                    field=f'slots[{slot_index}]',
                    before=before_slot,
                    after=dict(slots[slot_index]),
                )
                # â"€â"€â"€ SincronizaciÃ³n bidireccional: cupo real â†’ grupo Lank â"€â"€â"€
                try:
                    updated_slot = slots[slot_index]
                    assigned_from = updated_slot.get('assignedFrom') or before_slot.get('assignedFrom')
                    member_alias = updated_slot.get('memberAlias', '') or before_slot.get('memberAlias', '')
                    sync_user_fields = {}
                    if 'projectName' in slot_updates:
                        sync_user_fields['projectName'] = slot_updates['projectName']
                    if 'memberAlias' in slot_updates:
                        sync_user_fields['userAlias'] = slot_updates['memberAlias']
                    if 'memberEmail' in slot_updates:
                        sync_user_fields['userEmail'] = slot_updates['memberEmail']
                    if 'profileName' in slot_updates:
                        sync_user_fields['profileName'] = slot_updates['profileName']
                    if sync_user_fields and assigned_from and member_alias:
                        lank_account_id = str(assigned_from.get('accountId', '') if isinstance(assigned_from, dict) else assigned_from)
                        if lank_account_id:
                            group_ref = db.document(f'groups/{service}/lank-accounts/{lank_account_id}')
                            group_snap = group_ref.get()
                            if group_snap.exists:
                                g_users = group_snap.to_dict().get('users', [])
                                search_alias = before_slot.get('memberAlias', member_alias)
                                for gi, gu in enumerate(g_users):
                                    g_alias = gu.get('userAlias', '') if isinstance(gu, dict) else gu
                                    if g_alias.lower() == search_alias.lower():
                                        if isinstance(gu, dict):
                                            for k, v in sync_user_fields.items():
                                                g_users[gi][k] = v
                                            group_ref.update({'users': g_users, 'updatedAt': datetime.now(timezone.utc).isoformat()})
                                        break
                except Exception as sync_err:
                    # No bloquear la operaciÃ³n principal si la sincronizaciÃ³n falla
                    pass
                results.append({
                    'function': name, 'success': True,
                    'message': f'Cupo {slot_index + 1} de {account_ref} actualizado correctamente',
                    'updatedSlot': dict(slots[slot_index]),
                })

            elif name == 'get_schedule':
                # Leer configuraciÃ³n del anÃ¡lisis programado
                sched_snap = db.document('config/schedule').get()
                if sched_snap.exists:
                    sched_data = sched_snap.to_dict()
                    # Convertir startTime a hora MX para facilitar lectura
                    mx_tz = timezone(timedelta(hours=-6))
                    start_str = sched_data.get('startTime', '')
                    start_local = start_str
                    try:
                        if start_str:
                            st_dt = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
                            start_local = st_dt.astimezone(mx_tz).strftime('%d/%m/%Y %I:%M %p') + ' (UTC-6)'
                    except Exception:
                        pass
                    sched_data['startTimeLocal'] = start_local
                    results.append({'function': name, 'success': True, 'data': sched_data})
                else:
                    results.append({'function': name, 'success': False, 'error': 'No hay configuraciÃ³n de schedule'})

            elif name == 'update_schedule':
                # Actualizar configuraciÃ³n del anÃ¡lisis programado
                sched_ref = db.document('config/schedule')
                sched_snap = sched_ref.get()
                before = sched_snap.to_dict() if sched_snap.exists else {}

                update_fields = {}
                if 'enabled' in args:
                    update_fields['enabled'] = bool(args['enabled'])
                if 'frequencyHours' in args:
                    fh = int(args['frequencyHours'])
                    if fh not in (1, 2, 3, 4, 6, 8, 12, 24):
                        results.append({'function': name, 'success': False, 'error': f'Frecuencia {fh}h no vÃ¡lida. Usar: 1,2,3,4,6,8,12,24'})
                        continue
                    update_fields['frequencyHours'] = fh
                if 'startTime' in args:
                    update_fields['startTime'] = args['startTime']

                # Horario activo
                active_hours = before.get('activeHours', {})
                ah_changed = False
                if 'activeHoursEnabled' in args:
                    active_hours['enabled'] = bool(args['activeHoursEnabled'])
                    ah_changed = True
                if 'activeHoursStart' in args:
                    active_hours['startHour'] = int(args['activeHoursStart'])
                    ah_changed = True
                if 'activeHoursEnd' in args:
                    active_hours['endHour'] = int(args['activeHoursEnd'])
                    ah_changed = True
                if ah_changed:
                    update_fields['activeHours'] = active_hours

                if not update_fields:
                    results.append({'function': name, 'success': False, 'error': 'No se especificaron campos para actualizar'})
                    continue

                update_fields['updatedAt'] = datetime.now(timezone.utc).isoformat()

                if sched_snap.exists:
                    sched_ref.update(update_fields)
                else:
                    sched_ref.set(update_fields)

                lank_audit.log_ai_chat_action(
                    db, action='update_schedule',
                    description=f'Schedule actualizado por IA: {list(update_fields.keys())}',
                    collection='config', document_id='schedule',
                    before={k: before.get(k) for k in update_fields if k != 'updatedAt'},
                    after=update_fields,
                )
                results.append({'function': name, 'success': True, 'message': f'ConfiguraciÃ³n del schedule actualizada: {list(update_fields.keys())}'})

            elif name == 'get_pending_charges':
                # Lee cobros recurrentes pendientes del ledger
                ledger_ref = db.document('finance/manual-ledger')
                ledger_snap = ledger_ref.get()
                entries = ledger_snap.to_dict().get('entries', []) if ledger_snap.exists else []
                pending = []
                for idx, entry in enumerate(entries):
                    if entry.get('status') == 'pending':
                        pending.append({
                            'index': idx,
                            'description': entry.get('description', ''),
                            'amount': entry.get('amount', 0),
                            'effectiveAt': entry.get('effectiveAt', ''),
                            'subscription': entry.get('subscription', ''),
                            'cardLabel': entry.get('cardLabel', ''),
                            'isRecurring': entry.get('isRecurring', False),
                            'status': 'pending',
                        })
                results.append({'function': name, 'success': True, 'data': pending, 'total': len(pending)})

            elif name == 'confirm_pending_charge':
                # Confirma un cobro recurrente pendiente
                entry_index = int(args.get('entryIndex', -1))
                override_amount = args.get('overrideAmount')

                ledger_ref = db.document('finance/manual-ledger')
                ledger_snap = ledger_ref.get()
                if not ledger_snap.exists:
                    results.append({'function': name, 'success': False, 'error': 'No existe el ledger de finanzas'})
                    continue
                entries = ledger_snap.to_dict().get('entries', [])

                if entry_index < 0 or entry_index >= len(entries):
                    results.append({'function': name, 'success': False, 'error': f'Ãndice {entry_index} fuera de rango (0-{len(entries)-1})'})
                    continue
                entry = entries[entry_index]
                if entry.get('status') != 'pending':
                    results.append({'function': name, 'success': False, 'error': f'La entrada {entry_index} no estÃ¡ pendiente (status={entry.get("status")})'})
                    continue

                now_iso = datetime.now(timezone.utc).isoformat()
                final_amount = float(override_amount) if override_amount is not None else (entry.get('amount') or 0)

                if final_amount <= 0:
                    results.append({'function': name, 'success': False, 'error': 'El monto debe ser mayor a 0. Proporciona overrideAmount si el monto original es 0.'})
                    continue

                # Update the entry
                updated_entries = list(entries)
                updated_entries[entry_index] = {
                    **entry,
                    'amount': final_amount,
                    'status': 'confirmed',
                    'confirmedAt': now_iso,
                }
                ledger_ref.update({'entries': updated_entries})

                # Update monthly totals
                entry_month = (entry.get('effectiveAt', '') or '')[:7]
                now_dt = datetime.now(timezone.utc)
                current_month_key = f'{now_dt.year}-{str(now_dt.month).zfill(2)}'

                try:
                    if entry_month == current_month_key:
                        ov_ref = db.document('finance/overview')
                        ov_snap = ov_ref.get()
                        if ov_snap.exists:
                            ov = ov_snap.to_dict()
                            totals = dict(ov.get('totals', {}))
                            totals['manualExpensesGross'] = (totals.get('manualExpensesGross', 0) or 0) + final_amount
                            totals['bankNetAfterExpenses'] = round(
                                (totals.get('withdrawalCompletedGross', 0) or 0)
                                - (totals.get('manualExpensesGross', 0) or 0)
                                - (totals.get('manualInvestmentsGross', 0) or 0), 2)
                            totals['estimatedNetWallet'] = round(
                                (totals.get('walletCreditsGross', 0) or 0)
                                - (totals.get('manualExpensesGross', 0) or 0)
                                - (totals.get('manualInvestmentsGross', 0) or 0), 2)
                            ov_ref.update({'totals': totals})
                    elif entry_month:
                        month_ref = db.document(f'finance/monthly-{entry_month}')
                        month_snap = month_ref.get()
                        if month_snap.exists:
                            m_data = month_snap.to_dict()
                            totals = dict(m_data.get('totals', {}))
                            totals['manualExpensesGross'] = (totals.get('manualExpensesGross', 0) or 0) + final_amount
                            totals['bankNetAfterExpenses'] = round(
                                (totals.get('withdrawalCompletedGross', 0) or 0)
                                - (totals.get('manualExpensesGross', 0) or 0)
                                - (totals.get('manualInvestmentsGross', 0) or 0), 2)
                            totals['estimatedNetWallet'] = round(
                                (totals.get('walletCreditsGross', 0) or 0)
                                - (totals.get('manualExpensesGross', 0) or 0)
                                - (totals.get('manualInvestmentsGross', 0) or 0), 2)
                            month_ref.update({'totals': totals})
                except Exception as te:
                    print(f'Warning: totals update failed after confirming charge: {te}')

                lank_audit.log_ai_chat_action(
                    db, action='confirm_pending_charge',
                    description=f'Cobro "{entry.get("description", "")}" confirmado por IA -  ${final_amount}',
                    collection='finance', document_id='manual-ledger',
                    before={'status': 'pending', 'amount': entry.get('amount')},
                    after={'status': 'confirmed', 'amount': final_amount, 'confirmedAt': now_iso},
                )
                results.append({'function': name, 'success': True, 'message': f'Cobro "{entry.get("description", "")}" confirmado -  ${final_amount}'})

            elif name == 'get_credit_accounts':
                # Read credit accounts from Firestore
                credit_ref = db.document('finance/credit-accounts')
                credit_snap = credit_ref.get()
                accounts = credit_snap.to_dict().get('accounts', []) if credit_snap.exists else []
                summary = []
                total_debt = 0
                total_limit = 0
                for acct in accounts:
                    limit_val = acct.get('creditLimit', 0) or 0
                    balance_val = acct.get('currentBalance', 0) or 0
                    utilization = round((balance_val / limit_val * 100), 1) if limit_val > 0 else 0
                    total_debt += balance_val
                    total_limit += limit_val
                    installments = acct.get('installments', [])
                    active_msi = [i for i in installments if i.get('status', 'active') == 'active']
                    summary.append({
                        'id': acct.get('id', ''),
                        'bank': acct.get('bank', ''),
                        'creditLimit': limit_val,
                        'currentBalance': balance_val,
                        'utilization': utilization,
                        'cutoffDay': acct.get('cutoffDay'),
                        'paymentDueDay': acct.get('paymentDueDay'),
                        'annualRate': acct.get('annualRate'),
                        'minimumPayment': acct.get('minimumPayment', 0),
                        'alertDaysBefore': acct.get('alertDaysBefore', 1),
                        'vaultCardIds': acct.get('vaultCardIds', []),
                        'clabeIndex': acct.get('clabeIndex', -1),
                        'activeMSI': len(active_msi),
                        'msiDetails': [{'description': i.get('description', ''), 'monthlyAmount': i.get('monthlyPayment', i.get('monthlyAmount', 0)), 'remainingMonths': i.get('remainingMonths', 0)} for i in active_msi],
                    })
                results.append({
                    'function': name, 'success': True,
                    'data': summary, 'totalAccounts': len(summary),
                    'totalDebt': round(total_debt, 2), 'totalLimit': round(total_limit, 2),
                    'overallUtilization': round((total_debt / total_limit * 100), 1) if total_limit > 0 else 0,
                })

            elif name == 'update_credit_account':
                account_id = args.get('accountId', '')
                if not account_id:
                    results.append({'function': name, 'success': False, 'error': 'accountId es obligatorio'})
                    continue

                credit_ref = db.document('finance/credit-accounts')
                credit_snap = credit_ref.get()
                if not credit_snap.exists:
                    results.append({'function': name, 'success': False, 'error': 'No existe el documento finance/credit-accounts'})
                    continue
                accounts = list(credit_snap.to_dict().get('accounts', []))

                target_idx = None
                for idx, acct in enumerate(accounts):
                    if acct.get('id') == account_id:
                        target_idx = idx
                        break
                if target_idx is None:
                    results.append({'function': name, 'success': False, 'error': f'Cuenta de crédito {account_id} no encontrada'})
                    continue

                allowed_fields = ['currentBalance', 'creditLimit', 'minimumPayment', 'annualRate', 'cutoffDay', 'paymentDueDay', 'alertDaysBefore']
                before = {}
                after = {}
                for field in allowed_fields:
                    if field in args:
                        before[field] = accounts[target_idx].get(field)
                        val = args[field]
                        if field in ('cutoffDay', 'paymentDueDay', 'alertDaysBefore'):
                            val = int(val)
                        else:
                            val = float(val)
                        accounts[target_idx][field] = val
                        after[field] = val

                if not after:
                    results.append({'function': name, 'success': False, 'error': 'No se proporcionaron campos para actualizar'})
                    continue

                accounts[target_idx]['updatedAt'] = datetime.now(timezone.utc).isoformat()
                credit_ref.update({'accounts': accounts})

                lank_audit.log_ai_chat_action(
                    db, action='update_credit_account',
                    description=f'Cuenta de crédito {accounts[target_idx].get("bank", account_id)} actualizada: {list(after.keys())}',
                    collection='finance', document_id='credit-accounts',
                    before=before, after=after,
                )
                results.append({'function': name, 'success': True, 'message': f'Cuenta {accounts[target_idx].get("bank", account_id)} actualizada: {after}'})

            else:
                results.append({
                    'function': name,
                    'success': False,
                    'error': f'FunciÃ³n no implementada: {name}',
                })

        except Exception as e:
            traceback.print_exc()
            results.append({'function': name, 'success': False, 'error': str(e)})

    return results


# â"€â"€â"€ SCHEDULED ANALYSIS (runs if enabled) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

@scheduler_fn.on_schedule(
    schedule="0,30 * * * *",
    region="us-central1",
    timeout_sec=540,
    memory=options.MemoryOption.MB_256,
)
def scheduled_analysis(event: scheduler_fn.ScheduledEvent) -> None:
    """Runs every 30 minutes. Uses startTime-based grid scheduling.

    The schedule works as a fixed grid:
    - startTime defines the first run (e.g., 12:00 UTC)
    - frequencyHours defines the interval (e.g., every 2h, 6h, 12h, 24h)
    - Subsequent runs: 12:00, 14:00, 16:00, ...

    Each 30-min trigger checks if 'now' falls on a scheduled slot
    and if the analysis hasn't already run for that slot.
    """
    db = firestore.client()

    # Check schedule config
    config_doc = db.document('config/schedule').get()
    config = config_doc.to_dict() if config_doc.exists else {}

    if not config.get('enabled', False):
        print('Scheduled analysis is disabled.')
        return

    freq_hours = config.get('frequencyHours', 6)
    start_time_str = config.get('startTime')
    now = datetime.now(timezone.utc)

    # â"€â"€â"€ Active hours window check â"€â"€â"€
    active_hours = config.get('activeHours')
    if active_hours and active_hours.get('enabled'):
        tz_offset = active_hours.get('tzOffset', 0)  # minutes offset from UTC
        local_now = now + timedelta(minutes=-tz_offset)  # convert UTC to user's local time
        current_hour = local_now.hour + local_now.minute / 60.0
        start_hour = active_hours.get('startHour', 0)
        end_hour = active_hours.get('endHour', 24)

        if start_hour < end_hour:
            # Normal range (e.g., 7:00 to 23:00)
            in_window = start_hour <= current_hour < end_hour
        else:
            # Overnight range (e.g., 22:00 to 06:00)
            in_window = current_hour >= start_hour or current_hour < end_hour

        if not in_window:
            local_time_str = local_now.strftime('%H:%M')
            print(f'Outside active hours ({start_hour:g}:00-{end_hour:g}:00). '
                  f'Local time: {local_time_str}. Skipping.')
            return

    if not start_time_str:
        print('No startTime configured. Skipping.')
        return

    try:
        start_dt = datetime.fromisoformat(start_time_str)
        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)
    except Exception:
        print(f'Invalid startTime: {start_time_str}. Skipping.')
        return

    # If the start time is in the future, don't run yet
    if now < start_dt:
        time_until = (start_dt - now).total_seconds() / 3600
        print(f'Start time is in the future ({start_time_str}). Waiting {time_until:.1f}h.')
        return

    # Calculate if now falls on a scheduled slot
    # Time elapsed since startTime in hours
    elapsed_hours = (now - start_dt).total_seconds() / 3600
    # How many complete intervals have passed
    intervals_passed = int(elapsed_hours / freq_hours)
    # The current scheduled slot time
    current_slot = start_dt + timedelta(hours=intervals_passed * freq_hours)
    # The next scheduled slot
    next_slot = current_slot + timedelta(hours=freq_hours)

    # Check if we're within the execution window
    # Cloud Scheduler fires at :00 and :30, so with cold start delay (~3s)
    # the function starts at ~:00:03. Use a 28-min window to be safe.
    minutes_after_slot = (now - current_slot).total_seconds() / 60
    if minutes_after_slot > 28:
        print(f'Not in execution window. Current slot was {current_slot.isoformat()}, '
              f'next slot at {next_slot.isoformat()}.')
        return

    # Check if we already ran for this slot (prevent double execution)
    state = load_analysis_state(db)
    last_run = state.get('lastRun')
    if last_run:
        try:
            last_dt = datetime.fromisoformat(last_run)
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            # If the last run is after the current slot started, we already ran
            if last_dt >= current_slot:
                print(f'Already ran for slot {current_slot.isoformat()} (last run: {last_run}).')
                return
        except Exception:
            pass

    print(f'Running scheduled analysis (frequency={freq_hours}h, slot={current_slot.isoformat()})...')

    # Run the same analysis logic
    import urllib.request
    # Self-invoke the analyze_emails function
    # This is a simple approach - call our own HTTP endpoint
    # Load dynamic service configuration
    services_config, name_to_key, unmanaged_services = load_service_config(db)
    global SERVICE_TO_FS, UNMANAGED_JOIN_LEAVE_SERVICES
    SERVICE_TO_FS = name_to_key
    UNMANAGED_JOIN_LEAVE_SERVICES = unmanaged_services

    credentials = load_imap_credentials(db)
    registry = load_account_registry(db)
    rates = load_rates(db)
    db_context = load_current_state_context(db, name_to_key)

    cred_by_id = {int(a['accountId']): a for a in credentials}
    days = 3
    accounts = []
    for acc in registry:
        aid = int(acc['id'])
        cred = cred_by_id.get(aid)
        if not cred or not cred.get('enabled', True):
            continue
        accounts.append({
            'id': aid, 'canonicalAlias': acc.get('canonicalAlias', ''),
            'email': cred['email'], 'appPassword': cred['appPassword'],
        })

    report = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'days': days, 'usedUidTracking': state.get('lastRun') is not None,
        'accounts': [],
    }

    new_state_accounts = dict(state.get('accounts', {}))
    alerts_data = load_alerts_from_firestore(db)

    for account in accounts:
        aid = str(account['id'])
        last_uid = new_state_accounts.get(aid, {}).get('lastUid')
        account_result = analyze_account(account, rates, days, db_context, db, last_uid, services_config=services_config)
        report['accounts'].append(account_result)

        if account_result['rawEmails']:
            save_notifications(db, account['id'], account.get('canonicalAlias', ''), account_result['rawEmails'], analysis_timestamp=report['generatedAt'])

        max_uid = account_result.get('maxUid', 0)
        prev_uid = new_state_accounts.get(aid, {}).get('lastUid', 0)
        if max_uid > prev_uid:
            new_state_accounts[aid] = {
                'lastUid': max_uid, 'lastRun': datetime.now(timezone.utc).isoformat(),
                'accountAlias': account.get('canonicalAlias'),
            }
        elif aid not in new_state_accounts:
            new_state_accounts[aid] = {
                'lastUid': prev_uid, 'lastRun': datetime.now(timezone.utc).isoformat(),
                'accountAlias': account.get('canonicalAlias'),
            }

    state['lastRun'] = datetime.now(timezone.utc).isoformat()
    state['accounts'] = new_state_accounts

    # Save report
    ok_accounts = [a for a in report['accounts'] if a['access'] == 'ok']

    # Generate alerts and build actionable events using shared function
    alerts_generated, _, actionable = generate_alerts_for_accounts(db, ok_accounts, alerts_data, services_config=services_config)

    # Save analysis state AFTER alert generation so a crash during alerts
    # doesn't permanently skip unprocessed emails (UIDs not yet committed).
    save_analysis_state(db, state)

    total_pending = sum(a['summary']['pending'] for a in ok_accounts)
    total_relevant = sum(a['summary']['relevant'] for a in ok_accounts)
    total_raw = sum(len(a.get('rawEmails', [])) for a in ok_accounts)
    total_events = sum(a['summary']['totalEvents'] for a in ok_accounts)
    total_ignored = sum(a['summary']['ignored'] for a in ok_accounts)
    total_review = sum(a['summary']['review'] for a in ok_accounts)

    failed_accounts = [a for a in report['accounts'] if a['access'] != 'ok']

    db.document('analysis/latest-report').set({
        'generatedAt': report['generatedAt'],
        'mode': 'UID tracking' if report.get('usedUidTracking') else 'date fallback',
        'totalAccounts': len(report['accounts']),
        'accountsOk': len(ok_accounts),
        'accountCount': len(ok_accounts),
        'totalPending': total_pending,
        'totalRelevant': total_relevant,
        'totalRawEmails': total_raw,
        'totalEvents': total_events,
        'totalIgnored': total_ignored,
        'totalReview': total_review,
        'alertsGenerated': alerts_generated,
        'accounts': [{'accountId': a['accountId'], 'accountAlias': a.get('accountAlias', ''),
                      'access': 'ok', 'pending': a['summary']['pending'],
                      'relevant': a['summary']['relevant']} for a in ok_accounts],
        'failedAccounts': [{
            'accountId': a['accountId'],
            'accountAlias': a.get('accountAlias', ''),
            'access': a.get('access', 'unknown'),
            'error': a.get('error', 'Error desconocido'),
        } for a in failed_accounts],
    })

    # Merge actionable events -  accumulate, don't overwrite
    merge_actionable_events(db, actionable, report['generatedAt'])

    # â"€â"€â"€ AI SECOND LAYER â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    try:
        ai_result = run_ai_second_layer(
            db, ok_accounts, db_context, alerts_data, report['generatedAt']
        )
        if ai_result and not ai_result.get('error'):
            db.document('analysis/latest-report').update({
                'aiAnalysis': {
                    'enabled': True,
                    'status': 'success',
                    'summary': ai_result.get('summary', ''),
                    'totalActions': len(ai_result.get('actions', [])),
                    'confidence': ai_result.get('overallConfidence', 0),
                }
            })
        elif ai_result and ai_result.get('error'):
            db.document('analysis/latest-report').update({
                'aiAnalysis': {
                    'enabled': True,
                    'status': 'error',
                    'error': ai_result.get('error', ''),
                }
            })
        else:
            # ai_result es None (deshabilitada o sin correos)
            db.document('analysis/latest-report').update({
                'aiAnalysis': {
                    'enabled': bool(lank_ai.GeminiClient(db).is_analysis_enabled),
                    'status': 'skipped',
                }
            })
    except Exception as ai_err:
        print(f'[AI] Error no fatal en segunda capa (scheduled): {ai_err}')
    # â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

    # Update finance documents from withdrawal events
    try:
        finance_records = update_finance_from_analysis(db, ok_accounts)
        if finance_records > 0:
            print(f'Finance: {finance_records} withdrawal records updated')
    except Exception as e:
        print(f'Warning: scheduled finance update failed: {e}')

    cleanup_old_data(db)

    # ─── Auto-cleanup de artefactos de deploy (si la política está habilitada) ──
    try:
        policy_doc = db.document('config/cleanup-policies').get()
        policies = policy_doc.to_dict() if policy_doc.exists else {}
        cs_policy = policies.get('cloudStorage', {})
        ar_policy = policies.get('artifactRegistry', {})

        if cs_policy.get('autoCleanup'):
            from google.cloud import storage as gcs
            gcs_client = gcs.Client()
            _, gcf_buckets = _get_cloud_storage_data(gcs_client)
            cs_del, cs_freed, _ = _cleanup_cloud_storage(gcs_client, gcf_buckets)
            if cs_del > 0:
                print(f'[Auto-cleanup CS] {cs_del} objetos, {cs_freed / (1024*1024):.1f} MB liberados')

        if ar_policy.get('autoCleanup'):
            ar_del, ar_freed, _ = _cleanup_artifact_registry('adminlank')
            if ar_del > 0:
                print(f'[Auto-cleanup AR] {ar_del} versiones, {ar_freed / (1024*1024):.1f} MB liberados')
    except Exception as ac_err:
        print(f'[Auto-cleanup] Error no fatal: {ac_err}')

    # Revisar renovaciones de servicios con isRenewalBased (Microsoft 365, etc.)
    renewal_count = lank_alerts.generate_renewal_alerts(db, services_config)
    if renewal_count > 0:
        print(f'Renewal alerts generated: {renewal_count}')

    # Detectar usuarios sin fecha de renovaciÃ³n en servicios renewal-based
    missing_renewal_count = lank_alerts.generate_missing_renewal_alerts(db, services_config)
    if missing_renewal_count > 0:
        print(f'Missing renewal date alerts generated: {missing_renewal_count}')
    renewal_count += missing_renewal_count

    # Detectar usuarios sin telÃ©fono (preparaciÃ³n para WhatsApp)
    missing_phone_count = lank_alerts.generate_missing_phone_alerts(db, services_config)
    if missing_phone_count > 0:
        print(f'Missing phone alerts generated: {missing_phone_count}')
        alerts_generated += missing_phone_count

    # Alertas de cuentas de crédito (corte y pago)
    credit_alert_count = lank_alerts.generate_credit_alerts(db)
    if credit_alert_count > 0:
        print(f'Credit alerts generated: {credit_alert_count}')
        alerts_generated += credit_alert_count

    # Alertas de recarga de SIM Cards (7 días antes del 15 de cada mes)
    sim_alert_count = lank_alerts.generate_sim_recharge_alerts(db)
    if sim_alert_count > 0:
        print(f'SIM recharge alerts generated: {sim_alert_count}')
        alerts_generated += sim_alert_count

    print(f'Scheduled analysis complete: {len(ok_accounts)} accounts, {alerts_generated} alerts.')

    # â"€â"€â"€ Notificaciones de Telegram (scheduled) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    try:
        tg = lank_telegram.TelegramBot(db)
        if tg.is_enabled:
            notified = False

            # Calcular total de alertas generadas (primera capa + segunda capa IA)
            ai_alerts_created = 0
            if ai_result and isinstance(ai_result, dict):
                ai_alerts_created = ai_result.get('_ai_alerts_created', 0)
            total_alerts = alerts_generated + ai_alerts_created + renewal_count

            # 1. Alertas de Firestore con status pending (incluye primera capa + IA)
            if total_alerts > 0:
                new_alerts = list(db.collection('alerts')
                                 .where('status', '==', 'pending')
                                 .order_by('createdAt', direction='DESCENDING')
                                 .limit(max(total_alerts, 10)).stream())
                alert_dicts = [a.to_dict() for a in new_alerts]
                if alert_dicts:
                    tg.send_alert_notification(alert_dicts)
                    notified = True
                    print(f'[Telegram] NotificaciÃ³n enviada: {len(alert_dicts)} alertas '
                          f'(scripts: {alerts_generated}, IA: {ai_alerts_created}, renewal: {renewal_count})')

            # 2. FALLBACK FINAL: Siempre buscar alertas pending recientes
            #    (cubre el caso donde la IA creÃ³ alertas pero el conteo fallÃ³,
            #    o correos con formato nuevo que los scripts no detectaron)
            if not notified:
                try:
                    # Buscar alertas pending creadas en los Ãºltimos 10 minutos
                    recent_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
                    recent_alerts = list(db.collection('alerts')
                                        .where('status', '==', 'pending')
                                        .where('createdAt', '>=', recent_cutoff)
                                        .order_by('createdAt', direction='DESCENDING')
                                        .limit(20).stream())
                    alert_dicts = [a.to_dict() for a in recent_alerts]
                    if alert_dicts:
                        tg.send_alert_notification(alert_dicts)
                        notified = True
                        print(f'[Telegram] Fallback: {len(alert_dicts)} alertas pending recientes notificadas')
                except Exception as fb_err:
                    print(f'[Telegram] Error en fallback de alertas recientes: {fb_err}')

            # 3. Actionable-events como Ãºltimo recurso
            if not notified:
                try:
                    ae_doc = db.document('analysis/actionable-events').get()
                    if ae_doc.exists:
                        ae_events = ae_doc.to_dict().get('events', [])
                        if ae_events:
                            pseudo_alerts = []
                            for evt in ae_events:
                                pseudo_alerts.append({
                                    'title': f"{evt.get('userName', '?')} -  {evt.get('subscription', '?')}",
                                    'description': evt.get('action', 'AcciÃ³n requerida'),
                                    'priority': 'high' if 'join' in evt.get('kind', '') else 'medium',
                                    'service': evt.get('subscription', '?'),
                                    'accountId': evt.get('accountId', '?'),
                                    'accountAlias': evt.get('accountAlias', '?'),
                                })
                            tg.send_alert_notification(pseudo_alerts)
                except Exception as ae_err:
                    print(f'[Telegram] Error leyendo actionable-events: {ae_err}')

            if failed_accounts:
                tg.send_analysis_errors([{
                    'accountId': a['accountId'],
                    'accountAlias': a.get('accountAlias', ''),
                    'error': a.get('error', 'Error desconocido'),
                } for a in failed_accounts])
    except Exception as tg_err:
        print(f'[Telegram] Error no fatal en notificaciÃ³n scheduled: {tg_err}')
    # â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
# TELEGRAM BOT WEBHOOK
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST']),
    memory=options.MemoryOption.MB_512,
    timeout_sec=300,
)
def telegram_webhook(req: https_fn.Request) -> https_fn.Response:
    """Webhook para recibir mensajes de Telegram.

    Telegram envÃ­a actualizaciones vÃ­a POST. Esta funciÃ³n:
    1. Valida que el chat_id sea del admin autorizado
    2. Procesa comandos (/estado, /alertas, etc.)
    3. Para mensajes normales, los envÃ­a al chat de IA compartido
    """
    if req.method != 'POST':
        return https_fn.Response('OK', status=200)

    try:
        db = firestore.client()
        tg = lank_telegram.TelegramBot(db)

        if not tg.token:
            return https_fn.Response('Bot not configured', status=200)

        update = req.get_json(silent=True) or {}
        message = update.get('message', {})
        chat_id = message.get('chat', {}).get('id')
        text = message.get('text', '').strip()

        if not chat_id or not text:
            return https_fn.Response('OK', status=200)

        # â"€â"€ Auto-registro: si no hay admin configurado, el primero se registra
        if not tg.admin_chat_id:
            db.document('config/telegram-settings').set({
                'botToken': tg.token,
                'adminChatId': str(chat_id),
                'enabled': True,
                'registeredAt': datetime.now(timezone.utc).isoformat(),
            }, merge=True)
            tg._settings = None  # Limpiar cache
            tg.send_message(
                'âœ… *Registro completado*\n\n'
                f'Tu chat ID ({chat_id}) ha sido registrado como administrador.\n'
                'Ahora puedes usar todos los comandos. Escribe /ayuda para ver la lista.',
                chat_id=chat_id,
            )
            return https_fn.Response('OK', status=200)

        # â"€â"€ Verificar autorizaciÃ³n
        if not tg.is_authorized(chat_id):
            tg.send_message('â›" No estÃ¡s autorizado para usar este bot.', chat_id=chat_id)
            return https_fn.Response('OK', status=200)

        # â"€â"€ Procesar comando
        if text.startswith('/'):
            response_text = tg.process_command(text, chat_id)
            if response_text:
                tg.send_message(response_text, chat_id=chat_id)
                return https_fn.Response('OK', status=200)

        # â"€â"€ Chat con IA (contexto compartido)
        tg.send_typing(chat_id)

        ai_client = lank_ai.GeminiClient(db)
        if not ai_client.is_chat_enabled:
            tg.send_message('âš ï¸ El chat con IA estÃ¡ deshabilitado. ActÃ­valo desde el dashboard.', chat_id=chat_id)
            return https_fn.Response('OK', status=200)

        # Leer historial compartido de Firestore
        history_doc = db.document('chat/history').get()
        shared_messages = []
        if history_doc.exists:
            shared_messages = history_doc.to_dict().get('messages', [])

        # Construir chatHistory para la IA (Ãºltimos 20 mensajes)
        chat_history = [{'role': m.get('role', 'user'), 'content': m.get('content', '')}
                        for m in shared_messages[-20:]]

        # Inyectar contexto del sistema
        context_prefix = _build_chat_context(db)
        full_message = text
        if context_prefix:
            full_message = f"[CONTEXTO DEL SISTEMA ACTUAL]\n{context_prefix}\n\n[MENSAJE DEL ADMIN (via Telegram)]\n{text}"

        # Enviar a Gemini (con reintentos internos)
        try:
            result = ai_client.chat(
                message=full_message,
                chat_history=chat_history,
                tool_executor=lambda fcs: _execute_chat_functions(db, fcs),
            )
        except Exception as ai_err:
            # Error en la IA -  no romper el flujo, notificar amigablemente
            err_str = str(ai_err).lower()
            if any(k in err_str for k in ['503', 'unavailable', 'overloaded']):
                tg.send_message(
                    'â³ *Gemini no disponible temporalmente*\n\n'
                    'El modelo estÃ¡ experimentando alta demanda. '
                    'Intenta de nuevo en unos minutos.',
                    chat_id=chat_id,
                )
            else:
                tg.send_message(
                    f'âš ï¸ *Error al procesar tu mensaje*\n\n'
                    f'La IA no pudo responder: {str(ai_err)[:200]}\n'
                    f'Tu mensaje no se perdiÃ³, intenta de nuevo.',
                    chat_id=chat_id,
                )

            # Guardar el mensaje del usuario aunque la IA haya fallado
            user_msg = {'role': 'user', 'content': text, 'source': 'telegram',
                        'timestamp': datetime.now(timezone.utc).isoformat()}
            updated_messages = (shared_messages + [user_msg])[-50:]
            db.document('chat/history').set({
                'messages': updated_messages,
                'updatedAt': datetime.now(timezone.utc).isoformat(),
            })
            return https_fn.Response('OK', status=200)

        ai_response = result.get('response', 'Sin respuesta')

        # Si la IA retornÃ³ un error interno (sin excepciÃ³n)
        if result.get('error'):
            err_msg = ai_response
            if '503' in err_msg or 'unavailable' in err_msg.lower():
                tg.send_message(
                    'â³ *Gemini no disponible temporalmente*\n\n'
                    'El modelo estÃ¡ experimentando alta demanda. '
                    'Intenta de nuevo en unos minutos.',
                    chat_id=chat_id,
                )
            else:
                tg.send_message(f'âš ï¸ {err_msg}', chat_id=chat_id)
            return https_fn.Response('OK', status=200)

        # Guardar en historial compartido
        user_msg = {'role': 'user', 'content': text, 'source': 'telegram',
                    'timestamp': datetime.now(timezone.utc).isoformat()}
        ai_msg = {'role': 'assistant', 'content': ai_response, 'source': 'telegram',
                  'timestamp': datetime.now(timezone.utc).isoformat(),
                  'thinking': result.get('thinking')}

        updated_messages = shared_messages + [user_msg, ai_msg]
        # Mantener mÃ¡ximo 50 mensajes
        updated_messages = updated_messages[-50:]

        db.document('chat/history').set({
            'messages': updated_messages,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
        })

        # Registrar en audit-log
        lank_audit.log_change(
            db,
            source='telegram',
            action='chat_message',
            description=f'Telegram: "{text[:80]}"',
            actor='admin',
            ai_involved=True,
            ai_model=ai_client.settings.get('chatModel', 'unknown'),
        )

        # Enviar respuesta por Telegram
        tg.send_message(ai_response, chat_id=chat_id)

        return https_fn.Response('OK', status=200)

    except Exception as e:
        traceback.print_exc()
        try:
            tg.send_message(f'âŒ Error interno: {str(e)[:200]}', chat_id=chat_id)
        except Exception:
            pass
        return https_fn.Response('OK', status=200)


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST', 'GET']),
)
def telegram_setup(req: https_fn.Request) -> https_fn.Response:
    """Configura el webhook de Telegram y almacena el token.

    GET: Muestra info del webhook actual
    POST: { action: 'set_webhook' | 'delete_webhook' | 'save_token', botToken?: str }
    """
    db = firestore.client()

    if req.method == 'GET':
        tg = lank_telegram.TelegramBot(db)
        if not tg.token:
            return https_fn.Response(
                json.dumps({'error': 'Bot token no configurado'}),
                content_type='application/json',
            )
        info = tg.get_webhook_info()
        return https_fn.Response(
            json.dumps(info, default=str),
            content_type='application/json',
        )

    body = req.get_json(silent=True) or {}
    action = body.get('action', '')

    if action == 'save_token':
        token = body.get('botToken', '')
        if not token:
            return https_fn.Response(
                json.dumps({'error': 'botToken requerido'}),
                status=400, content_type='application/json',
            )
        db.document('config/telegram-settings').set({
            'botToken': token,
            'enabled': True,
        }, merge=True)
        return https_fn.Response(
            json.dumps({'success': True, 'message': 'Token guardado'}),
            content_type='application/json',
        )

    tg = lank_telegram.TelegramBot(db)
    if not tg.token:
        return https_fn.Response(
            json.dumps({'error': 'Bot token no configurado'}),
            status=400, content_type='application/json',
        )

    if action == 'set_webhook':
        webhook_url = '***REMOVED***/telegram_webhook'
        result = tg.set_webhook(webhook_url)
        return https_fn.Response(
            json.dumps(result, default=str),
            content_type='application/json',
        )
    elif action == 'delete_webhook':
        result = tg.delete_webhook()
        return https_fn.Response(
            json.dumps(result, default=str),
            content_type='application/json',
        )

    return https_fn.Response(
        json.dumps({'error': 'AcciÃ³n no reconocida'}),
        status=400, content_type='application/json',
    )


# â"€â"€â"€ GESTIÃ"N DE ALMACENAMIENTO DE DEPLOY â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

def _get_cloud_storage_data(gcs_client):
    """Collect Cloud Storage (gcf-v2-*) deploy artifacts info."""
    gcf_buckets = []
    for bucket in gcs_client.list_buckets():
        if bucket.name.startswith('gcf-v2-'):
            gcf_buckets.append(bucket.name)

    result = {
        'buckets': [],
        'totalSizeBytes': 0,
        'totalObjects': 0,
        'cleanableSizeBytes': 0,
        'cleanableObjects': 0,
    }

    for bucket_name in gcf_buckets:
        bucket = gcs_client.bucket(bucket_name)
        bucket_info = {
            'name': bucket_name,
            'type': 'sources' if 'sources' in bucket_name else 'uploads',
            'folders': [],
            'totalSizeBytes': 0,
            'totalObjects': 0,
            'cleanableSizeBytes': 0,
            'cleanableObjects': 0,
        }

        folders = {}
        for blob in bucket.list_blobs():
            parts = blob.name.split('/')
            folder = parts[0] if len(parts) > 1 else '__root__'
            if folder not in folders:
                folders[folder] = []
            folders[folder].append({
                'name': blob.name,
                'size': blob.size or 0,
                'created': blob.time_created.isoformat() if blob.time_created else None,
                'updated': blob.updated.isoformat() if blob.updated else None,
            })

        for folder_name, blobs in folders.items():
            blobs.sort(key=lambda b: b.get('created', ''), reverse=True)
            folder_total = sum(b['size'] for b in blobs)
            cleanable = blobs[1:] if len(blobs) > 1 else []
            cleanable_size = sum(b['size'] for b in cleanable)

            bucket_info['folders'].append({
                'name': folder_name,
                'objects': len(blobs),
                'totalSizeBytes': folder_total,
                'cleanableObjects': len(cleanable),
                'cleanableSizeBytes': cleanable_size,
                'latestCreated': blobs[0].get('created') if blobs else None,
            })
            bucket_info['totalSizeBytes'] += folder_total
            bucket_info['totalObjects'] += len(blobs)
            bucket_info['cleanableSizeBytes'] += cleanable_size
            bucket_info['cleanableObjects'] += len(cleanable)

        result['buckets'].append(bucket_info)
        result['totalSizeBytes'] += bucket_info['totalSizeBytes']
        result['totalObjects'] += bucket_info['totalObjects']
        result['cleanableSizeBytes'] += bucket_info['cleanableSizeBytes']
        result['cleanableObjects'] += bucket_info['cleanableObjects']

    return result, gcf_buckets


def _get_artifact_registry_data(project_id):
    """Collect Artifact Registry Docker images info for gcf-artifacts."""
    from google.cloud import artifactregistry_v1

    client = artifactregistry_v1.ArtifactRegistryClient()
    result = {
        'repositories': [],
        'totalSizeBytes': 0,
        'totalImages': 0,
        'totalVersions': 0,
        'cleanableVersions': 0,
        'cleanableSizeBytes': 0,
    }

    # List repositories in the project (all regions)
    regions = ['us-central1']  # Cloud Functions region
    for region in regions:
        parent = f'projects/{project_id}/locations/{region}'
        try:
            repos = list(client.list_repositories(parent=parent))
        except Exception as e:
            print(f'[AR] Error listing repos in {region}: {e}')
            continue

        for repo in repos:
            if 'gcf-artifacts' not in repo.name and 'cloud-run-source-deploy' not in repo.name:
                continue

            repo_info = {
                'name': repo.name.split('/')[-1],
                'fullName': repo.name,
                'region': region,
                'format': str(repo.format.name) if repo.format else 'DOCKER',
                'images': [],
                'totalSizeBytes': 0,
                'totalVersions': 0,
                'cleanableVersions': 0,
                'cleanableSizeBytes': 0,
            }

            # List Docker images in the repository
            try:
                images = list(client.list_docker_images(parent=repo.name))
            except Exception as e:
                print(f'[AR] Error listing images in {repo.name}: {e}')
                continue

            # Group by image name (package) -  each function has multiple versions
            image_groups = {}
            for img in images:
                # Image URI format: region-docker.pkg.dev/project/repo/image_name@sha256:xxx
                # or with tags: region-docker.pkg.dev/project/repo/image_name:tag
                uri_parts = img.uri.split('/')
                img_name = uri_parts[-1].split('@')[0].split(':')[0] if uri_parts else 'unknown'

                if img_name not in image_groups:
                    image_groups[img_name] = []
                image_groups[img_name].append({
                    'uri': img.uri,
                    'name': img.name,
                    'sizeBytes': img.image_size_bytes or 0,
                    'uploadTime': img.upload_time.isoformat() if img.upload_time else None,
                    'buildTime': img.build_time.isoformat() if img.build_time else None,
                    'tags': list(img.tags) if img.tags else [],
                })

            for img_name, versions in image_groups.items():
                versions.sort(key=lambda v: v.get('uploadTime', ''), reverse=True)
                total_size = sum(v['sizeBytes'] for v in versions)
                cleanable = versions[1:] if len(versions) > 1 else []
                cleanable_size = sum(v['sizeBytes'] for v in cleanable)

                repo_info['images'].append({
                    'name': img_name,
                    'versions': len(versions),
                    'totalSizeBytes': total_size,
                    'cleanableVersions': len(cleanable),
                    'cleanableSizeBytes': cleanable_size,
                    'latestUpload': versions[0].get('uploadTime') if versions else None,
                    'latestTags': versions[0].get('tags', []) if versions else [],
                })
                repo_info['totalSizeBytes'] += total_size
                repo_info['totalVersions'] += len(versions)
                repo_info['cleanableVersions'] += len(cleanable)
                repo_info['cleanableSizeBytes'] += cleanable_size

            result['repositories'].append(repo_info)
            result['totalSizeBytes'] += repo_info['totalSizeBytes']
            result['totalImages'] += len(image_groups)
            result['totalVersions'] += repo_info['totalVersions']
            result['cleanableVersions'] += repo_info['cleanableVersions']
            result['cleanableSizeBytes'] += repo_info['cleanableSizeBytes']

    return result


def _cleanup_cloud_storage(gcs_client, gcf_buckets):
    """Delete old Cloud Storage deploy artifacts, keep only latest per function."""
    deleted_count = 0
    freed_bytes = 0
    errors = []

    for bucket_name in gcf_buckets:
        bucket = gcs_client.bucket(bucket_name)
        folders = {}
        for blob in bucket.list_blobs():
            parts = blob.name.split('/')
            folder = parts[0] if len(parts) > 1 else '__root__'
            if folder not in folders:
                folders[folder] = []
            folders[folder].append(blob)

        for folder_name, blobs in folders.items():
            blobs.sort(key=lambda b: b.time_created or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
            for old_blob in blobs[1:]:
                try:
                    freed_bytes += old_blob.size or 0
                    old_blob.delete()
                    deleted_count += 1
                except Exception as e:
                    errors.append(f'{old_blob.name}: {str(e)}')

    return deleted_count, freed_bytes, errors


def _cleanup_artifact_registry(project_id):
    """Delete old Docker image versions in Artifact Registry, keep latest per image."""
    from google.cloud import artifactregistry_v1

    client = artifactregistry_v1.ArtifactRegistryClient()
    deleted_count = 0
    freed_bytes = 0
    errors = []

    regions = ['us-central1']
    for region in regions:
        parent = f'projects/{project_id}/locations/{region}'
        try:
            repos = list(client.list_repositories(parent=parent))
        except Exception:
            continue

        for repo in repos:
            if 'gcf-artifacts' not in repo.name and 'cloud-run-source-deploy' not in repo.name:
                continue

            try:
                images = list(client.list_docker_images(parent=repo.name))
            except Exception:
                continue

            # Group by image name
            image_groups = {}
            for img in images:
                uri_parts = img.uri.split('/')
                img_name = uri_parts[-1].split('@')[0].split(':')[0] if uri_parts else 'unknown'
                if img_name not in image_groups:
                    image_groups[img_name] = []
                image_groups[img_name].append(img)

            for img_name, versions in image_groups.items():
                versions.sort(
                    key=lambda v: v.upload_time or datetime.min.replace(tzinfo=timezone.utc),
                    reverse=True,
                )
                for old_ver in versions[1:]:
                    try:
                        freed_bytes += old_ver.image_size_bytes or 0
                        # Delete the version via its resource name
                        # Docker image names are: projects/P/locations/L/repositories/R/dockerImages/IMG@sha256:HASH
                        # We need to delete the underlying package version
                        # Use the name field which is the full resource name
                        client.delete_package(name=old_ver.name.rsplit('/versions/', 1)[0]
                                              if '/versions/' in old_ver.name
                                              else old_ver.name.replace('/dockerImages/', '/packages/').split('@')[0])
                        deleted_count += 1
                    except Exception as e:
                        err_msg = str(e)
                        if 'NOT_FOUND' not in err_msg and err_msg not in [x.split(':')[0] for x in errors]:
                            errors.append(f'{img_name}: {err_msg[:120]}')

    return deleted_count, freed_bytes, errors


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST', 'GET']),
)
def manage_storage(req: https_fn.Request) -> https_fn.Response:
    """Gestiona artefactos de deploy en Cloud Storage y Artifact Registry.

    GET: Lista ambos almacenes con tamaÃ±o, objetos y limpiables.
         ?type=cs  â†’ solo Cloud Storage
         ?type=ar  â†’ solo Artifact Registry
         (sin type â†’ ambos)
    POST: { action: 'cleanup_cs' | 'cleanup_ar' | 'cleanup_all',
            pinHash: str }
    POST: { action: 'get_policies' }
    POST: { action: 'set_policies', policies: { cs: {...}, ar: {...} } , pinHash: str }
    """
    from google.cloud import storage as gcs

    db = firestore.client()
    project_id = 'adminlank'

    if req.method == 'GET':
        query_type = req.args.get('type', 'all')

        result = {}

        if query_type in ('all', 'cs'):
            try:
                gcs_client = gcs.Client()
                cs_data, _ = _get_cloud_storage_data(gcs_client)
                result['cloudStorage'] = cs_data
            except Exception as e:
                result['cloudStorage'] = {'error': str(e)}

        if query_type in ('all', 'ar'):
            try:
                ar_data = _get_artifact_registry_data(project_id)
                result['artifactRegistry'] = ar_data
            except Exception as e:
                result['artifactRegistry'] = {'error': str(e)}

        # Load auto-cleanup policies
        try:
            policy_doc = db.document('config/cleanup-policies').get()
            result['policies'] = policy_doc.to_dict() if policy_doc.exists else {
                'cloudStorage': {'autoCleanup': False, 'keepVersions': 1},
                'artifactRegistry': {'autoCleanup': False, 'keepVersions': 1},
            }
        except Exception:
            result['policies'] = {
                'cloudStorage': {'autoCleanup': False, 'keepVersions': 1},
                'artifactRegistry': {'autoCleanup': False, 'keepVersions': 1},
            }

        return https_fn.Response(
            json.dumps(result, default=str),
            content_type='application/json',
        )

    # â"€â"€ POST â"€â"€
    body = req.get_json(silent=True) or {}
    action = body.get('action', '')

    # â"€â"€ Get policies (no PIN needed) â"€â"€
    if action == 'get_policies':
        try:
            policy_doc = db.document('config/cleanup-policies').get()
            policies = policy_doc.to_dict() if policy_doc.exists else {
                'cloudStorage': {'autoCleanup': False, 'keepVersions': 1},
                'artifactRegistry': {'autoCleanup': False, 'keepVersions': 1},
            }
            return https_fn.Response(
                json.dumps({'policies': policies}, default=str),
                content_type='application/json',
            )
        except Exception as e:
            return https_fn.Response(
                json.dumps({'error': str(e)}),
                status=500, content_type='application/json',
            )

    # â"€â"€ Set policies â"€â"€
    if action == 'set_policies':
        pin_hash = body.get('pinHash', '')
        if not pin_hash:
            return https_fn.Response(
                json.dumps({'error': 'PIN requerido'}),
                status=401, content_type='application/json',
            )
        try:
            pin_doc = db.document('config/vault-security').get()
            if not pin_doc.exists or pin_doc.to_dict().get('pinHash') != pin_hash:
                return https_fn.Response(
                    json.dumps({'error': 'PIN incorrecto'}),
                    status=403, content_type='application/json',
                )
        except Exception as e:
            return https_fn.Response(
                json.dumps({'error': f'Error verificando PIN: {str(e)}'}),
                status=500, content_type='application/json',
            )

        new_policies = body.get('policies', {})
        db.document('config/cleanup-policies').set(new_policies, merge=True)

        lank_audit.log_change(
            db,
            source='manual',
            action='update_cleanup_policies',
            description='ActualizaciÃ³n de polÃ­ticas de limpieza automÃ¡tica',
            actor='admin',
            metadata={'policies': new_policies},
        )

        return https_fn.Response(
            json.dumps({'success': True, 'policies': new_policies}),
            content_type='application/json',
        )

    # â"€â"€ Cleanup actions â"€â"€
    if action not in ('cleanup_cs', 'cleanup_ar', 'cleanup_all', 'cleanup'):
        return https_fn.Response(
            json.dumps({'error': 'AcciÃ³n no reconocida'}),
            status=400, content_type='application/json',
        )

    # Legacy support: 'cleanup' â†’ 'cleanup_cs'
    if action == 'cleanup':
        action = 'cleanup_cs'

    pin_hash = body.get('pinHash', '')
    if not pin_hash:
        return https_fn.Response(
            json.dumps({'error': 'PIN requerido para esta operaciÃ³n'}),
            status=401, content_type='application/json',
        )

    try:
        pin_doc = db.document('config/vault-security').get()
        if not pin_doc.exists or pin_doc.to_dict().get('pinHash') != pin_hash:
            return https_fn.Response(
                json.dumps({'error': 'PIN incorrecto'}),
                status=403, content_type='application/json',
            )
    except Exception as e:
        return https_fn.Response(
            json.dumps({'error': f'Error verificando PIN: {str(e)}'}),
            status=500, content_type='application/json',
        )

    total_deleted = 0
    total_freed = 0
    all_errors = []
    results = {}

    # Cloud Storage cleanup
    if action in ('cleanup_cs', 'cleanup_all'):
        try:
            gcs_client = gcs.Client()
            _, gcf_buckets = _get_cloud_storage_data(gcs_client)
            cs_deleted, cs_freed, cs_errors = _cleanup_cloud_storage(gcs_client, gcf_buckets)
            results['cloudStorage'] = {
                'deletedObjects': cs_deleted,
                'freedBytes': cs_freed,
                'freedMB': round(cs_freed / (1024 * 1024), 1),
            }
            total_deleted += cs_deleted
            total_freed += cs_freed
            all_errors.extend([f'[CS] {e}' for e in cs_errors])
        except Exception as e:
            results['cloudStorage'] = {'error': str(e)}

    # Artifact Registry cleanup
    if action in ('cleanup_ar', 'cleanup_all'):
        try:
            ar_deleted, ar_freed, ar_errors = _cleanup_artifact_registry(project_id)
            results['artifactRegistry'] = {
                'deletedVersions': ar_deleted,
                'freedBytes': ar_freed,
                'freedMB': round(ar_freed / (1024 * 1024), 1),
            }
            total_deleted += ar_deleted
            total_freed += ar_freed
            all_errors.extend([f'[AR] {e}' for e in ar_errors])
        except Exception as e:
            results['artifactRegistry'] = {'error': str(e)}

    # Audit log
    lank_audit.log_change(
        db,
        source='manual',
        action='storage_cleanup',
        description=f'Limpieza de artefactos ({action}): {total_deleted} objetos eliminados, '
                    f'{total_freed / (1024*1024):.1f} MB liberados',
        actor='admin',
        metadata={
            'action': action,
            'totalDeleted': total_deleted,
            'totalFreedBytes': total_freed,
            'totalFreedMB': round(total_freed / (1024 * 1024), 1),
            'results': results,
            'errors': all_errors[:10],
        },
    )

    return https_fn.Response(
        json.dumps({
            'success': True,
            'action': action,
            'totalDeleted': total_deleted,
            'totalFreedBytes': total_freed,
            'totalFreedMB': round(total_freed / (1024 * 1024), 1),
            'results': results,
            'errors': all_errors[:10],
        }),
        content_type='application/json',
    )

