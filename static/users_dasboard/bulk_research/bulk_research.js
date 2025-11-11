(function () {
  var sessionsButton = document.getElementById('sessions-button');
  var sessionsPanel = document.getElementById('sessions-panel');
  var sessionsClose = document.getElementById('sessions-close');
  var sessionsList = document.getElementById('sessions-list');
  var addBtn = document.getElementById('add-session-btn');
  var wizard = document.getElementById('wizard');
  var step1 = wizard ? wizard.querySelector('[data-step="1"]') : null;
  var step2 = wizard ? wizard.querySelector('[data-step="2"]') : null;
  var keywordInput = document.getElementById('keyword-input');
  var totalInput = document.getElementById('total-input');
  var step1Next = document.getElementById('step1-next');
  var step2Done = document.getElementById('step2-done');
  var wizardClose = document.getElementById('wizard-close');

  var resultsTitle = document.getElementById('results-title');
  var productsGrid = document.getElementById('products-grid');
  var resultsSelect = document.getElementById('results-session-select');
  var resultsLoading = document.getElementById('results-loading');
  var resultsBack = document.getElementById('results-back');  // header-level back button

  // Filter bar elements
  var sortMetricSelect = document.getElementById('sort-metric-select');
  var sortOrderSelect = document.getElementById('sort-order-select');

  // Current sort state (default to Demand, High → Low as requested)
  var currentSortMetric = (sortMetricSelect && sortMetricSelect.value) || 'demand';
  var currentSortOrder = (sortOrderSelect && sortOrderSelect.value) || 'desc';

  var sessions = Array.isArray(window.INITIAL_SESSIONS) ? window.INITIAL_SESSIONS.slice() : [];
  var sessionResultsCache = {}; // { id: entries[] }
  var sessionCounts = {};       // { id: number }
  var streams = {};             // { id: EventSource }
  var streamRetries = {};       // { id: number }
  var POLL_INTERVAL_MS = 2000;
  var pollTimer = null;

  // Track last SSE heartbeat to determine if a stream is truly alive
  var streamLastHeartbeat = {}; // { id: timestamp }
    var HEARTBEAT_STALE_MS = 5000;

    // Reconnect timing and state
    var STALE_THRESHOLD_MS = 2000;           // extra 2s before countdown
    var COUNTDOWN_SECONDS = 4;               // 4,3,2,1
    var ENABLE_AFTER_MS = STALE_THRESHOLD_MS + COUNTDOWN_SECONDS * 1000;      // 6s
    var AUTO_RECONNECT_AFTER_MS = ENABLE_AFTER_MS + 4000;                     // 10s
    var reconnectUiTimer = null;             // interval to update button labels
    var autoReconnectIssuedAt = {};          // { id: timestamp }

  // Returns true only when the stream is OPEN and has a recent heartbeat
  function isStreamAlive(sessionId) {
    var es = streams && streams[sessionId];
    if (!es || typeof es.readyState !== 'number') return false;
    if (es.readyState !== 1) return false; // require OPEN
    var last = streamLastHeartbeat[sessionId] || 0;
    return (Date.now() - last) <= HEARTBEAT_STALE_MS;
  }

  // Auto-refresh for aggregated ("All") view: 3s interval
  var AGG_REFRESH_INTERVAL_MS = 3000;
  var aggregatedRefreshTimer = null;

  // Current view and sort state
  var lastEntriesRaw = [];
  // Ensure we track current view entries for refreshes
  var currentViewEntries = [];

  // Storage keys for selection and scroll
  var SELECT_STORAGE_KEY = 'eto_bulk_selected_session';
  var SCROLL_STORAGE_KEY = 'eto_bulk_scroll_y';

  var REOPEN_STORAGE_KEY = 'eto_bulk_reopen_after_update';
  var pendingReopen = null;
  try {
    var rr = localStorage.getItem(REOPEN_STORAGE_KEY);
    if (rr) { pendingReopen = JSON.parse(rr || 'null') || null; }
  } catch (_) {}
  function clearPendingReopen() {
    try { localStorage.removeItem(REOPEN_STORAGE_KEY); } catch (_) {}
    pendingReopen = null;
  }

  var allSessionsController = null; // AbortController for aggregated fetches
  
  // Numeric price helper (prefers sale)
  function priceOf(entry) {
    // Prefer sale subtotal string like "$10.17"
    var sub = entry && entry.sale_subtotal_after_discount;
    if (typeof sub === 'string' && sub.trim()) {
      try {
        var cleaned = sub.trim().replace(/[^0-9.]/g, '');
        var v = parseFloat(cleaned);
        if (!isNaN(v) && isFinite(v)) return v;
      } catch (_) {}
    }
    if (entry && typeof entry.sale_price_value === 'number' && isFinite(entry.sale_price_value)) return entry.sale_price_value;
    if (entry && typeof entry.price_value === 'number' && isFinite(entry.price_value)) return entry.price_value;
    var priceObj = entry && entry.price || {};
    var amount = priceObj.amount, divisor = priceObj.divisor;
    if (typeof amount === 'number' && typeof divisor === 'number' && divisor) return amount / divisor;
    return null;
  }

  // Attach streams for all ongoing sessions at load (resumes live after refresh)
  function ensureStreamsAttached() {
    sessions.forEach(function (s) {
      if (s && s.status === 'ongoing') {
        attachStream(s.id);
      }
    });
  }
  ensureStreamsAttached();

  // SSE stream with auto-reconnect and snapshot hydration
  function attachStream(sessionId) {
    try { if (streams[sessionId]) { streams[sessionId].close(); } } catch (_) {}

    var url = window.BULK_RESEARCH_STREAM_URL_BASE + sessionId + '/';
    var es;
    try {
      es = new EventSource(url);
    } catch (e) {
      alert('Stream failed to open: ' + (e && e.message ? e.message : String(e)) + '\nURL: ' + url);
      return;
    }
    streams[sessionId] = es;

    if (typeof streamRetries === 'object') {
      streamRetries[sessionId] = 0;
      es.onopen = function () {
        streamRetries[sessionId] = 0;
        // Do not mark heartbeat here; only mark on actual messages
        try { renderSessionsList(); } catch (_) {}
      };
    }

    es.onmessage = function (ev) {
      // Expect SSE 'data: {...}'
      if (!ev || typeof ev.data !== 'string') {
        console.warn('SSE message missing data string for session', sessionId, ev);
        return;
      }
      var obj;
      try {
        obj = JSON.parse(ev.data);
      } catch (e) {
        console.warn('SSE non-JSON line for session', sessionId, ev.data);
        return;
      }
      try {
        handleStreamUpdate(sessionId, obj);
        streamLastHeartbeat[sessionId] = Date.now();
        autoReconnectIssuedAt[sessionId] = 0;
      } catch (e) {
        alert('Stream update handling failed: ' + e.message);
        console.error('Stream update error', e, obj);
      }
    };

    es.onerror = function (err) {
      try { es.close(); } catch (_) {}
      try { delete streams[sessionId]; } catch (_) {}
      try { delete streamLastHeartbeat[sessionId]; } catch (_) {}
      try { renderSessionsList(); } catch (_) {}
      try { scheduleReconnect(sessionId); } catch (_) {}
      console.warn('Stream error for session', sessionId, err);
    };
}

// Start heartbeat-driven reconnect UI updates
  (function startReconnectUiTimer() {
    if (reconnectUiTimer) return;
    reconnectUiTimer = setInterval(function updateReconnectUi() {
      if (!sessionsList) return;
      var now = Date.now();
      sessions.forEach(function (s) {
        if (String(s.status).toLowerCase() !== 'ongoing') return;
        var row = sessionsList.querySelector('.session-row[data-session-id="' + s.id + '"]');
        if (!row) return;
        var btn = row.querySelector('.reconnect-session');
        if (!btn) return;

        var alive = isStreamAlive(s.id);
        var last = streamLastHeartbeat[s.id] || 0;
        var age = now - last;

        if (alive) {
          btn.disabled = true;
          btn.textContent = 'Reconnect';
          return;
        }
        if (age <= STALE_THRESHOLD_MS) {
          btn.disabled = true;
          btn.textContent = 'Reconnect';
          return;
        }
        if (age <= ENABLE_AFTER_MS) {
          var remaining = Math.ceil((ENABLE_AFTER_MS - age) / 1000);
          btn.disabled = true;
          btn.textContent = String(remaining);
          return;
        }
        // Enable manual reconnect after 6s stale
        btn.disabled = false;
        btn.textContent = 'Reconnect';

        // Auto reconnect after 10s stale (throttled)
        if (age > AUTO_RECONNECT_AFTER_MS) {
          var issued = autoReconnectIssuedAt[s.id] || 0;
          if (!issued || now - issued > AUTO_RECONNECT_AFTER_MS) {
            autoReconnectIssuedAt[s.id] = now;
            reconnectSession(s.id, btn);
          }
        }
      });
    }, 500);
  })();

function reconnectSession(sessionId, reconBtn) {
    var endpoint = '/api/bulk-research/reconnect/' + sessionId + '/';
    if (reconBtn) { reconBtn.disabled = true; reconBtn.textContent = 'Reconnecting…'; }

    fetch(endpoint, {
        method: 'POST',
        headers: Object.assign({ 'Accept': 'application/json' }, csrfHeader()),
        credentials: 'same-origin'
    })
    .then(function (r) {
        return r.json().catch(function(){ return {}; }).then(function (body) {
            if (!r.ok) {
                var msg = (body && body.error) || ('Reconnect failed (' + r.status + ')');
                throw new Error(msg);
            }
            return body;
        });
    })
    .then(function (out) {
        var local = findSession(sessionId) || { id: sessionId };
        if (out && typeof out.status === 'string') local.status = out.status;
        if (out && out.progress) local.progress = out.progress;
        updateSession(local);

        var isCompleted = String(out && out.status || '').toLowerCase() === 'completed';

        function entriesFromReconnect(o) {
            if (o && Array.isArray(o.entries)) return o.entries;
            if (o && o.megafile && Array.isArray(o.megafile.entries)) return o.megafile.entries;
            return [];
        }

        showToast(isCompleted ? 'Session Completed.' : 'Reconnected — resuming live updates…', 'success');

        if (isCompleted) {
            var respEntries = entriesFromReconnect(out);
            var isSelected = resultsSelect && String(resultsSelect.value) === String(sessionId);
            if (Array.isArray(respEntries) && respEntries.length > 0) {
                var sorted = applySorting(respEntries);
                saveCachedSessionEntries(sessionId, sorted);
                if (isSelected) {
                    try { progressiveRenderSession(sessionId, sorted, productsGrid.children.length); }
                    catch (e) { console.warn('Progressive render fallback', e); renderProductsGrid(sorted); }
                } else if (resultsSelect && resultsSelect.value === '__all__') {
                    try { renderAggregatedFromCache(); } catch (e) { console.error('Re-render aggregated after cache update failed', e); }
                }
            } else {
                if (isSelected) {
                    updateResultsTitleForSession(local);
                    loadSessionResults(sessionId, true);
                } else if (resultsSelect && resultsSelect.value === '__all__') {
                    loadAllSessionsResults();
                }
            }
            updatePolling();
        } else {
            attachStream(sessionId);
            updatePolling();
        }
    })
    .catch(function (err) {
        showToast('Reconnect failed: ' + err.message, 'error');
    })
    .finally(function () {
        showLoading(false);
        if (reconBtn) { reconBtn.textContent = 'Reconnect'; reconBtn.disabled = false; }
    });
}

// Helpers for aggregated progressive rendering
function getAggregatedEntries() {
    var ids = sessions.map(function (s) { return s && s.id; }).filter(Boolean);
    var merged = [];
    ids.forEach(function (id) {
        var arr = sessionResultsCache[id];
        if (Array.isArray(arr) && arr.length) merged = merged.concat(arr);
    });
    return applySorting(merged);
}

var aggregatedProgressTimer = null;
function progressiveRenderAggregated(initialCount) {
    // ... existing code ...
    var entries = getAggregatedEntries();
    var total = entries.length;
    var count = Math.max(0, Math.min(initialCount || 0, total));
    var batch = 8;
    var delayMs = 100;

    if (aggregatedProgressTimer) { try { clearTimeout(aggregatedProgressTimer); } catch (_) {} aggregatedProgressTimer = null; }

    function step() {
        if (!resultsSelect || resultsSelect.value !== '__all__') { aggregatedProgressTimer = null; return; }
        count = Math.min(total, count + batch);
        try { renderProductsGrid(entries.slice(0, count)); } catch (e) { console.error('Aggregated progressive render failed', e); }
        if (count < total) {
            aggregatedProgressTimer = setTimeout(step, delayMs);
        } else {
            aggregatedProgressTimer = null;
        }
    }

    // Initial quick paint
    try { renderProductsGrid(entries.slice(0, Math.min(count || 8, total))); } catch (e) { console.error('Aggregated initial render failed', e); }
    lastEntriesRaw = entries;
    currentViewEntries = entries.slice(0, Math.min(count || 8, total));
    if (Math.min(count || 8, total) < total) aggregatedProgressTimer = setTimeout(step, delayMs);
}

    // renderAggregatedFromCache: merge cached entries across sessions and render
    function renderAggregatedFromCache() {
        var ids = sessions.map(function (s) { return s && s.id; }).filter(Boolean);
        var allEntries = [];
        ids.forEach(function (id) {
          var list = sessionResultsCache[id];
          if (Array.isArray(list) && list.length) {
            allEntries = allEntries.concat(list);
          }
        });
        lastEntriesRaw = allEntries;
        currentViewEntries = allEntries;
        renderProductsGrid(applySorting(allEntries));
        upsertResultsSelect();
    }

  function loadAllSessionsResults() {
    // ... existing code ...
    // No spinner; we progressively render instead
    ensureStreamsAttached();

    // Abort any previous aggregated request
    if (allSessionsController) { try { allSessionsController.abort(); } catch (_) {} }
    allSessionsController = new AbortController();
    var signal = allSessionsController.signal;

    var ids = sessions.map(function (s) { return s && s.id; }).filter(Boolean);
    if (ids.length === 0) {
        lastEntriesRaw = [];
        currentViewEntries = [];
        renderProductsGrid([]);
        upsertResultsSelect();
        return;
    }

    // Seed from whatever cache exists and start progressive rendering
    try { progressiveRenderAggregated(productsGrid.children.length); } catch (e) { console.error('Render aggregated from cache failed', e); }

    // Fetch sessions:
    // - Always fetch ongoing sessions (to pick up new products).
    // - Fetch completed sessions only if cache is missing.
    var remaining = 0;
    ids.forEach(function (id) {
        var s = findSession(id);
        var isOngoing = s && String(s.status).toLowerCase() === 'ongoing';

        // Prefer cached data; if missing, try sessionStorage hydrate
        var cached = sessionResultsCache[id];
        if (!Array.isArray(cached) || cached.length === 0) {
            var hydrated = getCachedSessionEntries(id);
            if (Array.isArray(hydrated) && hydrated.length) {
                cached = hydrated;
            }
        }
        var haveCache = Array.isArray(cached) && cached.length > 0;

        if (haveCache && !isOngoing) {
            sessionCounts[id] = cached.length;
            return; // no need to fetch completed with cache
        }

        remaining += 1;

        var url = window.BULK_RESEARCH_RESULT_URL_BASE + id + '/';
        fetch(url, { credentials: 'same-origin', signal: signal, headers: { 'Accept': 'application/json' } })
            .then(function (r) {
                var isJson = ((r.headers.get('Content-Type') || '').toLowerCase().indexOf('application/json') !== -1);
                return r.text().then(function (txt) {
                    var body;
                    try { body = isJson ? JSON.parse(txt || '{}') : {}; } catch (e) { body = { parse_error: e.message, raw: (txt || '').slice(0, 500) }; }
                    if (!r.ok) {
                        var msg = 'Aggregated results request failed (' + r.status + ') for session ' + id + '. URL: ' + url + '.';
                        throw new Error(msg);
                    }
                    return Array.isArray(body.entries) ? body.entries
                        : (body.megafile && Array.isArray(body.megafile.entries) ? body.megafile.entries : []);
                });
            })
            .catch(function (err) {
                console.warn('Aggregated: failed to fetch session', id, err);
                return [];
            })
            .then(function (entries) {
                var sorted = applySorting(entries);
                // Save to both memory and sessionStorage; keeps single-session views instant later
                saveCachedSessionEntries(id, sorted);
                // Progressive aggregated append using current grid count
                try { progressiveRenderAggregated(productsGrid.children.length); } catch (e) { console.error('Aggregated progressive step failed', e); }
            })
            .finally(function () {
                remaining -= 1;
            });
    });
}

  function scheduleReconnect(sessionId) {
  var s = findSession(sessionId);
  if (!s || s.status === 'completed' || s.status === 'failed') return;
  var attempt = (streamRetries[sessionId] || 0) + 1;
  streamRetries[sessionId] = attempt;
  var delay = Math.min(15000, 500 * Math.pow(2, attempt - 1)); // 0.5s → 15s
  setTimeout(function () {
    attachStream(sessionId);
      var selected = resultsSelect && resultsSelect.value;
      if (selected === '__all__') {
        loadAllSessionsResults();
      }
    }, delay);
}

  // Polling fallback: merge status/progress from backend every 2s
  function pollOnce() {
  // Gate polling to only when any session is ongoing
  var anyOngoing = Array.isArray(sessions) && sessions.some(function (s) { return String(s.status).toLowerCase() === 'ongoing'; });
  if (!anyOngoing) return;

  fetch(window.BULK_RESEARCH_LIST_URL, { credentials: 'same-origin' })
    .then(function (r) { return r.json().catch(function(){ return {}; }).then(function (j) { if (!r.ok) throw new Error(j && (j.error || ('Failed (' + r.status + ')'))); return j; }); })
    .then(function (json) {
      var arr = Array.isArray(json.sessions) ? json.sessions : [];
      arr.forEach(function (remote) {
        var local = findSession(remote.id);
        if (!local) return;
        var changed = false;
        if (typeof remote.status === 'string' && remote.status !== local.status) {
          local.status = remote.status;
          changed = true;
        }
        if (remote.progress && typeof remote.progress === 'object') {
            // Shallow merge per stage
            local.progress = local.progress || {};
            ['search','splitting','demand','keywords'].forEach(function (k) {
              var rp = remote.progress[k];
              if (rp && (typeof rp.total === 'number' || typeof rp.remaining === 'number')) {
                var lp = local.progress[k] || { total: local.desired_total || 0, remaining: local.desired_total || 0 };
                var newTotal = (typeof rp.total === 'number') ? rp.total : lp.total;
                var newRem = (typeof rp.remaining === 'number') ? rp.remaining : lp.remaining;
                if (newTotal !== lp.total || newRem !== lp.remaining) {
                  local.progress[k] = { total: newTotal, remaining: newRem };
                  changed = true;
                }
              }
            });
          }
          if (typeof remote.entries_count === 'number' && remote.entries_count !== local.entries_count) {
          local.entries_count = remote.entries_count;
          changed = true;
        }
        // If remote says completed, normalize progress to full totals
        if (String(local.status).toLowerCase() === 'completed') {
          normalizeProgressForCompleted(local);
          changed = true;
        }
        if (changed) updateSession(local);
      });
      updatePolling();
    })
    .catch(function () { /* silent */ });
}

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }
  function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
// Dynamically start/stop polling based on active sessions
function updatePolling() {
    // Stop polling unless there’s a selected, ongoing session or “All” with any ongoing
    var selected = (resultsSelect && resultsSelect.value) || '';
    var shouldPoll = false;

    if (selected === '__all__') {
        shouldPoll = Array.isArray(sessions) && sessions.some(function (s) {
            return String(s.status).toLowerCase() === 'ongoing';
        });
    } else if (selected) {
        var sel = findSession(selected);
        shouldPoll = !!(sel && String(sel.status).toLowerCase() === 'ongoing');
    } else {
        shouldPoll = false;
    }

    if (shouldPoll) {
        if (!pollTimer) { pollOnce(); pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS); }
    } else {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
}
  // Auto-refresh controls for "All" aggregated mode
function startAggregatedAutoRefresh() {
    if (aggregatedRefreshTimer) return;
    aggregatedRefreshTimer = setInterval(function () {
        try {
            if (!resultsSelect || resultsSelect.value !== '__all__') return;
            // Only refresh when any session is ongoing
            var anyOngoing = Array.isArray(sessions) && sessions.some(function (s) { return String(s.status).toLowerCase() === 'ongoing'; });
            if (!anyOngoing) return;
            loadAllSessionsResults();
        } catch (e) {
            console.warn('Aggregated auto refresh error', e);
        }
    }, AGG_REFRESH_INTERVAL_MS);
}
function stopAggregatedAutoRefresh() {
    if (aggregatedRefreshTimer) { clearInterval(aggregatedRefreshTimer); aggregatedRefreshTimer = null; }
}
  updatePolling();

    (function () {
      if (window.__initDefaultAll) return;
      window.__initDefaultAll = true;
      if (!resultsSelect) return;
      var current = (resultsSelect.value || sessionStorage.getItem(SELECT_STORAGE_KEY) || '');
      if (current === '__all__') {
        resultsTitle.textContent = 'All Sessions — aggregated';
        upsertResultsSelect();
        loadAllSessionsResults();
        updatePolling();
      }
    })();
window.addEventListener('beforeunload', stopPolling);
    window.addEventListener('beforeunload', stopAggregatedAutoRefresh);

  // resultsSelect change listener (first occurrence)
if (resultsSelect && !window.__bulkResultsChangeInit) {
    window.__bulkResultsChangeInit = true;
    resultsSelect.addEventListener('change', function () {
      var val = resultsSelect.value;
      productsGrid.innerHTML = '';
      if (resultsBack) resultsBack.classList.add('hidden');

      // Exit detail mode when the selection changes
      __detailOpen = false;
      __detailOpenListingId = null;

      if (allSessionsController) { try { allSessionsController.abort(); } catch (_) {} allSessionsController = null; }

    if (!val) {
        resultsTitle.textContent = 'No session selected';
        sessionStorage.removeItem(SELECT_STORAGE_KEY);
        stopAggregatedAutoRefresh();
        renderEmptyPrompt();
        updatePolling();
        return;
    }

    sessionStorage.setItem(SELECT_STORAGE_KEY, val);

    if (val === '__all__') {
        resultsTitle.textContent = 'All Sessions — aggregated';
        // Single aggregated load; no auto-refresh timer
        loadAllSessionsResults();
    } else {
        var s = findSession(val);
        updateResultsTitleForSession(s);
        stopAggregatedAutoRefresh();
        attachStream(val);

        var isCompleted = s && String(s.status).toLowerCase() === 'completed';
        if (isCompleted) {
            loadSessionResults(val, true);
        } else {
            var cached = getCachedSessionEntries(val);
            if (Array.isArray(cached) && cached.length) {
                try { renderProductsGrid(applySorting(cached)); } catch (e) { console.error('Render cached failed', e); }
            } else {
                showLoading(false);
                try { renderProductsGrid([]); } catch (_) {}
            }
        }
    }

    // Re-evaluate polling based on the selection
    updatePolling();
});
}
    // Generalized metric accessor (now supports Demand).
  function metricValueOf(entry, metric) {
    switch (String(metric || '').toLowerCase()) {
      case 'price':
        return priceOf(entry);
      case 'demand':
        return (entry && typeof entry.demand === 'number' && isFinite(entry.demand)) ? entry.demand : null;
      default:
        return null;
    }
  }

  // Sorting using metric + order (desc/asc)
  function applySorting(list) {
    var arr = Array.isArray(list) ? list.slice() : [];
    arr.sort(function (a, b) {
      var va = metricValueOf(a, currentSortMetric);
      var vb = metricValueOf(b, currentSortMetric);

      // push missing values to the end
      var aMissing = (va == null || !isFinite(va));
      var bMissing = (vb == null || !isFinite(vb));
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;

      return currentSortOrder === 'asc' ? (va - vb) : (vb - va);
    });
    return arr;
  }

  // Wire dropdowns
  if (sortMetricSelect) {
    sortMetricSelect.addEventListener('change', function () {
      currentSortMetric = sortMetricSelect.value || 'demand';
      renderProductsGrid(applySorting(lastEntriesRaw));
    });
  }
  if (sortOrderSelect) {
    sortOrderSelect.addEventListener('change', function () {
      currentSortOrder = sortOrderSelect.value || 'desc';
      renderProductsGrid(applySorting(lastEntriesRaw));
    });
  }

  // Helper to render a big grey prompt when no session is selected
  function renderEmptyPrompt() {
    productsGrid.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'col-span-full w-full min-h-[60vh] grid place-items-center';
    wrap.innerHTML =
      '<div class="text-center">' +
      '  <div class="text-2xl md:text-3xl font-semibold text-[var(--muted)]">Select a session to view products</div>' +
      '  <div class="mt-2 text-[var(--muted)]">Use the Session dropdown in the top right.</div>' +
      '</div>';
    productsGrid.appendChild(wrap);
  }

  // Persist and restore scroll position within the tab
  function restoreScroll() {
    var y = parseInt(sessionStorage.getItem(SCROLL_STORAGE_KEY) || '0', 10);
    if (!isNaN(y) && y > 0) { window.scrollTo(0, y); }
  }
  window.addEventListener('scroll', function () {
    try {
      sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY || document.documentElement.scrollTop || 0));
    } catch (_) {}
  });

  // Helpers
  function csrfHeader() {
    return window.CSRF_TOKEN ? { 'X-CSRFToken': window.CSRF_TOKEN } : {};
  }
  function escapeHtml(s) {
    return (s || '').toString().replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
function fmtDateISO(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return iso || ''; }
}
function fmtTimeISO(iso) {
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
}
// Centered loading icon (black & white, theme-aware)
var __resultsLoadingFlag = false;
var __centerLoadingWrap = null;
var __centerLoadingIcon = null;

// Freeze grid updates while a product detail is open
var __detailOpen = false;
var __detailOpenListingId = null;

function showLoading(on, _label) {
  __resultsLoadingFlag = !!on;
  if (resultsLoading) resultsLoading.classList.toggle('hidden', !on);
  toggleCenterLoading(on);
}

function toggleCenterLoading(on) {
  if (on) {
    ensureCenterLoading();
    __centerLoadingWrap.classList.remove('hidden');
  } else {
    if (__centerLoadingWrap) __centerLoadingWrap.classList.add('hidden');
  }
}

function ensureCenterLoading() {
  if (__centerLoadingWrap) return;

  var panel = document.getElementById('results-panel') || document.body;

  __centerLoadingWrap = document.createElement('div');
  __centerLoadingWrap.id = 'results-centered-loading';
  __centerLoadingWrap.className = 'col-span-full w-full min-h-[40vh] grid place-items-center';

  __centerLoadingIcon = document.createElement('div');
  __centerLoadingIcon.className = 'loading-icon';
  // Make it slightly larger/thicker while staying neutral (uses CSS vars)
  __centerLoadingIcon.style.width = '28px';
  __centerLoadingIcon.style.height = '28px';
  __centerLoadingIcon.style.borderWidth = '3px';
  __centerLoadingIcon.style.borderColor = 'var(--border)';
  __centerLoadingIcon.style.borderTopColor = 'var(--text)';

  __centerLoadingWrap.appendChild(__centerLoadingIcon);

  // Insert right above the products grid to center within the panel
  var products = document.getElementById('products-grid');
  if (panel && products) panel.insertBefore(__centerLoadingWrap, products);
  else document.body.appendChild(__centerLoadingWrap);

  // Start hidden until toggled on
  __centerLoadingWrap.classList.add('hidden');
}

  function clampInt(val, min, max) {
    var n = parseInt(String(val || '0'), 10);
    if (isNaN(n)) n = min;
    n = Math.max(min, Math.min(max, n));
    return n;
  }

  // Sessions panel
  function openSessionsPanel() { sessionsPanel && sessionsPanel.classList.remove('hidden'); }
  function closeSessionsPanel() { sessionsPanel && sessionsPanel.classList.add('hidden'); }
  if (sessionsButton) sessionsButton.addEventListener('click', openSessionsPanel);
  if (sessionsClose) sessionsClose.addEventListener('click', closeSessionsPanel);

  // Wizard open/close
  function openWizard() {
    if (!wizard) return;

    // Close sessions panel so the modal isn’t under it
    if (typeof closeSessionsPanel === 'function') closeSessionsPanel();

    // Reset steps and inputs
    if (step1) step1.classList.remove('hidden');
    if (step2) step2.classList.add('hidden');
    if (keywordInput) keywordInput.value = '';
    if (totalInput) totalInput.value = '';

    // Show modal and lock background scroll
    wizard.classList.remove('hidden');
    wizard.style.display = ''; // let CSS .wizard:not(.hidden) apply
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    if (keywordInput) keywordInput.focus();
}

function closeWizard() {
    if (wizard) {
        wizard.classList.add('hidden');
        wizard.style.display = 'none'; // hard hide to override any CSS
    }
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';

    if (step1 && step2) {
        step1.classList.remove('hidden');
        step2.classList.add('hidden');
    }
    if (keywordInput) keywordInput.blur();
    if (totalInput) totalInput.blur();
}

// Centralized step switching
function goWizardStep(stepNum) {
  if (!step1 || !step2) return;
  if (stepNum === 1) {
    step1.classList.remove('hidden');
    step2.classList.add('hidden');
    if (keywordInput) keywordInput.focus();
  } else if (stepNum === 2) {
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    if (totalInput) totalInput.focus();
  }
}

// Wire Next button to advance to step 2
if (step1Next) {
  step1Next.addEventListener('click', function () {
    var v = (keywordInput && keywordInput.value || '').trim();
    if (!v) {
      alert('Please enter a keyword');
      if (keywordInput) keywordInput.focus();
      return;
    }
    goWizardStep(2);
  });
}

// Allow Enter on keyword to trigger Next
if (keywordInput) {
  keywordInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (step1Next) step1Next.click();
    }
  });
}


// Ensure buttons are wired
if (addBtn) addBtn.addEventListener('click', openWizard);
if (wizardClose) wizardClose.addEventListener('click', closeWizard);

// Close on overlay click (but not when clicking inside the card)
var wizardCard = document.querySelector('.wizard-card');
if (wizard) {
  wizard.addEventListener('click', function (e) {
    if (e.target === wizard) closeWizard();
  });
}
if (wizardCard) {
  wizardCard.addEventListener('click', function (e) { e.stopPropagation(); });
}

// Escape key closes wizard
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && wizard && !wizard.classList.contains('hidden')) {
    closeWizard();
  }
});
  if (step2Done) {
    step2Done.addEventListener('click', function () {
      var kw = (keywordInput.value || '').trim();
      var total = clampInt(totalInput.value, 1, 500);
      if (!kw) { alert('Please enter a keyword'); return; }
      if (!(total > 0)) { alert('Please enter a positive number for products'); return; }
      step2Done.disabled = true;
      step2Done.textContent = 'Starting...';
      createSession(kw, total).finally(function () {
        step2Done.disabled = false;
        step2Done.textContent = 'Done';
      });
    });
  }

  function deleteSession(sessionId) {
  var btn = document.querySelector('.delete-session[data-delete="' + sessionId + '"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

  return fetch(window.BULK_RESEARCH_DELETE_URL_BASE + sessionId + '/', {
    method: 'POST',
    headers: Object.assign({ 'Accept': 'application/json' }, csrfHeader()),
    credentials: 'same-origin'
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) {
        var msg = (body && (body.error && (body.error.message || body.error) || body.raw)) || ('Delete failed (' + r.status + ')');
        if (typeof msg !== 'string') { try { msg = JSON.stringify(msg); } catch (_) { msg = 'Delete failed (' + r.status + ')'; } }
        throw new Error(msg);
      }
      return body;
    });
  }).then(function () {
        // Close any active stream for this session
        try { if (streams[sessionId]) { streams[sessionId].close(); } } catch (_) {}
        delete streams[sessionId];

        // Drop caches and counts (memory + sessionStorage)
        delete sessionResultsCache[sessionId];
        delete sessionCounts[sessionId];
        removeSessionCachedEntries(sessionId);

        // Remove from in-memory list
        sessions = sessions.filter(function (x) { return String(x.id) !== String(sessionId); });

        // If currently viewing this session, fallback appropriately
        if (resultsSelect && String(resultsSelect.value) === String(sessionId)) {
            var hasAnySessions = Array.isArray(sessions) && sessions.length > 0;
            if (hasAnySessions) {
                resultsSelect.value = '__all__';
                sessionStorage.setItem(SELECT_STORAGE_KEY, '__all__');
                if (resultsBack) resultsBack.classList.add('hidden');
                resultsTitle.textContent = 'All Sessions — aggregated';
                loadAllSessionsResults();
            } else {
                resultsSelect.value = '';
                if (resultsBack) resultsBack.classList.add('hidden');
                resultsTitle.textContent = 'No session selected';
                productsGrid.innerHTML = '';
                stopAggregatedAutoRefresh();
            }
        } else if (resultsSelect && resultsSelect.value === '__all__') {
            // Keep aggregated view current
            loadAllSessionsResults();
        } else {
            upsertResultsSelect();
        }

        // Re-render sessions list
        renderSessionsList();

        showToast('Session deleted.', 'success');
    }).catch(function (err) {
    // Error toast instead of alert
    showToast('Delete failed: ' + err.message, 'error');
  }).finally(function () {
    if (btn) { btn.textContent = 'Delete'; btn.disabled = false; }
  });
}

  // Create session
  function createSession(keyword, desiredTotal) {
    return fetch(window.BULK_RESEARCH_START_URL, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, csrfHeader()),
    credentials: 'same-origin',
    body: JSON.stringify({ keyword: keyword, desired_total: desiredTotal })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) {
        var msg = (body && (body.error && (body.error.message || body.error) || body.raw)) || ('Start failed (' + r.status + ')');
        if (typeof msg !== 'string') { try { msg = JSON.stringify(msg); } catch (_) { msg = 'Start failed (' + r.status + ')'; } }
        throw new Error(msg);
      }
      return body;
    });
  }).then(function (out) {
    closeWizard();
    var s = {
      id: out.session_id, keyword: keyword, desired_total: desiredTotal,
      status: 'ongoing',
      progress: {
        search:    { total: desiredTotal, remaining: desiredTotal },
        splitting: { total: desiredTotal, remaining: desiredTotal },
        demand:    { total: desiredTotal, remaining: desiredTotal },
        keywords:  { total: desiredTotal, remaining: desiredTotal }
      },
      created_at: new Date().toISOString()
    };
    sessions.unshift(s);
    renderSessionsList();
    upsertResultsSelect();
    attachStream(s.id);
  }).catch(function (err) { alert('Failed to start: ' + err.message); });
  }

  // Render sessions list in panel
  function renderSessionsList() {
    if (!sessionsList) return;
    sessionsList.innerHTML = '';
    if (sessions.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'text-sm text-neutral-500';
      empty.textContent = 'No sessions yet.';
      sessionsList.appendChild(empty);
      return;
    }
    sessions.forEach(function (s) {
        var item = document.createElement('article');
        item.className = 'session-row';
        item.setAttribute('data-session-id', s.id);

        var created = fmtDateISO(s.created_at);
        var isCompleted = String(s.status || '').toLowerCase() === 'completed';

        // Hide Reconnect entirely once completed
        var showReconnect = !isCompleted;
        var live = (String(s.status).toLowerCase() === 'ongoing') && isStreamAlive(s.id);

        // Make View Results clickable as soon as status is completed
        var canView = isCompleted;

        item.innerHTML =
          '<div class="session-header flex items-center justify-between gap-2">' +
          '  <button class="toggle-details text-xs px-1 py-0.5 mr-2" aria-expanded="' + (!isCompleted) + '" aria-label="Toggle details">' + (isCompleted ? '▸' : '▾') + '</button>' +
          '  <div class="flex items-center gap-2 flex-1 min-w-0">' +
          '    <div class="row-title truncate text-sm font-medium" title="' + escapeHtml(s.keyword) + '">' + escapeHtml(s.keyword) + '</div>' +
          '    <div class="row-meta text-xs text-[var(--muted)]">Desired: ' + (s.desired_total || 0) + ' • Started: ' + created + '</div>' +
          '  </div>' +
          '  <div class="row-actions flex items-center gap-2 text-xs">' +
          '    <button class="link-btn text-xs view-results' + (!canView ? ' is-disabled' : '') + '"' +
          '            data-view="' + s.id + '"' +
          (!canView ? ' disabled aria-disabled="true" title="Results available after completion"' : '') +
          '    >View Results</button>' +
          (showReconnect ? ('    <button class="link-btn text-xs reconnect-session ml-2" data-reconnect="' + s.id + '"' +
          (live ? ' title="Live updating — reconnect disabled"' : '') + '>Reconnect</button>') : '') +
          '    <button class="link-btn text-xs delete-session ml-2" data-delete="' + s.id + '">Delete</button>' +
          '  </div>' +
          '</div>' +
          '<div class="session-details' + (isCompleted ? ' hidden' : '') + '">' +
          '  <div class="text-xs"><span class="text-[var(--muted)]">Keyword</span>: <span class="break-words whitespace-normal">' + escapeHtml(s.keyword) + '</span></div>' +
          '  <div class="row-progress mt-1">' +
               progressLine('Search', s.progress && s.progress.search, s) +
               progressLine('Splitting', s.progress && s.progress.splitting, s) +
               progressLine('Demand', s.progress && s.progress.demand, s) +
               progressLine('Keywords', s.progress && s.progress.keywords, s) +
          '  </div>' +
          '  <div class="row-status mt-1">Status: <span class="status-tag ' + s.status + '">' + s.status + '</span></div>' +
          '</div>';

        // Toggle collapse/expand with arrow
        var toggle = item.querySelector('.toggle-details');
        var details = item.querySelector('.session-details');
        if (toggle && details) {
          toggle.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var collapsed = details.classList.contains('hidden');
            if (collapsed) {
              details.classList.remove('hidden');
              toggle.textContent = '▾';
              toggle.setAttribute('aria-expanded', 'true');
            } else {
              details.classList.add('hidden');
              toggle.textContent = '▸';
              toggle.setAttribute('aria-expanded', 'false');
            }
          });
        }

        // Bind View Results only when eligible
        var btn = item.querySelector('.view-results');
        if (btn) {
          if (canView) {
            btn.addEventListener('click', function (e) {
              e.stopPropagation();
              closeSessionsPanel();
              resultsSelect.value = String(s.id);
              updateResultsTitleForSession(s);
              // Fast render or revalidate; works immediately after completion
              loadSessionResults(s.id, true);
            });
          } else {
            // keep disabled; no handler bound
          }
        }

        // Delete: do not bind when ongoing, keep disabled
        var delBtn = item.querySelector('.delete-session');
        if (delBtn) {
          var isOngoing = String(s.status).toLowerCase() === 'ongoing';
          if (isOngoing) {
            delBtn.disabled = true;
            delBtn.title = 'Cannot delete while session is ongoing';
            delBtn.setAttribute('aria-disabled', 'true');
            delBtn.classList.add('is-disabled');
          } else {
            delBtn.addEventListener('click', function (e) {
              e.stopPropagation();
              if (delBtn.disabled || delBtn.classList.contains('is-disabled')) return;
              showConfirmDelete(s).then(function (confirmed) {
                if (!confirmed) return;
                deleteSession(s.id);
              });
            });
          }
        }

        var reconBtn = item.querySelector('.reconnect-session');
    if (reconBtn) {
        reconBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (isStreamAlive(s.id)) {
                showToast('Already receiving live updates — reconnect disabled.', 'error');
                return;
            }
            reconnectSession(s.id, reconBtn);
        });
    }

        sessionsList.appendChild(item);
    });
}

  function progressLine(name, obj, session) {
    var total = (obj && typeof obj.total === 'number' && isFinite(obj.total))
        ? obj.total
        : (session && typeof session.desired_total === 'number' ? session.desired_total : 0);
    var rem = (obj && typeof obj.remaining === 'number' && isFinite(obj.remaining))
        ? obj.remaining
        : Math.max(0, total);

    total = isFinite(total) ? total : 0;
    rem = isFinite(rem) ? rem : 0;

    var done = Math.max(0, Math.min(total, total - rem));
    return '<div class="prog-item"><span class="prog-title">' + name + '</span>' +
           '<span class="prog-values"><span class="done">' + done + '</span>' +
           '<span class="sep">/</span><span class="total">' + total + '</span></span></div>';
  }

  function handleStreamUpdate(sessionId, data) {
  var s = findSession(sessionId);
  if (!s) {
    console.warn('Stream update for unknown session', sessionId, data);
    return;
  }
  var stage = String(data.stage || '').toLowerCase();

  // Hydrate from snapshot: sets progress, status, and triggers results fetch
  if (stage === 'snapshot') {
    if (typeof data.status === 'string') s.status = data.status;
    if (data.progress && typeof data.progress === 'object') {
      s.progress = data.progress;
      // Normalize progress if snapshot says completed
      if (String(s.status).toLowerCase() === 'completed') {
        normalizeProgressForCompleted(s, data.entries_count);
      }
      updateSession(s);
    }
    var ec = data.entries_count;
    if (typeof ec === 'number' && isFinite(ec)) {
      sessionCounts[sessionId] = ec;
      upsertResultsSelect();

      // Only refresh results if snapshot indicates completion
      var statusLower = String(data.status || '').toLowerCase();
      var selected = resultsSelect && resultsSelect.value;
      if (statusLower === 'completed' && ec > 0) {
        try {
          if (selected === '__all__') {
            loadAllSessionsResults();
          } else {
            var shouldRenderNow = (String(selected) === String(sessionId));
            loadSessionResults(sessionId, shouldRenderNow);
          }
        } catch (e) { alert('Snapshot refresh failed: ' + e.message); }
      }
    } else {
      console.warn('Snapshot missing/invalid entries_count for session', sessionId, data);
    }
    return;
  }

  // Progress stage updates
  var key = mapStage(stage);
  if (key) {
    s.progress = s.progress || {};
    s.progress[key] = s.progress[key] || { total: 0, remaining: 0 };
    if (typeof data.total === 'number' && isFinite(data.total)) s.progress[key].total = data.total;
    if (typeof data.remaining === 'number' && isFinite(data.remaining)) s.progress[key].remaining = data.remaining;
    updateSession(s);
  }

  // Refresh products only on completion
  if (stage === 'completed') {
    s.status = 'completed';
    // Normalize progress to show done totals
    normalizeProgressForCompleted(s, data && typeof data.entries_count === 'number' ? data.entries_count : undefined);
    updateSession(s);
    var selected = resultsSelect && resultsSelect.value;
    try {
      if (selected === '__all__') {
        loadAllSessionsResults();
      } else if (String(selected) === String(sessionId)) {
        loadSessionResults(sessionId, true);
      }
    } catch (e) {
      alert('Refresh after completion failed: ' + e.message);
      console.error('Refresh error', e, data);
    }
  }
}

// Ensure completed sessions show full done totals (no leftovers)
function normalizeProgressForCompleted(session, entriesCountMaybe) {
  var s = session || {};
  var desired = (s && typeof s.desired_total === 'number') ? s.desired_total : 0;
  var ecKnown = (typeof entriesCountMaybe === 'number' && isFinite(entriesCountMaybe)) ? entriesCountMaybe : null;
  var cachedCount = (sessionCounts && sessionCounts[session.id]) || null;
  var ec = (ecKnown != null) ? ecKnown : (typeof cachedCount === 'number' ? cachedCount : null);

  s.progress = s.progress || {};
  // Search — total = desired_total, remaining = 0
  var pSearch = s.progress.search || {};
  pSearch.total = (typeof desired === 'number' && desired > 0) ? desired : (pSearch.total || 0);
  pSearch.remaining = 0;
  s.progress.search = pSearch;

  // Splitting — preserve total if any, remaining = 0 (defaults to 2)
  var pSplit = s.progress.splitting || {};
  var splitTotal = (typeof pSplit.total === 'number' && pSplit.total > 0) ? pSplit.total : 2;
  pSplit.total = splitTotal;
  pSplit.remaining = 0;
  s.progress.splitting = pSplit;

  // Demand — total = entries_count if known, remaining = 0
  var pDemand = s.progress.demand || {};
  var demandTotal = (ec != null) ? Math.max(pDemand.total || 0, ec) : (pDemand.total || 0);
  pDemand.total = demandTotal;
  pDemand.remaining = 0;
  s.progress.demand = pDemand;

  // Keywords — keep discovered total, remaining = 0
  var pKeywords = s.progress.keywords || {};
  pKeywords.total = (typeof pKeywords.total === 'number' ? pKeywords.total : 0);
  pKeywords.remaining = 0;
  s.progress.keywords = pKeywords;
}

function isProgressFull(progress) {
  var p = progress || {};
  function full(stage) {
    var st = p[stage] || {};
    return typeof st.remaining === 'number' && st.remaining === 0;
  }
  return full('search') && full('splitting') && full('demand') && full('keywords');
}

function hasCachedResults(sessionId) {
  var inMem = sessionResultsCache[sessionId];
  if (Array.isArray(inMem) && inMem.length > 0) return true;
  var hydrated = getCachedSessionEntries(sessionId);
  return Array.isArray(hydrated) && hydrated.length > 0;
}

function isSessionFullyCompleted(s) {
  return String(s.status).toLowerCase() === 'completed' && isProgressFull(s.progress);
}

  function mapStage(stage) {
    if (stage === 'search') return 'search';
    if (stage === 'splitting') return 'splitting';
    if (stage === 'demand_extraction') return 'demand';
    if (stage === 'ai_keywords' || stage === 'keywords_research') return 'keywords';
    return null;
  }
  function findSession(id) { return sessions.find(function (x) { return String(x.id) === String(id); }); }
  function updateSession(updated) {
  var idx = sessions.findIndex(function (x) { return String(x.id) === String(updated.id); });
  if (idx !== -1) sessions[idx] = updated;
  renderSessionsList();
  upsertResultsSelect();
  // Keep polling state in sync with session statuses
  updatePolling();
}

  // Results
  function upsertResultsSelect() {
    if (!resultsSelect) return;

    // Preserve whatever is currently selected or saved
    var current = resultsSelect.value || sessionStorage.getItem(SELECT_STORAGE_KEY) || '';

    // Rebuild the select
    resultsSelect.innerHTML = '';

    // Only show the empty 'Select...' option when there are no sessions at all
    var hasAnySessions = Array.isArray(sessions) && sessions.length > 0;
    if (!hasAnySessions) {
        var optDefault = document.createElement('option');
        optDefault.value = '';
        optDefault.textContent = 'Select...';
        resultsSelect.appendChild(optDefault);
    }

    // Aggregated option with known total if available
    var optAll = document.createElement('option');
    optAll.value = '__all__';
    var totalKnown = Object.keys(sessionCounts).reduce(function (acc, id) {
        var c = sessionCounts[id];
        return acc + (typeof c === 'number' ? c : 0);
    }, 0);
    optAll.textContent = totalKnown > 0
        ? ('All Sessions — aggregated • ' + totalKnown + ' products')
        : 'All Sessions — aggregated';
    optAll.title = 'Aggregated results from all sessions';
    resultsSelect.appendChild(optAll);

    // Include all sessions (ongoing and completed), so user can switch freely
    sessions.forEach(function (s) {
        var o = document.createElement('option');
        o.value = String(s.id);

        var created = fmtDateISO(s.created_at);
        var status = (s && s.status) ? String(s.status).toLowerCase() : '';
        var count = (typeof sessionCounts[s.id] === 'number') ? sessionCounts[s.id] : null;

        var txt = s.keyword + ' (' + created + ')';
        // Removed: if (status === 'ongoing') txt += ' • ongoing';
        if (count !== null) txt += ' • ' + count + ' products';

        o.textContent = txt;
        o.title = s.keyword; // show full keyword on hover
        resultsSelect.appendChild(o);
    });

    // Keep selection stable if it exists in the rebuilt list
    var hasDesired = Array.prototype.some.call(resultsSelect.options, function (opt) { return opt.value === current; });
    if (hasDesired) {
        resultsSelect.value = current;
    } else {
        // Do NOT force '__all__' here; leave selection unchanged.
        // Initial defaulting to aggregated is handled in the bootstrap/restoreSelection flow.
    }
}

  // resultsSelect change listener (second occurrence)
if (resultsSelect && !window.__bulkResultsChangeInit) {
    window.__bulkResultsChangeInit = true;
    resultsSelect.addEventListener('change', function () {
    var val = resultsSelect.value;
    productsGrid.innerHTML = '';
    if (resultsBack) resultsBack.classList.add('hidden');
    if (allSessionsController) { try { allSessionsController.abort(); } catch (_) {} allSessionsController = null; }

    if (!val) {
        var hasAnySessions = Array.isArray(sessions) && sessions.length > 0;
        if (hasAnySessions) {
            resultsSelect.value = '__all__';
            sessionStorage.setItem(SELECT_STORAGE_KEY, '__all__');
            resultsTitle.textContent = 'All Sessions — aggregated';
            loadAllSessionsResults();
            updatePolling();
            return;
        }
        resultsTitle.textContent = 'No session selected';
        sessionStorage.removeItem(SELECT_STORAGE_KEY);
        stopAggregatedAutoRefresh();
        renderEmptyPrompt();
        updatePolling();
        return;
    }

    sessionStorage.setItem(SELECT_STORAGE_KEY, val);

    if (val === '__all__') {
        resultsTitle.textContent = 'All Sessions — aggregated';
        loadAllSessionsResults();
    } else {
        var s = findSession(val);
        updateResultsTitleForSession(s);
        stopAggregatedAutoRefresh();
        attachStream(val);

        var isCompleted = s && String(s.status).toLowerCase() === 'completed';
        if (isCompleted) {
            loadSessionResults(val, true);
        } else {
            var cached = getCachedSessionEntries(val);
            if (Array.isArray(cached) && cached.length) {
                try { renderProductsGrid(applySorting(cached)); } catch (e) { console.error('Render cached failed', e); }
            } else {
                showLoading(false);
                try { renderProductsGrid([]); } catch (_) {}
            }
        }
    }

    updatePolling();
});
}

  function showToast(message, type) {
  var container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed bottom-4 right-4 z-[100] flex flex-col items-end space-y-2 pointer-events-none';
    document.body.appendChild(container);
  }

  var base =
    'pointer-events-auto max-w-sm w-full rounded-lg shadow-xl ' +
    'px-4 py-3 text-sm ring-1 transition transform ' +
    'opacity-0 translate-y-2';

  var cls;
  if (type === 'success') {
    cls = 'bg-emerald-600 text-white ring-emerald-500/20';
  } else if (type === 'error') {
    cls = 'bg-red-600 text-white ring-red-500/20';
  } else {
    cls = 'bg-gray-900 text-white dark:bg-gray-800 ring-white/10';
  }

  var toast = document.createElement('div');
  toast.className = base + ' ' + cls;

  var closeBtn =
    '<button class="ml-3 shrink-0 rounded-md bg-white/10 hover:bg-white/20 px-2 py-1 text-white" aria-label="Close">✕</button>';

  toast.innerHTML =
    '<div class="flex items-center justify-between">' +
    '  <div class="pr-2">' + message + '</div>' +
    '  ' + closeBtn +
    '</div>';

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(function () {
    toast.classList.remove('opacity-0', 'translate-y-2');
    toast.classList.add('opacity-100', 'translate-y-0');
    toast.style.transitionDuration = '200ms';
  });

  var remove = function () {
    toast.classList.remove('opacity-100', 'translate-y-0');
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(function () {
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    }, 180);
  };

  var btn = toast.querySelector('button');
  if (btn) btn.addEventListener('click', remove);

  setTimeout(remove, 3500);
}

// Attach only the selected session's stream on load (avoid starting all sessions)
  function ensureStreamForSelected() {
    var selected = (resultsSelect && resultsSelect.value) || sessionStorage.getItem(SELECT_STORAGE_KEY);
    if (selected && selected !== '__all__') {
      attachStream(selected);
    }
  }
  ensureStreamForSelected();

function showConfirmDelete(session) {
  return new Promise(function (resolve) {
    // Overlay
    var overlay = document.createElement('div');
    overlay.className =
      'fixed inset-0 z-[100] grid place-items-center ' +
      'bg-black/45 dark:bg-black/65 backdrop-blur-sm transition-opacity duration-200';
    overlay.style.opacity = '0';

    // Modal container
    var modal = document.createElement('div');
    modal.className =
      'relative w-[min(92vw,480px)] rounded-2xl shadow-2xl ' +
      'ring-1 ring-neutral-200 dark:ring-neutral-800 ' +
      'bg-white dark:bg-neutral-900 ' +
      'text-neutral-900 dark:text-neutral-100 ' +
      'transform transition-all duration-200 ease-out ' +
      'opacity-0 translate-y-2 scale-95';

    // Accessible attributes
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'confirm-delete-title');
    modal.setAttribute('aria-describedby', 'confirm-delete-desc');

    // Content
    modal.innerHTML =
      '<div class="p-6">' +
      '  <div class="flex items-center gap-3">' +
      '    <div class="flex h-9 w-9 items-center justify-center rounded-full ' +
      '      bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400">🗑️</div>' +
      '    <h2 id="confirm-delete-title" class="text-lg font-semibold tracking-tight">Delete Session</h2>' +
      '  </div>' +
      '  <p id="confirm-delete-desc" class="mt-2 text-sm text-neutral-600 dark:text-neutral-300">' +
      '    Are you sure you want to delete ' +
      '    <span class="font-medium">&ldquo;' + (session.keyword ? String(session.keyword) : 'this session') + '&rdquo;</span>? ' +
      '    This action cannot be undone.' +
      '  </p>' +
      '  <div class="mt-6 flex items-center justify-end gap-3">' +
      '    <button type="button" class="px-3.5 py-2 rounded-md ' +
      '      bg-neutral-100 text-neutral-800 hover:bg-neutral-200 ' +
      '      dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 ' +
      '      ring-1 ring-neutral-200 dark:ring-neutral-700">Cancel</button>' +
      '    <button type="button" class="px-3.5 py-2 rounded-md ' +
      '      bg-red-600 text-white hover:bg-red-700 ' +
      '      dark:bg-red-500 dark:hover:bg-red-600 ' +
      '      focus:outline-none focus:ring-2 focus:ring-red-500">Delete</button>' +
      '  </div>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Animate in
    requestAnimationFrame(function () {
      overlay.style.opacity = '1';
      modal.classList.remove('opacity-0', 'translate-y-2', 'scale-95');
      modal.classList.add('opacity-100', 'translate-y-0', 'scale-100');
    });

    var btns = modal.querySelectorAll('button');
    var cancelBtn = btns[0];
    var delBtn = btns[1];
    delBtn.focus();

    var close = function (value) {
      // Animate out, then remove
      overlay.style.opacity = '0';
      modal.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
      modal.classList.add('opacity-0', 'translate-y-2', 'scale-95');
      setTimeout(function () {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }, 150);
    };

    cancelBtn.addEventListener('click', function () { close(false); });
    delBtn.addEventListener('click', function () { close(true); });

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(false);
    });

    // Keyboard interactions
    function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(false);
      } else if (e.key === 'Enter') {
        document.removeEventListener('keydown', onKey);
        close(true);
      }
    }
    document.addEventListener('keydown', onKey);
  });
}

  function updateResultsTitleForSession(s) {
    if (!s) { resultsTitle.textContent = 'Session'; return; }
    var created = fmtDateISO(s.created_at);
    resultsTitle.textContent = 'Results — "' + (s.keyword || '') + '" • started ' + created;
  }

  function loadSessionResults(sessionId, renderNow) {
  // Use cache first for instant switching
  var s = findSession(sessionId);
  var isCompleted = s && String(s.status).toLowerCase() === 'completed';
  var baseUrl = window.BULK_RESEARCH_RESULT_URL_BASE + sessionId + '/';
  var fastUrl = baseUrl + '?limit=8';

  // Helper: normalize result JSON to an entries array
  function extractEntries(json) {
    if (Array.isArray(json.entries)) return json.entries;
    if (json.megafile && Array.isArray(json.megafile.entries)) return json.megafile.entries;
    return [];
  }

   var cached = getCachedSessionEntries(sessionId);
    // Skip cache if we are in a forced reopen flow for this session
    var skipCacheDueToReopen = (pendingReopen && String(pendingReopen.session_id) === String(sessionId));
    if (skipCacheDueToReopen) {
      cached = null;
    }
    if (Array.isArray(cached) && cached.length > 0) {
      // Immediate render from cache; no spinner
      var sortedCached = applySorting(cached);
      if (renderNow) {
        try { renderProductsGrid(sortedCached); } catch (e) { console.error('Render cached failed', e); }
        restoreScroll();
      } else if (resultsSelect && resultsSelect.value === '__all__') {
        try { renderAggregatedFromCache(); } catch (e) { console.error('Aggregated cached render failed', e); }
      }

      // Smart revalidate if cache looks incomplete (e.g., missing price fields)
      var cachedLooksIncomplete = false;
      try {
        var probeMax = Math.min(cached.length, 10);
        for (var ci = 0; ci < probeMax; ci++) {
          var ce = cached[ci] || {};
          var hasDisplay = !!(ce.price_display && String(ce.price_display).trim());
          var hasAmountDiv = (typeof ce.price_amount === 'number' && typeof ce.price_divisor === 'number' && ce.price_divisor);
          var hasValue = (typeof ce.price_value === 'number' && isFinite(ce.price_value));
          if (!hasDisplay && !hasAmountDiv && !hasValue) { cachedLooksIncomplete = true; break; }
        }
      } catch (_) {}

      // Quiet revalidate if session is ongoing OR cache is incomplete
      if (!isCompleted || cachedLooksIncomplete) {
        fetch(baseUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
          .then(function (r) {
            var isJson = ((r.headers.get('Content-Type') || '').toLowerCase().indexOf('application/json') !== -1);
            return r.text().then(function (txt) {
              var body;
              try { body = isJson ? JSON.parse(txt || '{}') : {}; } catch (e) { body = {}; }
              if (!r.ok) throw new Error('Background refresh failed (' + r.status + ')');
              return body;
            });
          })
          .then(function (json) {
            var fullEntries = extractEntries(json);
            var sortedFull = applySorting(fullEntries);
            saveCachedSessionEntries(sessionId, sortedFull);

            var isSelected = resultsSelect && String(resultsSelect.value) === String(sessionId);
            if (renderNow && isSelected) {
              try { progressiveRenderSession(sessionId, sortedFull, productsGrid.children.length); }
              catch (e) { console.warn('Progressive render fallback', e); renderProductsGrid(sortedFull); }
            } else if (resultsSelect && resultsSelect.value === '__all__') {
              try { renderAggregatedFromCache(); } catch (e) { console.error('Re-render aggregated after cache update failed', e); }
            }
          })
          .catch(function (err) { console.info('Quiet revalidate skipped/failed for session', sessionId, err && err.message); });
      }
      return Promise.resolve(); // Done via cache path
    }

  if (isCompleted) {
    showLoading(true, 'Loading top products…');
  } else {
    // Do not show spinner for ongoing sessions
    showLoading(false);
  }

  return fetch(fastUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
    .then(function (r) {
      var isJson = ((r.headers.get('Content-Type') || '').toLowerCase().indexOf('application/json') !== -1);
      return r.text().then(function (txt) {
        var body;
        try { body = isJson ? JSON.parse(txt || '{}') : {}; } catch (e) { body = { parse_error: e.message, raw: (txt || '').slice(0, 500) }; }
        if (!r.ok) {
          var msg = 'Results request failed (' + r.status + '). URL: ' + fastUrl;
          throw new Error(msg);
        }
        return body;
      });
    })
    .then(function (json) {
      var entries = extractEntries(json);
      var fastSorted = applySorting(entries).slice(0, 8);

      saveCachedSessionEntries(sessionId, fastSorted);

      if (renderNow) {
        try { renderProductsGrid(fastSorted); } catch (e) { alert('Rendering products failed: ' + e.message); console.error('Rendering error', e, fastSorted); }
      } else if (resultsSelect && resultsSelect.value === '__all__') {
        try { renderAggregatedFromCache(); } catch (e) { console.error('Re-render aggregated after cache update failed', e); }
      }

      showLoading(false);
      restoreScroll();
    })
    .catch(function (err) {
      var msg = (err && err.message) || '';
      var isAbort = err && (err.name === 'AbortError');
      var isTransient = /Failed to fetch|NetworkError|load failed/i.test(msg);
      if (isAbort || isTransient) {
        console.info('Fast results request aborted/transient for session', sessionId, err);
        showLoading(false);
        return;
      }
      showLoading(false);
      alert('Failed to load results: ' + msg);
      console.error('Results load failed (fast) for session', sessionId, err);
    })
    .then(function () {
      // Background full load (no spinner)
      return fetch(baseUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
        .then(function (r) {
          var isJson = ((r.headers.get('Content-Type') || '').toLowerCase().indexOf('application/json') !== -1);
          return r.text().then(function (txt) {
            var body;
            try { body = isJson ? JSON.parse(txt || '{}') : {}; } catch (e) { body = { parse_error: e.message, raw: (txt || '').slice(0, 500) }; }
            if (!r.ok) {
              var msg = 'Results request failed (' + r.status + ') (background). URL: ' + baseUrl;
              throw new Error(msg);
            }
            return body;
          });
        })
        .then(function (json) {
          var fullEntries = extractEntries(json);
          var fullSorted = applySorting(fullEntries);

          saveCachedSessionEntries(sessionId, fullSorted);

          var isSelected = resultsSelect && String(resultsSelect.value) === String(sessionId);
          if (renderNow && isSelected) {
            try { progressiveRenderSession(sessionId, fullSorted, productsGrid.children.length); }
            catch (e) { console.warn('Progressive render failed; fallback to full render', e); renderProductsGrid(fullSorted); }
          } else if (resultsSelect && resultsSelect.value === '__all__') {
            try { renderAggregatedFromCache(); } catch (e) { console.error('Re-render aggregated after cache update failed', e); }
          }
        })
        .catch(function (err) {
          var msg = (err && err.message) || '';
          var isAbort = err && (err.name === 'AbortError');
          var isTransient = /Failed to fetch|NetworkError|load failed/i.test(msg);
          if (isAbort || isTransient) {
            console.info('Background results request aborted/transient for session', sessionId, err);
            return;
          }
          console.warn('Background results load failed for session', sessionId, err);
        });
    });
}

// Lightweight cache helpers
function cacheKeyFor(sessionId) { return 'br_results_' + String(sessionId); }

// Chunked storage keys for full persistence
function metaKeyFor(sessionId) { return 'br_results_' + String(sessionId) + '__meta'; }
function chunkKeyFor(sessionId, idx) { return 'br_results_' + String(sessionId) + '__chunk_' + String(idx); }
var CACHE_CHUNK_SIZE = 200; // store entries in blocks of 200
var CACHE_MAX_CHUNKS = 100; // safety cap: up to 20k entries per session

function getCachedSessionEntries(sessionId) {
  // Prefer in-memory cache
  var mem = sessionResultsCache[sessionId];
  if (Array.isArray(mem) && mem.length) return mem;

  // Try new chunked sessionStorage format first
  try {
    var metaRaw = sessionStorage.getItem(metaKeyFor(sessionId));
    if (metaRaw) {
      var meta = {};
      try { meta = JSON.parse(metaRaw) || {}; } catch (_) { meta = {}; }
      var chunkCount = Number(meta.chunkCount || 0);
      var totalCount = Number(meta.count || 0);
      var out = [];
      if (chunkCount > 0) {
        for (var i = 0; i < chunkCount; i++) {
          var raw = sessionStorage.getItem(chunkKeyFor(sessionId, i));
          if (!raw) continue;
          try {
            var part = JSON.parse(raw);
            if (Array.isArray(part) && part.length) out = out.concat(part);
          } catch (_) {}
        }
      }
      if (!out.length && totalCount > 0) {
        // Fallback: legacy single-key format if chunks missing
        var legacyRaw = sessionStorage.getItem(cacheKeyFor(sessionId));
        if (legacyRaw) {
          try {
            var legacy = JSON.parse(legacyRaw) || {};
            var arrLegacy = Array.isArray(legacy.entries) ? legacy.entries : [];
            if (arrLegacy.length) out = arrLegacy.slice();
          } catch (_) {}
        }
      }
      if (out.length) {
        sessionResultsCache[sessionId] = out.slice();
        sessionCounts[sessionId] = out.length;
        return out.slice();
      }
    }
  } catch (_) {}

  // Legacy single-key format
  try {
    var raw = sessionStorage.getItem(cacheKeyFor(sessionId));
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    var arr = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    if (arr.length) {
      // Annotate with session metadata for aggregated view
      var meta = findSession(sessionId) || {};
      var count = (typeof parsed.count === 'number' ? parsed.count : arr.length);
      var annotated = arr.map(function (e) {
        if (e && e.__session_id) return e;
        var out = Object.assign({}, e);
        out.__session_id = sessionId;
        out.__session_keyword = meta.keyword || '';
        out.__session_created_at = meta.created_at || '';
        out.__session_products_count = count;
        return out;
      });
      sessionResultsCache[sessionId] = annotated.slice();
      sessionCounts[sessionId] = count;
      return annotated.slice();
    }
  } catch (_) {}
  return null;
}

function removeSessionCachedEntries(sessionId) {
  try {
    // Remove legacy blob
    sessionStorage.removeItem(cacheKeyFor(sessionId));
    // Remove meta and chunks
    var metaRaw = sessionStorage.getItem(metaKeyFor(sessionId));
    var chunkCount = 0;
    if (metaRaw) {
      try {
        var meta = JSON.parse(metaRaw) || {};
        chunkCount = Number(meta.chunkCount || 0);
      } catch (_) {}
    }
    sessionStorage.removeItem(metaKeyFor(sessionId));
    // Remove known chunk count, plus a safety sweep up to the cap
    var max = chunkCount > 0 ? Math.min(chunkCount + 5, CACHE_MAX_CHUNKS) : CACHE_MAX_CHUNKS;
    for (var i = 0; i < max; i++) {
      sessionStorage.removeItem(chunkKeyFor(sessionId, i));
    }
  } catch (_) {}
}

function saveCachedSessionEntries(sessionId, entries) {
  var arr = Array.isArray(entries) ? entries.slice() : [];
  // Annotate entries with session metadata for aggregated view rendering
  var meta = findSession(sessionId) || {};
  var annotated = arr.map(function (e) {
    var out = Object.assign({}, e);
    out.__session_id = sessionId;
    out.__session_keyword = meta.keyword || '';
    out.__session_created_at = meta.created_at || '';
    // will be set to length below and stay current via sessionCounts
    out.__session_products_count = arr.length;
    return out;
  });

  sessionResultsCache[sessionId] = annotated;
  sessionCounts[sessionId] = annotated.length;
  upsertResultsSelect();

  // Persist full entries in chunked sessionStorage
  try {
    // Clear any previous chunks to avoid stale leftover blocks
    removeSessionCachedEntries(sessionId);

    var chunkCount = Math.ceil(annotated.length / CACHE_CHUNK_SIZE);
    for (var i = 0; i < chunkCount; i++) {
      var start = i * CACHE_CHUNK_SIZE;
      var end = Math.min(start + CACHE_CHUNK_SIZE, annotated.length);
      var part = annotated.slice(start, end);
      sessionStorage.setItem(chunkKeyFor(sessionId, i), JSON.stringify(part));
    }
    var metaBlob = { count: annotated.length, chunkCount: chunkCount, ts: Date.now() };
    sessionStorage.setItem(metaKeyFor(sessionId), JSON.stringify(metaBlob));
  } catch (_) {
    // Fallback — at least keep a capped preview (legacy format)
    try {
      var capped = annotated.slice(0, 200);
      var blob = JSON.stringify({ entries: capped, count: annotated.length, ts: Date.now() });
      sessionStorage.setItem(cacheKeyFor(sessionId), blob);
    } catch (_2) {}
  }
}

// Progressive renderer: append batches without spinner
function progressiveRenderSession(sessionId, sortedEntries, initialCount) {
  var total = Array.isArray(sortedEntries) ? sortedEntries.length : 0;
  var count = Math.max(0, Math.min(initialCount || 0, total));
  var batch = 12;
  var delayMs = 120;

  function isStillSelected() {
    return resultsSelect && String(resultsSelect.value) === String(sessionId);
  }

  function step() {
        if (!isStillSelected()) return;
        if (__detailOpen) return; // stop progressive updates while detail is open
        count = Math.min(total, count + batch);
        try { renderProductsGrid(sortedEntries.slice(0, count)); } catch (e) { console.error('Progressive render failed', e); }
        if (count < total) setTimeout(step, delayMs);
    }

  if (count < total) setTimeout(step, delayMs);
  if (count === 0 && total > 0 && isStillSelected()) {
    try { renderProductsGrid(sortedEntries.slice(0, Math.min(8, total))); } catch (e) { console.error('Initial progressive render failed', e); }
    count = Math.min(8, total);
    if (count < total) setTimeout(step, delayMs);
  }
}

function renderProductsGrid(entries) {
  if (__detailOpen) return;

  productsGrid.innerHTML = '';
  if (!entries || entries.length === 0) {
    // While loading, suppress the empty-state message
    if (__resultsLoadingFlag) return;
    var empty = document.createElement('div');
    empty.className = 'text-[var(--muted)] text-sm';
    empty.textContent = 'No products yet.';
    productsGrid.appendChild(empty);
    return;
  }

  // Try auto-reopen after a hard reload once the target entry is present
    if (pendingReopen && entries && entries.length) {
      try {
        var target = entries.find(function (e) {
          var lidMatch = String(e && e.listing_id) === String(pendingReopen.listing_id);
          var sel = (resultsSelect && resultsSelect.value) || '';
          // In single-session view, match by current selection instead of entry annotation
          // because entries from server are not annotated with __session_id.
          var sidMatch = true;
          if (sel && sel !== '__all__') {
            sidMatch = String(sel) === String(pendingReopen.session_id);
          }
          return lidMatch && sidMatch;
        });
        if (target) {
          clearPendingReopen();
          showProductDetail(target);
          return; // detail view will replace grid immediately
        }
      } catch (_) {}
    }

  entries.forEach(function (entry) {
      var title = entry && entry.title || '';
      var url = entry && entry.url || '';
      var demand = (entry && typeof entry.demand !== 'undefined') ? entry.demand : null;
      var image = entry && entry.primary_image && entry.primary_image.image_url || '';
      var srcset = entry && entry.primary_image && entry.primary_image.srcset || '';
      var listingId = entry && entry.listing_id || '';
      var madeAt = entry && entry.made_at || '';

      var views = (entry && entry.views != null) ? entry.views : '—';
      var favorers = (entry && entry.num_favorers != null) ? entry.num_favorers : '—';

       // Price display (original/base)
      var priceObj = (entry && entry.price) || {};
        var amount = (priceObj && priceObj.amount != null) ? priceObj.amount : (entry && entry.price_amount);
        var divisor = (priceObj && priceObj.divisor != null) ? priceObj.divisor : (entry && entry.price_divisor);
        var currency = (priceObj.currency_code || entry.price_currency || '').trim();
        var priceDisplay = (entry && entry.price_display) || null;

        if (!priceDisplay) {
            try {
                if (typeof amount === 'number' && typeof divisor === 'number' && divisor) {
                    var val = amount / divisor;
                    var disp = (val.toFixed(2)).replace(/\.00$/, '');
                    priceDisplay = disp + (currency ? (' ' + currency) : '');
                }
            } catch (_) {}
        }
        // Fallback: compute from price_value + currency if display and amount/divisor are missing
        if (!priceDisplay && typeof entry.price_value === 'number' && isFinite(entry.price_value)) {
            try {
                var pv = Math.round(entry.price_value * 100) / 100;
                var pvDisp = pv.toFixed(2).replace(/\.00$/, '');
                priceDisplay = pvDisp + (currency ? (' ' + currency) : '');
            } catch (_) {}
        }

        // Sale price: normalize number and append currency code
      var promoDesc = (entry && (entry.buyer_applied_promotion_description || entry.buyer_promotion_description)) || '';
      var saleDisplay = '';
      var saleVal = null;

      if (entry && typeof entry.sale_price_display === 'string' && entry.sale_price_display.trim()) {
        var dispClean = entry.sale_price_display.replace(/[^0-9.,]/g, '').trim();
        var normalized = dispClean;
        if (normalized.indexOf(',') !== -1 && normalized.indexOf('.') === -1) { normalized = normalized.replace(',', '.'); }
        var asNum = parseFloat(normalized.replace(/,/g, ''));
        if (!isNaN(asNum) && isFinite(asNum)) {
          var numStr = (Math.round(asNum * 100) / 100).toFixed(2).replace(/\.00$/, '');
          saleDisplay = numStr + (currency ? (' ' + currency) : '');
        } else {
          saleDisplay = dispClean + (currency ? (' ' + currency) : '');
        }
      } else if (typeof entry.sale_price_value === 'number' && isFinite(entry.sale_price_value)) {
        saleVal = entry.sale_price_value;
      } else if (entry && typeof entry.sale_subtotal_after_discount === 'string' && entry.sale_subtotal_after_discount.trim()) {
        try {
          var cleaned = entry.sale_subtotal_after_discount.replace(/[^0-9.]/g, '');
          var parsed = parseFloat(cleaned);
          if (!isNaN(parsed) && isFinite(parsed)) saleVal = parsed;
        } catch (_) {}
      }
      if (saleVal == null) {
        var baseVal = null;
        if (typeof amount === 'number' && typeof divisor === 'number' && divisor) {
          baseVal = amount / divisor;
        } else if (typeof entry.price_value === 'number' && isFinite(entry.price_value)) {
          baseVal = entry.price_value;
        }
        if (baseVal != null) {
          try {
            var m = (promoDesc || '').match(/(\d+(?:\.\d+)?)\s*%/);
            var pct = m ? parseFloat(m[1]) : null;
            if (pct != null && isFinite(pct)) {
              saleVal = baseVal * (1 - pct / 100);
            }
          } catch (_) {}
        }
      }
      if (!saleDisplay && saleVal != null) {
        var saleStr = (Math.round(saleVal * 100) / 100).toFixed(2).replace(/\.00$/, '');
        saleDisplay = saleStr + (currency ? (' ' + currency) : '');
      }

      var hasSale = !!saleDisplay;
      var baseCellClass = 'px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs';
      var centeredClass = baseCellClass + ' h-full flex items-center justify-center text-center';
      var colCenteredClass = baseCellClass + ' h-full flex flex-col items-center justify-center text-center';

      // Spacer line used ONLY for non-sale rows
      var spacerLineHtml = '<div class="metric-spacer" aria-hidden="true" style="height:0.5rem;"></div>';

      var card = document.createElement('article');
      card.className = 'product-card';

      var mediaHtml = image
        ? '<img class="product-media" src="' + image + '" ' + (srcset ? ('srcset="' + srcset + '"') : '') + ' alt="">'
        : '<div class="product-media-placeholder">No image</div>';

      // Price: two-line and column layout only when sale exists; otherwise single-line centered
      var priceCellHtml = '';
      if (hasSale) {
        priceCellHtml =
          '<div class="' + colCenteredClass + ' metric-cell metric-cell-price">' +
          '  <div>Price: ' + escapeHtml(priceDisplay || '—') + '</div>' +
          '  <div>Sale Price: <span class="text-emerald-600 font-semibold">' + escapeHtml(saleDisplay) + '</span></div>' +
          '</div>';
      } else {
        priceCellHtml =
          '<div class="' + centeredClass + ' metric-cell metric-cell-price">Price: ' + escapeHtml(priceDisplay || '—') + '</div>';
      }
      // Favourites cell: no spacers for sale rows; spacers only for non-sale rows
      var favouritesCellHtml = '';
      if (hasSale) {
        favouritesCellHtml =
          '<div class="' + centeredClass + ' metric-cell metric-cell-favourites">Favourites: ' + escapeHtml(String(favorers)) + '</div>';
      } else {
        favouritesCellHtml =
          '<div class="' + colCenteredClass + ' metric-cell metric-cell-favourites">' +
            spacerLineHtml +
            '<div>Favourites: ' + escapeHtml(String(favorers)) + '</div>' +
            spacerLineHtml +
          '</div>';
      }

      var demandCellHtml = '<div class="' + baseCellClass + '">Demand: ' + (demand !== null ? escapeHtml(String(demand)) : '—') + '</div>';
      var viewsCellHtml  = '<div class="' + baseCellClass + '">Views: ' + escapeHtml(String(views)) + '</div>';

      card.innerHTML =
        mediaHtml +
        '<div class="product-body">' +
        '  <div class="product-title">' + escapeHtml(title) + '</div>' +
        '  <div class="grid grid-cols-2 gap-2 mt-1 items-stretch">' +
             demandCellHtml +
             viewsCellHtml +
             favouritesCellHtml +
             priceCellHtml +
        '  </div>' +
        '  <div class="mt-1 flex flex-col gap-1">' +
        '    <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Made: ' + escapeHtml(madeAt || '—') + '</div>' +
        '    <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Listing ID: ' + escapeHtml(String(listingId || '—')) + '</div>' +
        '  </div>' +
        '  <div class="product-actions">' +
        (url ? '<a class="link-btn" href="' + url + '" target="_blank" rel="noopener">View on Etsy</a>' : '') +
        '    <button class="link-btn ml-2 view-detail">View Detail</button>' +
        '  </div>' +
        '</div>';

      var detailBtn = card.querySelector('.view-detail');
      if (detailBtn) {
        detailBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          showProductDetail(entry);
        });
      }

      // Insert "Product Session Details" collapsible only in aggregated view
      var isAggregatedView = (resultsSelect && resultsSelect.value === '__all__');
      if (isAggregatedView) {
        var body = card.querySelector('.product-body');
        var actions = card.querySelector('.product-actions');

        var sessionId = entry.__session_id;
        var sKeyword = entry.__session_keyword || '';
        var sCreated = entry.__session_created_at || '';
        var sDate = fmtDateISO(sCreated);
        var sTime = fmtTimeISO(sCreated);
        var sCount = (sessionCounts && sessionCounts[sessionId] != null)
          ? sessionCounts[sessionId]
          : (entry.__session_products_count != null ? entry.__session_products_count : null);

        var toggleWrap = document.createElement('div');
        toggleWrap.className = 'mt-0.5'; // slimmer spacing than before

        var toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'w-full text-left px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs';
        toggleBtn.textContent = 'Product Session Details ▾';
        toggleBtn.setAttribute('aria-expanded', 'false');

        var details = document.createElement('div');
        details.className = 'rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs px-2 py-2';
        // Slim collapse: no margin when closed; expand to content height when open
        details.style.transition = 'max-height 0.22s ease, opacity 0.22s ease, margin-top 0.22s ease';
        details.style.overflow = 'hidden';
        details.style.maxHeight = '0';
        details.style.opacity = '0';
        details.style.marginTop = '0';

        details.innerHTML =
          '<div class="grid grid-cols-2 gap-2">' +
          '  <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)]">Session keyword: ' + escapeHtml(sKeyword || '—') + '</div>' +
          '  <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)]">Session Date: ' + escapeHtml(sDate || '—') + '</div>' +
          '  <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)]">Session Time: ' + escapeHtml(sTime || '—') + '</div>' +
          '  <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)]">Products found: ' + escapeHtml(String(sCount != null ? sCount : '—')) + '</div>' +
          '</div>';

        toggleWrap.appendChild(toggleBtn);
        toggleWrap.appendChild(details);

        if (body) {
          if (actions) body.insertBefore(toggleWrap, actions);
          else body.appendChild(toggleWrap);
        } else {
          card.appendChild(toggleWrap);
        }

        var open = false;
        toggleBtn.addEventListener('click', function (e) {
          e.preventDefault();
          open = !open;
          toggleBtn.textContent = open ? 'Product Session Details ▴' : 'Product Session Details ▾';
          toggleBtn.setAttribute('aria-expanded', String(open));
          if (open) {
            details.style.maxHeight = details.scrollHeight + 'px';
            details.style.opacity = '1';
            details.style.marginTop = '4px'; // minimal gap when open
          } else {
            details.style.maxHeight = '0';
            details.style.opacity = '0';
            details.style.marginTop = '0';   // no gap when collapsed
          }
        });
      }

      productsGrid.appendChild(card);

      // Equalize heights + enforce centering ONLY for rows with a sale price
      setTimeout(function () {
        var favEl = card.querySelector('.metric-cell-favourites');
        var priceEl = card.querySelector('.metric-cell-price');
        if (!favEl || !priceEl) return;

        // Always center content
        favEl.style.display = 'flex';
        favEl.style.alignItems = 'center';
        favEl.style.justifyContent = 'center';
        favEl.style.textAlign = 'center';
        favEl.style.boxSizing = 'border-box';

        priceEl.style.display = 'flex';
        priceEl.style.alignItems = 'center';
        priceEl.style.justifyContent = 'center';
        priceEl.style.textAlign = 'center';
        priceEl.style.boxSizing = 'border-box';
        priceEl.style.flexDirection = hasSale ? 'column' : 'row';

        if (hasSale) {
          // Match both to the sale-price box height
          var target = priceEl.offsetHeight;
          favEl.style.height = target + 'px';
          priceEl.style.height = target + 'px';
          favEl.style.minHeight = target + 'px';
          priceEl.style.minHeight = target + 'px';
        } else {
          // No sale in this 4-cell row: keep them slim, no forced height
          favEl.style.height = '';
          priceEl.style.height = '';
          favEl.style.minHeight = '';
          priceEl.style.minHeight = '';
        }
      }, 0);
  });
    }

    // Render a single-product detail view (clears products grid, keeps sidebar intact)
function showProductDetail(entry) {
  __detailOpen = true; // entering detail mode
  productsGrid.innerHTML = '';

  // Hide sort/filter bar in detail view
  var filterBar = document.getElementById('filter-bar');
  if (filterBar) filterBar.classList.add('hidden');

  var title = (entry && entry.title) || '';
  var image = (entry && entry.primary_image && entry.primary_image.image_url) || '';
  var srcset = (entry && entry.primary_image && entry.primary_image.srcset) || '';
  var url = (entry && entry.url) || '';

  // Key fields under "View on Etsy"
  var listingId = (entry && entry.listing_id != null) ? entry.listing_id : '—';
  __detailOpenListingId = listingId;
  var demand = (entry && entry.demand != null) ? entry.demand : '—';
  var madeAt = (entry && entry.made_at) || '—';
  var userId = (entry && entry.user_id != null) ? entry.user_id : '—';
  var shopId = (entry && entry.shop_id != null) ? entry.shop_id : '—';
  var state = (entry && entry.state) || '—';

  // Additional fields
  var lastModified = (entry && entry.last_modified) || '';
  var quantity = (entry && entry.quantity != null) ? entry.quantity : '—';
  var favorers = (entry && entry.num_favorers != null) ? entry.num_favorers : '—';
  var views = (entry && entry.views != null) ? entry.views : '—';
  var listingType = (entry && entry.listing_type) || '';
  var isDigital = String(listingType || '').toLowerCase() === 'download';
  var fileData = isDigital ? ((entry && entry.file_data) || '—') : '';

  // Arrays
    var tags = Array.isArray(entry && entry.tags) ? entry.tags.filter(Boolean) : [];
    // Keywords: can be strings or rich objects with metrics/trend
    var rawKeywords = Array.isArray(entry && entry.keywords) ? entry.keywords.filter(Boolean) : [];
    var materials = Array.isArray(entry && entry.materials) ? entry.materials.filter(Boolean) : [];
    // Add variations array
    var variations = Array.isArray(entry && entry.variations)
      ? entry.variations.filter(function (v) {
          return v && (v.id || v.title || (Array.isArray(v.options) && v.options.length));
        })
      : [];
    var hasVariations = !!(Array.isArray(variations) && variations.length) || !!entry.has_variations;

  // Demand extras
    var demandExtras = (entry && entry.demand_extras) || {};
    var totalCarts = (demandExtras && demandExtras.total_carts != null) ? demandExtras.total_carts : '—';
    var deQty = (demandExtras && demandExtras.quantity != null) ? demandExtras.quantity : '—';
    var estDeliv = demandExtras ? demandExtras.estimated_delivery_date : null;
    var estDelivDisplay = '—';
    if (estDeliv !== undefined && estDeliv !== null) {
      if (typeof estDeliv === 'string') {
        estDelivDisplay = estDeliv;
      } else if (typeof estDeliv === 'number') {
        try {
          var dED = new Date(estDeliv * 1000);
          estDelivDisplay = isFinite(dED.getTime()) ? dED.toLocaleDateString() : String(estDeliv);
        } catch (_) { estDelivDisplay = String(estDeliv); }
      } else {
        estDelivDisplay = String(estDeliv);
      }
    }
    var freeShip = (demandExtras && 'free_shipping' in demandExtras) ? demandExtras.free_shipping : null;
    var freeShipDisplay = (freeShip === true) ? 'Yes' : (freeShip === false ? 'No' : '—');

    // Merge backend keyword_insights into rawKeywords for metrics and trend
    var insights = Array.isArray(entry && entry.keyword_insights) ? entry.keyword_insights : [];
    var insightsByKey = {};
    for (var iI = 0; iI < insights.length; iI++) {
        var ik = insights[iI];
        var keyTxt = String(ik.keyword || ik.text || '').trim().toLowerCase();
        if (keyTxt) insightsByKey[keyTxt] = ik;
    }
    var mergedKeywords = rawKeywords.map(function (kw) {
        if (kw && typeof kw === 'object') return kw; // already rich, keep as-is
        var text = String(kw || '');
        var norm = text.trim().toLowerCase();

        // Try exact match first
        var found = insightsByKey[norm];

        // Fallback: partial contains match (handles verbose query text vs simplified keyword)
        if (!found) {
            for (var j = 0; j < insights.length; j++) {
                var ktxt = String(insights[j].keyword || insights[j].text || '').trim().toLowerCase();
                if (!ktxt) continue;
                if (ktxt === norm || ktxt.indexOf(norm) !== -1 || norm.indexOf(ktxt) !== -1) {
                    found = insights[j];
                    break;
                }
            }
        }

        if (found) {
            var vol = (found.vol != null) ? found.vol
                : (found.stats && typeof found.stats.searchVolume === 'number' ? found.stats.searchVolume : null);
            var comp = (found.competition != null) ? found.competition
                : (found.stats && typeof found.stats.avgTotalListings === 'number' ? found.stats.avgTotalListings : null);

            // Normalize dailyStats shape to an array [{date, searchVolume}, ...]
            var ds = [];
            if (Array.isArray(found.dailyStats)) {
                ds = found.dailyStats.slice();
            } else if (found.dailyStats && Array.isArray(found.dailyStats.stats)) {
                ds = found.dailyStats.stats.slice();
            }

            return {
                keyword: text,
                volume: vol,
                competition: comp,
                dailyStats: ds
            };
        }
        return { keyword: text }; // no insight available
    });

// Keyword normalization now uses merged objects (with metrics/trend if present)
    var keywordSuffix = String(listingId || Math.random()).replace(/\D/g, '');
    function firstNumber(cands) {
        for (var i = 0; i < cands.length; i++) {
            var v = cands[i];
            if (v !== undefined && v !== null && !isNaN(Number(v))) return Number(v);
        }
        return null;
    }

  // Price formatting: prefer server-provided display, otherwise compute
  var priceDisplay = (entry && entry.price_display) || '';
    var amount = (entry && entry.price_amount);
    var divisor = (entry && entry.price_divisor) || 0;
    var currency = (entry && entry.price_currency) || '';
    var baseVal = null;
    if (!priceDisplay) {
      if (typeof amount === 'number' && typeof divisor === 'number' && divisor) {
        baseVal = amount / divisor;
        var disp = (Math.round(baseVal * 100) / 100).toFixed(2).replace(/\.00$/, '');
        priceDisplay = disp + (currency ? (' ' + currency) : '');
      }
    } else {
      if (typeof amount === 'number' && typeof divisor === 'number' && divisor) {
        baseVal = amount / divisor;
      }
    }

    // Sale info and sale price (prefer backend, append currency code)
    var promoName = (entry && entry.buyer_promotion_name) || '';
    var promoShopName = (entry && entry.buyer_shop_promotion_name) || '';
    var promoDesc = (entry && (entry.buyer_applied_promotion_description || entry.buyer_promotion_description)) || '';
    var saleDisplay = (entry && entry.sale_price_display) || '';

    if (saleDisplay) {
      var dispClean = saleDisplay.replace(/[^0-9.,]/g, '').trim();
      var normalized = dispClean;
      if (normalized.indexOf(',') !== -1 && normalized.indexOf('.') === -1) { normalized = normalized.replace(',', '.'); }
      var asNum = parseFloat(normalized.replace(/,/g, ''));
      if (!isNaN(asNum) && isFinite(asNum)) {
        saleDisplay = (Math.round(asNum * 100) / 100).toFixed(2).replace(/\.00$/, '') + (currency ? (' ' + currency) : '');
      } else {
        saleDisplay = dispClean + (currency ? (' ' + currency) : '');
      }
    } else if (baseVal != null) {
      var percentMatch = (promoDesc || '').match(/(\d+(?:\.\d+)?)\s*%/);
      var salePercent = percentMatch ? parseFloat(percentMatch[1]) : null;
      if (salePercent != null && isFinite(salePercent)) {
        var saleVal = baseVal * (1 - salePercent / 100);
        var saleStr = (Math.round(saleVal * 100) / 100).toFixed(2).replace(/\.00$/, '');
        saleDisplay = saleStr + (currency ? (' ' + currency) : '');
      }
    }

  // Show header back button while in detail
  if (resultsBack) {
    resultsBack.classList.remove('hidden');
    resultsBack.onclick = function (e) {
      e.preventDefault();
      goBackFromDetail();
    };
  }

  // Shop block extras
  var shop = (entry && entry.shop) || {};
  var shop_languages = Array.isArray(shop.languages) ? shop.languages.filter(Boolean) : [];
  var shop_sections = Array.isArray(shop.sections) ? shop.sections : [];
  var shop_reviews = Array.isArray(shop.reviews) ? shop.reviews : [];
  var shop_review_avg = (shop && shop.review_average != null) ? shop.review_average : '—';
  var shop_review_count = (shop && shop.review_count != null) ? shop.review_count : '—';

  function formatUnix(ts) {
    try {
      if (!ts && ts !== 0) return '—';
      var d = new Date(ts * 1000);
      if (!isFinite(d.getTime())) return '—';
      return d.toLocaleDateString();
    } catch (e) { return '—'; }
  }

  var idSuffix = String(listingId || Math.random()).replace(/\D/g, '');
  var copyTagsBtnId = 'copy-tags-btn-' + idSuffix;
  var copyKeywordsBtnId = 'copy-keywords-btn-' + idSuffix;
  var copyDescriptionBtnId = 'copy-desc-btn-' + idSuffix;

  // Reviews section IDs
  var reviewGridId = 'reviews-grid-' + idSuffix;
  var reviewInfoId = 'reviews-info-' + idSuffix;
  var reviewLoadMoreId = 'reviews-load-more-' + idSuffix;
  var reviewLoadAllId = 'reviews-load-all-' + idSuffix;
  var reviewShowLessId = 'reviews-show-less-' + idSuffix;
  var reviewFilterId = 'reviews-filter-' + idSuffix;

  // Keyword insight helpers
  function firstNumber(cands) {
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (v !== undefined && v !== null && !isNaN(Number(v))) return Number(v);
    }
    return null;
  }
  function extractKeywordVolume(k) {
        return firstNumber([
            k && k.searchVolume,
            k && k.volume,                     // merged object uses `volume`
            k && k.search_volume,
            k && k.data && k.data.volume,
            k && k.metrics && (k.metrics.vol ?? k.metrics.volume ?? k.metrics.searchVolume),
            k && k.summary && (k.summary.avg_monthly_searches ?? k.summary.monthly_searches)
        ]);
    }
    function extractKeywordCompetition(k) {
        return firstNumber([
            k && k.competition,                // merged object uses `competition`
            k && k.metrics && k.metrics.competition,
            k && k.data && k.data.competition
        ]);
    }
    function extractKeywordTrend(k) {
    var series = null;
    if (Array.isArray(k && k.dailyStats && k.dailyStats.stats)) series = k.dailyStats.stats;
    else if (Array.isArray(k && k.dailyStats)) series = k.dailyStats;  // merged object uses `dailyStats`
    else if (Array.isArray(k && k.trend)) series = k.trend;
    else if (Array.isArray(k && k.data && k.data.trend)) series = k.data.trend;
    else if (Array.isArray(k && k.metrics && k.metrics.monthly)) series = k.metrics.monthly;
    else if (Array.isArray(k && k.history)) series = k.history;
    else if (Array.isArray(k && k.time_series)) series = k.time_series;
    else if (Array.isArray(k && k.timeseries)) series = k.timeseries;

    if (!Array.isArray(series) || !series.length) return [];

    var out = [];
    for (var i = 0; i < series.length; i++) {
        var item = series[i];
        var dateStr = '';
        var valueNum = 0;

        if (typeof item === 'number') {
            valueNum = Number(item);
        } else if (item && typeof item === 'object') {
            if ('date' in item && 'searchVolume' in item) {
                dateStr = String(item.date);
                valueNum = Number(item.searchVolume);
            } else if ('date' in item && 'value' in item) {
                dateStr = String(item.date);
                valueNum = Number(item.value);
            } else if ('month' in item && 'value' in item) {
                dateStr = String(item.month);
                valueNum = Number(item.value);
            } else if ('date' in item && 'count' in item) {
                dateStr = String(item.date);
                valueNum = Number(item.count);
            } else {
                var foundVal = firstNumber(Object.values(item));
                valueNum = foundVal === null ? 0 : foundVal;
                dateStr = (item.date || item.month || item.ts || item.timestamp || '');
            }
        }

        // Only use numeric timestamp when present; do NOT parse dateStr like "Oct 8"
        var d = null;
        if (item && typeof item === 'object') {
            var ts = item.ts || item.timestamp;
            if (ts !== undefined && ts !== null && !isNaN(Number(ts))) {
                var n = Number(ts);
                d = new Date(n > 1e12 ? n : n * 1000);
            }
        }

        // Tooltip label: prefer JSON-provided date string
        var lbl = dateStr ? dateStr : (d ? d.toLocaleDateString() : ('#' + (i + 1)));

        out.push({
            x: d ? d.getTime() : i,         // index-based position when no timestamp
            label: lbl,                     // show "Oct 8" etc. from JSON directly
            value: isNaN(valueNum) ? 0 : valueNum
        });
    }
    return out;
}
    function normalizeKeyword(item) {
        var text = (typeof item === 'string')
          ? item
          : (item.keyword || item.term || item.text || item.name || '');
        var vol = extractKeywordVolume(item);
        var comp = extractKeywordCompetition(item);
        var trend = extractKeywordTrend(item);
        return { text: String(text || ''), vol: vol, comp: comp, trend: trend };
    }
    var normalizedKeywords = mergedKeywords.map(normalizeKeyword).filter(function (k) { return k && k.text; });
  // Build HTML
  var wrap = document.createElement('div');
  wrap.className = 'col-span-full';

  // Precompute keyword insights cards HTML and chart configs
  var keywordCardsHTML = '';
  var keywordCharts = [];
  var perKeywordCopyIds = [];

  for (var i = 0; i < normalizedKeywords.length; i++) {
    var k = normalizedKeywords[i];
    var chartId = 'kw-chart-' + keywordSuffix + '-' + i;
    var copyId = 'kw-copy-' + keywordSuffix + '-' + i;
    keywordCharts.push({ id: chartId, series: k.trend });
    perKeywordCopyIds.push({ id: copyId, text: k.text });

    var volDisp = (k.vol !== null && k.vol !== undefined) ? String(k.vol) : '—';
    var compDisp = (k.comp !== null && k.comp !== undefined) ? String(k.comp) : '—';

    keywordCardsHTML += '' +
      '<div class="px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-1)]">' +
      '  <div class="flex items-center justify-between">' +
      '    <div class="font-medium text-sm break-words">' + escapeHtml(k.text) + '</div>' +
      '    <button id="' + copyId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-1)] transition">Copy</button>' +
      '  </div>' +
      '  <div class="flex flex-wrap gap-2 mt-1">' +
      '    <span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs">Vol: ' + escapeHtml(volDisp) + '</span>' +
      '    <span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs">Competition: ' + escapeHtml(compDisp) + '</span>' +
      '  </div>' +
      '  <div class="mt-2 relative">' +
      (k.trend && k.trend.length
        ? '<div id="' + chartId + '" class="relative h-28 w-full overflow-hidden rounded border border-[var(--border)] bg-[var(--surface-2)]"></div>'
        : '<div class="text-xs text-[var(--muted)] px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)]">No trend data</div>') +
      '  </div>' +
      '</div>';
  }

  wrap.innerHTML =
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">' +
    // Left: image
    '  <div class="space-y-3">' +
    (image
      ? ('<img class="w-full h-64 md:h-80 object-contain bg-[var(--surface-1)] border border-[var(--border)] rounded-lg" src="' + image + '" ' + (srcset ? ('srcset="' + srcset + '"') : '') + ' alt="">')
      : '<div class="w-full h-64 md:h-80 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg grid place-items-center text-[var(--muted)]">No image</div>') +
    '  </div>' +
    // Right: title, Etsy button, key details
    '  <div class="flex flex-col gap-3">' +
    '    <h3 class="text-xl md:text-2xl font-semibold break-words">' + escapeHtml(title) + '</h3>' +
    (url
      ? '    <div class="flex items-center gap-2"><a class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition" href="' + url + '" target="_blank" rel="noopener">View on Etsy</a><button id="update-product-btn" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Update Product</button></div>'
      : '    <div><button id="update-product-btn" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Update Product</button></div>') +
    '    <div class="mt-1 grid grid-cols-2 lg:grid-cols-3 gap-2">' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Listing ID</div><div class="font-medium break-words">' + escapeHtml(String(listingId)) + '</div></div>' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Demand</div><div class="font-medium break-words">' + escapeHtml(String(demand)) + '</div></div>' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Made</div><div class="font-medium break-words">' + escapeHtml(String(madeAt)) + '</div></div>' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">User ID</div><div class="font-medium break-words">' + escapeHtml(String(userId)) + '</div></div>' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Shop ID</div><div class="font-medium break-words">' + escapeHtml(String(shopId)) + '</div></div>' +
    '      <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">State</div><div class="font-medium break-words">' + escapeHtml(String(state)) + '</div></div>' +
    '    </div>' +
    '  </div>' +
    // More details: compact grid
    '  <div class="md:col-span-2 mt-1 grid grid-cols-2 lg:grid-cols-3 gap-2">' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Price</div><div class="font-medium break-words">' + escapeHtml(priceDisplay || '—') + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Sale Price</div><div class="font-medium break-words">' + escapeHtml(saleDisplay || '—') + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Last modified</div><div class="font-medium break-words">' + escapeHtml(lastModified || '—') + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Quantity</div><div class="font-medium break-words">' + escapeHtml(String(quantity)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Favorers</div><div class="font-medium break-words">' + escapeHtml(String(favorers)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Views</div><div class="font-medium break-words">' + escapeHtml(String(views)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Listing type</div><div class="font-medium break-words">' + escapeHtml(listingType || '—') + '</div></div>' +
    // Insert demand_extras next to Views / Listing type
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Total carts</div><div class="font-medium break-words">' + escapeHtml(String(totalCarts)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Quantity (DE)</div><div class="font-medium break-words">' + escapeHtml(String(deQty)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Est. delivery</div><div class="font-medium break-words">' + escapeHtml(estDelivDisplay) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Free shipping</div><div class="font-medium break-words">' + escapeHtml(freeShipDisplay) + '</div></div>' +
    (isDigital
      ? ('<div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">File data</div><div class="font-medium break-words">' + escapeHtml(fileData) + '</div></div>')
      : '') +
    '    <div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
      '      <div class="flex items-center justify-between mb-1">' +
      '        <div class="text-[var(--muted)] text-xs">Description</div>' +
      '        <button id="' + copyDescriptionBtnId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Copy description</button>' +
      '      </div>' +
      '      <div class="whitespace-pre-line break-words max-h-36 overflow-auto">' + escapeHtml(String((entry && entry.description) || '—')) + '</div>' +
      '    </div>' +
      // Keywords section with cards + charts
      (normalizedKeywords.length
        ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
           '  <div class="flex items-center justify-between mb-2"><div class="text-[var(--muted)] text-xs">Keywords</div>' +
           '    <button id="' + copyKeywordsBtnId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Copy keywords</button>' +
           '  </div>' +
           '  <div class="grid grid-cols-1 md:grid-cols-2 gap-2">' +
           keywordCardsHTML +
           '  </div>' +
           '</div>')
        : '') +
    // Tags with copy
    (tags.length
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
         '  <div class="flex items-center justify-between mb-2"><div class="text-[var(--muted)] text-xs">Tags</div>' +
         '    <button id="' + copyTagsBtnId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Copy tags</button>' +
         '  </div>' +
         '  <div class="flex flex-wrap gap-1.5">' +
         tags.map(function(t){ return '<span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1">' + escapeHtml(String(t)) + '</span>'; }).join('') +
         '  </div>' +
         '</div>')
      : '') +
    // Materials if any
    (materials.length
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
         '  <div class="text-[var(--muted)] text-xs mb-2">Materials</div>' +
         '  <div class="flex flex-wrap gap-1.5">' +
         materials.map(function(m){ return '<span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1">' + escapeHtml(String(m)) + '</span>'; }).join('') +
         '  </div>' +
         '</div>')
      : '') +
    // Variations if any
    (variations.length
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)]">' +
         '  <div class="text-[var(--muted)] text-xs mb-2">Variations</div>' +
         '  <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">' +
         variations.map(function(v){ var opts = Array.isArray(v.options) ? v.options : []; return '' +
           '<div class="px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-1)]">' +
           '  <div class="flex items-center justify-between">' +
           '    <div class="font-medium text-sm break-words">' + escapeHtml(String(v.title || '—')) + '</div>' +
           '    <div class="text-xs text-[var(--muted)]">ID: ' + escapeHtml(String(v.id || '—')) + '</div>' +
           '  </div>' +
           (opts.length
             ? ('<div class="flex flex-wrap gap-1.5 mt-2">' +
                opts.map(function(o){ var lbl = escapeHtml(String(o.label || '—')); var val = escapeHtml(String(o.value || '—')); return '<span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs">' + lbl + ' <span class="text-[var(--muted)] ml-1">(' + val + ')</span></span>'; }).join('') +
                '</div>')
             : '<div class="text-xs text-[var(--muted)] mt-2">No options</div>') +
           '</div>'; }).join('') +
         '  </div>' +
         '</div>')
      : '') +
    // Sale info
    ((promoName || promoShopName || promoDesc || saleDisplay)
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
         '  <div class="text-[var(--muted)] text-xs mb-2">Sale</div>' +
         '  <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Name</div><div class="font-medium break-words">' + escapeHtml(promoName || '—') + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Shop promo</div><div class="font-medium break-words">' + escapeHtml(promoShopName || '—') + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Description</div><div class="font-medium break-words">' + escapeHtml(promoDesc || '—') + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Original price</div><div class="font-medium break-words">' + escapeHtml(priceDisplay || '—') + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Sale price</div><div class="font-medium break-words">' + escapeHtml(saleDisplay || '—') + '</div></div>' +
         '  </div>' +
         '</div>')
      : '') +
    // Shop details + metrics + reviews
    ((shop && (shop.shop_id != null || shop.shop_name || shop.title || shop.created_timestamp != null))
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
         '  <div class="flex items-center justify-between mb-2"><div class="text-[var(--muted)] text-xs">Shop</div>' +
         (shop.url ? ('<a class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition" href="' + escapeHtml(shop.url) + '" target="_blank" rel="noopener">Open shop</a>') : '') +
         '  </div>' +
         '  <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Shop ID</div><div class="font-medium break-words">' + escapeHtml(String(shop.shop_id || '—')) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Shop name</div><div class="font-medium break-words">' + escapeHtml(String(shop.shop_name || '—')) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Created</div><div class="font-medium break-words">' + escapeHtml(String(shop.created || formatUnix(shop.created_timestamp))) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Title</div><div class="font-medium break-words">' + escapeHtml(String(shop.title || '—')) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Currency</div><div class="font-medium break-words">' + escapeHtml(String(shop.currency_code || '—')) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Vacation</div><div class="font-medium break-words">' + escapeHtml(String((typeof shop.is_vacation === "boolean") ? (shop.is_vacation ? "yes" : "no") : "—")) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Review avg</div><div class="font-medium break-words">' + escapeHtml(String(shop_review_avg)) + '</div></div>' +
         '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs">Review count</div><div class="font-medium break-words">' + escapeHtml(String(shop_review_count)) + '</div></div>' +
         '    <div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs mb-1">Announcement</div><div class="whitespace-pre-line break-words max-h-24 overflow-auto">' + escapeHtml(String(shop.announcement || '—')) + '</div></div>' +
         '    <div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs mb-1">Vacation message</div><div class="whitespace-pre-line break-words max-h-24 overflow-auto">' + escapeHtml(String(shop.vacation_message || '—')) + '</div></div>' +
         '    <div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs mb-1">Sale message</div><div class="whitespace-pre-line break-words max-h-24 overflow-auto">' + escapeHtml(String(shop.sale_message || '—')) + '</div></div>' +
         '    <div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]"><div class="text-[var(--muted)] text-xs mb-1">Digital sale message</div><div class="whitespace-pre-line break-words max-h-24 overflow-auto">' + escapeHtml(String(shop.digital_sale_message || '—')) + '</div></div>' +
         (shop_languages.length
           ? ('<div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]">' +
              '  <div class="text-[var(--muted)] text-xs mb-1">Languages</div>' +
              '  <div class="flex flex-wrap gap-1.5">' +
              shop_languages.map(function(l){ return '<span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1">' + escapeHtml(String(l)) + '</span>'; }).join('') +
              '  </div>' +
              '</div>')
           : '') +
         (shop_sections.length
           ? ('<div class="col-span-2 lg:col-span-3 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-1)]">' +
              '  <div class="text-[var(--muted)] text-xs mb-1">Sections</div>' +
              '  <div class="grid grid-cols-2 lg:grid-cols-3 gap-2">' +
              shop_sections.map(function(s){ var title = escapeHtml(String(s.title || '—')); var count = escapeHtml(String(s.active_listing_count != null ? s.active_listing_count : '—')); return '<div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)]"><div class="font-medium break-words">' + title + '</div><div class="text-[var(--muted)] text-xs">Active: ' + count + '</div></div>'; }).join('') +
              '  </div>' +
              '</div>')
           : '') +
         // Reviews: compact column layout with progressive loading + relevant filter
         (shop_reviews.length
           ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-1)]">' +
              '  <div class="flex items-center justify-between mb-2">' +
              '    <div class="flex items-center gap-2">' +
              '      <div class="text-[var(--muted)] text-xs">Reviews</div>' +
              '      <label class="inline-flex items-center gap-1 text-xs cursor-pointer">' +
              '        <input id="' + reviewFilterId + '" type="checkbox" class="accent-emerald-500">' +
              '        <span class="text-[var(--muted)]">Only relevant</span>' +
              '      </label>' +
              '    </div>' +
              '    <div id="' + reviewInfoId + '" class="text-xs text-[var(--muted)]">Showing 0 of ' + shop_reviews.length + '</div>' +
              '  </div>' +
              '  <div class="flex flex-wrap gap-2 mb-2">' +
              '    <button id="' + reviewLoadMoreId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-1)] transition">Load more</button>' +
              '    <button id="' + reviewLoadAllId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-1)] transition">Load all</button>' +
              '    <button id="' + reviewShowLessId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-1)] transition">Show less</button>' +
              '  </div>' +
              '  <div id="' + reviewGridId + '" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2"></div>' +
              '</div>')
           : '') +
         '  </div>' +
         '</div>')
      : '') +
    '</div>';

  productsGrid.appendChild(wrap);

  // Wire up “Update Product” button
  var upBtn = document.getElementById('update-product-btn');
    if (upBtn) {
      upBtn.addEventListener('click', function (e) {
      e.preventDefault();
      // Button loading state
      upBtn.disabled = true;
      upBtn.textContent = 'Updating…';

      // Decide session id: respect current selection; aggregated uses per-entry annotation
      var sel = (resultsSelect && resultsSelect.value) || '';
      var sid = (sel && sel !== '__all__') ? Number(sel) : Number(entry.__session_id || 0);

      // Build payload
      var payload = {
        listing_id: listingId,
        session_id: sid,
        forced_personalize: !!hasVariations
      };

      fetch('/api/bulk-research/replace-listing/', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, csrfHeader()),
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      })
      .then(function (r) {
        return r.text().then(function (txt) {
          var body = {};
          try { body = JSON.parse(txt || '{}'); } catch (_) {}
          if (!r.ok) {
            var msg = (body && body.error) || ('Update failed (' + r.status + ')');
            throw new Error(msg);
          }
          return body;
        });
      })
      .then(function (body) {
          try {
            // Bust all caches for this session to ensure fresh fetch on reload
            removeSessionCachedEntries(sid);
            delete sessionResultsCache[sid];
            delete sessionCounts[sid];
          } catch (_) {}
          try {
          // Persist reopen target across hard reload
            localStorage.setItem(REOPEN_STORAGE_KEY, JSON.stringify({
              session_id: sid,
              listing_id: listingId,
              ts: Date.now()
            }));
          } catch (_) {}
          // Hard reload
          window.location.reload();
        })
        .catch(function (err) {
        alert('Update failed: ' + err.message);
        upBtn.disabled = false;
        upBtn.textContent = 'Update Product';
      });
    });
  }

  // Wire up copy buttons
  var copyTagsBtn = document.getElementById(copyTagsBtnId);
  if (copyTagsBtn) {
    var text = tags.join(', ');
    copyTagsBtn.addEventListener('click', function () {
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      copyTagsBtn.textContent = 'Copied!';
      setTimeout(function(){ copyTagsBtn.textContent = 'Copy tags'; }, 1200);
    });
  }
  var copyKeywordsBtn = document.getElementById(copyKeywordsBtnId);
  if (copyKeywordsBtn) {
    var ktext = normalizedKeywords.map(function(k){ return k.text; }).join(', ');
    copyKeywordsBtn.addEventListener('click', function () {
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = ktext;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(ktext).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      copyKeywordsBtn.textContent = 'Copied!';
      setTimeout(function(){ copyKeywordsBtn.textContent = 'Copy keywords'; }, 1200);
    });
  }
  var copyDescriptionBtn = document.getElementById(copyDescriptionBtnId);
  if (copyDescriptionBtn) {
    var descText = String((entry && entry.description) || '');
    copyDescriptionBtn.addEventListener('click', function () {
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = descText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(descText).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      copyDescriptionBtn.textContent = 'Copied!';
      setTimeout(function(){ copyDescriptionBtn.textContent = 'Copy description'; }, 1200);
    });
  }
  // Per-keyword copy buttons
  for (var i2 = 0; i2 < perKeywordCopyIds.length; i2++) {
    (function (cfg) {
      var btn = document.getElementById(cfg.id);
      if (!btn) return;
      btn.addEventListener('click', function () {
        var txt = cfg.text || '';
        function fallbackCopy() {
          var ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          try { document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta);
        }
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(txt).catch(fallbackCopy);
        } else {
          fallbackCopy();
        }
        btn.textContent = 'Copied!';
        setTimeout(function(){ btn.textContent = 'Copy'; }, 1000);
      });
    })(perKeywordCopyIds[i2]);
  }

  // Reviews: progressive loading controls + filter
  (function setupReviews() {
    if (!shop_reviews.length) return;

    var grid = document.getElementById(reviewGridId);
    var info = document.getElementById(reviewInfoId);
    var btnMore = document.getElementById(reviewLoadMoreId);
    var btnAll = document.getElementById(reviewLoadAllId);
    var btnLess = document.getElementById(reviewShowLessId);
    var chkFilter = document.getElementById(reviewFilterId);

    var listingIdStr = (entry && entry.listing_id != null) ? String(entry.listing_id) : null;
    var filterRelevant = false;

    function stars(rating) {
      var n = Math.max(0, Math.min(5, Math.round(Number(rating || 0))));
      return n ? '★'.repeat(n) : '—';
    }

    function reviewCard(r) {
      var created = escapeHtml(String(r.created || formatUnix(r.created_timestamp)));
      var rating = r.rating != null ? escapeHtml(String(r.rating)) : '—';
      var lang = escapeHtml(String(r.language || '—'));
      var meta = [
        r.listing_id != null ? ('Listing: ' + escapeHtml(String(r.listing_id))) : '',
        r.transaction_id != null ? ('Txn: ' + escapeHtml(String(r.transaction_id))) : ''
      ].filter(Boolean).join(' • ');
      var body = escapeHtml(String(r.review || '—'));
      var preview = body.length > 200 ? (body.slice(0, 200) + '…') : body;

      // Green tint if review belongs to the same listing
      var isSameListing = (listingIdStr != null && String(r.listing_id) === listingIdStr);
      var boxStyle = isSameListing
        ? ' style="border-color: rgba(16,185,129,0.45); background-color: rgba(16,185,129,0.10); box-shadow: inset 0 0 0 1px rgba(16,185,129,0.25);"'
        : '';
      return '' +
        '<div class="rounded border border-[var(--border)] bg-[var(--surface-2)] p-2"' + boxStyle + '>' +
        '  <div class="flex items-center justify-between mb-1">' +
        '    <div class="font-medium text-xs sm:text-sm">' + stars(r.rating) + ' <span class="text-[var(--muted)]">(' + rating + ')</span></div>' +
        '    <div class="text-[var(--muted)] text-xs">' + created + ' • ' + lang + '</div>' +
        '  </div>' +
        (meta ? ('<div class="mb-1 text-[var(--muted)] text-xs">' + meta + '</div>') : '') +
        '  <details class="group">' +
        '    <summary class="cursor-pointer list-none text-xs sm:text-sm leading-snug">' +
        '      <span class="break-words">' + preview + '</span>' +
        '      ' + (body.length > 200 ? '<span class="ml-1 text-[var(--muted)]">Read more</span>' : '') +
        '    </summary>' +
        (body.length > 200 ? ('<div class="mt-1 text-xs sm:text-sm whitespace-pre-line break-words">' + body + '</div>') : '') +
        '  </details>' +
        '</div>';
    }

    function currentData() {
      var data = shop_reviews;
      if (filterRelevant && listingIdStr != null) {
        data = data.filter(function (r) { return String(r.listing_id) === listingIdStr; });
      }
      return data;
    }

    var total = currentData().length;
    var limit = Math.min(5, total);

    function render() {
      var data = currentData();
      total = data.length;
      if (limit > total) limit = total;

      var slice = data.slice(0, limit);
      grid.innerHTML = slice.length
        ? slice.map(reviewCard).join('')
        : '<div class="text-xs text-[var(--muted)]">No relevant reviews</div>';

      info.textContent = 'Showing ' + String(slice.length) + ' of ' + String(total) + (filterRelevant ? ' • filtered' : '');

      if (total <= 5) {
        if (btnMore) btnMore.style.display = 'none';
        if (btnAll) btnAll.style.display = 'none';
        if (btnLess) btnLess.style.display = 'none';
        return;
      }
      if (limit >= total) {
        if (btnMore) btnMore.style.display = 'none';
        if (btnAll) btnAll.style.display = 'none';
        if (btnLess) btnLess.style.display = 'inline-flex';
      } else if (limit <= 5) {
        if (btnMore) btnMore.style.display = 'inline-flex';
        if (btnAll) btnAll.style.display = 'inline-flex';
        if (btnLess) btnLess.style.display = 'none';
      } else {
        if (btnMore) btnMore.style.display = 'inline-flex';
        if (btnAll) btnAll.style.display = 'inline-flex';
        if (btnLess) btnLess.style.display = 'inline-flex';
      }
    }

    if (btnMore) btnMore.addEventListener('click', function () {
      limit = Math.min(total, limit + 5);
      render();
    });
    if (btnAll) btnAll.addEventListener('click', function () {
      limit = total;
      render();
    });
    if (btnLess) btnLess.addEventListener('click', function () {
      limit = Math.min(5, total);
      render();
    });
    if (chkFilter) chkFilter.addEventListener('change', function () {
      filterRelevant = chkFilter.checked;
      limit = Math.min(5, currentData().length);
      render();
    });

    render();
  })();

  // Render per-keyword interactive charts
  function renderTrendChart(containerId, series) {
    var container = document.getElementById(containerId);
    if (!container) return;

    container.style.position = 'relative';
    container.style.overflow = 'visible'; // ensure tooltip isn't clipped

    if (!Array.isArray(series) || !series.length) {
      container.innerHTML = '<div class="text-xs text-[var(--muted)] p-2">No trend data</div>';
      return;
    }

    // Layout: taller chart + more top padding for peaks
    var w = container.clientWidth || 600;
    var h = container.clientHeight || 180; // was 140
    var padLeft = 44;
    var padRight = 12;
    var padTop = 20; // was 12
    var padBottom = 32; // a little more room for x labels

    // Data bounds
    var minX = series[0].x, maxX = series[0].x;
    var minY = series[0].value, maxY = series[0].value;
    for (var i = 1; i < series.length; i++) {
      var s = series[i];
      if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
      if (s.value < minY) minY = s.value; if (s.value > maxY) maxY = s.value;
    }
    // Nice Y range
    if (minY === maxY) { minY -= 1; maxY += 1; }
    minY = Math.min(0, minY);

    function sx(x) {
      if (maxX === minX) return padLeft;
      return padLeft + ((x - minX) / (maxX - minX)) * (w - padLeft - padRight);
    }
    function sy(y) {
      return h - padBottom - ((y - minY) / (maxY - minY)) * (h - padTop - padBottom);
    }

    // Build path
    var path = '';
    for (var j = 0; j < series.length; j++) {
      var p = series[j];
      var x = sx(p.x), y = sy(p.value);
      path += (j === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
    }
    var area = path + 'L ' + (w - padRight) + ' ' + (h - padBottom) + ' L ' + padLeft + ' ' + (h - padBottom) + ' Z';

    // Y-axis ticks (min/mid/max)
    var yTicks = [minY, (minY + maxY) / 2, maxY].map(function (v) {
      var lab = Math.round(v * 100) / 100;
      return { v: v, y: sy(v), label: String(lab) };
    });

    // X-axis ticks: spread across series using labels
    var tickCount = Math.min(6, series.length);
    var xTickIdx = [];
    for (var t = 0; t < tickCount; t++) {
      var idx = Math.round((t / (tickCount - 1)) * (series.length - 1));
      if (xTickIdx.indexOf(idx) === -1) xTickIdx.push(idx);
    }
    var xTicks = xTickIdx.map(function (idx) {
      var s = series[idx];
      var lbl = (s.label || '').toString();
      return { idx: idx, x: sx(s.x), label: lbl };
    });

    // Compose SVG without x-axis line and ticks
  var svg = '' +
    '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' +
    '  <defs>' +
    '    <linearGradient id="kwGrad" x1="0" x2="0" y1="0" y2="1">' +
    '      <stop offset="0%" stop-color="rgba(99,102,241,0.35)"/>' +
    '      <stop offset="100%" stop-color="rgba(99,102,241,0.02)"/>' +
    '    </linearGradient>' +
    '  </defs>' +
    yTicks.map(function (t) {
      return '' +
        '<line x1="' + padLeft + '" y1="' + t.y + '" x2="' + (w - padRight) + '" y2="' + t.y + '" stroke="var(--border)" stroke-width="1" opacity="0.6"></line>' +
        '<text x="' + (padLeft - 6) + '" y="' + (t.y + 3) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + t.label + '</text>';
    }).join('') +
    // Removed: x-axis baseline and tick labels
    '  <path d="' + area + '" fill="url(#kwGrad)"></path>' +
    '  <path d="' + path + '" fill="none" stroke="rgba(99,102,241,0.9)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>' +
    '  <circle id="' + containerId + '-pt" cx="0" cy="0" r="3.5" fill="rgba(99,102,241,1)" stroke="white" stroke-width="1" style="opacity:0"></circle>' +
    '  <line id="' + containerId + '-vl" x1="0" y1="' + padTop + '" x2="0" y2="' + (h - padBottom) + '" stroke="rgba(99,102,241,0.35)" stroke-width="1" style="opacity:0"></line>' +
    '</svg>';

  container.innerHTML = svg;

    // Tooltip: ensure above SVG and readable
    var tip = document.createElement('div');
    tip.className = 'absolute pointer-events-none text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1 shadow-sm';
    tip.style.opacity = '0';
    tip.style.whiteSpace = 'nowrap';
    tip.style.zIndex = '10'; // keep above graph
    // do not set transform here; we’ll set it dynamically below
    container.appendChild(tip);

    var ptEl = container.querySelector('#' + containerId + '-pt');
    var vlEl = container.querySelector('#' + containerId + '-vl');

    function nearestIndex(mx) {
      // Find closest by screen-space x
      var best = { idx: 0, dist: Infinity };
      for (var i = 0; i < series.length; i++) {
        var xi = sx(series[i].x);
        var d = Math.abs(mx - xi);
        if (d < best.dist) best = { idx: i, dist: d };
      }
      return best.idx;
    }

    var pinnedIdx = null;

    function showAtIndex(idx) {
      var s = series[idx];
      var x = sx(s.x), y = sy(s.value);

      ptEl.setAttribute('cx', x); ptEl.setAttribute('cy', y);
      ptEl.style.opacity = '1';
      vlEl.setAttribute('x1', x); vlEl.setAttribute('x2', x);
      vlEl.style.opacity = '1';

      tip.textContent = (s.label || '') + ' • ' + s.value;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
      tip.style.opacity = '1';

      // Flip tooltip below the point when near the top so it never hides
      if (y <= padTop + 14) {
        tip.style.transform = 'translate(-50%, 12px)'; // place slightly below the dot
      } else {
        tip.style.transform = 'translate(-50%, -18px)'; // place slightly above the dot
      }
    }

    function hideMarker() {
      if (pinnedIdx !== null) return; // keep visible when pinned
      ptEl.style.opacity = '0';
      vlEl.style.opacity = '0';
      tip.style.opacity = '0';
    }

    container.addEventListener('pointerenter', function (e) {
      var rect = container.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var idx = nearestIndex(mx);
      showAtIndex(idx);
    });
    container.addEventListener('pointermove', function (e) {
      if (pinnedIdx !== null) return;
      var rect = container.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var idx = nearestIndex(mx);
      showAtIndex(idx);
    });
    container.addEventListener('pointerleave', function () {
      pinnedIdx = null;
      hideMarker();
    });
    container.addEventListener('click', function (e) {
      var rect = container.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      // Toggle pin
      if (pinnedIdx === null) {
        pinnedIdx = nearestIndex(mx);
        showAtIndex(pinnedIdx);
      } else {
        pinnedIdx = null;
        hideMarker();
      }
    });

    // Throttled responsive re-render
    var ro;
    try {
      var scheduled = false;
      ro = new ResizeObserver(function () {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function(){
          scheduled = false;
          renderTrendChart(containerId, series);
        }, 120);
      });
      ro.observe(container);
    } catch (err) {
      // ignore if ResizeObserver not available
    }
  }

  for (var i = 0; i < keywordCharts.length; i++) {
    var cfg = keywordCharts[i];
    renderTrendChart(cfg.id, cfg.series);
  }
}
    // Return from detail to the previously selected results
function goBackFromDetail() {
  __detailOpen = false;
  __detailOpenListingId = null;

  var saved = sessionStorage.getItem(SELECT_STORAGE_KEY) || '';
  var current = resultsSelect && resultsSelect.value ? resultsSelect.value : saved;

  // Show sort/filter bar again when leaving detail
  var filterBar = document.getElementById('filter-bar');
  if (filterBar) filterBar.classList.remove('hidden');

  // Hide header back button when leaving detail
  if (resultsBack) resultsBack.classList.add('hidden');

  if (!current) {
        var hasAnySessions = Array.isArray(sessions) && sessions.length > 0;
        if (hasAnySessions) {
            resultsSelect.value = '__all__';
            sessionStorage.setItem(SELECT_STORAGE_KEY, '__all__');
            resultsTitle.textContent = 'All Sessions — aggregated';
            loadAllSessionsResults();
            return;
        }
        resultsTitle.textContent = 'No session selected';
        renderEmptyPrompt();
        return;
    }
  if (current === '__all__') {
    resultsTitle.textContent = 'All Sessions — aggregated';
    // Single aggregated load; no auto-refresh
    loadAllSessionsResults();
  } else {
    var s = findSession(current);
    updateResultsTitleForSession(s);
    var isCompleted = s && String(s.status).toLowerCase() === 'completed';
    if (isCompleted) {
      loadSessionResults(current, true);
    } else {
      var cached = getCachedSessionEntries(current);
      if (Array.isArray(cached) && cached.length) {
        try { renderProductsGrid(applySorting(cached)); } catch (e) { console.error('Render cached failed', e); }
      } else {
        showLoading(false);
        try { renderProductsGrid([]); } catch (_) {}
      }
    }
  }
}
  // Bootstrap
  renderSessionsList();
  upsertResultsSelect();
  (function restoreSelection() {
  // Seed memory cache from sessionStorage on boot so switches are instant
  try {
        Array.isArray(sessions) && sessions.forEach(function (s) {
            if (!s || !s.id) return;
            getCachedSessionEntries(s.id);
        });
    } catch (_) {}

    // Default behavior:
    // - If there are sessions, default to aggregated view
    // - If none, show 'No session selected'
    upsertResultsSelect();
    var hasAnySessions = Array.isArray(sessions) && sessions.length > 0;
    var saved = sessionStorage.getItem(SELECT_STORAGE_KEY) || '';
    var current = resultsSelect && resultsSelect.value ? resultsSelect.value : saved;

    // If we have a pending reopen target, auto-select its session and load it
    if (hasAnySessions && pendingReopen && pendingReopen.session_id) {
        var sid = String(pendingReopen.session_id);
        var sess = findSession(sid);
        if (sess) {
            resultsSelect.value = sid;
            sessionStorage.setItem(SELECT_STORAGE_KEY, sid);
            updateResultsTitleForSession(sess);
            attachStream(sid);
            // Force load for fresh data; renderProductsGrid will auto-open detail
            loadSessionResults(sid, true);
            updatePolling();
            return;
        }
    }

    if (hasAnySessions) {
        if (!saved || saved === '') {
            resultsSelect.value = '__all__';
            sessionStorage.setItem(SELECT_STORAGE_KEY, '__all__');
            resultsTitle.textContent = 'All Sessions — aggregated';
            loadAllSessionsResults();
        } else if (saved === '__all__') {
            resultsSelect.value = '__all__';
            resultsTitle.textContent = 'All Sessions — aggregated';
            loadAllSessionsResults();
        } else {
            var s = findSession(saved);
            if (!s) {
                resultsSelect.value = '__all__';
                sessionStorage.setItem(SELECT_STORAGE_KEY, '__all__');
                resultsTitle.textContent = 'All Sessions — aggregated';
                loadAllSessionsResults();
            } else {
                resultsSelect.value = saved;
                updateResultsTitleForSession(s);
                attachStream(saved);
                var isCompleted = String(s.status).toLowerCase() === 'completed';
                if (isCompleted) {
                    loadSessionResults(saved, true);
                } else {
                    var cached = getCachedSessionEntries(saved);
                    if (Array.isArray(cached) && cached.length) {
                        try { renderProductsGrid(applySorting(cached)); } catch (e) { console.error('Render cached failed', e); }
                    } else {
                        showLoading(false);
                        try { renderProductsGrid([]); } catch (_) {}
                    }
                }
            }
        }
    } else {
        resultsTitle.textContent = 'No session selected';
        if (resultsBack) resultsBack.classList.add('hidden');
        stopAggregatedAutoRefresh();
        renderEmptyPrompt();
    }
    updatePolling();
})();
})();