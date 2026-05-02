"""
Sistema de alertas operativas para AdminLank — versión Cloud Functions.
Usa Firestore directamente en lugar de archivos locales.
"""
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


# Servicios que requieren cambio de contraseña al salir un usuario (fallback)
PASSWORD_SHARED_SERVICES = {'ChatGPT Plus', 'HBO Max Platino', 'F1 TV Premium'}
INVITATION_BASED_SERVICES = {'YouTube Premium', 'Gemini AI'}
ALL_MANAGED_SERVICES = PASSWORD_SHARED_SERVICES | INVITATION_BASED_SERVICES


def _derive_service_sets(services_config):
    """Deriva los sets de servicios por tipo de acceso desde config/services."""
    if not services_config:
        return PASSWORD_SHARED_SERVICES, INVITATION_BASED_SERVICES
    password_svcs = set()
    invitation_svcs = set()
    for key, svc in services_config.items():
        if svc.get('active') is False:
            continue
        name = svc.get('name', key)
        access_type = svc.get('accessType', '')
        if access_type == 'credentials':
            password_svcs.add(name)
        elif access_type == 'email_invitation':
            invitation_svcs.add(name)
    return password_svcs or PASSWORD_SHARED_SERVICES, invitation_svcs or INVITATION_BASED_SERVICES


def _alert_id():
    return str(uuid.uuid4())[:8]


def _now():
    return datetime.now(timezone.utc).isoformat()


def _email_date_fields(event):
    raw_date = None
    if isinstance(event, dict):
        raw_date = event.get('emailDateRaw') or event.get('date') or event.get('emailDate')
    if not raw_date:
        return {}
    try:
        dt = parsedate_to_datetime(raw_date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return {
            'emailDateRaw': raw_date,
            'emailDate': dt.astimezone(timezone.utc).isoformat(),
        }
    except Exception:
        return {'emailDateRaw': raw_date}


def find_duplicate(alerts, alert_type, service, account_id, user_alias):
    for a in alerts:
        if (a.get('type') == alert_type
            and a.get('service') == service
            and a.get('accountId') == account_id
            and a.get('userAlias') == user_alias
            and a.get('status') == 'pending'):
            return True
    return False


def _is_expired(expires_str):
    if not expires_str:
        return False
    import re
    from datetime import date
    MONTHS = {
        'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6,
        'julio': 7, 'agosto': 8, 'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12,
    }
    m = re.search(r'(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})', expires_str)
    if m:
        day, month_name, year = int(m.group(1)), m.group(2).lower(), int(m.group(3))
        month = MONTHS.get(month_name, 0)
        if month:
            try:
                return date(year, month, day) < date.today()
            except:
                pass
    try:
        return datetime.fromisoformat(expires_str).date() < date.today()
    except:
        pass
    return False


def generate_user_left_alerts(event, service, account_id, account_alias,
                               service_account_ref=None, other_users=None,
                               real_account_email=None, real_account_expires=None,
                               services_config=None):
    user_alias = event.get('userName', '?')
    alerts = []
    now = _now()

    if not service_account_ref:
        return alerts

    expired = _is_expired(real_account_expires)
    acct_label = service_account_ref
    if real_account_email:
        acct_label = f'{service_account_ref} ({real_account_email})'

    # Derivar sets dinámicamente si hay config
    pwd_svcs, inv_svcs = _derive_service_sets(services_config)

    base = {
        'service': service,
        'accountId': account_id,
        'accountAlias': account_alias,
        'userAlias': user_alias,
        'serviceAccountRef': service_account_ref,
        'realAccountEmail': real_account_email,
        'realAccountExpires': real_account_expires,
        'accountExpired': expired,
        'createdAt': now,
        'source': 'cloud_analysis',
        **_email_date_fields(event),
    }

    if expired:
        alerts.append({
            **base, 'id': _alert_id(), 'type': 'user_left_expired',
            'status': 'pending', 'priority': 'low',
            'title': f'{user_alias} salio - cuenta expirada',
            'description': (
                f'{user_alias} salio del grupo de {service} (cuenta Lank #{account_id} {account_alias}). '
                f'Estaba en {acct_label} que ya expiro ({real_account_expires}). '
                f'No requiere cambio de contrasena ni eliminacion de perfil.'
            ),
            'completedAt': None,
        })
        return alerts

    if service in pwd_svcs:
        alerts.append({
            **base, 'id': _alert_id(), 'type': 'profile_delete',
            'status': 'pending', 'priority': 'high',
            'title': f'Eliminar perfil de {user_alias}',
            'description': f'{user_alias} salio del grupo de {service} (cuenta Lank #{account_id} {account_alias}). Eliminar su perfil/proyecto de {acct_label}.',
            'completedAt': None,
        })
        alerts.append({
            **base, 'id': _alert_id(), 'type': 'password_change',
            'status': 'pending', 'priority': 'high',
            'title': f'Cambiar contrasena - {service}',
            'description': f'Cambiar contrasena de {acct_label}. El usuario {user_alias} tenia acceso.',
            'completedAt': None, 'dependsOn': 'profile_delete',
        })
        if other_users:
            other_names = ', '.join(other_users)
            alerts.append({
                **base, 'id': _alert_id(), 'type': 'access_verify',
                'status': 'pending', 'priority': 'medium',
                'title': f'Verificar acceso - {service}',
                'description': f'Despues de cambiar la contrasena de {acct_label}, verificar que estos usuarios aun tengan acceso: {other_names}',
                'completedAt': None, 'dependsOn': 'password_change',
            })
    elif service in inv_svcs:
        alerts.append({
            **base, 'id': _alert_id(), 'type': 'revoke_invitation',
            'status': 'pending', 'priority': 'high',
            'title': f'Revocar acceso de {user_alias}',
            'description': f'{user_alias} salio del grupo de {service} (cuenta Lank #{account_id} {account_alias}). Eliminar su correo/invitacion de {acct_label}.',
            'completedAt': None,
        })

    return alerts


def generate_user_joined_alert(event, service, account_id, account_alias):
    user_alias = event.get('userName', '?')
    return {
        'id': _alert_id(), 'type': 'user_needs_access',
        'status': 'pending', 'priority': 'high',
        'service': service, 'accountId': account_id, 'accountAlias': account_alias,
        'userAlias': user_alias,
        'title': f'Dar acceso a {user_alias}',
        'description': f'{user_alias} se unió al grupo de {service} (cuenta Lank #{account_id} {account_alias}). Necesita recibir acceso.',
        'createdAt': _now(), 'completedAt': None, 'source': 'cloud_analysis',
        **_email_date_fields(event),
    }


def generate_group_deactivated_alert(event, service, account_id, account_alias):
    return {
        'id': _alert_id(), 'type': 'group_deactivated',
        'status': 'pending', 'priority': 'critical',
        'service': service, 'accountId': account_id, 'accountAlias': account_alias,
        'userAlias': None,
        'title': f'Grupo desactivado — {service}',
        'description': f'Lank desactivó el grupo de {service} de la cuenta #{account_id} {account_alias}. Revisar accesos y pagos.',
        'createdAt': _now(), 'completedAt': None, 'source': 'cloud_analysis',
        **_email_date_fields(event),
    }



def generate_scheduled_manual_alerts(db, today_key=None):
    if today_key is None:
        today_key = datetime.now(timezone.utc).date().isoformat()

    scheduled_docs = db.collection('scheduled-alerts').where('status', '==', 'scheduled').stream()
    pending_alerts = list(db.collection('alerts').where('status', '==', 'pending').stream())
    generated_at = _now()
    alerts_generated = 0

    for scheduled_doc in scheduled_docs:
        scheduled_alert = scheduled_doc.to_dict()
        if scheduled_alert.get('scheduledDate') != today_key:
            continue

        existing_alert_id = None
        for pending_alert_doc in pending_alerts:
            pending_alert = pending_alert_doc.to_dict()
            if pending_alert.get('type') != 'manual_reminder':
                continue
            if pending_alert.get('scheduledAlertId') != scheduled_doc.id:
                continue
            existing_alert_id = pending_alert.get('id') or pending_alert_doc.id
            break

        if existing_alert_id is None:
            alert_id = f'manual_reminder__{scheduled_doc.id}'
            note = (scheduled_alert.get('note') or '').strip()
            title = scheduled_alert.get('title') or 'Recordatorio manual'
            alert_payload = {
                'id': alert_id,
                'type': 'manual_reminder',
                'status': 'pending',
                'priority': scheduled_alert.get('priority', 'medium'),
                'title': title,
                'description': note or title,
                'createdAt': generated_at,
                'completedAt': None,
                'source': 'scheduled_manual_alert',
                'scheduledAlertId': scheduled_doc.id,
                'scheduledDate': scheduled_alert.get('scheduledDate'),
            }
            db.collection('alerts').document(alert_id).set(alert_payload)
            existing_alert_id = alert_id
            alerts_generated += 1

        db.collection('scheduled-alerts').document(scheduled_doc.id).update({
            'status': 'generated',
            'generatedAlertId': existing_alert_id,
            'generatedAt': generated_at,
        })

    return alerts_generated



def generate_missing_phone_alerts(db, services_config=None):
    """
    Revisa todos los grupos activos de TODOS los servicios.
    Para cada usuario activo que NO tenga teléfono (campo 'phone'),
    genera una alerta 'medium' indicando que falta el número.
    Esto es necesario para la integración de WhatsApp.
    Retorna el número de alertas generadas.
    """
    # Determinar servicios activos
    service_keys = []
    if services_config:
        for key, svc in services_config.items():
            if svc.get('active') is not False:
                service_keys.append((key, svc.get('name', key)))
    else:
        # Fallback hardcoded
        service_keys = [
            ('chatgpt', 'ChatGPT Plus'), ('gemini', 'Google AI Pro'),
            ('youtube', 'YouTube Premium'), ('hbo', 'HBO Max Platino'),
            ('f1tv', 'F1 TV Premium'), ('microsoft365', 'Microsoft 365'),
        ]

    if not service_keys:
        return 0

    # Leer alertas existentes para evitar duplicados
    existing_alerts = []
    for a_doc in db.collection('alerts').where('status', '==', 'pending').stream():
        existing_alerts.append(a_doc.to_dict())

    alerts_generated = 0
    now = _now()

    for service_key, service_name in service_keys:
        groups_ref = db.collection('groups').document(service_key).collection('lank-accounts')
        try:
            groups = list(groups_ref.stream())
        except Exception:
            continue

        for group_doc in groups:
            group = group_doc.to_dict()
            if group.get('groupStatus') != 'active':
                continue

            account_id = group.get('accountId', group_doc.id)
            account_alias = group.get('accountAlias') or group.get('fullName', '')
            users = group.get('users', [])

            for user in users:
                if isinstance(user, str):
                    continue
                user_alias = user.get('userAlias', '')
                if not user_alias:
                    continue

                # Solo usuarios activos
                status = user.get('serviceStatus', 'active')
                if status in ('inactive', 'removed', 'suspended'):
                    continue

                # Verificar si tiene teléfono
                phone = (user.get('phone') or '').strip()
                if phone:
                    continue  # Ya tiene teléfono

                alert_type = 'missing_phone'
                if find_duplicate(existing_alerts, alert_type, service_name,
                                  str(account_id), user_alias):
                    continue

                alert = {
                    'id': _alert_id(),
                    'type': alert_type,
                    'status': 'pending',
                    'priority': 'medium',
                    'service': service_name,
                    'serviceKey': service_key,
                    'accountId': str(account_id),
                    'accountAlias': account_alias,
                    'userAlias': user_alias,
                    'title': f'Falta telefono — {user_alias}',
                    'description': (
                        f'{user_alias} del grupo #{account_id} {account_alias} '
                        f'({service_name}) no tiene numero de telefono registrado. '
                        f'Se necesita para la integracion de WhatsApp.'
                    ),
                    'createdAt': now,
                    'completedAt': None,
                    'source': 'cloud_scheduled',
                }
                db.collection('alerts').document(alert['id']).set(alert)
                existing_alerts.append(alert)
                alerts_generated += 1

    return alerts_generated


def generate_sim_recharge_alerts(db):
    """
    Revisa config/sim-cards en Firestore. Para cada SIM cuyo
    nextRechargeDate caiga dentro de los próximos 7 días (o ya haya pasado),
    genera una alerta indicando que necesita recarga.
    Usa la estructura plana sims[] (post-migración).
    Retorna el número de alertas generadas.
    """
    from datetime import date, timedelta, timezone as tz

    print('[SIM Alerts] generate_sim_recharge_alerts() called')

    mexico_tz = tz(timedelta(hours=-6))
    today = datetime.now(mexico_tz).date()

    sim_ref = db.document('config/sim-cards')
    sim_snap = sim_ref.get()
    if not sim_snap.exists:
        print('[SIM Alerts] config/sim-cards document does not exist')
        return 0

    sim_data = sim_snap.to_dict()
    sims = sim_data.get('sims', [])
    if not sims:
        print('[SIM Alerts] No SIMs found in config/sim-cards')
        return 0

    print(f'[SIM Alerts] Found {len(sims)} SIMs, today={today}')

    # Cargar alertas pendientes para evitar duplicados
    existing_alerts = []
    for a_doc in db.collection('alerts').where('status', '==', 'pending').stream():
        existing_alerts.append(a_doc.to_dict())

    print(f'[SIM Alerts] {len(existing_alerts)} existing pending alerts loaded')

    alerts_generated = 0
    now = _now()

    for sim in sims:
        lank_id = sim.get('lankAccountId', '')
        next_date_str = sim.get('nextRechargeDate', '')
        if not next_date_str:
            continue

        phone = sim.get('phone', '')
        name = sim.get('canonicalAlias') or sim.get('fullName') or f'Cuenta #{lank_id}'

        try:
            next_date = date.fromisoformat(next_date_str)
        except (ValueError, TypeError):
            print(f'[SIM Alerts] SIM #{lank_id}: invalid date "{next_date_str}"')
            continue

        days_until = (next_date - today).days
        print(f'[SIM Alerts] SIM #{lank_id} ({name}): nextRecharge={next_date_str}, daysUntil={days_until}')

        if days_until > 7:
            continue

        month_key = next_date_str[:7]  # YYYY-MM

        # Evitar duplicados: buscar por tipo + lank_id + monthKey
        is_dup = any(
            a.get('type') == 'sim_recharge'
            and str(a.get('lankAccountId', '')) == str(lank_id)
            and a.get('monthKey') == month_key
            and a.get('status') == 'pending'
            for a in existing_alerts
        )
        if is_dup:
            print(f'[SIM Alerts] Skipping duplicate: {name} ({phone}), monthKey={month_key}')
            continue

        print(f'[SIM Alerts] Creating alert: {name} ({phone}), days={days_until}')
        urgency = 'critical' if days_until <= 0 else ('high' if days_until <= 3 else 'medium')
        days_label = (
            'HOY' if days_until == 0
            else f'VENCIDA ({abs(days_until)} día(s))' if days_until < 0
            else f'en {days_until} día(s)'
        )

        alert = {
            'id': _alert_id(),
            'type': 'sim_recharge',
            'status': 'pending',
            'priority': urgency,
            'service': 'SIM Cards',
            'lankAccountId': str(lank_id),
            'phoneNumber': phone,
            'monthKey': month_key,
            'nextRechargeDate': next_date_str,
            'userAlias': name,
            'title': f'Recargar SIM — {name} ({phone})',
            'description': (
                f'Recarga pendiente {days_label} para {name} (Tel: {phone}). '
                f'Fecha límite: {next_date_str}. '
                f'Recargar para evitar desactivación del número.'
            ),
            'createdAt': now,
            'completedAt': None,
            'source': 'cloud_scheduled',
        }
        db.collection('alerts').document(alert['id']).set(alert)
        existing_alerts.append(alert)
        alerts_generated += 1

    print(f'[SIM Alerts] Finished. Total alerts generated: {alerts_generated}')
    return alerts_generated


def generate_credit_alerts(db):
    """
    Revisa las cuentas de crédito en finance/credit-accounts.
    Genera alertas de:
      - credit_cutoff: X días antes de la fecha de corte
      - credit_payment_due: X días antes de la fecha límite de pago
    Retorna el número de alertas generadas.
    """
    from datetime import timedelta, timezone as tz
    import calendar

    mexico_tz = tz(timedelta(hours=-6))
    now_mx = datetime.now(mexico_tz)
    today_day = now_mx.day
    current_month = now_mx.month
    current_year = now_mx.year
    last_day = calendar.monthrange(current_year, current_month)[1]

    credit_ref = db.document('finance/credit-accounts')
    credit_snap = credit_ref.get()
    if not credit_snap.exists:
        return 0
    accounts = credit_snap.to_dict().get('accounts', [])
    if not accounts:
        return 0

    existing_alerts = []
    for a_doc in db.collection('alerts').where('status', '==', 'pending').stream():
        existing_alerts.append(a_doc.to_dict())

    alerts_generated = 0
    now = _now()

    for acct in accounts:
        bank = acct.get('bank', '')
        acct_id = acct.get('id', '')
        days_before = acct.get('alertDaysBefore', 1)
        month_key = f'{current_year}-{str(current_month).zfill(2)}'

        # Fecha de corte
        cutoff_day = acct.get('cutoffDay')
        if cutoff_day:
            effective_cutoff = min(cutoff_day, last_day)
            alert_day = effective_cutoff - days_before
            if alert_day <= 0:
                alert_day += last_day
            if today_day == alert_day or today_day == effective_cutoff:
                alert_type = 'credit_cutoff'
                is_dup = any(
                    a.get('type') == alert_type
                    and a.get('creditAccountId') == acct_id
                    and a.get('monthKey') == month_key
                    and a.get('status') == 'pending'
                    for a in existing_alerts
                )
                if not is_dup:
                    is_today = today_day == effective_cutoff
                    alert = {
                        'id': _alert_id(),
                        'type': alert_type,
                        'status': 'pending',
                        'priority': 'high' if is_today else 'medium',
                        'service': bank,
                        'creditAccountId': acct_id,
                        'monthKey': month_key,
                        'title': f'Corte de {bank} — {"HOY" if is_today else f"en {days_before} día(s)"}',
                        'description': (
                            f'La fecha de corte de {bank} es el día {cutoff_day}. '
                            f'Revisa tu estado de cuenta y el saldo actual.'
                        ),
                        'createdAt': now,
                        'completedAt': None,
                        'source': 'cloud_scheduled',
                    }
                    db.collection('alerts').document(alert['id']).set(alert)
                    existing_alerts.append(alert)
                    alerts_generated += 1

        # Fecha límite de pago
        due_day = acct.get('paymentDueDay')
        if due_day:
            effective_due = min(due_day, last_day)
            alert_day = effective_due - days_before
            if alert_day <= 0:
                alert_day += last_day
            if today_day == alert_day or today_day == effective_due:
                alert_type = 'credit_payment_due'
                is_dup = any(
                    a.get('type') == alert_type
                    and a.get('creditAccountId') == acct_id
                    and a.get('monthKey') == month_key
                    and a.get('status') == 'pending'
                    for a in existing_alerts
                )
                if not is_dup:
                    is_today = today_day == effective_due
                    min_payment = acct.get('minimumPayment', 0)
                    balance = acct.get('currentBalance', 0)
                    alert = {
                        'id': _alert_id(),
                        'type': alert_type,
                        'status': 'pending',
                        'priority': 'critical' if is_today else 'high',
                        'service': bank,
                        'creditAccountId': acct_id,
                        'monthKey': month_key,
                        'title': f'Pago de {bank} — {"HOY" if is_today else f"en {days_before} día(s)"}',
                        'description': (
                            f'El límite de pago de {bank} es el día {due_day}. '
                            f'Saldo: ${balance:,.2f}.'
                            + (f' Pago mínimo: ${min_payment:,.2f}.' if min_payment > 0 else '')
                        ),
                        'createdAt': now,
                        'completedAt': None,
                        'source': 'cloud_scheduled',
                    }
                    db.collection('alerts').document(alert['id']).set(alert)
                    existing_alerts.append(alert)
                    alerts_generated += 1

    return alerts_generated
