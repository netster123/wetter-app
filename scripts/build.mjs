// Baut den Ordner dist/ – eine reine Sammlung statischer Dateien, die sich bei
// jedem Webhoster (Netlify, Cloudflare Pages, …) hochladen lässt.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/vendor`, { recursive: true });
await cp(`${root}public`, dist, { recursive: true });
const skip = (src) => !/(-dev\.mjs|\.map|\.d\.ts)$/.test(src);
await cp(`${root}node_modules/maplibre-gl/dist`, `${dist}/vendor/maplibre`, { recursive: true, filter: skip });
await cp(`${root}node_modules/@openmeteo/weather-map-layer/dist`, `${dist}/vendor/om`, { recursive: true, filter: skip });

// Versionsstempel: Ändert sich app.js oder style.css, bekommt die Datei eine neue
// Adresse (app.js?v=…). So laden Browser – vor allem das iPhone – nach einem
// Update sicher die neue Fassung statt einer zwischengespeicherten alten.
let html = await readFile(`${dist}/index.html`, 'utf8');
for (const file of ['app.js', 'style.css']) {
	const hash = createHash('sha1').update(await readFile(`${dist}/${file}`)).digest('hex').slice(0, 10);
	if (!html.includes(`"${file}"`)) throw new Error(`${file} nicht in index.html gefunden`);
	html = html.replace(`"${file}"`, `"${file}?v=${hash}"`);
}
// Stand der App: steht in der Seite und in version.json. Die App vergleicht beide
// beim Öffnen und lädt sich neu, wenn online eine neuere Fassung liegt – wichtig
// für die Home-Bildschirm-App auf dem iPhone, die sonst lange die alte behält.
const stamp = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date()).replace(',', '');
const version = `${stamp} (${createHash('sha1').update(html).digest('hex').slice(0, 6)})`;
if (!html.includes('name="app-version" content="dev"')) throw new Error('app-version nicht in index.html gefunden');
html = html.replace('name="app-version" content="dev"', `name="app-version" content="${version}"`);
await writeFile(`${dist}/index.html`, html);
await writeFile(`${dist}/version.json`, JSON.stringify({ version }));

// Dieselben Header wie server.mjs (Format von Netlify und Cloudflare Pages)
await writeFile(
	`${dist}/_headers`,
	['/*', '  Cross-Origin-Opener-Policy: same-origin', '  Cross-Origin-Embedder-Policy: require-corp', ''].join('\n')
);
console.log('Fertig: dist/');
