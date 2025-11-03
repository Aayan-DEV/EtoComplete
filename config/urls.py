"""
URL configuration for config project.
"""
from django.contrib import admin
from django.urls import path
from core.views import home, supabase_health

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', home, name='home'),
    path('health/supabase/', supabase_health, name='supabase_health'),
]