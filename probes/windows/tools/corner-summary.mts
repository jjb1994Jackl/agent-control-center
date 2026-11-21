// Prints a corner-run result (<out dir>\corner.json) with every time relative to the run's first step.
// Usage: node corner-summary.mts <out dir>
import fs from 'node:fs';
import path from 'node:path';
const r = JSON.parse(fs.readFileSync(path.join(process.argv[2]!, 'corner.json'), 'utf8'));
const t0 = r.timings[0].atQpcMs, rel = (t: number | null | undefined) => (t == null ? null : Math.round(t - t0));
const ms = (v: number) => Math.round(v * 10) / 10;
console.log('timings');
for (const t of r.timings) console.log(' ', t.step, '@', rel(t.atQpcMs), 'took', ms(t.ms), JSON.stringify(t.result ?? ''));
console.log('check', JSON.stringify(r.check));
if (r.orderAfter) console.log('orderBefore', JSON.stringify(r.orderBefore), '\norderAfter', JSON.stringify(r.orderAfter));
console.log('seq ok', r.seq?.ok);
for (const s of r.seq?.steps ?? []) console.log(' ', s.label, '@', rel(s.startQpcMs), 'act', s.actMs, 'ok', s.ok, s.used ?? '', s.refused ?? '', s.error ?? '', s.until ? `until ${JSON.stringify(s.until)} met=${s.untilMet} in ${s.untilMs}` : '', s.name ? `name="${s.name}"` : '', 'fg', s.foreground?.exe);
const g = r.guard;
console.log('grabs', JSON.stringify(g.grabs.map((x: any) => ({ at: rel(x.atQpcMs), ms: Math.round(x.ms), open: x.open }))), 'restores', g.restores, 'failed', g.failedRestores, 'ways', JSON.stringify(g.giveBackWays), 'errors', JSON.stringify(g.setForegroundErrors));
console.log('transitions off hr', r.transitionsOffHr, '| corner re-raises', g.cornerReRaises, JSON.stringify((g.cornerCovered ?? []).map((c: any[]) => [rel(c[0]), c[1], ms(c[2])])));
console.log('claude at screen centre', JSON.stringify(g.claudeAtScreenCentre.map((c: number[]) => [rel(c[0]), Math.round(c[1])])));
console.log('foreground changes', JSON.stringify(g.foregroundChanges.map((c: any[]) => [rel(c[0]), c[1]])));
console.log('foreground at end', r.foregroundAtEnd, '| shown after:', r.shownAfter);
const sc = r.screen;
console.log('screen', JSON.stringify({ mode: sc.mode, error: sc.error, presented: sc.framesPresented, maxAccumulated: sc.maxAccumulatedFrames, noiseCells: sc.noiseCells, changedFrames: sc.changedFrames }));
sc.runs.forEach((x: any, i: number) => console.log(`  run${String(i + 1).padStart(2, '0')}`, rel(x.fromQpcMs), '->', rel(x.untilQpcMs), 'shown', x.shownMs, 'ms', 'frames', x.frames, 'maxPx', x.maxPixels, 'bbox', JSON.stringify(x.bbox), x.stillShownAtEnd ? 'STILL AT END' : ''));
