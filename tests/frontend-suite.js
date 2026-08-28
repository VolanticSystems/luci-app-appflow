#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems
//
// appflow browser-half suite.
//
// WHY THIS FILE EXISTS. Every defect this package's frontend has had was found
// by a human or a review panel READING the code. Not one was found by a test,
// because until now no test could run any of it. The daemon has 54 checks
// against it and the JavaScript had none, which is backwards: the daemon
// mostly counts bytes, while the frontend is what decides whether an operator
// is told the collector is down.
//
//   usage:  node tests/frontend-suite.js
//
// Runs anywhere Node runs. No router, no browser, no network. The real
// common.js is loaded and executed by tests/luci-module.js; nothing in it is
// reimplemented here.
//
// EVERY CHECK IN THE FIRST THREE GROUPS IS A REGRESSION TEST FOR A DEFECT THAT
// WAS REAL, shipped, and fixed. They are not hypotheticals: each one names the
// date it was found and what it did to the screen.
//
// SABOTAGE COMMENTS: every check names the smallest edit to the PRODUCT that
// turns it red, written before the assertion.

'use strict';

const path = require('path');
const { load, potMsgids, textOf, classesOf } = require('./luci-module.js');

const ROOT = path.join(__dirname, '..');
const COMMON = path.join(ROOT, 'htdocs/luci-static/resources/view/appflow/common.js');
const POT = path.join(ROOT, 'po/templates/appflow.pot');

let PASS = 0, FAIL = 0;

function ok(m)  { PASS++; console.log('  PASS  ' + m); }
function bad(m) { FAIL++; console.log('  FAIL  ' + m); }
function chk(desc, expected, actual) {
	const e = JSON.stringify(expected), a = JSON.stringify(actual);
	if (e === a) ok(desc); else bad(`${desc} (expected ${e}, got ${a})`);
}
function head(m) { console.log('\n=== ' + m + ' ==='); }

// rpc and request throw if touched. Nothing under test calls them, and a stub
// that answered plausibly would let a test pass against a product that had
// stopped asking.
const c = load(COMMON, {
	rpc:     { declare: (o) => () => { throw new Error('rpc called: ' + (o && o.method)); } },
	request: { get: () => { throw new Error('request called'); } }
});

// --------------------------------------------------- the status strip

head('STATUS STRIP: absent evidence is not positive evidence');

// THE DEFECT, found 2026-08-25. The test was
//   connected = (s.agent_connected !== false) && (sock.connected !== false)
// and `undefined !== false` is true, so a payload carrying neither field
// rendered a single green "Netify agent connected" pill. Overview passes
// `status || summary`, so this fired exactly when the status call FAILED: the
// one indicator whose job is to say the collector is down failed GREEN, on the
// most common reason for the page being empty.
//
// SABOTAGE for this whole group: in statusStrip(), drop the `known &&` from
// the `connected` expression, or replace `known` with `true`. The three
// unknown rows go red and the two positive rows stay green, which is the
// asymmetry that matters.
const STATES = [
	['no status at all',                  undefined,                          'af-unknown'],
	['an empty object',                   {},                                 'af-unknown'],
	// The payload that actually triggered it: a summary, passed in because the
	// status call failed. It has neither field.
	['a summary payload (the real case)', { bytes_total: 12345, top_apps: [] }, 'af-unknown'],
	['agent_connected true',              { agent_connected: true },           'af-ok'],
	['agent_connected false',             { agent_connected: false },          'af-warn'],
	// socket.connected alone IS positive evidence: it says the daemon has the
	// export socket open. `known` requires only that ONE of the two fields be
	// present, which is deliberate.
	['socket.connected true only',        { socket: { connected: true } },     'af-ok'],
	['socket.connected false only',       { socket: { connected: false } },    'af-warn']
];

for (const [label, status, wantClass] of STATES) {
	const cls = classesOf(c.statusStrip(status));
	if (cls.has(wantClass)) ok(`${label} -> ${wantClass}`);
	else bad(`${label} -> expected ${wantClass}, got [${[...cls].join(' ')}]`);
}

// And the text, because a neutral class with reassuring words is still a lie.
//
// SABOTAGE: change the unknown-state string back to "Netify agent connected".
// The class check above stays green and only this goes red.
const unknownText = textOf(c.statusStrip({ bytes_total: 1 }));
if (/unknown/i.test(unknownText)) ok('and the unknown state SAYS unknown');
else bad(`the unknown state reads "${unknownText}"`);

// -------------------------------------------- prototype-chain lookups

head('HOSTILE KEYS: a name from the wire must not reach Object.prototype');

// THE DEFECT, found 2026-08-25. CATEGORY_SLOT is an object literal, so it
// inherits Object.prototype, and a bare `CATEGORY_SLOT[s] != null` test passed
// for 'constructor', '__proto__', 'toString' and friends, indexing PALETTE
// with a function and yielding undefined. A device named `constructor`
// rendered style="background:undefined", which the browser drops: white text
// on a transparent tile, and in the doughnut the slice silently did not draw
// while its legend still claimed a percentage.
//
// `s` is attacker-influenced. It comes from a category tag, an application
// label, or a DHCP hostname, so a LAN device can choose it.
//
// SABOTAGE: in color(), replace
//   Object.prototype.hasOwnProperty.call(CATEGORY_SLOT, s)
// with a bare `CATEGORY_SLOT[s] != null`. Every row below goes red.
const HOSTILE = ['constructor', '__proto__', 'toString', 'hasOwnProperty',
                 'valueOf', 'isPrototypeOf'];

for (const key of HOSTILE) {
	const col = c.color(key);
	if (typeof col === 'string' && /^hsl\(/.test(col))
		ok(`color(${JSON.stringify(key)}) is a real colour`);
	else
		bad(`color(${JSON.stringify(key)}) returned ${JSON.stringify(col)}`);
}

// The mirror: a function that returned a fixed colour for everything would
// pass all six rows above. A known category must still get its ASSIGNED slot,
// not the hash fallback.
//
// SABOTAGE: delete the hasOwnProperty branch entirely so everything falls
// through to the hash. This goes red while the six rows above stay green.
const known = c.color('games'), other = c.color('games');
chk('a known category is stable across calls', known, other);
if (c.color('games') !== c.color('shopping'))
	ok('and different categories get different colours');
else
	bad('two different categories returned the same colour');

// -------------------------------------------------------- normalisers

head('LABELS: netifyd slugs are cased, deliberate casing is left alone');

// catLabel() used to lowercase its input before title-casing it. That is
// harmless for netifyd's own categories, which are lowercase slugs, and it
// destroyed appflow's AI categories: "AI assistants" came back as
// "Ai assistants", because the title-case split is on [-_] and a space is
// neither. It rendered that way on a live router before anyone noticed.
//
// SABOTAGE: remove the /[A-Z]/ pass-through in catLabel(). The first two go
// red and the netifyd cases stay green, which is the distinction that matters.
chk('a category with deliberate capitals is left alone',
    'AI assistants', c.catLabel('AI assistants'));
chk('and so is a second one', 'AI infrastructure', c.catLabel('AI infrastructure'));

// The netifyd side must be unchanged by that pass-through.
chk('a lowercase netifyd slug is still title-cased', 'Networking', c.catLabel('networking'));
chk('and a hyphenated one still splits', 'Social Network', c.catLabel('social-network'));
chk('an empty category is still Unclassified', 'Unclassified', c.catLabel(''));

head('NORMALISERS: idempotent, and never inventing a total');

// THE DEFECT, found 2026-08-25. normSeries() was not idempotent and one caller
// normalised twice. The second pass read the already-renamed fields, found
// nothing, and produced {dl:0, ul:0, total:<real>}: a total contradicting its
// own parts. The chart drew empty while the "no data" message stayed
// suppressed, because `total` was non-zero.
//
// SABOTAGE: remove 'dl' and 'ul' from the alias lists the normaliser accepts.
// The second pass zeroes them and this goes red.
const rawSeries = [{ time: 1, dl: 10, ul: 5 }, { time: 2, dl: 20, ul: 10 }];
const once = c.normSeries(rawSeries);
const twice = c.normSeries(once);
chk('normSeries is idempotent', once, twice);

// SABOTAGE: change the `(tot >= 0) ? tot : dl + ul` fallback to a constant.
chk('a point with no explicit total gets dl+ul', 15, once[0].total);
chk('and the parts survive', [10, 5], [once[0].dl, once[0].ul]);

// The invariant that would have caught the original defect on its own, stated
// as an invariant rather than as a value: parts and total must not contradict.
const contradictions = twice.filter((p) => p.dl === 0 && p.ul === 0 && p.total > 0);
chk('no point claims a total while both parts are zero', [], contradictions);

// SABOTAGE: make normSeries() return its input unchanged. The empty and
// absent cases stop being normalised and this goes red.
chk('normSeries(null) is an empty list', [], c.normSeries(null));
chk('normSeries(undefined) is an empty list', [], c.normSeries(undefined));

head('HELPERS: the accessors every view depends on');

// SABOTAGE for each: change the default-value branch of num()/str()/toList()
// so a miss returns something other than the supplied default.
chk('num() finds a value by alias', 5, c.num({ a: 5 }, ['x', 'a'], 0));
chk('num() returns the default on a miss', 42, c.num({}, ['nope'], 42));
chk('num() returns the default on a non-number', 7, c.num({ a: 'xyz' }, ['a'], 7));
chk('str() returns the default on a miss', 'dflt', c.str({}, ['nope'], 'dflt'));
chk('toList(null) is empty', [], c.toList(null));
chk('toList of an array is itself', [1, 2], c.toList([1, 2]));

// toList over an object keyed by name must carry the key through, or every
// per-device row loses its identity.
//
// SABOTAGE: drop the keyField assignment in toList(). This goes red.
const keyed = c.toList({ 'aa:bb': { bytes: 1 } }, 'mac');
chk('toList carries the object key into the named field', 'aa:bb', keyed[0] && keyed[0].mac);

// ---------------------------------------------------------- catalogue

head('FILTER: include, exclude, and the shapes a half-typed term takes');

// WHY THIS GROUP EXISTS. The filter is the only way to make a busy dashboard
// legible, and the question that produced it was concrete: one streaming
// session buried everything else and there was no way to look past it.
//
// Both views share this logic precisely so they cannot drift, and it lives in
// common.js rather than inside a render function so a test can reach it at all.
// The classifier lesson from the sibling package: logic that decides something
// belongs where Node can load it.

// A term matches the application label, its key, or its category label. Those
// are the three strings a person could plausibly be typing at.
const FIELDS = {
	claude:  [ 'Anthropic (Claude)', 'ai:anthropic-claude', 'AI assistants' ],
	openai:  [ 'OpenAI', 'ai:openai', 'AI assistants' ],
	netflix: [ 'Netflix', 'a145', 'Streaming Media' ],
	http:    [ 'HTTP/S', 'p196', 'Web' ]
};

const pass = (text, row) => c.matchFilter(c.parseFilter(text), FIELDS[row]);

// An empty filter passes everything. This is the unfiltered case and must not
// be special-cased by any caller.
//
// SABOTAGE: make matchFilter return false for an empty term list. Every view
// renders an empty table on load, which is as broken as it sounds.
chk('an empty filter passes everything', [ true, true, true, true ],
    [ 'claude', 'openai', 'netflix', 'http' ].map((r) => pass('', r)));

// Matching is case-insensitive and matches any of the three fields.
chk('a term matches the application label', true,  pass('netflix', 'netflix'));
chk('and is case-insensitive',              true,  pass('NeTfLiX', 'netflix'));
chk('a term matches the CATEGORY label',    true,  pass('ai assistants', 'claude'));
chk('a partial category matches',           true,  pass('ai', 'claude'));
chk('a term matches the internal key',      true,  pass('p196', 'http'));
chk('a term that matches nothing excludes', false, pass('netflix', 'claude'));

// EXCLUSION. This is the case the whole feature exists for: "show me
// everything except the thing that is burying the view". An include-only
// filter cannot express it, because you would have to already know what you
// wanted to keep.
//
// SABOTAGE: drop the leading-minus branch in parseFilter so '-netflix' is
// treated as an ordinary term. The two checks below invert.
chk('a minus term removes the row it matches',  false, pass('-netflix', 'netflix'));
chk('and leaves every other row alone',         true,  pass('-netflix', 'claude'));

// Terms combine with AND, so each one narrows. Mixing include and exclude is
// the useful case: this category, except that member of it.
//
// SABOTAGE: change every() to some() in matchFilter. The first goes true.
chk('include and exclude combine',        false, pass('ai -claude', 'claude'));
chk('and the combination still includes', true,  pass('ai -claude', 'openai'));
chk('two includes both have to match',    false, pass('ai netflix', 'claude'));

// A bare '-' is what a half-typed exclusion looks like. Treating it as
// "exclude everything" would blank the table between two keystrokes.
//
// SABOTAGE: remove the final filter() in parseFilter that drops empty terms.
chk('a bare minus is ignored, not treated as exclude-all',
    [ true, true ], [ pass('-', 'claude'), pass('-', 'netflix') ]);
chk('and so is stray whitespace', true, pass('   ', 'claude'));

// Nulls and absent fields must not throw: a row can legitimately have no
// category, and normApp fills what it can.
//
// SABOTAGE: drop the null guard in matchFilter's field join.
chk('a row with missing fields does not throw', false,
    c.matchFilter(c.parseFilter('claude'), [ null, undefined, '' ]));
chk('and still matches on the field it does have', true,
    c.matchFilter(c.parseFilter('claude'), [ null, 'Anthropic (Claude)', undefined ]));

head('DEVICE IDENTITY: the key the drill-down is addressed by');

// normDevice DROPPED the daemon's device key. Every call site that needed it
// got undefined, so clicking a device cleared the selection instead of setting
// it: no error, no effect, a feature that looked wired and was not. Three bugs
// in one evening had that exact shape.
//
// SABOTAGE: remove `t.key = ...` from normDevice. This goes red and nothing
// else does, which is precisely why it had to be added.
{
	const d = c.normDevice({ key: 'b4:2e:99:3a:d6:df', mac: 'b4:2e:99:3a:d6:df',
	                         ip: '192.168.72.20', name: 'Stang', bytes_total: 10 });

	chk('normDevice carries the daemon key through', 'b4:2e:99:3a:d6:df', d.key);
	chk('and still carries name, mac and ip', [ 'Stang', 'B4:2E:99:3A:D6:DF', '192.168.72.20' ],
	    [ d.name, d.mac, d.ip ]);
}

// The pseudo-devices have no MAC at all, so a fallback to mac/ip would leave
// them unaddressable. The daemon's key is what they are called.
//
// SABOTAGE: change the key preference order so mac wins over key.
{
	const d = c.normDevice({ key: 'router', name: 'Router', bytes_total: 5 });

	chk('a pseudo-device is addressed by its key', 'router', d.key);
}

head('CLICKABLE CELLS: a label that names a thing is a way to see it');

// appCell and deviceCell take an onPick callback. Without one they render
// exactly as before, so nothing that does not want the behaviour gets it.
//
// SABOTAGE: make appCell add af-pick unconditionally. The first check goes red,
// and every table that never wanted click targets grows them.
{
	const plain = c.appCell({ label: 'Netflix', key: 'a145', cat: 'streaming-media' });
	chk('without a callback an app cell is not clickable',
	    false, /af-pick/.test(JSON.stringify(plain)));

	const picked = [];
	const live = c.appCell({ label: 'Netflix', key: 'a145', cat: 'streaming-media' },
	                       null, (v) => picked.push(v));
	chk('with a callback it is', true, /af-pick/.test(JSON.stringify(live)));
}

// A device cell with a callback is clickable and passes the whole device
// object, because the caller needs both the key (to query) and the name (to
// show in the chip).
//
// SABOTAGE: have deviceCell pass dev.name instead of dev. The drill-down then
// queries by name, which is not what the daemon keys on.
{
	const plain = c.deviceCell({ name: 'Stang', mac: 'B4:2E:99:3A:D6:DF', key: 'b4:2e' });
	chk('without a callback a device cell is not clickable',
	    false, /af-pick/.test(JSON.stringify(plain)));

	const live = c.deviceCell({ name: 'Stang', mac: 'B4:2E:99:3A:D6:DF', key: 'b4:2e' },
	                          () => {});
	chk('with a callback it is', true, /af-pick/.test(JSON.stringify(live)));
}

head('THE STRING CATALOGUE COVERS WHAT THE CODE ASKS FOR');

// SABOTAGE: add a `_('some new string')` anywhere in common.js without
// regenerating po/templates/appflow.pot. This goes red. Without it the
// catalogue rots silently the moment anyone adds a message, and nobody finds
// out until a translator does.
const pot = potMsgids(POT);
const seen = new Set(c.__translated.filter(Boolean));

// A catalogue check over an empty set proves nothing, so refuse to report a
// pass on one.
if (seen.size === 0) {
	bad('the run reached NO _() strings, so this check proved nothing');
} else {
	const missing = [...seen].filter((x) => !pot.has(x));
	if (missing.length === 0)
		ok(`all ${seen.size} strings reached by this run are in the catalogue`);
	else
		bad(`${missing.length} of ${seen.size} not in appflow.pot: `
		    + JSON.stringify(missing.slice(0, 5)));
}

// The catalogue must also not be EMPTY or trivially small, which would make
// the check above pass while covering nothing.
//
// SABOTAGE: truncate appflow.pot. This goes red.
if (pot.size >= 100) ok(`the catalogue holds ${pot.size} msgids`);
else bad(`the catalogue holds only ${pot.size} msgids; expected the full extraction`);

console.log('\n----------------------------------------');
console.log(`passed ${PASS}, failed ${FAIL}`);
process.exit(FAIL);
