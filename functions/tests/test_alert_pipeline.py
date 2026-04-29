import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from alert_pipeline import build_direct_alerts


GENERATED_AT = "2026-04-21T12:05:00+00:00"


def test_build_direct_alerts_attaches_notification_trace_and_business_key():
    event = {
        "kind": "user_join_direct",
        "subscription": "ChatGPT Plus",
        "accountId": "12",
        "accountAlias": "Cuenta 12",
        "userName": "Mario",
        "messageId": "<msg-1>",
        "uid": "901",
        "date": "2026-04-21T12:00:00+00:00",
    }
    review = {"category": "pending"}

    alerts = build_direct_alerts(
        event=event,
        review=review,
        notification_doc_id="notif_12",
        generated_at=GENERATED_AT,
        existing_alerts=[],
    )

    assert len(alerts) == 1
    assert alerts[0]["notificationDocId"] == "notif_12"
    assert alerts[0]["messageId"] == "<msg-1>"
    assert alerts[0]["emailUid"] == "901"
    assert alerts[0]["analysisGeneratedAt"] == GENERATED_AT
    assert alerts[0]["businessKey"] == "user_needs_access|ChatGPT Plus|12|mario"
    assert "id" not in alerts[0]
    assert "createdAt" not in alerts[0]









def test_build_direct_alerts_creates_group_deactivated_alert_when_event_is_complete():
    event = {
        "kind": "group_deactivated",
        "subscription": "ChatGPT Plus",
        "accountId": "12",
        "accountAlias": "Cuenta 12",
        "messageId": "<msg-group>",
        "uid": "903",
    }
    review = {"category": "pending"}

    alerts = build_direct_alerts(
        event=event,
        review=review,
        notification_doc_id="notif_group",
        generated_at=GENERATED_AT,
        existing_alerts=[],
    )

    assert len(alerts) == 1
    assert alerts[0]["type"] == "group_deactivated"
    assert alerts[0]["businessKey"] == "group_deactivated|ChatGPT Plus|12|"



def test_build_direct_alerts_skips_incomplete_join_event():
    event = {
        "kind": "user_join_direct",
        "subscription": "ChatGPT Plus",
        "accountId": "12",
        "accountAlias": "Cuenta 12",
    }
    review = {"category": "pending"}

    alerts = build_direct_alerts(
        event=event,
        review=review,
        notification_doc_id="notif_incomplete_join",
        generated_at=GENERATED_AT,
        existing_alerts=[],
    )

    assert alerts == []



def test_build_direct_alerts_skips_incomplete_leave_event_without_service_account_ref():
    event = {
        "kind": "user_left_self",
        "subscription": "ChatGPT Plus",
        "accountId": "12",
        "accountAlias": "Cuenta 12",
        "userName": "Mario",
    }
    review = {"category": "pending"}

    alerts = build_direct_alerts(
        event=event,
        review=review,
        notification_doc_id="notif_incomplete_leave",
        generated_at=GENERATED_AT,
        existing_alerts=[],
    )

    assert alerts == []



def test_build_direct_alerts_returns_empty_for_info_mail():
    event = {
        "kind": "unknown",
        "subscription": "ChatGPT Plus",
        "accountId": "12",
        "accountAlias": "Cuenta 12",
        "userName": "Mario",
    }
    review = {"category": "info"}

    alerts = build_direct_alerts(
        event=event,
        review=review,
        notification_doc_id="notif_info",
        generated_at=GENERATED_AT,
        existing_alerts=[],
    )

    assert alerts == []
