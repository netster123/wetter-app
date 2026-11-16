import * as maplibregl from './vendor/maplibre/maplibre-gl.mjs';
import * as OM from './vendor/om/index.mjs';

/* ------------------------------------------------------------------ *
 *  Datenquellen (alle kostenlos, ohne API-Schlüssel)
 *  - Punktvorhersage: Open-Meteo "best match" (wählt je Ort das beste
 *    Modell, in Mitteleuropa DWD ICON-D2 mit ~2 km Auflösung)
 *  - Kartenebenen:    Open-Meteo-Modelldaten (DWD ICON seamless),
 *    im Browser direkt aus den Modell-Dateien gerendert
 *  - Satellitenbild:  Esri World Imagery
 *  - Straßen/Häuser:  OpenFreeMap (OpenStreetMap-Daten)
 *  - Gelände:         Mapterhorn
 * ------------------------------------------------------------------ */
// Open-Meteos eigener Datenserver ist deutlich schneller (HTTP/2, näher), nimmt
// aber nur Anfragen von localhost an; sonst der öffentliche S3-Speicher.
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const SPATIAL = IS_LOCAL ? 'https://data-spatial.open-meteo.com/data_spatial' : 'https://openmeteo.s3.amazonaws.com/data_spatial';
const BASE_DOMAIN = 'dwd_icon'; // liefert Modelllauf und Zeitschritte
const MAP_DOMAIN = 'dwd_icon_seamless'; // ICON-D2 → ICON-EU → ICON global
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_API = 'https://nominatim.openstreetmap.org/reverse';

const LAYERS = {
	temp: { variable: 'temperature_2m', opacity: 0.6 },
	wind: { variable: 'wind_u_component_10m', opacity: 0.65, arrows: true },
	clouds: { variable: 'cloud_cover', opacity: 0.85 },
	rain: { variable: 'precipitation', opacity: 0.9 }
};

const LEGENDS = {
	rain: {
		label: 'Regen (mm pro Stunde)',
		css: 'linear-gradient(90deg,rgba(133,204,250,.4),#71b8fa 12%,#0000ff 28%,#0a940a 42%,#c5ec03 58%,#ffcc00 72%,#ff8800 86%,#ff0000)',
		scale: ['0,1', '1', '3', '8', '30']
	},
	clouds: {
		label: 'Bewölkung',
		css: 'linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.95))',
		scale: ['0 %', '50 %', '100 %']
	},
	wind: {
		label: 'Wind (km/h)',
		css: 'linear-gradient(90deg,rgba(70,130,180,.1),#149d64 10%,#008000 17%,#6ab600 26%,#d3db00 33%,#ffa500 40%,#ff0000 60%,#800080 83%,#740505)',
		scale: ['0', '25', '50', '75', '110']
	},
	temp: {
		label: 'Temperatur (°C)',
		css: 'linear-gradient(90deg,#4703f9,#0034ff 17%,#86c5f5 30%,#72e8a5 33%,#09bf24 47%,#008000 53%,#ffff00 67%,#ffa500 83%,#ff0000)',
		scale: ['-20', '-10', '0', '10', '20', '30', '40']
	}
};

/* WMO-Wettercodes → Text + Symbol (Tag/Nacht) */
const WMO = {
	0: ['Klar', '☀️', '🌙'],
	1: ['Überwiegend klar', '🌤️', '🌙'],
	2: ['Teils bewölkt', '⛅', '☁️'],
	3: ['Bedeckt', '☁️', '☁️'],
	45: ['Nebel', '🌫️'],
	48: ['Reifnebel', '🌫️'],
	51: ['Leichter Nieselregen', '🌦️', '🌧️'],
	53: ['Nieselregen', '🌦️', '🌧️'],
	55: ['Starker Nieselregen', '🌧️'],
	56: ['Gefrierender Nieselregen', '🌧️'],
	57: ['Gefrierender Nieselregen', '🌧️'],
	61: ['Leichter Regen', '🌦️', '🌧️'],
	63: ['Regen', '🌧️'],
	65: ['Starker Regen', '🌧️'],
	66: ['Gefrierender Regen', '🌧️'],
	67: ['Gefrierender Regen', '🌧️'],
	71: ['Leichter Schneefall', '🌨️'],
	73: ['Schneefall', '🌨️'],
	75: ['Starker Schneefall', '❄️'],
	77: ['Schneegriesel', '🌨️'],
	80: ['Leichte Regenschauer', '🌦️', '🌧️'],
	81: ['Regenschauer', '🌧️'],
	82: ['Heftige Regenschauer', '🌧️'],
	85: ['Schneeschauer', '🌨️'],
	86: ['Starke Schneeschauer', '❄️'],
	95: ['Gewitter', '⛈️'],
	96: ['Gewitter mit Hagel', '⛈️'],
	99: ['Schweres Gewitter mit Hagel', '⛈️']
};
const wmo = (code, isDay = 1) => {
	const w = WMO[code] || ['–', '❔'];
	return { text: w[0], icon: isDay ? w[1] : w[2] || w[1] };
};

const $ = (id) => document.getElementById(id);
const num = (v, digits = 0) =>
	v == null || Number.isNaN(v)
		? '–'
		: v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];

/* ------------------------------------------------------------------ *
 *  Zustand
 * ------------------------------------------------------------------ */
const state = {
	meta: null, // { reference_time, valid_times }
	steps: [], // Zeitschritte der Karte, wie sie im Dateinamen stehen
	times: [], // dieselben Zeitschritte als epoch ms
	timeIndex: 0,
	enabled: new Set(['rain', 'clouds']),
	target: 0, // Zeitschritt, den die Karte zeigen soll
	pos: 0, // Wiedergabeposition (Zeitschritt mit Nachkommaanteil)
	playing: false,
	dir: 1, // Laufrichtung der Wiedergabe: 1 vorwärts, -1 rückwärts
	speed: 1, // Spul-Faktor
	rolling: false, // Wiedergabe läuft (genug gepuffert)
	rate: 0, // aktuelles Wiedergabetempo, 0…1
	insideD2: false, // Kartenausschnitt liegt ganz im ICON-D2-Gebiet
	waiting: false,
	seq: 0,
	tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
	point: null,
	marker: null,
	forecastReq: 0,
	ready: false // Kartenstil geladen
};

/* ------------------------------------------------------------------ *
 *  Karte
 * ------------------------------------------------------------------ */
const settings = OM.defaultOmProtocolSettings;
// Geladene Datenblöcke im Browser-Cache behalten: einmal gesehene Bilder
// (z. B. beim zweiten Durchlauf der Wiedergabe) kommen dann ohne Netz.
try {
	settings.fileReaderConfig = { ...settings.fileReaderConfig, cache: new OM.BrowserBlockCache({ cacheName: 'wetter-om-cache', maxBytes: 400e6 }) };
} catch (err) {
	console.warn('Browser-Cache nicht verfügbar, nutze Arbeitsspeicher', err);
}
settings.maxStatesWithData = 18; // Puffer der Wiedergabe: Ebenen × vorgeladene Bilder
settings.colorScales = {
	...(settings.colorScales || OM.COLOR_SCALES || {}),
	// reines Weiß, damit Wolken über dem Satellitenbild wie Wolken aussehen
	cloud_cover: {
		type: 'breakpoint',
		unit: '%',
		breakpoints: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
		colors: [0, 0.06, 0.14, 0.24, 0.34, 0.45, 0.56, 0.67, 0.78, 0.88, 0.95].map((a) => [255, 255, 255, a])
	}
};
maplibregl.addProtocol('om', (params, abort) => OM.omProtocol(params, abort, settings));

const NAME = ['coalesce', ['get', 'name:de'], ['get', 'name']];
const anchor = (id) => ({ id, type: 'background', layout: { visibility: 'none' } });
const LABEL_LAYERS = ['roads-minor', 'roads-major', 'boundaries', 'street-names', 'house-numbers', 'places-small', 'places-big'];

const style = {
	version: 8,
	projection: { type: 'globe' },
	glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
	sky: {
		'sky-color': '#5b9bd9',
		'horizon-color': '#cfe4f7',
		'sky-horizon-blend': 0.6,
		'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
	},
	sources: {
		sat: {
			type: 'raster',
			tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
			tileSize: 256,
			maxzoom: 19,
			attribution: 'Satellitenbild © Esri, Maxar, Earthstar Geographics'
		},
		osm: {
			type: 'vector',
			url: 'https://tiles.openfreemap.org/planet',
			attribution: '© OpenStreetMap · OpenFreeMap'
		},
		dem: {
			type: 'raster-dem',
			tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
			encoding: 'terrarium',
			tileSize: 512,
			maxzoom: 12,
			attribution: '© Mapterhorn'
		}
	},
	layers: [
		{ id: 'bg', type: 'background', paint: { 'background-color': '#05080f' } },
		{ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } },
		// Wetterebenen werden jeweils unter ihrem Anker eingefügt
		anchor('anchor-temp'),
		anchor('anchor-wind'),
		anchor('anchor-clouds'),
		anchor('anchor-rain'),
		{
			id: 'roads-minor',
			type: 'line',
			source: 'osm',
			'source-layer': 'transportation',
			minzoom: 12,
			filter: ['in', ['get', 'class'], ['literal', ['tertiary', 'minor', 'service']]],
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: {
				'line-color': '#ffffff',
				'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.15, 16, 0.35],
				'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.5, 18, 6]
			}
		},
		{
			id: 'roads-major',
			type: 'line',
			source: 'osm',
			'source-layer': 'transportation',
			minzoom: 7,
			filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: {
				'line-color': ['match', ['get', 'class'], 'motorway', '#ffd27a', 'trunk', '#ffe2a8', '#ffffff'],
				'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.35, 16, 0.5],
				'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 7, 0.6, 12, 1.6, 18, 10]
			}
		},
		{
			id: 'boundaries',
			type: 'line',
			source: 'osm',
			'source-layer': 'boundary',
			filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
			paint: {
				'line-color': '#ffffff',
				'line-opacity': ['match', ['get', 'admin_level'], 2, 0.75, 0.35],
				'line-width': ['match', ['get', 'admin_level'], 2, 1.2, 0.7]
			}
		},
		{
			id: 'buildings-3d',
			type: 'fill-extrusion',
			source: 'osm',
			'source-layer': 'building',
			minzoom: 14.5,
			paint: {
				'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#e8e4dc', 40, '#cfd6e0', 150, '#aebbd0'],
				'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, ['coalesce', ['get', 'render_height'], 6]],
				'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
				'fill-extrusion-opacity': 0.82
			}
		},
		anchor('anchor-top'),
		{
			id: 'street-names',
			type: 'symbol',
			source: 'osm',
			'source-layer': 'transportation_name',
			minzoom: 13,
			layout: {
				'symbol-placement': 'line',
				'text-field': NAME,
				'text-font': ['Noto Sans Regular'],
				'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 18, 14]
			},
			paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.75)', 'text-halo-width': 1.4 }
		},
		{
			id: 'house-numbers',
			type: 'symbol',
			source: 'osm',
			'source-layer': 'housenumber',
			minzoom: 17.5,
			layout: { 'text-field': ['get', 'housenumber'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 },
			paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.7)', 'text-halo-width': 1.2 }
		},
		{
			id: 'places-small',
			type: 'symbol',
			source: 'osm',
			'source-layer': 'place',
			minzoom: 9,
			filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'quarter', 'neighbourhood', 'hamlet']]],
			layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
			paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.75)', 'text-halo-width': 1.4 }
		},
		{
			id: 'places-big',
			type: 'symbol',
			source: 'osm',
			'source-layer': 'place',
			filter: ['in', ['get', 'class'], ['literal', ['country', 'city', 'town']]],
			layout: {
				'text-field': NAME,
				'text-font': ['Noto Sans Bold'],
				'symbol-sort-key': ['coalesce', ['get', 'rank'], 20],
				'text-size': [
					'interpolate',
					['linear'],
					['zoom'],
					3,
					['match', ['get', 'class'], 'country', 13, 10],
					10,
					['match', ['get', 'class'], 'city', 20, 'country', 0, 14]
				]
			},
			paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,.8)', 'text-halo-width': 1.6 }
		}
	]
};

const map = new maplibregl.Map({
	container: 'map',
	style,
	center: [10.4, 51.1],
	zoom: 5.3,
	pitch: 45,
	maxPitch: 80,
	maxZoom: 20,
	// iPhones haben 3-fache Pixeldichte; 2-fach reicht und schont Speicher und Akku
	pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
	attributionControl: false
});
window.__map = map; // zum Debuggen in der Konsole
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
const SMALL = window.matchMedia('(max-width: 760px)');
// Quellenhinweis auf dem Handy eingeklappt starten (ein Tipp auf das i öffnet ihn)
map.once('load', () => {
	if (SMALL.matches) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});
// Höhe des unteren Panels als CSS-Variable, damit Karten-Elemente darüber sitzen
new ResizeObserver(([entry]) => {
	document.documentElement.style.setProperty('--bottom-h', `${Math.round(entry.target.offsetHeight)}px`);
}).observe(document.querySelector('.bottom'));

const TERRAIN = { source: 'dem', exaggeration: 1.3 };

/* ------------------------------------------------------------------ *
 *  Wetterebenen auf der Karte
 * ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0');

function omUrl(variable, index, domain, extra = '') {
	const ref = new Date(state.meta.reference_time);
	const run = `${ref.getUTCFullYear()}/${pad(ref.getUTCMonth() + 1)}/${pad(ref.getUTCDate())}/${pad(ref.getUTCHours())}${pad(ref.getUTCMinutes())}Z`;
	const file = state.steps[index].replace(':', '').replace('Z', '');
	const t = state.times;
	const prev = index > 0 ? t[index - 1] : Date.parse(state.meta.reference_time);
	const dt = Math.max(1, Math.round((t[index] - prev) / 3.6e6));
	return `om://${SPATIAL}/${domain}/${run}/${file}.om?variable=${variable}&delta_time_hours=${dt}${extra}`;
}

// bei starkem Hineinzoomen tritt das Wetter zugunsten des Satellitenbilds zurück
const zoomOpacity = (o) => ['interpolate', ['linear'], ['zoom'], 10, o, 15, o * 0.45];
const opacityAt = (o, zoom) => o * (1 - 0.55 * Math.min(1, Math.max(0, (zoom - 10) / 5)));

// Nur den sichtbaren Kartenausschnitt aus den Modell-Dateien laden – das macht
// jedes Einzelbild klein genug, um die Wiedergabe im Voraus zu puffern.
function syncBounds() {
	const b = map.getBounds();
	OM.updateCurrentBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
}
map.on('dataloading', syncBounds);

/*
 * Jedes Einzelbild (Ebene × Zeitschritt) ist eine eigene Kartenebene. Sie wird
 * unsichtbar geladen und erst eingeblendet, wenn ihre Kacheln da sind. Bei der
 * Wiedergabe werden mehrere Bilder im Voraus geladen und stufenlos ineinander
 * übergeblendet, sodass Regen und Wolken fließend ziehen statt zu springen.
 */
const frames = Object.fromEntries(Object.keys(LAYERS).map((k) => [k, new Map()])); // key → Map(index → frame)
const STEP_MS = 420; // Wiedergabe: Dauer eines Zeitschritts bei vollem Puffer
const FADE_MS = 280; // Überblenden beim manuellen Zeitwechsel
const lookahead = () => (SMALL.matches ? 3 : state.enabled.size <= 2 ? 6 : 3); // Handy: weniger Speicher

// Liegt der ganze Kartenausschnitt im Gebiet von ICON-D2 (Mitteleuropa, 48 h),
// wird nur dieses Modell geladen statt zusätzlich ICON-EU und ICON global –
// gleiche Darstellung bei rund einem Drittel der Datenmenge.
const D2 = { domain: 'dwd_icon_d2', west: -3.94, south: 43.18, east: 20.34, north: 58.08, hours: 48 };
function updateViewMode() {
	const b = map.getBounds();
	const inside = b.getWest() >= D2.west && b.getEast() <= D2.east && b.getSouth() >= D2.south && b.getNorth() <= D2.north;
	if (inside === state.insideD2) return;
	state.insideD2 = inside;
	kick();
}
map.on('moveend', updateViewMode);
function domainFor(index) {
	const lead = (state.times[index] - Date.parse(state.meta.reference_time)) / 3.6e6;
	return state.insideD2 && lead <= D2.hours ? D2.domain : MAP_DOMAIN;
}
const frameKey = (index) => `${domainFor(index)}:${index}`;

function makeFrame(key, index) {
	const cfg = LAYERS[key];
	const domain = domainFor(index);
	const id = `wx-${key}-${++state.seq}`;
	const frame = { key, index, mapKey: frameKey(index), id, arrowsId: null, loaded: false, factor: 0, shown: 0, arrowsShown: 0, settled: false };
	map.addSource(id, { type: 'raster', url: omUrl(cfg.variable, index, domain) });
	map.addLayer(
		{
			id,
			type: 'raster',
			source: id,
			paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 }
		},
		`anchor-${key}`
	);
	if (cfg.arrows) {
		frame.arrowsId = `${id}-arrows`;
		map.addSource(frame.arrowsId, { type: 'vector', url: omUrl(cfg.variable, index, domain, '&arrows=true') });
		map.addLayer(
			{
				id: frame.arrowsId,
				type: 'line',
				source: frame.arrowsId,
				'source-layer': 'wind-arrows',
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: {
					// Stärke über die Deckkraft der Farbe, damit 'line-opacity' eine einfache Zahl bleibt
					'line-color': [
						'interpolate',
						['linear'],
						['to-number', ['get', 'value'], 0],
						0,
						'rgba(255,255,255,0.25)',
						4,
						'rgba(255,255,255,0.7)',
						10,
						'rgba(255,255,255,1)'
					],
					'line-opacity': 0,
					'line-opacity-transition': { duration: 150 },
					'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 9, 1.8]
				}
			},
			'anchor-top'
		);
	}

	let sawTile = false;
	const done = () => {
		if (frame.loaded) return;
		frame.loaded = true;
		frame.stop();
		kick();
	};
	const onData = (e) => {
		if (e.sourceId !== id) return;
		if (e.tile) sawTile = true;
		if (sawTile && map.isSourceLoaded(id)) done();
	};
	const timer = setTimeout(done, 12000); // nie ewig auf ein Bild warten
	frame.stop = () => {
		clearTimeout(timer);
		map.off('sourcedata', onData);
	};
	map.on('sourcedata', onData);
	return frame;
}

function disposeFrame(frame) {
	frame.stop();
	if (frames[frame.key].get(frame.mapKey) === frame) frames[frame.key].delete(frame.mapKey);
	for (const id of [frame.arrowsId, frame.id]) {
		if (!id) continue;
		if (map.getLayer(id)) map.removeLayer(id);
		if (map.getSource(id)) map.removeSource(id);
	}
}

function resetFrames() {
	for (const set of Object.values(frames)) for (const frame of [...set.values()]) disposeFrame(frame);
}

function applyOpacity(frame, factor, zoom) {
	frame.factor = factor;
	frame.settled = false;
	const v = Math.round(factor * opacityAt(LAYERS[frame.key].opacity, zoom) * 500) / 500;
	if (v !== frame.shown) {
		frame.shown = v;
		map.setPaintProperty(frame.id, 'raster-opacity', v);
	}
	if (frame.arrowsId) {
		// Pfeile werden nicht überblendet (das ergäbe doppelte Pfeile), sondern umgeschaltet
		const a = factor >= 0.5 ? 0.9 : 0;
		if (a !== frame.arrowsShown) {
			frame.arrowsShown = a;
			map.setPaintProperty(frame.arrowsId, 'line-opacity', a);
		}
	}
}

function setWaiting(waiting) {
	const text = !waiting ? 'Kartenzeit' : state.playing ? 'Puffert …' : 'Karte lädt …';
	if (state.waiting === waiting && $('timeHint').textContent === text) return;
	state.waiting = waiting;
	$('play').classList.toggle('loading', waiting);
	$('timeHint').textContent = text;
}

let raf = 0;
let lastTick = 0;
function kick() {
	if (!raf) raf = requestAnimationFrame(tick);
}

function tick(now) {
	raf = 0;
	const dt = lastTick ? Math.min(64, now - lastTick) : 16;
	lastTick = 0;
	if (!state.meta || !state.ready) return;
	const n = state.times.length;
	const zoom = map.getZoom();
	const keys = Object.keys(LAYERS).filter((k) => state.enabled.has(k));
	for (const key of Object.keys(LAYERS)) {
		if (!state.enabled.has(key)) for (const frame of [...frames[key].values()]) disposeFrame(frame);
	}
	const ensure = (indexes) => {
		for (const key of keys) {
			for (const i of indexes) if (!frames[key].has(frameKey(i))) frames[key].set(frameKey(i), makeFrame(key, i));
		}
	};
	const at = (key, i) => frames[key].get(frameKey(((i % n) + n) % n));
	let busy = false;
	let waiting = false;

	if (state.playing) {
		busy = true;
		const ahead = lookahead();
		const back = state.dir < 0;
		// Fenster der Bilder, die bereitliegen sollen: in Laufrichtung voraus.
		// Rückwärts gehört auch das Bild "hinter" der Position dazu (base + 1),
		// weil gerade von ihm weg übergeblendet wird.
		const window_ = (base) =>
			back
				? Array.from({ length: ahead + 2 }, (_, k) => (((base + 1 - k) % n) + n) % n)
				: Array.from({ length: ahead + 1 }, (_, k) => (base + k) % n);
		let base = Math.floor(state.pos) % n;
		let f = state.pos - Math.floor(state.pos);
		ensure(window_(base));
		// Wie viele Bilder liegen in Laufrichtung lückenlos fertig vor uns?
		let buffered = ahead;
		for (const key of keys) {
			let c = 0;
			if (back) {
				if (!at(key, base)?.loaded || (f > 0 && !at(key, base + 1)?.loaded)) c = -1;
				else while (c < ahead && at(key, base - 1 - c)?.loaded) c++;
			} else if (at(key, base)?.loaded) {
				while (c < ahead && at(key, base + 1 + c)?.loaded) c++;
			}
			buffered = Math.min(buffered, c);
		}
		// Vorsprung in Bildern
		const reserve = !keys.length ? ahead : back ? (buffered < 0 ? 0 : buffered + f) : buffered - f;
		// Erst etwas puffern, dann losfließen; läuft der Puffer leer, neu puffern
		if (!state.rolling && reserve >= Math.min(3, ahead)) state.rolling = true;
		if (state.rolling && reserve <= 0.01) state.rolling = false;
		// Tempo gleitend an den Vorsprung anpassen: Bei langsamem Netz zieht das
		// Wetter langsamer, aber gleichmäßig, statt zu rucken und zu stocken.
		const wanted = state.rolling ? Math.min(1, Math.max(0.1, reserve / (ahead * 0.6))) : 0;
		state.rate += (wanted - state.rate) * Math.min(1, dt / 500);
		const advance = Math.min((dt / STEP_MS) * state.rate * state.speed, reserve);
		state.pos = (((state.pos + state.dir * advance) % n) + n) % n;
		waiting = keys.length > 0 && !state.rolling;

		base = Math.floor(state.pos) % n;
		f = state.pos - Math.floor(state.pos);
		const next = (base + 1) % n;
		const keep = new Set(window_(base).map(frameKey));
		for (const key of keys) {
			for (const frame of [...frames[key].values()]) {
				if (!keep.has(frame.mapKey)) disposeFrame(frame);
				else applyOpacity(frame, frame.index === base ? 1 - f : frame.index === next ? f : 0, zoom);
			}
		}
		$('time').value = state.pos;
		const nearest = Math.round(state.pos) % n;
		if (nearest !== state.timeIndex) {
			state.timeIndex = state.target = nearest;
			renderTimeLabel()?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
		}
	} else {
		ensure([state.target]);
		let allSettled = true;
		for (const key of keys) {
			const target = at(key, state.target);
			// die nächsten Bilder liegen unsichtbar bereit (siehe unten) und bleiben erhalten
			const preload = new Set([1, 2, 3].map((k) => frameKey((state.target + k) % n)));
			const others = [...frames[key].values()].filter((fr) => fr !== target && !preload.has(fr.mapKey));
			if (!target.loaded) {
				waiting = true;
				allSettled = false;
				// noch nicht sichtbare, überholte Bilder gleich verwerfen
				for (const fr of others) if (fr.factor === 0) disposeFrame(fr);
				continue;
			}
			if (target.settled) continue;
			allSettled = false;
			const step = dt / FADE_MS;
			for (const fr of others) applyOpacity(fr, Math.max(0, fr.factor - step), zoom);
			if (target.factor + step < 1) {
				applyOpacity(target, target.factor + step, zoom);
				busy = true;
			} else {
				applyOpacity(target, 1, zoom);
				for (const fr of others) disposeFrame(fr);
				// ab jetzt regelt die Karte die Deckkraft selbst je nach Zoomstufe
				map.setPaintProperty(target.id, 'raster-opacity', zoomOpacity(LAYERS[key].opacity));
				target.shown = -1;
				target.settled = true;
				busy = true; // noch eine Runde, um die nächsten Bilder vorzuladen
			}
		}
		// Steht das Bild, die nächsten Stunden schon im Hintergrund laden, damit
		// die Wiedergabe sofort losfließen kann.
		if (allSettled && keys.length) ensure([1, 2, 3].map((k) => (state.target + k) % n));
	}

	setWaiting(waiting);
	if (busy) {
		lastTick = now;
		kick();
	}
}

function refreshLayers() {
	kick();
}

function renderLegend() {
	$('legend').innerHTML = [...state.enabled]
		.map((key) => {
			const l = LEGENDS[key];
			return `<div class="row">${l.label}<div class="bar" style="background:${l.css}"></div><div class="scale">${l.scale.map((s) => `<span>${s}</span>`).join('')}</div></div>`;
		})
		.join('');
}

/* ------------------------------------------------------------------ *
 *  Zeitleiste
 * ------------------------------------------------------------------ */
const fmt = (opts) => new Intl.DateTimeFormat('de-DE', { timeZone: state.tz, ...opts });
const dayKey = (ms) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

function nearestIndex(ms) {
	let best = 0;
	for (let i = 1; i < state.times.length; i++) {
		if (Math.abs(state.times[i] - ms) < Math.abs(state.times[best] - ms)) best = i;
	}
	return best;
}

function renderTimeline() {
	const slider = $('time');
	slider.max = state.times.length - 1;
	slider.value = state.timeIndex;
	const dayFmt = fmt({ weekday: 'short', day: '2-digit', month: '2-digit' });
	let last = dayKey(state.times[0]);
	let html = '';
	state.times.forEach((ms, i) => {
		const k = dayKey(ms);
		if (k === last) return;
		last = k;
		const [wd, date] = dayFmt.format(ms).split(', ');
		html += `<span style="left:${(i / (state.times.length - 1)) * 100}%">${wd}<i>, ${date}</i></span>`;
	});
	$('ticks').innerHTML = html;
	renderTimeLabel();
}

function renderTimeLabel() {
	const ms = state.times[state.timeIndex];
	if (ms == null) return;
	$('timeText').textContent = fmt({ weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
	// passende Stunde und passenden Tag in der Übersicht markieren
	const hourMs = Math.round(ms / 3.6e6) * 3.6e6;
	let active = null;
	for (const el of document.querySelectorAll('.hr')) {
		const on = Number(el.dataset.t) === hourMs;
		el.classList.toggle('on', on);
		if (on) active = el;
	}
	const k = dayKey(ms);
	for (const el of document.querySelectorAll('.days button')) el.classList.toggle('on', el.dataset.day === k);
	return active;
}

let timeDebounce;
function setTimeIndex(i, { immediate = false, scroll = false } = {}) {
	i = Math.max(0, Math.min(state.times.length - 1, Math.round(i)));
	state.timeIndex = i;
	$('time').value = i;
	const active = renderTimeLabel();
	if (scroll && active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
	clearTimeout(timeDebounce);
	// beim Ziehen am Regler nicht für jede Zwischenposition ein Bild laden
	timeDebounce = setTimeout(
		() => {
			state.target = i;
			kick();
		},
		immediate ? 0 : 160
	);
}

const SPEEDS = [2, 4, 8];
function setPlaying(on, { dir = 1, speed = 1 } = {}) {
	if (on && !state.times.length) return;
	const wasPlaying = state.playing;
	state.playing = on;
	state.dir = dir;
	state.speed = speed;
	const fast = on && (dir < 0 || speed > 1);
	$('play').textContent = on ? '❚❚' : '▶';
	$('play').title = on ? 'Anhalten' : 'Abspielen';
	$('rew').classList.toggle('on', fast && dir < 0);
	$('ffw').classList.toggle('on', fast && dir > 0);
	$('rew').textContent = fast && dir < 0 ? `◀◀ ${speed}×` : '◀◀';
	$('ffw').textContent = fast && dir > 0 ? `${speed}× ▶▶` : '▶▶';
	clearTimeout(timeDebounce);
	if (on && wasPlaying) return kick(); // nur Richtung/Tempo gewechselt: Position behalten
	state.rolling = false;
	state.rate = 0;
	if (on) state.pos = state.target = state.timeIndex;
	else {
		// beim Anhalten auf dem nächstgelegenen Zeitschritt einrasten
		state.target = state.timeIndex;
		$('time').value = state.timeIndex;
	}
	kick();
}

/** Spulen: erster Klick startet mit 2×, jeder weitere in dieselbe Richtung erhöht auf 4× und 8×. */
function wind(dir) {
	const same = state.playing && state.dir === dir && (dir < 0 || state.speed > 1);
	const speed = same ? SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length] : SPEEDS[0];
	setPlaying(true, { dir, speed });
}

async function loadMeta() {
	const res = await fetch(`${SPATIAL}/${BASE_DOMAIN}/latest.json`, { cache: 'no-store' });
	if (!res.ok) throw new Error(`Modelldaten nicht erreichbar (${res.status})`);
	const meta = await res.json();
	if (state.meta && state.meta.reference_time === meta.reference_time) return;
	const keepMs = state.meta ? state.times[state.timeIndex] : Date.now();
	state.meta = meta;
	// Der erste Zeitschritt ist der Startzustand des Modells und enthält noch keinen Niederschlag
	state.steps = meta.valid_times.slice(1);
	state.times = state.steps.map((t) => Date.parse(t.replace('Z', ':00Z')));
	state.timeIndex = state.target = nearestIndex(keepMs);
	state.pos = state.timeIndex;
	resetFrames(); // Bilder des alten Modelllaufs verwerfen
	renderTimeline();
	refreshLayers();
}

/* ------------------------------------------------------------------ *
 *  Punktvorhersage: aktuell, stündlich, täglich
 * ------------------------------------------------------------------ */
function toast(text, ms = 4500) {
	const el = $('toast');
	el.textContent = text;
	el.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (el.hidden = true), ms);
}

async function loadForecast(lat, lon) {
	const req = ++state.forecastReq;
	const params = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lon.toFixed(4),
		current:
			'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
		hourly: 'temperature_2m,precipitation,precipitation_probability,weather_code,is_day',
		daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
		timezone: 'auto',
		timeformat: 'unixtime',
		forecast_days: '7'
	});
	try {
		const res = await fetch(`${FORECAST_API}?${params}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		if (req !== state.forecastReq) return;
		state.tz = data.timezone || state.tz;
		renderNow(data);
		renderDays(data);
		renderHours(data);
		if (state.times.length) renderTimeline();
	} catch (err) {
		if (req !== state.forecastReq) return;
		console.error(err);
		$('nowDesc').textContent = 'Vorhersage konnte nicht geladen werden.';
		$('hours').innerHTML = '<div class="empty">Keine Daten – bitte später erneut versuchen.</div>';
	}
}

function renderNow({ current: c }) {
	const w = wmo(c.weather_code, c.is_day);
	$('nowIcon').textContent = w.icon;
	$('nowTemp').textContent = `${num(c.temperature_2m)}°`;
	$('nowDesc').textContent = w.text;
	$('nowFeels').textContent = `${num(c.apparent_temperature)}°`;
	$('nowRain').textContent = `${num(c.precipitation, 1)} mm`;
	$('nowWind').textContent = `${num(c.wind_speed_10m)} km/h ${COMPASS[Math.round(c.wind_direction_10m / 45) % 8]}`;
	$('nowGust').textContent = `${num(c.wind_gusts_10m)} km/h`;
	$('nowCloud').textContent = `${num(c.cloud_cover)} %`;
	$('nowHum').textContent = `${num(c.relative_humidity_2m)} %`;
}

function renderDays({ daily: d }) {
	const wd = fmt({ weekday: 'short' });
	$('days').innerHTML = d.time
		.map((t, i) => {
			const ms = t * 1000;
			const rain = d.precipitation_sum[i];
			return `<button data-day="${dayKey(ms)}" data-t="${ms}">
				<b>${i === 0 ? 'Heute' : wd.format(ms)}</b>
				<span>${wmo(d.weather_code[i]).icon}</span>
				<span>${num(d.temperature_2m_max[i])}° <span class="lo">${num(d.temperature_2m_min[i])}°</span></span>
				${rain >= 0.1 ? `<span class="mm">${num(rain, 1)} mm</span>` : ''}
			</button>`;
		})
		.join('');
}

function renderHours({ hourly: h }) {
	const hourFmt = fmt({ hour: '2-digit' });
	const sepFmt = fmt({ weekday: 'short', day: '2-digit', month: '2-digit' });
	const from = Date.now() - 3.6e6;
	const maxRain = Math.max(2, ...h.precipitation.filter((v) => v != null));
	let html = '';
	let last = null;
	h.time.forEach((t, i) => {
		const ms = t * 1000;
		if (ms < from || h.temperature_2m[i] == null) return;
		const k = dayKey(ms);
		if (k !== last) {
			html += `<div class="sep" data-day="${k}">${last === null ? 'Heute' : sepFmt.format(ms)}</div>`;
			last = k;
		}
		const mm = h.precipitation[i] || 0;
		const prob = h.precipitation_probability[i];
		const rainText = mm >= 0.1 ? `${num(mm, 1)} mm` : prob >= 20 ? `${prob} %` : '–';
		html += `<button class="hr" data-t="${ms}" title="${wmo(h.weather_code[i]).text}${prob != null ? ` · Regenrisiko ${prob} %` : ''}">
			<span class="t">${hourFmt.format(ms)}</span>
			<span class="i">${wmo(h.weather_code[i], h.is_day[i]).icon}</span>
			<span class="v">${num(h.temperature_2m[i])}°</span>
			<span class="b" style="height:${mm > 0 ? Math.max(8, Math.min(100, (mm / maxRain) * 100)) : 0}%"></span>
			<span class="r${mm >= 0.1 || prob >= 20 ? '' : ' dry'}">${rainText}</span>
		</button>`;
	});
	$('hours').innerHTML = html || '<div class="empty">Keine Daten.</div>';
	$('hours').scrollLeft = 0;
}

/* ------------------------------------------------------------------ *
 *  Ort wählen: Ortung, Suche, Klick auf die Karte
 * ------------------------------------------------------------------ */
async function reverseName(lat, lon) {
	try {
		const res = await fetch(`${REVERSE_API}?format=jsonv2&zoom=14&accept-language=de&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
		const a = (await res.json()).address || {};
		const name = a.suburb || a.village || a.town || a.city || a.municipality || a.county;
		const parent = [a.city || a.town || a.county, a.state].filter((v) => v && v !== name);
		return { name, sub: parent.slice(0, 2).join(', ') };
	} catch {
		return {};
	}
}

async function selectPoint(lat, lon, { name, sub, gps = false, fly = true, zoom } = {}) {
	state.point = { lat, lon };
	if (!state.marker) {
		const el = document.createElement('div');
		el.className = 'pin';
		state.marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
	}
	state.marker.setLngLat([lon, lat]);
	state.marker.getElement().classList.toggle('gps', gps);
	if (fly) map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 9), pitch: map.getPitch(), duration: 2200 });

	$('placeName').textContent = name || (gps ? 'Mein Standort' : `${num(lat, 2)}°, ${num(lon, 2)}°`);
	$('placeSub').textContent = sub || '';
	loadForecast(lat, lon);
	if (!name) {
		const r = await reverseName(lat, lon);
		if (state.point.lat !== lat || state.point.lon !== lon || !r.name) return;
		$('placeName').textContent = r.name;
		$('placeSub').textContent = gps ? ['Mein Standort', r.sub].filter(Boolean).join(' · ') : r.sub || '';
	}
}

function locate({ silent = false } = {}) {
	if (!navigator.geolocation) {
		if (!silent) toast('Dieser Browser unterstützt keine Ortung.');
		return fallbackPlace();
	}
	if (!window.isSecureContext) {
		// Browser erlauben Ortung nur über https (oder auf localhost)
		toast('Ortung braucht eine sichere Verbindung (https) – Ort suchen oder auf die Karte tippen.', 7000);
		return fallbackPlace();
	}
	$('locate').classList.add('busy');
	navigator.geolocation.getCurrentPosition(
		(pos) => {
			$('locate').classList.remove('busy');
			selectPoint(pos.coords.latitude, pos.coords.longitude, { gps: true, zoom: 11 });
		},
		(err) => {
			$('locate').classList.remove('busy');
			toast(
				err.code === err.PERMISSION_DENIED
					? 'Ortung nicht erlaubt – Ort suchen oder auf die Karte klicken.'
					: 'Standort konnte nicht ermittelt werden – Ort suchen oder auf die Karte klicken.'
			);
			fallbackPlace();
		},
		{ enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
	);
}

function fallbackPlace() {
	if (!state.point) selectPoint(52.52, 13.405, { name: 'Berlin', sub: 'Deutschland', fly: false });
}

/* Suche */
let searchTimer;
let searchResults = [];
$('q').addEventListener('input', (e) => {
	clearTimeout(searchTimer);
	const q = e.target.value.trim();
	if (q.length < 2) return ($('results').hidden = true);
	searchTimer = setTimeout(async () => {
		try {
			const res = await fetch(`${GEOCODE_API}?name=${encodeURIComponent(q)}&count=6&language=de&format=json`);
			searchResults = (await res.json()).results || [];
		} catch {
			searchResults = [];
		}
		if ($('q').value.trim() !== q) return;
		const list = $('results');
		list.replaceChildren(
			...(searchResults.length
				? searchResults.map((r, i) => {
						const li = document.createElement('li');
						li.dataset.i = i;
						li.append(r.name);
						const small = document.createElement('small');
						small.textContent = [r.admin1, r.country].filter(Boolean).join(', ');
						li.append(small);
						return li;
					})
				: [Object.assign(document.createElement('li'), { textContent: 'Kein Ort gefunden' })])
		);
		list.hidden = false;
	}, 280);
});
function pickResult(i) {
	const r = searchResults[i];
	if (!r) return;
	$('results').hidden = true;
	$('q').value = '';
	$('q').blur();
	selectPoint(r.latitude, r.longitude, { name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', '), zoom: 10.5 });
}
$('results').addEventListener('click', (e) => pickResult(e.target.closest('li')?.dataset.i));
$('q').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') pickResult(0);
	if (e.key === 'Escape') $('results').hidden = true;
});
document.addEventListener('click', (e) => {
	if (!e.target.closest('.search')) $('results').hidden = true;
});

$('locate').addEventListener('click', () => locate());
map.on('click', (e) => selectPoint(e.lngLat.lat, e.lngLat.lng, { fly: false }));

/* ------------------------------------------------------------------ *
 *  Bedienelemente
 * ------------------------------------------------------------------ */
$('layerChips').addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-layer]');
	if (!btn) return;
	const key = btn.dataset.layer;
	const on = !state.enabled.has(key);
	if (on) state.enabled.add(key);
	else state.enabled.delete(key);
	btn.classList.toggle('on', on);
	kick();
	renderLegend();
});

$('toggle3d').addEventListener('click', (e) => {
	const on = e.currentTarget.classList.toggle('on');
	map.setTerrain(on ? TERRAIN : null);
	map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
	map.easeTo({ pitch: on ? 55 : 0, bearing: on ? map.getBearing() : 0, duration: 900 });
});

$('toggleLabels').addEventListener('click', (e) => {
	const on = e.currentTarget.classList.toggle('on');
	for (const id of LABEL_LAYERS) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
});

$('time').addEventListener('input', (e) => {
	setPlaying(false);
	setTimeIndex(Number(e.target.value), { scroll: true });
});
$('play').addEventListener('click', () => setPlaying(!state.playing));
$('rew').addEventListener('click', () => wind(-1));
$('ffw').addEventListener('click', () => wind(1));
// Tastatur: Leertaste = Abspielen/Anhalten, Pfeile = eine Stunde zurück/vor, mit Umschalt = spulen
document.addEventListener('keydown', (e) => {
	if (e.target.closest('input, textarea') && e.target.id !== 'time') return;
	if (e.key === ' ') setPlaying(!state.playing);
	else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
		const dir = e.key === 'ArrowLeft' ? -1 : 1;
		if (e.shiftKey) wind(dir);
		else {
			if (state.playing) setPlaying(false);
			setTimeIndex(state.timeIndex + dir, { immediate: true, scroll: true });
		}
	} else return;
	e.preventDefault();
});
$('nowBtn').addEventListener('click', () => {
	setPlaying(false);
	setTimeIndex(nearestIndex(Date.now()), { immediate: true, scroll: true });
});

function jumpTo(ms) {
	if (!state.times.length) return;
	if (state.playing) setPlaying(false);
	const last = state.times[state.times.length - 1];
	if (ms > last + 1.5 * 3.6e6) {
		toast(`Die Wetterkarte reicht bis ${fmt({ weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(last)} – die Übersicht unten geht weiter.`);
	}
	setTimeIndex(nearestIndex(ms), { immediate: true });
}
$('hours').addEventListener('click', (e) => {
	const el = e.target.closest('.hr');
	if (el) jumpTo(Number(el.dataset.t));
});
$('days').addEventListener('click', (e) => {
	const btn = e.target.closest('button');
	if (!btn) return;
	const sep = document.querySelector(`.hours .sep[data-day="${btn.dataset.day}"]`);
	if (sep) $('hours').scrollTo({ left: sep.offsetLeft - $('hours').offsetLeft, behavior: 'smooth' });
	// heute: aktuelle Zeit, sonst 13 Uhr Ortszeit des gewählten Tages
	const isToday = btn === $('days').firstElementChild;
	jumpTo(isToday ? Date.now() : Number(btn.dataset.t) + 13 * 3.6e6);
});

/* ------------------------------------------------------------------ *
 *  Start
 * ------------------------------------------------------------------ */
renderLegend();
// Vorhersage und Modelldaten sofort laden, nicht erst wenn die Karte fertig ist
loadMeta().catch((err) => {
	console.error(err);
	toast('Wetterkarte konnte nicht geladen werden – bitte später neu laden.', 8000);
});
locate({ silent: true });
map.on('load', () => {
	map.setTerrain(TERRAIN);
	state.ready = true;
	updateViewMode();
	refreshLayers();
});
// neuen Modelllauf übernehmen, wenn die Seite lange offen bleibt
setInterval(() => loadMeta().catch(() => {}), 20 * 60 * 1000);
