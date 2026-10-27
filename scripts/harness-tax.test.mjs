import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, skillDescription, estimateTokens } from './harness-tax.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tax-'));
  const claudeDir = path.join(home, '.claude');
  const put = (rel, text) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  put('.claude/CLAUDE.md', 'rules\n');
  const memoryIndex = put('.claude/projects/p/memory/MEMORY.md', 'x'.repeat(9000));
  put('.claude/skills/used-one/SKILL.md', '---\nname: used-one\ndescription: Does a thing.\n---\nbody');
  put('.claude/skills/idle-one/SKILL.md', '---\nname: idle-one\ndescription: >-\n  Folded\n  text.\n---\nbody');
  const pluginPath = path.join(home, 'plugin-cache', 'mkt');
  for (const n of ['a', 'b', 'c', 'd', 'e']) put(`plugin-cache/mkt/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: Marketing ${n}.\n---\n`);
  put('.claude/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'mkt@market': [{ installPath: pluginPath }] } }));
  put('.claude/projects/p/s1.jsonl', '{"type":"tool_use","name":"Skill","input":{"skill":"used-one"}}\n');
  const stale = put('.claude/projects/p/old.jsonl', '{"name":"Skill","input":{"skill":"idle-one"}}\n');
  const old = new Date(Date.now() - 90 * 86400000);
  fs.utimesSync(stale, old, old);
  return { home, claudeDir, memoryIndex };
}

test('skillDescription reads inline and folded descriptions', () => {
  assert.equal(skillDescription('---\nname: x\ndescription: Short one.\n---'), 'Short one.');
  assert.equal(skillDescription('---\ndescription: >-\n  Folded\n  text.\nname: y\n---'), 'Folded text.');
  assert.equal(skillDescription('no front matter'), '');
});

test('audit counts hot files, skill usage inside the window, and flags idle plugins', () => {
  const { home, claudeDir, memoryIndex } = fixture();
  const report = audit({ home, claudeDir, memoryIndex, days: 30 });
  assert.equal(report.hotTokens, estimateTokens('rules\n') + estimateTokens('x'.repeat(9000)));
  assert.equal(report.skills.total, 7);
  assert.equal(report.skills.used, 1);
  assert.ok(report.unused.includes('idle-one'), 'usage older than the window does not count');
  assert.ok(report.warnings.some(w => w.includes('hot budget')));
  assert.ok(report.warnings.some(w => w.startsWith('plugin:mkt: 5 skills')));
});
