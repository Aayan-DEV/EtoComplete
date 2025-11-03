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