import sys
from pathlib import Path


FUNCTIONS_DIR = Path(__file__).resolve().parents[1]
if str(FUNCTIONS_DIR) not in sys.path:
    sys.path.insert(0, str(FUNCTIONS_DIR))


from adminbot_work_queue import (
    WORK_COLLECTION,
    _job_id_from_key,
    enqueue_analysis_job,
    mark_job_claimed,
    mark_job_completed,
)


class FakeDocumentSnapshot:
    def __init__(self, data=None, exists=False):
        self._data = data or {}
        self.exists = exists

    def to_dict(self):
        return dict(self._data)


class FakeDocumentReference:
    def __init__(self, collection, doc_id):
        self._collection = collection
        self.id = doc_id

    def get(self):
        if self.id not in self._collection.documents:
            return FakeDocumentSnapshot(exists=False)
        return FakeDocumentSnapshot(self._collection.documents[self.id], exists=True)

    def set(self, data):
        self._collection.documents[self.id] = dict(data)


class FakeCollectionReference:
    def __init__(self, documents=None):
        self.documents = dict(documents or {})

    def document(self, doc_id):
        return FakeDocumentReference(self, doc_id)


class FakeDb:
    def __init__(self, collections=None):
        self._collections = {
            name: FakeCollectionReference(documents)
            for name, documents in (collections or {}).items()
        }

    def collection(self, name):
        if name not in self._collections:
            self._collections[name] = FakeCollectionReference()
        return self._collections[name]

    def document(self, path):
        parts = path.split("/", 1)
        return self.collection(parts[0]).document(parts[1])


def test_enqueue_analysis_job_reuses_same_job_for_same_idempotency_key():
    idempotency_key = "analysis:user-123:2026-04-26"
    existing_job = {
        "idempotencyKey": idempotency_key,
        "status": "pending",
        "createdAt": "2026-04-26T00:00:00+00:00",
        "kind": "analysis",
        "accountId": "user-123",
    }
    db = FakeDb(
        collections={
            WORK_COLLECTION: {
                "job_4a3a8dfab729": existing_job,
            }
        }
    )

    result = enqueue_analysis_job(
        db,
        idempotency_key=idempotency_key,
        payload={"kind": "analysis", "accountId": "user-123"},
    )

    assert result == {
        "jobId": "job_4a3a8dfab729",
        **existing_job,
    }
    assert db.collection(WORK_COLLECTION).documents == {
        "job_4a3a8dfab729": existing_job,
    }


def test_enqueue_analysis_job_creates_new_pending_job_with_deterministic_job_id(monkeypatch):
    idempotency_key = "analysis:user-456:2026-04-26"
    created_at = "2026-04-26T12:34:56+00:00"
    db = FakeDb()

    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: created_at)

    result = enqueue_analysis_job(
        db,
        idempotency_key=idempotency_key,
        payload={"kind": "analysis", "accountId": "user-456"},
    )

    expected_job = {
        "idempotencyKey": idempotency_key,
        "status": "pending",
        "createdAt": created_at,
        "kind": "analysis",
        "accountId": "user-456",
    }

    job_id = _job_id_from_key(idempotency_key)

    assert result == {
        "jobId": job_id,
        **expected_job,
    }
    assert db.collection(WORK_COLLECTION).documents == {
        job_id: expected_job,
    }


def test_enqueue_analysis_job_ignores_reserved_payload_fields(monkeypatch):
    idempotency_key = "analysis:user-789:2026-04-26"
    created_at = "2026-04-26T23:59:59+00:00"
    db = FakeDb()

    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: created_at)

    result = enqueue_analysis_job(
        db,
        idempotency_key=idempotency_key,
        payload={
            "kind": "analysis",
            "status": "completed",
            "createdAt": "1999-01-01T00:00:00+00:00",
            "idempotencyKey": "forged-key",
        },
    )

    assert result == {
        "jobId": _job_id_from_key(idempotency_key),
        "idempotencyKey": idempotency_key,
        "status": "pending",
        "createdAt": created_at,
        "kind": "analysis",
    }


def test_mark_job_claimed_and_completed_updates_status_fields(monkeypatch):
    job_id = "job_claim_flow"
    created_at = "2026-04-26T00:00:00+00:00"
    claimed_at = "2026-04-26T01:00:00+00:00"
    completed_at = "2026-04-26T02:00:00+00:00"
    result_summary = {"ok": True, "processed": 3}
    db = FakeDb(
        collections={
            WORK_COLLECTION: {
                job_id: {
                    "idempotencyKey": "analysis:user-999:2026-04-26",
                    "status": "pending",
                    "createdAt": created_at,
                    "kind": "analysis",
                }
            }
        }
    )

    timestamps = iter([claimed_at, completed_at])
    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: next(timestamps))

    claimed = mark_job_claimed(db, job_id=job_id, claimer="adminbot")
    completed = mark_job_completed(db, job_id=job_id, result_summary=result_summary)

    assert claimed == {
        "jobId": job_id,
        "idempotencyKey": "analysis:user-999:2026-04-26",
        "status": "claimed",
        "createdAt": created_at,
        "kind": "analysis",
        "claimedAt": claimed_at,
        "claimedBy": "adminbot",
    }
    assert completed == {
        "jobId": job_id,
        "idempotencyKey": "analysis:user-999:2026-04-26",
        "status": "completed",
        "createdAt": created_at,
        "kind": "analysis",
        "claimedAt": claimed_at,
        "claimedBy": "adminbot",
        "completedAt": completed_at,
        "resultSummary": result_summary,
    }
    assert db.collection(WORK_COLLECTION).documents[job_id] == {
        "idempotencyKey": "analysis:user-999:2026-04-26",
        "status": "completed",
        "createdAt": created_at,
        "kind": "analysis",
        "claimedAt": claimed_at,
        "claimedBy": "adminbot",
        "completedAt": completed_at,
        "resultSummary": result_summary,
    }


def test_mark_job_claimed_raises_for_missing_job():
    db = FakeDb()

    try:
        mark_job_claimed(db, job_id="job_missing", claimer="adminbot")
        assert False, "Expected ValueError for missing job"
    except ValueError as exc:
        assert str(exc) == "Job not found: job_missing"


def test_mark_job_completed_raises_for_missing_job():
    db = FakeDb()

    try:
        mark_job_completed(db, job_id="job_missing", result_summary={"ok": False})
        assert False, "Expected ValueError for missing job"
    except ValueError as exc:
        assert str(exc) == "Job not found: job_missing"


def test_mark_job_completed_requires_claimed_status(monkeypatch):
    job_id = "job_pending"
    db = FakeDb(
        collections={
            WORK_COLLECTION: {
                job_id: {
                    "idempotencyKey": "analysis:user-123:2026-04-26",
                    "status": "pending",
                    "createdAt": "2026-04-26T00:00:00+00:00",
                    "kind": "analysis",
                }
            }
        }
    )

    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: "2026-04-26T02:00:00+00:00")

    try:
        mark_job_completed(db, job_id=job_id, result_summary={"ok": True})
        assert False, "Expected ValueError for invalid completion transition"
    except ValueError as exc:
        assert str(exc) == "Invalid job status transition for job_pending: expected claimed, got pending"

    assert db.collection(WORK_COLLECTION).documents[job_id]["status"] == "pending"
    assert "completedAt" not in db.collection(WORK_COLLECTION).documents[job_id]


def test_mark_job_claimed_rejects_double_claim(monkeypatch):
    job_id = "job_already_claimed"
    existing_job = {
        "idempotencyKey": "analysis:user-321:2026-04-26",
        "status": "claimed",
        "createdAt": "2026-04-26T00:00:00+00:00",
        "kind": "analysis",
        "claimedAt": "2026-04-26T01:00:00+00:00",
        "claimedBy": "adminbot-a",
    }
    db = FakeDb(collections={WORK_COLLECTION: {job_id: existing_job}})

    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: "2026-04-26T03:00:00+00:00")

    try:
        mark_job_claimed(db, job_id=job_id, claimer="adminbot-b")
        assert False, "Expected ValueError for invalid claim transition"
    except ValueError as exc:
        assert str(exc) == "Invalid job status transition for job_already_claimed: expected pending, got claimed"

    assert db.collection(WORK_COLLECTION).documents[job_id] == existing_job


def test_mark_job_claimed_rejects_terminal_job(monkeypatch):
    job_id = "job_completed"
    existing_job = {
        "idempotencyKey": "analysis:user-654:2026-04-26",
        "status": "completed",
        "createdAt": "2026-04-26T00:00:00+00:00",
        "kind": "analysis",
        "claimedAt": "2026-04-26T01:00:00+00:00",
        "claimedBy": "adminbot",
        "completedAt": "2026-04-26T02:00:00+00:00",
        "resultSummary": {"ok": True},
    }
    db = FakeDb(collections={WORK_COLLECTION: {job_id: existing_job}})

    monkeypatch.setattr("adminbot_work_queue._now_iso", lambda: "2026-04-26T03:00:00+00:00")

    try:
        mark_job_claimed(db, job_id=job_id, claimer="adminbot-b")
        assert False, "Expected ValueError for invalid claim transition"
    except ValueError as exc:
        assert str(exc) == "Invalid job status transition for job_completed: expected pending, got completed"

    assert db.collection(WORK_COLLECTION).documents[job_id] == existing_job
