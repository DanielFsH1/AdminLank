"""
Capa de revisión operativa "AdminBot" sobre el análisis clásico.

No reemplaza el parser actual. Se monta encima para:
- detectar y resumir fallos IMAP con diagnóstico sugerido,
- marcar correos crudos no reconocidos por el parser,
- aplicar reglas operativas persistentes,
- cancelar alertas que ya no tienen sentido,
- guardar un resumen de revisión y opcionalmente notificar por Telegram.
"""
from datetime import datetime, timedelta, timezone

import lank_mail_core as core

MX_TZ = timezone(timedelta(hours=-6))

DEFAULT_SETTINGS = {
    'enabled': True,
    'notifyOnScheduledRun': True,
    'notifyOnManualRun': True,
    'maxFindings': 6,
    'maxUnknownSubjectsPerAccount': 2,
}


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _local_dt_text(iso_value):
    try:
        dt = datetime.fromisoformat((iso_value or '').replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(MX_TZ).strftime('%d/%m %I:%M %p')
    except Exception:
        return iso_value or 'N/A'


def load_settings(db):
    settings = dict(DEFAULT_SETTINGS)
    try:
        doc = db.document('config/agent-review-settings').get()
        if doc.exists:
            data = doc.to_dict() or {}
            if isinstance(data, dict):
                settings.update(data)
    except Exception:
        pass
    return settings


def _finding_key(finding):
    return '|'.join([
        str(finding.get('type', '')),
        str(finding.get('service', '')),
        str(finding.get('accountId', '')),
        str(finding.get('userAlias', '')),
        str(finding.get('message', '')),
    ])



def dedupe_findings(findings):
    seen = set()
    unique = []
    for finding in findings:
        key = _finding_key(finding)
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)
    return unique



def _diagnose_failure(failed_account):
    access = failed_account.get('access', '')
    error = (failed_account.get('error') or '').strip()
    error_l = error.lower()

    if access == 'auth_failed':
        return 'probable app password inválida, revocada o bloqueo de Gmail'
    if 'no pude abrir buz' in error_l or 'all mail' in error_l:
        return 'no pude abrir un buzón útil, revisar carpeta All Mail/INBOX o permisos IMAP'
    if 'timed out' in error_l or 'timeout' in error_l:
        return 'timeout o problema temporal de red/Google'
    if 'invalid credentials' in error_l or 'authentication failed' in error_l:
        return 'credenciales inválidas o expiradas'
    if 'imap' in error_l:
        return 'fallo IMAP, revisar credenciales y conectividad'
    if error:
        return error[:180]
    return 'fallo no clasificado'



def build_failed_account_findings(failed_accounts):
    findings = []
    for failed in failed_accounts or []:
        account_id = failed.get('accountId', '?')
        alias = failed.get('accountAlias', '')
        diagnosis = _diagnose_failure(failed)
        findings.append({
            'type': 'imap_failure',
            'severity': 'high',
            'accountId': account_id,
            'accountAlias': alias,
            'message': f'Cuenta #{account_id} {alias}: {diagnosis}',
            'rawError': failed.get('error', ''),
        })
    return findings



def build_unknown_mail_findings(ok_accounts, max_subjects=2):
    findings = []
    for account in ok_accounts or []:
        unknown = []
        for raw in account.get('rawEmails', []):
            subject = raw.get('subject', '')
            if core.subject_kind(subject) == 'unknown':
                unknown.append(subject.strip() or '(sin asunto)')
        if not unknown:
            continue
        samples = unknown[:max_subjects]
        sample_text = '; '.join(samples)
        if len(unknown) > max_subjects:
            sample_text += f' (+{len(unknown) - max_subjects} más)'
        findings.append({
            'type': 'unknown_mail_pattern',
            'severity': 'medium',
            'accountId': account.get('accountId'),
            'accountAlias': account.get('accountAlias', ''),
            'message': (
                f"Cuenta #{account.get('accountId')} {account.get('accountAlias', '')}: "
                f'{len(unknown)} correo(s) crudo(s) con asunto no reconocido por el parser. {sample_text}'
            ),
            'unknownCount': len(unknown),
            'subjects': samples,
        })
    return findings



def resolve_join_alert_without_real_access(db, alerts_data, service, account_id, account_alias,
                                           user_alias, group_updated=False):
    """Cancela alertas de acceso pendientes si el usuario ya salió sin tener cuenta real asignada."""
    if not user_alias or not service:
        return []

    pending_alerts = alerts_data.get('alerts', []) if isinstance(alerts_data, dict) else []
    now = _now_iso()
    cancelled = 0

    for alert in pending_alerts:
        if alert.get('status') != 'pending':
            continue
        if alert.get('type') != 'user_needs_access':
            continue
        if alert.get('service') != service:
            continue
        if str(alert.get('accountId')) != str(account_id):
            continue
        if str(alert.get('userAlias')) != str(user_alias):
            continue

        doc_id = alert.get('id') or alert.get('_docId')
        if not doc_id:
            continue

        resolution = (
            'Usuario se dio de baja antes de recibir una cuenta real o invitación. '
            'No se requiere revocar acceso.'
        )
        db.collection('alerts').document(doc_id).set({
            'status': 'cancelled_by_ai',
            'completedAt': now,
            'resolution': resolution,
            'updatedBy': 'adminbot_agent_review',
        }, merge=True)
        alert['status'] = 'cancelled_by_ai'
        alert['completedAt'] = now
        alert['resolution'] = resolution
        cancelled += 1

    action_text = 'Se liberó solo el cupo del grupo.' if group_updated else 'No se tocó ninguna cuenta real.'
    if cancelled:
        message = (
            f'{user_alias} salió de {service} en la cuenta #{account_id} {account_alias} '
            f'sin acceso real asignado. Se canceló la alerta pendiente de dar acceso. {action_text}'
        )
    else:
        message = (
            f'{user_alias} salió de {service} en la cuenta #{account_id} {account_alias} '
            f'sin acceso real asignado. No se generó alerta de revocación. {action_text}'
        )

    return [{
        'type': 'leave_without_real_access',
        'severity': 'medium',
        'service': service,
        'accountId': account_id,
        'accountAlias': account_alias,
        'userAlias': user_alias,
        'cancelledAlerts': cancelled,
        'message': message,
    }]



def build_review_document(db, trigger, report, ok_accounts, failed_accounts,
                          alerts_generated, extra_findings=None,
                          finance_records=0, schedule_config=None):
    settings = load_settings(db)
    if not settings.get('enabled', True):
        return {'enabled': False, 'settings': settings, 'shouldNotify': False}

    findings = list(extra_findings or [])
    findings.extend(build_failed_account_findings(failed_accounts))
    findings.extend(build_unknown_mail_findings(
        ok_accounts,
        max_subjects=int(settings.get('maxUnknownSubjectsPerAccount', 2) or 2),
    ))
    findings = dedupe_findings(findings)

    metrics = {
        'totalAccounts': len(report.get('accounts', [])),
        'accountsOk': len(ok_accounts or []),
        'accountsFailed': len(failed_accounts or []),
        'rawEmails': sum(len(a.get('rawEmails', [])) for a in ok_accounts or []),
        'totalEvents': sum(a.get('summary', {}).get('totalEvents', 0) for a in ok_accounts or []),
        'alertsGenerated': alerts_generated,
        'financeRecordsUpdated': finance_records,
    }

    schedule_snapshot = {}
    if isinstance(schedule_config, dict):
        schedule_snapshot = {
            'enabled': schedule_config.get('enabled', False),
            'frequencyHours': schedule_config.get('frequencyHours'),
            'startTime': schedule_config.get('startTime'),
            'activeHours': schedule_config.get('activeHours'),
        }

    review_doc = {
        'generatedAt': report.get('generatedAt') or _now_iso(),
        'trigger': trigger,
        'metrics': metrics,
        'findingsCount': len(findings),
        'findings': findings,
        'settingsSnapshot': settings,
        'schedule': schedule_snapshot,
        'updatedAt': _now_iso(),
    }

    db.document('analysis/agent-review-latest').set(review_doc)

    notify_flag = settings.get('notifyOnScheduledRun', True) if trigger == 'scheduled' else settings.get('notifyOnManualRun', True)
    review_doc['shouldNotify'] = bool(notify_flag)
    return review_doc



def build_notification_text(review_doc):
    if not review_doc or not review_doc.get('enabled', True):
        return None

    metrics = review_doc.get('metrics', {})
    trigger = review_doc.get('trigger', 'manual')
    generated_at = review_doc.get('generatedAt')
    findings = review_doc.get('findings', [])
    settings = review_doc.get('settingsSnapshot', DEFAULT_SETTINGS)
    max_findings = int(settings.get('maxFindings', 6) or 6)

    lines = [
        f"🤖 Revisión AdminBot ({'programada' if trigger == 'scheduled' else 'manual'})",
        f"Hora: {_local_dt_text(generated_at)}",
        (
            f"Cuentas OK: {metrics.get('accountsOk', 0)}/{metrics.get('totalAccounts', 0)} | "
            f"fallidas: {metrics.get('accountsFailed', 0)}"
        ),
        (
            f"Correos crudos: {metrics.get('rawEmails', 0)} | "
            f"eventos: {metrics.get('totalEvents', 0)} | "
            f"alertas nuevas: {metrics.get('alertsGenerated', 0)}"
        ),
    ]

    schedule = review_doc.get('schedule', {})
    if schedule.get('enabled'):
        freq = schedule.get('frequencyHours')
        if freq:
            lines.append(f'Schedule activo: cada {freq}h')

    if findings:
        lines.append('')
        lines.append('Hallazgos:')
        for finding in findings[:max_findings]:
            lines.append(f"• {finding.get('message', '')}")
        hidden = len(findings) - min(len(findings), max_findings)
        if hidden > 0:
            lines.append(f'• +{hidden} hallazgo(s) más en analysis/agent-review-latest')
    else:
        lines.append('')
        lines.append('Sin hallazgos extra en esta corrida.')

    return '\n'.join(lines)
