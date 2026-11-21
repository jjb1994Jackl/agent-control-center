import { t } from './i18n.js';
// The person's own avatar in the sidebar's corner: a small made-up character, drawn from a
// random seed kept in the browser (nothing is read from any account). Same seed, same face.
function generator(seed: unknown): () => number {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ (char.codePointAt(0) ?? 0), 16777619);
  return () => { state |= 0; state = state + 0x6D2B79F5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const newAvatarSeed = () => Math.random().toString(36).slice(2, 10);
type Draw = (color: string) => string;
const HAIR: [Draw, ...Draw[]] = [
  // short
  hair => `<path d="M16.5 30c-1-11 6-19 15.5-19s16.5 8 15.5 19c-3-6-8-9-15.5-9s-12.5 3-15.5 9z" fill="${hair}"/>`,
  // bob
  hair => `<path d="M15 44V28c0-10 7.5-17 17-17s17 7 17 17v16h-6V29c-3-5-7-7-11-7s-8 2-11 7v15z" fill="${hair}"/>`,
  // buns
  hair => `<circle cx="18.5" cy="15" r="5.5" fill="${hair}"/><circle cx="45.5" cy="15" r="5.5" fill="${hair}"/><path d="M16.5 30c-1-11 6-19 15.5-19s16.5 8 15.5 19c-3-6-8-9-15.5-9s-12.5 3-15.5 9z" fill="${hair}"/>`,
  // tufts
  hair => `<path d="M16.5 30c-1-9 3-15 7-17l1 4 4-6 3 5 4-5 2 6 5-3c3 3 5 9 4.5 16-3-6-8-9-15.5-9s-12.5 3-15.5 9z" fill="${hair}"/>`,
];
const EYES: [string, ...string[]] = [
  '<circle cx="26" cy="31.5" r="1.9"/><circle cx="38" cy="31.5" r="1.9"/>',
  '<path d="M23.8 32.2q2.2-2.8 4.4 0M35.8 32.2q2.2-2.8 4.4 0" fill="none" stroke="#3a2a25" stroke-width="1.6" stroke-linecap="round"/>',
  '<circle cx="26" cy="31.5" r="1.9"/><path d="M35.8 32q2.2-2.4 4.4 0" fill="none" stroke="#3a2a25" stroke-width="1.6" stroke-linecap="round"/>',
];
const EXTRAS: [Draw, ...Draw[]] = [
  () => '',
  () => '<g fill="none" stroke="#3a2a25" stroke-width="1.3"><circle cx="26" cy="31.5" r="4.3"/><circle cx="38" cy="31.5" r="4.3"/><path d="M30.3 31.5h3.4"/></g>',
  accent => `<path d="M15.5 31c0-11 7-18.5 16.5-18.5S48.5 20 48.5 31" fill="none" stroke="${accent}" stroke-width="2.6" stroke-linecap="round"/><rect x="12.5" y="27.5" width="5.5" height="9.5" rx="2.7" fill="${accent}"/><rect x="46" y="27.5" width="5.5" height="9.5" rx="2.7" fill="${accent}"/>`,
  () => '',
];
export function avatarSvg(seed?: string | null): string {
  const random = generator(seed || 'guest');
  // Every list below is non-empty, so the index always lands on an item.
  const pick = <T>(list: readonly [T, ...T[]]): T => list[Math.floor(random() * list.length)] ?? list[0];
  const ground = pick(['#FFD9C7', '#CFE8FF', '#D9F2D0', '#FFE8A8', '#E5D9FF', '#FFD6E8', '#CFF1EC']);
  const skin = pick(['#FFE3C8', '#F8D2AC', '#E6B386', '#C48A5E', '#94623F']);
  const hair = pick(['#2B2B2B', '#5A3A22', '#8C5A2B', '#D9A441', '#B5462F', '#6B6FD6', '#3F8F7B']);
  const shirt = pick(['#5B7BFA', '#D97757', '#3FA37C', '#F0A83A', '#8E6BD8', '#E26D8E']);
  const style = pick(HAIR), eyes = pick(EYES), extra = pick(EXTRAS);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${t('我的头像')}"><g><rect width="64" height="64" fill="${ground}"/><path d="M11 66c0-13 9.5-19 21-19s21 6 21 19z" fill="${shirt}"/><circle cx="32" cy="30" r="15" fill="${skin}"/>${style(hair)}<g fill="#3a2a25">${eyes}</g><circle cx="22.5" cy="36.5" r="2.6" fill="#ff8fa3" opacity=".5"/><circle cx="41.5" cy="36.5" r="2.6" fill="#ff8fa3" opacity=".5"/><path d="M28.5 37.5q3.5 3.6 7 0" fill="none" stroke="#3a2a25" stroke-width="1.6" stroke-linecap="round"/>${extra(shirt)}<path d="M52 9l1.3 3.2L56.5 13.5l-3.2 1.3L52 18l-1.3-3.2-3.2-1.3 3.2-1.3z" fill="#fff" opacity=".9"/></g></svg>`;
}
