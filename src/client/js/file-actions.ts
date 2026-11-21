// A file the reply names can be taken to where the person works with it: selected in the system's
// file manager, or opened in the agent's desktop app, in this chat (the desktop presses its own link).
// The same two actions sit on a hovered file link (a small box above it) and on the side panel's
// preview of that file. Which ones an engine offers is in its manifest (capabilities.openFile);
// the server does the opening (POST …/reveal), so this only draws and asks.
import { t } from './i18n.js';
import { escape, icon, hydrateIcons } from './renderers.js';
import { closest, nodeOf } from './dom.js';
import type { EngineManifest } from '../../shared/contract.js';

export interface FileAction { id: 'finder' | 'desktop'; icon: string; label: string }

// The server says which file manager its machine has: 'finder', 'explorer' or 'files'.
export function fileActions({ fileManager, engine }: { fileManager: string | undefined; engine?: Pick<EngineManifest, 'label' | 'capabilities'> | null | undefined }): FileAction[] {
  const list: FileAction[] = [{ id: 'finder', icon: 'folder-search', label: fileManager === 'finder' ? t('在 Finder 中显示') : fileManager === 'explorer' ? t('在资源管理器中显示') : t('在文件管理器中显示') }];
  if (engine?.capabilities?.openFile) list.push({ id: 'desktop', icon: 'app-window', label: t('在 {name} 中打开', { name: engine.label }) });
  return list;
}
export const actionButtons = (list: FileAction[], extra = ''): string => list.map(item => `<button type="button" class="${extra}" data-file-action="${item.id}" title="${escape(item.label)}" aria-label="${escape(item.label)}">${icon(item.icon)}<span>${escape(item.label)}</span></button>`).join('');

// The box over a hovered file link. `within`: the elements whose file links get it; `actions(link)`
// → the list above; `run(action, link)` does it (and reports any failure itself).
// Only where there is a mouse: on touch a tap still previews, and the side panel has the buttons.
export interface FilePopoverOptions { within: Iterable<HTMLElement>; actions(link: HTMLElement): FileAction[]; run(action: string, link: HTMLElement): Promise<unknown>; hover?: MediaQueryList }
export function filePopover({ within, actions, run, hover = matchMedia('(hover: hover)') }: FilePopoverOptions): { close(): void; element: HTMLDivElement } {
  const pop = document.createElement('div');
  pop.className = 'file-pop'; pop.hidden = true; pop.setAttribute('role', 'toolbar'); pop.setAttribute('aria-label', t('文件操作'));
  document.body.append(pop);
  let link: HTMLElement | null = null, showTimer = 0, hideTimer = 0;
  const place = (target: HTMLElement) => {
    const box = target.getBoundingClientRect(), size = pop.getBoundingClientRect();
    let top = box.top - size.height - 6, side = 'above';
    if (top < 8) { top = box.bottom + 6; side = 'below'; }
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(Math.min(Math.max(8, box.left + box.width / 2 - size.width / 2), innerWidth - size.width - 8))}px`;
    pop.dataset.side = side;
  };
  const open = (target: HTMLElement) => {
    clearTimeout(hideTimer);
    if (link === target && !pop.hidden) return;
    const list = actions(target);
    if (!list.length) return;
    link = target;
    pop.innerHTML = `<span class="file-pop-path" title="${escape(target.dataset['filePath'])}">${escape(target.dataset['filePath'])}</span><span class="file-pop-actions">${actionButtons(list)}</span>`;
    hydrateIcons(pop); pop.hidden = false; place(target);
  };
  const close = () => { clearTimeout(showTimer); clearTimeout(hideTimer); pop.hidden = true; link = null; };
  const later = () => { clearTimeout(showTimer); clearTimeout(hideTimer); hideTimer = window.setTimeout(close, 200); };
  for (const root of within) {
    root.addEventListener('mouseover', event => {
      const target = hover.matches && closest(event.target, '.file-link');
      if (!target) return;
      clearTimeout(hideTimer); clearTimeout(showTimer);
      showTimer = window.setTimeout(() => open(target), pop.hidden ? 350 : 60);
    });
    root.addEventListener('mouseout', event => {
      const target = closest(event.target, '.file-link'), next = nodeOf(event.relatedTarget);
      if (target && !target.contains(next) && !pop.contains(next)) later();
    });
    root.addEventListener('scroll', close, { passive: true, capture: true });
  }
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', event => { if (event.relatedTarget !== link) later(); });
  pop.addEventListener('click', async event => {
    const button = closest(event.target, '[data-file-action]', HTMLButtonElement);
    if (!button || !link) return;
    const target = link;
    button.disabled = true;
    try { await run(button.dataset['fileAction'] || '', target); close(); } finally { button.disabled = false; }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !pop.hidden) close(); });
  addEventListener('resize', close);
  return { close, element: pop };
}
