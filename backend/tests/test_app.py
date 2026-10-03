from __future__ import annotations

import asyncio
import base64
from copy import deepcopy
from io import BytesIO
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import httpx2
from openai import APIConnectionError, APITimeoutError, AuthenticationError, RateLimitError
from PIL import Image
import pytest

from backend.app import DEFAULT_MODEL, MAX_BODY_BYTES, MAX_IMAGE_BYTES, RequestGuard, Settings, create_app


def png_data() -> str:
    output = BytesIO()
    Image.new("RGB", (20, 20), "brown").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def payload() -> dict:
    return {
        "schemaVersion": 1, "inputDigest": "a" * 64, "view": "front",
        "referenceImage": png_data(), "currentImage": png_data(),
        "quality": {"status": "comparable", "issues": []},
        "metrics": [{"kind": "outer", "label": "外轮廓", "signedOffset": 1.5, "absoluteOffset": 2.5, "referenceScale": 100, "unit": "face-percent"}],
    }


def advice() -> dict:
    return {
        "summary": "当前照片的轮廓略有变化，请结合本地叠图观察。",
        "qualityIssues": [{"code": "lighting", "severity": "warning", "message": "两张照片的光线有差别。", "suggestion": "使用柔和正面光线复拍。"}],
        "regionNotes": [{"metricId": "outer", "text": "外轮廓可见偏移，具体数值请查看本地指标。"}],
        "limitations": ["透视和光照仍可能影响视觉判断。"],
    }


def response(content: dict | None = None, *, status: str = "completed", refusal: bool = False):
    return SimpleNamespace(status=status, output=[SimpleNamespace(content=[SimpleNamespace(type="refusal" if refusal else "output_text")])], output_text=json.dumps(content or advice(), ensure_ascii=False))


def setup_client(mock_response=None, error=None, *, token=""):
    create = AsyncMock(return_value=mock_response or response(), side_effect=error)
    fake = SimpleNamespace(responses=SimpleNamespace(create=create))
    return TestClient(create_app(Settings(api_key="test-key-never-log", access_token=token), fake)), create


def test_success_binds_digest_does_not_mutate_metrics_or_persist_images(tmp_path, monkeypatch, caplog):
    monkeypatch.chdir(tmp_path)
    request_payload = payload()
    before = deepcopy(request_payload)
    client, create = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", json=request_payload)
    assert result.status_code == 200
    assert result.json()["inputDigest"] == request_payload["inputDigest"]
    assert result.json()["model"] == DEFAULT_MODEL
    assert "transform" not in result.json()
    assert "quality" not in result.json()
    assert request_payload == before
    assert list(tmp_path.iterdir()) == []
    assert request_payload["referenceImage"] not in caplog.text
    assert "test-key-never-log" not in caplog.text
    args = create.call_args.kwargs
    assert args["store"] is False
    assert args["text"]["format"]["strict"] is True
    assert args["model"] == DEFAULT_MODEL
    assert [x["image_url"] for x in args["input"][0]["content"] if x["type"] == "input_image"] == [request_payload["referenceImage"], request_payload["currentImage"]]
    assert args["text"]["format"]["schema"]["properties"]["regionNotes"]["items"]["properties"]["metricId"]["enum"] == ["outer", None]


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(inputDigest="invalid-digest"),
    lambda p: p.update(schemaVersion=2),
    lambda p: p.update(referenceImage="https://example.com/photo.jpg"),
    lambda p: p.update(currentImage="data:image/gif;base64,AAAA"),
    lambda p: p.update(currentImage="data:image/png;base64,broken=="),
    lambda p: p.update(currentImage="data:image/jpeg;base64," + p["referenceImage"].split(",")[1]),
    lambda p: p.update(customerName="must-not-be-submitted"),
    lambda p: p["quality"].update(status="retake"),
    lambda p: p["quality"]["issues"].append({"code": "pose", "severity": "block", "message": "角度差异明显。", "suggestion": "重拍。"}),
    lambda p: p["metrics"].append(deepcopy(p["metrics"][0])),
    lambda p: p["metrics"][0].update(signedOffset=float("inf")),
])
def test_invalid_requests_never_echo_uploads_or_invoke_ai(mutate):
    data = payload()
    mutate(data)
    client, create = setup_client()
    with client:
        # JSON encoder rejects inf, so send a deliberate untrusted JSON body.
        result = client.post("/v1/comparison-assistance", content=json.dumps(data), headers={"Content-Type": "application/json"})
    assert result.status_code == 422
    assert result.json()["detail"]["code"] == "invalid_request"
    assert data["referenceImage"] not in result.text
    create.assert_not_called()


def test_oversized_image_rejected_before_upstream():
    data = payload()
    data["referenceImage"] = "data:image/png;base64," + base64.b64encode(b"x" * (MAX_IMAGE_BYTES + 1)).decode()
    client, create = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", json=data)
    assert result.status_code == 422
    create.assert_not_called()


def test_oversized_body_and_chunked_body_rejected():
    client, create = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", content=b"x" * (MAX_BODY_BYTES + 1))
    assert result.status_code == 413
    create.assert_not_called()

    called = AsyncMock()
    guard = RequestGuard(called, Settings())
    chunks = [{"type": "http.request", "body": b"x" * MAX_BODY_BYTES, "more_body": True}, {"type": "http.request", "body": b"x", "more_body": False}]
    receive = AsyncMock(side_effect=chunks)
    send = AsyncMock()
    asyncio.run(guard({"type": "http", "path": "/v1/comparison-assistance", "method": "POST", "headers": []}, receive, send))
    assert send.call_args_list[0].args[0]["status"] == 413
    called.assert_not_called()


def test_optional_access_token_and_origin_rejection():
    client, create = setup_client(token="research-token")
    with client:
        denied = client.post("/v1/comparison-assistance", content="invalid JSON")
        assert denied.status_code == 401
        blocked_origin = client.post("/v1/comparison-assistance", json=payload(), headers={"Authorization": "Bearer research-token", "Origin": "https://untrusted.example"})
        assert blocked_origin.status_code == 403
        allowed = client.post("/v1/comparison-assistance", json=payload(), headers={"Authorization": "Bearer research-token", "Origin": "http://localhost:5173"})
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert create.call_count == 1


def test_missing_key_has_only_readiness_health_no_secrets():
    with TestClient(create_app(Settings())) as client:
        assert client.get("/health").json() == {"ready": False}
        result = client.post("/v1/comparison-assistance", json=payload())
    assert result.status_code == 503
    assert result.json()["detail"]["code"] == "ai_not_configured"


def test_https_lan_origin_is_exact_and_opt_in():
    fake = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=response())))
    allowed_origin = "https://192.168.1.50:5174"
    settings = Settings(api_key="test-key", origins=(allowed_origin,))
    with TestClient(create_app(settings, fake)) as client:
        for origin in ["http://192.168.1.50:5174", "https://192.168.1.50:4173", "https://192.168.1.50:5174/", "https://192.168.1.51:5174"]:
            assert client.post("/v1/comparison-assistance", json=payload(), headers={"Origin": origin}).status_code == 403
        accepted = client.post("/v1/comparison-assistance", json=payload(), headers={"Origin": allowed_origin})
        assert accepted.status_code == 200
        assert accepted.headers["access-control-allow-origin"] == allowed_origin


@pytest.mark.parametrize("origin", ["https://localhost:5174", "https://127.0.0.1:5174"])
def test_https_development_port_is_allowed_by_default(origin):
    client, _ = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", json=payload(), headers={"Origin": origin})
    assert result.status_code == 200
    assert result.headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize("generated", [
    {**advice(), "regionNotes": [{"metricId": "fringe", "text": "不存在的区域。"}]},
    {**advice(), "summary": "建议剪短 5 mm。"},
    {**advice(), "summary": "长度变化为百分之三。"},
    {**advice(), "regionNotes": [{"metricId": "outer", "text": "剪短三厘米。"}]},
    {**advice(), "qualityStatus": "comparable"},
    {**advice(), "qualityIssues": [{"code": "test", "severity": "block", "message": "错误。", "suggestion": "错误。"}]},
])
def test_unknown_metrics_numeric_advice_and_geometry_overrides_rejected(generated):
    client, _ = setup_client(response(generated))
    with client:
        result = client.post("/v1/comparison-assistance", json=payload())
    assert result.status_code == 502
    assert result.json()["detail"]["code"] == "ai_invalid_response"


@pytest.mark.parametrize(("fake_response", "code"), [(response(status="incomplete"), "ai_incomplete"), (response(refusal=True), "ai_refused")])
def test_incomplete_and_refused_responses_do_not_expose_upstream(fake_response, code):
    client, _ = setup_client(fake_response)
    with client:
        result = client.post("/v1/comparison-assistance", json=payload())
    assert result.status_code == 502
    assert result.json()["detail"]["code"] == code


request = httpx2.Request("POST", "https://api.openai.com/v1/responses")


@pytest.mark.parametrize(("error", "status", "code"), [
    (APITimeoutError(request=request), 504, "ai_timeout"),
    (RateLimitError("private details", response=httpx2.Response(429, request=request), body={}), 429, "ai_rate_limited"),
    (AuthenticationError("private details", response=httpx2.Response(401, request=request), body={}), 503, "ai_configuration_error"),
    (APIConnectionError(request=request), 503, "ai_unavailable"),
    (RuntimeError("private details and image content"), 503, "ai_unavailable"),
])
def test_upstream_errors_are_sanitized(error, status, code):
    client, _ = setup_client(error=error)
    with client:
        result = client.post("/v1/comparison-assistance", json=payload())
    assert result.status_code == status
    assert result.json()["detail"]["code"] == code
    assert "private details" not in result.text


def test_visual_only_without_metrics_remains_advice_only():
    generated = advice()
    generated["regionNotes"][0]["metricId"] = None
    data = payload()
    data["quality"]["status"] = "visual-only"
    data["metrics"] = []
    client, create = setup_client(response(generated))
    with client:
        result = client.post("/v1/comparison-assistance", json=data)
    assert result.status_code == 200
    assert result.json()["regionNotes"][0]["metricId"] is None
    assert "本地质量限制继续有效" in "".join(result.json()["limitations"])
    assert "\"status\": \"visual-only\"" in create.call_args.kwargs["input"][0]["content"][0]["text"]


def test_bounded_upstream_limitations_accepts_trusted_local_boundaries():
    generated = advice()
    generated["limitations"] = ["视觉观察存在误差。"] * 12
    client, _ = setup_client(response(generated))
    with client:
        result = client.post("/v1/comparison-assistance", json=payload())
    assert result.status_code == 200
    assert len(result.json()["limitations"]) <= 14


def test_optional_projected_width_height_percentages_are_passed_without_reinterpretation():
    data = payload()
    data["metrics"][0]["projection"] = {"widthChangePercent": 12.5, "heightChangePercent": None}
    client, create = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", json=data)
    assert result.status_code == 200
    evidence_text = create.call_args.kwargs["input"][0]["content"][0]["text"]
    evidence = json.loads(evidence_text.split("：", 1)[1])
    assert evidence["metrics"][0]["projection"] == {"widthChangePercent": 12.5, "heightChangePercent": None}
    assert "不能换算成真实长度" in create.call_args.kwargs["instructions"]


@pytest.mark.parametrize("projection", [
    {"widthChangePercent": -100.1, "heightChangePercent": None},
    {"widthChangePercent": 10001, "heightChangePercent": None},
    {"widthChangePercent": float("nan"), "heightChangePercent": None},
    {"widthChangePercent": None, "heightChangePercent": float("inf")},
    {"widthChangePercent": 0, "heightChangePercent": 0, "realLengthMm": 5},
])
def test_invalid_projected_extents_are_rejected_without_calling_ai(projection):
    data = payload()
    data["metrics"][0]["projection"] = projection
    client, create = setup_client()
    with client:
        result = client.post("/v1/comparison-assistance", content=json.dumps(data), headers={"Content-Type": "application/json"})
    assert result.status_code == 422
    create.assert_not_called()
