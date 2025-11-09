import json
import time
from typing import Optional

import requests
from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse, HttpResponseBadRequest, Http404
from django.views.decorators.http import require_POST
from django.contrib.auth.decorators import login_required
from django.utils import timezone

from .models import BulkResearchSession

# Module-level: hardcoded upstream API endpoints
UPSTREAM_STREAM_URL = "http://136.116.10.105:8001/run/stream"

def _api_url(name: str, job_id: Optional[str] = None) -> str:
    url = getattr(settings, name, None)
    if not url:
        raise RuntimeError(f"Missing settings.{name}")
    return url.format(job_id=job_id) if (job_id and '{job_id}' in url) else url

def _map_stage_key(stage: str) -> Optional[str]:
    s = (stage or '').lower()
    if s == 'search':
        return 'search'
    if s == 'splitting':
        return 'splitting'
    if s == 'demand_extraction':
        return 'demand'
    if s in ('ai_keywords', 'keywords_research'):
        return 'keywords'
    return None

@login_required
@require_POST
def bulk_research_start(request):
    try:
        payload = json.loads(request.body.decode('utf-8'))
    except Exception:
        return HttpResponseBadRequest("Invalid JSON")

    keyword = (payload.get('keyword') or '').strip()
    desired_total = int(payload.get('desired_total') or 0)
    if not keyword or desired_total <= 0:
        return HttpResponseBadRequest("Keyword and desired_total are required")

    # Create local session only; upstream kicks off in stream attach
    session = BulkResearchSession.objects.create(
        user=request.user,
        keyword=keyword,
        desired_total=desired_total,
        status='ongoing',
        progress=BulkResearchSession.build_initial_progress(desired_total),
        started_at=timezone.now(),
    )
    return JsonResponse({'session_id': session.id})

@login_required
def bulk_research_stream(request, session_id: int):
    try:
        session = BulkResearchSession.objects.get(id=session_id, user=request.user)
    except BulkResearchSession.DoesNotExist:
        raise Http404("Session not found")

    # POST to the exact upstream URL and proxy SSE back to browser
    try:
        upstream = requests.post(
            "http://136.116.10.105:8001/run/stream",
            json={
                'user_id': request.user.username,
                'keyword': session.keyword,
                'desired_total': session.desired_total
            },
            headers={
                'Accept': 'text/event-stream',
                'Content-Type': 'application/json'
            },
            stream=True,
            timeout=120
        )
        if not upstream.ok:
            return JsonResponse({'error': f'Upstream stream failed ({upstream.status_code})', 'raw': upstream.text[:300]}, status=502)
    except Exception as e:
        return JsonResponse({'error': f'Upstream stream error: {e}'}, status=502)

    def to_event(obj):
        return f"data: {json.dumps(obj)}\n\n"

    def proxy():
        try:
            for raw in upstream.iter_lines(decode_unicode=True):
                if raw is None:
                    continue
                line = (raw or '').strip()
                if not line:
                    yield "\n"
                    continue
                if line.startswith(':'):
                    continue  # upstream keepalive/comment
                if line.startswith('data:'):
                    payload = line[5:].strip()
                    try:
                        evt = json.loads(payload)
                        stage = (evt.get('stage') or '').lower()
                        remaining = evt.get('remaining')
                        total = evt.get('total')
                        key = _map_stage_key(stage)
                        if key:
                            prog = session.progress or BulkResearchSession.build_initial_progress(session.desired_total)
                            obj = prog.get(key) or {'total': 0, 'remaining': 0}
                            if isinstance(total, int): obj['total'] = total
                            if isinstance(remaining, int): obj['remaining'] = remaining
                            prog[key] = obj
                            session.progress = prog
                            session.save(update_fields=['progress'])

                        # If upstream ever includes entries/megafile, persist them
                        try:
                            entries = None
                            if isinstance(evt.get('megafile'), dict) and isinstance(evt['megafile'].get('entries'), list):
                                entries = evt['megafile']['entries']
                            elif isinstance(evt.get('entries'), list):
                                entries = evt['entries']
                            if entries:
                                session.result_file = json.dumps({'entries': entries})
                                session.save(update_fields=['result_file'])
                        except Exception:
                            pass

                        # Mark completed when all stages reach zero remaining
                        try:
                            prog = session.progress or {}
                            if all((prog.get(k, {}).get('remaining', 1) == 0) for k in ('search', 'splitting', 'demand', 'keywords')):
                                session.status = 'completed'
                                session.completed_at = timezone.now()
                                session.save(update_fields=['status', 'completed_at'])
                        except Exception:
                            pass

                        yield to_event(evt)
                    except Exception:
                        yield f"data: {payload}\n\n"
                    time.sleep(0.01)
        finally:
            try:
                upstream.close()
            except Exception:
                pass

    resp = StreamingHttpResponse(proxy(), content_type='text/event-stream')
    resp['Cache-Control'] = 'no-cache'
    resp['X-Accel-Buffering'] = 'no'
    return resp

@login_required
def bulk_research_result(request, session_id: int):
    try:
        session = BulkResearchSession.objects.get(id=session_id, user=request.user)
    except BulkResearchSession.DoesNotExist:
        raise Http404("Session not found")

    raw = {}
    try:
        if session.result_file:
            raw = json.loads(session.result_file)
    except Exception:
        raw = {}

    entries = []
    if isinstance(raw, dict):
        if isinstance(raw.get('entries'), list):
            entries = raw['entries']
        elif raw.get('megafile') and isinstance(raw['megafile'].get('entries'), list):
            entries = raw['megafile']['entries']

    simplified = []
    for entry in entries:
        popular = entry.get('popular_info') or {}

        # Basic fields
        listing_id = entry.get('listing_id') or popular.get('listing_id') or ''
        title = popular.get('title') or entry.get('title') or ''
        url = popular.get('url') or entry.get('url') or ''
        demand = popular.get('demand', entry.get('demand', None))

        # IDs/state/description
        user_id = entry.get('user_id') or popular.get('user_id')
        shop_id = entry.get('shop_id') or popular.get('shop_id')
        state = entry.get('state') or popular.get('state') or ''
        description = popular.get('description') or entry.get('description') or ''

        # Made at (display + iso)
        ts = (popular.get('original_creation_timestamp')
              or popular.get('created_timestamp')
              or entry.get('original_creation_timestamp')
              or entry.get('created_timestamp'))
        made_at_iso = None
        made_at_display = None
        if ts is not None:
            try:
                dt = timezone.datetime.fromtimestamp(int(ts))
                made_at_iso = dt.isoformat()
                made_at_display = dt.strftime('%b %d, %Y')
            except Exception:
                made_at_display = str(ts)

        # Primary image
        primary_image = popular.get('primary_image') or entry.get('primary_image') or {}
        image_url = primary_image.get('image_url') or ''
        srcset = primary_image.get('srcset') or ''

        # Extra product detail fields
        last_modified_ts = popular.get('last_modified_timestamp') or entry.get('last_modified_timestamp')
        last_modified_iso = None
        last_modified_display = None
        if last_modified_ts is not None:
            try:
                dt = timezone.datetime.fromtimestamp(int(last_modified_ts))
                last_modified_iso = dt.isoformat()
                last_modified_display = dt.strftime('%b %d, %Y')
            except Exception:
                last_modified_display = str(last_modified_ts)

        quantity = entry.get('quantity') or popular.get('quantity')
        num_favorers = entry.get('num_favorers') or popular.get('num_favorers')
        listing_type = entry.get('listing_type') or popular.get('listing_type') or ''
        file_data = entry.get('file_data') or popular.get('file_data') or ''
        views = entry.get('views') or popular.get('views')

        # Tags, materials, keywords
        tags = popular.get('tags') or entry.get('tags') or []
        if not isinstance(tags, list):
            tags = []
        materials = popular.get('materials') or entry.get('materials') or []
        if not isinstance(materials, list):
            materials = []
        keywords = entry.get('keywords') or popular.get('keywords') or []
        if not isinstance(keywords, list):
            keywords = []

        # Price (base)
        price = popular.get('price') or entry.get('price') or {}
        price_amount = price.get('amount')
        price_divisor = price.get('divisor')
        price_currency = price.get('currency_code') or ''
        price_value = None
        price_display = None
        try:
            if isinstance(price_amount, (int, float)) and isinstance(price_divisor, int) and price_divisor:
                price_value = float(price_amount) / int(price_divisor)
                disp = ('{:.2f}'.format(price_value)).rstrip('0').rstrip('.')
                price_display = f'{disp} {price_currency}'.strip()
        except Exception:
            pass

        # Sale info and computed sale price
        import re
        sale_info = popular.get('sale_info') or entry.get('sale_info') or {}
        active_promo = sale_info.get('active_promotion') or {}
        buyer_promotion_name = active_promo.get('buyer_promotion_name') or ''
        buyer_shop_promotion_name = active_promo.get('buyer_shop_promotion_name') or ''
        buyer_promotion_description = active_promo.get('buyer_promotion_description') or ''
        buyer_applied_promotion_description = active_promo.get('buyer_applied_promotion_description') or ''

        promo_text = buyer_applied_promotion_description or buyer_promotion_description or ''
        sale_percent = None
        m = re.search(r'(\d+(?:\.\d+)?)\s*%', promo_text)
        if m:
            try:
                sale_percent = float(m.group(1))
            except Exception:
                sale_percent = None
        if sale_percent is None and isinstance(active_promo.get('seller_marketing_promotion'), dict):
            pct = active_promo['seller_marketing_promotion'].get('order_discount_pct')
            if isinstance(pct, (int, float)):
                sale_percent = float(pct)

        # Prefer subtotal_after_discount string from JSON for sale price
        sale_subtotal_after_discount = sale_info.get('subtotal_after_discount')
        sale_original_price = sale_info.get('original_price')

        sale_price_value = None
        sale_price_display = None
        if isinstance(sale_subtotal_after_discount, str) and sale_subtotal_after_discount.strip():
            sale_price_display = sale_subtotal_after_discount.strip()
            try:
                # Parse numeric amount like "$10.17" -> 10.17
                cleaned = re.sub(r'[^0-9.]', '', sale_price_display)
                if cleaned:
                    sale_price_value = float(cleaned)
            except Exception:
                sale_price_value = None
        elif (price_value is not None) and (sale_percent is not None):
            try:
                sale_price_value = price_value * (1.0 - (sale_percent / 100.0))
                disp = ('{:.2f}'.format(sale_price_value)).rstrip('0').rstrip('.')
                sale_price_display = f'{disp} {price_currency}'.strip()
            except Exception:
                sale_price_value = None
                sale_price_display = None

        sale_subtotal_after_discount = sale_info.get('subtotal_after_discount')
        sale_original_price = sale_info.get('original_price')

        # Shop details (nested: popular_info.shop.details)
        shop_obj = popular.get('shop') or entry.get('shop') or {}
        shop_details = shop_obj.get('details') or {}
        sh_shop_id = shop_obj.get('shop_id') or shop_details.get('shop_id')

        shop_created_ts = (shop_details.get('created_timestamp')
                           or shop_details.get('create_date')
                           or shop_obj.get('created_timestamp'))
        shop_created_iso = None
        shop_created_display = None
        if shop_created_ts is not None:
            try:
                dt = timezone.datetime.fromtimestamp(int(shop_created_ts))
                shop_created_iso = dt.isoformat()
                shop_created_display = dt.strftime('%b %d, %Y')
            except Exception:
                shop_created_display = str(shop_created_ts)

        shop_updated_ts = (shop_details.get('updated_timestamp')
                           or shop_details.get('update_date')
                           or shop_obj.get('updated_timestamp'))
        shop_updated_iso = None
        shop_updated_display = None
        if shop_updated_ts is not None:
            try:
                dt = timezone.datetime.fromtimestamp(int(shop_updated_ts))
                shop_updated_iso = dt.isoformat()
                shop_updated_display = dt.strftime('%b %d, %Y')
            except Exception:
                shop_updated_display = str(shop_updated_ts)

        # Shop sections
        shop_sections = shop_obj.get('sections')
        if not isinstance(shop_sections, list):
            shop_sections = []

        # Shop reviews (add friendly dates)
        shop_reviews = shop_obj.get('reviews')
        shop_reviews_simplified = []
        if isinstance(shop_reviews, list):
            for rv in shop_reviews:
                if not isinstance(rv, dict):
                    continue
                cts = rv.get('created_timestamp') or rv.get('create_timestamp')
                uts = rv.get('updated_timestamp') or rv.get('update_timestamp')
                c_iso = None
                c_disp = None
                u_iso = None
                u_disp = None
                if cts is not None:
                    try:
                        dt = timezone.datetime.fromtimestamp(int(cts))
                        c_iso = dt.isoformat()
                        c_disp = dt.strftime('%b %d, %Y')
                    except Exception:
                        c_disp = str(cts)
                if uts is not None:
                    try:
                        dt = timezone.datetime.fromtimestamp(int(uts))
                        u_iso = dt.isoformat()
                        u_disp = dt.strftime('%b %d, %Y')
                    except Exception:
                        u_disp = str(uts)
                shop_reviews_simplified.append({
                    'shop_id': rv.get('shop_id'),
                    'listing_id': rv.get('listing_id'),
                    'transaction_id': rv.get('transaction_id'),
                    'buyer_user_id': rv.get('buyer_user_id'),
                    'rating': rv.get('rating'),
                    'review': rv.get('review'),
                    'language': rv.get('language'),
                    'image_url_fullxfull': rv.get('image_url_fullxfull'),
                    'created_timestamp': cts,
                    'created_iso': c_iso,
                    'created': c_disp,
                    'updated_timestamp': uts,
                    'updated_iso': u_iso,
                    'updated': u_disp,
                })

        # Compute listing-level review metrics
        relevant_reviews = [rv for rv in shop_reviews_simplified if rv.get('listing_id') == listing_id]
        review_count_listing = len(relevant_reviews)
        review_average_listing = None
        if review_count_listing:
            try:
                review_average_listing = round(
                    sum((rv.get('rating') or 0) for rv in relevant_reviews) / review_count_listing, 2
                )
            except Exception:
                review_average_listing = None

        # Shop languages
        shop_languages = shop_details.get('languages')
        if not isinstance(shop_languages, list):
            shop_languages = []

        # Keyword insights (from example.json: entry.everbee.results)
        everbee = entry.get('everbee') or popular.get('everbee') or {}
        everbee_results = everbee.get('results') or []
        keyword_insights = []
        if isinstance(everbee_results, list):
            for res in everbee_results:
                if not isinstance(res, dict):
                    continue
                kw = res.get('keyword') or res.get('query') or ''
                metrics = res.get('metrics') or {}
                vol = metrics.get('vol')
                comp = metrics.get('competition')
                resp = res.get('response') or {}
                stats_obj = resp.get('stats') or {}
                if vol is None:
                    sv = stats_obj.get('searchVolume')
                    if isinstance(sv, (int, float)):
                        vol = sv
                if comp is None:
                    atl = stats_obj.get('avgTotalListings')
                    if isinstance(atl, (int, float)):
                        comp = atl
                daily_block = resp.get('dailyStats') or {}
                daily_stats_list = daily_block.get('stats') or []
                daily_stats = []
                if isinstance(daily_stats_list, list):
                    for d in daily_stats_list:
                        if isinstance(d, dict):
                            daily_stats.append({
                                'date': d.get('date'),
                                'searchVolume': d.get('searchVolume')
                            })
                keyword_insights.append({
                    'keyword': kw,
                    'vol': vol,
                    'competition': comp,
                    'stats': stats_obj,
                    'dailyStats': daily_stats,
                })

        # Build shop result
        shop_result = {
            'shop_id': sh_shop_id,
            'shop_name': shop_details.get('shop_name'),
            'user_id': shop_details.get('user_id'),
            'created_timestamp': shop_created_ts,
            'created_iso': shop_created_iso,
            'created': shop_created_display,
            'title': shop_details.get('title'),
            'announcement': shop_details.get('announcement'),
            'currency_code': shop_details.get('currency_code'),
            'is_vacation': shop_details.get('is_vacation'),
            'vacation_message': shop_details.get('vacation_message'),
            'sale_message': shop_details.get('sale_message'),
            'digital_sale_message': shop_details.get('digital_sale_message'),
            'updated_timestamp': shop_updated_ts,
            'updated_iso': shop_updated_iso,
            'updated': shop_updated_display,
            'listing_active_count': shop_details.get('listing_active_count'),
            'digital_listing_count': shop_details.get('digital_listing_count'),
            'login_name': shop_details.get('login_name'),
            'accepts_custom_requests': shop_details.get('accepts_custom_requests'),
            'vacation_autoreply': shop_details.get('vacation_autoreply'),
            'url': shop_details.get('url') or shop_obj.get('url'),
            'image_url_760x100': shop_details.get('image_url_760x100'),
            'icon_url_fullxfull': shop_details.get('icon_url_fullxfull'),
            'num_favorers': shop_details.get('num_favorers'),
            'languages': shop_languages,
            'review_average': shop_details.get('review_average'),
            'review_count': shop_details.get('review_count'),
            'sections': shop_sections,
            'reviews': shop_reviews_simplified,
            'shipping_from_country_iso': shop_details.get('shipping_from_country_iso'),
            'transaction_sold_count': shop_details.get('transaction_sold_count'),
        }

        simplified.append({
            'listing_id': listing_id,
            'title': title,
            'url': url,
            'demand': demand,
            'made_at': made_at_display,
            'made_at_iso': made_at_iso,
            'primary_image': { 'image_url': image_url, 'srcset': srcset },

            # Detail fields
            'user_id': user_id,
            'shop_id': shop_id or sh_shop_id,
            'state': state,
            'description': description,

            # Arrays
            'tags': tags,
            'materials': materials,
            'keywords': keywords,
            'sections': shop_sections,
            'reviews': shop_reviews_simplified,

            # Listing-level review metrics
            'review_average': review_average_listing,
            'review_count': review_count_listing,

            # Keyword insights for charts
            'keyword_insights': keyword_insights,

            # Sale info (+ computed price)
            'buyer_promotion_name': buyer_promotion_name,
            'buyer_shop_promotion_name': buyer_shop_promotion_name,
            'buyer_promotion_description': buyer_promotion_description,
            'buyer_applied_promotion_description': buyer_applied_promotion_description,
            'sale_percent': sale_percent,
            'sale_price_value': sale_price_value,
            'sale_price_display': sale_price_display,
            'sale_subtotal_after_discount': sale_subtotal_after_discount,
            'sale_original_price': sale_original_price,

            # Price tokens
            'price_amount': price_amount,
            'price_divisor': price_divisor,
            'price_currency': price_currency,
            'price_value': price_value,
            'price_display': price_display,

            # Extra detail
            'last_modified_timestamp': last_modified_ts,
            'last_modified_iso': last_modified_iso,
            'last_modified': last_modified_display,
            'quantity': quantity,
            'num_favorers': num_favorers,
            'listing_type': listing_type,
            'file_data': file_data,
            'views': views,

            # Rich shop
            'shop': shop_result,
        })

    return JsonResponse({
        'session_id': session.id,
        'session_keyword': session.keyword,
        'started_at': session.created_at.isoformat(),
        'entries': simplified
    })

@login_required
def bulk_research_list(request):
    qs = BulkResearchSession.objects.filter(user=request.user).order_by('-created_at')
    data = []
    for s in qs:
        data.append({
            'id': s.id,
            'keyword': s.keyword,
            'desired_total': s.desired_total,
            'status': s.status,
            'progress': s.progress or BulkResearchSession.build_initial_progress(s.desired_total),
            'created_at': s.created_at.isoformat()
        })
    return JsonResponse({'sessions': data})

def _candidate_start_urls():
    base = UPSTREAM_BASE.rstrip('/')
    return [
        f"{base}/bulk-research/start",
        f"{base}/bulk-research/start/",
        f"{base}/api/bulk-research/start",
        f"{base}/api/bulk-research/start/",
        f"{base}/api/bulk_research/start",
        f"{base}/api/bulk_research/start/",
        f"{base}/bulk_research/start",
        f"{base}/bulk_research/start/",
    ]

def _candidate_start_payloads(user_id: str, keyword: str, desired_total: int):
    return [
        {'user_id': user_id, 'keyword': keyword, 'desired_total': desired_total},
        {'user_id': user_id, 'keyword': keyword, 'total': desired_total},
        {'user_id': user_id, 'keyword': keyword, 'products_count': desired_total},
        {'keyword': keyword, 'desired_total': desired_total},
    ]

def _try_upstream_start(user_id: str, keyword: str, desired_total: int, timeout_sec: int = 20):
    headers = {'Accept': 'application/json'}
    attempts = []
    for url in _candidate_start_urls():
        for payload in _candidate_start_payloads(user_id, keyword, desired_total):
            try:
                resp = requests.post(url, json=payload, headers=headers, timeout=timeout_sec)
            except Exception as e:
                attempts.append({'url': url, 'error': str(e)})
                continue
            if 200 <= resp.status_code < 300:
                try:
                    data = resp.json()
                except Exception:
                    data = {}
                job_id = data.get('job_id') or data.get('id') or data.get('session_id') or data.get('jobId')
                if job_id:
                    return {'job_id': str(job_id), 'url': url, 'payload': payload, 'raw': data}
                attempts.append({'url': url, 'status': resp.status_code, 'raw': resp.text[:300]})
            else:
                attempts.append({'url': url, 'status': resp.status_code, 'raw': resp.text[:200]})
    return {'error': 'No upstream start endpoint accepted', 'attempts': attempts}

