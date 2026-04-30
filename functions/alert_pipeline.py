from __future__ import annotations

from copy import deepcopy
from typing import Any

from lank_alerts import (
    generate_group_deactivated_alert,
    generate_user_joined_alert,
    generate_user_left_alerts,
)

JOIN_EVENT_KINDS = {"user_join_direct", "user_join_transferred", "user_joined"}
LEAVE_EVENT_KINDS = {"user_left_self", "user_left_transferred", "user_left"}
NON_DETERMINISTIC_ALERT_FIELDS = {"id", "createdAt"}
USER_LEFT_BATCH_DEDUPE_TYPES = {"profile_delete", "user_left_expired"}


def _trace_fields(event: dict[str, Any], notification_doc_id: str, generated_at: str) -> dict[str, Any]:
    return {
        "notificationDocId": notification_doc_id,
        "messageId": event.get("messageId"),
        "emailUid": event.get("uid"),
        "analysisGeneratedAt": generated_at,
    }


def _normalize_user_alias(value: Any) -> str:
    return str(value or "").strip().lower()


def alert_business_key(alert: dict[str, Any]) -> str:
    return "|".join(
        [
            str(alert.get("type") or ""),
            str(alert.get("service") or ""),
            str(alert.get("accountId") or ""),
            _normalize_user_alias(alert.get("userAlias")),
        ]
    )


def _existing_business_keys(existing_alerts: list[dict[str, Any]]) -> set[str]:
    business_keys: set[str] = set()
    for alert in existing_alerts:
        if alert.get("status") != "pending":
            continue
        business_keys.add(alert_business_key(alert))
        if alert.get("businessKey"):
            business_keys.add(str(alert["businessKey"]))
    return business_keys


def _required_fields_present(
    event_kind: str | None,
    event: dict[str, Any],
    service: str | None,
    account_id: str,
    enrichment: dict[str, Any] | None,
) -> bool:
    if not event_kind or not service or not account_id:
        return False
    if event_kind in LEAVE_EVENT_KINDS:
        return bool(event.get("userName")) and bool((enrichment or {}).get("serviceAccountRef"))
    if event_kind in JOIN_EVENT_KINDS:
        return bool(event.get("userName") or event.get("userEmail"))
    if event_kind == "group_deactivated":
        return True
    return False


def _build_candidates(
    event: dict[str, Any],
    event_kind: str,
    service: str,
    account_id: str,
    account_alias: str | None,
    trace_fields: dict[str, Any],
    enrichment: dict[str, Any] | None,
    services_config: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    traced_event = {
        **deepcopy(event),
        **trace_fields,
    }

    if event_kind in LEAVE_EVENT_KINDS:
        return generate_user_left_alerts(
            traced_event,
            service,
            account_id,
            account_alias,
            service_account_ref=(enrichment or {}).get("serviceAccountRef"),
            other_users=(enrichment or {}).get("otherUsers"),
            real_account_email=(enrichment or {}).get("realAccountEmail"),
            services_config=services_config,
        )
    if event_kind in JOIN_EVENT_KINDS:
        return [generate_user_joined_alert(traced_event, service, account_id, account_alias)]
    if event_kind == "group_deactivated":
        return [generate_group_deactivated_alert(traced_event, service, account_id, account_alias)]
    return []


def _attach_metadata(candidate: dict[str, Any], trace_fields: dict[str, Any]) -> dict[str, Any]:
    alert = {
        key: value
        for key, value in candidate.items()
        if key not in NON_DETERMINISTIC_ALERT_FIELDS
    }
    return {
        **alert,
        **trace_fields,
        "businessKey": alert_business_key(alert),
    }


def _should_skip_user_left_batch(
    alerts: list[dict[str, Any]],
    pending_business_keys: set[str],
) -> bool:
    for alert in alerts:
        if alert.get("type") not in USER_LEFT_BATCH_DEDUPE_TYPES:
            continue
        if alert["businessKey"] in pending_business_keys:
            return True
    return False


def build_direct_alerts(
    *,
    event: dict[str, Any],
    review: dict[str, Any],
    notification_doc_id: str,
    generated_at: str,
    existing_alerts: list[dict[str, Any]],
    enrichment: dict[str, Any] | None = None,
    services_config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if review.get("category") not in {"pending", "review"}:
        return []

    service = event.get("subscription") or event.get("service")
    account_id = str(event.get("accountId") or "")
    account_alias = event.get("accountAlias")
    event_kind = event.get("kind")

    if not _required_fields_present(event_kind, event, service, account_id, enrichment):
        return []

    trace_fields = _trace_fields(event, notification_doc_id, generated_at)
    generated_alerts = _build_candidates(
        event,
        event_kind,
        service,
        account_id,
        account_alias,
        trace_fields,
        enrichment,
        services_config,
    )

    pending_business_keys = _existing_business_keys(existing_alerts)
    traced_alerts = [_attach_metadata(candidate, trace_fields) for candidate in generated_alerts]

    if event_kind in LEAVE_EVENT_KINDS and _should_skip_user_left_batch(traced_alerts, pending_business_keys):
        return []

    direct_alerts: list[dict[str, Any]] = []
    for traced_alert in traced_alerts:
        if traced_alert["businessKey"] in pending_business_keys:
            continue
        direct_alerts.append(traced_alert)
        pending_business_keys.add(traced_alert["businessKey"])

    return direct_alerts
