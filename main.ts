// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls, and applies them to a tree of text files, all or nothing: when any
// edit fails, no file is written. Lines an edit names are matched at three
// tiers (exact, trailing whitespace ignored, both ends ignored), so an edit
// still lands when the model drifted the indentation.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines, with its own line break and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly origText = new Map<string, string | null>();
  private readonly origAny = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  /** Content of a regular file at p, or null when there is none. */
  original(p: string): string | null {
    if (!this.origText.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origText.set(p, v);
    }
    return this.origText.get(p)!;
  }

  /** Whether anything at all (file, directory, ...) sits at p. */
  existsAny(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (!this.origAny.has(p)) {
      let v = false;
      try {
        statSync(p);
        v = true;
      } catch {
        v = false;
      }
      this.origAny.set(p, v);
    }
    return this.origAny.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }

  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

/** Every path an edit names is checked for safety before anything else about it. */
function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

function needFile(tree: Tree, p: string): FileText {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return parseFile(t);
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where oldLines occur in lines at one tier, starting at `from`. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  const n = oldLines.length;
  for (let i = from; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which oldLines occur at least once (tier 0 only with --strict). */
function findOld(lines: string[], oldLines: string[], strict: boolean, from: number, eof: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let positions = occurrences(lines, oldLines, t, from);
    if (eof) positions = positions.filter((p) => p + oldLines.length === lines.length);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of the replacement: fromO >= 0 copies the file's matched line at that O index. */
interface NewLine {
  text: string;
  fromO: number;
}

/** Replace oldLines at pos with newLines. Context lines come from the file itself;
 * at tier 2 every other line is re-indented from the patch's indent to the file's. */
function spliceLines(lines: string[], pos: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const fLead = leadWs(lines[pos] ?? '');
  const pLead = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  const out = newLines.map((nl) => {
    if (nl.fromO >= 0) return lines[pos + nl.fromO]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    return t.startsWith(pLead) ? fLead + t.slice(pLead.length) : t;
  });
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oldLines.length)];
}

type Edit = (tree: Tree) => void;

/** Detect the format (SPEC.md section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not a valid edit. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.existsAny(p)) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const f = needFile(tree, p);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const out = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.set(p, renderFile({ lines: out, br: f.br, final: f.final }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface HunkBodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBodyItem[];
}

interface UniSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Parse `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function diffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed. */
function uniPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Does a `\` line follow the body's last context or `+` line? */
function backslashAfterLastCtxPlus(body: HunkBodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const it = body[k]!;
    if (it.kind === ' ' || it.kind === '+') return body[k + 1]?.kind === '\\';
  }
  return false;
}

/** Does a `\` line follow the last `+` line of any hunk in the section? */
function backslashAfterLastPlus(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    if (!body.some((it) => it.kind === '+')) continue;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]!.kind === '+') return body[k + 1]?.kind === '\\';
    }
  }
  return false;
}

/** Parse one section starting at `start`; returns the section and the next line to read. */
function parseUniSection(lines: string[], start: number): { sec: UniSection; next: number } {
  let i = start;
  const n = lines.length;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isCreate = false;
  let isDelete = false;
  let seenPair = false;
  let sawHunk = false;
  const hunks: Hunk[] = [];

  if (lines[i]!.startsWith('diff --git ')) {
    const gp = diffGit(lines[i]!);
    if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
    gitOld = gp[0];
    gitNew = gp[1];
    i++;
  }

  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      if (diffGit(line) === null) throw new Exit2(`error: parse ${i + 1}`);
      break; // a new section starts
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      sawHunk = true;
      const body: HunkBodyItem[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '' });
          j++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: bl.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      hunks.push({ a, body });
      i = j;
      continue;
    }
    if (!sawHunk) {
      // Header: before the first hunk.
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!seenPair) {
            pairOld = uniPath(line);
            pairNew = uniPath(lines[i + 1]!);
            seenPair = true;
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (renameFrom === null) renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (renameTo === null) renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the first hunk: prose is ignored; a path pair starts a new section.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }

  const oldPath = seenPair ? pairOld : (renameFrom ?? gitOld);
  const newPath = seenPair ? pairNew : (renameTo ?? gitNew);
  return { sec: { oldPath, newPath, isCreate, isDelete, hunks }, next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      if (diffGit(line) === null) throw new Exit2(`error: parse ${i + 1}`);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // a section starts here
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i++;
      continue;
    }
    const { sec, next } = parseUniSection(lines, i);
    edits.push(unifiedEdit(sec, strict));
    i = next;
  }
  return edits;
}

/** Apply a section's hunks in order to a file's lines. */
function applyUnifiedHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const O: string[] = [];
    const N: NewLine[] = [];
    for (const it of hunk.body) {
      if (it.kind === ' ') {
        O.push(it.text);
        N.push({ text: it.text, fromO: O.length - 1 });
      } else if (it.kind === '-') O.push(it.text);
      else if (it.kind === '+') N.push({ text: it.text, fromO: -1 });
    }
    if (O.length === 0) {
      const at = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const ins = N.map((nl) => nl.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) final = !backslashAfterLastCtxPlus(hunk.body);
    } else {
      const found = findOld(lines, O, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const touchesEnd = pos + O.length === lines.length;
      lines = spliceLines(lines, pos, O, N, found.tier);
      if (touchesEnd) final = !backslashAfterLastCtxPlus(hunk.body);
    }
    d += N.length - O.length;
  }
  return { lines, br: f.br, final };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.isCreate) {
      const p = sec.newPath ?? '/dev/null';
      needSafe(p);
      if (tree.existsAny(p)) throw new Fail('exists', p);
      const outLines: string[] = [];
      for (const h of sec.hunks) for (const it of h.body) if (it.kind === '+') outLines.push(it.text);
      const final = !backslashAfterLastPlus(sec.hunks);
      tree.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (sec.isDelete) {
      const p = sec.oldPath ?? '/dev/null';
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const oldP = sec.oldPath ?? '/dev/null';
    const newP = sec.newPath ?? '/dev/null';
    if (oldP !== newP) {
      needSafe(oldP);
      needSafe(newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.existsAny(newP)) throw new Fail('exists', newP);
      const done = applyUnifiedHunks(parseFile(before), sec.hunks, strict, oldP);
      tree.set(newP, renderFile(done));
      tree.set(oldP, null);
      tree.recordMove(oldP, newP);
      return;
    }
    needSafe(oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const done = applyUnifiedHunks(parseFile(before), sec.hunks, strict, oldP);
    tree.set(oldP, renderFile(done));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, oldL, newL) => (tree: Tree) => {
      needSafe(p);
      if (oldL.length === 0) {
        if (tree.existsAny(p)) throw new Fail('exists', p);
        tree.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const f = needFile(tree, p);
      const found = findOld(f.lines, oldL, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const N: NewLine[] = newL.map((t) => ({ text: t, fromO: -1 }));
      const out = spliceLines(f.lines, pos, oldL, N, found.tier);
      tree.set(p, renderFile({ lines: out, br: f.br, final: f.final }));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aBodyItem {
  kind: ' ' | '-' | '+';
  text: string;
}

interface V4aChunk {
  anchor: string | null; // null: no anchor
  eof: boolean;
  body: V4aBodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // add: the file's lines
  chunks: V4aChunk[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      needSafe(sec.path);
      if (tree.existsAny(sec.path)) throw new Fail('exists', sec.path);
      tree.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      needSafe(sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    needSafe(sec.path);
    if (sec.moveTo !== null) needSafe(sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.existsAny(sec.moveTo)) throw new Fail('exists', sec.moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(f.lines, chunk.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NewLine[] = [];
      for (const it of chunk.body) {
        if (it.kind === ' ') {
          O.push(it.text);
          N.push({ text: it.text, fromO: O.length - 1 });
        } else if (it.kind === '-') O.push(it.text);
        else if (it.kind === '+') N.push({ text: it.text, fromO: -1 });
      }
      if (O.length === 0) {
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = N.map((nl) => nl.text);
        f = { lines: [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)], br: f.br, final: f.final };
        cursor = at + ins.length;
      } else {
        const found = findOld(f.lines, O, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', sec.path);
        const pos = found.positions[0]!;
        f = { lines: spliceLines(f.lines, pos, O, N, found.tier), br: f.br, final: f.final };
        cursor = pos + N.length;
      }
    }
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, renderFile(f));
      tree.set(sec.path, null);
      tree.recordMove(sec.path, sec.moveTo);
    } else {
      tree.set(sec.path, renderFile(f));
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isV4aSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind: 'add' | 'delete' | 'update' = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
    const marker = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(marker.length).trim();
    // The section's lines run to the next section start or *** End Patch.
    let end = i + 1;
    while (end < last && !isV4aSectionStart(lines[end]!)) end++;
    // Blank lines at the end of a section are not part of it.
    let e2 = end;
    while (e2 > i + 1 && blank(lines[e2 - 1]!)) e2--;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = i + 1; k < e2; k++) {
        const l = lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(v4aEdit({ kind, path, moveTo: null, lines: fileLines, chunks: [] }, strict));
    } else if (kind === 'delete') {
      if (e2 > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(v4aEdit({ kind, path, moveTo: null, lines: [], chunks: [] }, strict));
    } else {
      let moveTo: string | null = null;
      let k = i + 1;
      if (k < e2 && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (k < e2) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(cur);
          k++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          cur = null;
          k++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aEdit({ kind, path, moveTo, lines: [], chunks }, strict));
    }
    i = end;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? parseJson(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const rows = new Map<string, { key: string; text: string }>();
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) === null) continue; // the old path did not exist before the patch
    if (tree.get(oldP) !== null) continue; // ... and is not gone afterwards
    if (tree.original(newP) !== null) continue; // the new path did not exist before the patch
    if (tree.get(newP) === null) continue; // ... and is not there afterwards
    if (rows.get(oldP)?.text !== `D ${oldP}`) continue;
    if (rows.get(newP)?.text !== `A ${newP}`) continue;
    rows.delete(oldP);
    rows.delete(newP);
    rows.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
  }
  const sorted = [...rows.values()].sort((a, b) => byteCmp(a.key, b.key));
  const out = [...sorted.map((r) => r.text), `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
