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
  var streams = {}; // { id: EventSource }

  // Current view and sort state
  var lastEntriesRaw = [];
  // Ensure we track current view entries for refreshes
  var currentViewEntries = [];

  // Storage keys for selection and scroll
  var SELECT_STORAGE_KEY = 'eto_bulk_selected_session';
  var SCROLL_STORAGE_KEY = 'eto_bulk_scroll_y';

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

    // Generalized metric accessor (now supports Demand)
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
  function showLoading(on) {
    if (!resultsLoading) return;
    resultsLoading.classList.toggle('hidden', !on);
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
          search: { total: desiredTotal, remaining: desiredTotal },
          splitting: { total: desiredTotal, remaining: desiredTotal },
          demand: { total: desiredTotal, remaining: desiredTotal },
          keywords: { total: desiredTotal, remaining: desiredTotal }
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
      item.innerHTML =
        '<div class="row-line">' +
        '  <div class="row-title">' + escapeHtml(s.keyword) + '</div>' +
        '  <div class="row-meta">Desired: ' + (s.desired_total || 0) + ' • Started: ' + created + '</div>' +
        '</div>' +
        '<div class="row-progress">' +
        progressLine('Search', s.progress && s.progress.search, s) +
        progressLine('Splitting', s.progress && s.progress.splitting, s) +
        progressLine('Demand', s.progress && s.progress.demand, s) +
        progressLine('Keywords', s.progress && s.progress.keywords, s) +
        '</div>' +
        '<div class="row-status">Status: <span class="status-tag ' + s.status + '">' + s.status + '</span></div>' +
        '<div class="row-actions">' +
        '  <button class="link-btn view-results" data-view="' + s.id + '">View Results</button>' +
        '</div>';

      var btn = item.querySelector('.view-results');
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          closeSessionsPanel();
          resultsSelect.value = String(s.id);
          updateResultsTitleForSession(s);
          loadSessionResults(s.id, true);
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

  // SSE stream
  function attachStream(sessionId) {
    try { if (streams[sessionId]) { streams[sessionId].close(); } } catch (_) {}
    var es = new EventSource(window.BULK_RESEARCH_STREAM_URL_BASE + sessionId + '/');
    streams[sessionId] = es;

    es.onmessage = function (ev) {
      try {
        var data = JSON.parse(ev.data);
        handleStreamUpdate(sessionId, data);
      } catch (_) { /* ignore non-JSON lines */ }
    };
    es.onerror = function () {
      var s = findSession(sessionId);
      if (s && s.status !== 'failed') {
        s.status = 'completed';
        updateSession(s);
        var selected = resultsSelect.value;
        if (String(sessionId) === String(selected) || selected === '__all__') {
          loadSessionResults(sessionId, selected !== '__all__');
        }
      }
      try { es.close(); } catch (_) {}
    };
  }

  function handleStreamUpdate(sessionId, data) {
    var s = findSession(sessionId);
    if (!s) return;
    var stage = (data.stage || '').toLowerCase();
    var key = mapStage(stage);
    if (key) {
      s.progress = s.progress || {};
      s.progress[key] = s.progress[key] || { total: 0, remaining: 0 };
      if (typeof data.total === 'number') s.progress[key].total = data.total;
      if (typeof data.remaining === 'number') s.progress[key].remaining = data.remaining;
      updateSession(s);
    }

    // If stream supplies entries/megafile, fetch and render results
    if (data.entries || (data.megafile && data.megafile.entries)) {
      var isAggregated = (resultsSelect && resultsSelect.value === '__all__');
      if (isAggregated) {
        // Keep aggregated view current
        loadAllSessionsResults();
      } else {
        loadSessionResults(sessionId, String(resultsSelect.value) === String(sessionId));
      }
    }

    if (stage === 'completed') {
      s.status = 'completed';
      updateSession(s);
    }
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
  }

  // Results
  function upsertResultsSelect() {
    if (!resultsSelect) return;
    var current = resultsSelect.value || sessionStorage.getItem(SELECT_STORAGE_KEY) || '';
  resultsSelect.innerHTML = '';

  var optDefault = document.createElement('option');
  optDefault.value = '';
  optDefault.textContent = 'Select...';
  resultsSelect.appendChild(optDefault);

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
  resultsSelect.appendChild(optAll);

  sessions.forEach(function (s) {
    var o = document.createElement('option');
    o.value = String(s.id);
    var created = fmtDateISO(s.created_at);
    var count = (typeof sessionCounts[s.id] === 'number') ? sessionCounts[s.id] : null;
    var txt = s.keyword + ' (' + created + ')';
    if (count !== null) txt += ' • ' + count + ' products';
    o.textContent = txt;
    resultsSelect.appendChild(o);
  });

  var hasValue = Array.prototype.some.call(resultsSelect.options, function (opt) { return opt.value === current; });
  if (hasValue) resultsSelect.value = current;
  }

  if (resultsSelect) {
    resultsSelect.addEventListener('change', function () {
      var val = resultsSelect.value;
      productsGrid.innerHTML = '';
      // Always hide header back button when switching context
      if (resultsBack) resultsBack.classList.add('hidden');

      // Cancel any aggregated fetch in progress
      if (allSessionsController) {
        try { allSessionsController.abort(); } catch (_) {}
        allSessionsController = null;
      }

      if (!val) {
        resultsTitle.textContent = 'No session selected';
        sessionStorage.removeItem(SELECT_STORAGE_KEY);
        renderEmptyPrompt();
        return;
      }
      sessionStorage.setItem(SELECT_STORAGE_KEY, val);
      if (val === '__all__') {
        resultsTitle.textContent = 'All Sessions — aggregated';
        loadAllSessionsResults(); // new robust aggregator
      } else {
        var s = findSession(val);
        updateResultsTitleForSession(s);
        loadSessionResults(val, true);
      }
    });
  }

  function updateResultsTitleForSession(s) {
    if (!s) { resultsTitle.textContent = 'Session'; return; }
    var created = fmtDateISO(s.created_at);
    resultsTitle.textContent = 'Results — "' + (s.keyword || '') + '" • started ' + created;
  }

  function loadSessionResults(sessionId, renderNow) {
  showLoading(true);
  fetch(window.BULK_RESEARCH_RESULT_URL_BASE + sessionId + '/', { credentials: 'same-origin' })
  .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j && (j.error || j.raw || ('Failed (' + r.status + ')'))); return j; }); })
  .then(function (json) {
      var list = Array.isArray(json.entries) ? json.entries : [];
      sessionResultsCache[sessionId] = list;
      sessionCounts[sessionId] = list.length;
      upsertResultsSelect();
      lastEntriesRaw = list;
      if (renderNow) { renderProductsGrid(applySorting(list)); }
    })
    .catch(function (err) {
      alert('Failed to load results: ' + err.message);
    })
    .finally(function () { showLoading(false); restoreScroll(); });
}

  function loadAllSessionsResults() {
    showLoading(true);

    // Abort any previous aggregated request
    if (allSessionsController) {
      try { allSessionsController.abort(); } catch (_) {}
    }
    allSessionsController = new AbortController();
    var signal = allSessionsController.signal;

    var ids = sessions.map(function (s) { return s && s.id; }).filter(Boolean);
    if (ids.length === 0) {
      lastEntriesRaw = [];
      currentViewEntries = [];
      renderProductsGrid([]);
      upsertResultsSelect();
      showLoading(false);
      return;
    }

    var fetches = ids.map(function (id) {
      // Use cache if available
      if (sessionResultsCache[id]) {
        sessionCounts[id] = sessionResultsCache[id].length;
        return Promise.resolve(sessionResultsCache[id]);
      }
      // Fetch per session (swallow errors so one bad session doesn't block others)
      return fetch(window.BULK_RESEARCH_RESULT_URL_BASE + id + '/', { credentials: 'same-origin', signal: signal })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j && (j.error || j.raw || ('Failed (' + r.status + ')')));
            return Array.isArray(j.entries) ? j.entries : [];
          });
        })
        .catch(function () { return []; })
        .then(function (list) {
          sessionResultsCache[id] = list;
          sessionCounts[id] = list.length;
          return list;
        });
    });

    Promise.all(fetches)
      .then(function (lists) {
        var allEntries = [];
        for (var i = 0; i < lists.length; i++) {
          allEntries = allEntries.concat(lists[i]);
        }
        lastEntriesRaw = allEntries;
        currentViewEntries = allEntries;
        renderProductsGrid(applySorting(allEntries));
        upsertResultsSelect();
      })
      .finally(function () {
        showLoading(false);
      });
  }

  function renderProductsGrid(entries) {
  productsGrid.innerHTML = '';
  if (!entries || entries.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'text-[var(--muted)] text-sm';
      empty.textContent = 'No products yet.';
      productsGrid.appendChild(empty);
      return;
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
      var priceDisplay = (entry && entry.price_display) || null;
      if (!priceDisplay) {
        var priceObj = (entry && entry.price) || {};
        var amount = priceObj.amount, divisor = priceObj.divisor, currency = priceObj.currency_code || '';
        try {
          if (typeof amount === 'number' && typeof divisor === 'number' && divisor) {
            var val = amount / divisor;
            var disp = (val.toFixed(2)).replace(/\.00$/, '');
            priceDisplay = disp + (currency ? (' ' + currency) : '');
          }
        } catch (_) {}
      }

      // Sale price display: prefer subtotal_after_discount then sale_price_display then computed
      var promoDesc = (entry && (entry.buyer_applied_promotion_description || entry.buyer_promotion_description)) || '';
      var saleDisplay = (entry && (entry.sale_subtotal_after_discount || entry.sale_price_display)) || '';
      if (!saleDisplay) {
        var priceObj2 = entry && entry.price || {};
        var amount2 = priceObj2.amount, divisor2 = priceObj2.divisor, currency2 = priceObj2.currency_code || '';
        var baseVal = null;
        if (typeof amount2 === 'number' && typeof divisor2 === 'number' && divisor2) {
          baseVal = amount2 / divisor2;
        }
        if (baseVal != null) {
          try {
            var m = (promoDesc || '').match(/(\d+(?:\.\d+)?)\s*%/);
            var pct = m ? parseFloat(m[1]) : null;
            if (pct != null && isFinite(pct)) {
              var saleVal = baseVal * (1 - pct / 100);
              var saleStr = (Math.round(saleVal * 100) / 100).toFixed(2).replace(/\.00$/, '');
              saleDisplay = saleStr + (currency2 ? (' ' + currency2) : '');
            }
          } catch (_) {}
        }
      }

      var card = document.createElement('article');
      card.className = 'product-card';

      var mediaHtml = image
        ? '<img class="product-media" src="' + image + '" ' + (srcset ? ('srcset="' + srcset + '"') : '') + ' alt="">'
        : '<div class="product-media-placeholder">No image</div>';

      // Price cell showing sale if present
      var priceCellHtml = '';
      if (saleDisplay) {
        priceCellHtml =
          '<div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">' +
          '  <div>Price: <span class="line-through text-[var(--muted)] mr-1">' + escapeHtml(priceDisplay || '—') + '</span>' +
          '  <span class="text-emerald-600 font-semibold">' + escapeHtml(saleDisplay) + '</span></div>' +
          '</div>';
      } else {
        priceCellHtml =
          '<div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Price: ' + escapeHtml(priceDisplay || '—') + '</div>';
      }

      card.innerHTML =
        mediaHtml +
        '<div class="product-body">' +
        '  <div class="product-title">' + escapeHtml(title) + '</div>' +
        '  <div class="grid grid-cols-2 gap-2 mt-1">' +
        '    <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Demand: ' + (demand !== null ? escapeHtml(String(demand)) : '—') + '</div>' +
        '    <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Views: ' + escapeHtml(String(views)) + '</div>' +
        '    <div class="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs">Favourites: ' + escapeHtml(String(favorers)) + '</div>' +
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

      productsGrid.appendChild(card);
  });
    }

    // Render a single-product detail view (clears products grid, keeps sidebar intact)
function showProductDetail(entry) {
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

  // Sale info and sale price (prefer backend)
  var promoName = (entry && entry.buyer_promotion_name) || '';
  var promoShopName = (entry && entry.buyer_shop_promotion_name) || '';
  var promoDesc = (entry && (entry.buyer_applied_promotion_description || entry.buyer_promotion_description)) || '';
  var saleDisplay = (entry && entry.sale_price_display) || '';
  if (!saleDisplay && baseVal != null) {
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
      ? '    <div><a class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition" href="' + url + '" target="_blank" rel="noopener">View on Etsy</a></div>'
      : '') +
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
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Sale price</div><div class="font-medium break-words">' + escapeHtml(saleDisplay || '—') + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Last modified</div><div class="font-medium break-words">' + escapeHtml(lastModified || '—') + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Quantity</div><div class="font-medium break-words">' + escapeHtml(String(quantity)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Favorers</div><div class="font-medium break-words">' + escapeHtml(String(favorers)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Views</div><div class="font-medium break-words">' + escapeHtml(String(views)) + '</div></div>' +
    '    <div class="px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm"><div class="text-[var(--muted)] text-xs">Listing type</div><div class="font-medium break-words">' + escapeHtml(listingType || '—') + '</div></div>' +
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
    // Keywords with copy-all
    (rawKeywords.length
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs sm:text-sm">' +
         '  <div class="flex items-center justify-between mb-2"><div class="text-[var(--muted)] text-xs">Keywords</div>' +
         '    <button id="' + copyKeywordsBtnId + '" class="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)] transition">Copy keywords</button>' +
         '  </div>' +
         '  <div class="flex flex-wrap gap-1.5">' +
         normalizedKeywords.map(function(k){ return '<span class="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1">' + escapeHtml(String(k.text)) + '</span>'; }).join('') +
         '  </div>' +
         '</div>')
      : '') +
    // Keyword insights: metrics + per-keyword interactive chart
    (normalizedKeywords.length
      ? ('<div class="col-span-2 lg:col-span-3 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface-2)]">' +
         '  <div class="text-[var(--muted)] text-xs mb-2">Keyword insights</div>' +
         '  <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">' +
            keywordCardsHTML +
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
    var saved = sessionStorage.getItem(SELECT_STORAGE_KEY) || '';
  var current = resultsSelect && resultsSelect.value ? resultsSelect.value : saved;

  // Show sort/filter bar again when leaving detail
  var filterBar = document.getElementById('filter-bar');
  if (filterBar) filterBar.classList.remove('hidden');

  // Hide header back button when leaving detail
  if (resultsBack) resultsBack.classList.add('hidden');

  if (!current) {
    resultsTitle.textContent = 'No session selected';
    renderEmptyPrompt();
    return;
  }
  if (current === '__all__') {
    resultsTitle.textContent = 'All Sessions — aggregated';
    loadAllSessionsResults();
  } else {
    var s = findSession(current);
    updateResultsTitleForSession(s);
    loadSessionResults(current, true);
  }
  }

  // Bootstrap
  renderSessionsList();
  upsertResultsSelect();
  (function restoreSelection() {
    var saved = sessionStorage.getItem(SELECT_STORAGE_KEY);
    if (saved && resultsSelect) {
      var hasOption = Array.prototype.some.call(resultsSelect.options, function (opt) { return opt.value === saved; });
      if (hasOption) {
        resultsSelect.value = saved;
        if (saved === '__all__') {
          resultsTitle.textContent = 'All Sessions — aggregated';
          loadAllSessionsResults();
        } else {
          var s = findSession(saved);
          updateResultsTitleForSession(s);
          loadSessionResults(saved, true);
        }
        // Ensure header back button is hidden on initial render
        if (resultsBack) resultsBack.classList.add('hidden');
        return;
      }
    }
    renderEmptyPrompt();
  })();
})();