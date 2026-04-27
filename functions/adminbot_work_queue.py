from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Mapping, Protocol, cast


class JobSnapshot(Protocol):
    exists: bool

    def to_dict(self) -> dict[str, object]: ...


class JobDocumentReference(Protocol):
    def get(self) -> JobSnapshot: ...

    def set(self, data: Mapping[str, object]) -> None: ...


class JobCollectionReference(Protocol):
    def document(self, doc_id: str) -> JobDocumentReference: ...


class JobDb(Protocol):
    def collection(self, name: str) -> JobCollectionReference: ...

    def document(self, path: str) -> JobDocumentReference: ...


WORK_COLLECTION = "adminbot-work"
RESERVED_JOB_FIELDS = frozenset({"idempotencyKey", "status", "createdAt"})


_ALLOWED_STATUS_TRANSITIONS = {
    "pending": "claimed",
    "claimed": "completed",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_id_from_key(idempotency_key: str) -> str:
    digest = hashlib.sha1(idempotency_key.encode("utf-8")).hexdigest()[:12]
    return f"job_{digest}"


def _load_job_document(
    db: JobDb, job_id: str
) -> tuple[JobDocumentReference, dict[str, object]]:
    job_ref = db.collection(WORK_COLLECTION).document(job_id)
    snapshot = job_ref.get()

    if not snapshot.exists:
        raise ValueError(f"Job not found: {job_id}")

    return job_ref, cast(dict[str, object], snapshot.to_dict())


def _require_job_status_transition(
    current: Mapping[str, object], *, job_id: str, expected_status: str
) -> None:
    current_status = current.get("status")
    if current_status != expected_status:
        raise ValueError(
            f"Invalid job status transition for {job_id}: expected {expected_status}, got {current_status}"
        )


def enqueue_analysis_job(
    db: JobDb, *, idempotency_key: str, payload: Mapping[str, object]
) -> dict[str, object]:
    job_id = _job_id_from_key(idempotency_key)
    job_ref = db.collection(WORK_COLLECTION).document(job_id)
    snapshot = job_ref.get()

    if snapshot.exists:
        return {
            "jobId": job_id,
            **snapshot.to_dict(),
        }

    public_payload = {
        key: value for key, value in payload.items() if key not in RESERVED_JOB_FIELDS
    }
    document = {
        **public_payload,
        "idempotencyKey": idempotency_key,
        "status": "pending",
        "createdAt": _now_iso(),
    }
    job_ref.set(document)
    return {
        "jobId": job_id,
        **document,
    }


def mark_job_claimed(db: JobDb, *, job_id: str, claimer: str) -> dict[str, object]:
    job_ref, current = _load_job_document(db, job_id)
    _require_job_status_transition(current, job_id=job_id, expected_status="pending")
    document = {
        **current,
        "status": _ALLOWED_STATUS_TRANSITIONS["pending"],
        "claimedAt": _now_iso(),
        "claimedBy": claimer,
    }
    job_ref.set(document)
    return {
        "jobId": job_id,
        **document,
    }


def mark_job_completed(
    db: JobDb, *, job_id: str, result_summary: dict[str, object]
) -> dict[str, object]:
    job_ref, current = _load_job_document(db, job_id)
    _require_job_status_transition(current, job_id=job_id, expected_status="claimed")
    document = {
        **current,
        "status": _ALLOWED_STATUS_TRANSITIONS["claimed"],
        "completedAt": _now_iso(),
        "resultSummary": result_summary,
    }
    job_ref.set(document)
    return {
        "jobId": job_id,
        **document,
    }


def write_latest_adminbot_state(
    db: JobDb,
    *,
    job_id: str,
    status: str,
    run_source: str,
    analysis_generated_at: str,
    schedule_slot: str | None = None,
) -> None:
    db.document("analysis/adminbot-latest").set(
        {
            "jobId": job_id,
            "status": status,
            "runSource": run_source,
            "analysisGeneratedAt": analysis_generated_at,
            "scheduleSlot": schedule_slot,
            "updatedAt": _now_iso(),
        }
    )
