'use strict';
'require view';
'require dom';
'require poll';
'require view.appflow.common as appflow';

/*
 * AppFlow: Overview (live).
 *
 * DESIGN.md §4 item 1. This is the tab GL has no equivalent of: live total
 * throughput, the applications currently moving traffic, the category split
 * and the busiest devices, refreshed every 5 s from ubus appflow.summary /
 * appflow.devices / appflow.status.
 *
 * The chart window is kept client-side only: SLOTS samples at INTERVAL
 * seconds, i.e. a rolling five minutes that starts over on page load. The
 * daemon is not asked to remember anything for it.
 */

var INTERVAL = 5,
    SLOTS = 60,
    TOP_APPS = 8,
    TOP_DEVICES = 8,
    TOP_CATEGORIES = 6;

function head(cells) {
	return E('tr', { 'class': 'tr table-titles' }, cells.map(function(c) {
		return E('th', { 'class': 'th' + (c[1] ? ' ' + c[1] : '') }, [ c[0] ]);
	}));
}

return view.extend({
	samples: [],
	fails: 0,
	painted: false,

	fetch: function() {
		return Promise.all([
			L.resolveDefault(appflow.rpc.summary(), null),
			L.resolveDefault(appflow.rpc.devices(), null),
			L.resolveDefault(appflow.rpc.status(), null)
		]).then(function(r) {
			return { summary: r[0], devices: r[1], status: r[2] };
		});
	},

	load: function() {
		/* the icon pack is optional; loadIcons() resolves either way */
		return Promise.all([ appflow.loadIcons(), this.fetch() ])
			.then(function(r) { return r[1]; });
	},

	/* ------------------------------------------------------------ render */

	render: function(data) {
		appflow.injectCSS();

		this.nodes = {
			strip: E('div'),
			window: E('span'),
			kpi: E('div', { 'class': 'af-kpi' }),
			chart: E('div'),
			apps: E('div'),
			cats: E('div'),
			devs: E('div')
		};

		var n = this.nodes;

		this.liveNode = E('div', {}, [
			n.strip,
			appflow.card(_('Live throughput'), [
				n.window,
				_('%d minute chart, %d second interval').format(SLOTS * INTERVAL / 60, INTERVAL)
			], E('div', {}, [ n.kpi, n.chart ])),
			E('div', { 'class': 'af-grid af-split' }, [
				appflow.card(_('Top applications'), [ _('by current rate') ], n.apps),
				appflow.card(_('Categories'), [ _('top, by cumulative bytes') ], n.cats)
			]),
			appflow.card(_('Top devices'), [ _('top, by cumulative bytes') ], n.devs)
		]);

		this.downNode = E('div', { 'style': 'display:none' }, [ appflow.notRunning() ]);

		this.paint(data);

		poll.add(L.bind(function() {
			return this.fetch().then(L.bind(this.paint, this));
		}, this), INTERVAL);

		return E([], [
			E('h2', {}, [ _('AppFlow') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Live per-application traffic, classified on the router by the Netify Agent. Nothing on this page leaves the device.')
			]),
			this.liveNode,
			this.downNode
		]);
	},

	/* ------------------------------------------------------------- paint */

	paint: function(data) {
		var summary = data ? data.summary : null,
		    status = data ? data.status : null;

		if (summary == null) {
			this.fails++;

			/* One miss on a live page is usually a blip; only fall back to the
			 * "not running" screen once it is clearly not coming back. */
			if (this.fails >= (this.painted ? 2 : 1))
				return this.showDown();

			return;
		}

		this.fails = 0;
		this.painted = true;
		this.liveNode.style.display = '';
		this.downNode.style.display = 'none';

		/* live aggregates carry byte and rate counters in one object; a future
		 * split into totals/rates is handled by normRates */
		var totals = appflow.normTotals(summary.totals || summary),
		    rates = summary.rates ? appflow.normRates(summary.rates) : totals;

		this.samples.push({ dl: rates.rdl, ul: rates.rul });

		while (this.samples.length > SLOTS)
			this.samples.shift();

		var stamp = summary.generated_at || (status ? status.generated_at : 0);

		dom.content(this.nodes.strip, appflow.statusStrip(status || summary, [
			stamp ? E('span', { 'class': 'af-pill' }, [
				_('Updated %s').format(appflow.fmtAgo(stamp))
			]) : null
		]));

		dom.content(this.nodes.window, [ summary.window
			? _('%d s rate window').format(appflow.num(summary, [ 'window' ]))
			: '' ]);

		this.paintThroughput(totals, rates);
		this.paintApps(summary);
		this.paintCategories(summary);
		this.paintDevices(data.devices, summary);
	},

	showDown: function() {
		this.samples = [];
		this.liveNode.style.display = 'none';
		this.downNode.style.display = '';
	},

	/* ---------------------------------------------------------- sections */

	paintThroughput: function(totals, rates) {
		dom.content(this.nodes.kpi, [
			appflow.kpi(_('Download'), appflow.fmtRate(rates.rdl), 'af-dlc'),
			appflow.kpi(_('Upload'), appflow.fmtRate(rates.rul), 'af-ulc'),
			appflow.kpi(_('Downloaded'), appflow.fmtBytes(totals.dl)),
			appflow.kpi(_('Uploaded'), appflow.fmtBytes(totals.ul))
		]);

		if (this.samples.length < 2) {
			dom.content(this.nodes.chart, appflow.placeholder(
				_('Collecting samples…')));
			return;
		}

		dom.content(this.nodes.chart, [
			appflow.lineChart([
				{ values: this.samples.map(function(s) { return s.dl; }),
				  cls: 'af-dl', fill: true },
				{ values: this.samples.map(function(s) { return s.ul; }),
				  cls: 'af-ul', fill: true }
			], {
				slots: SLOTS,
				height: 170,
				fmt: function(v) { return appflow.fmtRate(v); },
				xlabels: [ _('-%d min').format(SLOTS * INTERVAL / 60), _('now') ]
			}),
			appflow.swatches(appflow.fmtRate(this.samples[this.samples.length - 1].dl),
			                 appflow.fmtRate(this.samples[this.samples.length - 1].ul))
		]);
	},

	paintApps: function(summary) {
		var apps = appflow.toList(summary.top_apps || summary.apps)
			.map(function(a) { return appflow.normApp(a); })
			.sort(function(a, b) { return b.rate - a.rate; })
			.slice(0, TOP_APPS);

		if (!apps.length) {
			dom.content(this.nodes.apps, appflow.placeholder(
				_('No application traffic in the current window.')));
			return;
		}

		var peak = apps[0].rate || 1;

		dom.content(this.nodes.apps, E('table', { 'class': 'table af-table' }, [
			head([
				[ _('Application') ],
				[ '' ],
				[ _('Download'), 'af-num' ],
				[ _('Upload'), 'af-num' ]
			])
		].concat(apps.map(function(a) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, [ appflow.appCell(a) ]),
				E('td', { 'class': 'td', 'style': 'width:26%' }, [
					appflow.bar(a.rdl, a.rul, peak)
				]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtRate(a.rdl) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtRate(a.rul) ])
			]);
		}))));
	},

	paintCategories: function(summary) {
		var cats = appflow.toList(summary.top_categories || summary.categories, 'category')
			.map(function(c) {
				var t = appflow.normTotals(c);

				return {
					label: appflow.catLabel(appflow.str(c,
						[ 'category', 'category_name', 'cat', 'key', 'name', 'label' ])),
					key: appflow.str(c,
						[ 'category', 'category_name', 'cat', 'key', 'name', 'label' ]),
					value: t.total || t.rate
				};
			})
			.filter(function(c) { return c.value > 0; })
			.sort(function(a, b) { return b.value - a.value; });

		if (!cats.length) {
			dom.content(this.nodes.cats, appflow.placeholder(_('No categories yet.')));
			return;
		}

		var slices = cats.slice(0, TOP_CATEGORIES).map(function(c) {
			return { label: c.label, value: c.value, color: appflow.color(c.key) };
		});

		if (cats.length > TOP_CATEGORIES) {
			var rest = cats.slice(TOP_CATEGORIES).reduce(function(a, c) {
				return a + c.value;
			}, 0);

			if (rest > 0)
				slices.push({ label: _('Other'), value: rest, color: appflow.color('other') });
		}

		dom.content(this.nodes.cats, appflow.donut(slices, {
			centerLabel: _('total')
		}));
	},

	paintDevices: function(devices, summary) {
		var list = appflow.toList(
			(devices && (devices.devices || devices.clients)) || devices || summary.top_devices,
			'mac');

		var devs = list
			.map(function(d) { return appflow.normDevice(d); })
			.filter(function(d) { return d.total > 0 || d.rate > 0; })
			.sort(function(a, b) { return (b.rate - a.rate) || (b.total - a.total); })
			.slice(0, TOP_DEVICES);

		if (!devs.length) {
			dom.content(this.nodes.devs, appflow.placeholder(_('No active devices.')));
			return;
		}

		var peak = devs.reduce(function(m, d) {
			return Math.max(m, d.total);
		}, 0) || 1;

		dom.content(this.nodes.devs, E('table', { 'class': 'table af-table' }, [
			head([
				[ _('Device') ],
				[ '' ],
				[ _('Current rate'), 'af-num' ],
				[ _('Downloaded'), 'af-num' ],
				[ _('Uploaded'), 'af-num' ]
			])
		].concat(devs.map(function(d) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'style': 'width:32%' }, [ appflow.deviceCell(d) ]),
				E('td', { 'class': 'td', 'style': 'width:26%' }, [
					appflow.bar(d.dl, d.ul, peak)
				]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtRate(d.rate) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(d.dl) ]),
				E('td', { 'class': 'td af-num' }, [ appflow.fmtBytes(d.ul) ])
			]);
		}))));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
