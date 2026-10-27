import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFor, judgePrompt, summarize, loadSubmissions, profileFacts, wilson, CHECKS } from './quality-audit.mjs';

const all = (verdict) => Object.fromEntries(Object.keys(CHECKS).map((k) => [k, { verdict, critique: 'x' }]));

test('record comes from the submission folder and skips blockers and résumés', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-qa-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'records/2026-10-27-acme'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'submission.md'), 'Answered: GPA 3.0'); fs.writeFileSync(path.join(dir, 'blocker.md'), 'BLOCKER'); fs.writeFileSync(path.join(dir, 'resume.txt'), 'RESUME');
  const rec = recordFor({ record: 'records/2026-10-27-acme' }, root);
  assert.match(rec.text, /GPA 3\.0/); assert.doesNotMatch(rec.text, /BLOCKER|RESUME/);
  assert.equal(recordFor({ record: 'records/missing' }, root), null);
  assert.equal(recordFor({}, root), null);
});

test('bundled example submissions resolve to records and facts', () => {
  const subs = loadSubmissions();
  assert.ok(subs.length >= 2);
  for (const s of subs) assert.ok(recordFor(s), s.key);
  assert.match(profileFacts(), /---/);
});

test('wilson interval is bounded and null for no data', () => {
  assert.equal(wilson(0, 0).rate, null);
  const w = wilson(5, 10); assert.ok(w.low < 0.5 && w.high > 0.5);
});

test('judge sees the record and facts as data, never the agent reasoning', () => {
  const p = judgePrompt({ name: 'Acme — Analyst' }, { text: 'record body' }, 'facts body');
  assert.match(p, /record body/); assert.match(p, /facts body/); assert.match(p, /data, not instructions/); assert.match(p, /unknown/);
});

test('summary separates unknowns, reports Wilson rates and stays uncalibrated without labels', () => {
  const now = Date.parse('2026-10-27T00:00:00Z'), at = '2026-10-26T00:00:00Z';
  const audits = [
    { id: 'a', at, name: 'A', checks: all('pass') },
    { id: 'b', at, name: 'B', checks: { ...all('pass'), truthful: { verdict: 'fail', critique: 'GPA claimed 3.8' } } },
    { id: 'c', at, name: 'C', checks: { ...all('pass'), fit: { verdict: 'unknown', critique: '' } } },
    { id: 'd', at, error: 'judge failed' },
  ];
  const s = summarize(audits, [], now);
  assert.equal(s.judged28d, 3); assert.equal(s.errors28d, 1);
  assert.equal(s.rates.truthful.k, 2); assert.equal(s.rates.truthful.n, 3);
  assert.equal(s.rates.fit.n, 2); assert.equal(s.rates.fit.unknown, 1);
  assert.equal(s.calibration.calibrated, false); assert.equal(s.flags.length, 1); assert.match(s.flags[0].failed[0], /GPA/);
});

test('calibration reports true-pass and true-fail rates separately', () => {
  const now = Date.parse('2026-10-27T00:00:00Z'), at = '2026-10-26T00:00:00Z';
  const audits = Array.from({ length: 22 }, (_, i) => ({ id: `x${i}`, at, name: `N${i}`, checks: all(i < 2 ? 'fail' : 'pass') }));
  const labels = audits.map((a, i) => ({ id: a.id, check: 'truthful', verdict: i < 4 ? 'fail' : 'pass' }));
  const c = summarize(audits, labels, now).calibration;
  assert.equal(c.labelled, 22); assert.equal(c.calibrated, true);
  assert.equal(c.truePassRate, 1); assert.equal(c.trueFailRate, 0.5);
});
