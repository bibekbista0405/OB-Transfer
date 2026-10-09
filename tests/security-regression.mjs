import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const server = read('server.ts');
const app = read('src/app.js');
const api = read('src/modules/api.js');
const vite = read('vite.config.ts');
const html = read('index.html');
const gitignore = read('.gitignore');
const pkg = JSON.parse(read('package.json'));
const css = read('src/style.css');
const env = read('.env');

function check(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS  ${name}`);
}

check('project identity is OB Transfer', pkg.name === 'ob-transfer' && !server.match(/Nebula|Gemini|AI Studio|react-example/i));
check('no legacy Gemini/AI branding remains in source', ![server, app, api, vite, html].join('\n').match(/Gemini|Google AI|AI Studio|Nebula|Generative AI/i));
check('Socket.IO client uses same-origin defaults', /window\.io\(\)/.test(app) && !/io\(['"]https?:/.test(app));
check('Socket.IO validates allowed origins', /allowRequest:\s*\(request, callback\)/.test(server) && /allowedOrigins\.has/.test(server));
check('development loopback origins are explicitly controlled', /127\.0\.0\.1/.test(server) && /localhost/.test(server));
check('Vite HMR uses the application HTTP server', /hmr:\s*\{\s*server:\s*app\.server/.test(server));
check('CSP does not allow Vite 24678 wildcard/transient socket', !/24678/.test(server));
check('CSP allows the canonical application WebSocket', /connectSrc:\s*\[.*websocketOrigins/.test(server));
check('CSP permits Socket.IO source-map requests', /https:\/\/cdn\.socket\.io/.test(server));
check('CSP has no wildcard connect source', !/connectSrc[^\n]*['"]\*['"]/.test(server));
check('authentication remains cookie-based', /HttpOnly; SameSite=Lax/.test(server) && !/localStorage.*password|x-access-password|\?auth=/.test(app + api + server));
check('runtime uploads remain Git-ignored', /uploads\/\*/.test(gitignore) && /!uploads\/\.gitkeep/.test(gitignore));
check('automated test script is registered', pkg.scripts.test === 'node tests/security-regression.mjs');
check('production configuration fails closed', /Production requires APP_URL to use HTTPS/.test(server) && /Production requires ACCESS_PASSWORD/.test(server));
check('runtime port and host are configurable', /parsePort\(process\.env\.PORT, 3000\)/.test(server) && /process\.env\.HOST \|\| '0\.0\.0\.0'/.test(server));
check('sensitive request headers are redacted from logs', /req\.headers\.cookie/.test(server) && /req\.headers\.authorization/.test(server) && /set-cookie/.test(server));
check('production request body limit is bounded', /bodyLimit: 1 \* 1024 \* 1024/.test(server));
check('health endpoint is available without API authentication', /app\.get\('\/healthz'/.test(server) && /if \(request\.url\.startsWith\('\/api'\)/.test(server));
check('graceful shutdown handles process signals', /process\.once\('SIGINT'/.test(server) && /process\.once\('SIGTERM'/.test(server) && /await app\.close\(\)/.test(server));
check('database and realtime resources close during shutdown', /db\?\.close\(\)/.test(server) && /io\.disconnectSockets\(true\)/.test(server));
check('production startup uses configured port', /const PORT = runtime\.port/.test(server));
check('startup has no duplicate isProduction declaration', (() => {
  const startBlock = server.slice(server.indexOf('async function start()'));
  return (startBlock.match(/const isProduction = process\.env\.NODE_ENV === 'production';/g) || []).length === 1;
})());

for (const file of ['src/app.js', 'src/modules/api.js', 'src/modules/constants.js', 'src/modules/dom.js', 'src/modules/state.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  console.log(`PASS  JavaScript syntax: ${file}`);
}


check('requested local development password is configured', /^ACCESS_PASSWORD=bibekbista$/m.test(env));
check('default password is not placed in the committed env template', !/^ACCESS_PASSWORD=bibekbista$/m.test(read('.env.example')));
check('media-first gallery supports all and dedicated media filters', ['all', 'image', 'video', 'audio', 'document'].every(category => html.includes(`data-category="${category}"`)));
check('theme toggle persists light/dark preference without storing credentials', /ob-transfer-theme/.test(app) && /applyTheme\(ui\.theme === 'dark' \? 'light' : 'dark'\)/.test(app) && !/localStorage.*password/i.test(app));
check('gallery has sorting and grid/list layout controls', /id="fileSort"/.test(html) && /id="gridViewBtn"/.test(html) && /id="listViewBtn"/.test(html) && /data-layout="list"/.test(css));
check('photo thumbnails lazy-load and decode asynchronously', /image\.loading = 'lazy'/.test(app) && /image\.decoding = 'async'/.test(app));
check('video gallery thumbnails load lazily near the viewport', /new IntersectionObserver/.test(app) && /videoThumb\.preload = 'metadata'/.test(app) && /rootMargin: '180px 0px'/.test(app));
check('preview failures show recoverable guidance', /PREVIEW UNAVAILABLE/.test(app) && /Try downloading the original file/.test(app));
check('upload success schedules authoritative file-list refresh', /scheduleFileSync\(\)/.test(app) && /ui\.refreshTimer = setTimeout\(\(\) => \{ ui\.refreshTimer = null; fetchFiles\(\); \}, 250\)/.test(app));
check('upload concurrency slots are released once, including cancellation', /releaseUploadSlot/.test(app) && !/state\.activeUploads--/.test(app) && /xhr\.addEventListener\('abort'/.test(app));
check('existing mobile video player controls and inline playback remain unchanged', /video\.controls = true;/.test(app) && /video\.playsInline = true;/.test(app) && /video\.preload = 'auto';/.test(app) && /video\.className = 'w-full h-full max-h-\[85vh\] object-contain';/.test(app));
check('reduced-motion preference is respected', /prefers-reduced-motion: reduce/.test(css) && /prefers-reduced-motion: reduce/.test(app));

console.log('\nAll Phase 22 security, UX, and regression checks passed.');
