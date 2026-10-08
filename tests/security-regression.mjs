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

for (const file of ['src/app.js', 'src/modules/api.js', 'src/modules/constants.js', 'src/modules/dom.js', 'src/modules/state.js']) {
  execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  console.log(`PASS  JavaScript syntax: ${file}`);
}

console.log('\nAll Phase 19 production-hardening regression checks passed.');
