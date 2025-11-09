"""
Keyword Insight routes (Flask) with robust config handling, validation, and error reporting.
No hardcoded paths; `.env` is discovered dynamically from the current working directory using
python-dotenv if available, else a safe manual upward search.

Routes:
- GET /keyword-insight
- POST /keyword-insight/search  (expects { "keyword": "..." } in JSON or form)

Configuration sources (precedence):
1) app.config['ETSY_KEYWORD_INSIGHT_API_LINK']
2) OS environment variable ETSY_KEYWORD_INSIGHT_API_LINK
3) .env discovered dynamically

Optional:
- KEYWORD_INSIGHT_TIMEOUT (seconds, clamps to [1, 120], default 30)
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Optional, Dict, Tuple, Any
from urllib.parse import urlparse

import requests
from flask import render_template, request, jsonify, current_app, Response

try:
    from dotenv import dotenv_values, find_dotenv  # type: ignore
except Exception:
    dotenv_values = None
    find_dotenv = None

# Module-level cache for .env values
_ENV_CACHE: Dict[str, str] = {}
_ENV_PATH: Optional[Path] = None
_ENV_LOADED: bool = False


def _log() -> logging.Logger:
    try:
        # If inside app context, prefer Flask logger
        return current_app.logger  # type: ignore
    except Exception:
        return logging.getLogger(__name__)


def _trace_id() -> str:
    return uuid.uuid4().hex


def _read_env_file(env_path: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    try:
        if env_path.exists():
            with open(env_path, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    if v.startswith('"') and v.endswith('"'):
                        v = v[1:-1]
                    elif v.startswith("'") and v.endswith("'"):
                        v = v[1:-1]
                    env[k] = v
    except Exception as e:
        _log().warning("Failed reading .env file: %s", e)
    return env

def _discover_env_path() -> Optional[Path]:
    # Updated: search from CWD, module path, and Flask app root_path (if available)
    candidates: list[Path] = []

    # 1) python-dotenv upward search from CWD
    try:
        if find_dotenv:
            pstr = find_dotenv(usecwd=True)
            if pstr:
                candidates.append(Path(pstr))
    except Exception as e:
        _log().debug("find_dotenv failed: %s", e)

    # 2) Manual upward search from current working directory
    try:
        cur = Path.cwd()
        for p in [cur] + list(cur.parents):
            candidates.append(p / ".env")
    except Exception as e:
        _log().debug("CWD discovery failed: %s", e)

    # 3) Manual upward search from this module's directory
    try:
        mod_dir = Path(__file__).resolve().parent
        for p in [mod_dir] + list(mod_dir.parents):
            candidates.append(p / ".env")
    except Exception as e:
        _log().debug("Module path discovery failed: %s", e)

    # 4) Manual upward search from Flask app root_path (if in app context)
    try:
        rp = Path(current_app.root_path)  # type: ignore
        for p in [rp] + list(rp.parents):
            candidates.append(p / ".env")
    except Exception:
        # Not in app context; ignore
        pass

    # Deduplicate preserving order
    seen: set[str] = set()
    uniq_candidates: list[Path] = []
    for c in candidates:
        s = str(c)
        if s in seen:
            continue
        seen.add(s)
        uniq_candidates.append(c)

    for c in uniq_candidates:
        try:
            if c.exists():
                return c
        except Exception:
            continue

    return None

def _load_env_cache(force: bool = False) -> None:
    global _ENV_CACHE, _ENV_PATH, _ENV_LOADED
    if _ENV_LOADED and not force:
        return

    _ENV_CACHE = {}
    _ENV_PATH = _discover_env_path()
    if _ENV_PATH and _ENV_PATH.exists():
        try:
            if dotenv_values:
                parsed = dotenv_values(_ENV_PATH, encoding="utf-8") or {}
                _ENV_CACHE = dict(parsed)
            else:
                _ENV_CACHE = _read_env_file(_ENV_PATH)
            _ENV_LOADED = True
            _log().debug("Loaded .env from %s with %d keys", _ENV_PATH, len(_ENV_CACHE))
        except Exception as e:
            _ENV_LOADED = True
            _log().warning("Error loading .env: %s", e)
    else:
        _ENV_LOADED = True


def _config_get(key: str) -> Optional[str]:
    try:
        cfg_val = current_app.config.get(key)  # type: ignore
        if isinstance(cfg_val, str) and cfg_val.strip():
            return cfg_val.strip()
    except Exception:
        pass
    return None


def _env_get(key: str, default: Optional[str] = None) -> Optional[str]:
    val = os.environ.get(key)
    if isinstance(val, str) and val.strip():
        return val.strip().strip('"').strip("'")
    if not _ENV_LOADED:
        _load_env_cache()
    v = _ENV_CACHE.get(key)
    if isinstance(v, str) and v.strip():
        return v.strip()
    return default


def _setting_get(key: str, default: Optional[str] = None) -> Optional[str]:
    # Precedence: app.config -> OS env -> .env
    val = _config_get(key)
    if val:
        return val
    return _env_get(key, default)


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
        return None, "Missing 'ETSY_KEYWORD_INSIGHT_API_LINK' in config/environment."
    ok, normalized, reason = _validate_base_url(raw)
    if not ok or not normalized:
        return None, f"Invalid ETSY_KEYWORD_INSIGHT_API_LINK: {reason or 'unknown reason'}."
    return normalized, None


def _resolve_api_path() -> str:
    raw = _setting_get("ETSY_KEYWORD_INSIGHT_API_PATH")
    path = (raw or "/api/keyword-insights").strip()
    if not path.startswith("/"):
        path = "/" + path
    return path


def _resolve_timeout() -> float:
    raw = _setting_get("KEYWORD_INSIGHT_TIMEOUT")
    if raw:
        try:
            t = float(raw)
            if t < 1:
                t = 1.0
            if t > 120:
                t = 120.0
            return t
        except Exception:
            _log().warning("Invalid KEYWORD_INSIGHT_TIMEOUT value: %s", raw)
    return 30.0


def _json_error(
    message: str,
    status: int,
    *,
    error_code: Optional[str] = None,
    details: Any = None,
    hint: Optional[str] = None,
    trace_id: Optional[str] = None,
) -> Response:
    tid = trace_id or _trace_id()
    payload = {
        "error": {
            "code": error_code or "UNKNOWN_ERROR",
            "message": message,
            "details": details,
            "hint": hint,
            "trace_id": tid,
        }
    }
    resp = jsonify(payload)
    resp.status_code = status
    resp.headers["X-Trace-ID"] = tid
    return resp


def _extract_keyword() -> Tuple[Optional[str], Optional[Tuple[str, int, Dict[str, Any]]]]:
    """
    Extracts and validates 'keyword' from JSON body or form.
    Returns:
      (keyword, None) on success; (None, (message, status, extras)) on validation error.
    """
    data: Any = None
    try:
        data = request.get_json(silent=True)
    except Exception:
        data = None

    keyword: Any = None
    if isinstance(data, dict):
        keyword = data.get("keyword")
    if not keyword:
        keyword = request.form.get("keyword")

    if keyword is None:
        return None, ("Missing 'keyword' input", 400, {"hint": "Provide JSON {\"keyword\": \"...\"} or form field 'keyword'."})
    if not isinstance(keyword, str):
        return None, ("'keyword' must be a string", 400, {"received_type": type(keyword).__name__})

    cleaned = keyword.strip()
    if not cleaned:
        return None, ("'keyword' cannot be empty", 400, {"hint": "Trim spaces; provide a non-empty value."})

    max_len = 120
    if len(cleaned) > max_len:
        return None, (f"'keyword' is too long (>{max_len} chars)", 413, {"received_length": len(cleaned), "hint": f"Use <= {max_len} characters."})

    return cleaned, None


def _call_keyword_insights_api(api_base: str, keyword: str, timeout_sec: float) -> Tuple[int, Dict[str, Any]]:
    api_path = _resolve_api_path()
    endpoint = f"{api_base.rstrip('/')}{api_path}"
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(endpoint, json={"keyword": keyword}, headers=headers, timeout=timeout_sec)
        content_type = resp.headers.get("Content-Type", "")

        if "application/json" in content_type.lower():
            try:
                body = resp.json()
            except ValueError:
                body = {
                    "error": {
                        "code": "BAD_UPSTREAM_JSON",
                        "message": "Upstream returned invalid JSON.",
                        "details": {"raw": resp.text[:500], "endpoint": endpoint},
                    }
                }
        else:
            body = {
                "error": {
                    "code": "UPSTREAM_NON_JSON",
                    "message": "Upstream returned non-JSON response.",
                    "details": {"content_type": content_type, "raw": resp.text[:500], "endpoint": endpoint},
                }
            }

        return resp.status_code, body

    except requests.Timeout:
        return 504, {
            "error": {
                "code": "UPSTREAM_TIMEOUT",
                "message": "Upstream request timed out.",
                "details": {"timeout_seconds": timeout_sec, "endpoint": endpoint},
                "hint": "Check the keyword-insights service availability and timeout settings.",
            }
        }
    except requests.ConnectionError as e:
        return 502, {
            "error": {
                "code": "UPSTREAM_CONNECTION_ERROR",
                "message": "Failed to connect to upstream service.",
                "details": {"error": str(e), "endpoint": endpoint},
                "hint": "Verify service host/port and network connectivity.",
            }
        }
    except requests.RequestException as e:
        return 502, {
            "error": {
                "code": "UPSTREAM_REQUEST_ERROR",
                "message": "Upstream request failed.",
                "details": {"error": str(e), "endpoint": endpoint},
            }
        }
    except Exception as e:
        return 500, {
            "error": {
                "code": "UNEXPECTED_CLIENT_ERROR",
                "message": "Unexpected error calling upstream service.",
                "details": {"error": str(e), "endpoint": endpoint},
            }
        }


def register_routes(app):
    @app.route("/keyword-insight", endpoint="keyword_insight")
    def keyword_insight_page():
        try:
            return render_template("keyword_insight/keyword.html")
        except Exception as e:
            tid = _trace_id()
            _log().error("Template rendering failed [%s]: %s", tid, e)
            return _json_error(
                "Template not found or failed to render",
                500,
                error_code="TEMPLATE_ERROR",
                details={"error": str(e)},
                hint="Ensure template 'keyword_insight/keyword.html' exists.",
                trace_id=tid,
            )

    @app.route("/keyword-insight/search", methods=["POST"], endpoint="keyword_insight_search")
    def keyword_insight_search():
        tid = _trace_id()

        keyword, validation_err = _extract_keyword()
        if validation_err:
            message, status, extras = validation_err
            _log().info("Invalid keyword input [%s]: %s", tid, message)
            return _json_error(
                message,
                status,
                error_code="INVALID_INPUT",
                details=extras,
                trace_id=tid,
            )

        api_base, base_err = _resolve_api_base()
        if base_err or not api_base:
            _log().error("API base resolution failed [%s]: %s", tid, base_err)
            return _json_error(
                "Configuration error",
                500,
                error_code="CONFIG_MISSING",
                details={"message": base_err},
                hint="Set ETSY_KEYWORD_INSIGHT_API_LINK in environment or app.config.",
                trace_id=tid,
            )

        timeout = _resolve_timeout()
        api_path = _resolve_api_path()
        endpoint = f"{api_base.rstrip('/')}{api_path}"
        _log().info("Upstream call [%s]: endpoint=%s, base=%s, path=%s, timeout=%s", tid, endpoint, api_base, api_path, timeout)

        status_code, body = _call_keyword_insights_api(api_base, keyword, timeout)

        try:
            resp = jsonify(body)
            resp.status_code = status_code
            resp.headers["X-Trace-ID"] = tid
            return resp
        except Exception as e:
            _log().error("Failed to build JSON response [%s]: %s", tid, e)
            return _json_error(
                "Server response error",
                500,
                error_code="RESPONSE_BUILD_ERROR",
                details={"error": str(e)},
                trace_id=tid,
            )

    @app.route("/keyword-insight/debug", methods=["GET"], endpoint="keyword_insight_debug")
    def keyword_insight_debug():
        tid = _trace_id()
        base, base_err = _resolve_api_base()
        path = _resolve_api_path()
        timeout = _resolve_timeout()

        resp = jsonify({
            "trace_id": tid,
            "config": {
                "ETSY_KEYWORD_INSIGHT_API_LINK": base,
                "ETSY_KEYWORD_INSIGHT_API_PATH": path,
                "KEYWORD_INSIGHT_TIMEOUT": timeout,
                "env_source": str(_ENV_PATH) if _ENV_PATH else None,
                "env_loaded": _ENV_LOADED,
            },
            "errors": {"base_error": base_err},
        })
        resp.status_code = 200 if base else 500
        resp.headers["X-Trace-ID"] = tid
        return resp