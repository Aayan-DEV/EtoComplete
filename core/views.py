from django.http import HttpResponse
from django.http import JsonResponse
from .supabase_client import ping_supabase

def home(request):
    return HttpResponse("Hello, Django!")
def supabase_health(request):
    result = ping_supabase()
    status = 200 if result.get("ok") else 503
    return JsonResponse(result, status=status)