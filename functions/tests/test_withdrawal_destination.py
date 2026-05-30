import sys
import types
from pathlib import Path


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

import main


class FakeDocSnapshot:
    def __init__(self, data=None, *, exists=True):
        self._data = data or {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class FakeDb:
    def __init__(self, documents=None):
        self.documents = documents or {}

    def document(self, path):
        db = self

        class _DocRef:
            def get(self):
                if path in db.documents:
                    return FakeDocSnapshot(db.documents[path], exists=True)
                return FakeDocSnapshot({}, exists=False)

        return _DocRef()


def test_snowball_wallet_clabe_wins_over_stp_bank_label_and_external_bank_identity():
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "bank": "STP",
        "accountNumber": "646180333333333333",
        "clabes": ["646180333333333333"],
        "destinationBankId": "stp",
    }
    snowball_config = {
        "wallets": {
            "3": {"accountId": "3", "walletClabe": "646180333333333333", "active": True},
        },
        "connections": {
            "snowball_4_3": {
                "id": "snowball_4_3",
                "fromAccountId": "4",
                "destinationType": "lank_wallet",
                "toAccountId": "3",
                "destinationClabe": "646180333333333333",
                "active": True,
            }
        },
    }
    known_banks = [
        {"id": "stp_generic", "bankId": "stp", "bank": "STP", "clabe": "646180333333333333"},
    ]

    result = main.resolve_withdrawal_destination(
        event,
        snowball_config=snowball_config,
        known_banks=known_banks,
    )

    assert result["movementType"] == "snowball_internal"
    assert event["movementType"] == "snowball_internal"
    assert event["destinationAccountId"] == "3"
    assert result["destinationAccountId"] == "3"
    assert event["snowballConnectionId"] == "snowball_4_3"
    assert "destinationBankId" not in event
    assert "destinationBankId" not in result
    assert "knownBankAccount" not in event


def test_known_external_bank_clabe_sets_registered_destination_bank_id():
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "bank": "BBVA",
        "accountNumber": "012345678901234567",
        "clabes": ["012345678901234567"],
    }
    known_banks = [
        {"id": "bank-account-1", "bankId": "bbva_demo", "bank": "BBVA", "clabe": "012345678901234567"},
    ]

    result = main.resolve_withdrawal_destination(
        event,
        snowball_config={"wallets": {}, "connections": {}},
        known_banks=known_banks,
    )

    assert result["movementType"] == "external_bank"
    assert event["movementType"] == "external_bank"
    assert event["destinationBankId"] == "bbva_demo"
    assert result["destinationBankId"] == "bbva_demo"
    assert event["knownBankAccount"]["bankId"] == "bbva_demo"
    assert "destinationAccountId" not in event


def test_unknown_clabe_remains_pending_review_without_creating_bank_identity():
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "bank": "STP",
        "accountNumber": "646180999999999999",
        "clabes": ["646180999999999999"],
    }

    result = main.resolve_withdrawal_destination(
        event,
        snowball_config={"wallets": {}, "connections": {}},
        known_banks=[],
    )

    assert result == {"movementType": "unclassified_clabe", "classificationStatus": "pending_review"}
    assert event["movementType"] == "unclassified_clabe"
    assert event["classificationStatus"] == "pending_review"
    assert event["destinationClabe"] == "646180999999999999"
    assert "destinationBankId" not in event
    assert "knownBankAccount" not in event


def test_without_clabe_legacy_short_account_number_is_explicit_low_confidence_external_destination():
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "bank": "BBVA",
        "accountNumber": "1234567890",
        "clabes": [],
    }

    result = main.resolve_withdrawal_destination(
        event,
        snowball_config={"wallets": {}, "connections": {}},
        known_banks=[{"bankId": "bbva", "bank": "BBVA", "accountNumber": "1234567890"}],
    )

    assert result["movementType"] == "external_bank"
    assert result["classificationStatus"] == "legacy_account_number"
    assert event["movementType"] == "external_bank"
    assert event["classificationStatus"] == "legacy_account_number"
    assert "destinationClabe" not in event
    assert "destinationBankId" not in event


def test_multiple_distinct_clabe_candidates_are_not_guessed_even_if_one_matches():
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "bank": "STP",
        "accountNumber": "646180333333333333",
        "clabes": ["646180333333333333", "646180999999999999"],
    }
    snowball_config = {
        "wallets": {
            "3": {"accountId": "3", "walletClabe": "646180333333333333", "active": True},
        },
        "connections": {},
    }

    result = main.resolve_withdrawal_destination(
        event,
        snowball_config=snowball_config,
        known_banks=[],
    )

    assert result["movementType"] == "unclassified_clabe"
    assert result["classificationStatus"] == "pending_review"
    assert result["classificationReason"] == "ambiguous_clabe_candidates"
    assert event["clabeCandidates"] == ["646180333333333333", "646180999999999999"]
    assert event["classificationReason"] == "ambiguous_clabe_candidates"
    assert "destinationAccountId" not in event
    assert "destinationBankId" not in event


def test_concrete_withdrawal_from_account_4_account_4_demo_to_account_3_demo_stp_snowball_is_internal_transfer():
    db = FakeDb(documents={
        "config/snowball": {
            "wallets": {
                "3": {
                    "accountId": "3",
                    "accountAlias": "Cuenta Demo 3",
                    "walletClabe": "646180333333333333",
                    "active": True,
                },
                "4": {
                    "accountId": "4",
                    "accountAlias": "Cuenta Demo 4",
                    "walletClabe": "646180444444444444",
                    "active": True,
                },
            },
            "connections": {
                "snowball_4_3": {
                    "id": "snowball_4_3",
                    "fromAccountId": "4",
                    "fromAccountAlias": "Cuenta Demo 4",
                    "destinationType": "lank_wallet",
                    "toAccountId": "3",
                    "toAccountAlias": "Cuenta Demo 3",
                    "destinationClabe": "646180333333333333",
                    "active": True,
                }
            },
        },
        "config/bank-accounts": {
            "accounts": [
                {"id": "stp", "bankId": "stp", "bank": "STP", "clabe": "646180333333333333"},
            ]
        },
    })
    event = {
        "kind": "withdrawal_completed",
        "accountId": "4",
        "accountAlias": "Cuenta Demo 4",
        "amount": "1500",
        "bank": "STP",
        "accountNumber": "646180333333333333",
        "clabes": ["646180333333333333"],
    }

    review = main.classify_event(event, {}, db=db)

    assert review["category"] == "info"
    assert review["matchStatus"] == "snowball_internal"
    assert "transferencia interna Snowball" in review["action"]
    assert event["movementType"] == "snowball_internal"
    assert event["destinationAccountId"] == "3"
    assert event["snowballConnectionId"] == "snowball_4_3"
    assert "destinationBankId" not in event
