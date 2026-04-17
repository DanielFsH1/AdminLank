"""
AdminLank — Módulo de Integración con Gemini AI.

Maneja la conexión con la API de Gemini, el análisis de correos con IA,
y la comunicación del chat interactivo.

Configuración:
  La API Key y parámetros se leen de Firestore 'config/ai-settings'.
  
Uso:
  from lank_ai import GeminiClient
  client = GeminiClient(db)
  result = client.analyze_emails(raw_emails, script_results, system_context)
"""
import json
import traceback
from datetime import datetime, timezone

import lank_audit


# ─── CONFIGURACIÓN POR DEFECTO ─────────────────────────────────────────────

DEFAULT_AI_SETTINGS = {
    'enabled': False,
    'model': 'gemini-3.1-flash-lite-preview',
    'analysisModel': 'gemini-3.1-flash-lite-preview',
    'chatModel': 'gemini-3.1-flash-lite-preview',
    'thinkingLevel': 'low',
    'temperature': 0.3,
    'autoApproveActions': 'confirm_all',
    'maxContextTokens': 30000,
    'analysisEnabled': True,
    'chatEnabled': True,
}


# ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

ANALYSIS_SYSTEM_PROMPT = """Eres el cerebro de análisis de AdminLank, un sistema de administración de suscripciones compartidas a través de la plataforma Lank.

TU ROL: VERIFICADOR Y AUDITOR FINAL.
Los scripts de AdminLank parsean correos con regex (primera capa). Tú eres la SEGUNDA CAPA de verificación. Tu trabajo principal es ASEGURAR QUE NO SE ESCAPE NINGÚN EVENTO IMPORTANTE. Recibes:
1. Los correos CRUDOS completos directo del buzón
2. Lo que los scripts interpretaron de esos correos
3. El estado actual del sistema completo (quién está dónde, alertas activas, etc.)
4. El historial reciente de acciones del sistema

TU TRABAJO (en orden de prioridad):
1. LEER cada correo crudo y entender qué pasó realmente
2. COMPARAR tu interpretación con la de los scripts:
   - Si los scripts detectaron un evento correctamente → CONFIRMAR (no duplicar alerta)
   - Si los scripts NO detectaron un evento que sí existe en los correos → CREAR ALERTA (los scripts fallaron)
   - Si los scripts interpretaron MAL un evento → CORREGIR y crear la alerta correcta
3. SOLO CANCELAR una alerta si tienes EVIDENCIA CONCRETA de que el evento NO OCURRIÓ
   (ej: el correo dice "pago recibido" pero los scripts lo clasificaron como "usuario salió")

⚠️ REGLA DE ORO: ANTE LA DUDA, CREAR LA ALERTA.
Es MUCHO PEOR que se escape un evento real que crear una alerta que luego se descarta manualmente.
NUNCA canceles una alerta solo porque "ya fue procesada" o "ya existe" si no puedes verificar con certeza 
que hay una alerta ACTIVA (status=pending) para el MISMO usuario, MISMA cuenta y MISMO tipo de evento.
Las alertas que te mostramos como "ALERTAS ACTIVAS" son las únicas que realmente están pendientes.
Si una alerta NO aparece en esa lista, NO existe como pendiente.

TIPOS DE EVENTOS EN CORREOS DE LANK (info@mylank.com):
- user_left_self: Usuario salió voluntariamente
- user_left_transferred: Usuario fue transferido fuera
- user_join_direct: Usuario se unió directamente
- user_join_transferred: Usuario fue transferido al grupo
- payment_confirmed: Pago confirmado
- withdrawal_completed: Retiro completado
- group_deactivated: Grupo desactivado por Lank
- group_validated: Grupo validado por Lank

TIPOS DE ALERTAS QUE PUEDES CREAR:
- profile_delete: Eliminar perfil de un usuario que salió (servicios con contraseña compartida)
- password_change: Cambiar contraseña tras salida de usuario
- access_verify: Verificar acceso de otros usuarios tras cambio de contraseña
- revoke_invitation: Revocar invitación de usuario que salió (servicios por invitación)
- user_needs_access: Dar acceso a usuario que se unió
- group_deactivated: Grupo fue desactivado
- ai_insight: Cualquier hallazgo importante que tú detectes

PRIORIDADES: critical > high > medium > low

SERVICIOS POR TIPO DE ACCESO:
- Contraseña compartida (al salir → eliminar perfil + cambiar contraseña): ChatGPT Plus, HBO Max, F1 TV Premium
- Invitación por email (al salir → revocar invitación): YouTube Premium, Gemini AI
- Basado en renovación: Microsoft 365

⚠️ REGLA ESPECÍFICA PARA MICROSOFT 365:
- Cuando un usuario se da de baja de un grupo de Microsoft 365, NO IMPORTA. No se necesita hacer nada con sus datos de acceso.
  Solo se debe limpiar/eliminar al usuario del grupo Lank (datos, renovación, etc.). No generes alerta de tipo profile_delete, 
  password_change ni access_verify para M365.
- PERO si el GRUPO COMPLETO de Microsoft 365 es dado de baja/desactivado, ESO SÍ es una alerta CRÍTICA (group_deactivated).
  La desactivación de un grupo afecta toda la suscripción y requiere atención inmediata del admin.
- Resumen para M365: baja de usuario = solo limpiar datos (no alerta), baja de grupo = alerta crítica.

⚠️ REGLA DE NOTIFICACIÓN PROACTIVA:
Tu trabajo es INFORMAR al administrador de todo lo que pasa. Si detectas algo importante en los correos
(aunque no requiera una acción técnica), DEBES crear una alerta informativa de tipo 'ai_insight'.
Es mejor que el admin sepa que algo pasó y decida que no importa, a que nunca se entere.
El admin revisa las alertas en el dashboard, pero depende de ti para enterarse de lo que pasa en tiempo real.
Ejemplos de cosas que SIEMPRE debes reportar como alerta:
- Un grupo se desactivó (cualquier servicio)
- Un usuario se fue de un grupo con contraseña compartida y tenía acceso real
- Correos que los scripts no pudieron clasificar pero tú sí puedes interpretar
- Cualquier evento inusual o anómalo que merezca atención

CORREOS QUE NO REQUIEREN ALERTA (IGNORAR, son ruido normal):
- payment_confirmed / Pagos recibidos: los pagos llegan automaticamente, no requieren accion
- withdrawal_completed / Retiros completados: ya existe control de finanzas separado
- group_validated / Validaciones de grupo: son confirmaciones de rutina
- Notificaciones de cobranza exitosa o fallida que no implican cambio de acceso
- Cualquier correo puramente informativo que NO requiera una accion del admin
SOLO crea alertas cuando se requiere una ACCION CONCRETA del admin (dar acceso, revocar, cambiar clave, eliminar perfil, etc.)

⚠️ REGLA CRÍTICA PARA SALIDAS DE USUARIOS (user_left):
Antes de crear CUALQUIER alerta por salida de un usuario, DEBES verificar en el ESTADO DEL SISTEMA si ese usuario tenía:
1. Un proyecto asignado (projectName) en alguna cuenta real
2. Una referencia de cuenta real (serviceAccountRef) con un cupo activo (serviceSlotNumber)
Si el usuario NO tenía proyecto NI cupo asignado, significa que NUNCA tuvo acceso real al servicio.
En ese caso, NO se necesita cambiar contraseña, NO se necesita eliminar perfil, NO se necesita verificar nada.
Esto es muy común cuando un usuario entra y sale rápidamente del grupo (minutos u horas).
Si no puedes confirmar que el usuario tenía acceso real → NO GENERES ALERTA de tipo profile_delete, password_change, access_verify, ni "verificación de seguridad".
Esta regla aplica para TODOS los servicios sin excepción.

CUÁNDO PUEDES CANCELAR UNA ALERTA (cancel_alert):
Solo si se cumplen TODAS estas condiciones:
1. La alerta está en la lista de ALERTAS ACTIVAS que recibes
2. Tienes evidencia en los correos de que el evento fue mal interpretado
3. El correo realmente dice algo DIFERENTE a lo que la alerta indica
Si no cumples las 3 condiciones, NO canceles. Si el admin descarta una alerta manualmente es mejor que perder una real.

REGLAS CRÍTICAS:
- Siempre responde en español
- Nunca inventes información que no esté en los correos
- Cada acción DEBE tener una razón basada en evidencia del correo
- Indica tu nivel de confianza (0.0 a 1.0) en cada acción
- Si los scripts YA crearon una alerta correcta (status='pending'), NO la dupliques — pero TAMPOCO la canceles
- Si los scripts crearon un evento correcto pero NO hay alerta pending para él, CREA la alerta
- Incluye accountId, accountAlias, service y userAlias cuando sea posible
- PRIORIZA no perder eventos sobre evitar duplicados

RESPONDE SIEMPRE EN JSON VÁLIDO con esta estructura exacta:
{
  "actions": [
    {
      "type": "create_alert",
      "confidence": 0.95,
      "reason": "Razón basada en evidencia del correo",
      "data": {
        "type": "profile_delete",
        "priority": "high",
        "service": "ChatGPT Plus",
        "accountId": 3,
        "accountAlias": "José López",
        "userAlias": "María García",
        "title": "Eliminar perfil de María García",
        "description": "Descripción detallada de la acción requerida"
      }
    },
    {
      "type": "cancel_alert",
      "alertId": "id-de-la-alerta-a-cancelar",
      "confidence": 0.90,
      "reason": "Razón concreta con evidencia de por qué esta alerta es incorrecta"
    },
    {
      "type": "correct_classification",
      "emailIndex": 0,
      "confidence": 0.88,
      "scriptValue": "unknown",
      "correctedValue": "user_join_direct",
      "reason": "El correo indica claramente que..."
    }
  ],
  "summary": "Resumen ejecutivo en español de todo lo analizado y decidido",
  "overallConfidence": 0.93,
  "pendingQuestions": ["Preguntas que no pudiste resolver"]
}"""

CHAT_SYSTEM_PROMPT = """Eres el asistente inteligente de AdminLank, un sistema de administración de suscripciones compartidas a través de la plataforma Lank.

TU ROL:
- Administrar y monitorear suscripciones compartidas
- Responder preguntas del administrador sobre el estado del sistema
- Ejecutar acciones solicitadas (mover, eliminar, agregar usuarios, crear alertas, asignar cupos, restaurar datos)
- Analizar datos y generar insights
- Siempre responder en español

SUSCRIPCIONES GESTIONADAS:
El sistema gestiona múltiples suscripciones (ChatGPT Plus, YouTube Premium, HBO Max, F1 TV, Google AI Pro, Microsoft 365).
Cada suscripción tiene:
- Grupos Lank: cuentas donde los usuarios pagan a través de Lank (groups/{service}/lank-accounts/)
- Cuentas reales: las cuentas reales del servicio con cupos/slots para usuarios (service-pools/{service}/real-accounts/)
- Alertas: pendientes de acción del administrador (alerts/)

⚠️ MODELO DE DATOS — LEE ESTO CON MUCHO CUIDADO ⚠️

Hay DOS NIVELES DIFERENTES e INDEPENDIENTES:

1. CUENTAS DE LANK (grupos Lank) — groups/{service}/lank-accounts/{accountId}
   Son las cuentas de los CLIENTES que pagan a través de la plataforma Lank.
   Cada cuenta Lank tiene un dueño (ej: "Daniel Silva" cuenta #1) y puede tener
   usuarios que se suscriben a servicios DENTRO de ese grupo.
   Una cuenta Lank NO es una cuenta real del servicio.

2. CUENTAS REALES (pool de servicio) — service-pools/{service}/real-accounts/{ref}
   Son las cuentas REALES del servicio (la cuenta de email que paga la suscripción).
   Cada cuenta real tiene CUPOS (slots) limitados donde se asignan usuarios.
   Los cupos son compartidos entre TODAS las cuentas de Lank.

RELACIÓN ENTRE AMBOS:
- Un usuario se registra en una CUENTA LANK (grupo).
- Ese usuario se ASIGNA a un CUPO en una CUENTA REAL.
- Un cupo en una cuenta real puede contener un usuario de CUALQUIER cuenta Lank.
- Las cuentas reales y los grupos Lank son cosas DIFERENTES.
- Ejemplo: Cuenta Lank #36 (Camila Herrera) tiene un usuario "Prueba1_36".
  Ese usuario ocupa un cupo libre en la cuenta REAL chatgpt_1 (Daniel Silva Principal).
  La cuenta real chatgpt_1 puede tener usuarios de la cuenta Lank #1, #36, #15, cualquiera.

TIPOS DE CUENTAS REALES (campo accountStatus en get_real_accounts):
- 'active_cashback': Cuenta real ACTIVA con cashback. ✅ USAR PARA NUEVAS ASIGNACIONES.
- 'active_new': Cuenta real ACTIVA nueva. ✅ USAR PARA NUEVAS ASIGNACIONES.
- 'legacy_in_use': Cuenta heredada de un periodo anterior. 🚫 PROHIBIDO asignar nuevos usuarios.

🚫 REGLA ABSOLUTA: NUNCA, BAJO NINGUNA CIRCUNSTANCIA, asignes nuevos usuarios a cuentas LEGACY.
Las cuentas legacy (accountStatus='legacy_in_use') son solo para mantener usuarios que ya estaban.
Si el admin pide asignar usuarios, SOLO usa cuentas con accountStatus='active_cashback' o 'active_new'.
Si NO hay cupos libres en cuentas activas, INFORMA al admin y NO asignes a legacy.

ORDEN DE PRIORIDAD AL ELEGIR CUENTA REAL PARA ASIGNAR:
1. Primero: Cuentas con accountStatus='active_cashback' (generan cashback)
2. Segundo: Cuentas con accountStatus='active_new' (activas sin cashback)
3. NUNCA: Cuentas con accountStatus='legacy_in_use'
Dentro de cada categoría, elegir la que tenga más cupos libres.

DEFINICION DE "TIENE GRUPO" vs "NO TIENE GRUPO" (LEE ESTO CON CUIDADO):
Una cuenta Lank "tiene grupo activo" de un servicio si EXISTE un documento en groups/{service}/lank-accounts/{accountId} con groupStatus='active'.
Una cuenta Lank "NO tiene grupo" de un servicio si NO EXISTE ese documento.

REGLA ABSOLUTA: "TIENE GRUPO" NO DEPENDE DE SI TIENE USUARIOS.
- Cuenta con grupo activo y 5 usuarios = TIENE GRUPO ACTIVO
- Cuenta con grupo activo y 1 usuario = TIENE GRUPO ACTIVO
- Cuenta con grupo activo y 0 usuarios = TIENE GRUPO ACTIVO
- Cuenta SIN documento en groups/{service}/lank-accounts/ = NO TIENE GRUPO

Ejemplo: si el admin dice "cuentas que no tengan grupo activo de chatgpt", se refiere SOLO a cuentas cuyo documento groups/chatgpt/lank-accounts/{id} NO EXISTE. Las cuentas que SI tienen el documento con groupStatus='active' pero con 0 usuarios YA TIENEN grupo activo.

PROHIBIDO: interpretar hasUsers:false o subscriptionActive:false como "sin grupo" o "inactivo". Esos campos son metadatos internos, NO determinan si el grupo existe o esta activo.

SERVICIOS (IDs en Firestore):
- chatgpt → ChatGPT Plus
- youtube → YouTube Premium Cashback
- hbo → HBO Max Platino
- f1tv → F1 TV Premium
- gemini → Google AI Pro
- microsoft365 → Microsoft 365

HERRAMIENTAS DISPONIBLES (function calling REAL — úsalas directamente):
Tienes acceso a herramientas que SE EJECUTAN DE VERDAD en Firestore. Cuando necesites datos o ejecutar acciones, LLAMA LA HERRAMIENTA directamente sin describirla en texto primero.

LECTURA:
- get_alerts: Obtener alertas filtradas por estado
- get_lank_accounts: TODAS las cuentas Lank de un servicio con usuarios
- get_lank_account: UNA cuenta Lank específica por ID
- get_real_accounts: Cuentas reales (pools) con slots y ocupación
- get_audit_log: Últimos N cambios del sistema
- search_user: Buscar usuario por alias en TODOS los servicios

ESCRITURA (con audit trail automático):
- complete_alert: Marcar una alerta como completada
- create_alert: Crear nueva alerta
- update_lank_account: Actualizar campos de cuenta Lank (alias, notas, estado, etc.)
- add_user_to_account: Agregar usuario NUEVO a una cuenta Lank
- update_user_in_account: Editar un usuario EXISTENTE en una cuenta Lank (alias, proyecto, estado, etc.) ← USA ESTO en vez de eliminar+recrear
- remove_user_from_account: Eliminar usuario de una cuenta Lank
- update_real_account_slot: Asignar/actualizar un cupo en una cuenta real (memberAlias, projectName, memberEmail, slotNumber)
- restore_from_audit: Restaurar datos a estado anterior

REGLAS CRÍTICAS:
1. Siempre responde en español
2. Para acciones de escritura que modifiquen datos, pide confirmación ANTES de ejecutar si el usuario no ha confirmado explícitamente
3. Si el usuario dice 'confirmo', 'sí', 'hazlo', 'procede' o cualquier palabra similar → EJECUTA las herramientas directamente sin volver a preguntar
4. NUNCA inventes datos. Si no tienes la información, usa una herramienta de lectura para obtenerla
5. Toda acción queda registrada en audit-log automáticamente
6. Cuando ejecutes múltiples herramientas en secuencia, hazlo en el orden correcto (primero lectura, luego escritura)
7. Cuando asignes un cupo a un usuario, primero usa get_real_accounts para encontrar un cupo libre EN UNA CUENTA ACTIVA (accountStatus='active_cashback' o 'active_new'), luego usa update_real_account_slot con el slotIndex correcto. NUNCA uses cuentas legacy.
8. ZONA HORARIA: El admin está en México (UTC-6 fijo, sin horario de verano). Todos los timestamps almacenados están en UTC. SIEMPRE resta 6 horas a cualquier hora UTC antes de mostrársela al admin. NO muestres horas en UTC.
9. Cuando el admin diga "cuentas reales activas" o "cuentas activas no legacy", se refiere a cuentas con accountStatus='active_cashback' o 'active_new'. FILTRA las legacy.
10. FECHA DE RENOVACIÓN OBLIGATORIA: Para Microsoft 365 y cualquier servicio con isRenewalBased=true, TODOS los usuarios activos DEBEN tener renewDay (día del mes 1-31). Si al agregar o editar un usuario de M365 no se proporciona renewDay, PREGUNTA al admin. Si detectas usuarios sin renewDay, informa al admin.
11. TELÉFONO OBLIGATORIO: TODOS los usuarios de TODOS los servicios DEBEN tener el campo 'phone' (número de WhatsApp/teléfono). Si al agregar un usuario no se proporciona phone, PREGUNTA al admin. Si detectas usuarios sin phone al consultar datos, informa que falta ese dato. El campo phone se usa para la integración de WhatsApp en preparación.
12. ⚠️ ANTI-ALUCINACIÓN — REGLA ABSOLUTA: NUNCA digas que completaste una acción si NO llamaste la herramienta correspondiente. Si dices "He marcado la alerta como resuelta" DEBES haber llamado complete_alert() con el alertId correcto. Si dices "He eliminado al usuario" DEBES haber llamado remove_user_from_account(). Si la herramienta retornó un error, INFORMA el error, NO digas que se completó. VERIFICAR SIEMPRE = leer después de escribir para confirmar el cambio.
13. FLUJO PARA COMPLETAR UN PENDIENTE/ALERTA: Cuando el admin pida completar un pendiente o alerta:
    a) Llama get_alerts(status='pending') para obtener los IDs reales de las alertas
    b) Llama complete_alert(alertId=..., resolution=...) para CADA alerta que deba completarse
    c) Si hay usuarios que deben eliminarse, llama remove_user_from_account() para cada uno
    d) Si el grupo debe desactivarse, llama update_lank_account() con groupStatus='inactive'
    e) Verifica llamando get_alerts(status='pending') de nuevo para confirmar que ya no aparecen
14. CUANDO EL ADMIN DICE "COMPLETA ESOS PENDIENTES": NO es suficiente con decir "listo". DEBES ejecutar las herramientas reales paso a paso. El dashboard muestra datos de Firestore en tiempo real — si no llamaste las herramientas, el admin verá que nada cambió.
15. COBROS RECURRENTES: Tienes acceso a los cobros recurrentes pendientes del mes en finance/manual-ledger. Usa get_pending_charges() para ver qué cobros faltan por confirmar (muestra descripción, monto, fecha, suscripción y tarjeta vinculada). Usa confirm_pending_charge(entryIndex, overrideAmount) para confirmar un cobro. Si el admin pregunta por cobros pendientes, usa get_pending_charges. Si dice "confirma los cobros", usa confirm_pending_charge para cada uno. Si un cobro no tiene monto (amount=0), PREGUNTA al admin el monto antes de confirmar.
16. CUENTAS DE CRÉDITO: Tienes acceso a las cuentas de crédito bancarias en finance/credit-accounts. Usa get_credit_accounts() para consultar saldo, límite, utilización, fechas de corte/pago, MSI activos y tarjetas vinculadas. Usa update_credit_account(accountId, ...) para actualizar saldo, límite, pago mínimo, tasa u otros campos. Si el admin pregunta por sus créditos, deuda total o fechas próximas, usa get_credit_accounts. Si dice "actualiza el saldo de Nu" o similar, usa update_credit_account con el accountId correcto.

FLUJO OBLIGATORIO PARA EDITAR UN USUARIO EXISTENTE:
Cuando el admin pida cambiar el nombre, proyecto u otros datos de un usuario ya registrado:
- Usa update_user_in_account para actualizar el grupo Lank (currentAlias = nombre actual del usuario)
- Usa update_real_account_slot para actualizar el cupo en la cuenta real (slotIndex del cupo del usuario)
- NUNCA elimines y vuelvas a crear el usuario solo para cambiar un campo. Úsa la herramienta de edición.

FLUJO OBLIGATORIO PARA ASIGNAR UN USUARIO (PASO A PASO):
Cuando el admin pide agregar/asignar un usuario a un servicio, DEBES hacer ESTOS PASOS EN ORDEN:

PASO 1: Leer estado actual
- Llama get_lank_accounts(service=...) para ver qué cuenta Lank tendría al usuario
- Llama get_real_accounts(service=...) para ver qué cuentas reales tienen cupos libres (status='free')
- ⚠️ FILTRA: Solo considera cuentas con accountStatus='active_cashback' o 'active_new'. IGNORA cuentas legacy.

PASO 2: Agregar usuario al grupo Lank (add_user_to_account)
- userData DEBE contener:
  * userAlias: alias del usuario
  * phone: número de WhatsApp/teléfono del usuario (ej: +525512345678) ← PREGUNTAR si no se proporciona
  * serviceStatus: 'pending' (si aún no tiene cupo) o 'active'
  * serviceAccountRef: ID de la cuenta real (ej: 'chatgpt_1') ← OBLIGATORIO si asignas cupo
  * serviceAccountLabel: nombre legible de la cuenta real (ej: 'Daniel Silva (Principal)') ← OBLIGATORIO
  * projectName: nombre del proyecto si aplica ← OBLIGATORIO si el servicio es de tipo perfil/proyecto
  * cancelOn: 'N/D' si no aplica
  * renewDay: día del mes de renovación (1-31) ← OBLIGATORIO si el servicio es Microsoft 365 u otro servicio renewal-based

PASO 3: Actualizar cupo en la cuenta real (update_real_account_slot)
- updates DEBE contener:
  * memberAlias: igual que userAlias del paso anterior
  * status: 'active' (NO 'occupied') ← CRÍTICO: el sistema usa 'active' para cupos ocupados
  * projectName: nombre del proyecto si aplica
  * memberEmail: email si aplica
  * profileName: nombre de perfil si aplica
  * assignedFrom: objeto con accountId (número) y canonicalAlias (nombre de la cuenta Lank) ← OBLIGATORIO para vincular las dos vistas
  * assignedAt: fecha actual en ISO format

Ejemplo de assignedFrom: {"accountId": 1, "canonicalAlias": "Daniel Silva"}

IMPORTANTE SOBRE assignedFrom:
- El campo assignedFrom en el cupo real es LO QUE PERMITE:
  a) Mostrar la foto de perfil del dueño de la cuenta Lank en la vista de suscripciones
  b) Hacer clickeable el cupo para navegar a la cuenta Lank
  c) Mostrar el '← Nombre (#ID)' debajo del cupo
- SIN assignedFrom, el cupo se muestra sin foto y sin link. SIEMPRE incluirlo.

IMPORTANTE SOBRE projectName en el grupo Lank:
- El campo projectName en userData del grupo Lank es LO QUE MUESTRA el proyecto en la pestaña 'Cuentas de Lank'
- SIN projectName en userData, la pestaña de Cuentas Lank no muestra el proyecto del usuario
- SIEMPRE incluirlo si el servicio tiene proyectos/perfiles (chatgpt usa profile_project)

CAMPOS PROHIBIDOS — NUNCA los incluyas en userData al agregar o actualizar usuarios:
- matchStatus: Solo lo escribe el sistema de análisis automático de correos. Si lo escribes con 'pending', el usuario aparece con badge amarillo de advertencia en la UI. NUNCA lo incluyas al crear usuarios.
- matchConfidence: Mismo caso. NUNCA lo incluyas.
- Si ves estos campos en datos existentes, son correctos (fueron escritos por el sistema), solo no los copies.

VALORES CORRECTOS de serviceStatus al asignar manualmente:
- 'active': usuario con cupo real asignado (sin cashback)
- 'active_cashback': usuario con cupo real asignado y con cashback
- 'pending': usuario en lista de espera SIN cupo asignado aún
- Al asignar un cupo completo usa 'active' (o 'active_cashback' si el grupo tiene cashback=true).

REGLA DE ALERTAS:
- Las alertas son SOLO para acciones que requieren la intervencion del admin
- NO crear alertas para: pagos recibidos, retiros completados, validaciones de grupo ni notificaciones informativas
- SI crear alertas para: dar acceso, revocar acceso, cambiar contrasena, eliminar perfil, resolver inconsistencias
"""


# ─── DEFINICIÓN DE HERRAMIENTAS (Gemini Function Calling) ───────────────────

def _build_gemini_tools():
    """Construye la lista de herramientas reales para Gemini Function Calling.
    
    Estas herramientas se declaran a Gemini y cuando las llama, el servidor
    ejecuta el código real en Firestore.
    """
    from google.genai import types

    tools = types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name='get_alerts',
            description='Obtiene alertas del sistema filtradas por estado (pending, completed, discarded, done).',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'status': types.Schema(type='STRING', description='Estado: pending, completed, discarded, done'),
                },
            ),
        ),
        types.FunctionDeclaration(
            name='get_lank_accounts',
            description='Lee TODAS las cuentas Lank de un servicio con detalle de usuarios. Úsalo para conocer qué usuarios hay en un servicio.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio: chatgpt, youtube, hbo, f1tv, gemini, microsoft365'),
                },
                required=['service'],
            ),
        ),
        types.FunctionDeclaration(
            name='get_lank_account',
            description='Lee UNA cuenta Lank específica por su ID numérico.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountId': types.Schema(type='STRING', description='ID numérico de la cuenta Lank'),
                },
                required=['service', 'accountId'],
            ),
        ),
        types.FunctionDeclaration(
            name='get_real_accounts',
            description=(
                'Lee las cuentas reales (service pool) con sus cupos/slots y quién los ocupa. '
                'Úsalo para encontrar cupos libres antes de asignar un usuario. '
                'IMPORTANTE: Cada cuenta incluye accountStatus (active_cashback, active_new, legacy_in_use) '
                'e isLegacy (true/false). NUNCA asignes a cuentas con isLegacy=true. '
                'Las cuentas se retornan ordenadas: activas primero, legacy al final. '
                'También incluye freeSlots (cantidad de cupos libres) y slotIndex en cada slot (para update_real_account_slot).'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                },
                required=['service'],
            ),
        ),
        types.FunctionDeclaration(
            name='get_audit_log',
            description='Obtiene los últimos N registros de cambios del sistema (audit log).',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'limit': types.Schema(type='INTEGER', description='Número de registros a obtener (máx 100)'),
                },
            ),
        ),
        types.FunctionDeclaration(
            name='search_user',
            description='Busca un usuario por alias en TODOS los servicios y cuentas Lank.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'alias': types.Schema(type='STRING', description='Alias o nombre del usuario a buscar'),
                },
                required=['alias'],
            ),
        ),
        types.FunctionDeclaration(
            name='complete_alert',
            description='Marca una alerta como completada/resuelta.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'alertId': types.Schema(type='STRING', description='ID de la alerta a completar'),
                    'resolution': types.Schema(type='STRING', description='Descripción de cómo se resolvió'),
                },
                required=['alertId'],
            ),
        ),
        types.FunctionDeclaration(
            name='create_alert',
            description='Crea una nueva alerta en el sistema.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'alertData': types.Schema(
                        type='OBJECT',
                        description='Datos de la alerta',
                        properties={
                            'title': types.Schema(type='STRING'),
                            'description': types.Schema(type='STRING'),
                            'type': types.Schema(type='STRING', description='profile_delete, password_change, revoke_invitation, user_needs_access, ai_insight, etc.'),
                            'priority': types.Schema(type='STRING', description='critical, high, medium, low'),
                            'service': types.Schema(type='STRING'),
                            'accountId': types.Schema(type='STRING'),
                            'accountAlias': types.Schema(type='STRING'),
                            'userAlias': types.Schema(type='STRING'),
                        },
                    ),
                },
                required=['alertData'],
            ),
        ),
        types.FunctionDeclaration(
            name='add_user_to_account',
            description=(
                'Agrega un usuario nuevo a una cuenta Lank (grupo). '
                'IMPORTANTE: Si al mismo tiempo asignarás un cupo real, incluir en userData: '
                'serviceAccountRef (ID de la cuenta real, ej: chatgpt_1), '
                'serviceAccountLabel (nombre legible, ej: Daniel Silva Principal), '
                'projectName (nombre del proyecto si aplica). '
                'Estos campos son los que aparecen en la vista de Cuentas de Lank.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountId': types.Schema(type='STRING', description='ID numérico de la cuenta Lank'),
                    'userData': types.Schema(
                        type='OBJECT',
                        description='Datos del usuario a agregar',
                        properties={
                            'userAlias': types.Schema(type='STRING', description='Alias/nombre del usuario (requerido)'),
                            'serviceStatus': types.Schema(type='STRING', description='Estado: active, pending'),
                            'serviceAccountRef': types.Schema(type='STRING', description='ID de la cuenta real asignada (ej: chatgpt_1). Incluir siempre que se asigne cupo.'),
                            'serviceAccountLabel': types.Schema(type='STRING', description='Nombre legible de la cuenta real (ej: Daniel Silva Principal). Incluir junto con serviceAccountRef.'),
                            'serviceLabel': types.Schema(type='STRING', description='Nombre del plan (ej: ChatGPT Plus)'),
                            'serviceSlotNumber': types.Schema(type='INTEGER', description='Número de cupo asignado (1-based)'),
                            'projectName': types.Schema(type='STRING', description='Nombre del proyecto asignado. OBLIGATORIO para servicios tipo perfil/proyecto como chatgpt.'),
                            'cancelOn': types.Schema(type='STRING', description='Fecha de cancelación, N/D si no aplica'),
                            'renewDay': types.Schema(type='INTEGER', description='Día del mes de renovación (1-31). OBLIGATORIO para Microsoft 365 y otros servicios renewal-based.'),
                            'invitationEmail': types.Schema(type='STRING', description='Correo de invitación del usuario'),
                            'phone': types.Schema(type='STRING', description='Número de teléfono/WhatsApp del usuario (ej: +525512345678). IMPORTANTE: siempre incluir si se conoce.'),
                            'userEmail': types.Schema(type='STRING', description='Correo electrónico del usuario'),
                            'profileName': types.Schema(type='STRING', description='Nombre del perfil del usuario en el servicio (ej: perfil HBO)'),
                        },
                        required=['userAlias'],
                    ),
                },
                required=['service', 'accountId', 'userData'],
            ),
        ),
        types.FunctionDeclaration(
            name='update_user_in_account',
            description=(
                'Actualiza campos de un usuario EXISTENTE en una cuenta Lank (grupo). '
                'Úsalo para renombrar usuarios, cambiar su proyecto, estado, email, etc. '
                'NO elimines y vuelvas a crear para editar — usa esta herramienta directamente. '
                'Identifica al usuario por su userAlias actual (currentAlias). '
                'Luego especifica en updates solo los campos que cambían.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountId': types.Schema(type='STRING', description='ID numérico de la cuenta Lank'),
                    'currentAlias': types.Schema(type='STRING', description='Alias ACTUAL del usuario que se desea editar (para buscarlo)'),
                    'updates': types.Schema(
                        type='OBJECT',
                        description='Campos a actualizar en el usuario',
                        properties={
                            'userAlias': types.Schema(type='STRING', description='Nuevo alias/nombre del usuario'),
                            'projectName': types.Schema(type='STRING', description='Nuevo nombre del proyecto'),
                            'serviceStatus': types.Schema(type='STRING', description='Nuevo estado: active, active_cashback, pending'),
                            'serviceAccountRef': types.Schema(type='STRING', description='Nuevo ID de cuenta real'),
                            'serviceAccountLabel': types.Schema(type='STRING', description='Nuevo nombre legible de cuenta real'),
                            'serviceLabel': types.Schema(type='STRING', description='Nuevo nombre del plan'),
                            'serviceSlotNumber': types.Schema(type='INTEGER', description='Nuevo número de cupo'),
                            'cancelOn': types.Schema(type='STRING', description='Nueva fecha de cancelación'),
                            'renewDay': types.Schema(type='INTEGER', description='Día del mes de renovación (1-31). Obligatorio para servicios renewal-based como Microsoft 365.'),
                            'invitationEmail': types.Schema(type='STRING', description='Correo de invitación del usuario'),
                            'phone': types.Schema(type='STRING', description='Número de teléfono/WhatsApp del usuario (ej: +525512345678)'),
                            'userEmail': types.Schema(type='STRING', description='Correo electrónico del usuario'),
                            'profileName': types.Schema(type='STRING', description='Nombre del perfil del usuario en el servicio'),
                        },
                    ),
                },
                required=['service', 'accountId', 'currentAlias', 'updates'],
            ),
        ),
        types.FunctionDeclaration(
            name='remove_user_from_account',
            description='Elimina un usuario de una cuenta Lank.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountId': types.Schema(type='STRING', description='ID numérico de la cuenta Lank'),
                    'userAlias': types.Schema(type='STRING', description='Alias del usuario a eliminar'),
                },
                required=['service', 'accountId', 'userAlias'],
            ),
        ),
        types.FunctionDeclaration(
            name='update_lank_account',
            description='Actualiza campos de una cuenta Lank: alias, nombre completo, notas, estado, cashback.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountId': types.Schema(type='STRING', description='ID numérico de la cuenta Lank'),
                    'updates': types.Schema(
                        type='OBJECT',
                        description='Campos a actualizar: accountAlias, fullName, cashback, groupStatus, subscriptionActive, notes',
                    ),
                },
                required=['service', 'accountId', 'updates'],
            ),
        ),
        types.FunctionDeclaration(
            name='update_real_account_slot',
            description=(
                'Asigna o actualiza un cupo (slot) en una cuenta real de servicio. '
                'Usa get_real_accounts primero para obtener el slotIndex correcto del cupo libre. '
                'CRÍTICO: status debe ser "active" (NO "occupied") para marcar un cupo como ocupado. '
                'OBLIGATORIO incluir assignedFrom para vincular con la cuenta Lank: '
                'permite mostrar foto de perfil y navegación bidireccional entre vistas. '
                'assignedFrom = {"accountId": <número de la cuenta Lank>, "canonicalAlias": <nombre de la cuenta Lank>}'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'service': types.Schema(type='STRING', description='ID del servicio'),
                    'accountRef': types.Schema(type='STRING', description='ID de la cuenta real (ej: chatgpt_1)'),
                    'slotIndex': types.Schema(type='INTEGER', description='Índice 0-based del slot en el array slots[]'),
                    'updates': types.Schema(
                        type='OBJECT',
                        description='Datos a actualizar en el slot',
                        properties={
                            'memberAlias': types.Schema(type='STRING', description='Alias del miembro asignado al cupo'),
                            'projectName': types.Schema(type='STRING', description='Nombre del proyecto asignado (para ChatGPT y similares)'),
                            'memberEmail': types.Schema(type='STRING', description='Email del miembro'),
                            'profileName': types.Schema(type='STRING', description='Nombre del perfil'),
                            'status': types.Schema(type='STRING', description='Estado del cupo: active (ocupado), free (libre), disabled. USAR "active" para asignar, NO "occupied".'),
                            'assignedAt': types.Schema(type='STRING', description='Fecha de asignación en ISO format'),
                            'assignedFrom': types.Schema(
                                type='OBJECT',
                                description='OBLIGATORIO: Vincula el cupo con la cuenta Lank. Permite foto de perfil y navegación. Ej: {"accountId": 1, "canonicalAlias": "Daniel Silva"}',
                                properties={
                                    'accountId': types.Schema(type='INTEGER', description='ID numérico de la cuenta Lank dueña del usuario'),
                                    'canonicalAlias': types.Schema(type='STRING', description='Nombre/alias de la cuenta Lank'),
                                },
                            ),
                        },
                    ),
                },
                required=['service', 'accountRef', 'slotIndex', 'updates'],
            ),
        ),
        types.FunctionDeclaration(
            name='restore_from_audit',
            description='Restaura datos al estado anterior usando un registro del audit log. Permite deshacer cambios.',
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'auditId': types.Schema(type='STRING', description='ID del registro en el audit-log'),
                },
                required=['auditId'],
            ),
        ),
        types.FunctionDeclaration(
            name='get_schedule',
            description='Obtiene la configuración completa del análisis programado de correos: estado, frecuencia, hora de inicio, horario activo.',
            parameters=types.Schema(
                type='OBJECT',
                properties={},
            ),
        ),
        types.FunctionDeclaration(
            name='get_pending_charges',
            description=(
                'Lee los cobros recurrentes pendientes de confirmación del mes actual (finance/manual-ledger). '
                'Retorna descripción, monto, fecha, suscripción, tarjeta vinculada y estado. '
                'Usar para revisar qué cobros faltan por confirmar.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={},
            ),
        ),
        types.FunctionDeclaration(
            name='confirm_pending_charge',
            description=(
                'Confirma un cobro recurrente pendiente en el ledger de finanzas. '
                'Cambia su status de pending a confirmed, registra la fecha de confirmación, '
                'y actualiza los totales del mes. Opcionalmente permite ajustar el monto.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'entryIndex': types.Schema(type='INTEGER', description='Índice (0-based) de la entrada en el array de entries del ledger. Obtener de get_pending_charges.'),
                    'overrideAmount': types.Schema(type='NUMBER', description='Monto a usar en lugar del original (opcional). Si no se envía, se usa el monto existente.'),
                },
                required=['entryIndex'],
            ),
        ),
        types.FunctionDeclaration(
            name='update_schedule',
            description=(
                'Actualiza la configuración del análisis programado de correos. '
                'Puede activar/desactivar, cambiar frecuencia, hora de inicio, y horario activo. '
                'Solo envía los campos que se quieren cambiar.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'enabled': types.Schema(type='BOOLEAN', description='Activar (true) o desactivar (false) el análisis programado'),
                    'frequencyHours': types.Schema(type='INTEGER', description='Frecuencia en horas entre análisis (ej: 2, 6, 12, 24)'),
                    'startTime': types.Schema(type='STRING', description='Hora de inicio en ISO 8601 UTC (ej: 2026-04-11T12:00:00.000Z). El admin da horas en MX (UTC-6), SUMAR 6 horas para convertir a UTC.'),
                    'activeHoursEnabled': types.Schema(type='BOOLEAN', description='Activar/desactivar el filtro de horario activo'),
                    'activeHoursStart': types.Schema(type='INTEGER', description='Hora de inicio del horario activo en hora MX (0-23, ej: 6)'),
                    'activeHoursEnd': types.Schema(type='INTEGER', description='Hora de fin del horario activo en hora MX (0-23, ej: 22)'),
                },
            ),
        ),
        types.FunctionDeclaration(
            name='get_credit_accounts',
            description=(
                'Lee las cuentas de crédito bancarias del admin (finance/credit-accounts). '
                'Retorna banco, límite de crédito, saldo actual, utilización, días de corte y pago, '
                'tasa anual, tarjetas vinculadas, CLABEs y pagos a meses sin intereses activos. '
                'Usar para consultar estado de créditos, fechas próximas, o deuda total.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={},
            ),
        ),
        types.FunctionDeclaration(
            name='update_credit_account',
            description=(
                'Actualiza campos de una cuenta de crédito existente. '
                'Puede actualizar saldo, límite, pagos, tasa de interés, etc. '
                'Solo envía los campos que se quieren cambiar.'
            ),
            parameters=types.Schema(
                type='OBJECT',
                properties={
                    'accountId': types.Schema(type='STRING', description='ID de la cuenta de crédito a actualizar (obtener de get_credit_accounts).'),
                    'currentBalance': types.Schema(type='NUMBER', description='Nuevo saldo actual de la cuenta.'),
                    'creditLimit': types.Schema(type='NUMBER', description='Nuevo límite de crédito.'),
                    'minimumPayment': types.Schema(type='NUMBER', description='Nuevo pago mínimo del período.'),
                    'annualRate': types.Schema(type='NUMBER', description='Nueva tasa de interés anual en porcentaje (ej: 45 para 45%).'),
                    'cutoffDay': types.Schema(type='INTEGER', description='Nuevo día de corte (1-31).'),
                    'paymentDueDay': types.Schema(type='INTEGER', description='Nuevo día límite de pago (1-31).'),
                },
                required=['accountId'],
            ),
        ),
    ])
    return tools


# ─── CLASE PRINCIPAL ────────────────────────────────────────────────────────

class GeminiClient:
    """Cliente de Gemini AI para AdminLank.
    
    Maneja la conexión con la API de Gemini, carga configuración desde
    Firestore, y proporciona métodos para análisis y chat.
    """

    def __init__(self, db, settings_override=None):
        """Inicializa el cliente de Gemini.
        
        Args:
            db: Cliente de Firestore.
            settings_override: Dict con settings que sobreescriben los de Firestore.
        """
        self.db = db
        self._client = None
        self._settings = None
        self._settings_override = settings_override

    @property
    def settings(self):
        """Carga settings de Firestore (con cache por instancia)."""
        if self._settings is None:
            self._settings = self._load_settings()
        return self._settings

    def _load_settings(self):
        """Carga la configuración de IA desde Firestore."""
        try:
            doc = self.db.document('config/ai-settings').get()
            if doc.exists:
                settings = {**DEFAULT_AI_SETTINGS, **doc.to_dict()}
            else:
                settings = dict(DEFAULT_AI_SETTINGS)
        except Exception:
            settings = dict(DEFAULT_AI_SETTINGS)

        # Aplicar overrides si existen
        if self._settings_override:
            settings.update(self._settings_override)

        return settings

    @property
    def client(self):
        """Obtiene el cliente de Gemini (lazy initialization)."""
        if self._client is None:
            self._client = self._init_client()
        return self._client

    def _init_client(self):
        """Inicializa la conexión con la API de Gemini."""
        api_key = self.settings.get('apiKey')
        if not api_key:
            raise ValueError(
                "API Key de Gemini no configurada. "
                "Configúrala en la pestaña de Chat IA > Configuración."
            )

        try:
            from google import genai
            return genai.Client(api_key=api_key)
        except ImportError:
            raise ImportError(
                "El paquete 'google-genai' no está instalado. "
                "Agrega 'google-genai>=1.0.0' a requirements.txt."
            )

    @property
    def is_enabled(self):
        """Verifica si la IA está habilitada."""
        return bool(self.settings.get('enabled')) and bool(self.settings.get('apiKey'))

    @property
    def is_analysis_enabled(self):
        """Verifica si el análisis con IA está habilitado."""
        return self.is_enabled and bool(self.settings.get('analysisEnabled', True))

    @property
    def is_chat_enabled(self):
        """Verifica si el chat con IA está habilitado."""
        return self.is_enabled and bool(self.settings.get('chatEnabled', True))

    # ─── ANÁLISIS DE CORREOS (SEGUNDA CAPA) ─────────────────────────────

    def analyze_emails(self, raw_emails, script_results, system_context,
                       active_alerts=None, audit_log=None):
        """Ejecuta la segunda capa de análisis con Gemini — IA como decisora.

        La IA recibe correos crudos, resultados de scripts, estado del sistema,
        alertas activas y el historial reciente. Emite acciones concretas.

        Args:
            raw_emails: Lista de correos crudos [{subject, body, from, date}, ...].
            script_results: Resultado de los scripts [{kind, service, ...}, ...].
            system_context: Estado actual del sistema (suscripciones, usuarios, etc.).
            active_alerts: Lista de alertas activas en Firestore.
            audit_log: Resumen del historial reciente (texto formateado).

        Returns:
            dict: Resultado con 'actions' a ejecutar, o None si está deshabilitado.
        """
        if not self.is_analysis_enabled:
            return None

        model = self.settings.get('analysisModel', 'gemini-3.1-flash-lite-preview')

        # Construir el prompt completo con todos los datos
        user_prompt = self._build_analysis_prompt(
            raw_emails, script_results, system_context,
            active_alerts=active_alerts, audit_log=audit_log,
        )

        try:
            from google.genai import types

            # Reintento con backoff para errores transitorios (503, alta demanda)
            response = None
            last_err = None
            for attempt in range(3):
                try:
                    response = self.client.models.generate_content(
                        model=model,
                        contents=user_prompt,
                        config=types.GenerateContentConfig(
                            system_instruction=self._get_analysis_prompt(),
                            temperature=float(self.settings.get('temperature', 0.3)),
                            response_mime_type='application/json',
                        ),
                    )
                    break
                except Exception as retry_err:
                    err_str = str(retry_err).lower()
                    is_transient = any(k in err_str for k in ['503', 'unavailable', 'overloaded', 'quota', 'rate_limit', 'resource_exhausted'])
                    if is_transient and attempt < 2:
                        import time
                        wait_secs = (attempt + 1) * 3
                        print(f'[AI] Reintento análisis {attempt + 1}/2 tras error transitorio, esperando {wait_secs}s')
                        time.sleep(wait_secs)
                        last_err = retry_err
                    else:
                        raise

            if response is None:
                raise last_err or Exception('No se obtuvo respuesta de Gemini tras reintentos')

            # Parsear la respuesta JSON
            result = json.loads(response.text)

            # Registrar en audit-log
            actions = result.get('actions', [])
            lank_audit.log_change(
                self.db,
                source='ai_analysis',
                action='ai_email_analysis',
                description=result.get('summary', 'Análisis de IA completado'),
                actor='ai',
                ai_involved=True,
                ai_model=model,
                metadata={
                    'emailsAnalyzed': len(raw_emails),
                    'totalActions': len(actions),
                    'actionTypes': list(set(a.get('type', '?') for a in actions)),
                    'confidence': result.get('overallConfidence', 0),
                }
            )

            return result

        except json.JSONDecodeError as e:
            print(f'[AI] Error parsing AI response as JSON: {e}')
            print(f'[AI] Raw response: {response.text[:500] if response else "None"}')
            return {'error': 'json_parse_error', 'rawResponse': response.text[:500] if response else None}
        except Exception as e:
            print(f'[AI] Error in email analysis: {e}')
            traceback.print_exc()
            return {'error': str(e)}

    def _build_analysis_prompt(self, raw_emails, script_results, system_context,
                               active_alerts=None, audit_log=None):
        """Construye el prompt completo para el análisis de correos.

        Incluye: correos crudos, resultados de scripts, estado del sistema,
        alertas activas y historial reciente de acciones.
        """
        # Formatear correos crudos
        emails_text = []
        for i, email in enumerate(raw_emails):
            emails_text.append(
                f"--- Correo #{i} ---\n"
                f"Cuenta Lank: #{email.get('accountId', '?')} ({email.get('accountAlias', '?')})\n"
                f"De: {email.get('from', 'N/A')}\n"
                f"Asunto: {email.get('subject', 'N/A')}\n"
                f"Fecha: {email.get('date', 'N/A')}\n"
                f"Cuerpo:\n{email.get('body', '(vacío)')[:1500]}\n"
            )

        # Formatear resultados de scripts
        scripts_text = json.dumps(script_results, ensure_ascii=False, indent=2, default=str)

        # Formatear contexto del sistema (resumido para ahorrar tokens)
        context_summary = self._summarize_system_context(system_context)

        # Formatear alertas activas
        alerts_text = "No hay alertas activas."
        if active_alerts:
            alert_lines = []
            for a in active_alerts[:20]:  # Máximo 20 para no consumir tokens
                alert_lines.append(
                    f"  [{a.get('id', '?')}] {a.get('type', '?')} | {a.get('priority', '?')} | "
                    f"{a.get('service', '?')} | {a.get('userAlias', '?')} — {a.get('title', '')}"
                )
            alerts_text = f"{len(active_alerts)} alertas activas:\n" + "\n".join(alert_lines)

        # Historial reciente
        audit_text = audit_log or "No hay historial de acciones recientes."

        return (
            f"ESTADO ACTUAL DEL SISTEMA:\n{context_summary}\n\n"
            f"ALERTAS ACTIVAS:\n{alerts_text}\n\n"
            f"HISTORIAL RECIENTE DE ACCIONES:\n{audit_text}\n\n"
            f"CORREOS CRUDOS ({len(raw_emails)} correos):\n"
            f"{''.join(emails_text)}\n\n"
            f"RESULTADO DE LOS SCRIPTS (primera capa):\n{scripts_text}\n\n"
            f"INSTRUCCIONES:\n"
            f"1. Lee TODOS los correos crudos y entiende qué pasó en cada uno.\n"
            f"2. Compara tu interpretación con lo que los scripts detectaron.\n"
            f"3. Para CADA evento importante (usuario se unió, salió, etc.):\n"
            f"   - Si ya hay una alerta ACTIVA (status=pending) para el mismo usuario/cuenta/tipo → NO crear otra.\n"
            f"   - Si NO hay alerta activa correspondiente → CREAR ALERTA (aunque los scripts lo hayan detectado).\n"
            f"   - Solo crear alertas para eventos que requieren ACCIÓN del admin.\n"
            f"   - Para SALIDAS (user_left): VERIFICA el campo 'hadRealAccess' en los resultados de scripts.\n"
            f"     Si hadRealAccess=false → el usuario NUNCA tuvo acceso real → NO generar alerta.\n"
            f"     También revisa el ESTADO DEL SISTEMA: si el usuario aparece como '(SIN acceso real asignado)' → NO generar alerta.\n"
            f"     Esto aplica para TODOS los servicios sin excepción.\n"
            f"4. Solo cancela alertas si el correo CLARAMENTE contradice la alerta.\n"
            f"5. En tu resumen, describe qué encontraste en cada correo.\n"
            f"Cada acción debe tener razón y confianza."
        )

    def _summarize_system_context(self, context):
        """Resume el contexto del sistema para ahorrar tokens.

        Incluye info de proyecto/acceso real de cada usuario para que la IA
        pueda determinar si un usuario tenía acceso real al servicio.
        """
        if not context:
            return "No hay contexto del sistema disponible."

        parts = []
        for service_name, data in context.items():
            accounts = data.get('accounts', {})
            total_users = 0
            account_summaries = []
            for aid, acc in accounts.items():
                users = acc.get('currentUsers', [])
                total_users += len(users)
                user_details = []
                for u in users[:10]:
                    alias = u.get('alias', '?')
                    project = u.get('projectName', '')
                    svc_ref = u.get('serviceAccountRef', '')
                    slot = u.get('serviceSlotNumber', '')
                    if project and svc_ref:
                        user_details.append(f"{alias} (proyecto: {project}, cuenta real: {svc_ref} slot #{slot})")
                    elif svc_ref:
                        user_details.append(f"{alias} (cuenta real: {svc_ref} slot #{slot}, sin proyecto)")
                    else:
                        user_details.append(f"{alias} (SIN acceso real asignado)")
                account_summaries.append(
                    f"  Cuenta Lank #{aid}: {len(users)} usuarios\n    " + '\n    '.join(user_details) if user_details else f"  Cuenta Lank #{aid}: 0 usuarios"
                )
            parts.append(
                f"{service_name} ({total_users} usuarios total):\n"
                + '\n'.join(account_summaries)
            )

        return '\n'.join(parts) if parts else "Sin datos del sistema."

    # ─── RESOLUCIÓN DE PROMPTS ────────────────────────────────────────────

    def _get_chat_prompt(self):
        """Obtiene el system prompt para chat (custom o default)."""
        try:
            doc = self.db.document('config/ai-prompts').get()
            if doc.exists:
                data = doc.to_dict()
                if data.get('useCustomChat') and data.get('chatPrompt', '').strip():
                    return data['chatPrompt']
        except Exception:
            pass
        return CHAT_SYSTEM_PROMPT

    def _get_analysis_prompt(self):
        """Obtiene el system prompt para análisis (custom o default)."""
        try:
            doc = self.db.document('config/ai-prompts').get()
            if doc.exists:
                data = doc.to_dict()
                if data.get('useCustomAnalysis') and data.get('analysisPrompt', '').strip():
                    return data['analysisPrompt']
        except Exception:
            pass
        return ANALYSIS_SYSTEM_PROMPT

    # ─── CHAT INTERACTIVO ───────────────────────────────────────────────

    def chat(self, message, chat_history=None, tool_executor=None):
        """Envía un mensaje al chat de Gemini con agentic loop real.

        Implementa un loop multi-turn donde:
        1. Gemini recibe el mensaje con las herramientas definidas
        2. Si Gemini decide llamar herramientas, se ejecutan de verdad
        3. Los resultados se pasan de vuelta a Gemini como FunctionResponse
        4. El loop continúa hasta que Gemini dé una respuesta final (máx 5 rondas)

        Args:
            message: Mensaje del admin.
            chat_history: Lista de mensajes previos [{role, content}, ...].
            tool_executor: Callable(function_calls) -> results que ejecuta herramientas reales.

        Returns:
            dict: Respuesta de la IA con functionCalls y functionResults ejecutados.
        """
        if not self.is_chat_enabled:
            return {
                'response': 'El chat con IA está deshabilitado. Actívalo en Configuración.',
                'actions': [],
            }

        model = self.settings.get('chatModel', 'gemini-3.1-flash-lite-preview')
        thinking_level = self.settings.get('thinkingLevel', 'none')

        try:
            from google.genai import types

            # Construir historial de mensajes
            contents = self._build_chat_contents(message, chat_history)

            # Configuracion base
            config_params = {
                'system_instruction': self._get_chat_prompt(),
                'temperature': float(self.settings.get('temperature', 0.3)),
            }

            # Thinking (solo si hay soporte)
            if thinking_level and thinking_level != 'none':
                try:
                    config_params['thinking_config'] = types.ThinkingConfig(
                        thinking_level=thinking_level,
                    )
                except Exception as te:
                    print(f'[AI] ThinkingConfig error: {te}')

            # Declarar herramientas reales para function calling
            gemini_tools = _build_gemini_tools()
            config_params['tools'] = [gemini_tools]

            all_function_calls = []
            all_function_results = []
            final_text = ''
            final_thinking = ''
            max_rounds = 10

            # Agentic loop: máx 10 rondas de tool use
            for round_num in range(max_rounds):
                # Reintento con backoff para errores transitorios (503, cuota, etc.)
                ai_response = None
                last_err = None
                for attempt in range(3):
                    try:
                        ai_response = self.client.models.generate_content(
                            model=model,
                            contents=contents,
                            config=types.GenerateContentConfig(**config_params),
                        )
                        break
                    except Exception as retry_err:
                        err_str = str(retry_err).lower()
                        is_transient = any(k in err_str for k in ['503', 'unavailable', 'overloaded', 'quota', 'rate_limit', 'resource_exhausted'])
                        if is_transient and attempt < 2:
                            import time
                            wait_secs = (attempt + 1) * 3  # 3s, 6s
                            print(f'[AI] Reintento {attempt + 1}/2 tras error transitorio, esperando {wait_secs}s: {retry_err}')
                            time.sleep(wait_secs)
                            last_err = retry_err
                        else:
                            raise  # Error no transitorio o agotados los reintentos

                if ai_response is None:
                    raise last_err or Exception('No se obtuvo respuesta tras reintentos')

                response = ai_response

                if not response.candidates:
                    # Si no hay candidatos en una ronda de herramientas, generar texto de resumen
                    if all_function_results:
                        final_text = 'Se ejecutaron las herramientas solicitadas, pero Gemini no generó una respuesta de texto. Revisa los resultados de las acciones.'
                    else:
                        final_text = 'No se obtuvo respuesta de Gemini.'
                    break

                candidate = response.candidates[0]
                parts = candidate.content.parts if candidate.content else []

                # Recolectar partes de texto, thinking y function calls
                text_parts = []
                thinking_parts = []
                function_calls_this_round = []

                for part in parts:
                    if hasattr(part, 'thought') and part.thought:
                        thinking_parts.append(part.text or '')
                    elif hasattr(part, 'function_call') and part.function_call and part.function_call.name:
                        function_calls_this_round.append({
                            'name': part.function_call.name,
                            'args': dict(part.function_call.args) if part.function_call.args else {},
                        })
                    elif hasattr(part, 'text') and part.text:
                        text_parts.append(part.text)

                if thinking_parts:
                    final_thinking += '\n'.join(thinking_parts)

                # Si no hay function calls, es la respuesta final
                if not function_calls_this_round:
                    final_text = '\n'.join(text_parts) if text_parts else ''
                    break

                # Hay function calls — ejecutarlas de verdad
                print(f'[AI] Round {round_num + 1}/{max_rounds}: ejecutando {len(function_calls_this_round)} herramienta(s): '
                      f'{", ".join(fc["name"] for fc in function_calls_this_round)}')

                all_function_calls.extend(function_calls_this_round)

                if tool_executor:
                    try:
                        fn_results = tool_executor(function_calls_this_round)
                    except Exception as exec_err:
                        print(f'[AI] Error ejecutando herramientas en round {round_num + 1}: {exec_err}')
                        traceback.print_exc()
                        fn_results = [{'function': fc['name'], 'success': False, 'error': f'Error de ejecución: {str(exec_err)}'}
                                      for fc in function_calls_this_round]
                else:
                    fn_results = [{'function': fc['name'], 'success': False, 'error': 'No executor'}
                                  for fc in function_calls_this_round]

                all_function_results.extend(fn_results)

                # Agregar el turno del modelo al historial de contents
                contents.append(candidate.content)

                # Agregar los resultados de las funciones como FunctionResponse
                fn_response_parts = []
                for fc, fr in zip(function_calls_this_round, fn_results):
                    fn_response_parts.append(
                        types.Part.from_function_response(
                            name=fc['name'],
                            response={'result': fr},
                        )
                    )
                contents.append(
                    types.Content(role='user', parts=fn_response_parts)
                )

            # Si el loop terminó por max_rounds sin respuesta de texto,
            # generar un resumen
            if not final_text and all_function_results:
                final_text = (
                    f'⚠️ Se alcanzó el límite de {max_rounds} rondas de herramientas. '
                    f'Se ejecutaron {len(all_function_calls)} herramienta(s) en total. '
                    f'Revisa los resultados de las acciones ejecutadas.'
                )

            return {
                'response': final_text,
                'thinking': final_thinking if final_thinking else None,
                'functionCalls': all_function_calls,
                'functionResults': all_function_results,
            }

        except Exception as e:
            print(f'[AI] Error in chat: {e}')
            traceback.print_exc()
            return {
                'response': f'Error al comunicarse con Gemini: {str(e)}',
                'actions': [],
                'error': True,
            }

    def _build_chat_contents(self, new_message, history=None):
        """Construye el array de contenidos para Gemini."""
        from google.genai import types

        contents = []

        # Agregar historial (últimos N mensajes para contexto)
        max_history = 20
        if history:
            for msg in history[-max_history:]:
                role = msg.get('role', 'user')
                # Gemini usa 'user' y 'model'
                gemini_role = 'model' if role in ('assistant', 'model', 'ai') else 'user'
                contents.append(
                    types.Content(
                        role=gemini_role,
                        parts=[types.Part(text=msg.get('content', ''))],
                    )
                )

        # Agregar nuevo mensaje
        contents.append(
            types.Content(
                role='user',
                parts=[types.Part(text=new_message)],
            )
        )

        return contents

    def _process_chat_response(self, response):
        """Procesa la respuesta de Gemini, incluyendo function calls."""
        result = {
            'response': '',
            'actions': [],
            'functionCalls': [],
        }

        if not response.candidates:
            result['response'] = 'No se obtuvo respuesta de Gemini.'
            return result

        candidate = response.candidates[0]
        parts = candidate.content.parts if candidate.content else []

        text_parts = []
        thinking_parts = []
        for part in parts:
            if hasattr(part, 'thought') and part.thought:
                thinking_parts.append(part.text or '')
            elif hasattr(part, 'text') and part.text:
                text_parts.append(part.text)
            elif hasattr(part, 'function_call') and part.function_call:
                result['functionCalls'].append({
                    'name': part.function_call.name,
                    'args': dict(part.function_call.args) if part.function_call.args else {},
                })

        result['response'] = '\n'.join(text_parts) if text_parts else ''
        if thinking_parts:
            result['thinking'] = '\n'.join(thinking_parts)
        return result

    # ─── TEST DE CONEXIÓN ───────────────────────────────────────────────

    def test_connection(self):
        """Verifica que la conexión con Gemini funciona.

        Returns:
            dict: {success: bool, message: str, model: str}
        """
        try:
            model = self.settings.get('model', 'gemini-3.1-flash-lite-preview')

            response = self.client.models.generate_content(
                model=model,
                contents='Responde solo con "OK" si puedes leer este mensaje.',
            )

            return {
                'success': True,
                'message': f'Conexión exitosa. Respuesta: {response.text.strip()[:100]}',
                'model': model,
            }
        except Exception as e:
            return {
                'success': False,
                'message': f'Error de conexión: {str(e)}',
                'model': self.settings.get('model', 'desconocido'),
            }
