// Baut den Ordner dist/ – eine reine Sammlung statischer Dateien, die sich bei
// jedem Webhoster (Netlify, Cloudflare Pages, …) hochladen lässt.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/vendor`, { recursive: true });
await cp(`${root}public`, dist, { recursive: true });
const skip = (src) => !/(-dev\.mjs|\.map|\.d\.ts)$/.test(src);
await cp(`${root}node_modules/maplibre-gl/dist`, `${dist}/vendor/maplibre`, { recursive: true, filter: skip });
await cp(`${root}node_modules/@openmeteo/weather-map-layer/dist`, `${dist}/vendor/om`, { recursive: true, filter: skip });

// Dieselben Header wie server.mjs (Format von Netlify und Cloudflare Pages)
await writeFile(
	`${dist}/_headers`,
	['/*', '  Cross-Origin-Opener-Policy: same-origin', '  Cross-Origin-Embedder-Policy: require-corp', ''].join('\n')
);
console.log('Fertig: dist/');
