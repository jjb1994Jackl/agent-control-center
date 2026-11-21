export class MessageInbox<T extends { id: string } = { id: string }> {
  seen = new Set<string>(); initialized = false;
  ingest(notices: T[] = []): T[] {
    const fresh: T[] = [];
    for (const notice of notices) {
      if (this.seen.has(notice.id)) continue;
      this.seen.add(notice.id);
      if (this.initialized) fresh.push(notice);
    }
    this.initialized = true;
    while (this.seen.size > 400) { const oldest = this.seen.values().next().value; if (oldest === undefined) break; this.seen.delete(oldest); }
    return fresh;
  }
}
export function previewText(text: unknown, length = 160): string {
  const plain = String(text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  return chars.slice(0, length).join('') + (chars.length > length ? '…' : '');
}
