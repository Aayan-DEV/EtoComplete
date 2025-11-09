import json
import threading
import time
from collections import deque
from typing import Dict, Optional, Any, List

import requests
from django.conf import settings
from django.utils import timezone

from .models import BulkResearchSession

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

    def start(self):
        if not self.thread.is_alive():
            self.thread.start()

    def _persist_progress(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(progress=self.progress)
        except Exception:
            pass

    def _persist_entries(self):
        try:
            BulkResearchSession.objects.filter(id=self.session_id).update(
                result_file=json.dumps({'entries': self.entries_snapshot})
            )
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

        # Capture entries snapshot when upstream provides them
        try:
            entries = None
            if isinstance(evt.get('megafile'), dict) and isinstance(evt['megafile'].get('entries'), list):
                entries = evt['megafile']['entries']
            elif isinstance(evt.get('entries'), list):
                entries = evt['entries']
            if entries is not None:
                # Keep in-memory for real-time result requests
                self.entries_snapshot = entries
                # Optionally persist as we go for durability; leave final save on completion
        except Exception:
            pass

        # Completed when all remaining reach zero
        try:
            if all((self.progress.get(k, {}).get('remaining', 1) == 0) for k in ('search', 'splitting', 'demand', 'keywords')):
                if self.status != 'completed':
                    self.status = 'completed'
                    # Save final entries to DB
                    if self.entries_snapshot:
                        self._persist_entries()
                    self._mark_completed()
                    self._append_event({'stage': 'status', 'status': 'completed'})
        except Exception:
            pass

    def _run(self):
        try:
            upstream = requests.post(
                UPSTREAM_STREAM_URL,
                json={
                    'user_id': self.user_id,
                    'keyword': self.keyword,
                    'desired_total': self.desired_total
                },
                headers={
                    'Accept': 'text/event-stream',
                    'Content-Type': 'application/json'
                },
                stream=True,
                timeout=120
            )
        except Exception as e:
            with self.lock:
                self.status = 'failed'
                self._append_event({'stage': 'error', 'error': f'Upstream stream error: {e}'})
                self._append_event({'stage': 'status', 'status': 'failed'})
            return

        if not upstream.ok:
            with self.lock:
                self.status = 'failed'
                self._append_event({'stage': 'error', 'error': f'Upstream stream failed ({upstream.status_code})', 'raw': upstream.text[:300]})
                self._append_event({'stage': 'status', 'status': 'failed'})
            try:
                upstream.close()
            except Exception:
                pass
            return

        try:
            for raw in upstream.iter_lines(decode_unicode=True):
                if self.stop_event.is_set():
                    break
                if raw is None:
                    continue
                line = (raw or '').strip()
                if not line:
                    # keepalive for SSE
                    continue
                if line.startswith(':'):
                    # comment
                    continue
                if line.startswith('data:'):
                    payload = line[5:].strip()
                    try:
                        evt = json.loads(payload)
                    except Exception:
                        # Non-JSON payload; still forward
                        evt = {'raw': payload}
                    with self.lock:
                        self._update_from_event(evt)
                        self._append_event(evt)
                time.sleep(0.01)
        finally:
            try:
                upstream.close()
            except Exception:
                pass
            # If upstream ended but not marked completed, close out gracefully
            with self.lock:
                if self.status == 'ongoing':
                    if all((self.progress.get(k, {}).get('remaining', 1) == 0) for k in ('search', 'splitting', 'demand', 'keywords')):
                        self.status = 'completed'
                        if self.entries_snapshot:
                            self._persist_entries()
                        self._mark_completed()
                        self._append_event({'stage': 'status', 'status': 'completed'})

    def subscribe(self):
        # Generator yielding SSE events from in-memory buffer
        idx = 0
        while not self.stop_event.is_set():
            # Emit any new events
            while idx < len(self.event_buffer):
                evt = self.event_buffer[idx]
                idx += 1
                yield evt
            # Lightweight idle
            time.sleep(0.2)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                'status': self.status,
                'progress': self.progress.copy(),
                'entries': list(self.entries_snapshot),
            }

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