import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
const supportsProxy = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
if (supportsProxy && process.platform === 'darwin' && !env.https_proxy && !env.HTTPS_PROXY) {
  try {
    const lines = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
    const pairs = [...lines.matchAll(/^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort)\s*:\s*(\S+)\s*$/gm)];
    const proxy = Object.fromEntries(pairs.map(([, key, value]) => [key, value]));
    const host = proxy.HTTPSProxy ?? '';
    const port = Number(proxy.HTTPSPort);
    if (proxy.HTTPSEnable === '1' && /^[a-z0-9.-]+$/i.test(host) && Number.isInteger(port) && port > 0 && port < 65536)
      env.HTTPS_PROXY = `http://${host}:${port}`;
  } catch {
    // If no system proxy is available, keep the user's direct connection.
  }
}
const proxied = supportsProxy && Boolean(env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY);
if (proxied) {
  const noProxy = [env.no_proxy || env.NO_PROXY, 'localhost,127.0.0.1,::1,[::1]'].filter(Boolean).join(',');
  env.NO_PROXY = env.no_proxy = noProxy;
}
const server = fileURLToPath(new URL('../dist/server/server.js', import.meta.url));
const child = spawn(process.execPath, [...(proxied ? ['--use-env-proxy'] : []), server], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 0); });
