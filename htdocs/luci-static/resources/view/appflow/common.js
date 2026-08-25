'use strict';
'require baseclass';
'require request';
'require rpc';

/*
 * AppFlow: shared frontend helpers.
 *
 * Everything the two views have in common lives here: the ubus bindings from
 * DESIGN.md §5, a thin normalisation layer over the daemon payloads, byte/rate
 * formatting, the category colour scheme and the SVG chart primitives.
 *
 * The charts are hand-drawn SVG on purpose (see docs/frontend.md): SVG reads
 * the theme's CSS custom properties directly, so identical markup stays legible
 * on the light and dark bootstrap themes with no JS colour probing.
 */

/* ------------------------------------------------------------------ ubus */

/* No `expect` filter: the daemon's exact envelope is still settling and an
 * expect type mismatch would silently swallow a valid reply. `reject: true`
 * makes a non-zero ubus status reject (4 = object not found, i.e. appflowd is
 * down; 6 = permission denied, i.e. an ACL gap), which is what the views key
 * their "not running" state off. */
function declare(method, params) {
	return rpc.declare({
		object: 'appflow',
		method: method,
		params: params,
		reject: true
	});
}

/* §5 also defines `apps` and `flows`; neither v1 view needs them, so they are
 * intentionally not bound here -- and as of 2026-08-25 the rpcd ACL does not
 * grant them either. A security audit pointed out that this comment was the
 * evidence: the frontend had been deliberately narrowed and the boundary file
 * had not, so an account restricted to this package alone could still call
 * `flows` directly through /cgi-bin/luci/admin/ubus. That one matters more than
 * the others, because every method the UI does use returns an AGGREGATE, while
 * `flows` is the live per-connection table -- which local device is talking to
 * which remote endpoint, right now. If a view grows to need either, bind it
 * here AND add it back to the ACL, in that order.
 * `params` is positional: callStats('hour'), callDetail('a10465'). */
var callStatus  = declare('status'),
    callSummary = declare('summary'),
    callDevices = declare('devices'),
    callStats   = declare('stats', [ 'range' ]),
    callDetail  = declare('app_detail', [ 'app' ]),
    callReset   = declare('reset');

/* ------------------------------------------------------------- constants */

var STYLE_ID = 'appflow-style';

/*
 * Optional icon pack (DESIGN §9 soft coupling). The sibling package
 * luci-app-appflow-icons installs a manifest plus SVGs under
 * /luci-static/resources/appflow-icons/. Nothing here depends on it: the
 * manifest is probed once per page load and, when it is absent, every tile
 * stays a letter tile for the rest of the session.
 *
 *   iconMap === null   probe has not run yet
 *   iconMap === {}     pack absent or unreadable, do not ask again
 */
var ICON_BASE = L.resource('appflow-icons'),
    ICON_FILE = /^[A-Za-z0-9._-]+\.svg$/,
    iconMap = null,
    iconProbe = null;

/* Mid-luminance hues: white tile text is legible on every entry, and each
 * colour keeps enough contrast against both the white and the #222 page. */
var PALETTE = [
	'hsl(210,58%,46%)', 'hsl(150,50%,36%)', 'hsl(27,70%,46%)', 'hsl(280,40%,52%)',
	'hsl(340,52%,50%)', 'hsl(190,55%,38%)', 'hsl(96,40%,38%)', 'hsl(256,44%,56%)',
	'hsl(12,60%,50%)',  'hsl(172,45%,34%)', 'hsl(44,58%,40%)', 'hsl(318,36%,46%)',
	'hsl(224,42%,58%)', 'hsl(84,38%,32%)',  'hsl(0,52%,46%)',   'hsl(300,30%,42%)',
	'hsl(200,60%,32%)', 'hsl(62,42%,34%)'
];

/*
 * Hashing a category name into PALETTE is fine for a tile, but the doughnut
 * legend uses the same colours as a key, and with ~32 netify category tags in
 * 18 buckets collisions are common enough to be seen (web and social-media
 * collided on the first live run). The tags that actually show up get a fixed
 * slot so the legend is unambiguous; anything outside this list still hashes.
 */
var CATEGORY_SLOT = {
	'web': 0,                  'os-software-updates': 1,  'networking': 2,
	'infrastructure': 3,       'social-media': 4,         'messaging': 5,
	'cdn': 6,                  'technology': 7,           'shopping': 8,
	'financial': 9,            'business': 10,            'games': 11,
	'file-sharing': 12,        'mail': 13,                'streaming-media': 14,
	'advertiser': 15,          'voip': 16,                'news': 17
};

/* 'unclassified' is a real netify category; 'other' is our own roll-up of the
 * slices past the top N. They are different things, so they get different
 * greys rather than colliding in the doughnut legend. */
var NEUTRAL = 'hsl(0,0%,50%)',
    NEUTRAL_ROLLUP = 'hsl(0,0%,72%)';

/* Netify category tags whose naive title-case reads badly. */
var CATEGORY_LABELS = {
	'cdn':                 _('CDN'),
	'voip':                _('VoIP'),
	'vpn-and-proxy':       _('VPN & Proxy'),
	'os-software-updates': _('OS & Software Updates'),
	'device-iot':          _('IoT Devices'),
	'file-sharing':        _('File Sharing'),
	'file-server':         _('File Server'),
	'social-media':        _('Social Media'),
	'streaming-media':     _('Streaming Media'),
	'remote-desktop':      _('Remote Desktop'),
	'media-provider':      _('Media Provider'),
	'unclassified':        _('Unclassified')
};

/* Field-name aliases.
 *
 * appflowd speaks two dialects: the live aggregates (summary / apps / devices)
 * use bytes_down / bytes_up / bytes_total / rate_down / rate_up / rate_total,
 * while the range views (stats / app_detail) use download / upload / total.
 * Every read goes through these lists, so the views never care which one they
 * are looking at and a future rename costs one edit here.
 *
 * Note that `tag` is deliberately NOT a category alias: on the live aggregates
 * it carries the raw detection tag ("netify.openwrt"), not a category. */
var A_DL   = [ 'download', 'bytes_down', 'rx_bytes', 'download_bytes', 'total_download' ],
    A_UL   = [ 'upload', 'bytes_up', 'tx_bytes', 'upload_bytes', 'total_upload' ],
    A_TOT  = [ 'total', 'bytes_total', 'total_bytes', 'total_traffic' ],
    A_RDL  = [ 'rate_down', 'rx_rate', 'download_rate', 'down_rate' ],
    A_RUL  = [ 'rate_up', 'tx_rate', 'upload_rate', 'up_rate' ],
    A_RATE = [ 'rate_total', 'rate', 'total_rate' ],
    A_KEY  = [ 'key', 'app', 'application', 'application_id', 'app_identifier', 'id' ],
    A_LBL  = [ 'label', 'name', 'application_name', 'app_name', 'app', 'application' ],
    A_CAT  = [ 'category', 'category_name', 'cat' ],
    A_HOST = [ 'host', 'hostname', 'host_server_name', 'domain' ],
    A_MAC  = [ 'mac', 'local_mac', 'mac_address', 'macaddr' ],
    A_IP   = [ 'ip', 'local_ip', 'ipaddr', 'address' ],
    A_DNAM = [ 'name', 'hostname', 'label', 'alias', 'device' ],
    A_SEEN = [ 'last_seen', 'last_seen_at', 'last_active', 'last_active_time', 'seen' ],
    A_TIME = [ 'ts', 't', 'time', 'timestamp', 'interval_start', 'start' ],
    A_NFLOW = [ 'flows', 'active_flows', 'flow_count' ],
    /* Raw netify detection tag: named 'tag' on the live aggregates and on
     * app_detail, carried in 'app' on the range views. Icon lookups key off
     * this, never off the display label. */
    A_TAG   = [ 'tag', 'app' ];

/* ------------------------------------------------------------------- css */

var CSS = '\
.af-grid{display:grid;grid-template-columns:1fr;gap:0 1em}\
@media (min-width:920px){.af-grid.af-split{grid-template-columns:minmax(0,1.9fr) minmax(270px,1fr)}}\
.af-card{border:1px solid var(--border-color-medium);border-radius:4px;\
 background:var(--background-color-high);padding:.8em 1em 1em;margin:0 0 1em}\
.af-cardhead{display:flex;align-items:baseline;justify-content:space-between;\
 gap:.75em;flex-wrap:wrap;margin:0 0 .8em}\
.af-cardhead h3{margin:0;padding:0;font-size:15px;font-weight:700;border:none}\
.af-cardaux{display:flex;align-items:center;gap:.7em;flex-wrap:wrap;\
 font-size:11px;color:var(--text-color-medium)}\
.af-sub{color:var(--text-color-medium);font-size:11px;line-height:14px;display:block}\
.af-app .af-sub,.af-legend .af-legend-lbl,.af-applabel{overflow:hidden;\
 text-overflow:ellipsis;white-space:nowrap}\
.af-empty .af-sub{font-size:12px;line-height:16px}\
.af-mono{font-family:var(--font-mono);font-size:10.5px}\
.af-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;\
 font-feature-settings:"tnum" 1}\
.af-strip{display:flex;flex-wrap:wrap;gap:.4em;margin:0 0 1em}\
.af-pill{display:inline-flex;align-items:center;gap:.45em;font-size:11px;\
 line-height:1;padding:.45em .75em;border-radius:11px;\
 border:1px solid var(--border-color-medium);color:var(--text-color-medium);\
 background:var(--background-color-low)}\
.af-pill > i{width:7px;height:7px;border-radius:50%;background:var(--text-color-low)}\
.af-pill.af-ok > i{background:var(--success-color-high)}\
.af-pill.af-warn{color:var(--error-color-high);border-color:var(--error-color-high)}\
.af-pill.af-warn > i{background:var(--error-color-high)}\
.af-tile{display:inline-flex;align-items:center;justify-content:center;\
 width:26px;height:26px;flex:0 0 26px;border-radius:5px;color:#fff;\
 font-weight:600;font-size:12px;text-shadow:0 1px 1px rgba(0,0,0,.25)}\
.af-tile.af-tile-icon{font-size:0}\
.af-tile-img{width:64%;height:64%;object-fit:contain;display:block}\
.af-tile-img.af-mono{filter:brightness(0) invert(1)}\
.af-app{display:flex;align-items:center;gap:.6em;min-width:0}\
.af-appname{min-width:0;overflow:hidden}\
.af-applabel{display:block;overflow:hidden;text-overflow:ellipsis;\
 white-space:nowrap;line-height:16px}\
.af-bar{position:relative;display:flex;height:8px;min-width:56px;border-radius:4px;\
 background:var(--background-color-medium);overflow:hidden;\
 box-shadow:inset 0 0 0 1px var(--border-color-low)}\
.af-bar > i{display:block;height:100%;transition:width .3s ease-out}\
i.af-dl{background:var(--primary-color-high)}\
i.af-ul{background:var(--success-color-high)}\
.af-kpi{display:flex;flex-wrap:wrap;gap:1.4em 2.4em;margin:0 0 1.1em}\
.af-kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.08em;\
 color:var(--text-color-medium);margin-bottom:.2em}\
.af-kpi-val{font-size:21px;line-height:1.1;font-weight:600;\
 font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}\
.af-kpi-val.af-dlc{color:var(--primary-color-high)}\
.af-kpi-val.af-ulc{color:var(--success-color-high)}\
.af-plot{position:relative;padding-left:64px}\
.af-plot > svg{display:block;width:100%;height:100%;overflow:visible}\
.af-grid-line{stroke:var(--border-color-medium);stroke-width:1;opacity:.7}\
.af-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}\
.af-line.af-dl{stroke:var(--primary-color-high)}\
.af-line.af-ul{stroke:var(--success-color-high)}\
.af-area{stroke:none}\
.af-area.af-dl{fill:var(--primary-color-high);fill-opacity:.16}\
.af-area.af-ul{fill:var(--success-color-high);fill-opacity:.12}\
rect.af-col.af-dl{fill:var(--primary-color-high)}\
rect.af-col.af-ul{fill:var(--success-color-high)}\
.af-yaxis{position:absolute;left:0;top:0;bottom:0;width:58px;pointer-events:none}\
.af-ylbl{position:absolute;right:0;transform:translateY(-50%);font-size:10px;\
 color:var(--text-color-medium);font-variant-numeric:tabular-nums;white-space:nowrap}\
.af-xaxis{display:flex;justify-content:space-between;padding-left:64px;\
 font-size:10px;color:var(--text-color-medium);margin-top:.8em}\
.af-key{display:flex;gap:1.5em;flex-wrap:wrap;margin-top:.7em;font-size:11px}\
.af-key > span{display:inline-flex;align-items:center;gap:.4em}\
.af-key strong{font-size:12px}\
.af-dot{display:inline-block;width:9px;height:9px;border-radius:2px;flex:0 0 9px}\
.af-donut-wrap{display:flex;align-items:center;gap:1.2em;flex-wrap:wrap}\
.af-donut{position:relative;width:128px;height:128px;flex:0 0 128px}\
.af-donut > svg{display:block;width:100%;height:100%;transform:rotate(-90deg)}\
.af-donut-track{stroke:var(--background-color-medium)}\
.af-donut-mid{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;\
 flex-direction:column;align-items:center;justify-content:center;\
 text-align:center;pointer-events:none}\
.af-donut-mid strong{font-size:14px;font-variant-numeric:tabular-nums}\
.af-donut-mid span{font-size:9px;color:var(--text-color-medium);\
 text-transform:uppercase;letter-spacing:.07em}\
.af-legend{list-style:none;margin:0;padding:0;flex:1 1 145px;min-width:0}\
.af-legend > li{display:flex;align-items:center;gap:.5em;padding:.22em 0;font-size:12px}\
.af-legend-lbl{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;\
 white-space:nowrap}\
.af-legend-val{flex:0 0 auto;color:var(--text-color-medium);font-size:11px}\
.af-table{margin-bottom:0}\
.af-table .th,.af-table .td{padding:7px 10px}\
.af-table .tr.af-row{cursor:pointer}\
.af-table .tr.af-row:hover .td{background:var(--background-color-low)}\
.af-table .tr.af-all .td{background:var(--background-color-medium);font-weight:600}\
.af-table .th.af-num,.af-table .td.af-num{text-align:right}\
.af-table .th.af-sortable{cursor:pointer;user-select:none;white-space:nowrap}\
.af-table .th.af-sortable:hover{color:var(--primary-color-high)}\
.af-caret{font-size:9px;margin-left:.3em;opacity:.6}\
.af-placeholder{padding:1.7em 0;text-align:center;color:var(--text-color-medium);\
 font-size:12px}\
.af-empty{text-align:center;padding:2.2em 1em}\
.af-empty svg{width:34px;height:34px;fill:var(--warn-color-high);margin-bottom:.3em}\
.af-empty h3{margin:0 0 .5em;border:none;font-size:16px}\
.af-empty p{max-width:52em;margin:0 auto .8em;color:var(--text-color-medium)}\
.af-cmd{display:inline-block;text-align:left;margin:0 auto .9em;padding:.6em .9em;\
 border:1px solid var(--border-color-medium);border-radius:3px;\
 background:var(--background-color-low);font-family:var(--font-mono);font-size:12px}\
.af-toolbar{display:flex;align-items:center;gap:.6em;flex-wrap:wrap;margin:0 0 .9em}\
.af-toolbar input[type="text"]{width:235px;max-width:100%}\
.af-spacer{flex:1 1 auto}\
.af-ranges{margin-bottom:1.2em}\
.af-ranges > li.af-disabled,.af-ranges > li.af-disabled > a{cursor:not-allowed}\
.af-modal-head{display:flex;align-items:center;gap:.75em;margin:0 0 1em}\
.af-modal-head .af-tile{width:34px;height:34px;flex-basis:34px;font-size:15px;\
 border-radius:6px}\
.af-modal-head h4{margin:0;font-size:16px;line-height:1.2}\
.af-badge{display:inline-block;font-size:10px;letter-spacing:.03em;padding:.2em .55em;\
 border-radius:9px;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.25)}\
.af-btnrow{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:.5em;margin-top:.8em}\
.af-tag{display:inline-block;margin-left:.45em;padding:0 .4em;border-radius:3px;\
 font-size:9px;line-height:14px;text-transform:uppercase;letter-spacing:.05em;\
 color:var(--text-color-medium);border:1px solid var(--border-color-high);\
 vertical-align:1px}\
.modal h4{margin:1.1em 0 .5em;font-size:13px;text-transform:uppercase;\
 letter-spacing:.06em;color:var(--text-color-medium);border:none}\
.modal .af-modal-head h4{margin:0;font-size:16px;text-transform:none;letter-spacing:0;\
 color:var(--text-color-high)}\
';

/* --------------------------------------------------------------- exports */

return baseclass.extend({
	rpc: {
		status: callStatus,
		summary: callSummary,
		devices: callDevices,
		stats: callStats,
		detail: callDetail,
		reset: callReset
	},

	/* ------------------------------------------------------ value picking */

	num: function(obj, names, dflt) {
		if (obj != null)
			for (var i = 0; i < names.length; i++) {
				var v = obj[names[i]];

				if (v != null && v !== '' && typeof v != 'object' && !isNaN(+v))
					return +v;
			}

		return (dflt != null) ? dflt : 0;
	},

	str: function(obj, names, dflt) {
		if (obj != null)
			for (var i = 0; i < names.length; i++) {
				var v = obj[names[i]];

				if (v != null && v !== '' && typeof v != 'object')
					return String(v);
			}

		return (dflt != null) ? dflt : '';
	},

	/* A ubus payload may hand back either an array or a map keyed by id;
	 * accept both and always yield an array. */
	toList: function(value, keyField) {
		if (Array.isArray(value))
			return value.filter(function(v) { return v != null; });

		if (!value || typeof value != 'object')
			return [];

		return Object.keys(value).map(function(k) {
			var row = (value[k] && typeof value[k] == 'object') ? value[k] : {},
			    out = {};

			for (var f in row)
				out[f] = row[f];

			if (keyField && out[keyField] == null)
				out[keyField] = k;

			return out;
		});
	},

	/* -------------------------------------------------------- normalisers */

	/* Byte and rate counters, wherever they sit in the payload. */
	normTotals: function(raw) {
		var dl = this.num(raw, A_DL),
		    ul = this.num(raw, A_UL),
		    tot = this.num(raw, A_TOT, -1),
		    rdl = this.num(raw, A_RDL),
		    rul = this.num(raw, A_RUL),
		    rate = this.num(raw, A_RATE, -1);

		return {
			dl: dl,
			ul: ul,
			total: (tot >= 0) ? tot : dl + ul,
			rdl: rdl,
			rul: rul,
			rate: (rate >= 0) ? rate : rdl + rul,
			flows: this.num(raw, A_NFLOW)
		};
	},

	/* A dedicated rate object may name its members download/upload rather than
	 * rx_rate/tx_rate; fold both spellings into rdl/rul. */
	normRates: function(raw) {
		var t = this.normTotals(raw);

		return {
			rdl: t.rdl || t.dl,
			rul: t.rul || t.ul,
			rate: t.rate || t.total
		};
	},

	normApp: function(raw) {
		var t = this.normTotals(raw),
		    label = this.appLabel(this.str(raw, A_LBL, _('Unknown')));

		t.key = this.str(raw, A_KEY, label);
		t.label = label;
		t.cat = this.str(raw, A_CAT);
		t.host = this.str(raw, A_HOST);
		t.tag = this.str(raw, A_TAG);
		t.series = this.normSeries(raw ? (raw.time_series || raw.series) : null);

		return t;
	},

	normDevice: function(raw) {
		var t = this.normTotals(raw),
		    mac = this.str(raw, A_MAC),
		    ip = this.str(raw, A_IP);

		t.mac = mac.toUpperCase();
		t.ip = ip;
		t.name = this.str(raw, A_DNAM, ip || mac || _('Unknown device'));
		t.seen = this.num(raw, A_SEEN, 0);
		t.isRouter = !!(raw && raw.is_router);

		/* the daemon falls back to the MAC when no lease name is known; do not
		 * then print the same string twice in the cell */
		t.sub = (t.name.toUpperCase() == t.mac) ? t.ip : (t.mac || t.ip);

		return t;
	},

	/* Secondary line under an application name: the server hostname when the
	 * payload carries one, otherwise the category, otherwise the flow count. */
	subLabel: function(app) {
		if (app.host)
			return app.host;

		if (app.cat)
			return this.catLabel(app.cat);

		if (app.flows)
			return this.fmtFlows(app.flows);

		return '';
	},

	fmtFlows: function(count) {
		var n = Math.max(0, Math.round(+count || 0));

		return (n == 1) ? _('1 flow') : _('%d flows').format(n);
	},

	normSeries: function(raw) {
		var self = this;

		return this.toList(raw).map(function(p) {
			var dl = self.num(p, A_DL),
			    ul = self.num(p, A_UL),
			    tot = self.num(p, A_TOT, -1);

			return {
				t: self.num(p, A_TIME, 0),
				dl: dl,
				ul: ul,
				total: (tot >= 0) ? tot : dl + ul
			};
		});
	},

	/* --------------------------------------------------------- formatting */

	/* LuCI's %m specifier only engages above the divisor and prints the raw
	 * float below it, so anything under 1 KiB is rounded here instead. */
	fmtBytes: function(bytes) {
		var n = +bytes;

		if (!isFinite(n) || n < 0)
			n = 0;

		return (n > 1024) ? '%1024.2mB'.format(n) : '%d B'.format(Math.round(n));
	},

	fmtRate: function(bps) {
		var n = +bps;

		if (!isFinite(n) || n < 0)
			n = 0;

		return (n > 1024) ? '%1024.2mB/s'.format(n) : '%d B/s'.format(Math.round(n));
	},

	fmtPercent: function(part, whole) {
		if (!whole)
			return '0.0%';

		/* Clamp at 100: the app total and the per-device totals come from rings
		 * of different bucket granularity over the same trailing hour, so at the
		 * window edge a single device's total can round just above the app total.
		 * A share over 100% reads as a bug even when the few-byte cause is benign. */
		var pct = 100 * part / whole;

		return '%.1f%%'.format(pct > 100 ? 100 : pct);
	},

	fmtAgo: function(stamp) {
		var ts = +stamp;

		if (!isFinite(ts) || ts <= 0)
			return '-';

		/* accept both second and millisecond epochs */
		if (ts < 1e11)
			ts *= 1000;

		var d = Math.round((Date.now() - ts) / 1000);

		if (d < 0)
			d = 0;

		if (d < 15)
			return _('just now');

		if (d < 60)
			return _('%d s ago').format(d);

		if (d < 3600)
			return _('%d min ago').format(Math.floor(d / 60));

		if (d < 86400)
			return _('%d h ago').format(Math.floor(d / 3600));

		return _('%d d ago').format(Math.floor(d / 86400));
	},

	fmtUptime: function(seconds) {
		return '%t'.format(Math.max(0, Math.floor(+seconds || 0)));
	},

	/* "netify.google-ads" -> "Google Ads"; already-pretty names pass through. */
	appLabel: function(name) {
		var s = String(name || '').replace(/^netify\./, '');

		if (!s.length)
			return _('Unknown');

		if (/^[a-z0-9]+([-_.][a-z0-9]+)*$/.test(s))
			s = s.split(/[-_.]/).map(function(w) {
				return w.charAt(0).toUpperCase() + w.substr(1);
			}).join(' ');

		return s;
	},

	catLabel: function(cat) {
		var c = String(cat || '').toLowerCase();

		if (!c.length)
			return _('Unclassified');

		if (CATEGORY_LABELS[c])
			return CATEGORY_LABELS[c];

		return c.split(/[-_]/).map(function(w) {
			return w.charAt(0).toUpperCase() + w.substr(1);
		}).join(' ');
	},

	/* ------------------------------------------------------------ colours */

	/* Stable hash of the category, so every app in a category shares its tile
	 * colour and the doughnut legend reads as one colour system. */
	color: function(key) {
		var s = String(key == null ? '' : key).toLowerCase();

		if (s == 'other')
			return NEUTRAL_ROLLUP;

		if (!s.length || s == 'unclassified' || s == 'unknown')
			return NEUTRAL;

		if (CATEGORY_SLOT[s] != null)
			return PALETTE[CATEGORY_SLOT[s]];

		var h = 0;

		for (var i = 0; i < s.length; i++)
			h = ((h << 5) - h + s.charCodeAt(i)) | 0;

		return PALETTE[Math.abs(h) % PALETTE.length];
	},

	/* --------------------------------------------------------- primitives */

	/*
	 * Probe the optional icon pack. Resolves either way and never rejects, so
	 * callers can fold it into their load() without a catch: a missing pack is
	 * the normal case, not an error.
	 */
	loadIcons: function() {
		if (iconProbe != null)
			return iconProbe;

		iconProbe = request.get(ICON_BASE + '/manifest.json', { cache: true })
			.then(function(res) {
				var map = res.ok ? res.json() : null;

				iconMap = (map != null && typeof map == 'object') ? map : {};
			})
			.catch(function() {
				iconMap = {};
			});

		return iconProbe;
	},

	/*
	 * Resolve a netify tag to an icon. simple-icons ship as fill-less glyphs
	 * that would render black on a coloured tile, so they are flagged for the
	 * white-out filter; full-colour logos are left alone.
	 */
	iconFor: function(tag) {
		var t = String(tag || '');

		if (iconMap == null || !t.length)
			return null;

		var e = iconMap[t];

		if (e == null || typeof e.file != 'string' || !ICON_FILE.test(e.file))
			return null;

		return {
			url: ICON_BASE + '/svg/' + e.file,
			mono: (e.source == 'simple-icons')
		};
	},

	tile: function(label, category, tag) {
		var s = String(label || '').replace(/^[^0-9A-Za-z]+/, ''),
		    ch = s.length ? s.charAt(0).toUpperCase() : '?',
		    icon = this.iconFor(tag),
		    node = E('span', {
			'class': 'af-tile',
			'style': 'background:' + this.color(category || label),
			'aria-hidden': 'true'
		    }, [ ch ]);

		if (icon == null)
			return node;

		/* The letter stays in the DOM behind font-size:0 and is only hidden once
		 * the icon has actually decoded, so a cold cache shows a letter that
		 * swaps to the logo rather than an empty coloured square, and a manifest
		 * entry pointing at a file that is not installed keeps the letter. */
		var img = E('img', {
			'class': 'af-tile-img' + (icon.mono ? ' af-mono' : ''),
			'src': icon.url,
			'alt': '',
			'load': function(ev) {
				if (ev.target.parentNode)
					ev.target.parentNode.classList.add('af-tile-icon');
			},
			'error': function(ev) {
				var host = ev.target.parentNode;

				if (host) {
					host.removeChild(ev.target);
					host.classList.remove('af-tile-icon');
				}
			}
		});

		node.appendChild(img);

		/* already in cache: hide the letter now, before the first paint */
		if (img.complete && img.naturalWidth > 0)
			node.classList.add('af-tile-icon');

		return node;
	},

	appCell: function(app, sub) {
		var second = (sub != null) ? sub : this.subLabel(app);

		/* Colour seed: the category when the payload carries one, so every app
		 * in a category shares a tile colour; the stable app key otherwise. */
		return E('div', { 'class': 'af-app' }, [
			this.tile(app.label, app.cat || app.key || app.label, app.tag),
			E('div', { 'class': 'af-appname' }, [
				E('span', { 'class': 'af-applabel', 'title': app.label }, [ app.label ]),
				second ? E('span', { 'class': 'af-sub', 'title': second }, [ second ]) : ''
			])
		]);
	},

	deviceCell: function(dev) {
		return E('div', { 'class': 'af-app' }, [
			this.tile(dev.name, dev.mac || dev.name),
			E('div', { 'class': 'af-appname' }, [
				E('span', { 'class': 'af-applabel', 'title': dev.name }, [
					dev.name,
					dev.isRouter ? E('span', { 'class': 'af-tag' }, [ _('router') ]) : ''
				]),
				dev.sub ? E('span', { 'class': 'af-sub af-mono' }, [ dev.sub ]) : ''
			])
		]);
	},

	/* Two-tone download/upload bar, scaled against `max`. */
	/* `fmt` names the unit the caller is passing, because two of the three
	 * callers pass cumulative bytes and one passes rates. The tooltip formatted
	 * with fmtBytes unconditionally until 2026-08-25, so on the Overview's Top
	 * applications table the numeric cells read "1.20 MB/s" while hovering the
	 * bar in the same row read "Download: 1.20 MB" -- the same quantity stated
	 * twice, in two units, one of them wrong, and the wrong one being the one
	 * that looks cumulative. Fixed here rather than at the call site so the next
	 * caller cannot step on it, and so the translated string stops having to
	 * serve two unit systems at once. */
	bar: function(dl, ul, max, fmt) {
		var m = (max > 0) ? max : 1,
		    w1 = Math.max(0, Math.min(100, 100 * dl / m)),
		    w2 = Math.max(0, Math.min(100 - w1, 100 * ul / m)),
		    f = (typeof fmt === 'function') ? fmt : this.fmtBytes;

		return E('div', {
			'class': 'af-bar',
			'title': _('Download: %s, upload: %s').format(f.call(this, dl), f.call(this, ul))
		}, [
			E('i', { 'class': 'af-dl', 'style': 'width:%.2f%%'.format(w1) }),
			E('i', { 'class': 'af-ul', 'style': 'width:%.2f%%'.format(w2) })
		]);
	},

	kpi: function(label, value, cls) {
		return E('div', {}, [
			E('div', { 'class': 'af-kpi-lbl' }, [ label ]),
			E('div', { 'class': 'af-kpi-val' + (cls ? ' ' + cls : '') }, [ value ])
		]);
	},

	card: function(title, aux, body, cls) {
		return E('div', { 'class': 'cbi-section af-card' + (cls ? ' ' + cls : '') }, [
			E('div', { 'class': 'af-cardhead' }, [
				E('h3', {}, [ title ]),
				aux ? E('div', { 'class': 'af-cardaux' }, aux) : ''
			]),
			body
		]);
	},

	placeholder: function(text) {
		return E('div', { 'class': 'af-placeholder' }, [ text ]);
	},

	/* ------------------------------------------------------------- charts */

	/* Round a peak up to a 1/2/5 * 10^n boundary so axis labels stay tidy. */
	niceMax: function(value) {
		var v = +value;

		if (!isFinite(v) || v <= 0)
			return 1;

		var exp = Math.floor(Math.log(v) / Math.LN10),
		    base = Math.pow(10, exp),
		    frac = v / base,
		    step = (frac <= 1) ? 1 : (frac <= 2) ? 2 : (frac <= 5) ? 5 : 10;

		return step * base;
	},

	svg: function(tag, attrs, children) {
		var node = document.createElementNS('http://www.w3.org/2000/svg', tag);

		for (var k in (attrs || {}))
			if (attrs[k] != null)
				node.setAttribute(k, attrs[k]);

		(Array.isArray(children) ? children : (children != null ? [ children ] : []))
			.forEach(function(c) {
				node.appendChild((typeof c == 'string')
					? document.createTextNode(c) : c);
			});

		return node;
	},

	yAxis: function(peak, fmt) {
		return E('div', { 'class': 'af-yaxis' }, [ 1, 0.5, 0 ].map(function(f) {
			return E('span', {
				'class': 'af-ylbl',
				'style': 'top:%.1f%%'.format(100 * (1 - f))
			}, [ (f > 0) ? fmt(peak * f) : '0' ]);
		}));
	},

	xAxis: function(labels) {
		if (!labels || !labels.length)
			return '';

		return E('div', { 'class': 'af-xaxis' }, [
			E('span', {}, [ labels[0] ]),
			E('span', {}, [ labels[1] || '' ])
		]);
	},

	gridLines: function(w, h) {
		var out = [];

		for (var g = 0; g <= 4; g++)
			out.push(this.svg('line', {
				'class': 'af-grid-line',
				'x1': 0, 'x2': w,
				'y1': (h * g / 4).toFixed(1), 'y2': (h * g / 4).toFixed(1),
				'vector-effect': 'non-scaling-stroke'
			}));

		return out;
	},

	/*
	 * Rolling line chart.
	 *   series: [ { values: [...], cls: 'af-dl'|'af-ul', fill: bool } ]
	 *   opts:   { slots, height, fmt, xlabels: [ left, right ] }
	 *
	 * Drawn in a 1000x300 user space stretched to the container width. Strokes
	 * carry vector-effect="non-scaling-stroke" so they stay 2px whatever the
	 * horizontal scale, and every label is real HTML so it never distorts.
	 */
	lineChart: function(series, opts) {
		opts = opts || {};

		var self = this,
		    W = 1000, H = 300,
		    slots = Math.max(2, opts.slots || 60),
		    fmt = opts.fmt || function(v) { return self.fmtRate(v); },
		    peak = 0;

		series.forEach(function(s) {
			(s.values || []).forEach(function(v) {
				if (v > peak)
					peak = v;
			});
		});

		peak = this.niceMax(peak * 1.05);

		var kids = this.gridLines(W, H);

		series.forEach(function(s) {
			var vals = s.values || [],
			    n = vals.length;

			if (n < 1)
				return;

			var pts = vals.map(function(v, i) {
				var x = W * (slots - n + i) / (slots - 1),
				    y = H - H * Math.max(0, Math.min(1, v / peak));

				return x.toFixed(2) + ',' + y.toFixed(2);
			});

			if (s.fill && n > 1)
				kids.push(self.svg('path', {
					'class': 'af-area ' + (s.cls || ''),
					'd': 'M' + pts[0].split(',')[0] + ',' + H +
					     ' L' + pts.join(' L') +
					     ' L' + W + ',' + H + ' Z'
				}));

			kids.push(self.svg('path', {
				'class': 'af-line ' + (s.cls || ''),
				'vector-effect': 'non-scaling-stroke',
				'd': 'M' + pts.join(' L')
			}));
		});

		return E('div', { 'class': 'af-chart' }, [
			E('div', {
				'class': 'af-plot',
				'style': 'height:%dpx'.format(opts.height || 168)
			}, [
				this.svg('svg', {
					'viewBox': '0 0 %d %d'.format(W, H),
					'preserveAspectRatio': 'none',
					'role': 'img'
				}, kids),
				this.yAxis(peak, fmt)
			]),
			this.xAxis(opts.xlabels)
		]);
	},

	/*
	 * Stacked download/upload column chart for a short bucket series
	 * (the 12 x 5-minute points of the "past hour" range).
	 */
	columnChart: function(points, opts) {
		opts = opts || {};

		/* `slots` is the width of the axis the CALLER labels, in buckets. A
		 * partial series is drawn right-aligned against it, so three buckets
		 * occupy the last three of sixty rather than being stretched across the
		 * whole width beneath a label reading "-60 min".
		 *
		 * That stretch was the behaviour until 2026-08-25, and it was not an
		 * edge case: this daemon keeps nothing across a restart by design, so
		 * every boot, every `uci commit appflow`, and every fresh install spent
		 * its first hour showing a chart that asserted an hour of history it did
		 * not have. lineChart already did this correctly for the same problem,
		 * which is what made it a defect rather than a decision. Omit `slots`
		 * and the old full-width behaviour is kept, for any caller that really
		 * is showing a complete series. */
		var self = this,
		    W = 1000, H = 240,
		    n = Math.max(1, points.length),
		    slots = Math.max(n, opts.slots || 0),
		    peak = 0;

		points.forEach(function(p) {
			if (p.dl + p.ul > peak)
				peak = p.dl + p.ul;
		});

		peak = this.niceMax(peak * 1.05);

		var kids = this.gridLines(W, H),
		    slot = W / slots,
		    bw = slot * 0.6,
		    pad = (slot - bw) / 2,
		    off = (slots - n) * slot;   /* right-align a partial series */

		points.forEach(function(p, i) {
			var hdl = H * Math.max(0, Math.min(1, p.dl / peak)),
			    hul = H * Math.max(0, Math.min(1, p.ul / peak)),
			    x = off + i * slot + pad,
			    when = p.t
				? new Date(p.t < 1e11 ? p.t * 1000 : p.t)
					.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
				: '',
			    tip = '%s\n%s'.format(when,
				_('Download: %s, upload: %s')
					.format(self.fmtBytes(p.dl), self.fmtBytes(p.ul)));

			if (hdl > 0.4)
				kids.push(self.svg('rect', {
					'class': 'af-col af-dl',
					'x': x.toFixed(2), 'y': (H - hdl).toFixed(2),
					'width': bw.toFixed(2), 'height': hdl.toFixed(2)
				}, [ self.svg('title', {}, [ tip ]) ]));

			if (hul > 0.4)
				kids.push(self.svg('rect', {
					'class': 'af-col af-ul',
					'x': x.toFixed(2), 'y': (H - hdl - hul).toFixed(2),
					'width': bw.toFixed(2), 'height': hul.toFixed(2)
				}, [ self.svg('title', {}, [ tip ]) ]));
		});

		return E('div', { 'class': 'af-chart' }, [
			E('div', {
				'class': 'af-plot',
				'style': 'height:%dpx'.format(opts.height || 150)
			}, [
				this.svg('svg', {
					'viewBox': '0 0 %d %d'.format(W, H),
					'preserveAspectRatio': 'none',
					'role': 'img'
				}, kids),
				this.yAxis(peak, function(v) { return self.fmtBytes(v); })
			]),
			this.xAxis(opts.xlabels)
		]);
	},

	/*
	 * Doughnut. Pure SVG using stroke-dasharray on an r=15.91549 circle
	 * (circumference 100), so each slice length is literally its percentage.
	 */
	donut: function(slices, opts) {
		opts = opts || {};

		var self = this,
		    total = slices.reduce(function(a, s) { return a + Math.max(0, s.value); }, 0),
		    off = 25, /* rotate so the first slice starts at 12 o'clock */
		    ring = [ this.svg('circle', {
			'class': 'af-donut-track',
			'cx': 21, 'cy': 21, 'r': 15.91549,
			'fill': 'none', 'stroke-width': 5.2
		    }) ];

		if (total > 0)
			slices.forEach(function(s) {
				var pct = 100 * Math.max(0, s.value) / total;

				if (pct <= 0)
					return;

				ring.push(self.svg('circle', {
					'cx': 21, 'cy': 21, 'r': 15.91549,
					'fill': 'none',
					'stroke': s.color,
					'stroke-width': 5.2,
					'stroke-dasharray': '%.3f %.3f'.format(pct, 100 - pct),
					'stroke-dashoffset': off.toFixed(3)
				}, [ self.svg('title', {}, [ '%s: %s (%s)'.format(s.label,
					self.fmtBytes(s.value), self.fmtPercent(s.value, total)) ]) ]));

				off -= pct;
			});

		var legend = slices.map(function(s) {
			return E('li', {}, [
				E('span', { 'class': 'af-dot', 'style': 'background:' + s.color }),
				E('span', { 'class': 'af-legend-lbl', 'title': s.label }, [ s.label ]),
				E('span', { 'class': 'af-legend-val af-num' }, [
					self.fmtPercent(s.value, total)
				])
			]);
		});

		return E('div', { 'class': 'af-donut-wrap' }, [
			E('div', { 'class': 'af-donut' }, [
				this.svg('svg', { 'viewBox': '0 0 42 42', 'role': 'img' }, ring),
				E('div', { 'class': 'af-donut-mid' }, [
					E('strong', {}, [ opts.center || this.fmtBytes(total) ]),
					E('span', {}, [ opts.centerLabel || _('total') ])
				])
			]),
			E('ul', { 'class': 'af-legend' }, legend.length ? legend
				: [ E('li', { 'class': 'af-sub' }, [ _('No data') ]) ])
		]);
	},

	/* Download/upload key shown under the charts. */
	swatches: function(dlText, ulText) {
		return E('div', { 'class': 'af-key' }, [
			E('span', {}, [
				E('i', { 'class': 'af-dot af-dl' }),
				E('span', { 'class': 'af-sub' }, [ _('Download') ]),
				E('strong', { 'class': 'af-num' }, [ dlText ])
			]),
			E('span', {}, [
				E('i', { 'class': 'af-dot af-ul' }),
				E('span', { 'class': 'af-sub' }, [ _('Upload') ]),
				E('strong', { 'class': 'af-num' }, [ ulText ])
			])
		]);
	},

	/* ------------------------------------------------------- empty states */

	/* Classify an rpc.declare(reject:true) rejection. ubus status 6 is permission
	 * denied, which means appflowd IS up and the LuCI session lacks the ACL, a
	 * different problem with a different fix than a stopped daemon (status 4,
	 * object not found). LuCI encodes the rejection differently across versions
	 * (a bare number, an Error, or a status string), so probe all three. */
	classifyFail: function(err) {
		if (err === 6 || err === '6')
			return 'denied';
		var s = (err && typeof err === 'object') ? (err.message || '') : String(err == null ? '' : err);
		return (/\b6\b/.test(s) || /permission|denied|access/i.test(s)) ? 'denied' : 'down';
	},

	notRunning: function(kind, detail) {
		var denied = (kind === 'denied');

		return E('div', { 'class': 'cbi-section af-card af-empty' }, [
			this.svg('svg', { 'viewBox': '0 0 24 24', 'role': 'img' }, [
				this.svg('path', {
					'd': 'M12 2 1 21h22L12 2zm0 5 7.5 12.9h-15L12 7zm-1 4v5h2v-5h-2zm0 6v2h2v-2h-2z'
				})
			]),
			E('h3', {}, [ denied ? _('AppFlow: access denied') : _('appflowd is not running') ]),
			E('p', {}, [ denied
				? _('appflowd is running, but this LuCI session was refused access to it over ubus (permission denied). This is an ACL problem, not a stopped service: confirm the luci-app-appflow ACL is installed and reload rpcd.')
				: _('The AppFlow collector could not be reached over ubus, so there is no traffic data to show. Start the service and this page picks it up automatically.')
			]),
			E('pre', { 'class': 'af-cmd' }, [ denied
				? '/etc/init.d/rpcd restart'
				: '/etc/init.d/appflowd enable\n/etc/init.d/appflowd start'
			]),
			denied ? '' : E('p', { 'class': 'af-sub' }, [
				_('AppFlow also needs the Netify Agent running (%s), since that is where the per-application classification comes from.').format('/etc/init.d/netifyd status')
			]),
			detail ? E('p', { 'class': 'af-sub af-mono' }, [ String(detail) ]) : ''
		]);
	},

	pill: function(text, cls) {
		return E('span', { 'class': 'af-pill' + (cls ? ' ' + cls : '') }, [
			cls ? E('i', {}) : '', text
		]);
	},

	/*
	 * Thin status strip above the cards. `status` is either the full
	 * appflow.status payload (Overview) or any response envelope, which always
	 * carries generated_at + agent_connected per §5.
	 */
	statusStrip: function(status, extra) {
		var s = status || {},
		    sock = s.socket || {},
		    flows = s.flows || {},
		    counts = s.aggregates || s.counts || {},
		    agent = s.agent || {},
		    connected = (s.agent_connected !== false) && (sock.connected !== false),
		    bits = [ this.pill(connected
			? _('Netify agent connected')
			: _('Netify agent disconnected'), connected ? 'af-ok' : 'af-warn') ];

		if (flows.tracked != null)
			bits.push(this.pill(_('Flows tracked: %d').format(this.num(flows, [ 'tracked' ]))));

		if (counts.apps != null || counts.devices != null)
			bits.push(this.pill(_('%d apps, %d devices').format(
				this.num(counts, [ 'apps' ]), this.num(counts, [ 'devices' ]))));

		if (s.uptime != null)
			bits.push(this.pill(_('Collector uptime: %s').format(this.fmtUptime(s.uptime))));

		if (agent.version)
			bits.push(this.pill(_('netifyd %s').format(String(agent.version))));

		(extra || []).forEach(function(e) {
			if (e)
				bits.push(e);
		});

		return E('div', { 'class': 'af-strip' }, bits);
	},

	/* ---------------------------------------------------------------- css */

	injectCSS: function() {
		if (document.getElementById(STYLE_ID))
			return;

		document.head.appendChild(E('style', {
			'id': STYLE_ID,
			'type': 'text/css'
		}, [ CSS ]));
	}
});
