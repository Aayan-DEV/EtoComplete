from typing import Optional, Tuple, Dict, Any
import logging
import os
import requests
from urllib.parse import urlparse

from django.http import JsonResponse, HttpRequest
from django.conf import settings
from django.views.decorators.http import require_POST, require_GET
from django.contrib.auth.decorators import login_required
from django.utils import timezone

logger = logging.getLogger(__name__)

SESSION_KEY_LAST = "qks_last_result"

def _strip_bad_chars(val: Optional[str]) -> Optional[str]:
    if not isinstance(val, str):
        return val
    return val.strip().strip('"').strip("'").rstrip(",")

def _setting_get(key: str, default: Optional[str] = None) -> Optional[str]:
    try:
        val = getattr(settings, key)
        if isinstance(val, str) and val.strip():
            return _strip_bad_chars(val)
    except Exception:
        pass
    env_val = os.environ.get(key)
    if isinstance(env_val, str) and env_val.strip():
        return _strip_bad_chars(env_val)
    return default

def _validate_base_url(raw: str) -> Tuple[bool, Optional[str], Optional[str]]:
    if not isinstance(raw, str):
        return False, None, "Invalid type for URL."
    url = raw.strip()
    if not url:
        return False, None, "Empty URL."
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, None, "URL must start with http:// or https://."
    if not parsed.netloc:
        return False, None, "URL missing host."
    normalized = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
    return True, normalized, None

def _resolve_api_base() -> Tuple[Optional[str], Optional[str]]:
    raw = _setting_get("ETSY_KEYWORD_INSIGHT_API_LINK")
    if not raw:
        return None, "Missing 'ETSY_KEYWORD_INSIGHT_API_LINK' in settings/environment."
    ok, normalized, reason = _validate_base_url(raw)
    if not ok or not normalized:
        return None, f"Invalid ETSY_KEYWORD_INSIGHT_API_LINK: {reason or 'unknown reason'}."
    return normalized, None

def _resolve_api_path() -> str:
    raw = _setting_get("ETSY_KEYWORD_INSIGHT_API_PATH")
    path = (raw or "/api/keyword-insights").strip()
    path = path.rstrip(",")
    if not path.startswith("/"):
        path = "/" + path
    return path

def _resolve_timeout() -> float:
    raw = _setting_get("KEYWORD_INSIGHT_TIMEOUT")
    if raw:
        try:
            t = float(raw)
            if t < 1: t = 1.0
            if t > 120: t = 120.0
            return t
        except Exception:
            logger.warning("Invalid KEYWORD_INSIGHT_TIMEOUT value: %s", raw)
    return 30.0

def _json_error(message: str, status: int, *, error_code: Optional[str] = None, details: Any = None) -> JsonResponse:
    payload = {"error": {"code": error_code or "UNKNOWN_ERROR", "message": message, "details": details}}
    return JsonResponse(payload, status=status)

def _call_keyword_insights_api(api_base: str, keyword: str, timeout_sec: float) -> Tuple[int, Dict[str, Any]]:
    api_path = _resolve_api_path()
    endpoint = f"{api_base.rstrip('/')}{api_path}"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    logger.info("[QKS] Upstream call: endpoint=%s, base=%s, path=%s, timeout=%s", endpoint, api_base, api_path, timeout_sec)
    try:
        resp = requests.post(endpoint, json={"keyword": keyword}, headers=headers, timeout=timeout_sec)
        content_type = (resp.headers.get("Content-Type", "") or "").lower()
        if "application/json" in content_type:
            try:
                body = resp.json()
            except ValueError:
                body = {"error": {"code": "BAD_UPSTREAM_JSON", "message": "Upstream returned invalid JSON.",
                                  "details": {"raw": resp.text[:500], "endpoint": endpoint}}}
        else:
            body = {"error": {"code": "UPSTREAM_NON_JSON", "message": "Upstream returned non-JSON response.",
                              "details": {"content_type": content_type, "raw": resp.text[:500], "endpoint": endpoint}}}
        return resp.status_code, body
    except requests.Timeout:
        return 504, {"error": {"code": "UPSTREAM_TIMEOUT", "message": "Upstream request timed out.",
                               "details": {"timeout_seconds": timeout_sec, "endpoint": endpoint}}}
    except requests.ConnectionError as e:
        return 502, {"error": {"code": "UPSTREAM_CONNECTION_ERROR", "message": "Failed to connect to upstream service.",
                               "details": {"error": str(e), "endpoint": endpoint}}}
    except requests.RequestException as e:
        return 502, {"error": {"code": "UPSTREAM_REQUEST_ERROR", "message": "Upstream request failed.",
                               "details": {"error": str(e), "endpoint": endpoint}}}
    except Exception as e:
        return 500, {"error": {"code": "UNEXPECTED_CLIENT_ERROR", "message": "Unexpected error calling upstream service.",
                               "details": {"error": str(e), "endpoint": endpoint}}}

@require_POST
@login_required
def quick_keyword_search(request: HttpRequest) -> JsonResponse:
    try:
        import json
        if request.headers.get("Content-Type", "").lower().startswith("application/json"):
            parsed = json.loads(request.body.decode("utf-8") or "{}")
            keyword = parsed.get("keyword")
        else:
            keyword = request.POST.get("keyword")
    except Exception:
        keyword = request.POST.get("keyword")

    if keyword is None:
        return _json_error("Missing 'keyword' input", 400, error_code="INVALID_INPUT",
                           details={"hint": "Provide JSON {\"keyword\": \"...\"} or form field 'keyword'."})
    if not isinstance(keyword, str):
        return _json_error("'keyword' must be a string", 400, error_code="INVALID_INPUT",
                           details={"received_type": type(keyword).__name__})
    cleaned = keyword.strip()
    if not cleaned:
        return _json_error("'keyword' cannot be empty", 400, error_code="INVALID_INPUT",
                           details={"hint": "Trim spaces; provide a non-empty value."})
    if len(cleaned) > 120:
        return _json_error("'keyword' is too long (>120 chars)", 413, error_code="INPUT_TOO_LONG",
                           details={"received_length": len(cleaned), "hint": "Use <= 120 characters."})

    api_base, base_err = _resolve_api_base()
    if base_err or not api_base:
        logger.error("[QKS] API base resolution failed: %s", base_err)
        return _json_error("Configuration error", 500, error_code="CONFIG_MISSING",
                           details={"message": base_err, "hint": "Set ETSY_KEYWORD_INSIGHT_API_LINK in settings/.env (no trailing comma)."})

    timeout = _resolve_timeout()
    status_code, body = _call_keyword_insights_api(api_base, cleaned, timeout)

    try:
        request.session[SESSION_KEY_LAST] = {
            "keyword": cleaned,
            "result": body,
            "saved_at": timezone.now().isoformat()
        }
        request.session.modified = True
    except Exception as e:
        logger.warning("[QKS] Failed to persist last result in session: %s", str(e))

    return JsonResponse({"keyword": cleaned, "status": status_code, "body": body}, status=status_code)

@require_GET
@login_required
def quick_keyword_last(request: HttpRequest) -> JsonResponse:
    payload = request.session.get(SESSION_KEY_LAST) or {}
    if not payload:
        return JsonResponse({"saved": False, "last": None}, status=200)
    return JsonResponse({"saved": True, "last": payload}, status=200)