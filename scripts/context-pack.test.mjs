import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, renderContext, contextDir, LIMITS, MARKER } from './context-pack.mjs';

test('missing folder injects nothing rather than inventing context', () => {
  assert.equal(buildContext({ dir: path.join(os.tmpdir(), 'no-such-context-dir-xyz') }), null);
  assert.equal(renderContext(null), '');
});

test('bundled example folder renders as advisory data with a marker', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const packet = buildContext({ dir: contextDir(root, {}) });
  assert.ok(packet.excerpts.length >= 3);
  const text = renderContext(packet);
  assert.ok(text.startsWith(MARKER));
  assert.match(text, /never expands this task's permission/);
  assert.match(text, /fictional example/);
});

test('env override, per-file and total caps, hidden and underscore files skipped, old files flagged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(contextDir('/x', { HARNESS_CONTEXT_DIR: dir }), dir);
  for (const n of ['a', 'b', 'c', 'd', 'e']) fs.writeFileSync(path.join(dir, `${n}.md`), n.repeat(5000));
  fs.writeFileSync(path.join(dir, '_draft.md'), 'DRAFT'); fs.writeFileSync(path.join(dir, '.hidden.md'), 'HIDDEN'); fs.writeFileSync(path.join(dir, 'notes.txt'), 'TXT');
  const old = new Date(Date.now() - 400 * 86400000); fs.utimesSync(path.join(dir, 'a.md'), old, old);
  const packet = buildContext({ dir });
  const total = packet.excerpts.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= LIMITS.totalChars);
  assert.ok(packet.excerpts.every(e => e.text.length <= LIMITS.perFileChars && e.truncated));
  assert.equal(packet.excerpts[0].status, 'review');
  assert.doesNotMatch(renderContext(packet), /DRAFT|HIDDEN|TXT/);
});
