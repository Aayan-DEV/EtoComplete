from django.conf import settings
from supabase import create_client, Client
from dotenv import load_dotenv
import os
import requests

def get_supabase_client(use_service_role: bool = False) -> Client:
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    url = os.getenv("SUPABASE_URL") or settings.SUPABASE_URL
    if not url:
        raise RuntimeError("SUPABASE_URL is not configured")
    key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY") if use_service_role else os.getenv("SUPABASE_ANON_KEY")
    ) or (settings.SUPABASE_SERVICE_ROLE_KEY if use_service_role else settings.SUPABASE_ANON_KEY)
    if not key:
        raise RuntimeError("Supabase key is not configured")
    return create_client(url, key)

def ping_supabase() -> dict:
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    result = {"ok": False, "method": None, "details": None}
    try:
        service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or settings.SUPABASE_SERVICE_ROLE_KEY
        if service_key:
            client = get_supabase_client(use_service_role=True)
            result["method"] = "auth.admin.list_users"
            users = client.auth.admin.list_users()
            count = len(getattr(users, "users", getattr(users, "data", [])))
            result["details"] = {"user_count": count}
            result["ok"] = True
            return result

        result["method"] = "url-ping"
        resp = requests.get(os.getenv("SUPABASE_URL") or settings.SUPABASE_URL, timeout=5)
        result["details"] = {"status_code": resp.status_code}
        result["ok"] = resp.ok
        return result
    except Exception as exc:
        result["details"] = {"error": str(exc)}
        return result

def oauth_authorize_url(provider: str, redirect_to: str) -> str:
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    base = (os.getenv("SUPABASE_URL") or settings.SUPABASE_URL).rstrip("/")
    return f"{base}/auth/v1/authorize?provider={provider}&redirect_to={redirect_to}"

def sign_up_user(email: str, password: str, data: dict | None = None, redirect_to: str | None = None) -> dict:
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    url = (os.getenv("SUPABASE_URL") or settings.SUPABASE_URL).rstrip("/") + "/auth/v1/signup"
    headers = {
        "apikey": os.getenv("SUPABASE_ANON_KEY") or settings.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
    }
    payload = {"email": email, "password": password, "data": data or {}}
    if redirect_to:
        payload["email_redirect_to"] = redirect_to
    resp = requests.post(url, headers=headers, json=payload, timeout=10)
    try:
        body = resp.json()
    except Exception:
        body = None
    return {"ok": resp.ok, "status": resp.status_code, "data": body}

def resend_signup_confirmation(email: str, redirect_to: str | None = None) -> bool:
    load_dotenv(settings.BASE_DIR / ".env", override=True)
    url = (os.getenv("SUPABASE_URL") or settings.SUPABASE_URL).rstrip("/") + "/auth/v1/resend"
    headers = {
        "apikey": os.getenv("SUPABASE_ANON_KEY") or settings.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
    }
    payload = {"type": "signup", "email": email}
    if redirect_to:
        payload["email_redirect_to"] = redirect_to
    resp = requests.post(url, headers=headers, json=payload, timeout=10)
    return resp.ok