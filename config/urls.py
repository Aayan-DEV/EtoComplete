from django.contrib import admin
from django.urls import path
from core.views import home, supabase_health, signup, oauth_redirect, auth_confirm, resend_confirmation_view, users_main_dash, login_view
from core.views import (
    users_stores, users_va_admin, users_customer_support,
    users_bulk_research, users_single_research, users_keyword_search,
    users_settings, logout_view
)
from keyword_insight.views import keyword_insight_search, keyword_insight_debug
from bulk_research.views import bulk_research_start, bulk_research_stream, bulk_research_result, bulk_research_list
from bulk_research.views import bulk_research_delete
from bulk_research.views import bulk_research_reconnect

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', home, name='home'),
    path('health/supabase/', supabase_health, name='supabase_health'),
    path('auth/signup/', signup, name='signup'),
    path('auth/login/', login_view, name='login'),
    path('auth/logout/', logout_view, name='logout'),
    path('auth/confirm/', auth_confirm, name='auth_confirm'),
    path('auth/resend/', resend_confirmation_view, name='auth_resend'),
    path('oauth/<str:provider>/', oauth_redirect, name='oauth_redirect'),
    path('dashboard/', users_main_dash, name='users_main_dash'),
    path('dashboard/stores/', users_stores, name='users_stores'),
    path('dashboard/va-admin/', users_va_admin, name='users_va_admin'),
    path('dashboard/support/', users_customer_support, name='users_customer_support'),
    path('dashboard/bulk-research/', users_bulk_research, name='users_bulk_research'),
    path('dashboard/single-research/', users_single_research, name='users_single_research'),
    path('dashboard/keywords/', users_keyword_search, name='users_keyword_search'),
    path('settings/', users_settings, name='users_settings'),
    path('api/keyword-insight/search/', keyword_insight_search, name='keyword_insight_search'),
    path('api/keyword-insight/debug/', keyword_insight_debug, name='keyword_insight_debug'),
    path('api/bulk-research/start/', bulk_research_start, name='bulk_research_start'),
    path('api/bulk-research/stream/<int:session_id>/', bulk_research_stream, name='bulk_research_stream'),
    path('api/bulk-research/result/<int:session_id>/', bulk_research_result, name='bulk_research_result'),
    path('api/bulk-research/list/', bulk_research_list, name='bulk_research_list'),
    path('api/bulk-research/delete/<int:session_id>/', bulk_research_delete, name='bulk_research_delete'),
    path('api/bulk-research/reconnect/<int:session_id>/', bulk_research_reconnect, name='bulk_research_reconnect'),
]