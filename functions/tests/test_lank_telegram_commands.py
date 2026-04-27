import sys
import types
from pathlib import Path


FUNCTIONS_DIR = Path(__file__).resolve().parents[1]
if str(FUNCTIONS_DIR) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS_DIR))


sys.modules.setdefault("lank_audit", types.ModuleType("lank_audit"))

import lank_telegram


class FakeDocSnapshot:
    def __init__(self, data=None, exists=True):
        self._data = data or {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class FakeQuery:
    def __init__(self, docs):
        self._docs = list(docs)

    def stream(self):
        return list(self._docs)


class FakeCollection:
    def __init__(self, docs=None):
        self._docs = docs or []

    def where(self, field, op, value):
        assert op == "=="
        filtered = [doc for doc in self._docs if doc.to_dict().get(field) == value]
        return FakeQuery(filtered)

    def stream(self):
        return list(self._docs)


class FakeCollectionDoc:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return dict(self._data)


class FakeDocumentRef:
    def __init__(self, data=None, exists=True):
        self._data = data or {}
        self._exists = exists

    def get(self):
        return FakeDocSnapshot(self._data, exists=self._exists)


class FakeDb:
    def __init__(self, documents=None, collections=None):
        self.documents = documents or {}
        self.collections = collections or {}

    def document(self, path):
        if path in self.documents:
            return FakeDocumentRef(self.documents[path], exists=True)
        return FakeDocumentRef({}, exists=False)

    def collection(self, name):
        return FakeCollection(self.collections.get(name, []))


def make_bot(*, alerts=None, latest_report=None, account_registry=None, groups=None, actionable_events=None):
    documents = {
        "config/telegram-settings": {"botToken": "token", "adminChatId": "123", "enabled": True},
        "analysis/latest-report": latest_report or {"generatedAt": "2026-04-22T12:00:00+00:00", "accountsOk": 2, "totalAccounts": 2},
        "config/account-registry": account_registry or {"accounts": [{"id": 12}, {"id": 13}]},
    }
    if actionable_events is not None:
        documents["analysis/actionable-events"] = {"events": actionable_events}

    collections = {
        "alerts": alerts or [],
        "groups": groups or [FakeCollectionDoc("chatgpt", {"serviceName": "ChatGPT Plus"})],
    }
    return lank_telegram.TelegramBot(FakeDb(documents=documents, collections=collections))


def test_cmd_estado_counts_only_pending_firestore_alerts():
    bot = make_bot(
        alerts=[
            FakeCollectionDoc("a1", {"status": "pending", "title": "Pendiente 1"}),
            FakeCollectionDoc("a2", {"status": "pending", "title": "Pendiente 2"}),
            FakeCollectionDoc("a3", {"status": "resolved", "title": "Resuelta"}),
        ],
        actionable_events=[
            {"userName": "Mario", "accountId": 12, "subscription": "ChatGPT Plus"},
            {"userName": "Luigi", "accountId": 13, "subscription": "ChatGPT Plus"},
        ],
    )

    response = bot._cmd_estado()

    assert "Alertas pendientes: 2" in response


def test_cmd_alertas_lists_only_pending_firestore_alerts():
    bot = make_bot(
        alerts=[
            FakeCollectionDoc(
                "a1",
                {
                    "status": "pending",
                    "title": "Eliminar perfil",
                    "type": "profile_delete",
                    "priority": "high",
                    "service": "ChatGPT Plus",
                    "accountId": 12,
                    "userAlias": "Mario",
                },
            ),
            FakeCollectionDoc(
                "a2",
                {
                    "status": "resolved",
                    "title": "Resuelta",
                    "type": "profile_delete",
                    "priority": "low",
                    "service": "ChatGPT Plus",
                    "accountId": 13,
                    "userAlias": "Luigi",
                },
            ),
        ],
        actionable_events=[
            {"userName": "Peach", "accountId": 14, "subscription": "ChatGPT Plus", "action": "legacy event"},
        ],
    )

    response = bot._cmd_alertas()

    assert "1 alerta(s) pendiente(s)" in response
    assert "Eliminar perfil" in response
    assert "legacy event" not in response
    assert "Peach" not in response


def test_cmd_alertas_returns_empty_when_only_legacy_events_exist():
    bot = make_bot(
        alerts=[
            FakeCollectionDoc(
                "a1",
                {
                    "status": "resolved",
                    "title": "Resuelta",
                    "service": "ChatGPT Plus",
                    "accountId": 13,
                    "userAlias": "Luigi",
                },
            )
        ],
        actionable_events=[
            {"userName": "Peach", "accountId": 14, "subscription": "ChatGPT Plus", "action": "legacy event"},
        ],
    )

    response = bot._cmd_alertas()

    assert response == "✅ No hay alertas pendientes."


def test_cmd_analizar_returns_hermes_handoff_message():
    bot = make_bot()
    response = bot._cmd_analizar()

    assert 'AdminBot' in response
    assert 'Hermes' in response
    assert '@lankadminbot' in response
    assert 'dashboard' in response
