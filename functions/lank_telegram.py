"""
AdminLank — Módulo de integración con Telegram Bot.

Maneja el envío de mensajes, procesamiento de comandos,
notificaciones automáticas y el chat compartido con la IA.

Configuración:
  Se lee de Firestore 'config/telegram-settings'.
  Campos: botToken, adminChatId, enabled.
"""
import json
import traceback
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
            result = self._api_call('sendMessage', {
                'chat_id': cid,
                'text': chunk,
                'parse_mode': parse_mode,
            })
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

    def process_command(self, command, chat_id, ai_client=None, tool_executor=None):
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
        elif cmd.startswith('/modelo'):
            return self._cmd_modelo(cmd)
        elif cmd.startswith('/thinking'):
            return self._cmd_thinking(cmd)
        elif cmd == '/contexto':
            return self._cmd_contexto()
        elif cmd == '/limpiar':
            return self._cmd_limpiar()
        elif cmd == '/ayuda':
            return self._cmd_ayuda()
        else:
            return None  # No es un comando — tratar como chat

    def _cmd_start(self):
        return (
            "👋 *Hola! Soy el bot de AdminLank.*\n\n"
            "Puedo ayudarte a administrar tus suscripciones compartidas.\n\n"
            "📌 Escríbeme cualquier cosa y la IA responderá con acceso completo al sistema.\n\n"
            "Comandos disponibles: /ayuda"
        )

    def _cmd_ayuda(self):
        return (
            "📋 *Comandos disponibles:*\n\n"
            "/estado — Resumen rápido del sistema\n"
            "/alertas — Ver alertas pendientes\n"
            "/analizar — Ejecutar análisis de correos ahora\n"
            "/modelo — Ver/cambiar modelo de IA\n"
            "/thinking — Ver/cambiar nivel de razonamiento\n"
            "/contexto — Ver cuánto contexto se está usando\n"
            "/limpiar — Limpiar contexto de la conversación\n"
            "/ayuda — Esta lista de comandos\n\n"
            "💬 También puedes escribir cualquier mensaje para chatear con la IA."
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

            # Alertas pendientes (Firestore alerts + actionable-events)
            alerts_q = list(self.db.collection('alerts').where('status', '==', 'pending').stream())
            pending_count = len(alerts_q)

            # Sumar actionable-events que no tengan alerta duplicada (en CUALQUIER estado)
            try:
                ae_doc = self.db.document('analysis/actionable-events').get()
                if ae_doc.exists:
                    ae_events = ae_doc.to_dict().get('events', [])
                    # Build keys from ALL alerts (pending + resolved) to avoid counting stale events
                    all_alerts = list(self.db.collection('alerts').stream())
                    alert_keys = set()
                    for a_doc in all_alerts:
                        a = a_doc.to_dict()
                        alert_keys.add(f"{a.get('userAlias','')}-{a.get('accountId','')}-{a.get('service','')}")
                    for evt in ae_events:
                        key = f"{evt.get('userName','')}-{evt.get('accountId','')}-{evt.get('subscription','')}"
                        if key not in alert_keys:
                            pending_count += 1
            except Exception:
                pass

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
        """Lista las alertas pendientes (Firestore + actionable-events)."""
        try:
            priority_emoji = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🟢'}
            all_pending = []

            # 1. Alertas de Firestore con status pending
            alerts_q = list(self.db.collection('alerts').where('status', '==', 'pending').stream())
            alert_keys = set()
            for doc in alerts_q:
                a = doc.to_dict()
                all_pending.append(a)
                alert_keys.add(f"{a.get('userAlias','')}-{a.get('accountId','')}-{a.get('service','')}")

            # 2. Build keys from ALL alerts (pending + resolved) to exclude stale events
            all_alert_keys = set(alert_keys)  # Start with pending keys
            try:
                for adoc in self.db.collection('alerts').stream():
                    ad = adoc.to_dict()
                    all_alert_keys.add(f"{ad.get('userAlias','')}-{ad.get('accountId','')}-{ad.get('service','')}")
            except Exception:
                pass

            # 3. Actionable-events del último análisis (excluir los que ya tienen alerta en cualquier estado)
            try:
                ae_doc = self.db.document('analysis/actionable-events').get()
                if ae_doc.exists:
                    for evt in ae_doc.to_dict().get('events', []):
                        key = f"{evt.get('userName','')}-{evt.get('accountId','')}-{evt.get('subscription','')}"
                        if key not in all_alert_keys:
                            all_pending.append({
                                'title': f"{evt.get('userName', '?')} — {evt.get('subscription', '?')}",
                                'description': evt.get('action', 'Acción requerida'),
                                'type': evt.get('kind', 'info'),
                                'priority': 'high' if 'join' in evt.get('kind', '') else 'medium',
                                'service': evt.get('subscription', '?'),
                                'accountId': evt.get('accountId', '?'),
                                'accountAlias': evt.get('accountAlias', '?'),
                                'userAlias': evt.get('userName', '?'),
                                'source': 'análisis automático',
                            })
            except Exception:
                pass

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

    def _cmd_modelo(self, full_cmd):
        """Ver o cambiar el modelo de IA."""
        parts = full_cmd.split(maxsplit=1)

        # Modelos base (mismos que el dashboard)
        base_models = [
            {'value': 'gemini-pro-latest', 'label': 'Gemini Pro (Latest)'},
            {'value': 'gemini-flash-latest', 'label': 'Gemini Flash (Latest)'},
            {'value': 'gemini-flash-lite-latest', 'label': 'Gemini Flash Lite (Latest)'},
        ]

        # Si solo escribió /modelo, mostrar info actual
        if len(parts) == 1:
            try:
                settings = self.db.document('config/ai-settings').get()
                s = settings.to_dict() if settings.exists else {}
                chat_model = s.get('chatModel', s.get('model', 'no configurado'))

                # Merge: base + custom de Firestore
                custom = s.get('customModels', [])
                all_models = list(base_models)
                for cm in custom:
                    cm_val = cm.get('value', '')
                    if cm_val and not any(m['value'] == cm_val for m in all_models):
                        all_models.append({'value': cm_val, 'label': cm.get('label', cm_val)})

                # Si el modelo actual no está en la lista, agregarlo
                if chat_model and not any(m['value'] == chat_model for m in all_models):
                    all_models.append({'value': chat_model, 'label': chat_model})

                lines = [
                    f"🤖 *Modelo actual:* `{chat_model}`\n",
                    "*Modelos disponibles:*"
                ]
                for m in all_models:
                    marker = ' ← actual' if m['value'] == chat_model else ''
                    label_part = f" ({m['label']})" if m['label'] != m['value'] else ''
                    lines.append(f"  • `{m['value']}`{label_part}{marker}")

                lines.append(f"\nUsa: `/modelo nombre-del-modelo` para cambiar")
                return '\n'.join(lines)
            except Exception as e:
                return f"❌ Error: {e}"

        # Cambiar modelo
        new_model = parts[1].strip()
        try:
            self.db.document('config/ai-settings').update({
                'chatModel': new_model,
                'model': new_model,
            })
            lank_audit.log_change(
                self.db,
                source='telegram',
                action='change_model',
                description=f'Modelo cambiado a: {new_model}',
                actor='admin',
            )
            return f"✅ Modelo de chat cambiado a: `{new_model}`"
        except Exception as e:
            return f"❌ Error al cambiar modelo: {e}"

    def _cmd_thinking(self, full_cmd):
        """Ver o cambiar el nivel de razonamiento."""
        parts = full_cmd.split(maxsplit=1)
        valid_levels = {'apagado': 'none', 'bajo': 'low', 'medio': 'medium', 'alto': 'high',
                        'none': 'none', 'low': 'low', 'medium': 'medium', 'high': 'high'}

        if len(parts) == 1:
            try:
                settings = self.db.document('config/ai-settings').get()
                s = settings.to_dict() if settings.exists else {}
                level = s.get('thinkingLevel', 'none')
                labels = {'none': 'Apagado', 'low': 'Bajo', 'medium': 'Medio', 'high': 'Alto'}
                return (
                    f"🧠 *Nivel de razonamiento actual:* {labels.get(level, level)}\n\n"
                    f"Opciones: `apagado`, `bajo`, `medio`, `alto`\n"
                    f"Usa: `/thinking nivel`"
                )
            except Exception as e:
                return f"❌ Error: {e}"

        new_level_input = parts[1].strip().lower()
        new_level = valid_levels.get(new_level_input)
        if not new_level:
            return f"❌ Nivel inválido: `{new_level_input}`\nOpciones: `apagado`, `bajo`, `medio`, `alto`"

        try:
            self.db.document('config/ai-settings').update({
                'thinkingLevel': new_level,
            })
            labels = {'none': 'Apagado', 'low': 'Bajo', 'medium': 'Medio', 'high': 'Alto'}
            lank_audit.log_change(
                self.db,
                source='telegram',
                action='change_thinking',
                description=f'Razonamiento cambiado a: {labels[new_level]}',
                actor='admin',
            )
            return f"✅ Nivel de razonamiento cambiado a: *{labels[new_level]}*"
        except Exception as e:
            return f"❌ Error: {e}"

    def _cmd_contexto(self):
        """Muestra cuánto contexto se está usando."""
        try:
            history_doc = self.db.document('chat/history').get()
            if not history_doc.exists:
                return "📊 *Contexto:* 0 mensajes (vacío)"

            messages = history_doc.to_dict().get('messages', [])
            total_chars = sum(len(m.get('content', '')) for m in messages)
            sources = {}
            for m in messages:
                src = m.get('source', 'dashboard')
                sources[src] = sources.get(src, 0) + 1

            source_info = ', '.join(f"{k}: {v}" for k, v in sources.items())

            return (
                f"📊 *Contexto del chat:*\n\n"
                f"💬 Mensajes: {len(messages)} / 50 (máximo)\n"
                f"📝 Caracteres: {total_chars:,}\n"
                f"📱 Origen: {source_info}\n\n"
                f"Usa /limpiar para reiniciar el contexto."
            )
        except Exception as e:
            return f"❌ Error: {e}"

    def _cmd_limpiar(self):
        """Limpia el contexto compartido de la conversación."""
        try:
            from google.cloud.firestore import SERVER_TIMESTAMP
            self.db.document('chat/history').set({
                'messages': [],
                'updatedAt': datetime.now(MX_TZ).isoformat(),
                'clearedBy': 'telegram',
            })
            lank_audit.log_change(
                self.db,
                source='telegram',
                action='clear_chat_context',
                description='Contexto del chat limpiado desde Telegram',
                actor='admin',
            )
            return "🧹 *Contexto limpiado.*\nLa IA no recordará mensajes anteriores.\nEl historial de logs del sistema se mantiene intacto."
        except Exception as e:
            return f"❌ Error al limpiar: {e}"

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
