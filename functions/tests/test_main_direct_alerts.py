import sys
import types
from pathlib import Path

import pytest


FUNCTIONS_DIR = Path(__file__).resolve().parents[1]
if str(FUNCTIONS_DIR) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS_DIR))


class _DecoratorFactory:
    def __call__(self, *args, **kwargs):
        def decorator(fn):
            return fn

        return decorator


class _CorsOptions:
    def __init__(self, *args, **kwargs):
        pass


class _MemoryOption:
    MB_256 = "MB_256"
    MB_512 = "MB_512"
    GB_1 = "GB_1"


class _FakeResponse:
    def __init__(self, body=None, status=200, content_type=None):
        self.body = body
        self.status = status
        self.content_type = content_type


firebase_functions = types.ModuleType("firebase_functions")
firebase_functions.https_fn = types.SimpleNamespace(
    on_request=_DecoratorFactory(),
    Response=_FakeResponse,
    Request=object,
)
firebase_functions.scheduler_fn = types.SimpleNamespace(
    on_schedule=_DecoratorFactory(),
    ScheduledEvent=object,
)
firebase_functions.options = types.SimpleNamespace(
    CorsOptions=_CorsOptions,
    MemoryOption=_MemoryOption,
)
sys.modules.setdefault("firebase_functions", firebase_functions)

firebase_admin = types.ModuleType("firebase_admin")
firebase_admin.initialize_app = lambda: object()
firebase_admin.firestore = types.SimpleNamespace(client=lambda: None)
firebase_admin.auth = types.SimpleNamespace(verify_id_token=lambda _token: {"uid": "test-admin"})
sys.modules.setdefault("firebase_admin", firebase_admin)

google_module = types.ModuleType("google")
google_cloud = types.ModuleType("google.cloud")
google_firestore = types.ModuleType("google.cloud.firestore")
google_cloud.firestore = google_firestore
google_module.cloud = google_cloud
sys.modules.setdefault("google", google_module)
sys.modules.setdefault("google.cloud", google_cloud)
sys.modules.setdefault("google.cloud.firestore", google_firestore)

import lank_alerts
import main


ADMIN_UID = "Ls1vtEv0rvY8DIyKKKmQY5SlOOQ2"
ADMIN_HEADERS = {"Authorization": "Bearer admin-token"}


def make_http_request(method="GET", *, headers=None, body=None, args=None):
    return types.SimpleNamespace(
        method=method,
        headers=headers or {},
        args=args or {},
        get_json=lambda silent=True: body or {},
    )


def test_update_schedule_rejects_missing_firebase_token(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(main.firestore, "client", lambda: db)

    response = main.update_schedule(make_http_request("POST", body={"enabled": True}))

    assert response.status == 401
    assert "Authorization" in response.body
    assert "config/schedule" not in db.documents


def test_update_schedule_rejects_non_admin_firebase_user(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main.auth, "verify_id_token", lambda _token: {"uid": "not-admin"})

    response = main.update_schedule(
        make_http_request("POST", headers=ADMIN_HEADERS, body={"enabled": True})
    )

    assert response.status == 403
    assert "admin" in response.body.lower()
    assert "config/schedule" not in db.documents


def test_update_schedule_accepts_admin_firebase_user(monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main.auth, "verify_id_token", lambda _token: {"uid": ADMIN_UID})

    response = main.update_schedule(
        make_http_request("POST", headers=ADMIN_HEADERS, body={"enabled": True, "frequencyHours": 4})
    )

    assert response.status == 200
    assert db.documents["config/schedule"]["enabled"] is True
    assert db.documents["config/schedule"]["frequencyHours"] == 4


def test_protected_dashboard_endpoint_keeps_options_public(monkeypatch):
    monkeypatch.setattr(
        main.auth,
        "verify_id_token",
        lambda _token: pytest.fail("OPTIONS must not verify Firebase tokens"),
    )

    response = main.update_schedule(make_http_request("OPTIONS"))

    assert response.status == 204


def test_parse_event_detects_withdrawal_by_clabe_when_subject_varies():
    body = """
    Tu extracción de fondos se encuentra en revisión.
    Monto: 1250.50
    CLABE destino: 646180123456789012
    """

    event = main.core.parse_event(
        "Actualización sobre tu movimiento",
        body,
        account_id=1,
        source="lank",
    )

    assert event["kind"] == "withdrawal_detected"
    assert event["amount"] == "1250.50"
    assert event["accountNumber"] == "646180123456789012"
    assert event["clabes"] == ["646180123456789012"]


def test_classify_event_marks_internal_snowball_transfer():
    db = FakeDb(documents={
        "config/snowball": {
            "wallets": {
                "1": {"accountId": "1", "walletClabe": "646180111111111111", "active": True},
                "2": {"accountId": "2", "walletClabe": "646180123456789012", "active": True},
            },
            "connections": {
                "snowball_1_2": {
                    "id": "snowball_1_2",
                    "fromAccountId": "1",
                    "destinationType": "lank_wallet",
                    "toAccountId": "2",
                    "destinationClabe": "646180123456789012",
                    "active": True,
                }
            },
        }
    })
    event = {
        "kind": "withdrawal_completed",
        "accountId": 1,
        "amount": "500",
        "accountNumber": "646180123456789012",
        "clabes": ["646180123456789012"],
    }

    review = main.classify_event(event, {}, db=db)

    assert review["category"] == "info"
    assert review["matchStatus"] == "snowball_internal"
    assert event["movementType"] == "snowball_internal"
    assert event["destinationAccountId"] == "2"
    assert event["snowballConnectionId"] == "snowball_1_2"


def test_classify_event_marks_unknown_clabe_for_review():
    db = FakeDb(documents={
        "config/snowball": {"wallets": {}, "connections": {}},
        "config/bank-accounts": {"accounts": []},
    })
    event = {
        "kind": "withdrawal_completed",
        "accountId": 1,
        "amount": "500",
        "accountNumber": "646180999999999999",
        "clabes": ["646180999999999999"],
    }

    review = main.classify_event(event, {}, db=db)

    assert review["category"] == "review"
    assert review["matchStatus"] == "unclassified_clabe"
    assert event["movementType"] == "unclassified_clabe"


def test_build_domain_summary_separates_finance_from_membership_and_deposits_create_work():
    ok_accounts = [{
        "accountId": 17,
        "accountAlias": "Marco Fuentes",
        "access": "ok",
        "rawEmails": [
            {
                "uid": 301,
                "subject": "Retiraste tus fondos con éxito",
                "messageId": "<withdrawal-301>",
                "bodySnippet": "Monto: 500. Cuenta o numero tarjeta: 646180123456789012",
            },
            {
                "uid": 302,
                "subject": "¡Ya acreditamos tu pago!",
                "messageId": "<deposit-302>",
                "bodySnippet": "Depósito $80 exitoso",
            },
        ],
        "events": [
            {
                "uid": 301,
                "date": "Tue, 12 May 2026 22:00:00 +0000",
                "event": {
                    "kind": "withdrawal_completed",
                    "amount": "500",
                    "accountNumber": "646180123456789012",
                    "destinationClabe": "646180123456789012",
                    "movementType": "external_bank",
                    "classificationStatus": "classified",
                    "knownBankAccount": {"bank": "BBVA", "clabe": "646180123456789012"},
                },
            },
            {
                "uid": 302,
                "date": "Tue, 12 May 2026 22:01:00 +0000",
                "event": {
                    "kind": "payment_user",
                    "amount": "80",
                    "action": "registrar ingreso",
                },
            },
        ],
    }]

    domain_summary = main.build_adminbot_domain_summary(
        ok_accounts,
        finance_records=1,
        alerts_generated=0,
    )

    assert domain_summary["membership"]["eventCount"] == 0
    assert domain_summary["membership"]["message"] == "No hubo cambios de membresía/grupos en esta corrida."
    assert domain_summary["finance"]["eventCount"] == 2
    assert domain_summary["finance"]["recordsUpdated"] == 1
    assert domain_summary["finance"]["requiresAdminBotReview"] is True
    assert [item["kind"] for item in domain_summary["financeWorkItems"]] == [
        "withdrawal_completed",
        "payment_user",
    ]
    deposit_item = domain_summary["financeWorkItems"][1]
    assert deposit_item["action"] == "review_and_register_deposit"
    assert deposit_item["rawEmail"]["subject"] == "¡Ya acreditamos tu pago!"


def test_build_domain_summary_marks_finance_only_accounts_without_group_empty_language():
    ok_accounts = [{
        "accountId": 18,
        "accountAlias": "Andrés Casanova",
        "access": "ok",
        "rawEmails": [{"uid": 401, "subject": "¡Ya acreditamos tu pago!"}],
        "events": [{
            "uid": 401,
            "event": {
                "kind": "payment_user",
                "amount": "80",
            },
        }],
    }]

    domain_summary = main.build_adminbot_domain_summary(ok_accounts, finance_records=0, alerts_generated=0)

    assert domain_summary["accounts"]["18"]["domains"] == ["finance"]
    assert domain_summary["accounts"]["18"]["message"] == "Hubo movimiento financiero; no hubo cambios de membresía."
    assert "Sin grupos resolubles" not in str(domain_summary)


class FakeDocSnapshot:
    def __init__(self, data=None, exists=True, reference=None, doc_id=None):
        self._data = data or {}
        self.exists = exists
        self.reference = reference
        self.id = doc_id

    def to_dict(self):
        return dict(self._data)


class FakeDocRef:
    def __init__(self, collection, doc_id):
        self.collection = collection
        self.id = doc_id
        self.deleted = False
        self.updated = []

    def set(self, data, merge=False):
        current = self.collection.store.get(self.id, {}) if merge else {}
        current.update(data)
        self.collection.store[self.id] = current

    def update(self, data):
        current = self.collection.store.get(self.id, {})
        current.update(data)
        self.collection.store[self.id] = current
        self.updated.append(data)

    def get(self):
        if self.id in self.collection.store:
            return FakeDocSnapshot(self.collection.store[self.id], exists=True, reference=self, doc_id=self.id)
        return FakeDocSnapshot({}, exists=False, reference=self, doc_id=self.id)

    def delete(self):
        self.deleted = True
        self.collection.store.pop(self.id, None)


class FakeQuery:
    def __init__(self, collection):
        self.collection = collection

    def where(self, *args, **kwargs):
        return self

    def stream(self):
        return self.collection.stream()


class FakeCollection:
    def __init__(self, store=None):
        self.store = store or {}

    def document(self, doc_id):
        return FakeDocRef(self, doc_id)

    def where(self, *args, **kwargs):
        return FakeQuery(self)

    def stream(self):
        return [FakeDocSnapshot(data, reference=FakeDocRef(self, doc_id), doc_id=doc_id) for doc_id, data in self.store.items()]


class FakeBatch:
    def __init__(self):
        self.deleted_refs = []
        self.commit_calls = 0

    def delete(self, reference):
        self.deleted_refs.append(reference)
        reference.delete()

    def commit(self):
        self.commit_calls += 1


class FakeDb:
    def __init__(self, groups=None, pending_events=None, alerts=None, documents=None):
        self.groups = groups or {}
        self.documents = documents or {}
        self.collections = {
            "alerts": FakeCollection(alerts or {}),
            "pending-events": FakeCollection(pending_events or {}),
        }
        self.deleted_docs = []
        self.batch_instances = []

    def collection(self, name):
        return self.collections.setdefault(name, FakeCollection({}))

    def document(self, path):
        if path.startswith("groups/"):
            data = self.groups.get(path)
            return types.SimpleNamespace(get=lambda: FakeDocSnapshot(data or {}, exists=data is not None))

        db = self

        class _DocRef:
            def get(self):
                if path in db.documents:
                    return FakeDocSnapshot(db.documents[path], exists=True)
                return FakeDocSnapshot({}, exists=False)

            def set(self, data, merge=False):
                current = db.documents.get(path, {}) if merge else {}
                current.update(data)
                db.documents[path] = current

            def update(self, data):
                current = db.documents.get(path, {})
                current.update(data)
                db.documents[path] = current

            def delete(self):
                db.deleted_docs.append(path)
                db.documents.pop(path, None)

        return _DocRef()

    def batch(self):
        batch = FakeBatch()
        self.batch_instances.append(batch)
        return batch


def test_save_notifications_keeps_raw_mail_trace_without_operational_parse_fields():
    db = FakeDb()

    main.save_notifications(
        db,
        2,
        "Silva Herrera",
        [{
            "uid": 201,
            "date": "Sun, 10 May 2026 20:00:00 +0000",
            "subject": "Un usuario ha dejado tu grupo",
            "bodySnippet": "El usuario Kytzia1 ha dejado el grupo de YouTube.",
            "messageId": "<msg-201>",
        }],
        analysis_timestamp="2026-05-10T20:05:00+00:00",
    )

    item = db.documents["notifications/2"]["items"][0]
    assert item["messageId"] == "<msg-201>"
    assert item["subject"] == "Un usuario ha dejado tu grupo"
    assert item["bodySnippet"] == "El usuario Kytzia1 ha dejado el grupo de YouTube."
    assert "parsedService" not in item
    assert "parsedUserAlias" not in item
    assert "parseConfidence" not in item
    assert "parseNotes" not in item


def test_telegram_webhook_does_not_auto_register_without_explicit_flag(monkeypatch):
    db = FakeDb(documents={"config/telegram-settings": {"botToken": "telegram-token", "enabled": True}})
    sent_messages = []

    class FakeTelegramBot:
        token = "telegram-token"
        admin_chat_id = None

        def __init__(self, _db):
            self._settings = None

        def send_message(self, text, chat_id=None, parse_mode=None):
            sent_messages.append({"text": text, "chat_id": chat_id, "parse_mode": parse_mode})

    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main.lank_telegram, "TelegramBot", FakeTelegramBot)

    response = main.telegram_webhook(make_http_request(
        "POST",
        body={"message": {"chat": {"id": 123456}, "text": "/estado"}},
    ))

    assert response.status == 200
    assert "adminChatId" not in db.documents["config/telegram-settings"]
    assert sent_messages == []


def test_generate_alerts_for_accounts_creates_direct_alerts_and_external_notices(monkeypatch):
    db = FakeDb(
        groups={
            "groups/chatgpt/lank-accounts/12": {
                "users": [
                    {"userAlias": "Mario", "serviceAccountRef": "Perfil 1"},
                    {"userAlias": "Luigi", "serviceAccountRef": "Perfil 1"},
                ]
            }
        }
    )
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {
                        "kind": "user_left_self",
                        "subscription": "ChatGPT Plus",
                        "userName": "Mario",
                        "userEmail": "mario@example.com",
                    },
                    "uid": 101,
                    "messageId": "msg-101",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {
                        "service": "ChatGPT Plus",
                        "category": "pending",
                        "action": "revocar acceso",
                        "reason": "salió del grupo",
                        "dbGroupStatus": "active",
                        "matchesCurrent": [{"alias": "Mario"}],
                        "matchesStale": [],
                    },
                },
                {
                    "event": {
                        "kind": "unknown",
                        "subscription": "ChatGPT Plus",
                        "userName": "Mario",
                    },
                    "uid": 102,
                    "messageId": "msg-102",
                    "date": "2026-04-22T11:00:00+00:00",
                    "dbReview": {
                        "service": "ChatGPT Plus",
                        "category": "info",
                        "action": "revisar correo relevante",
                        "reason": "correo relevante sin acción operativa",
                        "notifyExternally": True,
                    },
                },
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}
    captured_direct_calls = []

    def fake_build_direct_alerts(**kwargs):
        captured_direct_calls.append(kwargs)
        event = kwargs["event"]
        if event["kind"] != "user_left_self":
            return []
        return [
            {
                "type": "profile_delete",
                "status": "pending",
                "priority": "high",
                "service": kwargs["review"]["service"],
                "accountId": str(event["accountId"]),
                "accountAlias": event["accountAlias"],
                "userAlias": event["userName"],
                "serviceAccountRef": kwargs["enrichment"]["serviceAccountRef"],
                "businessKey": "profile_delete|ChatGPT Plus|12|mario",
                "title": "Eliminar perfil",
                "description": "Eliminar perfil de Mario",
            }
        ]

    monkeypatch.setattr(main, "build_direct_alerts", fake_build_direct_alerts)
    monkeypatch.setattr(main, "update_group_on_leave", lambda *args, **kwargs: False)
    monkeypatch.setattr(
        main,
        "load_pool_data",
        lambda _db, _service: {
            "accounts": [
                {
                    "serviceAccountRef": "Perfil 1",
                    "email": "perfil1@example.com",
                    "status": "active",
                }
            ]
        },
    )

    alerts_generated, updated_services, external_notices, agent_findings = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"chatgpt": {"name": "ChatGPT Plus", "accessType": "credentials"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 1
    assert updated_services == {}
    assert agent_findings == []
    assert len(alerts_data["alerts"]) == 1
    saved_alert = alerts_data["alerts"][0]
    assert saved_alert["serviceAccountRef"] == "Perfil 1"
    assert saved_alert["id"].startswith("alert_")
    assert saved_alert["createdAt"] == "2026-04-22T12:00:00+00:00"
    assert db.collection("alerts").store[saved_alert["id"]]["businessKey"] == "profile_delete|ChatGPT Plus|12|mario"

    assert len(captured_direct_calls) == 2
    leave_call = captured_direct_calls[0]
    assert leave_call["event"]["accountId"] == 12
    assert leave_call["event"]["accountAlias"] == "Cuenta 12"
    assert leave_call["enrichment"]["serviceAccountRef"] == "Perfil 1"
    assert leave_call["enrichment"]["otherUsers"] == ["Luigi"]
    assert leave_call["enrichment"]["realAccountEmail"] == "perfil1@example.com"
    assert leave_call["enrichment"]["realAccountStatus"] == "active"
    assert leave_call["enrichment"]["groupStatus"] == "active"

    assert external_notices == [
        {
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "userName": "Mario",
            "subscription": "ChatGPT Plus",
            "kind": "unknown",
            "category": "info",
            "action": "revisar correo relevante",
            "reason": "correo relevante sin acción operativa",
            "date": "2026-04-22T11:00:00+00:00",
        }
    ]


def test_generate_alerts_for_accounts_skips_unmanaged_info_notices(monkeypatch):
    db = FakeDb()
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {"kind": "user_join_direct", "subscription": "Microsoft 365", "userName": "Mario"},
                    "uid": 211,
                    "messageId": "msg-211",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {
                        "service": "Microsoft 365",
                        "category": "info",
                        "action": "sin acción requerida",
                        "reason": "Microsoft 365: altas y bajas se registran como referencia",
                    },
                }
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}

    monkeypatch.setattr(main, "build_direct_alerts", lambda **kwargs: [])

    alerts_generated, _, external_notices, _ = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"microsoft365": {"name": "Microsoft 365", "accessType": "renewal_only"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 0
    assert external_notices == []


def test_generate_alerts_for_accounts_skips_routine_validation_info_notices(monkeypatch):
    db = FakeDb()
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {"kind": "group_validated", "subscription": "ChatGPT Plus"},
                    "uid": 212,
                    "messageId": "msg-212",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {
                        "service": "ChatGPT Plus",
                        "category": "info",
                        "action": "sin acción",
                        "reason": "validación sin impacto",
                        "notifyExternally": True,
                    },
                }
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}

    monkeypatch.setattr(main, "build_direct_alerts", lambda **kwargs: [])

    alerts_generated, _, external_notices, _ = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"chatgpt": {"name": "ChatGPT Plus", "accessType": "credentials"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 0
    assert external_notices == []


@pytest.mark.parametrize(
    ("event", "review", "expected"),
    [
        (
            {"kind": "unknown", "subscription": "ChatGPT Plus"},
            {"category": "info", "notifyExternally": True},
            True,
        ),
        (
            {"kind": "group_validated", "subscription": "ChatGPT Plus"},
            {"category": "info", "notifyExternally": True},
            False,
        ),
        (
            {"kind": "user_join_direct", "service": "Microsoft 365"},
            {"category": "info", "notifyExternally": True},
            False,
        ),
        (
            {"kind": "unknown", "subscription": "ChatGPT Plus"},
            {"category": "info", "notifyExternally": False},
            False,
        ),
    ],
)
def test_should_send_external_notice_applies_structured_rules(event, review, expected):
    assert main.should_send_external_notice(event, review) is expected


def test_generate_alerts_for_accounts_deduplicates_alerts_within_same_run(monkeypatch):
    db = FakeDb()
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {"kind": "user_join_direct", "subscription": "ChatGPT Plus", "userName": "Mario"},
                    "uid": 201,
                    "messageId": "msg-201",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {"service": "ChatGPT Plus", "category": "pending", "action": "dar acceso", "reason": "alta"},
                },
                {
                    "event": {"kind": "user_join_direct", "subscription": "ChatGPT Plus", "userName": "Mario"},
                    "uid": 202,
                    "messageId": "msg-202",
                    "date": "2026-04-22T10:05:00+00:00",
                    "dbReview": {"service": "ChatGPT Plus", "category": "pending", "action": "dar acceso", "reason": "duplicado"},
                },
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}

    monkeypatch.setattr(
        main,
        "build_direct_alerts",
        lambda **kwargs: [
            {
                "type": "user_needs_access",
                "status": "pending",
                "priority": "high",
                "service": "ChatGPT Plus",
                "accountId": "12",
                "accountAlias": "Cuenta 12",
                "userAlias": "Mario",
                "businessKey": "user_needs_access|ChatGPT Plus|12|mario",
                "title": "Dar acceso",
                "description": "Dar acceso a Mario",
            }
        ],
    )

    alerts_generated, _, external_notices, _ = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"chatgpt": {"name": "ChatGPT Plus", "accessType": "credentials"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 1
    assert len(alerts_data["alerts"]) == 1
    assert len(db.collection("alerts").store) == 1
    assert external_notices == []


def test_generate_alerts_for_accounts_keeps_review_alerts(monkeypatch):
    db = FakeDb()
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {"kind": "user_join_direct", "subscription": "ChatGPT Plus", "userEmail": "mario@example.com"},
                    "uid": 301,
                    "messageId": "msg-301",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {"service": "ChatGPT Plus", "category": "review", "action": "revisar acceso", "reason": "falta nombre"},
                }
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}

    monkeypatch.setattr(
        main,
        "build_direct_alerts",
        lambda **kwargs: [
            {
                "type": "user_needs_access",
                "status": "pending",
                "priority": "high",
                "service": "ChatGPT Plus",
                "accountId": "12",
                "accountAlias": "Cuenta 12",
                "userAlias": "mario@example.com",
                "businessKey": "user_needs_access|ChatGPT Plus|12|mario@example.com",
                "title": "Dar acceso",
                "description": "Revisar acceso manualmente",
            }
        ],
    )

    alerts_generated, _, external_notices, _ = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"chatgpt": {"name": "ChatGPT Plus", "accessType": "credentials"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 1
    assert len(alerts_data["alerts"]) == 1
    assert external_notices == []



def test_generate_alerts_for_accounts_updates_group_and_adds_agent_finding_without_service_account(monkeypatch):
    db = FakeDb(
        groups={
            "groups/chatgpt/lank-accounts/12": {
                "users": [
                    {"userAlias": "Mario"},
                    {"userAlias": "Luigi"},
                ]
            }
        }
    )
    ok_accounts = [
        {
            "access": "ok",
            "accountId": 12,
            "accountAlias": "Cuenta 12",
            "events": [
                {
                    "event": {"kind": "user_left_self", "subscription": "ChatGPT Plus", "userName": "Mario"},
                    "uid": 302,
                    "messageId": "msg-302",
                    "date": "2026-04-22T10:00:00+00:00",
                    "dbReview": {
                        "service": "ChatGPT Plus",
                        "category": "pending",
                        "action": "revocar acceso",
                        "reason": "salió del grupo",
                    },
                }
            ],
        }
    ]
    alerts_data = {"alerts": [], "completedAlerts": []}
    updated_calls = []

    monkeypatch.setattr(main, "build_direct_alerts", lambda **kwargs: [])
    monkeypatch.setattr(main, "load_pool_data", lambda *_args, **_kwargs: {"accounts": []})
    monkeypatch.setattr(main, "update_group_on_leave", lambda *args: updated_calls.append(args) or True)
    monkeypatch.setattr(
        main.lank_agent_review,
        "resolve_join_alert_without_real_access",
        lambda *_args, **_kwargs: [{"type": "leave_without_real_access", "severity": "medium"}],
    )

    alerts_generated, updated_services, external_notices, agent_findings = main.generate_alerts_for_accounts(
        db,
        ok_accounts,
        alerts_data,
        services_config={"chatgpt": {"name": "ChatGPT Plus", "accessType": "credentials"}},
        generated_at="2026-04-22T12:00:00+00:00",
    )

    assert alerts_generated == 0
    assert external_notices == []
    assert agent_findings == [{"type": "leave_without_real_access", "severity": "medium"}]
    assert updated_calls
    assert updated_services == {"ChatGPT Plus": {12}}


def test_generate_scheduled_manual_alerts_creates_pending_manual_reminder():
    class FakeDoc:
        def __init__(self, doc_id, data):
            self.id = doc_id
            self._data = data

        def to_dict(self):
            return dict(self._data)

    created = {}
    updated = {}

    class FakeScheduledDocRef:
        def __init__(self, doc_id):
            self.doc_id = doc_id

        def update(self, payload):
            updated[self.doc_id] = payload

    class FakeAlertsDocRef:
        def __init__(self, doc_id):
            self.doc_id = doc_id

        def set(self, payload):
            created[self.doc_id] = payload

    class FakeCollection:
        def __init__(self, name, docs):
            self.name = name
            self.docs = docs

        def where(self, field, _op, value):
            filtered = [doc for doc in self.docs if doc.to_dict().get(field) == value]
            return FakeCollection(self.name, filtered)

        def stream(self):
            return list(self.docs)

        def document(self, doc_id):
            if self.name == 'alerts':
                return FakeAlertsDocRef(doc_id)
            return FakeScheduledDocRef(doc_id)

    class FakeDbForScheduledAlerts:
        def collection(self, name):
            if name == 'scheduled-alerts':
                return FakeCollection(name, [
                    FakeDoc('sched_1', {
                        'title': 'Llamar al banco',
                        'note': 'Confirmar cargo',
                        'scheduledDate': '2026-05-01',
                        'priority': 'high',
                        'status': 'scheduled',
                    }),
                ])
            if name == 'alerts':
                return FakeCollection(name, [])
            raise AssertionError(name)

    count = lank_alerts.generate_scheduled_manual_alerts(FakeDbForScheduledAlerts(), today_key='2026-05-01')

    assert count == 1
    alert_payload = next(iter(created.values()))
    assert alert_payload['type'] == 'manual_reminder'
    assert alert_payload['status'] == 'pending'
    assert alert_payload['source'] == 'scheduled_manual_alert'
    assert alert_payload['scheduledAlertId'] == 'sched_1'
    assert updated['sched_1']['status'] == 'generated'



def test_generate_scheduled_manual_alerts_skips_existing_pending_duplicate():
    class FakeDoc:
        def __init__(self, doc_id, data):
            self.id = doc_id
            self._data = data

        def to_dict(self):
            return dict(self._data)

    created = {}
    updated = {}

    class FakeScheduledDocRef:
        def __init__(self, doc_id):
            self.doc_id = doc_id

        def update(self, payload):
            updated[self.doc_id] = payload

    class FakeAlertsDocRef:
        def __init__(self, doc_id):
            self.doc_id = doc_id

        def set(self, payload):
            created[self.doc_id] = payload

    class FakeCollection:
        def __init__(self, name, docs):
            self.name = name
            self.docs = docs

        def where(self, field, _op, value):
            filtered = [doc for doc in self.docs if doc.to_dict().get(field) == value]
            return FakeCollection(self.name, filtered)

        def stream(self):
            return list(self.docs)

        def document(self, doc_id):
            if self.name == 'alerts':
                return FakeAlertsDocRef(doc_id)
            return FakeScheduledDocRef(doc_id)

    class FakeDbForScheduledAlerts:
        def collection(self, name):
            if name == 'scheduled-alerts':
                return FakeCollection(name, [
                    FakeDoc('sched_1', {
                        'title': 'Llamar al banco',
                        'note': 'Confirmar cargo',
                        'scheduledDate': '2026-05-01',
                        'priority': 'high',
                        'status': 'scheduled',
                    }),
                ])
            if name == 'alerts':
                return FakeCollection(name, [
                    FakeDoc('alert_existing', {
                        'id': 'alert_existing',
                        'type': 'manual_reminder',
                        'status': 'pending',
                        'scheduledAlertId': 'sched_1',
                    }),
                ])
            raise AssertionError(name)

    count = lank_alerts.generate_scheduled_manual_alerts(FakeDbForScheduledAlerts(), today_key='2026-05-01')

    assert count == 0
    assert created == {}
    assert updated['sched_1']['status'] == 'generated'
    assert updated['sched_1']['generatedAlertId'] == 'alert_existing'



def test_analyze_emails_enqueues_adminbot_work_after_saving_latest_report(monkeypatch):
    db = FakeDb()
    enqueued_jobs = []

    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main, "load_service_config", lambda _db: ({}, {}, set()))
    monkeypatch.setattr(main, "load_imap_credentials", lambda _db: [
        {"accountId": 12, "email": "owner@example.com", "appPassword": "secret", "enabled": True}
    ])
    monkeypatch.setattr(main, "load_account_registry", lambda _db: [
        {"id": 12, "canonicalAlias": "Cuenta 12", "fullName": "Cuenta Principal"}
    ])
    monkeypatch.setattr(main, "load_rates", lambda _db: {})
    monkeypatch.setattr(main, "load_current_state_context", lambda _db, _name_to_key, _services_config=None: {})
    monkeypatch.setattr(main, "load_analysis_state", lambda _db: {"lastRun": None, "accounts": {}})
    monkeypatch.setattr(main, "load_system_flags", lambda _db: {})
    monkeypatch.setattr(main, "load_alerts_from_firestore", lambda _db: {"alerts": [], "completedAlerts": []})
    monkeypatch.setattr(main, "analyze_account", lambda *args, **kwargs: {
        "accountId": 12,
        "accountAlias": "Cuenta 12",
        "access": "ok",
        "summary": {
            "pending": 0,
            "relevant": 1,
            "totalEvents": 1,
            "ignored": 0,
            "review": 0,
            "rawEmailCount": 1,
        },
        "rawEmails": [{
            "uid": 101,
            "subject": "¡Ya acreditamos tu pago!",
            "messageId": "<deposit-101>",
            "bodySnippet": "Depósito $80 exitoso",
        }],
        "events": [{
            "uid": 101,
            "subject": "¡Ya acreditamos tu pago!",
            "messageId": "<deposit-101>",
            "event": {
                "kind": "payment_user",
                "amount": "80",
                "action": "registrar ingreso",
            },
            "dbReview": {"category": "ignore", "action": "ignorar"},
        }],
        "maxUid": 101,
    })
    monkeypatch.setattr(main, "save_notifications", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "generate_alerts_for_accounts", lambda *args, **kwargs: (0, {}, [], []))
    monkeypatch.setattr(main, "save_analysis_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "update_finance_from_analysis", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(main, "cleanup_old_data", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main.lank_alerts, "generate_missing_phone_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_credit_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_sim_recharge_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "load_schedule_config", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(main.lank_agent_review, "build_review_document", lambda *args, **kwargs: {"shouldNotify": False})
    monkeypatch.setattr(main.lank_agent_review, "build_notification_text", lambda *_args, **_kwargs: None)

    class FakeTelegramBot:
        is_enabled = False

        def __init__(self, _db):
            pass

    def fake_enqueue_analysis_job(_db, *, idempotency_key, payload):
        assert "analysis/latest-report" in db.documents
        enqueued_jobs.append({"idempotency_key": idempotency_key, "payload": payload})
        return {"jobId": "job_123", "status": "pending", **payload}

    monkeypatch.setattr(main.lank_telegram, "TelegramBot", FakeTelegramBot)
    monkeypatch.setattr(main.adminbot_work_queue, "enqueue_analysis_job", fake_enqueue_analysis_job)

    monkeypatch.setattr(main.auth, "verify_id_token", lambda _token: {"uid": ADMIN_UID})
    response = main.analyze_emails(make_http_request("POST", headers=ADMIN_HEADERS))

    assert response.status == 200
    assert len(enqueued_jobs) == 1
    payload = enqueued_jobs[0]["payload"]
    assert payload["type"] == "manual_analysis"
    assert payload["runSource"] == "dashboard"
    assert payload["reportRef"] == "analysis/latest-report"
    assert payload["failedAccounts"] == []
    assert payload["notificationAccountIds"] == ["12"]
    assert payload["summary"] == {
        "accountsOk": 1,
        "totalAccounts": 1,
        "totalRawEmails": 1,
        "alertsGeneratedByBackend": 0,
    }
    assert payload["financeRecordsUpdated"] == 1
    assert payload["domainSummary"]["finance"]["eventCount"] == 1
    assert payload["domainSummary"]["finance"]["recordsUpdated"] == 1
    assert payload["domainSummary"]["accounts"]["12"]["domains"] == ["finance"]
    assert payload["financeWorkItems"][0]["action"] == "review_and_register_deposit"
    assert db.documents["analysis/latest-report"]["domainSummary"]["finance"]["eventCount"] == 1


def test_analyze_emails_includes_scheduled_manual_alerts_in_backend_count(monkeypatch):
    db = FakeDb()
    enqueued_jobs = []

    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main, "load_service_config", lambda _db: ({}, {}, set()))
    monkeypatch.setattr(main, "load_imap_credentials", lambda _db: [
        {"accountId": 12, "email": "owner@example.com", "appPassword": "secret", "enabled": True}
    ])
    monkeypatch.setattr(main, "load_account_registry", lambda _db: [
        {"id": 12, "canonicalAlias": "Cuenta 12", "fullName": "Cuenta Principal"}
    ])
    monkeypatch.setattr(main, "load_rates", lambda _db: {})
    monkeypatch.setattr(main, "load_current_state_context", lambda _db, _name_to_key, _services_config=None: {})
    monkeypatch.setattr(main, "load_analysis_state", lambda _db: {"lastRun": None, "accounts": {}})
    monkeypatch.setattr(main, "load_system_flags", lambda _db: {})
    monkeypatch.setattr(main, "load_alerts_from_firestore", lambda _db: {"alerts": [], "completedAlerts": []})
    monkeypatch.setattr(main, "analyze_account", lambda *args, **kwargs: {
        "accountId": 12,
        "accountAlias": "Cuenta 12",
        "access": "ok",
        "summary": {
            "pending": 0,
            "relevant": 1,
            "totalEvents": 1,
            "ignored": 0,
            "review": 0,
            "rawEmailCount": 1,
        },
        "rawEmails": [{"uid": 101, "subject": "Alta"}],
        "events": [],
        "maxUid": 101,
    })
    monkeypatch.setattr(main, "save_notifications", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "generate_alerts_for_accounts", lambda *args, **kwargs: (0, {}, [], []))
    monkeypatch.setattr(main, "save_analysis_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "update_finance_from_analysis", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "cleanup_old_data", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main.lank_alerts, "generate_scheduled_manual_alerts", lambda *_args, **_kwargs: 2)
    monkeypatch.setattr(main.lank_alerts, "generate_missing_phone_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_credit_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_sim_recharge_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "load_schedule_config", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(main.lank_agent_review, "build_review_document", lambda *args, **kwargs: {"shouldNotify": False})
    monkeypatch.setattr(main.lank_agent_review, "build_notification_text", lambda *_args, **_kwargs: None)

    class FakeTelegramBot:
        is_enabled = False

        def __init__(self, _db):
            pass

    def fake_enqueue_analysis_job(_db, *, idempotency_key, payload):
        enqueued_jobs.append({"idempotency_key": idempotency_key, "payload": payload})
        return {"jobId": "job_123", "status": "pending", **payload}

    monkeypatch.setattr(main.lank_telegram, "TelegramBot", FakeTelegramBot)
    monkeypatch.setattr(main.adminbot_work_queue, "enqueue_analysis_job", fake_enqueue_analysis_job)

    monkeypatch.setattr(main.auth, "verify_id_token", lambda _token: {"uid": ADMIN_UID})
    response = main.analyze_emails(make_http_request("POST", headers=ADMIN_HEADERS))

    assert response.status == 200
    assert len(enqueued_jobs) == 1
    assert enqueued_jobs[0]["payload"]["summary"]["alertsGeneratedByBackend"] == 2
    assert db.documents["analysis/latest-report"]["alertsGenerated"] == 2



def test_scheduled_analysis_enqueues_adminbot_work_for_current_slot(monkeypatch):
    db = FakeDb(documents={"config/schedule": {"enabled": True, "frequencyHours": 6, "startTime": "2026-04-26T00:00:00+00:00"}})
    enqueued_jobs = []
    frozen_now = main.datetime(2026, 4, 26, 18, 5, tzinfo=main.timezone.utc)

    class FrozenDateTime(main.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_now
            return frozen_now.astimezone(tz)

    monkeypatch.setattr(main, "datetime", FrozenDateTime)
    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main, "load_analysis_state", lambda _db: {"lastRun": None, "accounts": {}})
    monkeypatch.setattr(main, "load_system_flags", lambda _db: {})
    monkeypatch.setattr(main, "load_service_config", lambda _db: ({}, {}, set()))
    monkeypatch.setattr(main, "load_imap_credentials", lambda _db: [
        {"accountId": 12, "email": "owner@example.com", "appPassword": "secret", "enabled": True}
    ])
    monkeypatch.setattr(main, "load_account_registry", lambda _db: [
        {"id": 12, "canonicalAlias": "Cuenta 12", "fullName": "Cuenta Principal"}
    ])
    monkeypatch.setattr(main, "load_rates", lambda _db: {})
    monkeypatch.setattr(main, "load_current_state_context", lambda _db, _name_to_key, _services_config=None: {})
    monkeypatch.setattr(main, "load_alerts_from_firestore", lambda _db: {"alerts": [], "completedAlerts": []})
    monkeypatch.setattr(main, "analyze_account", lambda *args, **kwargs: {
        "accountId": 12,
        "accountAlias": "Cuenta 12",
        "access": "ok",
        "summary": {
            "pending": 0,
            "relevant": 1,
            "totalEvents": 1,
            "ignored": 0,
            "review": 0,
            "rawEmailCount": 1,
        },
        "rawEmails": [{"uid": 101, "subject": "Alta"}],
        "events": [],
        "maxUid": 101,
    })
    monkeypatch.setattr(main, "save_notifications", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "generate_alerts_for_accounts", lambda *args, **kwargs: (0, {}, [], []))
    monkeypatch.setattr(main, "save_analysis_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "update_finance_from_analysis", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "cleanup_old_data", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "load_schedule_config", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(main.lank_alerts, "generate_missing_phone_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_credit_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_sim_recharge_alerts", lambda *_args, **_kwargs: 0)

    def fake_enqueue_analysis_job(_db, *, idempotency_key, payload):
        assert "analysis/latest-report" in db.documents
        enqueued_jobs.append({"idempotency_key": idempotency_key, "payload": payload})
        return {"jobId": "job_123", "status": "pending", **payload}

    monkeypatch.setattr(main.adminbot_work_queue, "enqueue_analysis_job", fake_enqueue_analysis_job)

    main.scheduled_analysis(types.SimpleNamespace())

    assert len(enqueued_jobs) == 1
    assert enqueued_jobs[0]["idempotency_key"] == "scheduled:2026-04-26T18:00:00+00:00"
    payload = enqueued_jobs[0]["payload"]
    assert payload["type"] == "scheduled_analysis"
    assert payload["runSource"] == "scheduler"
    assert payload["scheduleSlot"] == "2026-04-26T18:00:00+00:00"
    assert payload["analysisGeneratedAt"] == db.documents["analysis/latest-report"]["generatedAt"]
    assert payload["reportRef"] == "analysis/latest-report"
    assert payload["failedAccounts"] == []
    assert payload["notificationAccountIds"] == ["12"]
    assert payload["summary"] == {
        "accountsOk": 1,
        "totalAccounts": 1,
        "totalRawEmails": 1,
        "alertsGeneratedByBackend": 0,
    }
    assert payload["telegramPolicy"] == {"sendStart": True, "sendFinal": True}


def test_scheduled_analysis_includes_scheduled_manual_alerts_in_backend_count(monkeypatch):
    db = FakeDb(documents={"config/schedule": {"enabled": True, "frequencyHours": 6, "startTime": "2026-04-26T00:00:00+00:00"}})
    enqueued_jobs = []
    frozen_now = main.datetime(2026, 4, 26, 18, 5, tzinfo=main.timezone.utc)

    class FrozenDateTime(main.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_now
            return frozen_now.astimezone(tz)

    monkeypatch.setattr(main, "datetime", FrozenDateTime)
    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main, "load_analysis_state", lambda _db: {"lastRun": None, "accounts": {}})
    monkeypatch.setattr(main, "load_system_flags", lambda _db: {})
    monkeypatch.setattr(main, "load_service_config", lambda _db: ({}, {}, set()))
    monkeypatch.setattr(main, "load_imap_credentials", lambda _db: [
        {"accountId": 12, "email": "owner@example.com", "appPassword": "secret", "enabled": True}
    ])
    monkeypatch.setattr(main, "load_account_registry", lambda _db: [
        {"id": 12, "canonicalAlias": "Cuenta 12", "fullName": "Cuenta Principal"}
    ])
    monkeypatch.setattr(main, "load_rates", lambda _db: {})
    monkeypatch.setattr(main, "load_current_state_context", lambda _db, _name_to_key, _services_config=None: {})
    monkeypatch.setattr(main, "load_alerts_from_firestore", lambda _db: {"alerts": [], "completedAlerts": []})
    monkeypatch.setattr(main, "analyze_account", lambda *args, **kwargs: {
        "accountId": 12,
        "accountAlias": "Cuenta 12",
        "access": "ok",
        "summary": {
            "pending": 0,
            "relevant": 1,
            "totalEvents": 1,
            "ignored": 0,
            "review": 0,
            "rawEmailCount": 1,
        },
        "rawEmails": [{"uid": 101, "subject": "Alta"}],
        "events": [],
        "maxUid": 101,
    })
    monkeypatch.setattr(main, "save_notifications", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "generate_alerts_for_accounts", lambda *args, **kwargs: (0, {}, [], []))
    monkeypatch.setattr(main, "save_analysis_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "update_finance_from_analysis", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "cleanup_old_data", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "load_schedule_config", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(main.lank_alerts, "generate_scheduled_manual_alerts", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(main.lank_alerts, "generate_missing_phone_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_credit_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_sim_recharge_alerts", lambda *_args, **_kwargs: 0)

    def fake_enqueue_analysis_job(_db, *, idempotency_key, payload):
        enqueued_jobs.append({"idempotency_key": idempotency_key, "payload": payload})
        return {"jobId": "job_123", "status": "pending", **payload}

    monkeypatch.setattr(main.adminbot_work_queue, "enqueue_analysis_job", fake_enqueue_analysis_job)

    main.scheduled_analysis(types.SimpleNamespace())

    assert len(enqueued_jobs) == 1
    assert enqueued_jobs[0]["payload"]["summary"]["alertsGeneratedByBackend"] == 1
    assert db.documents["analysis/latest-report"]["alertsGenerated"] == 1



def test_analyze_emails_persists_adminbot_latest_state_snapshot(monkeypatch):
    db = FakeDb()

    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(main, "load_service_config", lambda _db: ({}, {}, set()))
    monkeypatch.setattr(main, "load_imap_credentials", lambda _db: [])
    monkeypatch.setattr(main, "load_account_registry", lambda _db: [])
    monkeypatch.setattr(main, "load_rates", lambda _db: {})
    monkeypatch.setattr(main, "load_current_state_context", lambda _db, _name_to_key, _services_config=None: {})
    monkeypatch.setattr(main, "load_analysis_state", lambda _db: {"accounts": {}})
    monkeypatch.setattr(main, "load_system_flags", lambda _db: {})
    monkeypatch.setattr(main, "load_alerts_from_firestore", lambda _db: {"alerts": [], "completedAlerts": []})
    monkeypatch.setattr(main, "generate_alerts_for_accounts", lambda *args, **kwargs: (0, {}, [], []))
    monkeypatch.setattr(main, "save_analysis_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "update_finance_from_analysis", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "cleanup_old_data", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main.lank_alerts, "generate_missing_phone_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_credit_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main.lank_alerts, "generate_sim_recharge_alerts", lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(main, "load_schedule_config", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(main.lank_agent_review, "build_review_document", lambda *args, **kwargs: {"shouldNotify": False})
    monkeypatch.setattr(main.lank_agent_review, "build_notification_text", lambda *_args, **_kwargs: None)

    class FakeTelegramBot:
        is_enabled = False

        def __init__(self, _db):
            pass

    monkeypatch.setattr(main.lank_telegram, "TelegramBot", FakeTelegramBot)
    monkeypatch.setattr(
        main.adminbot_work_queue,
        "enqueue_analysis_job",
        lambda _db, *, idempotency_key, payload: {"jobId": "job_abc", "status": "pending", **payload},
    )

    monkeypatch.setattr(main.auth, "verify_id_token", lambda _token: {"uid": ADMIN_UID})
    main.analyze_emails(make_http_request("POST", headers=ADMIN_HEADERS))

    latest = db.document("analysis/adminbot-latest").get().to_dict()
    assert latest["jobId"] == "job_abc"
    assert latest["status"] == "pending"
    assert latest["runSource"] == "dashboard"


def test_scheduled_analysis_active_hours_include_exact_end_boundary(monkeypatch, capsys):
    db = FakeDb(
        documents={
            "config/schedule": {
                "enabled": True,
                "frequencyHours": 2,
                "activeHours": {
                    "enabled": True,
                    "startHour": 6,
                    "endHour": 22,
                    "tzOffset": 360,
                },
            }
        }
    )
    frozen_now = main.datetime(2026, 5, 7, 4, 0, tzinfo=main.timezone.utc)  # 22:00 CST

    class FrozenDateTime(main.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_now
            return frozen_now.astimezone(tz)

    monkeypatch.setattr(main, "datetime", FrozenDateTime)
    monkeypatch.setattr(main.firestore, "client", lambda: db)

    main.scheduled_analysis(types.SimpleNamespace())

    output = capsys.readouterr().out
    assert "No startTime configured" in output
    assert "Outside active hours" not in output



def test_scheduled_analysis_skips_duplicate_slot_when_last_run_is_same_slot(monkeypatch):
    db = FakeDb(
        documents={
            "config/schedule": {
                "enabled": True,
                "frequencyHours": 2,
                "startTime": "2026-04-26T18:00:00+00:00",
            }
        }
    )
    frozen_now = main.datetime(2026, 4, 26, 18, 5, tzinfo=main.timezone.utc)

    class FrozenDateTime(main.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is None:
                return frozen_now
            return frozen_now.astimezone(tz)

    monkeypatch.setattr(main, "datetime", FrozenDateTime)
    monkeypatch.setattr(main.firestore, "client", lambda: db)
    monkeypatch.setattr(
        main,
        "load_analysis_state",
        lambda _db: {"accounts": {}, "lastRun": "2026-04-26T18:00:00+00:00"},
    )

    result = main.scheduled_analysis(types.SimpleNamespace())

    assert result is None
    assert db.collection("adminbot-work").store == {}


# ── generate_credit_cutoff_statements ──


def test_generate_credit_cutoff_statements_creates_snapshot_on_cutoff_day(monkeypatch):
    from datetime import timedelta, timezone as tz

    mexico_tz = tz(timedelta(hours=-6))
    frozen = lank_alerts.datetime(2026, 5, 15, 10, 0, tzinfo=mexico_tz)

    class FrozenDT(lank_alerts.datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz is None else frozen.astimezone(tz)

    monkeypatch.setattr(lank_alerts, "datetime", FrozenDT)

    db = FakeDb()
    db.collections["banks"] = FakeCollection({
        "bank-klar": {
            "name": "Klar",
            "creditAccount": {
                "cutoffDay": 15,
                "currentBalance": 5000,
                "creditLimit": 20000,
                "monthlyStatements": [],
            },
        },
    })

    result = lank_alerts.generate_credit_cutoff_statements(db)

    assert result == 1
    updated = db.collections["banks"].store["bank-klar"]
    stmts = updated.get("creditAccount.monthlyStatements")
    assert stmts is not None
    assert len(stmts) == 1
    assert stmts[0]["monthKey"] == "2026-05"
    assert stmts[0]["closingBalance"] == 5000
    assert stmts[0]["creditLimit"] == 20000
    assert stmts[0]["cutoffDay"] == 15


def test_generate_credit_cutoff_statements_deduplicates(monkeypatch):
    from datetime import timedelta, timezone as tz

    mexico_tz = tz(timedelta(hours=-6))
    frozen = lank_alerts.datetime(2026, 5, 15, 10, 0, tzinfo=mexico_tz)

    class FrozenDT(lank_alerts.datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz is None else frozen.astimezone(tz)

    monkeypatch.setattr(lank_alerts, "datetime", FrozenDT)

    db = FakeDb()
    db.collections["banks"] = FakeCollection({
        "bank-klar": {
            "name": "Klar",
            "creditAccount": {
                "cutoffDay": 15,
                "currentBalance": 5000,
                "creditLimit": 20000,
                "monthlyStatements": [{"monthKey": "2026-05", "closingBalance": 4500}],
            },
        },
    })

    result = lank_alerts.generate_credit_cutoff_statements(db)

    assert result == 0


def test_generate_credit_cutoff_statements_skips_non_cutoff_day(monkeypatch):
    from datetime import timedelta, timezone as tz

    mexico_tz = tz(timedelta(hours=-6))
    frozen = lank_alerts.datetime(2026, 5, 10, 10, 0, tzinfo=mexico_tz)

    class FrozenDT(lank_alerts.datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen if tz is None else frozen.astimezone(tz)

    monkeypatch.setattr(lank_alerts, "datetime", FrozenDT)

    db = FakeDb()
    db.collections["banks"] = FakeCollection({
        "bank-klar": {
            "name": "Klar",
            "creditAccount": {
                "cutoffDay": 15,
                "currentBalance": 5000,
                "creditLimit": 20000,
                "monthlyStatements": [],
            },
        },
    })

    result = lank_alerts.generate_credit_cutoff_statements(db)

    assert result == 0
