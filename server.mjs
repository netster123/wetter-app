// Kleiner statischer Server ohne Abhängigkeiten.
// Die COOP/COEP-Header machen die Seite "cross-origin isolated"; damit kann die
// Open-Meteo-Kartenbibliothek Wetterdaten ohne Kopieren an ihre Worker geben
// und die Karte bleibt beim Zoomen flüssig.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

const MOUNTS = [
	['/vendor/maplibre/', join(ROOT, 'node_modules/maplibre-gl/dist')],
	['/vendor/om/', join(ROOT, 'node_modules/@openmeteo/weather-map-layer/dist')],
	['/', join(ROOT, 'public')]
];

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon'
};

createServer(async (req, res) => {
	try {
		let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
		if (path === '/') path = '/index.html';
		const mount = MOUNTS.find(([prefix]) => path.startsWith(prefix));
		const base = resolve(mount[1]);
		const file = resolve(join(base, normalize(path.slice(mount[0].length))));
		if (file !== base && !file.startsWith(base + sep)) throw new Error('forbidden');
		if (!(await stat(file)).isFile()) throw new Error('not a file');
		res.writeHead(200, {
			'Content-Type': MIME[extname(file)] || 'application/octet-stream',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Cache-Control': path.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache'
		});
		res.end(await readFile(file));
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Nicht gefunden');
	}
}).listen(PORT, () => {
	console.log(`Wetter-App läuft auf http://localhost:${PORT}`);
	// Adressen für andere Geräte im selben WLAN (z. B. das iPhone)
	for (const list of Object.values(networkInterfaces())) {
		for (const net of list ?? []) {
			if (net.family === 'IPv4' && !net.internal) console.log(`Im WLAN erreichbar unter http://${net.address}:${PORT}`);
		}
	}
});
