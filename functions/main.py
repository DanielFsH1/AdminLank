"""
AdminLank Cloud Function -  Análisis de correos IMAP + sincronización Firestore.

Endpoints:
  POST /analyze_emails   -  Ejecuta análisis completo de correos IMAP
  POST /update_schedule  -  Actualiza configuración de análisis programados
  POST /cleanup          -  Limpia notificaciones >7 días y alertas >30 días

Todas las credenciales IMAP se almacenan en Firestore (collection: config/imap-credentials).
El estado del análisis se guarda en Firestore (analysis/state, analysis/history).
"""
import json
import imaplib
import os
import re
import unicodedata
import traceback
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from uuid import uuid4

from firebase_functions import https_fn, scheduler_fn, options
from firebase_admin import initialize_app, firestore, auth
import google.cloud.firestore

import lank_mail_core as core
import lank_alerts
import lank_agent_review
import lank_audit
import lank_telegram
import adminbot_work_queue
from alert_pipeline import build_direct_alerts

app = initialize_app()

LANK_FROM = os.environ.get('LANK_FROM_EMAIL', 'info@example.com')
IGNORED_EVENT_KINDS = {'payment_user', 'payment_cashback', 'monthly_summary', 'cashback_validated', 'unknown'}
ADMINBOT_REVIEW_FINANCE_EVENT_KINDS = {'payment_user', 'payment_cashback'}
PROJECT_ID = (
    os.environ.get('FIREBASE_PROJECT_ID')
    or os.environ.get('GOOGLE_CLOUD_PROJECT')
    or os.environ.get('GCLOUD_PROJECT')
    or ''
)
JOIN_EVENT_KINDS = {'user_join_direct', 'user_join_transferred'}
LEAVE_EVENT_KINDS = {'user_left_self', 'user_left_transferred'}
WITHDRAWAL_EVENT_KINDS = {'withdrawal_requested', 'withdrawal_completed', 'withdrawal_detected'}
FINANCE_EVENT_KINDS = WITHDRAWAL_EVENT_KINDS | ADMINBOT_REVIEW_FINANCE_EVENT_KINDS
ROUTINE_INFO_EVENT_KINDS = {'group_validated', 'cashback_validated', 'monthly_summary'}
# Servicios donde altas/bajas de usuarios no requieren acción administrativa
# (no hay cuentas reales que gestionar, solo se monitorean renovaciones)
# Se deriva dinámicamente desde config/services (usesPool == false)
UNMANAGED_JOIN_LEAVE_SERVICES = {'Microsoft 365'}  # Fallback, se sobreescribe con config dinámica
ADMIN_UID = os.environ.get('DASHBOARD_ADMIN_UID', '')


def _json_response(payload, status=200):
    return https_fn.Response(
        json.dumps(payload),
        status=status,
        content_type='application/json',
    )


def require_dashboard_admin(req):
    """Return an HTTP error response unless req has the configured admin Firebase ID token."""
    if not ADMIN_UID:
        return _json_response(
            {'success': False, 'error': 'DASHBOARD_ADMIN_UID no configurado'},
            status=500,
        )

    headers = getattr(req, 'headers', {}) or {}
    authorization = ''
    if hasattr(headers, 'get'):
        authorization = headers.get('Authorization') or headers.get('authorization') or ''

    if not authorization.startswith('Bearer '):
        return _json_response(
            {'success': False, 'error': 'Authorization Bearer token requerido'},
            status=401,
        )

    token = authorization.split(' ', 1)[1].strip()
    if not token:
        return _json_response(
            {'success': False, 'error': 'Authorization Bearer token requerido'},
            status=401,
        )

    try:
        decoded = auth.verify_id_token(token)
    except Exception:
        return _json_response(
            {'success': False, 'error': 'Firebase ID token inválido'},
            status=401,
        )

    if decoded.get('uid') != ADMIN_UID:
        return _json_response(
            {'success': False, 'error': 'Acceso restringido al administrador de AdminLank'},
            status=403,
        )

    return None

# Mapeo de nombres de servicio a claves de Firestore
# Fallback hardcodeado -  se sobreescribe con config dinámica al inicio del análisis
SERVICE_TO_FS = {
    'ChatGPT Plus': 'chatgpt', 'YouTube Premium': 'youtube', 'HBO Max Platino': 'hbo',
    'Microsoft 365': 'microsoft365', 'Gemini AI': 'gemini', 'F1 TV Premium': 'f1tv',
}


def load_service_config(db):
    """Carga la configuración dinámica de servicios desde Firestore.
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
        # Servicios sin pool → unmanaged
        if svc.get('usesPool') is False:
            unmanaged.add(svc.get('name', key))
    return services, name_to_key, unmanaged


def _build_name_aliases(services_config):
    """Construye un diccionario {alias: nombre_canónico} para lank_mail_core."""
    if not services_config:
        return None
    aliases = {}
    for key, svc in services_config.items():
        canonical = svc.get('name', key)
        for alias in svc.get('nameAliases', []):
            aliases[alias] = canonical
        aliases[canonical] = canonical
    return aliases


# ───────────────────────────── HELPERS ──────────────────────────────

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
        'payment_user': 'registrar ingreso; no hay acción urgente',
        'payment_cashback': 'registrar ingreso; no hay acción urgente',
        'withdrawal_requested': 'esperar confirmación del retiro',
        'withdrawal_completed': 'registrar retiro completado',
        'group_deactivated': 'revisar grupo y retirar accesos',
        'group_validated': 'sin acción urgente; solo registrar estado',
        'cashback_validated': 'sin acción urgente; solo registrar estado',
        'monthly_summary': 'sin acción; solo registro',
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


# ────────────────────── FIRESTORE DATA LOADING ──────────────────────

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


def load_current_state_context(db, name_to_key=None, services_config=None):
    """Load current-state data from Firestore groups/ collections."""
    if name_to_key is None:
        name_to_key = dict(SERVICE_TO_FS)
    context = {}
    # Construir el mapeo inverso: key → nombre canónico
    if services_config:
        key_to_name = {
            key: svc.get('name', key)
            for key, svc in services_config.items()
            if svc.get('active') is not False
        }
    else:
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


def load_schedule_config(db):
    doc = db.document('config/schedule').get()
    if doc.exists:
        return doc.to_dict() or {}
    return {'enabled': False, 'frequencyHours': 6}


def load_snowball_config(db):
    """Load Snowball wallet/connection config from Firestore config/snowball."""
    try:
        doc = db.document('config/snowball').get()
        if doc.exists:
            data = doc.to_dict() or {}
            wallets = data.get('wallets') or {}
            connections = data.get('connections') or {}
            if isinstance(wallets, list):
                wallets = {str(w.get('accountId') or w.get('id') or idx): w for idx, w in enumerate(wallets) if isinstance(w, dict)}
            if isinstance(connections, list):
                connections = {str(c.get('id') or idx): c for idx, c in enumerate(connections) if isinstance(c, dict)}
            return {
                'wallets': wallets if isinstance(wallets, dict) else {},
                'connections': connections if isinstance(connections, dict) else {},
            }
    except Exception:
        pass
    return {'wallets': {}, 'connections': {}}


def load_known_bank_accounts(db):
    try:
        banks_doc = db.document('config/bank-accounts').get()
        if banks_doc.exists:
            accounts = (banks_doc.to_dict() or {}).get('accounts', [])
            if isinstance(accounts, dict):
                return [acc for acc in accounts.values() if isinstance(acc, dict)]
            if isinstance(accounts, list):
                return [acc for acc in accounts if isinstance(acc, dict)]
    except Exception:
        pass
    return []


def load_system_flags(db):
    doc = db.document('config/system-flags').get()
    if doc.exists:
        return doc.to_dict() or {}
    return {}



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


def load_pool_data(db, service):
    """Load service pool data for enriching alerts."""
    fs_key = SERVICE_TO_FS.get(service)
    if not fs_key:
        return {}
    try:
        docs = db.collection(f'service-pools/{fs_key}/real-accounts').stream()
        accounts = []
        for d in docs:
            acc = d.to_dict()
            acc['serviceAccountRef'] = acc.get('serviceAccountRef', d.id)
            accounts.append(acc)
        return {'accounts': accounts}
    except Exception:
        return {}


def save_alert_to_firestore(db, alert, created_at=None):
    stored_alert = dict(alert)
    aid = stored_alert.get('id') or stored_alert.get('_docId') or f"alert_{uuid4().hex[:12]}"
    stored_alert['id'] = aid
    stored_alert.setdefault('createdAt', created_at or datetime.now(timezone.utc).isoformat())
    db.collection('alerts').document(aid).set(stored_alert, merge=True)
    return stored_alert


# ────────────────────────── USER MATCHING ───────────────────────────

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


# ─────────────────────── EVENT CLASSIFICATION ───────────────────────

def _normalize_clabe(value):
    digits = core.normalize_account_number(value)
    return digits if digits and len(digits) == 18 else None


def _event_clabe_candidates(event):
    """Return unique normalized 18-digit CLABE candidates in deterministic source order."""
    candidates = []
    for candidate in event.get('clabes') or []:
        clabe = _normalize_clabe(candidate)
        if clabe and clabe not in candidates:
            candidates.append(clabe)
    account_clabe = _normalize_clabe(event.get('accountNumber'))
    if account_clabe and account_clabe not in candidates:
        candidates.append(account_clabe)
    return candidates


def _event_destination_clabe(event):
    candidates = _event_clabe_candidates(event)
    return candidates[0] if len(candidates) == 1 else None


def _match_known_bank_by_clabe(clabe, known_banks):
    if not clabe:
        return None
    for kb in known_banks or []:
        if not isinstance(kb, dict):
            continue
        kb_digits = _normalize_clabe(kb.get('clabe') or kb.get('accountNumber'))
        if kb_digits == clabe:
            return kb
    return None


def resolve_withdrawal_destination(event, db=None, snowball_config=None, known_banks=None):
    """Classify withdrawal destination as internal Snowball, external bank, or unclassified.

    Resolution is CLABE-first and deliberately ignores bank labels such as "STP" as an
    identity source. Internal Snowball wallet CLABEs win over external bank mappings;
    ambiguous or unknown CLABEs remain pending review and never synthesize a bank.
    """
    clabe_candidates = _event_clabe_candidates(event)
    if len(clabe_candidates) > 1:
        event.pop('destinationClabe', None)
        event.pop('destinationAccountId', None)
        event.pop('snowballConnectionId', None)
        event.pop('destinationBankId', None)
        event.pop('knownBankAccount', None)
        event.update({
            'movementType': 'unclassified_clabe',
            'classificationStatus': 'pending_review',
            'classificationReason': 'ambiguous_clabe_candidates',
            'clabeCandidates': clabe_candidates,
        })
        return {
            'movementType': 'unclassified_clabe',
            'classificationStatus': 'pending_review',
            'classificationReason': 'ambiguous_clabe_candidates',
            'clabeCandidates': clabe_candidates,
        }

    clabe = clabe_candidates[0] if clabe_candidates else None
    if clabe:
        event['destinationClabe'] = clabe

    if not clabe:
        legacy_account_number = core.normalize_account_number(event.get('accountNumber'))
        if legacy_account_number:
            event.pop('destinationClabe', None)
            event.pop('destinationAccountId', None)
            event.pop('snowballConnectionId', None)
            event.pop('destinationBankId', None)
            event.pop('knownBankAccount', None)
            event['movementType'] = 'external_bank'
            event['classificationStatus'] = 'legacy_account_number'
            return {'movementType': 'external_bank', 'classificationStatus': 'legacy_account_number'}
        event.pop('destinationAccountId', None)
        event.pop('snowballConnectionId', None)
        event.pop('destinationBankId', None)
        event.pop('knownBankAccount', None)
        event['movementType'] = 'unknown_destination'
        event['classificationStatus'] = 'missing_clabe'
        return {'movementType': 'unknown_destination', 'classificationStatus': 'missing_clabe'}

    if snowball_config is None and db is not None:
        snowball_config = load_snowball_config(db)
    snowball_config = snowball_config or {'wallets': {}, 'connections': {}}

    wallets = snowball_config.get('wallets') or {}
    if isinstance(wallets, list):
        wallets = {str(wallet.get('accountId') or wallet.get('id') or idx): wallet for idx, wallet in enumerate(wallets) if isinstance(wallet, dict)}
    for wallet_key, wallet in wallets.items():
        if not isinstance(wallet, dict):
            continue
        wallet_clabe = _normalize_clabe(wallet.get('walletClabe') or wallet.get('clabe'))
        if wallet.get('active') is False:
            continue
        if wallet_clabe != clabe:
            continue

        from_account = str(event.get('accountId') or '').strip()
        connection_match = None
        connections = snowball_config.get('connections') or {}
        if isinstance(connections, list):
            connections = {str(connection.get('id') or idx): connection for idx, connection in enumerate(connections) if isinstance(connection, dict)}
        for connection_key, connection in connections.items():
            if not isinstance(connection, dict):
                continue
            if connection.get('active') is False:
                continue
            if connection.get('destinationType') != 'lank_wallet':
                continue
            if str(connection.get('fromAccountId') or '').strip() != from_account:
                continue
            if _normalize_clabe(connection.get('destinationClabe')) != clabe:
                continue
            connection_match = {**connection, 'id': connection.get('id') or connection_key}
            break

        destination_account_id = str(wallet.get('accountId') or wallet_key)
        event.pop('destinationBankId', None)
        event.pop('knownBankAccount', None)
        event.pop('classificationReason', None)
        event.update({
            'movementType': 'snowball_internal',
            'classificationStatus': 'classified',
            'destinationAccountId': destination_account_id,
            'snowballConnectionId': connection_match.get('id') if connection_match else None,
        })
        result = {
            'movementType': 'snowball_internal',
            'classificationStatus': 'classified',
            'destinationAccountId': destination_account_id,
        }
        if event.get('snowballConnectionId'):
            result['snowballConnectionId'] = event.get('snowballConnectionId')
        return result

    if known_banks is None and db is not None:
        known_banks = load_known_bank_accounts(db)
    known_bank = _match_known_bank_by_clabe(clabe, known_banks or [])
    if known_bank:
        event.pop('destinationAccountId', None)
        event.pop('snowballConnectionId', None)
        event.pop('classificationReason', None)
        event.update({
            'movementType': 'external_bank',
            'classificationStatus': 'classified',
            'knownBankAccount': known_bank,
            'destinationBankId': known_bank.get('bankId') or known_bank.get('id') or known_bank.get('bank'),
        })
        return {
            'movementType': 'external_bank',
            'classificationStatus': 'classified',
            'knownBankAccount': known_bank,
            'destinationBankId': event.get('destinationBankId'),
        }

    event.pop('destinationAccountId', None)
    event.pop('snowballConnectionId', None)
    event.pop('destinationBankId', None)
    event.pop('knownBankAccount', None)
    event.pop('classificationReason', None)
    event.update({
        'movementType': 'unclassified_clabe',
        'classificationStatus': 'pending_review',
    })
    return {'movementType': 'unclassified_clabe', 'classificationStatus': 'pending_review'}


def classify_event(event, db_context, db=None):
    service = core.canonical_subscription(event.get('subscription')) or event.get('subscription')
    kind = event.get('kind')
    review = {
        'service': service, 'category': None, 'action': None, 'reason': None,
        'dbGroupStatus': None, 'matchStatus': None, 'matchesCurrent': [], 'matchesStale': [],
    }

    if kind in WITHDRAWAL_EVENT_KINDS:
        amount = core.parse_amount(event.get('amount'))
        bank = event.get('bank') or 'banco no informado'
        account_number = event.get('destinationClabe') or event.get('accountNumber') or 'cuenta no informada'
        destination = resolve_withdrawal_destination(event, db=db)
        if destination['movementType'] == 'snowball_internal':
            review['category'] = 'info' if kind == 'withdrawal_completed' else 'pending'
            review['action'] = 'transferencia interna Snowball'
            review['reason'] = f'transferencia interna Snowball por ${amount or event.get("amount") or "?"} hacia Lank #{destination.get("destinationAccountId")}'
            review['matchStatus'] = 'snowball_internal'
            return review
        if destination['movementType'] == 'unclassified_clabe':
            review['category'] = 'review'
            review['action'] = 'clasificar CLABE de retiro'
            review['reason'] = f'CLABE no clasificada en Snowball ni bancos externos: {account_number}'
            review['matchStatus'] = 'unclassified_clabe'
            return review
        if kind == 'withdrawal_detected':
            review['category'] = 'review'
            review['action'] = 'revisar retiro detectado por CLABE'
            review['reason'] = f'retiro detectado por ${amount or event.get("amount") or "?"} hacia {bank} / {account_number}'
            review['matchStatus'] = destination.get('movementType') or 'detected'
            return review
        if kind == 'withdrawal_requested':
            review['category'] = 'pending'
            review['action'] = 'esperar confirmación del retiro'
            review['reason'] = f'retiro solicitado por ${amount or event.get("amount") or "?"} hacia {bank} / {account_number}'
            review['matchStatus'] = destination.get('movementType') or 'awaiting_completion'
        else:
            review['category'] = 'info'
            review['action'] = 'retiro confirmado'
            review['reason'] = f'retiro completado por ${amount or event.get("amount") or "?"} hacia {bank} / {account_number}'
            review['matchStatus'] = destination.get('movementType') or 'completed'
        return review

    if kind in IGNORED_EVENT_KINDS:
        review['category'] = 'ignore'
        review['action'] = 'ignorar'
        review['reason'] = 'correo no operativo o informativo' if kind == 'unknown' else 'correo financiero/informativo'
        return review

    if not service:
        review['category'] = 'review'
        review['action'] = 'revisar manualmente'
        review['reason'] = 'no pude identificar la suscripción'
        return review

    # Servicios no gestionados: altas/bajas no requieren acción pero se registran
    if service in UNMANAGED_JOIN_LEAVE_SERVICES and kind in (JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS):
        review['category'] = 'info'
        review['action'] = 'sin acción requerida'
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
            review['reason'] = 'grupo validado pero no está activo en la base'
        else:
            review['category'] = 'info'
            review['action'] = 'sin acción'
            review['reason'] = 'validación sin impacto'
        return review

    if kind == 'group_deactivated':
        review['category'] = 'pending'
        review['action'] = 'revisar grupo y accesos'
        review['reason'] = 'Lank reportó que el grupo fue dado de baja'
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
            review['action'] = 'sin acción'
            review['reason'] = 'usuario ya estaba en la base'
            review['matchStatus'] = 'already_present'
            return review
        review['category'] = 'pending'
        review['action'] = 'agregar o confirmar usuario pendiente'
        review['reason'] = 'usuario nuevo no presente en la base'
        review['matchStatus'] = 'missing_from_current_state'
        if match['staleFound']:
            review['reason'] += '; aparece en histórico'
        if account_context.get('groupStatus') in {'no_group', 'empty', 'deactivated'}:
            review['reason'] += f"; base marca groupStatus={account_context.get('groupStatus')}"
        return review

    # LEAVE events
    if match['currentFound']:

        review['category'] = 'pending'
        review['action'] = 'quitar acceso o confirmar baja'
        review['reason'] = 'usuario sigue en la base'
        review['matchStatus'] = 'still_present_in_current_state'
        return review

    review['category'] = 'ignore'
    review['action'] = 'sin acción'
    review['reason'] = 'usuario ya no está en la base'
    review['matchStatus'] = 'already_absent_from_current_state'
    if match['staleFound']:
        review['reason'] += '; solo aparece en histórico'
    return review


# ─────────────────────── EVENT RECONCILIATION ───────────────────────

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
                review['action'] = 'sin acción'
                review['reason'] = 'alta superada por baja posterior'
                review['matchStatus'] = 'superseded_by_later_leave'
            elif kind in LEAVE_EVENT_KINDS and review.get('category') == 'pending' and review.get('matchStatus') == 'still_present_in_current_state' and later_join:
                review['category'] = 'ignore'
                review['action'] = 'sin acción'
                review['reason'] = 'baja superada por alta posterior'
                review['matchStatus'] = 'superseded_by_later_join'
            elif kind == 'withdrawal_requested' and review.get('category') == 'pending' and later_withdraw_completed:
                review['category'] = 'ignore'
                review['action'] = 'sin acción'
                review['reason'] = 'retiro ya confirmado'
                review['matchStatus'] = 'superseded_by_withdrawal_completed'


def rebuild_summary(events):
    summary = {'relevant': 0, 'pending': 0, 'review': 0, 'info': 0, 'ignored': 0, 'totalEvents': 0}
    for row in events:
        summary['totalEvents'] += 1
        bucket = 'ignored' if row['dbReview'].get('category') == 'ignore' else row['dbReview'].get('category')
        if bucket in summary:
            summary[bucket] += 1
        # 'relevant' = solo eventos que requieren atención (pending + review + info)
        if bucket not in ('ignored',):
            summary['relevant'] += 1
    return summary


def should_send_external_notice(event, review):
    if review.get('category') != 'info':
        return False

    kind = event.get('kind')
    service = review.get('service') or event.get('service') or event.get('subscription')
    if kind in ROUTINE_INFO_EVENT_KINDS:
        return False
    if service in UNMANAGED_JOIN_LEAVE_SERVICES and kind in (JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS):
        return False

    return review.get('notifyExternally') is True



def generate_alerts_for_accounts(db, ok_accounts, alerts_data, services_config=None,
                                  generated_at=None):
    alerts_generated = 0
    updated_services = {}
    external_notices = []
    agent_findings = []

    for account_result in ok_accounts:
        if account_result['access'] != 'ok':
            continue
        for evt_row in account_result['events']:
            evt = dict(evt_row.get('event', {}))
            kind = evt.get('kind', '')
            review = evt_row.get('dbReview', {})
            service = review.get('service') or evt.get('subscription')
            a_id = account_result['accountId']
            alias = account_result.get('accountAlias', '')
            user_alias = evt.get('userName', '?')
            cat = review.get('category', '')

            if not service:
                continue

            evt['accountId'] = a_id
            evt['accountAlias'] = alias
            evt['service'] = service
            evt['date'] = evt_row.get('date', '')
            evt['uid'] = evt_row.get('uid')
            evt['messageId'] = evt_row.get('messageId')

            enrichment = {
                'groupStatus': review.get('dbGroupStatus'),
                'matchesCurrent': review.get('matchesCurrent', []),
                'matchesStale': review.get('matchesStale', []),
            }

            if kind in ('user_left_self', 'user_left_transferred'):
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

                real_email = None
                real_status = None
                if svc_ref and fs_key:
                    pool_data = load_pool_data(db, service)
                    for pacc in pool_data.get('accounts', []):
                        if pacc.get('serviceAccountRef') == svc_ref:
                            real_email = pacc.get('email')
                            real_status = pacc.get('status', '')
                            break

                leave_reason = 'Salida voluntaria.' if kind == 'user_left_self' else 'Transferido fuera del grupo.'
                group_updated = update_group_on_leave(db, service, a_id, user_alias, leave_reason)
                if group_updated:
                    if service not in updated_services:
                        updated_services[service] = set()
                    updated_services[service].add(a_id)

                if not svc_ref:
                    agent_findings.extend(
                        lank_agent_review.resolve_join_alert_without_real_access(
                            db, alerts_data, service, a_id, alias, user_alias,
                            group_updated=group_updated,
                        )
                    )

                enrichment = {
                    **enrichment,
                    'serviceAccountRef': svc_ref,
                    'otherUsers': other_users,
                    'realAccountEmail': real_email,
                    'realAccountStatus': real_status,
                }

            direct_alerts = build_direct_alerts(
                event=evt,
                review=review,
                notification_doc_id=f'notification_{a_id}_{evt_row.get("uid")}',
                generated_at=generated_at or datetime.now(timezone.utc).isoformat(),
                existing_alerts=alerts_data['alerts'],
                enrichment=enrichment,
                services_config=services_config,
            )
            existing_business_keys = {
                alert.get('businessKey')
                for alert in alerts_data['alerts']
                if alert.get('businessKey')
            }
            for direct_alert in direct_alerts:
                business_key = direct_alert.get('businessKey')
                if business_key and business_key in existing_business_keys:
                    continue
                stored_alert = save_alert_to_firestore(db, direct_alert, created_at=generated_at)
                alerts_data['alerts'].append(stored_alert)
                if business_key:
                    existing_business_keys.add(business_key)
                alerts_generated += 1

            if should_send_external_notice(evt, review):
                external_notices.append({
                    'accountId': a_id,
                    'accountAlias': alias,
                    'userName': evt.get('userName') or 'usuario no informado',
                    'subscription': service,
                    'kind': kind,
                    'category': cat,
                    'action': review.get('action', ''),
                    'reason': review.get('reason', ''),
                    'date': evt_row.get('date', ''),
                })

    return alerts_generated, updated_services, external_notices, agent_findings


# ────────────────────────── IMAP ANALYSIS ───────────────────────────

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
            raise RuntimeError('No pude abrir buzón útil')

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
            message_id = core.decode_mime(msg.get('Message-ID', '')).strip()
            uid_int = int(uid)

            if uid_int > result['maxUid']:
                result['maxUid'] = uid_int
            body_snippet = (body or '')[:2000].strip()
            result['rawEmails'].append({
                'uid': uid_int,
                'date': date,
                'subject': subject,
                'bodySnippet': body_snippet,
                'messageId': message_id or None,
            })

            if is_non_operational_lank_mail(subject, body):
                continue

            event = core.parse_event(subject, body, account['id'], 'production', name_aliases=_build_name_aliases(services_config))
            amt = core.infer_amount(event, rates)
            if amt is not None:
                event['amount'] = amt

            review = classify_event(event, db_context, db)
            if (
                review['category'] == 'ignore'
                and event.get('kind') in IGNORED_EVENT_KINDS
                and event.get('kind') not in ADMINBOT_REVIEW_FINANCE_EVENT_KINDS
            ):
                continue

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


# ───────────────── NOTIFICATIONS (7-day retention) ──────────────────

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
            'messageId': raw.get('messageId'),
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


# ────────────────── FINANCE -  WITHDRAWAL TRACKING ──────────────────

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


def _ensure_month_rollover(db, current_month_key):
    """Archive old month totals and reset overview when the month changes."""
    try:
        overview_ref = db.document('finance/overview')
        overview_doc = overview_ref.get()
        if not overview_doc.exists:
            return

        data = overview_doc.to_dict()
        latest_month = data.get('latestMonth', '')

        if not latest_month or latest_month >= current_month_key:
            return

        old_totals = data.get('totals', {})
        months_list = data.get('months', [])
        access_list = data.get('access', [])

        archive_ref = db.document(f'finance/monthly-{latest_month}')
        archive_ref.set({
            'month': latest_month,
            'totals': old_totals,
            'accountCount': len(access_list),
            'generatedAt': data.get('updatedAt', datetime.now(timezone.utc).isoformat()),
            'archivedAt': datetime.now(timezone.utc).isoformat(),
            'archivedBy': 'auto_rollover',
        })

        if current_month_key not in months_list:
            months_list.append(current_month_key)

        zero_totals = {k: 0 for k in old_totals}

        # Recalculate manual expenses already confirmed for the new month
        ledger_doc = db.document('finance/manual-ledger').get()
        if ledger_doc.exists:
            entries = ledger_doc.to_dict().get('entries', [])
            for entry in entries:
                eff = entry.get('effectiveAt', '')
                if not eff.startswith(current_month_key):
                    continue
                if entry.get('status') != 'confirmed':
                    continue
                amount = float(entry.get('amount') or 0)
                etype = entry.get('type', '')
                if etype in ('expense', 'investment'):
                    zero_totals['manualExpensesGross'] = zero_totals.get('manualExpensesGross', 0) + amount
                elif etype == 'deposit':
                    zero_totals['manualDepositsGross'] = zero_totals.get('manualDepositsGross', 0) + amount

            me = zero_totals.get('manualExpensesGross', 0)
            mi = zero_totals.get('manualInvestmentsGross', 0)
            md = zero_totals.get('manualDepositsGross', 0)
            wc = zero_totals.get('withdrawalCompletedGross', 0)
            wk = zero_totals.get('walletCreditsGross', 0)
            zero_totals['bankNetAfterExpenses'] = round(wc + md - me - mi, 2)
            zero_totals['estimatedNetWallet'] = round(wk + md - me - mi, 2)

        overview_ref.update({
            'latestMonth': current_month_key,
            'months': months_list,
            'totals': zero_totals,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'updatedBy': 'auto_rollover',
        })

        print(f'Finance month rollover: {latest_month} -> {current_month_key}')
    except Exception as e:
        print(f'Warning: month rollover failed: {e}')


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

    _ensure_month_rollover(db, current_month_key)

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

            destination = resolve_withdrawal_destination(evt, db=db)
            destination_clabe = evt.get('destinationClabe') or evt.get('accountNumber')

            withdrawal_events.append({
                'kind': kind,
                'accountId': a_id,
                'accountAlias': alias,
                'amount': amount,
                'bank': (evt.get('bank') or '').strip()[:30] or None,
                'accountType': evt.get('accountType'),
                'accountNumber': destination_clabe,
                'destinationClabe': evt.get('destinationClabe'),
                'movementType': destination.get('movementType') or evt.get('movementType'),
                'classificationStatus': destination.get('classificationStatus') or evt.get('classificationStatus'),
                'classificationReason': destination.get('classificationReason') or evt.get('classificationReason'),
                'clabeCandidates': destination.get('clabeCandidates') or evt.get('clabeCandidates'),
                'snowballConnectionId': destination.get('snowballConnectionId') or evt.get('snowballConnectionId'),
                'destinationAccountId': destination.get('destinationAccountId') or evt.get('destinationAccountId'),
                'destinationBankId': destination.get('destinationBankId') or evt.get('destinationBankId'),
                'emailDate': email_dt.isoformat(),
                'monthName': month_name,
                'monthKey': f'{email_dt.year}-{str(email_dt.month).zfill(2)}',
                'uid': evt_row.get('uid'),
                'withdrawalId': _make_withdrawal_id(evt, a_id, evt_row.get('uid')),
            })

    if not withdrawal_events:
        return 0

    # Load known bank accounts for enrichment
    known_banks = load_known_bank_accounts(db)

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

        known = match_known_bank(we.get('accountNumber')) if we.get('movementType') == 'external_bank' else None
        base_payload = {
            'movementType': we.get('movementType') or 'unknown_destination',
            'classificationStatus': we.get('classificationStatus') or 'pending_review',
            'classificationReason': we.get('classificationReason'),
            'clabeCandidates': we.get('clabeCandidates'),
            'destinationClabe': we.get('destinationClabe') or we.get('accountNumber'),
            'snowballConnectionId': we.get('snowballConnectionId'),
            'destinationAccountId': we.get('destinationAccountId'),
            'destinationBankId': we.get('destinationBankId'),
        }

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
                **base_payload,
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
                    **base_payload,
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
                            **base_payload,
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
                        **base_payload,
                    })

            records_written += 1
            months_affected.add(we['monthKey'])

        elif we['kind'] == 'withdrawal_detected':
            if existing.exists:
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
                'status': 'review',
                'createdBy': 'cloud_function',
                'createdAt': now.isoformat(),
                **base_payload,
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
        snowball_internal_gross = 0.0
        snowball_internal_count = 0
        unclassified_gross = 0.0
        unclassified_count = 0

        records = db.collection(f'finance/withdrawals-{month_name}/records').stream()
        for rec in records:
            rd = rec.to_dict()
            amount = float(rd.get('amount') or 0)
            status = rd.get('status', '')
            movement_type = rd.get('movementType') or 'external_bank'
            if movement_type == 'snowball_internal':
                snowball_internal_gross += amount
                snowball_internal_count += 1
                continue
            if movement_type == 'unclassified_clabe':
                unclassified_gross += amount
                unclassified_count += 1
                continue
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
            'snowballInternalGross': round(snowball_internal_gross, 2),
            'snowballInternalTransfers': snowball_internal_count,
            'unclassifiedClabeGross': round(unclassified_gross, 2),
            'unclassifiedClabeWithdrawals': unclassified_count,
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


# ──────────────────────── UPDATE GROUP STATE ────────────────────────

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
        notes.append(f'{date_str}: {user_alias} salió del grupo. {reason}'.strip())
        doc_ref.update({
            'users': users,
            'hasUsers': len(users) > 0,
            'notes': notes,
        })

        # Registrar en audit-log para que aparezca en Historial
        account_alias = data.get('accountAlias') or data.get('fullName') or str(account_id)
        try:
            lank_audit.log_change(
                db,
                source='ai_analysis',
                action='remove_user',
                description=f'{user_alias} dado de baja del grupo #{account_id} ({account_alias}) - {service}. {reason}'.strip(),
                collection=f'groups/{fs_key}/lank-accounts/{account_id}',
                document_id=str(account_id),
                field='users',
                before={'userAlias': user_alias, 'totalUsers': original_count},
                after={'totalUsers': len(users)},
                actor='system',
                ai_involved=True,
                metadata={'service': service, 'accountAlias': account_alias, 'reason': reason},
            )
        except Exception:
            pass

        # Si el grupo quedo vacio, registrar la desactivacion
        if len(users) == 0:
            try:
                lank_audit.log_change(
                    db,
                    source='ai_analysis',
                    action='delete_lank_group',
                    description=f'Grupo #{account_id} ({account_alias}) quedo vacio en {service}. Ultimo usuario: {user_alias}.',
                    collection=f'groups/{fs_key}/lank-accounts/{account_id}',
                    document_id=str(account_id),
                    actor='system',
                    ai_involved=True,
                    metadata={'service': service, 'accountAlias': account_alias, 'lastUser': user_alias},
                )
            except Exception:
                pass

        # Cancelar alertas pending de este usuario (renovación, teléfono faltante, etc.)
        try:
            alias_lower = normalize_alias(user_alias)
            pending_alerts = db.collection('alerts').where('status', '==', 'pending').where(
                'userAlias', '==', user_alias
            ).stream()
            for alert_doc in pending_alerts:
                alert = alert_doc.to_dict()
                a_type = alert.get('type', '')
                # Solo cancelar alertas de teléfono faltante
                if 'missing_phone' in a_type:
                    alert_doc.reference.update({
                        'status': 'cancelled_by_system',
                        'completedAt': datetime.now(timezone.utc).isoformat(),
                        'resolution': f'Usuario {user_alias} se dio de baja del grupo.',
                    })
        except Exception as e:
            print(f'Warning: could not cancel pending alerts for {user_alias}: {e}')

        return True
    return False


def build_enabled_analysis_accounts(credentials, registry):
    cred_by_id = {int(a['accountId']): a for a in credentials}
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
    return accounts


def run_analysis_accounts(db, accounts, rates, db_context, state, services_config, days=3):
    report = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'days': days,
        'usedUidTracking': state.get('lastRun') is not None,
        'accounts': [],
    }
    new_state_accounts = dict(state.get('accounts', {}))

    for account in accounts:
        aid = str(account['id'])
        last_uid = new_state_accounts.get(aid, {}).get('lastUid')
        account_result = analyze_account(
            account, rates, days, db_context, db, last_uid,
            services_config=services_config,
        )
        report['accounts'].append(account_result)

        if account_result.get('rawEmails'):
            save_notifications(
                db,
                account['id'],
                account.get('canonicalAlias', ''),
                account_result['rawEmails'],
                analysis_timestamp=report['generatedAt'],
            )

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

    state['lastRun'] = datetime.now(timezone.utc).isoformat()
    state['accounts'] = new_state_accounts
    return report, state


def analysis_totals(ok_accounts):
    return {
        'totalPending': sum(a['summary']['pending'] for a in ok_accounts),
        'totalRelevant': sum(a['summary']['relevant'] for a in ok_accounts),
        'totalRawEmails': sum(len(a.get('rawEmails', [])) for a in ok_accounts),
        'totalEvents': sum(a['summary']['totalEvents'] for a in ok_accounts),
        'totalIgnored': sum(a['summary']['ignored'] for a in ok_accounts),
        'totalReview': sum(a['summary']['review'] for a in ok_accounts),
    }


def _raw_email_by_uid(account):
    return {
        str(raw.get('uid')): raw
        for raw in account.get('rawEmails', [])
        if raw.get('uid') is not None
    }


def _event_uid(row):
    return row.get('uid') or row.get('event', {}).get('uid')


def _finance_action_for_event(event):
    kind = event.get('kind')
    if kind in {'payment_user', 'payment_cashback'}:
        return 'review_and_register_deposit'
    if kind == 'withdrawal_requested':
        if event.get('movementType') == 'unclassified_clabe':
            return 'review_unclassified_withdrawal_clabe'
        return 'watch_withdrawal_until_completed'
    if kind == 'withdrawal_completed':
        if event.get('movementType') == 'unclassified_clabe':
            return 'review_unclassified_withdrawal_clabe'
        return 'verify_withdrawal_record'
    if kind == 'withdrawal_detected':
        return 'review_withdrawal_email'
    return 'review_finance_event'


def _build_finance_work_item(account, row, raw_email):
    event = row.get('event', {})
    kind = event.get('kind')
    amount = core.parse_amount(event.get('amount'))
    item = {
        'kind': kind,
        'accountId': account.get('accountId'),
        'accountAlias': account.get('accountAlias', ''),
        'uid': _event_uid(row),
        'messageId': row.get('messageId') or (raw_email or {}).get('messageId'),
        'subject': row.get('subject') or (raw_email or {}).get('subject'),
        'amount': amount if amount is not None else event.get('amount'),
        'action': _finance_action_for_event(event),
        'rawEmail': raw_email or {},
        'event': {
            'kind': kind,
            'amount': event.get('amount'),
            'accountNumber': event.get('accountNumber'),
            'destinationClabe': event.get('destinationClabe'),
            'movementType': event.get('movementType'),
            'classificationStatus': event.get('classificationStatus'),
            'classificationReason': event.get('classificationReason'),
            'clabeCandidates': event.get('clabeCandidates'),
            'knownBankAccount': event.get('knownBankAccount'),
            'destinationAccountId': event.get('destinationAccountId'),
            'destinationBankId': event.get('destinationBankId'),
            'snowballConnectionId': event.get('snowballConnectionId'),
            'action': event.get('action'),
        },
    }
    return item


def build_adminbot_domain_summary(ok_accounts, finance_records=0, alerts_generated=0):
    membership_items = []
    finance_items = []
    unknown_items = []
    accounts_summary = {}

    for account in ok_accounts or []:
        account_id = str(account.get('accountId'))
        raw_by_uid = _raw_email_by_uid(account)
        account_domains = set()
        account_membership = 0
        account_finance = 0
        account_unknown = 0

        for row in account.get('events', []):
            event = row.get('event', {})
            kind = event.get('kind')
            uid = _event_uid(row)
            raw_email = raw_by_uid.get(str(uid), {})

            if kind in FINANCE_EVENT_KINDS:
                account_domains.add('finance')
                account_finance += 1
                finance_items.append(_build_finance_work_item(account, row, raw_email))
            elif kind in JOIN_EVENT_KINDS | LEAVE_EVENT_KINDS | {'group_deactivated', 'group_validated'}:
                account_domains.add('membership')
                account_membership += 1
                membership_items.append({
                    'kind': kind,
                    'accountId': account.get('accountId'),
                    'accountAlias': account.get('accountAlias', ''),
                    'uid': uid,
                    'service': row.get('dbReview', {}).get('service') or event.get('subscription'),
                    'userAlias': event.get('userName'),
                    'action': row.get('dbReview', {}).get('action') or event.get('action'),
                    'subject': row.get('subject') or raw_email.get('subject'),
                })
            elif kind == 'unknown':
                account_domains.add('unknown')
                account_unknown += 1
                unknown_items.append({
                    'kind': kind,
                    'accountId': account.get('accountId'),
                    'accountAlias': account.get('accountAlias', ''),
                    'uid': uid,
                    'subject': row.get('subject') or raw_email.get('subject'),
                    'rawEmail': raw_email,
                })

        if account.get('rawEmails') and account_finance and not account_membership:
            message = 'Hubo movimiento financiero; no hubo cambios de membresía.'
        elif account.get('rawEmails') and account_membership:
            message = 'Hubo novedad de membresía/grupos.'
        elif account.get('rawEmails'):
            message = 'Hubo correos crudos sin trabajo operativo clasificado.'
        else:
            message = 'Sin correos crudos en esta corrida.'

        if account.get('rawEmails') or account_domains:
            accounts_summary[account_id] = {
                'accountId': account.get('accountId'),
                'accountAlias': account.get('accountAlias', ''),
                'domains': sorted(account_domains),
                'membershipEvents': account_membership,
                'financeEvents': account_finance,
                'unknownEvents': account_unknown,
                'message': message,
            }

    finance_requires_review = any(
        item.get('kind') in ADMINBOT_REVIEW_FINANCE_EVENT_KINDS
        or item.get('event', {}).get('classificationStatus') in {'pending_review', 'missing_clabe'}
        for item in finance_items
    )

    return {
        'membership': {
            'eventCount': len(membership_items),
            'items': membership_items,
            'message': (
                'Hay cambios de membresía/grupos para revisar.'
                if membership_items
                else 'No hubo cambios de membresía/grupos en esta corrida.'
            ),
        },
        'finance': {
            'eventCount': len(finance_items),
            'recordsUpdated': finance_records,
            'items': finance_items,
            'requiresAdminBotReview': finance_requires_review,
            'message': (
                'Hubo movimiento financiero; revisar retiros, depósitos y CLABEs.'
                if finance_items
                else 'No hubo movimiento financiero en esta corrida.'
            ),
        },
        'unknown': {
            'eventCount': len(unknown_items),
            'items': unknown_items,
        },
        'accounts': accounts_summary,
        'financeWorkItems': finance_items,
        'operatorGuidance': [
            'No narrar eventos financieros como grupos vacíos.',
            'Separar membresía/grupos de finanzas en la respuesta final.',
            'Para retiros, usar la CLABE como llave: Snowball primero, bancos externos después.',
            'Para depósitos/pagos acreditados, AdminBot debe revisar el correo crudo y registrar si corresponde.',
        ],
        'alertsGeneratedByBackend': alerts_generated,
    }


def build_failed_accounts_payload(report):
    failed_accounts = [a for a in report['accounts'] if a['access'] != 'ok']
    return failed_accounts, [{
        'accountId': a['accountId'],
        'accountAlias': a.get('accountAlias', ''),
        'access': a.get('access', 'unknown'),
        'error': a.get('error', 'Error desconocido'),
    } for a in failed_accounts]


def persist_latest_analysis_report(db, report, ok_accounts, totals, alerts_generated, failed_payload, domain_summary=None):
    db.document('analysis/latest-report').set({
        'generatedAt': report['generatedAt'],
        'mode': 'UID tracking' if report.get('usedUidTracking') else 'date fallback',
        'totalAccounts': len(report['accounts']),
        'accountsOk': len(ok_accounts),
        'accountCount': len(ok_accounts),
        'totalPending': totals['totalPending'],
        'totalRelevant': totals['totalRelevant'],
        'totalRawEmails': totals['totalRawEmails'],
        'totalEvents': totals['totalEvents'],
        'totalIgnored': totals['totalIgnored'],
        'totalReview': totals['totalReview'],
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
        'failedAccounts': failed_payload,
        'domainSummary': domain_summary or {},
    })


# ────────────────────── MAIN ANALYSIS FUNCTION ──────────────────────

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
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

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
        db_context = load_current_state_context(db, name_to_key, services_config)
        state = load_analysis_state(db)
        accounts = build_enabled_analysis_accounts(credentials, registry)
        alerts_data = load_alerts_from_firestore(db)
        report, state = run_analysis_accounts(
            db, accounts, rates, db_context, state, services_config,
        )

        # Save report to Firestore
        ok_accounts = [a for a in report['accounts'] if a['access'] == 'ok']


        alerts_generated, updated_services, external_notices, agent_findings = generate_alerts_for_accounts(
            db, ok_accounts, alerts_data, services_config=services_config,
            generated_at=report['generatedAt'],
        )
        scheduled_manual_alert_count = lank_alerts.generate_scheduled_manual_alerts(db)
        alerts_generated += scheduled_manual_alert_count

        # Save analysis state AFTER alert generation so a crash during alerts
        # doesn't permanently skip unprocessed emails (UIDs not yet committed).
        save_analysis_state(db, state)

        totals = analysis_totals(ok_accounts)
        failed_accounts, failed_accounts_payload = build_failed_accounts_payload(report)

        # Update finance documents from withdrawal events before creating the
        # AdminBot job, so the job can explain what was already written.
        finance_records = 0
        try:
            finance_records = update_finance_from_analysis(db, ok_accounts)
        except Exception as e:
            print(f'Warning: finance update failed: {e}')

        domain_summary = build_adminbot_domain_summary(
            ok_accounts,
            finance_records=finance_records,
            alerts_generated=alerts_generated,
        )
        persist_latest_analysis_report(
            db, report, ok_accounts, totals, alerts_generated, failed_accounts_payload,
            domain_summary=domain_summary,
        )

        queued_job = adminbot_work_queue.enqueue_analysis_job(
            db,
            idempotency_key=f"manual:{report['generatedAt']}",
            payload={
                'type': 'manual_analysis',
                'runSource': 'dashboard',
                'analysisGeneratedAt': report['generatedAt'],
                'reportRef': 'analysis/latest-report',
                'failedAccounts': failed_accounts_payload,
                'notificationAccountIds': [
                    str(a['accountId']) for a in ok_accounts if a.get('rawEmails')
                ],
                'summary': {
                    'accountsOk': len(ok_accounts),
                    'totalAccounts': len(report['accounts']),
                    'totalRawEmails': totals['totalRawEmails'],
                    'alertsGeneratedByBackend': alerts_generated,
                },
                'domainSummary': domain_summary,
                'financeWorkItems': domain_summary.get('financeWorkItems', []),
                'operatorGuidance': domain_summary.get('operatorGuidance', []),
                'financeRecordsUpdated': finance_records,
                'telegramPolicy': {
                    'sendStart': True,
                    'sendFinal': True,
                },
            },
        )
        adminbot_work_queue.write_latest_adminbot_state(
            db,
            job_id=str(queued_job['jobId']),
            status=str(queued_job['status']),
            run_source='dashboard',
            analysis_generated_at=report['generatedAt'],
        )

        # Run cleanup
        cleanup_old_data(db)

        # Build response
        response_data = {
            'success': True,
            'analyzedAccounts': len(ok_accounts),
            'totalAccounts': len(report['accounts']),
            'totalRawEmails': totals['totalRawEmails'],
            'totalPending': totals['totalPending'],
            'totalRelevant': totals['totalRelevant'],
            'alertsGenerated': alerts_generated,
            'financeRecordsUpdated': finance_records,
            'generatedAt': report['generatedAt'],
        }


        # Detectar usuarios sin teléfono (preparación para WhatsApp)
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

        schedule_config = load_schedule_config(db)
        agent_review = lank_agent_review.build_review_document(
            db,
            trigger='manual',
            report=report,
            ok_accounts=ok_accounts,
            failed_accounts=failed_accounts,
            alerts_generated=alerts_generated,
            extra_findings=agent_findings,
            finance_records=finance_records,
            schedule_config=schedule_config,
            domain_summary=domain_summary,
        )
        agent_review_text = lank_agent_review.build_notification_text(agent_review)

        # ─── Notificaciones de Telegram ─────────────────────────────────
        try:
            tg = lank_telegram.TelegramBot(db)
            if tg.is_enabled:
                notified = False

                # Calcular total de alertas (primera capa)
                total_alerts = alerts_generated

                # 1. Alertas de Firestore con status pending (incluye primera capa)
                if total_alerts > 0:
                    new_alerts = list(db.collection('alerts')
                                     .where('status', '==', 'pending')
                                     .order_by('createdAt', direction='DESCENDING')
                                     .limit(max(total_alerts, 10)).stream())
                    alert_dicts = [a.to_dict() for a in new_alerts]
                    if alert_dicts:
                        tg.send_alert_notification(alert_dicts)
                        notified = True
                        print(f'[Telegram] Notificación enviada: {len(alert_dicts)} alertas '
                              f'(scripts: {alerts_generated})')

                # 2. Fallback: buscar alertas pending recientes (últimos 10 min)
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

                if external_notices:
                    pseudo_alerts = []
                    for evt in external_notices:
                        pseudo_alerts.append({
                            'title': f"{evt.get('userName', '?')} - {evt.get('subscription', '?')}",
                            'description': evt.get('action', 'Acción requerida'),
                            'priority': 'high' if 'join' in evt.get('kind', '') else 'medium',
                            'service': evt.get('subscription', '?'),
                            'accountId': evt.get('accountId', '?'),
                            'accountAlias': evt.get('accountAlias', '?'),
                        })
                    tg.send_alert_notification(pseudo_alerts)

                # Notificar cuentas con error
                if failed_accounts:
                    tg.send_analysis_errors([{
                        'accountId': a['accountId'],
                        'accountAlias': a.get('accountAlias', ''),
                        'error': a.get('error', 'Error desconocido'),
                    } for a in failed_accounts])

                if agent_review.get('shouldNotify') and agent_review_text:
                    tg.send_message(agent_review_text, parse_mode=None)
        except Exception as tg_err:
            print(f'[Telegram] Error no fatal enviando notificación: {tg_err}')
        # ──────────────────────────────────────────────────────────────────

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


# ───────────────────────── SCHEDULE CONFIG ──────────────────────────

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST", "OPTIONS"]),
    region="us-central1",
)
def update_schedule(req: https_fn.Request) -> https_fn.Response:
    """Update the scheduled analysis configuration."""
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

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
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error
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
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

    import time as _time
    start_ts = _time.time()
    checks = {}
    now = datetime.now(timezone.utc)

    db = None
    try:
        db = firestore.client()
        checks['firestore'] = {'status': 'ok', 'message': 'Conexión exitosa'}
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
            checks['last_analysis'] = {'status': 'warning', 'message': 'Sin datos de análisis'}
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


# ────────────────────── AUDIT LOG (Dashboard) ───────────────────────

AUDIT_LOG_MAX_LIMIT = 1000


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["GET", "OPTIONS"]),
    region="us-central1",
    timeout_sec=30,
    memory=options.MemoryOption.MB_256,
)
def get_audit_log(req: https_fn.Request) -> https_fn.Response:
    """Lee las últimas entradas del audit-log para el dashboard.

    Filtra en memoria para evitar necesidad de índices compuestos en Firestore.

    Query params:
        limit: int (default 50, max 1000)
        source: str (filtro por fuente: ai_analysis, ai_chat, manual, system, adminbot)
        actor: str (filtro por actor: admin, ai, system)
        action: str (filtro por acción: create_alert, remove_user, etc.)
    """
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

    try:
        db = firestore.client()
        limit = min(int(req.args.get('limit', 50)), AUDIT_LOG_MAX_LIMIT)
        source_filter = req.args.get('source', '').strip()
        actor_filter = req.args.get('actor', '').strip()
        action_filter = req.args.get('action', '').strip()

        # Leer sin filtros compuestos evita índices extra; si se filtra en memoria,
        # se escanea hasta el máximo retenido para no ocultar coincidencias recientes.
        scan_limit = AUDIT_LOG_MAX_LIMIT if (
            source_filter or actor_filter or action_filter
        ) else limit

        from google.cloud.firestore_v1 import Query as FsQuery
        docs = list(
            db.collection('audit-log')
            .order_by('timestamp', direction=FsQuery.DESCENDING)
            .limit(scan_limit)
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


# ───────────────────────────── AI CHAT ──────────────────────────────

# ─────────────── SCHEDULED ANALYSIS (runs if enabled) ───────────────

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

# ──────────────────── Active hours window check ─────────────────────
    active_hours = config.get('activeHours')
    if active_hours and active_hours.get('enabled'):
        tz_offset = active_hours.get('tzOffset', 0)  # minutes offset from UTC
        local_now = now + timedelta(minutes=-tz_offset)  # convert UTC to user's local time
        current_hour = local_now.hour + local_now.minute / 60.0
        start_hour = active_hours.get('startHour', 0)
        end_hour = active_hours.get('endHour', 24)

        if start_hour < end_hour:
            # Normal range (e.g., 6:00 to 22:00). The configured end hour is
            # inclusive for exact boundary slots, so a 22:00 scheduled run is
            # allowed while 22:30 is still outside the window.
            in_window = start_hour <= current_hour <= end_hour
        else:
            # Overnight range (e.g., 22:00 to 06:00), also inclusive at the
            # exact end boundary.
            in_window = current_hour >= start_hour or current_hour <= end_hour

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
    db_context = load_current_state_context(db, name_to_key, services_config)
    accounts = build_enabled_analysis_accounts(credentials, registry)
    alerts_data = load_alerts_from_firestore(db)
    report, state = run_analysis_accounts(
        db, accounts, rates, db_context, state, services_config,
    )

    # Save report
    ok_accounts = [a for a in report['accounts'] if a['access'] == 'ok']


    alerts_generated, _, external_notices, agent_findings = generate_alerts_for_accounts(
        db, ok_accounts, alerts_data, services_config=services_config,
        generated_at=report['generatedAt'],
    )
    scheduled_manual_alert_count = lank_alerts.generate_scheduled_manual_alerts(db)
    alerts_generated += scheduled_manual_alert_count

    # Save analysis state AFTER alert generation so a crash during alerts
    # doesn't permanently skip unprocessed emails (UIDs not yet committed).
    save_analysis_state(db, state)

    totals = analysis_totals(ok_accounts)
    failed_accounts, failed_accounts_payload = build_failed_accounts_payload(report)

    # Update finance documents from withdrawal events before creating the
    # AdminBot job, so the job can explain what was already written.
    finance_records = 0
    try:
        finance_records = update_finance_from_analysis(db, ok_accounts)
        if finance_records > 0:
            print(f'Finance: {finance_records} withdrawal records updated')
    except Exception as e:
        print(f'Warning: scheduled finance update failed: {e}')

    domain_summary = build_adminbot_domain_summary(
        ok_accounts,
        finance_records=finance_records,
        alerts_generated=alerts_generated,
    )
    persist_latest_analysis_report(
        db, report, ok_accounts, totals, alerts_generated, failed_accounts_payload,
        domain_summary=domain_summary,
    )

    queued_job = adminbot_work_queue.enqueue_analysis_job(
        db,
        idempotency_key=f"scheduled:{current_slot.isoformat()}",
        payload={
            'type': 'scheduled_analysis',
            'runSource': 'scheduler',
            'scheduleSlot': current_slot.isoformat(),
            'analysisGeneratedAt': report['generatedAt'],
            'reportRef': 'analysis/latest-report',
            'failedAccounts': failed_accounts_payload,
            'notificationAccountIds': [
                str(a['accountId']) for a in ok_accounts if a.get('rawEmails')
            ],
            'summary': {
                'accountsOk': len(ok_accounts),
                'totalAccounts': len(report['accounts']),
                'totalRawEmails': totals['totalRawEmails'],
                'alertsGeneratedByBackend': alerts_generated,
            },
            'domainSummary': domain_summary,
            'financeWorkItems': domain_summary.get('financeWorkItems', []),
            'operatorGuidance': domain_summary.get('operatorGuidance', []),
            'financeRecordsUpdated': finance_records,
            'telegramPolicy': {
                'sendStart': True,
                'sendFinal': True,
            },
        },
    )
    adminbot_work_queue.write_latest_adminbot_state(
        db,
        job_id=str(queued_job['jobId']),
        status=str(queued_job['status']),
        run_source='scheduler',
        analysis_generated_at=report['generatedAt'],
        schedule_slot=current_slot.isoformat(),
    )

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

        if ar_policy.get('autoCleanup') and PROJECT_ID:
            ar_del, ar_freed, _ = _cleanup_artifact_registry(PROJECT_ID)
            if ar_del > 0:
                print(f'[Auto-cleanup AR] {ar_del} versiones, {ar_freed / (1024*1024):.1f} MB liberados')
    except Exception as ac_err:
        print(f'[Auto-cleanup] Error no fatal: {ac_err}')

    # Detectar usuarios sin teléfono (preparación para WhatsApp)
    missing_phone_count = lank_alerts.generate_missing_phone_alerts(db, services_config)
    if missing_phone_count > 0:
        print(f'Missing phone alerts generated: {missing_phone_count}')
        alerts_generated += missing_phone_count

    # Alertas de cuentas de crédito (corte y pago)
    credit_alert_count = lank_alerts.generate_credit_alerts(db)
    if credit_alert_count > 0:
        print(f'Credit alerts generated: {credit_alert_count}')
        alerts_generated += credit_alert_count

    # Snapshot automático de saldo al día de corte
    cutoff_statements = lank_alerts.generate_credit_cutoff_statements(db)
    if cutoff_statements > 0:
        print(f'Credit cutoff statements created: {cutoff_statements}')

    # Alertas de recarga de SIM Cards (7 días antes del 15 de cada mes)
    sim_alert_count = lank_alerts.generate_sim_recharge_alerts(db)
    if sim_alert_count > 0:
        print(f'SIM recharge alerts generated: {sim_alert_count}')
        alerts_generated += sim_alert_count

    print(f'Scheduled analysis complete: {len(ok_accounts)} accounts, {alerts_generated} alerts.')

    schedule_config = load_schedule_config(db)
    agent_review = lank_agent_review.build_review_document(
        db,
        trigger='scheduled',
        report=report,
        ok_accounts=ok_accounts,
        failed_accounts=failed_accounts,
        alerts_generated=alerts_generated,
        extra_findings=agent_findings,
        finance_records=finance_records,
        schedule_config=schedule_config,
        domain_summary=domain_summary,
    )
    agent_review_text = lank_agent_review.build_notification_text(agent_review)

# ────────────── Notificaciones de Telegram (scheduled) ──────────────
    try:
        tg = lank_telegram.TelegramBot(db)
        if tg.is_enabled:
            notified = False

            # Calcular total de alertas generadas (primera capa)
            total_alerts = alerts_generated

            # 1. Alertas de Firestore con status pending (incluye primera capa)
            if total_alerts > 0:
                from google.cloud.firestore_v1.base_query import FieldFilter
                new_alerts = list(db.collection('alerts')
                                 .where(filter=FieldFilter('status', '==', 'pending'))
                                 .order_by('createdAt', direction='DESCENDING')
                                 .limit(max(total_alerts, 10)).stream())
                alert_dicts = [a.to_dict() for a in new_alerts]
                if alert_dicts:
                    tg.send_alert_notification(alert_dicts)
                    notified = True
                    print(f'[Telegram] Notificación enviada: {len(alert_dicts)} alertas '
                          f'(scripts: {alerts_generated})')

            # 2. FALLBACK FINAL: Siempre buscar alertas pending recientes
            #    (cubre correos con formato nuevo que los scripts no detectaron)

            if not notified:
                try:
                    from google.cloud.firestore_v1.base_query import FieldFilter
                    recent_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
                    recent_alerts = list(db.collection('alerts')
                                        .where(filter=FieldFilter('status', '==', 'pending'))
                                        .where(filter=FieldFilter('createdAt', '>=', recent_cutoff))
                                        .order_by('createdAt', direction='DESCENDING')
                                        .limit(20).stream())
                    alert_dicts = [a.to_dict() for a in recent_alerts]
                    if alert_dicts:
                        tg.send_alert_notification(alert_dicts)
                        notified = True
                        print(f'[Telegram] Fallback: {len(alert_dicts)} alertas pending recientes notificadas')
                except Exception as fb_err:
                    print(f'[Telegram] Error en fallback de alertas recientes: {fb_err}')

            if external_notices:
                pseudo_alerts = []
                for evt in external_notices:
                    pseudo_alerts.append({
                        'title': f"{evt.get('userName', '?')} - {evt.get('subscription', '?')}",
                        'description': evt.get('action', 'Acción requerida'),
                        'priority': 'high' if 'join' in evt.get('kind', '') else 'medium',
                        'service': evt.get('subscription', '?'),
                        'accountId': evt.get('accountId', '?'),
                        'accountAlias': evt.get('accountAlias', '?'),
                    })
                tg.send_alert_notification(pseudo_alerts)

            if failed_accounts:
                tg.send_analysis_errors([{
                    'accountId': a['accountId'],
                    'accountAlias': a.get('accountAlias', ''),
                    'error': a.get('error', 'Error desconocido'),
                } for a in failed_accounts])

            if agent_review.get('shouldNotify') and agent_review_text:
                tg.send_message(agent_review_text, parse_mode=None)
                print(f'[Telegram] Resumen de agent-review enviado ({len(agent_review_text)} chars)')
            else:
                print(f'[Telegram] Agent-review no enviado (shouldNotify={agent_review.get("shouldNotify")}, '
                      f'hasText={bool(agent_review_text)})')
    except Exception as tg_err:
        print(f'[Telegram] Error no fatal en notificación scheduled: {tg_err}')
    # ──────────────────────────────────────────────────────────────────


# ──────────────────────────────────────────────────────────────────
# TELEGRAM BOT WEBHOOK
# ──────────────────────────────────────────────────────────────────

@https_fn.on_request(
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST']),
    memory=options.MemoryOption.MB_512,
    timeout_sec=300,
)
def telegram_webhook(req: https_fn.Request) -> https_fn.Response:
    """Webhook para recibir mensajes de Telegram.

    Telegram envía actualizaciones vía POST. Esta función:
    1. Valida que el chat_id sea del admin autorizado
    2. Procesa comandos (/estado, /alertas, etc.)
    3. Para mensajes normales, responde que el chat IA no está disponible
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

# ── Auto-registro: si no hay admin configurado, el primero se registra ──
        if not tg.admin_chat_id:
            settings_doc = db.document('config/telegram-settings').get()
            settings = settings_doc.to_dict() if settings_doc.exists else {}
            if settings.get('allowAdminAutoRegistration') is not True:
                return https_fn.Response('OK', status=200)

            db.document('config/telegram-settings').set({
                'botToken': tg.token,
                'adminChatId': str(chat_id),
                'enabled': True,
                'allowAdminAutoRegistration': False,
                'registeredAt': datetime.now(timezone.utc).isoformat(),
            }, merge=True)
            tg._settings = None  # Limpiar cache
            tg.send_message(
                '✅ *Registro completado*\n\n'
                f'Tu chat ID ({chat_id}) ha sido registrado como administrador.\n'
                'Ahora puedes usar todos los comandos. Escribe /ayuda para ver la lista.',
                chat_id=chat_id,
            )
            return https_fn.Response('OK', status=200)

# ────────────────────── Verificar autorizacin ───────────────────────
        if not tg.is_authorized(chat_id):
            tg.send_message('⛔ No estás autorizado para usar este bot.', chat_id=chat_id)
            return https_fn.Response('OK', status=200)

# ───────────────────────── Procesar comando ─────────────────────────
        if text.startswith('/'):
            response_text = tg.process_command(text, chat_id)
            if response_text:
                tg.send_message(response_text, chat_id=chat_id)
                return https_fn.Response('OK', status=200)

        # Chat messages - AI removed, respond with info
        tg.send_message('El chat con IA no está disponible actualmente.', chat_id=chat_id)

        return https_fn.Response('OK', status=200)

    except Exception as e:
        traceback.print_exc()
        try:
            tg.send_message(f'❌ Error interno: {str(e)[:200]}', chat_id=chat_id)
        except Exception:
            pass
        return https_fn.Response('OK', status=200)


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST', 'GET', 'OPTIONS']),
)
def telegram_setup(req: https_fn.Request) -> https_fn.Response:
    """Configura el webhook de Telegram y almacena el token.

    GET: Muestra info del webhook actual
    POST: { action: 'set_webhook' | 'delete_webhook' | 'save_token', botToken?: str }
    """
    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

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
        webhook_url = os.environ.get('TELEGRAM_WEBHOOK_URL', '')
        if not webhook_url:
            return https_fn.Response(
                json.dumps({'error': 'TELEGRAM_WEBHOOK_URL no configurado'}),
                status=500, content_type='application/json',
            )
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
        json.dumps({'error': 'Acción no reconocida'}),
        status=400, content_type='application/json',
    )


# ──────────────── GESTIN DE ALMACENAMIENTO DE DEPLOY ────────────────

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
    cors=options.CorsOptions(cors_origins='*', cors_methods=['POST', 'GET', 'OPTIONS']),
)
def manage_storage(req: https_fn.Request) -> https_fn.Response:
    """Gestiona artefactos de deploy en Cloud Storage y Artifact Registry.

    GET: Lista ambos almacenes con tamaño, objetos y limpiables.
         ?type=cs  → solo Cloud Storage
         ?type=ar  → solo Artifact Registry
         (sin type → ambos)
    POST: { action: 'cleanup_cs' | 'cleanup_ar' | 'cleanup_all',
            pinHash: str }
    POST: { action: 'get_policies' }
    POST: { action: 'set_policies', policies: { cs: {...}, ar: {...} } , pinHash: str }
    """
    from google.cloud import storage as gcs

    if req.method == 'OPTIONS':
        return https_fn.Response('', status=204)
    auth_error = require_dashboard_admin(req)
    if auth_error is not None:
        return auth_error

    db = firestore.client()
    project_id = PROJECT_ID
    if not project_id:
        return _json_response(
            {'success': False, 'error': 'FIREBASE_PROJECT_ID no configurado'},
            status=500,
        )

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

# ─────────────────────────────── POST ───────────────────────────────
    body = req.get_json(silent=True) or {}
    action = body.get('action', '')

# ─────────────────── Get policies (no PIN needed) ───────────────────
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

# ─────────────────────────── Set policies ───────────────────────────
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
            description='Actualización de políticas de limpieza automática',
            actor='admin',
            metadata={'policies': new_policies},
        )

        return https_fn.Response(
            json.dumps({'success': True, 'policies': new_policies}),
            content_type='application/json',
        )

# ───────────────────────── Cleanup actions ──────────────────────────
    if action not in ('cleanup_cs', 'cleanup_ar', 'cleanup_all', 'cleanup'):
        return https_fn.Response(
            json.dumps({'error': 'Acción no reconocida'}),
            status=400, content_type='application/json',
        )

    # Legacy support: 'cleanup' → 'cleanup_cs'
    if action == 'cleanup':
        action = 'cleanup_cs'

    pin_hash = body.get('pinHash', '')
    if not pin_hash:
        return https_fn.Response(
            json.dumps({'error': 'PIN requerido para esta operación'}),
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
