// Our own dropdowns instead of the operating system's. A native <select> stays in the
// page as the source of truth (value, options, disabled, hidden, change events), so the
// rest of the app keeps reading and setting it; this draws a button and a listbox for it.
import { find, nodeOf } from './dom.js';

export interface MenuItem { value: string; label: string; hint?: string; description?: string; selected?: boolean; group?: string | undefined }
interface OpenMenu { menu: HTMLElement; anchor: HTMLElement; onClose?: (() => void) | undefined }
const open: { menu: OpenMenu | null } = { menu: null };

function place(menu: HTMLElement, anchor: HTMLElement, point?: { x: number; y: number }): void {
  // At the pointer (a menu opened by right-click), kept on the page.
  if (point) {
    menu.style.minWidth = '180px';
    menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - menu.offsetHeight - 8))}px`;
    menu.dataset.side = 'below';
    return;
  }
  const box = anchor.getBoundingClientRect(), gap = 6;
  menu.style.minWidth = `${Math.max(box.width, 180)}px`;
  const height = menu.offsetHeight, width = menu.offsetWidth;
  const below = innerHeight - box.bottom - gap >= height || box.top < height + gap;
  menu.style.top = `${below ? box.bottom + gap : box.top - gap - height}px`;
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  menu.dataset.side = below ? 'below' : 'above';
}

export function closeMenu(): void {
  const current = open.menu; if (!current) return;
  open.menu = null; current.menu.remove(); current.anchor.setAttribute('aria-expanded', 'false');
  current.onClose?.();
}

// A popover list. items: [{ value, label, hint?, selected?, group? }].
/** `at`: where the pointer was, for a menu opened by right-click (it opens there instead of under its anchor). */
export interface MenuOptions<T extends MenuItem> { onPick?: (item: T) => void; onClose?: () => void; label?: string; at?: { x: number; y: number } }
export function showMenu<T extends MenuItem>(anchor: HTMLElement, items: T[], { onPick, onClose, label = '', at }: MenuOptions<T> = {}): HTMLElement | undefined {
  if (open.menu?.anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu-popover'; menu.setAttribute('role', 'listbox'); if (label) menu.setAttribute('aria-label', label);
  if (anchor.dataset.for) menu.dataset.for = anchor.dataset.for;
  let group: string | null = null;
  items.forEach((item, index) => {
    if (item.group && item.group !== group) {
      group = item.group;
      const heading = document.createElement('div'); heading.className = 'menu-group'; heading.textContent = group; menu.append(heading);
    }
    const option = document.createElement('button');
    option.type = 'button'; option.className = 'menu-option'; option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(!!item.selected)); option.dataset.index = String(index);
    option.innerHTML = '<span class="menu-check" aria-hidden="true"></span><span class="menu-label"></span>';
    const labelText = find(option, '.menu-label');
    if (labelText) labelText.textContent = item.label;
    if (item.description) { option.classList.add('has-description'); const text = document.createElement('span'); text.className = 'menu-description'; text.textContent = item.description; labelText?.after(text); }
    if (item.hint) { const hint = document.createElement('span'); hint.className = 'menu-hint'; hint.textContent = item.hint; option.append(hint); }
    option.addEventListener('click', () => { closeMenu(); onPick?.(item); anchor.focus({ preventScroll: true }); });
    menu.append(option);
  });
  // A modal <dialog> sits in the top layer; a menu opened from it must live inside it.
  (anchor.closest('dialog[open]') || document.body).append(menu);
  place(menu, anchor, at);
  open.menu = { menu, anchor, onClose };
  anchor.setAttribute('aria-expanded', 'true');
  (find(menu, '[aria-selected="true"]') || find(menu, '.menu-option'))?.focus({ preventScroll: true });
  return menu;
}

document.addEventListener('pointerdown', event => {
  const target = nodeOf(event.target);
  if (open.menu && !open.menu.menu.contains(target) && !open.menu.anchor.contains(target)) closeMenu();
}, true);
document.addEventListener('keydown', event => {
  if (!open.menu) return;
  const options = [...open.menu.menu.querySelectorAll<HTMLElement>('.menu-option')];
  const at = document.activeElement instanceof HTMLElement ? options.indexOf(document.activeElement) : -1;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); const anchor = open.menu.anchor; closeMenu(); anchor.focus(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); }
  else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); options[event.key === 'Home' ? 0 : options.length - 1]?.focus(); }
  else if (event.key === 'Tab') closeMenu();
  else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    const starts = (option: HTMLElement) => (option.textContent || '').toLowerCase().startsWith(event.key.toLowerCase());
    const match = options.find((option, index) => index > at && starts(option)) || options.find(starts);
    match?.focus();
  }
}, true);
addEventListener('resize', closeMenu);
document.addEventListener('scroll', event => { if (open.menu && !open.menu.menu.contains(nodeOf(event.target))) closeMenu(); }, true);

// Replace a native select's look while keeping the element itself.
export function enhanceSelect(select: HTMLSelectElement, { variant = 'subtle' } = {}): HTMLButtonElement | undefined {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = 'true';
  const button = document.createElement('button');
  button.type = 'button'; button.className = `select-button is-${variant}`; button.dataset.for = select.id;
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<span class="select-value"></span><svg class="select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';
  const label = find(document, `label[for="${select.id}"]`, HTMLLabelElement);
  if (label) { label.htmlFor = ''; button.setAttribute('aria-label', (label.textContent || '').trim()); }
  select.after(button);
  select.classList.add('native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  const sync = () => {
    const option = select.selectedOptions[0];
    const shown = find(button, '.select-value'); if (shown) shown.textContent = option?.textContent || '';
    button.title = select.title || option?.textContent || '';
    button.disabled = select.disabled;
    button.hidden = select.hidden;
  };
  // Programmatic `select.value = x` fires no event, so watch the property as well.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', { configurable: true, get(this: HTMLSelectElement) { return descriptor?.get?.call(this); }, set(this: HTMLSelectElement, value: string) { descriptor?.set?.call(this, value); sync(); } });
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'title', 'selected'] });
  select.addEventListener('change', sync);
  button.addEventListener('click', () => {
    const items = [...select.options].map((option): MenuItem => ({ value: option.value, label: option.textContent || '', hint: option.dataset.hint || '', description: option.dataset.description || '', selected: option.selected, group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : undefined }));
    showMenu(button, items, {
      label: button.getAttribute('aria-label') || '',
      // Picking the option already shown is still the person's pick (it may be showing a value
      // the page filled in by itself), so it is announced like any other.
      onPick: item => { if (select.value !== item.value) select.value = item.value; select.dispatchEvent(new Event('change', { bubbles: true })); },
    });
  });
  button.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); button.click(); } });
  sync();
  return button;
}
