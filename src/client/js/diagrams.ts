// Diagrams in replies. Every desktop app draws a ```mermaid block as a picture, so the console does
// too, for every engine: markdown() leaves a .md-diagram placeholder holding the source, and this
// module draws each one as it appears. The library (3 MB) loads only when a page has a diagram.
// Drawn pictures are cached by source and theme, so a re-rendered message gets its picture back in
// the same frame instead of flickering through the source again.
import type { Mermaid } from 'mermaid';

const cache = new Map<string, string | null>();
let library: Promise<Mermaid> | null = null, queue: Promise<unknown> = Promise.resolve(), sequence = 0;

const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
// Its own chunk, fetched the first time a page has a diagram. A failed fetch is tried again next time.
function load(): Promise<Mermaid> {
  library ||= import('mermaid').then(module => module.default, () => { library = null; throw new Error('mermaid unavailable'); });
  return library;
}
function show(node: HTMLElement, svg: string | null | undefined): void {
  node.querySelector('.md-diagram-view')?.remove();
  if (!svg) { node.dataset.drawn = 'failed'; return; }
  const view = document.createElement('div');
  view.className = 'md-diagram-view'; view.innerHTML = svg;
  node.prepend(view); node.dataset.drawn = 'yes';
}
// mermaid renders one diagram at a time; each waits for the one before it.
type Theme = 'dark' | 'neutral';
function render(source: string, theme: Theme): Promise<string | null> {
  const run = queue.then(async () => {
    const mermaid = await load();
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true, fontFamily: 'inherit' });
    try { return (await mermaid.render(`md-diagram-${++sequence}`, source)).svg; }
    catch { return null; } // incomplete (still streaming) or invalid: the source stays visible
  });
  queue = run.catch(() => {});
  return run;
}
function draw(node: HTMLElement): void {
  const source = node.querySelector('.md-diagram-source code')?.textContent || '';
  const theme: Theme = dark() ? 'dark' : 'neutral', key = `${theme}\n${source}`;
  node.dataset.drawn = 'pending'; node.dataset.theme = theme;
  if (cache.has(key)) return show(node, cache.get(key));
  render(source, theme).then(svg => { cache.set(key, svg); if (node.isConnected && node.dataset.theme === theme) show(node, svg); }, () => { node.dataset.drawn = 'failed'; });
}
const scan = () => { for (const node of document.querySelectorAll<HTMLElement>('.md-diagram:not([data-drawn])')) draw(node); };
// Markup changes (new or re-rendered messages) and theme switches both redraw what is on the page.
const redraw = () => { for (const node of document.querySelectorAll('.md-diagram[data-drawn]')) node.removeAttribute('data-drawn'); scan(); };
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
scan();
