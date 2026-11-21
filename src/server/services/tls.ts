import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Browsers expose the microphone only to secure origins, so a console opened from
// another device needs HTTPS. A self-signed certificate covers localhost, this
// machine's name and its current LAN addresses; it is regenerated when they change.
function localNames(): { dns: string[]; ips: string[] } {
  const ips = Object.values(os.networkInterfaces()).flat().filter((item): item is os.NetworkInterfaceInfo => !!item && item.family === 'IPv4').map(item => item.address);
  const host = os.hostname().replace(/\.local$/, '');
  return { dns: [...new Set(['localhost', host, `${host}.local`])], ips: [...new Set(['127.0.0.1', ...ips])] };
}
function ensureCertificate(dir: string): { key: Buffer; cert: Buffer; names: { dns: string[]; ips: string[] } } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), stamp = path.join(dir, 'names.json');
  const names = localNames(), wanted = JSON.stringify(names);
  const current = fs.existsSync(stamp) && fs.existsSync(key) && fs.existsSync(cert) ? fs.readFileSync(stamp, 'utf8') : '';
  if (current !== wanted) {
    const san = [...names.dns.map(name => `DNS:${name}`), ...names.ips.map(ip => `IP:${ip}`)].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', key, '-out', cert, '-subj', '/CN=Agent Frontdesk (local)', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
    fs.writeFileSync(stamp, wanted);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), names };
}
export { ensureCertificate, localNames };
