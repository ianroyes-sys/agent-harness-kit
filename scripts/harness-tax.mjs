#!/usr/bin/env node
// Harness tax audit: what Claude Code loads before you type, and which loaded skills earned it.
// Read-only. Token counts are chars/4 estimates; `/context` in a fresh session is the ground truth.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOT_BUDGET_TOKENS = 2000;
export const MEMORY_INDEX_LINE_LIMIT = 200; // Claude Code truncates MEMORY.md past this.
export const estimateTokens = text => Math.ceil(String(text || '').length / 4);

const readOr = (file, fallback = '') => { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } };

export function skillDescription(markdown) {
  const front = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!front) return '';
  const lines = front[1].split('\n');
  const start = lines.findIndex(line => /^description:/.test(line));
  if (start < 0) return '';
  const out = [lines[start].replace(/^description:\s*/, '')];
  for (const line of lines.slice(start + 1)) { if (/^\S/.test(line)) break; out.push(line.trim()); }
  return out.join(' ').replace(/^[>|]-?\s*/, '').replace(/^["']|["']$/g, '').trim();
}

function findSkillFiles(root, depth = 4) {
  const found = [];
  const walk = (dir, left) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) { found.push(path.join(dir, 'SKILL.md')); return; }
    if (left > 0) for (const e of entries) if ((e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), left - 1);
  };
  walk(root, depth);
  return found;
}

export function collectSkills({ claudeDir }) {
  const skills = [];
  const add = (file, source, prefix) => {
    const name = path.basename(path.dirname(file));
    skills.push({ name, id: prefix ? `${prefix}:${name}` : name, source, descriptionTokens: estimateTokens(skillDescription(readOr(file))) });
  };
  for (const file of findSkillFiles(path.join(claudeDir, 'skills'), 1)) add(file, 'user', '');
  let installed = {};
  try { installed = JSON.parse(readOr(path.join(claudeDir, 'plugins', 'installed_plugins.json'), '{}')); } catch {}
  for (const [key, value] of Object.entries(installed.plugins || installed)) {
    const entry = Array.isArray(value) ? value[0] : value;
    if (!entry?.installPath) continue;
    const plugin = key.split('@')[0];
    for (const file of findSkillFiles(entry.installPath)) add(file, `plugin:${plugin}`, plugin);
  }
  return skills;
}

export function collectUsage({ projectsDir, days, now = Date.now() }) {
  const cutoff = now - days * 86400000;
  const counts = new Map();
  const bump = name => counts.set(name, (counts.get(name) || 0) + 1);
  const files = [];
  const walk = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(full).mtimeMs >= cutoff) files.push(full); } catch {} }
    }
  };
  walk(projectsDir);
  for (const file of files) {
    const text = readOr(file);
    for (const m of text.matchAll(/"name":\s*"Skill",\s*"input":\s*\{\s*"skill":\s*"([^"]+)"/g)) bump(m[1]);
    for (const m of text.matchAll(/<command-name>\/([^<\s]+)<\/command-name>/g)) bump(m[1]);
    // A loop or agent reading SKILL.md directly is a use too. One count per transcript to avoid listing noise.
    for (const name of new Set([...text.matchAll(/\/skills\/([A-Za-z0-9_.-]+)\/SKILL\.md/g)].map(m => m[1]))) bump(`file:${name}`);
  }
  return { transcripts: files.length, counts };
}

export function usesOf(skill, counts) {
  return (counts.get(skill.id) || 0) + (counts.get(skill.name) || 0) + (counts.get(`file:${skill.name}`) || 0);
}

export function audit({ home = os.homedir(), claudeDir = path.join(home, '.claude'), memoryIndex, extraHotFiles = [], days = 30, now } = {}) {
  memoryIndex ??= path.join(claudeDir, 'projects', home.replace(/[/.]/g, '-'), 'memory', 'MEMORY.md');
  const hotFiles = [path.join(claudeDir, 'CLAUDE.md'), path.join(home, 'AGENTS.md'), memoryIndex, ...extraHotFiles]
    .filter(file => fs.existsSync(file))
    .map(file => { const text = readOr(file); return { file, tokens: estimateTokens(text), lines: text.split('\n').length }; });
  const hotTokens = hotFiles.reduce((sum, f) => sum + f.tokens, 0);
  const skills = collectSkills({ claudeDir });
  const usage = collectUsage({ projectsDir: path.join(claudeDir, 'projects'), days, now });
  for (const skill of skills) skill.uses = usesOf(skill, usage.counts);
  const bySource = {};
  for (const s of skills) {
    const g = bySource[s.source] ||= { skills: 0, used: 0, descriptionTokens: 0 };
    g.skills++; g.descriptionTokens += s.descriptionTokens; if (s.uses) g.used++;
  }
  const warnings = [];
  if (hotTokens > HOT_BUDGET_TOKENS) warnings.push(`Always-loaded instruction + memory files ≈${hotTokens} tokens, over the ${HOT_BUDGET_TOKENS} hot budget. Make MEMORY.md an index: one hook per line, details in the linked file.`);
  const index = hotFiles.find(f => f.file === memoryIndex);
  if (index && index.lines > MEMORY_INDEX_LINE_LIMIT) warnings.push(`MEMORY.md has ${index.lines} lines; lines past ${MEMORY_INDEX_LINE_LIMIT} are truncated and never seen.`);
  for (const [source, g] of Object.entries(bySource)) if (source.startsWith('plugin:') && g.skills >= 5 && g.used === 0) warnings.push(`${source}: ${g.skills} skills, ≈${g.descriptionTokens} listing tokens, 0 uses in ${days} days. Candidate to disable.`);
  return { days, transcripts: usage.transcripts, hotFiles, hotTokens, skills: { total: skills.length, used: skills.filter(s => s.uses).length, descriptionTokens: skills.reduce((n, s) => n + s.descriptionTokens, 0), bySource }, unused: skills.filter(s => !s.uses).map(s => s.id), warnings };
}

function render(report) {
  const out = [`Harness tax (estimates; confirm with /context in a fresh session). Usage window: ${report.days} days, ${report.transcripts} transcripts.`, '', 'Always-loaded files:'];
  for (const f of report.hotFiles) out.push(`  ${String(f.tokens).padStart(6)} tok  ${f.lines} lines  ${f.file.replace(os.homedir(), '~')}`);
  out.push(`  ${String(report.hotTokens).padStart(6)} tok  total (budget ${HOT_BUDGET_TOKENS})`, '', `Skills: ${report.skills.used}/${report.skills.total} used (upper bound: a SKILL.md path mention counts), ≈${report.skills.descriptionTokens} listing tokens`);
  for (const [source, g] of Object.entries(report.skills.bySource).sort((a, b) => b[1].descriptionTokens - a[1].descriptionTokens)) out.push(`  ${source.padEnd(34)} ${String(g.used).padStart(3)}/${String(g.skills).padEnd(3)} used  ≈${g.descriptionTokens} tok`);
  out.push('', 'Not counted here: claude.ai-synced skills and MCP server instructions. Turn synced skills off at claude.ai/customize/skills.');
  if (report.warnings.length) out.push('', 'Warnings:', ...report.warnings.map(w => `  - ${w}`));
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: harness-tax.mjs [--days N] [--json] [--hot-file PATH]...\nRead-only audit of always-loaded context and skill usage.'); process.exit(0); }
  const days = Number(args[args.indexOf('--days') + 1]) || 30;
  const extraHotFiles = args.flatMap((a, i) => a === '--hot-file' ? [path.resolve(args[i + 1])] : []);
  const report = audit({ days, extraHotFiles });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : render(report));
}
