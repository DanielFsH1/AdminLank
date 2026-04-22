"""
AdminLank — Módulo de integración con Telegram Bot.

Maneja el envío de mensajes, procesamiento de comandos
y notificaciones automáticas.

Configuración:
  Se lee de Firestore 'config/telegram-settings'.
  Campos: botToken, adminChatId, enabled.
"""
from datetime import datetime, timezone, timedelta

import requests

import lank_audit

# Zona horaria fija UTC-6 (México)
MX_TZ = timezone(timedelta(hours=-6))

TELEGRAM_API = 'https://api.telegram.org/bot{token}/{method}'

# Límite de Telegram por mensaje
MAX_MESSAGE_LENGTH = 4096


class TelegramBot:
    """Cliente de Telegram Bot para AdminLank."""

    def __init__(self, db):
        self.db = db
        self._settings = None

    @property
    def settings(self):
        if self._settings is None:
            self._settings = self._load_settings()
        return self._settings

    def _load_settings(self):
        try:
            doc = self.db.document('config/telegram-settings').get()
            if doc.exists:
                return doc.to_dict()
        except Exception:
            pass
        return {}

    @property
    def token(self):
        return self.settings.get('botToken', '')

    @property
    def admin_chat_id(self):
        return self.settings.get('adminChatId')

    @property
    def is_enabled(self):
        return bool(self.token) and bool(self.admin_chat_id) and self.settings.get('enabled', True)

    def is_authorized(self, chat_id):
        """Verifica si el chat_id corresponde al admin autorizado."""
        return str(chat_id) == str(self.admin_chat_id)

    # ─── ENVÍO DE MENSAJES ──────────────────────────────────────────────

    def _api_call(self, method, data):
        """Llamada genérica a la API de Telegram."""
        url = TELEGRAM_API.format(token=self.token, method=method)
        try:
            resp = requests.post(url, json=data, timeout=30)
            return resp.json()
        except Exception as e:
            print(f'[Telegram] Error en API call {method}: {e}')
            return {'ok': False, 'error': str(e)}

    def send_message(self, text, chat_id=None, parse_mode='Markdown'):
        """Envía un mensaje por Telegram, dividiendo si excede el límite."""
        cid = chat_id or self.admin_chat_id
        if not cid or not self.token:
            return None

        chunks = self._split_message(text, MAX_MESSAGE_LENGTH)
        results = []
        for chunk in chunks:
            payload = {
                'chat_id': cid,
                'text': chunk,
            }
            if parse_mode:
                payload['parse_mode'] = parse_mode
            result = self._api_call('sendMessage', payload)
            # Si Markdown falla, reintentar sin parse_mode
            if not result.get('ok') and parse_mode == 'Markdown':
                result = self._api_call('sendMessage', {
                    'chat_id': cid,
                    'text': chunk,
                })
            results.append(result)
        return results

    def send_typing(self, chat_id=None):
        """Envía indicador de 'escribiendo...' al chat."""
        cid = chat_id or self.admin_chat_id
        if cid and self.token:
            self._api_call('sendChatAction', {
                'chat_id': cid,
                'action': 'typing',
            })

    def _split_message(self, text, max_len):
        """Divide un mensaje largo en chunks respetando saltos de línea."""
        if len(text) <= max_len:
            return [text]

        chunks = []
        current = ''
        for line in text.split('\n'):
            if len(current) + len(line) + 1 > max_len:
                if current:
                    chunks.append(current)
                # Si una sola línea excede el límite, cortarla
                while len(line) > max_len:
                    chunks.append(line[:max_len])
                    line = line[max_len:]
                current = line
            else:
                current = current + '\n' + line if current else line
        if current:
            chunks.append(current)
        return chunks

    # ─── NOTIFICACIONES ─────────────────────────────────────────────────

    def send_alert_notification(self, alerts):
        """Envía notificación de alertas nuevas que requieren acción."""
        if not alerts or not self.is_enabled:
            return

        priority_emoji = {
            'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🟢',
        }

        lines = [f'⚠️ *{len(alerts)} alerta(s) nueva(s) que requieren acción:*\n']
        for a in alerts:
            emoji = priority_emoji.get(a.get('priority', ''), '📌')
            lines.append(
                f"{emoji} *{a.get('title', 'Sin título')}*\n"
                f"   Servicio: {a.get('service', '?')} | "
                f"Cuenta: #{a.get('accountId', '?')} ({a.get('accountAlias', '')})\n"
                f"   {a.get('description', '')[:200]}\n"
            )

        self.send_message('\n'.join(lines))

    def send_error_notification(self, title, details):
        """Envía notificación de error del sistema."""
        if not self.is_enabled:
            return
        text = f"❌ *Error del sistema*\n\n*{title}*\n{details}"
        self.send_message(text)

    def send_analysis_errors(self, failed_accounts):
        """Envía notificación de cuentas que fallaron en el análisis."""
        if not failed_accounts or not self.is_enabled:
            return

        lines = [f'⚠️ *{len(failed_accounts)} cuenta(s) con error en el análisis:*\n']
        for fa in failed_accounts:
            lines.append(
                f"• Cuenta #{fa.get('accountId', '?')} "
                f"({fa.get('accountAlias', 'sin alias')}): "
                f"{fa.get('error', 'error desconocido')}"
            )
        self.send_message('\n'.join(lines))

    # ─── PROCESAMIENTO DE COMANDOS ──────────────────────────────────────

    def process_command(self, command, chat_id):
        """Procesa un comando de Telegram y retorna la respuesta.

        Returns:
            str: Texto de respuesta para el usuario.
        """
        cmd = command.lower().strip()

        if cmd == '/start':
            return self._cmd_start()
        elif cmd == '/estado':
            return self._cmd_estado()
        elif cmd == '/alertas':
            return self._cmd_alertas()
        elif cmd == '/analizar':
            return self._cmd_analizar()
        elif cmd == '/ayuda':
            return self._cmd_ayuda()
        else:
            return None  # No es un comando — tratar como chat

    def _cmd_start(self):
        return (
            "👋 *Hola! Soy el bot de AdminLank.*\n\n"
            "Puedo ayudarte a administrar tus suscripciones compartidas.\n\n"
            "Comandos disponibles: /ayuda"
        )

    def _cmd_ayuda(self):
        return (
            "📋 *Comandos disponibles:*\n\n"
            "/estado — Resumen rápido del sistema\n"
            "/alertas — Ver alertas pendientes\n"
            "/analizar — Ejecutar análisis de correos ahora\n"
            "/ayuda — Esta lista de comandos"
        )

    def _cmd_estado(self):
        """Resumen rápido del sistema."""
        try:
            # Último análisis
            report = self.db.document('analysis/latest-report').get()
            rpt = report.to_dict() if report.exists else {}
            gen_at = rpt.get('generatedAt', 'N/A')
            try:
                if isinstance(gen_at, str) and gen_at != 'N/A':
                    dt = datetime.fromisoformat(gen_at.replace('Z', '+00:00'))
                    gen_at = dt.astimezone(MX_TZ).strftime('%d/%m/%Y %I:%M %p')
            except Exception:
                pass

            # Alertas pendientes del flujo directo actual
            alerts_q = list(self.db.collection('alerts').where('status', '==', 'pending').stream())
            pending_count = len(alerts_q)

            # Cuentas
            registry = self.db.document('config/account-registry').get()
            total_accounts = 0
            if registry.exists:
                total_accounts = len(registry.to_dict().get('accounts', []))

            # Servicios
            services = list(self.db.collection('groups').stream())
            svc_names = [s.to_dict().get('serviceName', s.id) for s in services]

            alert_emoji = '🟢' if pending_count == 0 else '🟠' if pending_count < 3 else '🔴'

            return (
                f"📊 *Estado de AdminLank*\n\n"
                f"📅 Último análisis: {gen_at}\n"
                f"📧 Cuentas OK: {rpt.get('accountsOk', '?')}/{rpt.get('totalAccounts', '?')}\n"
                f"{alert_emoji} Alertas pendientes: {pending_count}\n"
                f"👤 Cuentas Lank: {total_accounts}\n"
                f"📦 Servicios: {', '.join(svc_names)}\n"
            )
        except Exception as e:
            return f"❌ Error al obtener estado: {e}"

    def _cmd_alertas(self):
        """Lista las alertas pendientes del flujo directo actual."""
        try:
            priority_emoji = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🟢'}
            all_pending = []

            for doc in self.db.collection('alerts').where('status', '==', 'pending').stream():
                all_pending.append(doc.to_dict())

            if not all_pending:
                return "✅ No hay alertas pendientes."

            lines = [f"📋 *{len(all_pending)} alerta(s) pendiente(s):*\n"]
            for a in all_pending:
                emoji = priority_emoji.get(a.get('priority', ''), '📌')
                lines.append(
                    f"{emoji} *{a.get('title', 'Sin título')}*\n"
                    f"   Tipo: {a.get('type', '?')} | Servicio: {a.get('service', '?')}\n"
                    f"   Cuenta: #{a.get('accountId', '?')} | "
                    f"Usuario: {a.get('userAlias', '?')}\n"
                )
            return '\n'.join(lines)
        except Exception as e:
            return f"❌ Error al leer alertas: {e}"

    def _cmd_analizar(self):
        """Dispara un análisis de correos. Respuesra inmediata, análisis en background."""
        try:
            # Llamar a la Cloud Function de análisis
            url = '***REMOVED***/analyze_emails'
            resp = requests.post(url, json={}, timeout=300)
            data = resp.json()
            if data.get('success'):
                return (
                    f"✅ *Análisis completado*\n\n"
                    f"📧 Cuentas analizadas: {data.get('analyzedAccounts', '?')}/{data.get('totalAccounts', '?')}\n"
                    f"📩 Correos procesados: {data.get('totalRawEmails', 0)}\n"
                    f"⚠️ Alertas generadas: {data.get('alertsGenerated', 0)}\n"
                    f"📅 Hora: {data.get('generatedAt', 'N/A')}"
                )
            else:
                return f"❌ Error en análisis: {data.get('error', 'desconocido')}"
        except Exception as e:
            return f"❌ Error ejecutando análisis: {e}"

    # ─── SETUP ──────────────────────────────────────────────────────────

    def set_webhook(self, webhook_url):
        """Configura el webhook de Telegram."""
        result = self._api_call('setWebhook', {
            'url': webhook_url,
            'allowed_updates': ['message'],
        })
        return result

    def delete_webhook(self):
        """Elimina el webhook de Telegram."""
        return self._api_call('deleteWebhook', {})

    def get_webhook_info(self):
        """Obtiene la información del webhook actual."""
        url = TELEGRAM_API.format(token=self.token, method='getWebhookInfo')
        try:
            resp = requests.get(url, timeout=10)
            return resp.json()
        except Exception as e:
            return {'ok': False, 'error': str(e)}
