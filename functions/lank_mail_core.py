#!/usr/bin/env python3
import json
import re
from email.header import decode_header


def load_json(path, default):
    """Fallback loader - not used in cloud, but kept for compatibility."""
    try:
        from pathlib import Path
        if not Path(path).exists():
            return default
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def decode_mime(value):
    if not value:
        return ''
    parts = decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            # Try declared encoding first, then utf-8, then latin-1 as last resort
            for charset in [enc, 'utf-8', 'latin-1']:
                if charset:
                    try:
                        out.append(text.decode(charset))
                        break
                    except (UnicodeDecodeError, LookupError):
                        continue
            else:
                out.append(text.decode('utf-8', errors='replace'))
        else:
            out.append(text)
    result = ''.join(out)
    # Strip stray leading/trailing whitespace and non-printable control chars
    result = re.sub(r'^[\x00-\x1f\x7f-\x9f\s]+', '', result)
    result = re.sub(r'[\x00-\x1f\x7f-\x9f\s]+$', '', result)
    return result


def html_to_text(html):
    html = re.sub(r'(?i)<br\s*/?>', '\n', html)
    html = re.sub(r'(?i)</p>|</div>|</tr>|</li>|</h\d>', '\n', html)
    html = re.sub(r'(?s)<style.*?</style>|<script.*?</script>', ' ', html)
    html = re.sub(r'<[^>]+>', ' ', html)
    html = html.replace('&nbsp;', ' ')
    html = re.sub(r'\r', '', html)
    html = re.sub(r'\n\s*\n+', '\n\n', html)
    html = re.sub(r'[ \t]+', ' ', html)
    text = html.strip()
    # Remove stray leading numbers left from table cells (e.g. account badges like "96")
    text = re.sub(r'^\d{1,4}\s+(?=[A-ZÀ-ÿ¡¿])', '', text)
    return text


def get_text(msg):
    if msg.is_multipart():
        text_parts = []
        html_parts = []
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get('Content-Disposition') or '')
            if 'attachment' in disp.lower():
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or 'utf-8'
            decoded = payload.decode(charset, errors='replace')
            if ctype == 'text/plain':
                text_parts.append(decoded)
            elif ctype == 'text/html':
                html_parts.append(decoded)
        if text_parts:
            return '\n'.join(text_parts).strip()
        if html_parts:
            return html_to_text('\n'.join(html_parts))
        return ''
    payload = msg.get_payload(decode=True)
    if payload is None:
        return ''
    charset = msg.get_content_charset() or 'utf-8'
    decoded = payload.decode(charset, errors='replace')
    if msg.get_content_type() == 'text/html':
        return html_to_text(decoded)
    return decoded.strip()


def normalize_space(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def clean_email(value):
    if not value:
        return None
    return value.strip().rstrip('.,;:')


def parse_embedded_date(body):
    m = re.search(r'_fecha:\s*([0-9]{1,2}/[0-9]{1,2})_', body, re.I)
    return m.group(1) if m else None


def parse_payment_due(body):
    m = re.search(r'El día\s*([0-9]{1,2}/[0-9]{1,2})', body, re.I)
    return m.group(1) if m else None


def canonical_subscription(value, name_aliases=None):
    if not value:
        return None
    v = normalize_space(value)
    if name_aliases:
        # Buscar en aliases dinámicos: {alias: canonical_name}
        canonical = name_aliases.get(v)
        if canonical:
            return canonical
        # Buscar case-insensitive
        v_lower = v.lower()
        for alias, canon in name_aliases.items():
            if alias.lower() == v_lower:
                return canon
    # Fallback hardcodeado
    aliases = {
        'Office365': 'Microsoft 365',
        'Microsoft 365': 'Microsoft 365',
        'Gemini AI': 'Gemini AI',
        'Google/Gemini AI': 'Gemini AI',
        'YouTube': 'YouTube Premium',
        'YouTube Premium': 'YouTube Premium',
        'ChatGPT Plus': 'ChatGPT Plus',
        'HBO Max Platino': 'HBO Max Platino',
        'F1 TV Premium': 'F1 TV Premium',
        'F1 TV': 'F1 TV Premium',
    }
    return aliases.get(v, v)


def subject_kind(subject):
    s = (subject or '').lower().strip()
    if 'tu solicitud de extracción está siendo procesada' in s:
        return 'withdrawal_requested'
    if 'retiraste tus fondos con éxito' in s:
        return 'withdrawal_completed'
    if '¡ya acreditamos tu pago!' in s:
        return 'payment_user'
    if '¡ya acreditamos el pago de tu cuenta cashback!' in s:
        return 'payment_cashback'
    if 'hemos validado tu cuenta de' in s:
        return 'group_validated'
    if 'has canjeado tu cuenta cashback' in s:
        return 'cashback_validated'
    if 'agrega a ' in s and ' a tu grupo de ' in s:
        return 'user_join_direct'
    if 'agregamos un usuario a tu grupo de' in s:
        return 'user_join_transferred'
    if 'se ha unido a tu grupo de' in s:
        return 'user_join_transferred'
    if '¡importante! un miembro se ha dado de baja de' in s:
        return 'user_left_self'
    if 'un usuario ha dejado tu grupo' in s:
        return 'user_left_self'
    if 'usuario ha dejado' in s and 'grupo' in s:
        return 'user_left_self'
    if 'un miembro ha dejado' in s and 'grupo' in s:
        return 'user_left_self'
    if 'quitamos y cambiamos de tu grupo a un usuario' in s:
        return 'user_left_transferred'
    if 'tu grupo ha sido dado de baja' in s:
        return 'group_deactivated'
    if 'tu grupo ha sido desactivado' in s:
        return 'group_deactivated'
    if 'grupo' in s and ('dado de baja' in s or 'desactivado' in s or 'cancelado' in s):
        return 'group_deactivated'
    if re.search(r'ganaste \$?[0-9]+', s):
        return 'monthly_summary'
    return 'unknown'


def _clean_bank(value):
    """Validate extracted bank name. Return None if it looks like marketing text."""
    if not value:
        return None
    v = value.strip()
    # If the "bank" text is too long (>40 chars) or contains marketing markers, it's not a real bank
    if len(v) > 40:
        return None
    spam_markers = ['agradecemos', 'colaboración', 'suscripciones', 'disfrutar', 'compartir', 'felicitaciones']
    vl = v.lower()
    if any(m in vl for m in spam_markers):
        return None
    return v


def find_first(pattern, text, flags=re.I):
    m = re.search(pattern, text, flags)
    return normalize_space(m.group(1)) if m else None


def extract_clabes(text):
    """Extract 18-digit CLABE candidates, allowing spaces or dashes between digits."""
    if not text:
        return []
    candidates = []
    seen = set()
    for match in re.finditer(r'(?<!\d)(?:\d[\s-]?){18}(?!\d)', text):
        digits = re.sub(r'\D+', '', match.group(0))
        if len(digits) == 18 and digits not in seen:
            candidates.append(digits)
            seen.add(digits)
    return candidates


def infer_withdrawal_kind(subject, body):
    exact = subject_kind(subject)
    if exact != 'unknown':
        return exact

    merged = f'{subject}\n{body}'
    if not extract_clabes(merged):
        return exact

    text = merged.lower()
    has_withdrawal_signal = any(word in text for word in [
        'retiro', 'retiraste', 'retirar', 'extracción', 'extraccion', 'fondos',
    ])
    if not has_withdrawal_signal:
        return exact

    if any(word in text for word in ['éxito', 'exito', 'completado', 'completada', 'retiraste']):
        return 'withdrawal_completed'
    if any(word in text for word in ['procesada', 'proceso', 'solicitud', 'revisión', 'revision']):
        return 'withdrawal_detected'
    return 'withdrawal_detected'


def parse_event(subject, body, account_id, source, name_aliases=None):
    kind = infer_withdrawal_kind(subject, body)
    merged = f'{subject}\n{body}'
    clabes = extract_clabes(merged)
    event = {
        'kind': kind,
        'source': source,
        'subscription': None,
        'userName': None,
        'userEmail': None,
        'amount': None,
        'bank': None,
        'accountType': None,
        'accountNumber': None,
        'status': None,
        'action': None,
        'accountId': account_id,
        'joinDate': parse_embedded_date(body),
        'expectedPaymentDate': parse_payment_due(body),
        'notes': [],
        'clabes': clabes,
    }

    # Construir alternancia de nombres de servicio para regex
    if name_aliases:
        all_names = sorted(set(name_aliases.keys()), key=lambda x: -len(x))
    else:
        all_names = ['HBO Max Platino', 'YouTube Premium', 'YouTube', 'Office365',
                     'ChatGPT Plus', 'Gemini AI', 'Microsoft 365', 'F1 TV Premium', 'F1 TV']
    names_alt = '|'.join(re.escape(n) for n in all_names)

    sub = None
    for patt in [
        # Priorizar nombres exactos de servicio conocidos
        r'grupo de\s+(' + names_alt + ')',
        r'cuenta de\s+(' + names_alt + ')',
        r'de\s+(' + names_alt + ')',
        # Fallback genérico solo si no se encontró nombre conocido
        r'a tu grupo de\s+([^!\n\.]+)',
        r'de tu grupo de\s+([^!\n\.]+)',
        r'grupo de\s+([^!\n\.]+)',
        r'CUENTA CASHBACK de\s+([^,\.\n!]+)',
    ]:
        sub = find_first(patt, merged)
        if sub:
            # Limpiar: si capturó texto extra después del nombre real (ej: "Office365 ha sido dado de baja...")
            # truncar en palabras clave que indican fin del nombre
            for stop in [' ha sido', ' fue ', ' se ha', ' ha dejado']:
                idx = (sub or '').lower().find(stop)
                if idx > 0:
                    sub = sub[:idx].strip()
            break
    event['subscription'] = canonical_subscription(sub, name_aliases)

    if kind == 'user_join_direct':
        event['userName'] = find_first(r'¡Un usuario\s+(.+?)\s+se unió a tu grupo', body) or find_first(r'Agrega a\s+(.+?)\s+a tu grupo de', subject)
        event['userEmail'] = clean_email(find_first(r'correo electrónico:\s*([\w.+\-]+@[\w.\-]+)', body))
        event['status'] = 'detectado'
        event['action'] = 'pendiente invitar'
        if not event['userName']:
            event['notes'].append('usuario no informado')
    elif kind == 'user_join_transferred':
        event['userName'] = find_first(r'El usuario\s+(.+?)\s+se ha unido a tu grupo', body) or find_first(r'El usuario\s+(.+?)\s+se ha unido a tu grupo', subject) or find_first(r'El usuario\s+(.+?)\s+se ha unido', subject)
        event['status'] = 'detectado'
        event['action'] = 'revisar acceso'
        if not event['userName']:
            event['notes'].append('usuario no informado')
    elif kind == 'user_left_self':
        event['userName'] = (
            find_first(r'El usuario\s+(.+?)\s+se ha dado de baja', body) or
            find_first(r'El usuario\s+(.+?)\s+ha dejado', body) or
            find_first(r'usuario\s+(.+?)\s+ha dejado', body) or
            find_first(r'El miembro\s+(.+?)\s+ha dejado', body)
        )
        event['userEmail'] = clean_email(find_first(r'correo electr.nico(?:\s+es)?\s*:?\s*([\w.+\-]+@[\w.\-]+)', body))
        event['status'] = 'pendiente'
        event['action'] = 'quitar acceso'
    elif kind == 'user_left_transferred':
        event['userName'] = find_first(r'El usuario\s+(.+?)\s+ha decidido abandonar tu grupo', body)
        event['status'] = 'pendiente'
        event['action'] = 'ajustar proyección de pago'
    elif kind == 'payment_user':
        event['status'] = 'acreditado'
        event['action'] = 'registrar ingreso'
    elif kind == 'payment_cashback':
        event['status'] = 'acreditado'
        event['action'] = 'registrar ingreso cashback'
    elif kind in {'withdrawal_requested', 'withdrawal_detected'}:
        event['amount'] = find_first(r'Monto:\s*([0-9,]+(?:\.[0-9]+)?)', body)
        event['accountType'] = find_first(r'Tipo de cuenta:\s*([^\n]+)', body)
        event['accountNumber'] = find_first(r'Cuenta o numero tarjeta:\s*([0-9]+)', body) or (clabes[0] if clabes else None)
        event['bank'] = _clean_bank(find_first(r'Banco:\s*([^\n]+)', body))
        event['status'] = 'en proceso' if kind == 'withdrawal_requested' else 'pendiente revisión'
        event['action'] = 'esperar confirmación' if kind == 'withdrawal_requested' else 'clasificar retiro por CLABE'
    elif kind == 'withdrawal_completed':
        event['amount'] = find_first(r'Monto:\s*([0-9,]+(?:\.[0-9]+)?)', body)
        event['accountType'] = find_first(r'Tipo de cuenta:\s*([^\n]+)', body)
        event['accountNumber'] = find_first(r'Cuenta o numero tarjeta:\s*([0-9]+)', body) or (clabes[0] if clabes else None)
        event['bank'] = _clean_bank(find_first(r'Banco:\s*([^\n]+)', body))
        event['status'] = 'completado'
        event['action'] = 'registrar retiro'
    elif kind == 'group_validated':
        event['status'] = 'activo'
        event['action'] = 'grupo validado'
    elif kind == 'cashback_validated':
        event['status'] = 'activo'
        event['action'] = 'cashback validado'
    elif kind == 'group_deactivated':
        event['status'] = 'crítico'
        event['action'] = 'revisar usuarios y pagos futuros'
    elif kind == 'monthly_summary':
        event['amount'] = find_first(r'Ganaste\s*\$?([0-9]+(?:\.[0-9]+)?)', merged)
        event['status'] = 'informativo'
        event['action'] = 'solo guardar'

    if not event['joinDate']:
        event['notes'].append('fecha tomada del correo')
    if kind in {'payment_user', 'payment_cashback'} and not event['expectedPaymentDate']:
        event['notes'].append('fecha de pago tomada del correo')

    return event


def infer_amount(event, rates=None):
    if event.get('amount'):
        return event['amount']
    if rates is None:
        rates = {}
    if event.get('kind') not in {'payment_user', 'payment_cashback', 'user_join_direct', 'user_join_transferred', 'user_left_self', 'user_left_transferred'}:
        return None
    sub = event.get('subscription')
    if not sub:
        return None
    return rates.get(sub)


def normalize_account_number(value):
    if not value:
        return None
    digits = re.sub(r'\D+', '', str(value))
    return digits or None


def parse_amount(value):
    if value in {None, ''}:
        return None
    try:
        return round(float(str(value).replace(',', '')), 2)
    except Exception:
        return None


def match_known_bank_account(account_number, known_accounts):
    normalized = normalize_account_number(account_number)
    if not normalized:
        return None
    for row in known_accounts:
        clabe = normalize_account_number(row.get('clabe'))
        if clabe == normalized:
            return row
    return None
