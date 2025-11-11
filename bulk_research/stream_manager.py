import json
import threading
import time
from collections import deque
from typing import Dict, Optional, Any, List

import requests
from django.conf import settings
from django.utils import timezone
from django.db import connection, close_old_connections
from .models import BulkResearchSession
from requests.exceptions import ChunkedEncodingError, ConnectionError, ReadTimeout

# Upstream SSE URL; prefer settings if provided
UPSTREAM_STREAM_URL = getattr(settings, 'UPSTREAM_STREAM_URL', "http://136.116.10.105:8001/run/stream")


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


def _initial_progress(desired_total: int) -> Dict[str, Dict[str, int]]:
    # Matches BulkResearchSession.build_initial_progress
    return {
        'search': {'total': desired_total, 'remaining': desired_total},
        'splitting': {'total': desired_total, 'remaining': desired_total},
        'demand': {'total': desired_total, 'remaining': desired_total},
        'keywords': {'total': desired_total, 'remaining': desired_total},
    }


class SessionWorker:
    def __init__(self, session: BulkResearchSession, user_id: str):
        self.session_id = session.id
        self.user_id = user_id
        self.keyword = session.keyword
        self.desired_total = session.desired_total
        self.status = 'ongoing'
        self.progress: Dict[str, Dict[str, int]] = session.progress or _initial_progress(self.desired_total)
        self.entries_snapshot: List[Dict[str, Any]] = []
        self.event_buffer: deque = deque(maxlen=2000)  # recent SSE events
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"BulkSession-{self.session_id}", daemon=True)
        # External upstream session id (generated at start)
        self.upstream_session_id = session.external_session_id
        self._last_persist_ts = 0.0
        self._last_persist_len = 0

    def start(self):
        if not self.thread.is_alive():
            self.thread.start()

    def _persist_progress(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(progress=self.progress)
        except Exception:
            pass
        finally:
            try:
                connection.close()  # release DB slot after each write
            except Exception:
                pass

    def _persist_entries(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(
                result_file=json.dumps({'entries': self.entries_snapshot})
            )
        except Exception:
            pass
        finally:
            try:
                connection.close()  # release DB slot after each write
            except Exception:
                pass

    def _mark_completed(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(
                status='completed',
                completed_at=timezone.now()
            )
        except Exception:
            pass
        finally:
            try:
                connection.close()  # release DB slot after each write
            except Exception:
                pass

    def _persist_entries_throttled(self, min_interval_sec: float = 3.0, min_growth: int = 5):
        try:
            now = time.time()
            cur_len = len(self.entries_snapshot)
            if (cur_len == 0):
                return
            should_by_time = (now - self._last_persist_ts) >= min_interval_sec
            grew_enough = (cur_len - self._last_persist_len) >= min_growth
            if should_by_time or grew_enough:
                self._persist_entries()
                self._last_persist_ts = now
                self._last_persist_len = cur_len
        except Exception:
            pass

    def _mark_completed(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(
                status='completed',
                completed_at=timezone.now()
            )
        except Exception:
            pass

    def _append_event(self, evt: Dict[str, Any]):
        try:
            self.event_buffer.append(evt)
        except Exception:
            # In case of non-serializable event shapes, fallback to string
            self.event_buffer.append({'raw': evt})

    def _update_from_event(self, evt: Dict[str, Any]):
        stage = (evt.get('stage') or '').lower()
        remaining = evt.get('remaining')
        total = evt.get('total')
        key = _map_stage_key(stage)
        if key:
            obj = self.progress.get(key) or {'total': 0, 'remaining': 0}
            if isinstance(total, int):
                obj['total'] = total
            if isinstance(remaining, int):
                obj['remaining'] = remaining
            self.progress[key] = obj
            self._persist_progress()

        # Capture entries snapshot for both batch and single-item events
        try:
            entries = None
            if isinstance(evt.get('megafile'), dict) and isinstance(evt['megafile'].get('entries'), list):
                entries = evt['megafile']['entries']
            elif isinstance(evt.get('entries'), list):
                entries = evt['entries']
            if entries is not None:
                self.entries_snapshot = entries
                self._persist_entries_throttled()
            else:
                # Single-item variants
                added = False
                if isinstance(evt.get('entry'), dict):
                    self.entries_snapshot.append(evt['entry']); added = True
                elif isinstance(evt.get('item'), dict):
                    self.entries_snapshot.append(evt['item']); added = True
                elif isinstance(evt.get('popular_info'), dict) or isinstance(evt.get('popular'), dict):
                    # Event itself resembles an entry; keep it for downstream mapping
                    self.entries_snapshot.append(evt); added = True
                if added:
                    self._persist_entries_throttled()
        except Exception:
            pass

        # Completed when all remaining reach zero
        try:
            if all((self.progress.get(k, {}).get('remaining', 1) == 0) for k in ('search', 'splitting', 'demand', 'keywords')):
                if self.status != 'completed':
                    self.status = 'completed'
                    if self.entries_snapshot:
                        self._persist_entries()
                    self._mark_completed()
                    self._append_event({'stage': 'status', 'status': 'completed'})
        except Exception:
            pass

    def _run(self):
        attempts = 0
        max_attempts = 5
        backoffs = [1, 2, 5, 10, 15]
        upstream = None

        while not self.stop_event.is_set():
            # Ensure fresh DB connection per loop to avoid stale/persistent sessions
            try:
                close_old_connections()
            except Exception:
                pass

            try:
                upstream = requests.post(
                    UPSTREAM_STREAM_URL,
                    json={
                        'user_id': self.user_id,
                        'keyword': self.keyword,
                        'desired_total': self.desired_total,
                        'session_id': self.upstream_session_id,
                    },
                    headers={
                        'Accept': 'text/event-stream',
                        'Content-Type': 'application/json'
                    },
                    stream=True,
                    timeout=(10, 120)  # connect, read
                )

                if not upstream.ok:
                    with self.lock:
                        self.status = 'failed'
                        self._append_event({'stage': 'error', 'error': f'Upstream stream failed ({upstream.status_code})', 'raw': upstream.text[:300]})
                        self._append_event({'stage': 'status', 'status': 'failed'})
                    return

                for raw in upstream.iter_lines(decode_unicode=True):
                    if self.stop_event.is_set():
                        break
                    if raw is None:
                        continue
                    line = (raw or '').strip()
                    if not line or line.startswith(':'):
                        continue
                    if line.startswith('data:'):
                        payload = line[5:].strip()
                        try:
                            evt = json.loads(payload)
                        except Exception:
                            evt = {'raw': payload}
                        with self.lock:
                            self._update_from_event(evt)
                            self._append_event(evt)
                    # Opportunistic persistence tick (in case events are sparse)
                    self._persist_entries_throttled(min_interval_sec=5.0, min_growth=3)
                    time.sleep(0.01)

                # Normal end-of-stream: flush snapshot and exit
                with self.lock:
                    if self.entries_snapshot:
                        self._persist_entries()
                    self._append_event({
                        'stage': 'snapshot',
                        'status': self.status,
                        'progress': self.progress,
                        'entries_count': len(self.entries_snapshot)
                    })
                return

            except ChunkedEncodingError as e:
                attempts += 1
                with self.lock:
                    self._append_event({'stage': 'error', 'error': f'Chunked encoding ended prematurely: {e}', 'attempt': attempts})
                if attempts >= max_attempts:
                    with self.lock:
                        self.status = 'failed'
                        if self.entries_snapshot:
                            self._persist_entries()
                        self._append_event({'stage': 'status', 'status': 'failed'})
                    return
                time.sleep(backoffs[min(attempts - 1, len(backoffs) - 1)])
                continue

            except (ConnectionError, ReadTimeout) as e:
                attempts += 1
                with self.lock:
                    self._append_event({'stage': 'error', 'error': f'Upstream connection error: {e}', 'attempt': attempts})
                if attempts >= max_attempts:
                    with self.lock:
                        self.status = 'failed'
                        if self.entries_snapshot:
                            self._persist_entries()
                        self._append_event({'stage': 'status', 'status': 'failed'})
                    return
                time.sleep(backoffs[min(attempts - 1, len(backoffs) - 1)])
                continue

            except Exception as e:
                with self.lock:
                    self.status = 'failed'
                    self._append_event({'stage': 'error', 'error': f'Worker crashed: {e}'})
                    self._append_event({'stage': 'status', 'status': 'failed'})
                    if self.entries_snapshot:
                        self._persist_entries()
                return

            finally:
                try:
                    if upstream is not None:
                        upstream.close()
                except Exception:
                    pass

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                'status': self.status,
                'progress': self.progress.copy(),
                'entries': list(self.entries_snapshot),
            }

    def subscribe(self):
        # Generator yielding SSE events from in-memory buffer
        idx = 0
        last_emit = time.time()
        heartbeat_interval = 15  # seconds
        while not self.stop_event.is_set():
            emitted = False
            while idx < len(self.event_buffer):
                evt = self.event_buffer[idx]
                idx += 1
                last_emit = time.time()
                emitted = True
                yield evt
            # Lightweight idle
            if not emitted and (time.time() - last_emit) >= heartbeat_interval:
                last_emit = time.time()
                # harmless heartbeat; ignored by UI mapStage
                yield {'stage': 'heartbeat', 'ts': int(last_emit)}
            time.sleep(0.2)

    def stop(self):
        self.stop_event.set()


class BulkStreamManager:
    def __init__(self):
        self.workers: Dict[int, SessionWorker] = {}
        self.lock = threading.Lock()

    def ensure_worker(self, session: BulkResearchSession, user_id: str):
        with self.lock:
            w = self.workers.get(session.id)
            if w and w.thread.is_alive():
                return
            # Backfill external_session_id for legacy sessions if missing
            if not getattr(session, 'external_session_id', None):
                try:
                    import re, random
                    ts = timezone.now().strftime('%Y%m%d%H%M%S')
                    slug = re.sub(r'[^a-z0-9]+', '-', (session.keyword or '').lower()).strip('-')[:30]
                    rand5 = ''.join(random.choice('0123456789') for _ in range(5))
                    external_id = f"sess-{session.user.username}-{slug}-{session.desired_total}-{ts}-{rand5}"
                    BulkResearchSession.objects.filter(id=session.id).update(external_session_id=external_id)
                    session.external_session_id = external_id
                except Exception:
                    pass
            w = SessionWorker(session, user_id=user_id)
            self.workers[session.id] = w
            w.start()

    def subscribe_events(self, session_id: int) -> Optional[Any]:
        w = self.workers.get(session_id)
        if not w:
            return None
        return w.subscribe()

    def get_snapshot(self, session_id: int) -> Optional[Dict[str, Any]]:
        w = self.workers.get(session_id)
        if not w:
            return None
        return w.snapshot()


# Single manager instance
bulk_stream_manager = BulkStreamManager()