import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const service = process.env.ACC_MANAGED === '1' ? 'AgentControlCenter.Preview.GrokRoutine' : 'AgentControlCenter.GrokRoutine';
async function item(account: string, reveal: boolean) {
  const args = ['find-generic-password', '-s', service, '-a', account];
  if (reveal) args.push('-w');
  return (await exec('/usr/bin/security', args, { timeout: 12000, maxBuffer: 8192 })).stdout.trim();
}
export async function grokConfigured() {
  try {
    await item('url', false);
    await item('key', false);
    return true;
  } catch {
    return false;
  }
}
export async function sendRoutine(
  url: string,
  key: string,
  id: string,
  prompt: string,
  send: typeof fetch = fetch,
) {
  const dest = new URL(url);
  if (dest.protocol !== 'https:' || dest.username || dest.password || !key) throw new Error('Routine 配置无效');
  const response = await send(dest, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key.replace(/^Bearer\s+/i, '') },
    body: JSON.stringify({ taskId: id, prompt }),
  });
  await response.body?.cancel();
  if (response.status === 200) return { state: 'accepted', note: '已受理，结果在 Grok Bot 查看' };
  return { state: 'failed', note: 'Routine 未受理：HTTP ' + response.status };
}
export async function grokDispatch(id: string, prompt: string) {
  let url: string, key: string;
  try {
    url = await item('url', true);
    key = await item('key', true);
  } catch {
    return { state: 'failed', note: '未发送：Grok Routine 钥匙串凭据未配置或未解锁' };
  }
  try {
    return await sendRoutine(url, key, id, prompt);
  } catch {
    return { state: 'uncertain', note: '未取得可确认的回执，请核对 Grok Bot；未自动重发' };
  }
}
