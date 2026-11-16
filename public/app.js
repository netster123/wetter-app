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
const ALERTS_API = 'https://api.brightsky.dev/alerts'; // amtliche DWD-Warnungen
// Regenradar: Kartendienst des DWD, Radarkomposit 1 km, alle 5 Minuten,
// Messung plus 2 Stunden Kurzfrist-Vorhersage
const RADAR_WMS = 'https://maps.dwd.de/geoserver/dwd';
const RADAR_LAYER = 'Radar_wn-product_1x1km_ger';
const RADAR_BOUNDS = [1.4, 45.6, 18.8, 56.3]; // Abdeckung: Deutschland und Umgebung
const RADAR_STEP = 5 * 60e3;
const RADAR_PAST = 90 * 60e3;
const RADAR_FUTURE = 120 * 60e3;
// Satellitenbild: Kartendienst von EUMETSAT, Meteosat (MTG) „GeoColour“, alle
// 10 Minuten. Tagsüber Echtfarben, nachts Wolken aus dem Infrarotkanal.
const SAT_WMS = 'https://view.eumetsat.int/geoserver';
const SAT_LAYER = 'mtg_fd:rgb_geocolour';
// Achsen mit eigenen Zeitschritten (Messungen statt Modellvorhersage)
const LIVE = {
	radar: { step: 5 * 60e3, past: RADAR_PAST, future: RADAR_FUTURE, lag: 5 * 60e3, caps: `${RADAR_WMS}/${RADAR_LAYER}/wms`, name: 'Radar' },
	sat: { step: 10 * 60e3, past: 180 * 60e3, future: 0, lag: 25 * 60e3, caps: `${SAT_WMS}/${SAT_LAYER.replace(':', '/')}/wms`, name: 'Satellit' }
};
const TZ = 'Europe/Berlin';

const LAYERS = {
	temp: { variable: 'temperature_2m', opacity: 0.6 },
	wind: { variable: 'wind_u_component_10m', opacity: 0.65, arrows: true },
	clouds: { variable: 'cloud_cover', opacity: 0.85 },
	rain: { variable: 'precipitation', opacity: 0.9 },
	radar: { opacity: 0.8, fixed: true }, // eigene Zeitachse, siehe setAxis()
	sat: { opacity: 1, fixed: true } // echte Wolken aus dem Satellitenbild, eigene Zeitachse
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
const TOWARDS = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];

/* ------------------------------------------------------------------ *
 *  Zwischenspeicher für API-Abrufe: Antworten werden für eine gewisse Zeit
 *  im Arbeitsspeicher und im Browser (localStorage) behalten, damit die App
 *  nicht unnötig oft abfragt. Fällt eine Quelle aus, wird die letzte
 *  bekannte Antwort weiterverwendet.
 * ------------------------------------------------------------------ */
const CACHE_PREFIX = 'wx:';
const memCache = new Map();
async function cachedJson(url, ttlMs) {
	const key = CACHE_PREFIX + url;
	const now = Date.now();
	let hit = memCache.get(key);
	if (!hit) {
		try {
			hit = JSON.parse(localStorage.getItem(key));
		} catch {}
	}
	if (hit?.promise) return hit.promise;
	if (hit && now - hit.t < ttlMs) return hit.d;
	const promise = fetch(url).then((res) => {
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	});
	memCache.set(key, { t: now, promise });
	try {
		const d = await promise;
		memCache.set(key, { t: now, d });
		try {
			localStorage.setItem(key, JSON.stringify({ t: now, d }));
		} catch {}
		return d;
	} catch (err) {
		memCache.delete(key);
		if (hit?.d && now - hit.t < 6 * 3.6e6) return hit.d; // veraltet, aber besser als nichts
		throw err;
	}
}
// alte Einträge beim Start aufräumen
try {
	for (const key of Object.keys(localStorage)) {
		if (!key.startsWith(CACHE_PREFIX)) continue;
		let t = 0;
		try {
			t = JSON.parse(localStorage.getItem(key)).t;
		} catch {}
		if (Date.now() - t > 6 * 3.6e6) localStorage.removeItem(key);
	}
} catch {}

/* ------------------------------------------------------------------ *
 *  Zustand
 * ------------------------------------------------------------------ */
const state = {
	meta: null, // { reference_time, valid_times }
	// Zwei Zeitachsen: 'model' (Vorhersagekarte, stündlich, 5 Tage) und 'radar'
	// (5-Minuten-Schritte, 90 min zurück bis 2 h voraus). times/timeIndex
	// gehören immer zur gerade aktiven Achse.
	axis: 'model',
	model: { steps: [], times: [], index: 0 },
	radar: { times: [], index: 0, latest: 0 },
	sat: { times: [], index: 0, latest: 0 },
	times: [],
	timeIndex: 0,
	enabled: new Set(['rain', 'clouds']),
	target: 0, // Zeitschritt, den die Karte zeigen soll
	pos: 0, // Wiedergabeposition (Zeitschritt mit Nachkommaanteil)
	playing: false,
	scrubbing: false, // Regler wird gerade von Hand gezogen
	dir: 1, // Laufrichtung der Wiedergabe: 1 vorwärts, -1 rückwärts
	speed: 1, // Spul-Faktor
	rolling: false, // Wiedergabe läuft (genug gepuffert)
	rate: 0, // aktuelles Wiedergabetempo, 0…1
	insideD2: false, // Kartenausschnitt liegt ganz im ICON-D2-Gebiet
	waiting: false,
	seq: 0,
	tz: TZ,
	steer: null, // Höhenwind am Ort: Zugrichtung der Niederschlagsgebiete
	alertReq: 0,
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

// Satellitenbild → nur die Wolken: Der Dienst liefert ein fertiges Bild samt
// Erdoberfläche. Helle, farblose Bildpunkte sind Wolken (oder Schnee); alles
// andere wird durchsichtig, damit darunter die eigene Karte sichtbar bleibt.
maplibregl.addProtocol('satcloud', async (params, abort) => {
	const res = await fetch(params.url.replace('satcloud://', 'https://'), { signal: abort.signal });
	if (!res.ok) throw new Error(`Satellitenbild: HTTP ${res.status}`);
	const bmp = await createImageBitmap(await res.blob());
	const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(bmp, 0, 0);
	bmp.close?.();
	const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		const lo = Math.min(d[i], d[i + 1], d[i + 2]);
		const hi = Math.max(d[i], d[i + 1], d[i + 2]);
		const t = Math.min(1, Math.max(0, (lo - 0.6 * (hi - lo) - 70) / 105));
		d[i + 3] = Math.round(255 * t * t * (3 - 2 * t));
	}
	ctx.putImageData(img, 0, 0);
	return { data: await createImageBitmap(canvas) };
});

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
		anchor('anchor-radar'),
		anchor('anchor-sat'),
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
map.once('idle', () => {
	if (SMALL.matches) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});
if (SMALL.matches) setTimeout(() => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'), 4000);
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
	const file = state.model.steps[index].replace(':', '').replace('Z', '');
	const t = state.model.times;
	const prev = index > 0 ? t[index - 1] : Date.parse(state.meta.reference_time);
	const dt = Math.max(1, Math.round((t[index] - prev) / 3.6e6));
	return `om://${SPATIAL}/${domain}/${run}/${file}.om?variable=${variable}&delta_time_hours=${dt}${extra}`;
}

// bei starkem Hineinzoomen tritt das Wetter zugunsten des Satellitenbilds zurück
const zoomOpacity = (o) => ['interpolate', ['linear'], ['zoom'], 10, o, 15, o * 0.45];
const opacityAt = (o, zoom) => o * (1 - 0.55 * Math.min(1, Math.max(0, (zoom - 10) / 5)));
// Radar bleibt auch nah herangezoomt gut sichtbar
const layerOpacityAt = (cfg, zoom) => (cfg.fixed ? cfg.opacity : opacityAt(cfg.opacity, zoom));
const layerOpacityExpr = (cfg) => (cfg.fixed ? cfg.opacity : zoomOpacity(cfg.opacity));

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
const isLive = () => state.axis !== 'model';
const stepMs = () => (isLive() ? 260 : 420); // Wiedergabe: Dauer eines Zeitschritts bei vollem Puffer
const FADE_MS = 280; // Überblenden beim manuellen Zeitwechsel
const lookahead = () => (isLive() ? (SMALL.matches ? 4 : 8) : SMALL.matches ? 3 : state.enabled.size <= 2 ? 6 : 3); // Handy: weniger Speicher

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
	if (isLive()) return state.axis;
	const lead = (state.model.times[index] - Date.parse(state.meta.reference_time)) / 3.6e6;
	return state.insideD2 && lead <= D2.hours ? D2.domain : MAP_DOMAIN;
}
// Radarbilder werden über ihre Uhrzeit erkannt, weil sich die Zeitachse alle 5 Minuten verschiebt
const frameKey = (index) => (isLive() ? `${state.axis}:${state.times[index]}` : `${domainFor(index)}:${index}`);

function makeFrame(key, index) {
	const cfg = LAYERS[key];
	const domain = domainFor(index);
	const id = `wx-${key}-${++state.seq}`;
	const frame = { key, index, time: state.times[index], mapKey: frameKey(index), id, arrowsId: null, loaded: false, factor: 0, shown: 0, arrowsShown: 0, settled: false };
	if (key === 'radar') {
		const time = new Date(frame.time).toISOString();
		map.addSource(id, {
			type: 'raster',
			tiles: [
				`${RADAR_WMS}/wms?service=WMS&version=1.3.0&request=GetMap&layers=dwd:${RADAR_LAYER}&styles=&format=image/png&transparent=true&crs=EPSG:3857&width=512&height=512&bbox={bbox-epsg-3857}&time=${time}`
			],
			tileSize: 512,
			bounds: RADAR_BOUNDS,
			maxzoom: 10,
			attribution: 'Radar © Deutscher Wetterdienst'
		});
	} else if (key === 'sat') {
		const time = new Date(frame.time).toISOString();
		map.addSource(id, {
			type: 'raster',
			tiles: [
				`satcloud://${SAT_WMS.slice(8)}/wms?service=WMS&version=1.3.0&request=GetMap&layers=${SAT_LAYER}&styles=&format=image/jpeg&crs=EPSG:3857&width=512&height=512&bbox={bbox-epsg-3857}&time=${time}`
			],
			tileSize: 512,
			maxzoom: 7,
			attribution: 'Satellitenbild © EUMETSAT'
		});
	} else map.addSource(id, { type: 'raster', url: omUrl(cfg.variable, index, domain) });
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
	// nie ewig auf ein Bild warten; außerhalb des Radargebiets gibt es nichts zu laden
	const b = map.getBounds();
	const outside = key === 'radar' && (b.getEast() < RADAR_BOUNDS[0] || b.getWest() > RADAR_BOUNDS[2] || b.getNorth() < RADAR_BOUNDS[1] || b.getSouth() > RADAR_BOUNDS[3]);
	const timer = setTimeout(done, outside ? 0 : 12000);
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
	const v = Math.round(factor * layerOpacityAt(LAYERS[frame.key], zoom) * 500) / 500;
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
	let text = 'Kartenzeit';
	if (waiting) text = state.playing ? 'Puffert …' : 'Karte lädt …';
	else if (state.axis === 'radar') text = state.times[state.timeIndex] > state.radar.latest ? 'Radar · Vorhersage' : 'Radar · Messung';
	else if (state.axis === 'sat') text = 'Satellit · Aufnahme';
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
	const n = state.times.length;
	if (!state.ready || !n || (state.axis === 'model' && !state.meta)) return;
	const zoom = map.getZoom();
	// Im Radar-Modus ist nur das Radar zu sehen, sonst die gewählten Vorhersage-Ebenen
	const keys = isLive() ? [state.axis] : Object.keys(LAYERS).filter((k) => state.enabled.has(k));
	for (const key of Object.keys(LAYERS)) {
		if (!keys.includes(key)) for (const frame of [...frames[key].values()]) disposeFrame(frame);
	}
	const ensure = (indexes) => {
		for (const key of keys) {
			for (const i of indexes) if (!frames[key].has(frameKey(i))) frames[key].set(frameKey(i), makeFrame(key, i));
		}
	};
	const at = (key, i) => frames[key].get(frameKey(((i % n) + n) % n));
	let busy = false;
	let waiting = false;

	if (state.scrubbing) {
		// Regler wird von Hand gezogen: Das Bild folgt der Position. Was schon
		// geladen ist, wird sofort überblendet; der Rest lädt beim Ziehen nach.
		const base = Math.min(n - 1, Math.floor(state.pos));
		const next = Math.min(n - 1, base + 1);
		const f = state.pos - base;
		const near = [...new Set([base - 1, base, next, base + 2].filter((i) => i >= 0 && i < n))];
		ensure(near);
		const keep = new Set(near.map(frameKey));
		for (const key of keys) {
			const A = at(key, base);
			const B = at(key, next);
			const nearest = f < 0.5 ? A : B;
			const all = [...frames[key].values()];
			if (A.loaded && B.loaded) {
				for (const fr of all) {
					if (fr === A) applyOpacity(fr, A === B ? 1 : 1 - f, zoom);
					else if (fr === B) applyOpacity(fr, f, zoom);
					else if (keep.has(fr.mapKey)) applyOpacity(fr, 0, zoom);
					else disposeFrame(fr);
				}
			} else if (nearest.loaded) {
				for (const fr of all) {
					if (fr === nearest) applyOpacity(fr, 1, zoom);
					else if (keep.has(fr.mapKey)) applyOpacity(fr, 0, zoom);
					else disposeFrame(fr);
				}
			} else {
				// noch nichts Passendes geladen: das bisherige Bild stehen lassen
				waiting = true;
				for (const fr of all) if (!keep.has(fr.mapKey) && fr.factor === 0) disposeFrame(fr);
			}
		}
	} else if (state.playing) {
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
		const advance = Math.min((dt / stepMs()) * state.rate * state.speed, reserve);
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
				map.setPaintProperty(target.id, 'raster-opacity', layerOpacityExpr(LAYERS[key]));
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
	if (state.axis === 'sat') {
		$('legend').innerHTML = '<div class="row">Echte Wolken aus dem Satellitenbild (Meteosat, EUMETSAT). Tagsüber in Echtfarben, nachts aus dem Infrarotbild. Auch Schnee erscheint weiß.</div>';
		return;
	}
	if (state.axis === 'radar') {
		// Farbskala direkt vom DWD-Kartendienst
		$('legend').innerHTML = `<div class="row">Regenradar (DWD), Niederschlag in mm/h<br /><img class="radarLegend" crossorigin="anonymous" alt="Farbskala des Regenradars" src="${RADAR_WMS}/ows?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=${RADAR_LAYER}" /></div>`;
		return;
	}
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
	const n = state.times.length;
	slider.max = Math.max(1, n - 1);
	slider.value = state.timeIndex;
	const at = (i) => `left:${(i / Math.max(1, n - 1)) * 100}%`;
	let html = '';
	if (isLive()) {
		// Radar/Satellit: volle Stunden und die Grenze zwischen Messung und Vorhersage
		const hm = fmt({ hour: '2-digit', minute: '2-digit' });
		const latest = state[state.axis].latest;
		state.times.forEach((ms, i) => {
			if (ms === latest) html += `<span class="nowTick" style="${at(i)}">jetzt</span>`;
			else if (ms % 3.6e6 === 0 && Math.abs(ms - latest) > 20 * 60e3) html += `<span style="${at(i)}">${hm.format(ms)}</span>`;
		});
	} else {
		const dayFmt = fmt({ weekday: 'short', day: '2-digit', month: '2-digit' });
		let last = dayKey(state.times[0]);
		state.times.forEach((ms, i) => {
			const k = dayKey(ms);
			if (k === last) return;
			last = k;
			const [wd, date] = dayFmt.format(ms).split(', ');
			html += `<span style="${at(i)}">${wd}<i>, ${date}</i></span>`;
		});
	}
	$('ticks').innerHTML = html;
	renderTimeLabel();
}

/* ------------------------------------------------------------------ *
 *  Temperaturzahlen auf der Karte
 *  Unter jedem sichtbaren Ortsnamen steht seine Temperatur: weit weg sind das
 *  Städte, nah herangezoomt Bezirke und Stadtteile. Sind die Namen
 *  ausgeblendet, gibt es stattdessen ein Raster aus Punkten.
 * ------------------------------------------------------------------ */
const tempCells = new Map(); // "lat,lon" → { at, t0, temps[] } (stündlich)
let tempPoints = [];
let tempSig = '';
let tempTimer = 0;
let tempReq = 0;
const TEMP_TTL = 30 * 60e3;
const tempsOn = () => $('toggleTemps').classList.contains('on');

function tempGrid() {
	const b = map.getBounds();
	const south = Math.max(-80, b.getSouth());
	const north = Math.min(80, b.getNorth());
	const west = b.getWest();
	const east = Math.min(b.getEast(), west + 360);
	// Schrittweite als Zweierpotenz, damit die Punkte beim Verschieben stehen bleiben
	let step = Math.max(1 / 64, 2 ** Math.ceil(Math.log2((east - west) / 5)));
	const count = (st) => (Math.floor(east / st) - Math.ceil(west / st) + 1) * (Math.floor(north / (st * 0.625)) - Math.ceil(south / (st * 0.625)) + 1);
	while (count(step) > 54) step *= 2;
	const points = [];
	const dLat = step * 0.625; // in Mitteleuropa etwa quadratische Zellen
	for (let j = Math.ceil(south / dLat); j * dLat <= north; j++) {
		for (let i = Math.ceil(west / step); i * step <= east; i++) {
			const lat = +(j * dLat).toFixed(4);
			const lon = +((((i * step + 180) % 360) + 360) % 360 - 180).toFixed(4);
			points.push({ lat, lon, key: `${lat},${lon}` });
		}
	}
	return points;
}

/** Orte, deren Namen gerade auf der Karte stehen (höchstens 45, ohne Doppelte). */
function tempPlaces() {
	const layers = ['places-big', 'places-small'].filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
	if (!layers.length) return [];
	const seen = new Set();
	const points = [];
	for (const f of map.queryRenderedFeatures({ layers })) {
		if (f.geometry.type !== 'Point' || points.length >= 45) continue;
		const lon = +f.geometry.coordinates[0].toFixed(2);
		const lat = +f.geometry.coordinates[1].toFixed(2);
		const key = `${lat},${lon}`;
		if (seen.has(key)) continue;
		seen.add(key);
		points.push({ lat, lon, key, place: true });
	}
	return points;
}

async function updateTemps() {
	if (!state.ready || !map.getSource('temps')) return;
	if (!tempsOn()) {
		tempPoints = [];
		tempSig = '';
		return renderTemps();
	}
	const places = tempPlaces();
	const points = places.length >= 3 ? places : tempGrid();
	const now = Date.now();
	const missing = points.filter((p) => !(tempCells.get(p.key)?.at > now - TEMP_TTL));
	const sig = points.map((p) => p.key).join('|');
	if (sig === tempSig && !missing.length) return; // nichts Neues: nicht neu zeichnen
	tempSig = sig;
	tempPoints = points;
	renderTemps();
	if (!missing.length) return;
	const req = ++tempReq;
	const params = new URLSearchParams({
		latitude: missing.map((p) => p.lat).join(','),
		longitude: missing.map((p) => p.lon).join(','),
		hourly: 'temperature_2m',
		forecast_days: '7',
		timeformat: 'unixtime'
	});
	try {
		const res = await fetch(`${FORECAST_API}?${params}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = [await res.json()].flat();
		data.forEach((d, i) => {
			if (missing[i] && d?.hourly) tempCells.set(missing[i].key, { at: now, t0: d.hourly.time[0] * 1000, temps: d.hourly.temperature_2m });
		});
		// alte Einträge verwerfen, damit der Speicher nicht wächst
		if (tempCells.size > 1500) for (const key of [...tempCells.keys()].slice(0, tempCells.size - 1000)) tempCells.delete(key);
		if (req === tempReq) renderTemps();
	} catch (err) {
		console.warn('Temperaturwerte für die Karte nicht erreichbar', err); // der Rest der App läuft weiter
	}
}

function renderTemps() {
	const source = state.ready && map.getSource('temps');
	if (!source) return;
	// Radar und Satellit zeigen Messzeiten; dort gelten die Werte der aktuellen Stunde
	const ms = isLive() ? Date.now() : state.times[state.timeIndex];
	const features = [];
	for (const p of tempPoints) {
		const cell = tempCells.get(p.key);
		const t = cell?.temps[Math.round((ms - cell.t0) / 3.6e6)];
		if (t == null) continue;
		features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { label: `${Math.round(t)}°`.replace('-', '−'), t, place: !!p.place } });
	}
	source.setData({ type: 'FeatureCollection', features });
}

function renderTimeLabel() {
	const ms = state.times[state.timeIndex];
	if (ms == null) return;
	renderTemps();
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
	setWaiting(state.waiting); // Statuszeile nachführen (Radar: Messung/Vorhersage)
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
	const m = state.model;
	const shown = state.axis === 'model' ? state.timeIndex : m.index;
	const keepMs = state.meta ? m.times[shown] : Date.now();
	state.meta = meta;
	// Der erste Zeitschritt ist der Startzustand des Modells und enthält noch keinen Niederschlag
	m.steps = meta.valid_times.slice(1);
	m.times = m.steps.map((t) => Date.parse(t.replace('Z', ':00Z')));
	m.index = 0;
	for (let i = 1; i < m.times.length; i++) if (Math.abs(m.times[i] - keepMs) < Math.abs(m.times[m.index] - keepMs)) m.index = i;
	// Bilder des alten Modelllaufs verwerfen
	for (const key of Object.keys(LAYERS)) if (!LIVE[key]) for (const frame of [...frames[key].values()]) disposeFrame(frame);
	if (state.axis !== 'model') return;
	state.times = m.times;
	state.timeIndex = state.target = m.index;
	state.pos = state.timeIndex;
	renderTimeline();
	refreshLayers();
}

/** Zeitpunkte von Radar (90 min zurück bis 2 h voraus, alle 5 min) oder Satellit (3 h zurück, alle 10 min). */
async function loadLiveTimes(axis) {
	const cfg = LIVE[axis];
	const r = state[axis];
	let end = 0;
	try {
		// Der Kartendienst nennt den letzten verfügbaren Zeitpunkt
		const res = await fetch(`${cfg.caps}?service=WMS&version=1.3.0&request=GetCapabilities`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const match = (await res.text()).match(/<Dimension name="time"[^>]*>[^<]*\/([^/<]+)\/PT\d+M\s*</);
		end = match ? Date.parse(match[1]) : 0;
	} catch (err) {
		console.warn(`${cfg.name}-Zeitangaben nicht erreichbar, rechne mit der Uhrzeit`, err);
	}
	// Notlösung ohne Dienst: aus der Uhrzeit und der üblichen Verzögerung
	if (!end || Math.abs(end - cfg.future - Date.now()) > 90 * 60e3) end = Math.floor((Date.now() - cfg.lag) / cfg.step) * cfg.step + cfg.future;
	const latest = end - cfg.future;
	if (latest === r.latest && r.times.length) return;
	const shownMs = state.axis === axis ? r.times[state.timeIndex] : null;
	const wasLatest = shownMs === r.latest;
	r.latest = latest;
	r.times = [];
	for (let t = latest - cfg.past; t <= end; t += cfg.step) r.times.push(t);
	r.index = r.times.indexOf(latest);
	if (state.axis !== axis) return;
	// Achse hat sich verschoben: vorhandene Bilder ihrer neuen Position zuordnen
	state.times = r.times;
	for (const frame of [...frames[axis].values()]) {
		const i = r.times.indexOf(frame.time);
		if (i < 0) disposeFrame(frame);
		else frame.index = i;
	}
	if (!state.playing) {
		const i = wasLatest || shownMs == null ? r.index : Math.max(0, r.times.indexOf(shownMs));
		state.timeIndex = state.target = i;
		state.pos = i;
	}
	renderTimeline();
	renderRadarInfo();
	kick();
}

/** Zwischen Vorhersagekarte ('model') und Regenradar ('radar') umschalten. */
async function setAxis(axis) {
	if (state.axis === axis) return;
	if (state.playing) setPlaying(false);
	if (LIVE[axis]) await loadLiveTimes(axis);
	state[state.axis].index = state.timeIndex;
	state.axis = axis;
	state.times = state[axis].times;
	state.timeIndex = state.target = LIVE[axis] ? state[axis].times.indexOf(state[axis].latest) : state.model.index;
	state.pos = state.timeIndex;
	clearTimeout(timeDebounce);
	renderChips();
	renderLegend();
	renderRadarInfo();
	renderTimeline();
	kick();
}

function renderChips() {
	for (const btn of document.querySelectorAll('#layerChips button')) {
		const key = btn.dataset.layer;
		btn.classList.toggle('on', LIVE[key] ? state.axis === key : !isLive() && state.enabled.has(key));
	}
}

function renderRadarInfo() {
	const box = $('radarInfo');
	box.hidden = !isLive();
	if (box.hidden) return;
	const hm = fmt({ hour: '2-digit', minute: '2-digit' });
	if (state.axis === 'sat') {
		const t = state.sat.times;
		box.textContent = `Satellitenbild (Meteosat, EUMETSAT) · echte Wolken von ${hm.format(t[0])} bis ${hm.format(state.sat.latest)} Uhr, alle 10 Minuten · ▶ zeigt, wie sie gezogen sind`;
		return;
	}
	const r = state.radar;
	const parts = [`Regenradar des DWD · Messung bis ${hm.format(r.latest)} Uhr, danach Vorhersage bis ${hm.format(r.times[r.times.length - 1])} Uhr`];
	if (state.steer) {
		// Niederschlagsgebiete ziehen grob mit dem Wind in etwa 3 km Höhe
		const to = (state.steer.dir + 180) % 360;
		parts.push(`Zugrichtung: <span class="arrow" style="transform:rotate(${to}deg)">↑</span> nach ${TOWARDS[Math.round(to / 45) % 8]}, etwa ${num(state.steer.speed)} km/h`);
	}
	box.innerHTML = parts.join(' · ');
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
		latitude: lat.toFixed(3),
		longitude: lon.toFixed(3),
		current:
			'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
		hourly: 'temperature_2m,precipitation,precipitation_probability,weather_code,is_day,wind_speed_700hPa,wind_direction_700hPa',
		// 15-Minuten-Werte (in Mitteleuropa direkt aus ICON-D2) für den Regen der nächsten 2 Stunden
		minutely_15: 'precipitation',
		forecast_minutely_15: '9',
		daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
		timezone: TZ,
		timeformat: 'unixtime',
		forecast_days: '7'
	});
	try {
		// ICON-D2 rechnet nur alle 3 Stunden neu; 10 Minuten Zwischenspeicher reichen locker
		const data = await cachedJson(`${FORECAST_API}?${params}`, 10 * 60e3);
		if (req !== state.forecastReq) return;
		renderNow(data);
		renderNowcast(data);
		const h = data.hourly;
		const i = h.time.findLastIndex((t) => t * 1000 <= Date.now());
		state.steer = i >= 0 && h.wind_direction_700hPa?.[i] != null ? { dir: h.wind_direction_700hPa[i], speed: h.wind_speed_700hPa[i] } : null;
		renderRadarInfo();
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

/** Regen in den nächsten 2 Stunden: kurzer Satz plus Balken je 15 Minuten. */
function renderNowcast({ minutely_15: m, current: c }) {
	const box = $('nowcast');
	const now = Date.now();
	const slots = (m?.time || [])
		.map((t, i) => ({ t: t * 1000, mm: m.precipitation[i] ?? 0 }))
		.filter((s) => s.t + 15 * 60e3 > now)
		.slice(0, 8);
	box.hidden = slots.length < 4;
	if (box.hidden) return;
	const wet = (s) => s.mm >= 0.1;
	const hm = fmt({ hour: '2-digit', minute: '2-digit' });
	const peak = Math.max(...slots.map((s) => s.mm)) * 4; // mm pro Stunde
	const snow = c?.temperature_2m <= 0.5;
	const kind = snow ? (peak < 2.5 ? 'Leichter Schneefall' : peak < 10 ? 'Schneefall' : 'Starker Schneefall') : peak < 2.5 ? 'Leichter Regen' : peak < 10 ? 'Regen' : 'Starker Regen';
	const firstWet = slots.findIndex(wet);
	let text;
	if (firstWet === -1) text = 'Die nächsten 2 Stunden trocken';
	else if (firstWet > 0) text = `${kind} ab ${hm.format(slots[firstWet].t)} Uhr`;
	else {
		const firstDry = slots.findIndex((s) => !wet(s));
		if (firstDry === -1) text = `${kind} hält die nächsten 2 Stunden an`;
		else if (slots.slice(firstDry).some(wet)) text = `${kind}, Pause ab etwa ${hm.format(slots[firstDry].t)} Uhr`;
		else text = `${kind} bis etwa ${hm.format(slots[firstDry].t)} Uhr`;
	}
	$('nowcastText').textContent = text;
	const max = Math.max(0.5, ...slots.map((s) => s.mm));
	$('nowcastBars').innerHTML = slots
		.map((s) => `<i class="${wet(s) ? 'wet' : ''}" style="height:${wet(s) ? Math.max(30, (s.mm / max) * 100) : 8}%" title="${hm.format(s.t)} Uhr: ${num(s.mm, 1)} mm"></i>`)
		.join('');
	$('nowcastAxis').innerHTML = `<span>${hm.format(slots[0].t)}</span><span>${hm.format(slots[4].t)}</span><span>${hm.format(slots[slots.length - 1].t + 15 * 60e3)}</span>`;
}

/* ------------------------------------------------------------------ *
 *  Amtliche Warnungen des DWD (über Bright Sky)
 * ------------------------------------------------------------------ */
const SEVERITY = {
	minor: { rank: 1, label: 'Wetterwarnung' },
	moderate: { rank: 2, label: 'Warnung vor markantem Wetter' },
	severe: { rank: 3, label: 'Unwetterwarnung' },
	extreme: { rank: 4, label: 'Warnung vor extremem Unwetter' }
};
const titleCase = (text) => (text || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

function alertElement(a) {
	const sev = SEVERITY[a.severity] || SEVERITY.minor;
	const when = fmt({ weekday: 'short', hour: '2-digit', minute: '2-digit' });
	const onset = Date.parse(a.onset || a.effective);
	const expires = a.expires ? Date.parse(a.expires) : null;
	const el = document.createElement('details');
	el.className = `alert glass sev${sev.rank}`;
	const summary = document.createElement('summary');
	const title = document.createElement('b');
	title.textContent = `⚠️ ${titleCase(a.event_de) || 'Warnung'}`;
	const time = document.createElement('small');
	time.textContent = `${sev.label} · ${onset > Date.now() ? `ab ${when.format(onset)} Uhr` : 'jetzt'}${expires ? ` bis ${when.format(expires)} Uhr` : ''}`;
	summary.append(title, time);
	el.append(summary);
	for (const text of [a.description_de, a.instruction_de]) {
		if (!text) continue;
		const p = document.createElement('p');
		p.textContent = text;
		el.append(p);
	}
	const src = document.createElement('p');
	src.className = 'src';
	src.textContent = 'Quelle: Deutscher Wetterdienst';
	el.append(src);
	return el;
}

async function loadAlerts(lat, lon) {
	const req = ++state.alertReq;
	const box = $('alerts');
	const none = $('warnState');
	try {
		// Warnungen ändern sich selten im Minutentakt; 5 Minuten Zwischenspeicher
		const data = await cachedJson(`${ALERTS_API}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, 5 * 60e3);
		if (req !== state.alertReq) return;
		const now = Date.now();
		const alerts = (data.alerts || [])
			.filter((a) => !a.expires || Date.parse(a.expires) > now)
			.sort((a, b) => (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0) || Date.parse(a.onset) - Date.parse(b.onset));
		// Die zwei wichtigsten Warnungen direkt zeigen, weitere hinter einem Aufklapper
		const items = alerts.map(alertElement);
		const rest = items.splice(2);
		if (rest.length) {
			const more = document.createElement('details');
			more.className = 'moreAlerts';
			const summary = document.createElement('summary');
			summary.textContent = rest.length === 1 ? '+ 1 weitere Warnung' : `+ ${rest.length} weitere Warnungen`;
			more.append(summary, ...rest);
			items.push(more);
		}
		box.replaceChildren(...items);
		none.hidden = alerts.length > 0;
		none.textContent = 'Keine amtlichen Warnungen (DWD)';
	} catch {
		// außerhalb Deutschlands gibt es keine DWD-Warnungen; bei Ausfall läuft der Rest weiter
		if (req !== state.alertReq) return;
		box.replaceChildren();
		none.hidden = true;
	}
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
	loadAlerts(lat, lon);
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
$('layerChips').addEventListener('click', async (e) => {
	const btn = e.target.closest('button[data-layer]');
	if (!btn) return;
	const key = btn.dataset.layer;
	if (LIVE[key]) {
		// Radar und Satellit haben eigene Zeitachsen und ersetzen solange die Vorhersage-Ebenen
		await setAxis(state.axis === key ? 'model' : key);
		return;
	}
	if (isLive()) {
		// zurück zur Vorhersagekarte, die gewählte Ebene ist dann sicher an
		state.enabled.add(key);
		await setAxis('model');
	} else if (state.enabled.has(key)) state.enabled.delete(key);
	else state.enabled.add(key);
	renderChips();
	kick();
	renderLegend();
});

$('toggle3d').addEventListener('click', (e) => {
	const on = e.currentTarget.classList.toggle('on');
	map.setTerrain(on ? TERRAIN : null);
	map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
	map.easeTo({ pitch: on ? 55 : 0, bearing: on ? map.getBearing() : 0, duration: 900 });
});

$('toggleTemps').addEventListener('click', (e) => {
	e.currentTarget.classList.toggle('on');
	updateTemps();
});

$('toggleLabels').addEventListener('click', (e) => {
	const on = e.currentTarget.classList.toggle('on');
	for (const id of LABEL_LAYERS) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
	updateTemps();
});

// Regler von Hand ziehen: Das Kartenbild läuft stufenlos mit (vor und zurück).
$('time').addEventListener('pointerdown', () => {
	if (!state.times.length) return;
	if (state.playing) setPlaying(false);
	clearTimeout(timeDebounce);
	state.scrubbing = true;
});
function endScrub() {
	if (!state.scrubbing) return;
	state.scrubbing = false;
	// beim Loslassen auf dem nächstgelegenen Zeitschritt einrasten
	setTimeIndex(Number($('time').value), { immediate: true, scroll: true });
}
$('time').addEventListener('change', endScrub);
window.addEventListener('pointerup', endScrub);
window.addEventListener('pointercancel', endScrub);
$('time').addEventListener('input', (e) => {
	const value = Number(e.target.value);
	if (!state.scrubbing) {
		// Tastatur o. Ä.: direkt zum Zeitschritt springen
		if (state.playing) setPlaying(false);
		return setTimeIndex(value, { scroll: true });
	}
	state.pos = Math.max(0, Math.min(state.times.length - 1, value));
	const nearest = Math.round(state.pos);
	if (nearest !== state.timeIndex) {
		state.timeIndex = nearest;
		renderTimeLabel()?.scrollIntoView({ inline: 'center', block: 'nearest' });
	}
	kick();
});

// Menüs ein- und ausklappen; die Wahl bleibt gespeichert
for (const [id, cls, open, closed] of [
	['toggleTop', 'top-collapsed', '▴', '▾ Menü'],
	['toggleBottom', 'bottom-collapsed', '▾ Einklappen', '▴ Vorhersage & Zeitleiste']
]) {
	const btn = $(id);
	const apply = (collapsed) => {
		document.body.classList.toggle(cls, collapsed);
		btn.textContent = collapsed ? closed : open;
		btn.setAttribute('aria-expanded', String(!collapsed));
		try {
			localStorage.setItem(cls, collapsed ? '1' : '');
		} catch {}
	};
	let saved = false;
	try {
		saved = localStorage.getItem(cls) === '1';
	} catch {}
	apply(saved);
	btn.addEventListener('click', () => apply(!document.body.classList.contains(cls)));
}
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

async function jumpTo(ms) {
	// Stunden und Tage der Übersicht beziehen sich auf die Vorhersagekarte
	if (isLive()) await setAxis('model');
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
// Wetterebenen starten, sobald der Kartenstil steht – nicht erst, wenn alle
// Satellitenkacheln da sind (das dauert bei langsamer Verbindung lange).
function startLayers() {
	if (state.ready) return;
	try {
		map.setTerrain(TERRAIN);
	} catch {
		return; // Stil noch nicht bereit; das nächste Ereignis versucht es erneut
	}
	state.ready = true;
	map.off('styledata', startLayers);
	map.addSource('temps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
	map.addLayer({
		id: 'temps',
		type: 'symbol',
		source: 'temps',
		layout: {
			'text-field': ['get', 'label'],
			'text-font': ['Noto Sans Bold'],
			'text-size': 16,
			// bei Ortsnamen direkt unter dem Namen, im Raster mittig auf dem Punkt
			'text-anchor': ['case', ['get', 'place'], 'top', 'center'],
			'text-offset': ['case', ['get', 'place'], ['literal', [0, 0.8]], ['literal', [0, 0]]],
			'text-allow-overlap': true,
			'text-ignore-placement': true
		},
		paint: {
			// Farbe wie die Temperaturskala: blau kalt, grün mild, rot heiß
			'text-color': ['interpolate', ['linear'], ['get', 't'], -15, '#9db8ff', 0, '#bfe3ff', 10, '#c9f7c0', 20, '#fff3a0', 30, '#ffb37a', 38, '#ff8a8a'],
			'text-halo-color': 'rgba(5,10,20,.92)',
			'text-halo-width': 2
		}
	});
	// 'idle': Karte ist fertig gezeichnet, erst dann stehen die sichtbaren Ortsnamen fest
	map.on('idle', () => {
		clearTimeout(tempTimer);
		tempTimer = setTimeout(updateTemps, 250);
	});
	updateTemps();
	updateViewMode();
	refreshLayers();
}
map.on('styledata', startLayers);
map.once('load', startLayers);
// neuen Modelllauf übernehmen, wenn die Seite lange offen bleibt
setInterval(() => loadMeta().catch(() => {}), 20 * 60 * 1000);
// Radar, Warnungen und Vorhersage am gewählten Ort regelmäßig auffrischen
setInterval(() => {
	if (document.hidden) return;
	if (isLive()) loadLiveTimes(state.axis);
	if (state.point) {
		loadForecast(state.point.lat, state.point.lon);
		loadAlerts(state.point.lat, state.point.lon);
	}
}, 5 * 60 * 1000);
