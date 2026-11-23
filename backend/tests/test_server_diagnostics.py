import secrets
import time
from uuid import UUID

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_service_timeouts_are_correlated_and_expected_errors_stay_out_of_diagnostics(tmp_path):
    settings = Settings(db_path=str(tmp_path / "service.sqlite3"), worker_enabled=False,
                        public_enabled=False, admin_token=secrets.token_urlsafe(32),
                        weekly_limit=0, user_weekly_limit=0)
    app = create_app(settings)

    @app.get("/v1/accounts/synthetic-timeout")
    def timeout():
        raise HTTPException(504, "Synthetic provider failure")

    @app.get("/v1/accounts/synthetic-conflict")
    def conflict():
        raise HTTPException(409, "Expected user conflict")

    with TestClient(app) as client:
        failed = client.get("/v1/accounts/synthetic-timeout?flag=private-test-value")
        unrelated = client.get("/v1/accounts/synthetic-conflict")
        assert failed.status_code == 504 and unrelated.status_code == 409
        request_id = failed.headers["X-Request-ID"]
        assert str(UUID(request_id)) == request_id
        assert unrelated.headers["X-Request-ID"] != request_id

        diagnostics = app.state.technical_diagnostics
        deadline = time.monotonic() + 3
        while not (groups := diagnostics.groups()) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(groups) == 1 and groups[0]["count"] == 1
        event = diagnostics.event(groups[0]["latest_event_id"])
        assert (event["source"], event["area"], event["code"], event["http_status"], event["request_id"]) == (
            "server", "account", "timeout", 504, request_id,
        )
        assert "private-test-value" not in str(event) and "Synthetic provider failure" not in str(event)
