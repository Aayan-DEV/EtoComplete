(function(){
  const form = document.getElementById('ki-form');
  const input = document.getElementById('ki-input');
  const statusEl = document.getElementById('ki-status');
  const metricsEl = document.getElementById('ki-metrics');
  const chartWrap = document.getElementById('ki-chart-wrap');
  const chartCanvas = document.getElementById('ki-chart');
  const noTrendEl = document.getElementById('ki-no-trend');
  const legendEl = document.getElementById('ki-chart-legend');

  let chartRef = null;

  function getCookie(name) {
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (let i = 0; i < cookies.length; i++) {
      const parts = cookies[i].split('=');
      const key = decodeURIComponent(parts[0]);
      const val = parts.slice(1).join('=');
      if (key === name) return decodeURIComponent(val);
    }
    return '';
  }

  function setStatus(msg, tone) {
    statusEl.textContent = msg || '';
    statusEl.className = 'mt-3 text-sm ' + (tone === 'error' ? 'text-red-400' : 'text-white/70');
  }

  function saveState(keyword, result) {
    try {
      sessionStorage.setItem('eto_keyword_insight', JSON.stringify({ keyword, result, ts: Date.now() }));
    } catch (_) {}
  }
  function loadState() {
    try {
      const raw = sessionStorage.getItem('eto_keyword_insight');
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function classifyCompetition(v) {
    if (v == null || isNaN(v)) return '—';
    const n = Number(v);
    const score = n > 1 ? Math.max(0, Math.min(100, n)) : Math.round(n * 100);
    if (score < 35) return 'Low';
    if (score < 65) return 'Medium';
    return 'High';
  }

  function normalizePayload(body) {
    const normalized = body?.data ?? body?.result ?? body;
    console.log('[KI] normalizePayload:', { raw: body, normalized });
    return normalized;
  }

  function extractCompetition(res) {
    const listings = res?.avgTotalListings ?? res?.data?.avgTotalListings;
    if (listings !== undefined && listings !== null && !isNaN(Number(listings))) {
      const n = Number(listings);
      const min = 10000, max = 3000000;
      let score = ((n - min) / (max - min)) * 100;
      score = Math.max(0, Math.min(100, score));
      console.log('[KI] Derived competition from listings:', { listings: n, score: Math.round(score) });
      return Math.round(score);
    }
    const candidates = [
      res?.competition,
      res?.data?.competition,
      res?.metrics?.competition,
      res?.summary?.competition_score,
      res?.metrics?.competitionScore,
      res?.result?.metrics?.competition,
      res?.result?.metrics?.competitionScore,
      res?.summary?.competitionScore
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null && !isNaN(Number(c))) {
        console.log('[KI] Found competition candidate:', c);
        return Number(c);
      }
    }
    console.log('[KI] No competition found in payload.');
    return null;
  }

  function extractVolume(res) {
    const candidates = [
      res?.searchVolume,
      res?.volume,
      res?.search_volume,
      res?.data?.volume,
      res?.metrics?.volume,
      res?.summary?.avg_monthly_searches,
      res?.metrics?.searchVolume,
      res?.summary?.monthly_searches
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null && !isNaN(Number(c))) {
        console.log('[KI] Found volume candidate:', c);
        return Number(c);
      }
    }
    console.log('[KI] No volume found in payload.');
    return null;
  }

  function extractTrend(res) {
    let series = null;
    if (Array.isArray(res?.dailyStats)) series = res.dailyStats; // [{date, searchVolume}]
    else if (Array.isArray(res?.trend)) series = res.trend;
    else if (Array.isArray(res?.data?.trend)) series = res.data.trend;
    else if (Array.isArray(res?.result?.trend)) series = res.result.trend;
    else if (Array.isArray(res?.history)) series = res.history;
    else if (Array.isArray(res?.time_series)) series = res.time_series;
    else if (Array.isArray(res?.timeseries)) series = res.timeseries;
    else if (Array.isArray(res?.metrics?.monthly)) series = res.metrics.monthly;

    if (!Array.isArray(series) || series.length === 0) return null;

    const labels = [], values = [];
    for (const item of series) {
      if (typeof item === 'number') {
        values.push(item); labels.push('');
      } else if (typeof item === 'object' && item) {
        if ('date' in item && 'searchVolume' in item) {
          labels.push(String(item.date));
          values.push(Number(item.searchVolume));
        } else if ('month' in item && 'value' in item) {
          labels.push(String(item.month));
          values.push(Number(item.value));
        } else if ('date' in item && 'count' in item) {
          labels.push(String(item.date));
          values.push(Number(item.count));
        } else {
          const v = Number(Object.values(item).find(x => !isNaN(Number(x))));
          values.push(isNaN(v) ? 0 : v);
          labels.push('');
        }
      }
    }
    console.log('[KI] Trend extracted:', { labels, valuesLength: values.length });
    return { labels, values };
  }

  function renderMetrics(keyword, res) {
    const comp = extractCompetition(res);
    const vol = extractVolume(res);
    const listings = res?.avgTotalListings ?? res?.data?.avgTotalListings;
    const compScore = comp == null ? '—' : (comp > 1 ? Math.round(comp) : Math.round(comp * 100));
    const compLevel = classifyCompetition(comp);
    const volText = vol == null ? '—' : new Intl.NumberFormat().format(Math.round(vol));
    const listingsText = (listings !== undefined && listings !== null && !isNaN(Number(listings)))
      ? new Intl.NumberFormat().format(Number(listings))
      : null;

    console.log('[KI] Metrics:', { keyword, comp, compLevel, vol, listings });

    metricsEl.innerHTML = `
      <div class="card">
        <div class="text-sm text-white/70">Keyword</div>
        <div class="value text-xl mt-1">${keyword}</div>
      </div>
      <div class="card">
        <div class="text-sm text-white/70">Competition</div>
        <div class="value text-xl mt-1">${compScore}${comp == null ? '' : (comp > 1 ? '' : '%')}</div>
        <div class="sub mt-1">${compLevel}${listingsText ? ' • ' + listingsText + ' listings' : ''}</div>
      </div>
      <div class="card">
        <div class="text-sm text-white/70">Volume</div>
        <div class="value text-xl mt-1">${volText}</div>
        <div class="sub mt-1">Avg monthly searches</div>
      </div>
    `;
  }

  function labelWithDay(labels) {
    const year = new Date().getFullYear();
    const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const out = labels.map(lbl => {
      if (!lbl || typeof lbl !== 'string') return lbl;
      const parts = lbl.split(' ');
      if (parts.length !== 2) return lbl;
      const m = parts[0];
      const d = parseInt(parts[1], 10);
      const mi = months[m];
      if (mi == null || isNaN(d)) return lbl;
      const dt = new Date(year, mi, d);
      const dow = days[dt.getDay()];
      return [lbl, dow]; // two-line label
    });
    return { labels: out, year };
  }

  function themeTokens() {
    const root = document.documentElement;
    const isLight = root.getAttribute('data-theme') === 'light';
    const css = getComputedStyle(root);
    const gridDefault = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
    const ticksDefault = isLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.7)';
    return {
      line: isLight ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)',
      fill: isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)',
      grid: (css.getPropertyValue('--border') || gridDefault).trim(),
      ticks: (css.getPropertyValue('--muted') || ticksDefault).trim()
    };
  }

  function renderChart(res) {
    const trend = extractTrend(res);
    if (!trend || !trend.values || trend.values.length === 0) {
      chartCanvas.classList.add('hidden');
      noTrendEl.classList.remove('hidden');
      legendEl.textContent = '';
      if (chartRef) { chartRef.destroy(); chartRef = null; }
      return;
    }
    chartCanvas.classList.remove('hidden');
    noTrendEl.classList.add('hidden');

    const { labels: displayLabels, year } = labelWithDay(trend.labels);
    const colors = themeTokens();

    const ctx = chartCanvas.getContext('2d');
    if (chartRef) { chartRef.destroy(); chartRef = null; }

    chartRef = new Chart(ctx, {
      type: 'line',
      data: {
        labels: displayLabels,
        datasets: [{
          label: 'Interest',
          data: trend.values,
          borderColor: colors.line,
          backgroundColor: colors.fill,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointHitRadius: 12
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              title: function(items) {
                const l = items[0]?.label;
                if (Array.isArray(l)) return `${l[0]} — ${l[1]}, ${year}`;
                return `${l}, ${year}`;
              },
              label: function(ctx) { return ` ${ctx.parsed.y}`; }
            }
          }
        },
        scales: {
          x: {
            grid: { color: colors.grid },
            ticks: { color: colors.ticks, maxRotation: 0, autoSkip: true }
          },
          y: {
            grid: { color: colors.grid },
            ticks: { color: colors.ticks }
          }
        }
      }
    });

    const last = trend.values[trend.values.length - 1];
    legendEl.textContent = `Latest: ${Math.round(last)} • ${year}`;
  }

  function doSearch(keyword) {
    const csrf = getCookie('csrftoken');
    const url = window.KI_SEARCH_URL;
    const payload = { keyword: keyword.trim() };

    console.log('[KI] POST ->', url, 'payload:', payload);

    setStatus('Searching…');

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf,
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      credentials: 'same-origin'
    })
    .then(async (resp) => {
      console.log('[KI] Response status:', resp.status);
      let body;
      try {
        body = await resp.json();
      } catch (e) {
        const txt = await resp.text();
        console.warn('[KI] Non-JSON response body:', txt);
        throw new Error('Invalid JSON from server');
      }
      console.log('[KI] Raw response body:', body);

      if (!resp.ok) {
        const msg = body?.error || body?.detail || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      const normalized = normalizePayload(body);
      renderMetrics(keyword, normalized);
      renderChart(normalized);
      saveState(keyword, normalized);

      setStatus('Done.');
    })
    .catch(err => {
      console.error('[KI] Search error:', err);
      setStatus(`Error: ${err.message}`, 'error');
    });
  }

  if (form && input) {
    form.addEventListener('submit', function(e){
      e.preventDefault();
      const keyword = (input.value || '').trim();
      if (!keyword) {
        setStatus('Please enter a keyword.', 'error');
        return;
      }
      doSearch(keyword);
    });
  }

  // Restore last result
  (function restoreFromSession(){
    const s = loadState();
    if (s?.keyword && s?.result) {
      try { input.value = s.keyword; } catch (_) {}
      setStatus('Restored previous result.');
      renderMetrics(s.keyword, s.result);
      renderChart(s.result);
    }
  })();

  // Re-render chart when theme changes
  (function observeTheme(){
    const mo = new MutationObserver(() => {
      const s = loadState();
      if (s?.result) renderChart(s.result);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  })();
})();