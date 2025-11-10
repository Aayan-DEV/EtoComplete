from django.http import HttpResponse
from django.http import JsonResponse
from django.shortcuts import render, redirect
from django.urls import reverse
from django.contrib import messages
from django.contrib.auth.models import User
from django.contrib.auth import authenticate, login, logout
from django.utils import timezone
from django.utils.safestring import mark_safe
from django.contrib.auth.decorators import login_required
import re
import json
from django.views.decorators.csrf import ensure_csrf_cookie
from .supabase_client import ping_supabase, sign_up_user, oauth_authorize_url, resend_signup_confirmation
from .models import UserProfile
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash

# Bulk Research sessions for template bootstrapping
try:
    from bulk_research.models import BulkResearchSession
except Exception:
    BulkResearchSession = None


def home(request):
    # Redirect remembered, authenticated users straight to dashboard
    if request.user.is_authenticated and request.session.get('remember_me') is True:
        return redirect('users_main_dash')
    return render(request, 'landing/landing.html')

@ensure_csrf_cookie
def signup(request):
    if request.method == 'GET':
        return render(request, 'auth/user_auth/signup/signup.html')
    first_name = request.POST.get('first_name','').strip()
    last_name = request.POST.get('last_name','').strip()
    email = request.POST.get('email','').strip().lower()
    password = request.POST.get('password','')
    confirm = request.POST.get('confirm_password','')
    pw_ok = (
        len(password) >= 8 and
        re.search(r'[A-Z]', password) and
        re.search(r'[a-z]', password) and
        re.search(r'\d', password) and
        re.search(r'[^A-Za-z0-9]', password)
    )
    if not pw_ok or password != confirm or not email:
        messages.error(request, 'Please meet password rules and match confirmation.')
        return render(request, 'auth/user_auth/signup/signup.html', status=400)
    user, created = User.objects.get_or_create(
        username=email,
        defaults={'email': email, 'first_name': first_name, 'last_name': last_name}
    )
    if not created:
        user.first_name, user.last_name, user.email = first_name, last_name, email
    user.set_password(password)
    user.save()
    UserProfile.objects.get_or_create(user=user, defaults={'email_confirmed': False})
    redirect_to = request.build_absolute_uri(reverse('auth_confirm'))
    sb = sign_up_user(email=email, password=password, data={'first_name': first_name, 'last_name': last_name}, redirect_to=redirect_to)
    if sb.get('ok'):
        messages.success(request, 'Signup successful. Confirmation email sent — check your inbox.')
    else:
        messages.error(request, f"Signup completed locally. Supabase email failed (status {sb.get('status')}).")
    return redirect('signup')

@ensure_csrf_cookie
def login_view(request):
    if request.method == 'GET':
        return render(request, 'auth/user_auth/login/login.html')
    email = (request.POST.get('email') or '').strip().lower()
    password = request.POST.get('password') or ''
    remember = (request.POST.get('remember') == 'on')

    # If account exists but email not confirmed, show notification and stay on login
    user_for_check = User.objects.filter(username__iexact=email).first()
    if user_for_check:
        profile, _ = UserProfile.objects.get_or_create(user=user_for_check)
        if not profile.email_confirmed:
            resend_url = reverse('auth_resend') + f'?email={email}&next=login'
            messages.warning(
                request,
                mark_safe(f'Haven’t confirmed your email? <a href="{resend_url}" class="underline underline-offset-4">Resend email confirmation</a>')
            )
            return render(request, 'auth/user_auth/login/login.html', status=403)

    # Proceed with authentication when confirmed
    user = authenticate(request, username=email, password=password)
    if user is None:
        messages.error(request, 'Invalid email or password.')
        return render(request, 'auth/user_auth/login/login.html', status=401)

    # Safety: guard against unconfirmed login
    profile, _ = UserProfile.objects.get_or_create(user=user)
    if not profile.email_confirmed:
        resend_url = reverse('auth_resend') + f'?email={email}&next=login'
        messages.warning(
            request,
            mark_safe(f'Haven’t confirmed your email? <a href="{resend_url}" class="underline underline-offset-4">Resend email confirmation</a>')
        )
        return render(request, 'auth/user_auth/login/login.html', status=403)

    login(request, user)
    # Persist session based on "Remember me"
    request.session.set_expiry(1209600 if remember else 0)
    if remember:
        request.session['remember_me'] = True
    else:
        request.session.pop('remember_me', None)

    messages.success(request, 'Welcome back.')
    return redirect('users_main_dash')

def oauth_redirect(request, provider):
    redirect_to = request.build_absolute_uri(reverse('auth_confirm'))
    return redirect(oauth_authorize_url(provider, redirect_to))

def auth_confirm(request):
    email = (request.GET.get('email') or '').strip().lower()
    user = None
    if email:
        try:
            user = User.objects.get(username=email)
        except User.DoesNotExist:
            user = None
    if user:
        profile, _ = UserProfile.objects.get_or_create(user=user)
        profile.email_confirmed = True
        profile.confirmed_at = timezone.now()
        profile.save()
        login(request, user)
        messages.success(request, 'Email confirmed.')
        messages.info(request, 'Redirecting to dashboard...')
        return redirect('users_main_dash')
    messages.error(request, 'We couldn’t find an account for this email. Please sign up first.')
    return redirect('signup')

def resend_confirmation_view(request):
    email = request.GET.get('email') or request.POST.get('email') or ''
    redirect_to = request.build_absolute_uri(reverse('auth_confirm'))
    ok = resend_signup_confirmation(email, redirect_to=redirect_to) if email else False
    messages.success(request, 'Confirmation email resent.' if ok else 'Enter your email to resend confirmation.')

    # Stay on login page when coming from login or explicitly requested
    next_page = request.GET.get('next') or request.POST.get('next') or ''
    referer = request.META.get('HTTP_REFERER', '') or ''
    if next_page == 'login' or '/auth/login' in referer:
        return redirect('login')

    # Default: keep user on login (instead of signup)
    return redirect('login')

@login_required(login_url='/auth/login/')
def users_main_dash(request):
    return render(request, 'users_dasboard/main_dash/main.html')

def supabase_health(request):
    result = ping_supabase()
    status = 200 if result.get("ok") else 503
    return JsonResponse(result, status=status)

@login_required(login_url='/auth/login/')
def users_stores(request):
    return render(request, 'users_dasboard/stores/stores.html')

@login_required(login_url='/auth/login/')
def users_va_admin(request):
    return render(request, 'users_dasboard/va_admin/for_user/va_admin.html')

@login_required(login_url='/auth/login/')
def users_customer_support(request):
    return render(request, 'users_dasboard/customer_support_auto/customer_support_auto.html')

@login_required(login_url='/auth/login/')
def users_bulk_research(request):
    """
    Render bulk research UI with an empty main page.
    Sessions are managed via the top-right panel; initial sessions are bootstrapped
    as JSON for the JS to render.
    """
    sessions_json = '[]'
    if BulkResearchSession:
        qs = BulkResearchSession.objects.filter(user=request.user).order_by('-created_at')
        sessions_list = []
        for s in qs:
            # Compute result stats
            entries_count = 0
            result_size = len(s.result_file or '')
            try:
                if s.result_file:
                    raw = json.loads(s.result_file)
                    if isinstance(raw, dict):
                        if isinstance(raw.get('entries'), list):
                            entries_count = len(raw['entries'])
                        elif raw.get('megafile') and isinstance(raw['megafile'].get('entries'), list):
                            entries_count = len(raw['megafile']['entries'])
            except Exception:
                pass

            sessions_list.append({
                'id': s.id,
                'keyword': s.keyword,
                'desired_total': s.desired_total,
                'status': s.status,
                'progress': s.progress or {
                    'search': {'total': 0, 'remaining': 0},
                    'splitting': {'total': 0, 'remaining': 0},
                    'demand': {'total': 0, 'remaining': 0},
                    'keywords': {'total': 0, 'remaining': 0},
                },
                'created_at': s.created_at.isoformat(),
                'entries_count': entries_count,
                'result_size': result_size,
            })
        sessions_json = json.dumps(sessions_list)
    return render(request, 'users_dasboard/bulk_research/bulk_research.html', {
        'sessions_json': sessions_json
    })

@login_required
def bulk_research_list(request):
    qs = BulkResearchSession.objects.filter(user=request.user).order_by('-created_at')
    data = []
    for s in qs:
        # Compute result stats
        entries_count = 0
        result_size = len(s.result_file or '')
        try:
            if s.result_file:
                raw = json.loads(s.result_file)
                if isinstance(raw, dict):
                    if isinstance(raw.get('entries'), list):
                        entries_count = len(raw['entries'])
                    elif raw.get('megafile') and isinstance(raw['megafile'].get('entries'), list):
                        entries_count = len(raw['megafile']['entries'])
        except Exception:
            pass

        data.append({
            'id': s.id,
            'keyword': s.keyword,
            'desired_total': s.desired_total,
            'status': s.status,
            'progress': s.progress or BulkResearchSession.build_initial_progress(s.desired_total),
            'created_at': s.created_at.isoformat(),
            'entries_count': entries_count,
            'result_size': result_size,
        })
    return JsonResponse({'sessions': data})

@login_required(login_url='/auth/login/')
def users_single_research(request):
    return render(request, 'users_dasboard/single_research/single_research.html')

@login_required(login_url='/auth/login/')
def users_keyword_search(request):
    return render(request, 'users_dasboard/keyword_search/keyword_search.html')
    
def logout_view(request):
    logout(request)
    messages.success(request, 'You have been signed out.')
    return redirect('home')

@login_required(login_url='/auth/login/')
def users_settings(request):
    if request.method == 'GET':
        return render(request, 'settings/settings_for_user/settings.html')

    action = (request.POST.get('action') or '').strip()

    if action == 'update_profile':
        first_name = (request.POST.get('first_name') or '').strip()
        last_name = (request.POST.get('last_name') or '').strip()

        # Update name fields
        user = request.user
        user.first_name = first_name
        user.last_name = last_name
        user.save()
        messages.success(request, 'Profile updated.')
        return redirect('users_settings')

    elif action == 'change_password':
        current_password = request.POST.get('current_password') or ''
        new_password = request.POST.get('new_password') or ''
        confirm_password = request.POST.get('confirm_password') or ''

        user = request.user
        if not user.check_password(current_password):
            messages.error(request, 'Current password is incorrect.')
            return redirect('users_settings')

        pw_ok = (
            len(new_password) >= 8 and
            re.search(r'[A-Z]', new_password) and
            re.search(r'[a-z]', new_password) and
            re.search(r'\d', new_password) and
            re.search(r'[^A-Za-z0-9]', new_password)
        )
        if not pw_ok:
            messages.error(request, 'Password must be 8+ chars with uppercase, lowercase, number, and symbol.')
            return redirect('users_settings')

        if new_password != confirm_password:
            messages.error(request, 'New password and confirmation do not match.')
            return redirect('users_settings')

        user.set_password(new_password)
        user.save()
        update_session_auth_hash(request, user)  # keep user logged in
        messages.success(request, 'Password changed successfully.')
        return redirect('users_settings')

    else:
        messages.error(request, 'Unknown action.')
        return redirect('users_settings')