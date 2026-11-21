// `npm run dev:server`: runs the server under `tsx watch` on the API port Vite proxies to
// (API_PORT, or PORT + 1). A script rather than `PORT=$((…)) tsx …` in package.json, because
// npm runs scripts with cmd.exe on Windows, which has no such syntax.
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 4100);
const api = process.env.API_PORT || String(port + 1);
const child = spawn('tsx', ['watch', '--clear-screen=false', 'src/server/server.ts'], {
  stdio: 'inherit', shell: true, env: { ...process.env, PORT: api },
});
child.on('exit', code => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
