#!/usr/bin/env python3
"""Build a self-contained HTML load-test report from a k6 result directory.

Reads:
  <dir>/summary.json  - k6 handleSummary data (aggregates + tagged sub-metrics)
  <dir>/meta.json     - {title, description, scenarios} (optional)
  <dir>/metrics.csv   - k6 CSV output (time-series)
Writes:
  <dir>/report.html   - tables + inline-SVG charts, no external assets

Usage: build-report.py <RESULT_DIR>
"""
import csv
import html
import json
import os
import re
import sys
from datetime import datetime, timezone

API_NAMES = ['Auth_Login', 'PGR_Create', 'PGR_Assign', 'PGR_Resolve', 'PGR_Search', 'PGR_List']

STATUS_REASON = {
    '0': 'No response / timeout',
    '400': 'Bad request / validation (e.g. INVALID_UPDATE)',
    '401': 'Unauthorized (token expired / bad credentials)',
    '403': 'Forbidden (missing role / access)',
    '404': 'Not found',
    '408': 'Request timeout',
    '409': 'Conflict',
    '422': 'Unprocessable entity',
    '429': 'Rate limited',
    '500': 'Server error',
    '502': 'Bad gateway',
    '503': 'Service unavailable',
    '504': 'Gateway timeout',
}

BUCKET_SECONDS = 5


# ---- helpers -------------------------------------------------------------

def esc(s):
    return html.escape(str(s), quote=True)


def num(v, d=0.0):
    try:
        f = float(v)
        return f if f == f and f not in (float('inf'), float('-inf')) else d
    except (TypeError, ValueError):
        return d


def f0(v):
    return f'{num(v):.0f}'


def f1(v):
    return f'{num(v):.1f}'


def pctl(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def vals(metrics, key):
    m = metrics.get(key) or {}
    return m.get('values', m) or {}


# ---- charts (inline SVG) -------------------------------------------------

def line_chart(title, points, unit='', color='#2a6fdb'):
    """points: list of (x_seconds, y). Returns an SVG string."""
    W, H, PL, PR, PT, PB = 620, 170, 48, 12, 26, 22
    if not points:
        return f'<div class="chart"><div class="ct">{esc(title)}</div><div class="nodata">no data</div></div>'
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    xmax = max(xs) or 1
    ymax = max(ys) or 1
    ymax *= 1.1  # headroom

    def px(x):
        return PL + (x / xmax) * (W - PL - PR)

    def py(y):
        return H - PB - (y / ymax) * (H - PT - PB)

    pts = ' '.join(f'{px(x):.1f},{py(y):.1f}' for x, y in points)
    # gridlines + y labels at 0, mid, max
    grid = []
    for frac in (0, 0.5, 1.0):
        yv = ymax * frac
        yy = py(yv)
        grid.append(f'<line x1="{PL}" y1="{yy:.1f}" x2="{W-PR}" y2="{yy:.1f}" class="grid"/>')
        grid.append(f'<text x="{PL-6}" y="{yy+3:.1f}" class="yl">{yv:.0f}</text>')
    xlabels = (
        f'<text x="{PL}" y="{H-6}" class="xl">0s</text>'
        f'<text x="{W-PR}" y="{H-6}" class="xl" text-anchor="end">{xmax:.0f}s</text>'
    )
    area = f'{PL},{py(0):.1f} ' + pts + f' {px(xmax):.1f},{py(0):.1f}'
    return (
        f'<div class="chart"><div class="ct">{esc(title)}{(" (" + unit + ")") if unit else ""}</div>'
        f'<svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img">'
        f'{"".join(grid)}'
        f'<polygon points="{area}" fill="{color}" opacity="0.10"/>'
        f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="1.6"/>'
        f'{xlabels}'
        f'</svg></div>'
    )


def bar_chart(title, rows, unit='', color='#2a6fdb', warn=None):
    """rows: list of (label, value) or (label, value, failed). warn: dict label->bool for red."""
    W, H, PL, PR, PT, PB = 620, 190, 52, 12, 24, 40
    if not rows:
        return f'<div class="chart"><div class="ct">{esc(title)}</div><div class="nodata">no data</div></div>'
    vmax = max((r[1] for r in rows), default=1) or 1
    vmax *= 1.1
    n = len(rows)
    slot = (W - PL - PR) / n
    bw = slot * 0.6
    bars = []
    for i, r in enumerate(rows):
        label, value = r[0], r[1]
        failed = r[2] if len(r) > 2 else 0
        x = PL + i * slot + (slot - bw) / 2
        h = (value / vmax) * (H - PT - PB)
        y = H - PB - h
        c = '#c0392b' if (warn and warn.get(label)) else color
        bars.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{h:.1f}" fill="{c}"/>')
        if failed:
            fh = (failed / vmax) * (H - PT - PB)
            bars.append(f'<rect x="{x:.1f}" y="{H-PB-fh:.1f}" width="{bw:.1f}" height="{fh:.1f}" fill="#c0392b"/>')
        bars.append(f'<text x="{x+bw/2:.1f}" y="{y-3:.1f}" class="bv">{value:.0f}</text>')
        short = label.replace('PGR_', '').replace('Auth_', '')
        bars.append(f'<text x="{x+bw/2:.1f}" y="{H-PB+14:.1f}" class="bl" text-anchor="middle">{esc(short)}</text>')
    return (
        f'<div class="chart"><div class="ct">{esc(title)}{(" (" + unit + ")") if unit else ""}</div>'
        f'<svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img">'
        f'{"".join(bars)}</svg></div>'
    )


# ---- time-series from metrics.csv ---------------------------------------

def build_timeseries(csv_path):
    if not os.path.exists(csv_path):
        return None
    t0 = None
    reqs = {}          # bucket -> count
    fails = {}         # bucket -> [0/1,...]
    durs = {}          # bucket -> [ms,...]
    vus = {}           # bucket -> max
    with open(csv_path, newline='') as fh:
        r = csv.reader(fh)
        header = next(r, None)
        for row in r:
            if len(row) < 3:
                continue
            metric, ts, val = row[0], row[1], row[2]
            try:
                ts = int(float(ts))
            except ValueError:
                continue
            if t0 is None:
                t0 = ts
            b = (ts - t0) // BUCKET_SECONDS
            if metric == 'http_reqs':
                reqs[b] = reqs.get(b, 0) + 1
            elif metric == 'http_req_failed':
                fails.setdefault(b, []).append(num(val))
            elif metric == 'http_req_duration':
                durs.setdefault(b, []).append(num(val))
            elif metric == 'vus':
                vus[b] = max(vus.get(b, 0), num(val))
    if t0 is None:
        return None
    buckets = sorted(set(reqs) | set(fails) | set(durs) | set(vus))

    def series(fn):
        return [(b * BUCKET_SECONDS, fn(b)) for b in buckets]

    return {
        'rps': series(lambda b: reqs.get(b, 0) / BUCKET_SECONDS),
        'p95': series(lambda b: pctl(durs.get(b, []), 95)),
        'vus': series(lambda b: vus.get(b, 0)),
        'err': series(lambda b: (sum(fails.get(b, [])) / len(fails[b]) * 100) if fails.get(b) else 0),
    }


# ---- uPlot (interactive charts) -----------------------------------------

VENDOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor')


def load_uplot():
    """Return (js, css) text of the vendored uPlot, or (None, None) if absent."""
    js_path = os.path.join(VENDOR_DIR, 'uPlot.iife.min.js')
    css_path = os.path.join(VENDOR_DIR, 'uPlot.min.css')
    if not (os.path.exists(js_path) and os.path.exists(css_path)):
        return None, None
    with open(js_path) as f:
        js = f.read()
    with open(css_path) as f:
        css = f.read()
    return js, css


# Vanilla init: builds a uPlot per entry in window.__CHARTS__.
# line = time-series (drag-zoom + hover); bars = categorical; stackedBars =
# success(green) over failed(red) via draw order, with true segment values on hover.
UPLOT_INIT_JS = r"""
(function () {
  var charts = window.__CHARTS__ || [];
  function fmt(v) { if (v == null) return '--'; var n = Math.round(v * 10) / 10; return n.toLocaleString(); }
  charts.forEach(function (c) {
    var el = document.getElementById(c.id);
    if (!el || typeof uPlot === 'undefined') return;
    var w = Math.max(320, el.clientWidth - 2);
    var opts, data;
    if (c.kind === 'line') {
      data = c.data;
      opts = {
        title: c.title + (c.unit ? ' (' + c.unit + ')' : ''),
        width: w, height: c.height || 180,
        scales: { x: { time: false } },
        // Shared key 'ts' syncs the crosshair across all 4 time-series charts by x (time);
        // y is not synced (null) since each chart's y-scale differs.
        cursor: { drag: { x: true, y: false }, sync: { key: 'ts', scales: ['x', null] } },
        axes: [{ values: function (u, sp) { return sp.map(function (v) { return v + 's'; }); } }, {}],
        series: [{}, { label: c.title, stroke: c.color, width: 1.6, fill: c.fill, value: function (u, v) { return fmt(v); } }]
      };
    } else if (c.kind === 'bars' || c.kind === 'groupedBars') {
      var labels = c.labels;
      var common = {
        title: c.title + (c.unit ? ' (' + c.unit + ')' : ''),
        width: w, height: c.height || 220,
        scales: { x: { time: false, range: function (u, min, max) { return [-0.5, labels.length - 0.5]; } } },
        cursor: { drag: { x: false, y: false } },
        axes: [{ splits: function (u) { return labels.map(function (_, i) { return i; }); },
                 values: function (u, sp) { return sp.map(function (i) { return labels[i] != null ? labels[i] : ''; }); },
                 rotate: -25, size: 70 }, {}]
      };
      if (c.kind === 'bars') {
        var bars = uPlot.paths.bars({ size: [0.7, 120], align: 0 });
        data = c.data;
        opts = Object.assign(common, { series: [{}, { label: c.title, stroke: c.stroke, fill: c.fill, paths: bars, points: { show: false }, value: function (u, v) { return fmt(v); } }] });
      } else {
        // groupedBars: two bars per category, side by side (align offsets).
        var barsL = uPlot.paths.bars({ size: [0.42, 60], align: -1 });
        var barsR = uPlot.paths.bars({ size: [0.42, 60], align: 1 });
        var st = c.styles; // [ {label,stroke,fill}, {label,stroke,fill} ]
        data = c.data; // [x, series0, series1]
        opts = Object.assign(common, { series: [{},
          { label: st[0].label, stroke: st[0].stroke, fill: st[0].fill, paths: barsL, points: { show: false }, value: function (u, v) { return fmt(v); } },
          { label: st[1].label, stroke: st[1].stroke, fill: st[1].fill, paths: barsR, points: { show: false }, value: function (u, v) { return fmt(v); } }
        ] });
      }
    } else { return; }
    var u = new uPlot(opts, data, el);
    if (window.ResizeObserver) {
      new ResizeObserver(function () { u.setSize({ width: Math.max(320, el.clientWidth - 2), height: opts.height }); }).observe(el);
    }
  });
})();
"""


def _short(name):
    return name.replace('PGR_', '').replace('Auth_', '')


# ---- error summary (from console.log: API + status + response body) ------

_MSG_RE = re.compile(r'msg="((?:[^"\\]|\\.)*)"')
_FAIL_RE = re.compile(r'^(Login|PGR [A-Za-z]+) failed: (\d+) (.*)$', re.S)


def _api_from_prefix(prefix):
    if prefix == 'Login':
        return 'Auth_Login'
    if prefix.startswith('PGR '):
        return 'PGR_' + prefix[4:].strip().title()
    return prefix


def build_error_summary(console_path):
    """Parse console.log failure logs into unique (API, status, response body)
    groups, count-desc. Returns None if console.log is absent.

    Helpers log each failure as `console.error("<endpoint> failed: <status> <body>")`;
    k6 wraps that as `... msg="..." source=console`.
    """
    if not console_path or not os.path.exists(console_path):
        return None
    groups = {}
    with open(console_path, errors='replace') as fh:
        for line in fh:
            mm = _MSG_RE.search(line)
            msg = (mm.group(1) if mm else line).replace('\\"', '"').replace('\\\\', '\\').strip()
            fm = _FAIL_RE.match(msg)
            if not fm:
                continue
            api = _api_from_prefix(fm.group(1))
            status, body = fm.group(2), fm.group(3).strip()
            key = (api, status, body)
            groups[key] = groups.get(key, 0) + 1
    out = [{'api': a, 'status': s, 'body': b, 'count': c} for (a, s, b), c in groups.items()]
    out.sort(key=lambda e: -e['count'])
    return out


# ---- main ----------------------------------------------------------------

def build(result_dir):
    summary_path = os.path.join(result_dir, 'summary.json')
    if not os.path.exists(summary_path):
        raise SystemExit(f'No summary.json in {result_dir}')
    with open(summary_path) as fh:
        data = json.load(fh)
    metrics = data.get('metrics', {})

    meta = {}
    meta_path = os.path.join(result_dir, 'meta.json')
    if os.path.exists(meta_path):
        with open(meta_path) as fh:
            meta = json.load(fh)
    # Fallback title from the dir name (<ts>_<env>_<profile>_<scenario>).
    base = os.path.basename(result_dir.rstrip('/'))
    parts = base.split('_')
    fallback = '_'.join(parts[3:]) if len(parts) > 3 else base
    title = meta.get('title') or fallback
    description = meta.get('description') or ''

    # Overview
    reqs = vals(metrics, 'http_reqs')
    failed = vals(metrics, 'http_req_failed')
    dur = vals(metrics, 'http_req_duration')
    tx = vals(metrics, 'transaction_success')
    err_pct = num(failed.get('rate')) * 100
    succ_pct = num(tx.get('rate')) * 100 if 'rate' in tx else None
    duration_s = num((data.get('state') or {}).get('testRunDurationMs')) / 1000

    tiles = [
        ('Total requests', f0(reqs.get('count')), False),
        ('Requests/s', f1(reqs.get('rate')), False),
        ('HTTP error %', f1(err_pct), err_pct > 0),
        ('HTTP p95 (ms)', f0(dur.get('p(95)')), False),
        ('Transaction success %', f1(succ_pct) if succ_pct is not None else '—', succ_pct is not None and succ_pct < 100),
        ('Duration (s)', f1(duration_s), False),
    ]
    tiles_html = ''.join(
        f'<div class="tile{" bad" if warn else ""}"><div class="tk">{esc(k)}</div><div class="tv">{esc(v)}</div></div>'
        for k, v, warn in tiles
    )

    # Scenario names discovered from sub-metric keys
    scen = meta.get('scenarios') or sorted({
        k[len('http_reqs{scenario:'):-1] for k in metrics if k.startswith('http_reqs{scenario:')
    })
    scen_rows = ''
    for s in scen:
        r = vals(metrics, f'http_reqs{{scenario:{s}}}')
        fl = vals(metrics, f'http_req_failed{{scenario:{s}}}')
        d = vals(metrics, f'http_req_duration{{scenario:{s}}}')
        scen_rows += (f'<tr><td>{esc(s)}</td><td class="r">{f0(r.get("count"))}</td>'
                      f'<td class="r">{f1(num(fl.get("rate"))*100)}%</td>'
                      f'<td class="r">{f0(d.get("p(95)"))}</td></tr>')

    # Per-API table + chart data
    api_rows = ''
    lat_bars, req_bars, warn = [], [], {}   # SVG fallback shapes
    api_chart = []                          # (name, p95, total, failed)
    for n in API_NAMES:
        r = vals(metrics, f'http_reqs{{name:{n}}}')
        total = num(r.get('count'))
        if total == 0:
            continue
        fl = vals(metrics, f'http_req_failed{{name:{n}}}')
        d = vals(metrics, f'http_req_duration{{name:{n}}}')
        fail_count = num(fl.get('passes'))  # Rate 'passes' = # of true (failed) observations
        fail_pct = num(fl.get('rate')) * 100
        p95 = num(d.get('p(95)'))
        row_bad = ' class="badrow"' if fail_count > 0 else ''
        api_rows += (f'<tr{row_bad}><td>{esc(n)}</td><td class="r">{f0(total)}</td>'
                     f'<td class="r">{f0(fail_count)}</td><td class="r">{f1(fail_pct)}%</td>'
                     f'<td class="r">{f0(p95)}</td></tr>')
        lat_bars.append((n, p95))
        req_bars.append((n, total, fail_count))
        api_chart.append((n, p95, total, fail_count))
        warn[n] = fail_count > 0

    # Failures
    failure_rows = []
    for n in API_NAMES:
        for c, reason in STATUS_REASON.items():
            cnt = num(vals(metrics, f'api_errors{{name:{n},status:{c}}}').get('count'))
            if cnt > 0:
                failure_rows.append((n, c, cnt, reason))
    failure_rows.sort(key=lambda x: -x[2])
    if failure_rows:
        failures_html = ''.join(
            f'<tr class="badrow"><td>{esc(n)}</td><td class="r">{esc(c)}</td>'
            f'<td class="r">{f0(cnt)}</td><td>{esc(reason)}</td></tr>'
            for n, c, cnt, reason in failure_rows
        )
    else:
        failures_html = '<tr><td colspan="4" class="ok">No failed API calls 🎉</td></tr>'

    # Threshold breaches
    breaches = []
    for key, met in metrics.items():
        for src, res in (met.get('thresholds') or {}).items():
            if isinstance(res, dict) and res.get('ok') is False:
                breaches.append(f'{key}: {src}')
    breach_html = ('<ul>' + ''.join(f'<li class="bad">{esc(b)}</li>' for b in breaches) + '</ul>'
                   if breaches else '<p class="ok">All thresholds passed</p>')

    # Error summary (API + status + response body) parsed from console.log.
    err_summary = build_error_summary(os.path.join(result_dir, 'console.log'))
    if err_summary is None:
        error_summary_section = ('<h2>Error summary</h2>'
                                 '<p class="nodata">console.log not found — response bodies unavailable.</p>')
    elif not err_summary:
        error_summary_section = '<h2>Error summary</h2><p class="ok">No logged errors 🎉</p>'
    else:
        esrows = ''
        for e in err_summary:
            body = e['body']
            disp = body if len(body) <= 500 else body[:500] + '…'
            esrows += (f'<tr class="badrow"><td>{esc(e["api"])}</td>'
                       f'<td class="r">{esc(e["status"])}</td>'
                       f'<td class="ebody" title="{esc(body)}">{esc(disp)}</td>'
                       f'<td class="r">{f0(e["count"])}</td></tr>')
        error_summary_section = (
            f'<h2>Error summary <span class="badge">({len(err_summary)})</span> — '
            'all error types per API (status + response body)</h2>'
            '<table><thead><tr><th>API</th><th class="r">Status</th>'
            '<th>Response body</th><th class="r">Count</th></tr></thead>'
            f'<tbody>{esrows}</tbody></table>')

    # Charts — interactive uPlot when vendored, else static SVG fallback.
    ts = build_timeseries(os.path.join(result_dir, 'metrics.csv'))
    uplot_js, uplot_css = load_uplot()
    uplot_css_tag = ''
    charts_js = ''

    if uplot_js and uplot_css:
        cfgs = []
        # Time-series line charts
        if ts:
            ts_specs = [
                ('c_rps', 'Requests / s', 'rps', '', '#2a6fdb', 'rgba(42,111,219,.12)'),
                ('c_p95', 'HTTP request duration p95', 'p95', 'ms', '#8e44ad', 'rgba(142,68,173,.12)'),
                ('c_vus', 'Active VUs', 'vus', '', '#16a085', 'rgba(22,160,133,.12)'),
                ('c_err', 'HTTP error rate', 'err', '%', '#c0392b', 'rgba(192,57,43,.12)'),
            ]
            ts_divs = ''
            for cid, ctitle, key, unit, color, fill in ts_specs:
                xs = [round(p[0], 3) for p in ts[key]]
                ys = [round(p[1], 3) for p in ts[key]]
                cfgs.append({'id': cid, 'kind': 'line', 'title': ctitle, 'unit': unit,
                             'height': 180, 'color': color, 'fill': fill, 'data': [xs, ys]})
                ts_divs += f'<div class="chart uchart" id="{cid}"></div>'
            charts_section = f'<h2>Time-series</h2><div class="charts">{ts_divs}</div>'
        else:
            charts_section = '<h2>Time-series</h2><p class="nodata">metrics.csv not found — charts unavailable.</p>'

        # Per-API bar + stacked success/failed charts
        bar_section = ''
        if api_chart:
            labels = [_short(a[0]) for a in api_chart]
            xs = list(range(len(api_chart)))
            p95s = [round(a[1], 1) for a in api_chart]
            faileds = [a[3] for a in api_chart]
            successes = [a[2] - a[3] for a in api_chart]
            cfgs.append({'id': 'c_apilat', 'kind': 'bars', 'title': 'p95 latency by API',
                         'unit': 'ms', 'height': 240, 'labels': labels,
                         'stroke': '#8e44ad', 'fill': 'rgba(142,68,173,.55)',
                         'data': [xs, p95s]})
            cfgs.append({'id': 'c_apireq', 'kind': 'groupedBars',
                         'title': 'Requests by API (success vs failed)', 'unit': '', 'height': 240,
                         'labels': labels,
                         'styles': [
                             {'label': 'Success', 'stroke': '#2a6fdb', 'fill': 'rgba(42,111,219,.55)'},
                             {'label': 'Failed', 'stroke': '#c0392b', 'fill': 'rgba(192,57,43,.55)'},
                         ],
                         'data': [xs, successes, faileds]})
            bar_section = ('<h2>By API (charts)</h2><div class="charts">'
                           '<div class="chart uchart" id="c_apilat"></div>'
                           '<div class="chart uchart" id="c_apireq"></div></div>')

        uplot_css_tag = f'<style>{uplot_css}</style>'
        charts_js = (f'<script>{uplot_js}</script>'
                     f'<script>window.__CHARTS__={json.dumps(cfgs)};{UPLOT_INIT_JS}</script>')
    else:
        # Static SVG fallback (no uPlot vendored)
        if ts:
            charts = (
                line_chart('Requests / s', ts['rps'], color='#2a6fdb')
                + line_chart('HTTP request duration p95', ts['p95'], unit='ms', color='#8e44ad')
                + line_chart('Active VUs', ts['vus'], color='#16a085')
                + line_chart('HTTP error rate', ts['err'], unit='%', color='#c0392b')
            )
            charts_section = f'<h2>Time-series</h2><div class="charts">{charts}</div>'
        else:
            charts_section = '<h2>Time-series</h2><p class="nodata">metrics.csv not found — charts unavailable.</p>'
        bar_section = ''
        if lat_bars:
            bars = (bar_chart('p95 latency by API', lat_bars, unit='ms', warn=warn)
                    + bar_chart('Requests by API (red = failed)', req_bars, warn=warn))
            bar_section = f'<h2>By API (charts)</h2><div class="charts">{bars}</div>'

    err_banner = ''
    if err_pct > 0 or breaches:
        bits = []
        if err_pct > 0:
            bits.append(f'{f1(err_pct)}% of HTTP requests failed')
        if breaches:
            bits.append(f'{len(breaches)} threshold breach(es)')
        err_banner = f'<div class="banner">⚠ {esc(" · ".join(bits))}</div>'

    generated = datetime.now(timezone.utc).isoformat(timespec='seconds')

    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{esc(title)}</title>
<style>
:root{{--bd:#e2e2e2;--muted:#666;--bad:#c0392b;--ok:#1e8449;--head:#2c3e50}}
*{{box-sizing:border-box}}body{{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;color:#222}}
h1{{margin:0 0 4px;font-size:22px;color:var(--head)}}h2{{font-size:16px;color:var(--head);margin:28px 0 8px;border-bottom:1px solid var(--bd);padding-bottom:4px}}
.desc{{color:var(--muted);margin:0 0 4px}}.gen{{color:var(--muted);font-size:12px;margin:0 0 12px}}
.banner{{background:#fdecea;border:1px solid #f5c6c2;color:var(--bad);padding:8px 12px;border-radius:6px;font-weight:600;margin:0 0 12px}}
.tiles{{display:flex;flex-wrap:wrap;gap:10px}}.tile{{border:1px solid var(--bd);border-radius:8px;padding:10px 14px;min-width:150px}}
.tile.bad{{border-color:#f5c6c2;background:#fdecea}}.tile.bad .tv{{color:var(--bad)}}
.tk{{color:var(--muted);font-size:12px}}.tv{{font-size:20px;font-weight:600}}
.charts{{display:flex;flex-wrap:wrap;gap:16px}}.chart{{flex:1 1 340px;min-width:320px;border:1px solid var(--bd);border-radius:8px;padding:8px 10px}}
.chart svg{{width:100%;height:auto}}.ct{{font-size:13px;font-weight:600;color:var(--head);margin-bottom:2px}}
.grid{{stroke:#eee;stroke-width:1}}.yl{{fill:var(--muted);font-size:9px;text-anchor:end}}.xl{{fill:var(--muted);font-size:9px}}
.bv{{fill:var(--muted);font-size:9px;text-anchor:middle}}.bl{{fill:#444;font-size:9px}}.nodata{{color:var(--muted);padding:20px;text-align:center}}
table{{border-collapse:collapse;width:100%;margin-top:6px}}th,td{{border:1px solid var(--bd);padding:6px 10px;text-align:left}}
th{{background:#f7f7f7}}td.r,th.r{{text-align:right}}.ok{{color:var(--ok)}}.bad{{color:var(--bad)}}
.badrow{{background:#fdecea}}.badrow td{{color:var(--bad)}}.badge{{font-weight:600}}ul{{margin:6px 0;padding-left:20px}}
.ebody{{max-width:520px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}}
.chart .u-title{{font-size:13px;font-weight:600;color:var(--head)}}.chart .u-legend{{font-size:11px}}
</style>{uplot_css_tag}</head><body>
<h1>{esc(title)}</h1>
{f'<p class="desc">{esc(description)}</p>' if description else ''}
<p class="gen">Generated {esc(generated)}</p>
{err_banner}

<h2>Overview</h2>
<div class="tiles">{tiles_html}</div>

{charts_section}

{bar_section}

<h2>By scenario</h2>
<table><thead><tr><th>Scenario</th><th class="r">Requests</th><th class="r">HTTP error %</th><th class="r">HTTP p95 (ms)</th></tr></thead>
<tbody>{scen_rows or '<tr><td colspan="4">No per-scenario data</td></tr>'}</tbody></table>

<h2>By API</h2>
<table><thead><tr><th>API</th><th class="r">Requests</th><th class="r">Failed</th><th class="r">Fail %</th><th class="r">p95 (ms)</th></tr></thead>
<tbody>{api_rows or '<tr><td colspan="5">No API data</td></tr>'}</tbody></table>

<h2>Failures <span class="badge">({len(failure_rows)})</span></h2>
<table><thead><tr><th>API</th><th class="r">HTTP status</th><th class="r">Count</th><th>Likely reason</th></tr></thead>
<tbody>{failures_html}</tbody></table>

{error_summary_section}

<h2>Threshold breaches</h2>
{breach_html}
{charts_js}
</body></html>"""


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: build-report.py <RESULT_DIR>')
    result_dir = sys.argv[1]
    html_out = build(result_dir)
    out_path = os.path.join(result_dir, 'report.html')
    with open(out_path, 'w') as fh:
        fh.write(html_out)
    print(f'Report written to: {out_path}')


if __name__ == '__main__':
    main()
