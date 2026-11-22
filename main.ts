// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

// Check if a line contains only whitespace characters or is completely empty
const blank = (s: string): boolean => typeof s === 'string' && s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// Validate that a path segment is a non-empty string and avoids directory traversal tokens
function isValidSegment(s: string): boolean {
  return typeof s === 'string' && s !== '' && s !== '.' && s !== '..';
}

// Ensure path safety by guarding against absolute paths, backslashes, directory traversal, and empty segments
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every(isValidSegment);
}

class FileModel {
  readonly lines: string[];
  readonly crlf: boolean;
  readonly finalBreak: boolean;
  constructor(lines: string[], crlf: boolean, finalBreak: boolean) {
    this.lines = lines;
    this.crlf = crlf;
    this.finalBreak = finalBreak;
  }
  static fromString(text: string): FileModel {
    if (text === '') return new FileModel([], false, false);
    const nl = text.indexOf('\n');
    const crlf = nl > 0 && text[nl - 1] === '\r';
    const br = crlf ? '\r\n' : '\n';
    const lines = text.split(br);
    const finalBreak = text.endsWith(br);
    if (finalBreak && lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return new FileModel(lines, crlf, finalBreak);
  }
  toString(): string {
    if (this.lines.length === 0) return '';
    const br = this.crlf ? '\r\n' : '\n';
    return this.lines.join(br) + (this.finalBreak ? br : '');
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        const st = statSync(p);
        if (st.isFile()) v = readFileSync(p, 'utf8');
        else if (st.isDirectory()) v = null;
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (this.original(p) !== null) return true;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

// Helper to normalize lines per matching tier rules 0, 1, and 2
function normalizeLine(s: string, tier: number): string {
  if (tier === 1) return s.trimEnd();
  if (tier === 2) return s.trim();
  return s;
}

// Optimize pattern matching by performing early length bounds and tier validation
function findOccurrences(fileLines: string[], oldLines: string[], strict: boolean): { tier: number; indices: number[] } {
  if (oldLines.length === 0) return { tier: 0, indices: [] };
  if (fileLines.length < oldLines.length) return { tier: -1, indices: [] };

  const matchTier = (t: number): number[] => {
    const indices: number[] = [];
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      let matched = true;
      for (let j = 0; j < oldLines.length; j++) {
        const f = normalizeLine(fileLines[i + j]!, t);
        const o = normalizeLine(oldLines[j]!, t);
        if (f !== o) { matched = false; break; }
      }
      if (matched) indices.push(i);
    }
    return indices;
  };

  const t0 = matchTier(0);
  if (t0.length > 0) return { tier: 0, indices: t0 };
  if (strict) return { tier: -1, indices: [] };

  const t1 = matchTier(1);
  if (t1.length > 0) return { tier: 1, indices: t1 };

  const t2 = matchTier(2);
  if (t2.length > 0) return { tier: 2, indices: t2 };

  return { tier: -1, indices: [] };
}

function adjustNewLines(nLines: string[], tier: number, fileFirstLine: string, oFirstLine: string): string[] {
  if (tier !== 2) return nLines;
  const getIndent = (s: string) => {
    const m = s.match(/^[ \t]*/);
    return m ? m[0] : '';
  };
  const F = getIndent(fileFirstLine);
  const P = getIndent(oFirstLine);
  return nLines.map((l) => {
    if (l === '' || blank(l)) return l;
    if (P !== '' && l.startsWith(P)) {
      return F + l.slice(P.length);
    }
    if (P === '' && F !== '') {
      return F + l;
    }
    return l;
  });
}

interface Hunk {
  headerLine: number;
  a: number;
  c: number;
  body: { type: ' ' | '-' | '+' | '\\'; text: string; lineNo: number }[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): { edits: Edit[]; movePairs: Map<string, string>; errorLine: number | null } {
  const sections: UnifiedSection[] = [];
  let i = 0;

  const cleanPath = (raw: string): string | null => {
    const p = raw.split('\t')[0]!.trim();
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
    return p;
  };

  const cleanRenamePath = (raw: string): string | null => {
    const p = raw.split('\t')[0]!.trim();
    if (p === '/dev/null') return null;
    return p;
  };

  while (i < lines.length) {
    const l = lines[i]!;
    const lineNo = i + 1;

    let isDiffGit = l.startsWith('diff --git ');
    let isMinusPlus = l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');

    if (l.startsWith('@@ ')) {
      return { edits: [], movePairs: new Map(), errorLine: lineNo };
    }

    if (!isDiffGit && !isMinusPlus) {
      i++;
      continue;
    }

    const sec: UnifiedSection = {
      oldPath: null,
      newPath: null,
      isCreate: false,
      isDelete: false,
      hunks: []
    };

    if (isDiffGit) {
      const matchGit = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (!matchGit) {
        return { edits: [], movePairs: new Map(), errorLine: lineNo };
      }
      sec.oldPath = cleanPath('a/' + matchGit[1]!);
      sec.newPath = cleanPath('b/' + matchGit[2]!);
      i++;
    } else if (isMinusPlus) {
      sec.oldPath = cleanPath(lines[i]!.slice(4));
      sec.newPath = cleanPath(lines[i + 1]!.slice(4));
      i += 2;
    }

    let headerMinusPlusConsumed = isMinusPlus;
    // Parse header lines until first @@ or end of patch or next section start
    while (i < lines.length) {
      const hl = lines[i]!;
      const hlNo = i + 1;

      if (hl.startsWith('@@ ')) {
        break;
      }
      if (hl.startsWith('diff --git ')) {
        break;
      }

      if (hl.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
          if (!headerMinusPlusConsumed) {
            sec.oldPath = cleanPath(lines[i]!.slice(4));
            sec.newPath = cleanPath(lines[i + 1]!.slice(4));
            headerMinusPlusConsumed = true;
            i += 2;
            continue;
          } else {
            break;
          }
        } else {
          return { edits: [], movePairs: new Map(), errorLine: hlNo + 1 };
        }
      }

      if (hl.startsWith('+++ ')) {
        sec.newPath = cleanPath(hl.slice(4));
        i++;
        continue;
      }

      if (hl.startsWith('rename from ')) {
        sec.oldPath = cleanRenamePath(hl.slice(12));
        i++;
        continue;
      }
      if (hl.startsWith('rename to ')) {
        sec.newPath = cleanRenamePath(hl.slice(10));
        i++;
        continue;
      }
      if (hl.startsWith('new file mode')) {
        sec.isCreate = true;
        sec.oldPath = null;
        i++;
        continue;
      }
      if (hl.startsWith('deleted file mode')) {
        sec.isDelete = true;
        sec.newPath = null;
        i++;
        continue;
      }

      if (hl.startsWith('@@')) {
        return { edits: [], movePairs: new Map(), errorLine: hlNo };
      }

      i++;
    }

    // Now parse hunks for this section
    while (i < lines.length) {
      const hl = lines[i]!;
      const hlNo = i + 1;

      if (hl.startsWith('diff --git ') || (hl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ '))) {
        break;
      }

      if (hl.startsWith('@@ ')) {
        const match = hl.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!match) {
          return { edits: [], movePairs: new Map(), errorLine: hlNo };
        }
        const a = parseInt(match[1]!, 10);
        const c = parseInt(match[2]!, 10);
        const hunk: Hunk = { headerLine: hlNo, a, c, body: [] };
        sec.hunks.push(hunk);

        i++;
        while (i < lines.length) {
          const bl = lines[i]!;
          const blNo = i + 1;
          if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) || bl.startsWith('@@ ')) {
            break;
          }
          const fc = bl[0];
          if (fc === ' ' || fc === '-' || fc === '+' || fc === '\\' || bl === '') {
            hunk.body.push({
              type: bl === '' ? ' ' : (fc as ' ' | '-' | '+' | '\\'),
              text: bl === '' ? '' : (fc === '\\' ? bl : bl.slice(1)),
              lineNo: blNo
            });
            i++;
          } else {
            break;
          }
        }
        while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.type === ' ' && hunk.body[hunk.body.length - 1]!.text === '') {
          hunk.body.pop();
        }
        continue;
      }

      if (hl.startsWith('@@')) {
        return { edits: [], movePairs: new Map(), errorLine: hlNo };
      }

      i++;
    }

    sections.push(sec);
  }

  const edits: Edit[] = [];
  const movePairs = new Map<string, string>();

  for (const sec of sections) {
    let oldPath = sec.oldPath;
    let newPath = sec.newPath;
    if (sec.isCreate) oldPath = null;
    if (sec.isDelete) newPath = null;
    const path = newPath ?? oldPath;
    if (!path) continue;

    const isCreation = sec.isCreate || oldPath === null;
    const isDeletion = sec.isDelete || newPath === null;
    const isMove = !isCreation && !isDeletion && oldPath !== null && newPath !== null && oldPath !== newPath;

    edits.push((tree) => {
      if (isCreation) {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.exists(path)) throw new Fail('exists', path);
        let fileLines: string[] = [];
        let finalBreak = true;
        let lastPlusIdx = -1;
        let lastPlusBodyIdx = -1;
        let totalPlusCount = 0;
        for (const hunk of sec.hunks) {
          for (let k = 0; k < hunk.body.length; k++) {
            const b = hunk.body[k]!;
            if (b.type === '+') {
              fileLines.push(b.text);
              totalPlusCount++;
              lastPlusBodyIdx = k;
            }
          }
        }
        if (totalPlusCount > 0) {
          // Check if a \ line follows the LAST + line across all hunks
          let foundLastPlus = false;
          let hasBackslash = false;
          let seenPlus = 0;
          for (const hunk of sec.hunks) {
            for (let k = 0; k < hunk.body.length; k++) {
              const b = hunk.body[k]!;
              if (b.type === '+') {
                seenPlus++;
                if (seenPlus === totalPlusCount) {
                  foundLastPlus = true;
                  if (k + 1 < hunk.body.length && hunk.body[k + 1]!.type === '\\') {
                    hasBackslash = true;
                  }
                }
              }
            }
          }
          if (hasBackslash) finalBreak = false;
        } else {
          finalBreak = false;
        }
        const model = new FileModel(fileLines, false, finalBreak);
        tree.now.set(path, model.toString());
      } else if (isDeletion) {
        if (!safe(oldPath!)) throw new Fail('unsafe', oldPath!);
        if (!tree.exists(oldPath!)) throw new Fail('missing', oldPath!);
        tree.now.set(oldPath!, null);
      } else if (isMove) {
        if (!safe(oldPath!)) throw new Fail('unsafe', oldPath!);
        if (!safe(newPath!)) throw new Fail('unsafe', newPath!);
        if (!tree.exists(oldPath!)) throw new Fail('missing', oldPath!);
        if (tree.exists(newPath!) && oldPath !== newPath) throw new Fail('exists', newPath!);

        const origText = tree.get(oldPath!) ?? '';
        const model = FileModel.fromString(origText);
        let currLines = [...model.lines];
        let currFinalBreak = model.finalBreak;
        let d = 0;

        for (const hunk of sec.hunks) {
          const oLines: string[] = [];
          for (let k = 0; k < hunk.body.length; k++) {
            const b = hunk.body[k]!;
            if (b.type === ' ' || b.type === '-') oLines.push(b.text);
          }

          if (oLines.length > 0) {
            const res = findOccurrences(currLines, oLines, strict);
            if (res.tier < 0 || res.indices.length === 0) throw new Fail('no-match', oldPath!);
            const targetPos = hunk.a - 1 + d;
            let bestIdx = res.indices[0]!;
            let bestDist = Math.abs(bestIdx - targetPos);
            for (let idx = 1; idx < res.indices.length; idx++) {
              const pos = res.indices[idx]!;
              const dist = Math.abs(pos - targetPos);
              if (dist < bestDist) {
                bestDist = dist;
                bestIdx = pos;
              }
            }

            const runsToEnd = bestIdx + oLines.length === currLines.length;
            if (runsToEnd) {
              let followsLast = false;
              if (hunk.body.length > 0) {
                const lastB = hunk.body[hunk.body.length - 1]!;
                if (lastB.type === '\\') {
                  const prevB = hunk.body[hunk.body.length - 2];
                  if (prevB && (prevB.type === ' ' || prevB.type === '+')) {
                    followsLast = true;
                  }
                }
              }
              currFinalBreak = !followsLast;
            }

            const matchedFirst = currLines[bestIdx]!;
            const oFirst = oLines[0]!;

            // Rebuild nLines positionally
            const nLines: string[] = [];
            let oIndex = 0;
            for (let k = 0; k < hunk.body.length; k++) {
              const b = hunk.body[k]!;
              if (b.type === ' ') {
                nLines.push(currLines[bestIdx + oIndex]!);
                oIndex++;
              } else if (b.type === '-') {
                oIndex++;
              } else if (b.type === '+') {
                let tText = b.text;
                if (res.tier === 2) {
                  const getIndent = (s: string) => {
                    const m = s.match(/^[ \t]*/);
                    return m ? m[0] : '';
                  };
                  const F = getIndent(matchedFirst);
                  const P = getIndent(oFirst);
                  if (tText !== '' && !blank(tText)) {
                    if (P !== '' && tText.startsWith(P)) {
                      tText = F + tText.slice(P.length);
                    } else if (P === '' && F !== '') {
                      tText = F + tText;
                    }
                  }
                }
                nLines.push(tText);
              }
            }

            currLines.splice(bestIdx, oLines.length, ...nLines);
            d += nLines.length - oLines.length;
          } else {
            const insertPos = Math.min(Math.max(0, hunk.a + d), currLines.length);
            const runsToEnd = insertPos === currLines.length;
            if (runsToEnd) {
              let followsLast = false;
              if (hunk.body.length > 0) {
                const lastB = hunk.body[hunk.body.length - 1]!;
                if (lastB.type === '\\') {
                  const prevB = hunk.body[hunk.body.length - 2];
                  if (prevB && (prevB.type === ' ' || prevB.type === '+')) {
                    followsLast = true;
                  }
                }
              }
              currFinalBreak = !followsLast;
            }

            const nLines: string[] = [];
            for (let k = 0; k < hunk.body.length; k++) {
              const b = hunk.body[k]!;
              if (b.type === '+') nLines.push(b.text);
            }
            currLines.splice(insertPos, 0, ...nLines);
            d += nLines.length;
          }
        }

        const newModel = new FileModel(currLines, model.crlf, currFinalBreak);
        tree.now.set(oldPath!, null);
        tree.now.set(newPath!, newModel.toString());
        movePairs.set(oldPath!, newPath!);
      } else {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (!tree.exists(path)) throw new Fail('missing', path);

        const origText = tree.get(path) ?? '';
        const model = FileModel.fromString(origText);
        let currLines = [...model.lines];
        let currFinalBreak = model.finalBreak;
        let d = 0;

        for (const hunk of sec.hunks) {
          const oLines: string[] = [];
          for (let k = 0; k < hunk.body.length; k++) {
            const b = hunk.body[k]!;
            if (b.type === ' ' || b.type === '-') oLines.push(b.text);
          }

          if (oLines.length > 0) {
            const res = findOccurrences(currLines, oLines, strict);
            if (res.tier < 0 || res.indices.length === 0) throw new Fail('no-match', path);
            const targetPos = hunk.a - 1 + d;
            let bestIdx = res.indices[0]!;
            let bestDist = Math.abs(bestIdx - targetPos);
            for (let idx = 1; idx < res.indices.length; idx++) {
              const pos = res.indices[idx]!;
              const dist = Math.abs(pos - targetPos);
              if (dist < bestDist) {
                bestDist = dist;
                bestIdx = pos;
              }
            }

            const runsToEnd = bestIdx + oLines.length === currLines.length;
            if (runsToEnd) {
              let followsLast = false;
              if (hunk.body.length > 0) {
                const lastB = hunk.body[hunk.body.length - 1]!;
                if (lastB.type === '\\') {
                  const prevB = hunk.body[hunk.body.length - 2];
                  if (prevB && (prevB.type === ' ' || prevB.type === '+')) {
                    followsLast = true;
                  }
                }
              }
              currFinalBreak = !followsLast;
            }

            const matchedFirst = currLines[bestIdx]!;
            const oFirst = oLines[0]!;

            const nLines: string[] = [];
            let oIndex = 0;
            for (let k = 0; k < hunk.body.length; k++) {
              const b = hunk.body[k]!;
              if (b.type === ' ') {
                nLines.push(currLines[bestIdx + oIndex]!);
                oIndex++;
              } else if (b.type === '-') {
                oIndex++;
              } else if (b.type === '+') {
                let tText = b.text;
                if (res.tier === 2) {
                  const getIndent = (s: string) => {
                    const m = s.match(/^[ \t]*/);
                    return m ? m[0] : '';
                  };
                  const F = getIndent(matchedFirst);
                  const P = getIndent(oFirst);
                  if (tText !== '' && !blank(tText)) {
                    if (P !== '' && tText.startsWith(P)) {
                      tText = F + tText.slice(P.length);
                    } else if (P === '' && F !== '') {
                      tText = F + tText;
                    }
                  }
                }
                nLines.push(tText);
              }
            }

            currLines.splice(bestIdx, oLines.length, ...nLines);
            d += nLines.length - oLines.length;
          } else {
            const insertPos = Math.min(Math.max(0, hunk.a + d), currLines.length);
            const runsToEnd = insertPos === currLines.length;
            if (runsToEnd) {
              let followsLast = false;
              if (hunk.body.length > 0) {
                const lastB = hunk.body[hunk.body.length - 1]!;
                if (lastB.type === '\\') {
                  const prevB = hunk.body[hunk.body.length - 2];
                  if (prevB && (prevB.type === ' ' || prevB.type === '+')) {
                    followsLast = true;
                  }
                }
              }
              currFinalBreak = !followsLast;
            }

            const nLines: string[] = [];
            for (let k = 0; k < hunk.body.length; k++) {
              const b = hunk.body[k]!;
              if (b.type === '+') nLines.push(b.text);
            }
            currLines.splice(insertPos, 0, ...nLines);
            d += nLines.length;
          }
        }

        const newModel = new FileModel(currLines, model.crlf, currFinalBreak);
        tree.now.set(path, newModel.toString());
      }
    });
  }

  return { edits, movePairs, errorLine: null };
}


type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function parseSearchReplace(lines: string[], strict: boolean): { edits: Edit[]; errorLine: number | null } {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;

  while (i < lines.length) {
    const l = lines[i]!;
    const lineNo = i + 1;

    if (l.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNo = lineNo;
      let foundPath: string | null = null;
      for (let k = i - 1; k >= prevEnd + 1; k--) {
        const pk = lines[k]!;
        if (!blank(pk)) {
          const trimmed = pk.trim();
          if (!trimmed.startsWith('```')) {
            foundPath = trimmed;
            break;
          }
        }
      }
      if (foundPath === null) {
        if (prevPath !== null) {
          foundPath = prevPath;
        } else {
          throw new Exit2(`error: parse ${searchLineNo}`);
        }
      }
      const path = foundPath;
      prevPath = path;

      let eqIdx = -1;
      let repIdx = -1;
      for (let k = i + 1; k < lines.length; k++) {
        const bk = lines[k]!;
        if (bk.trimEnd() === '=======' && eqIdx === -1) {
          eqIdx = k;
        } else if (bk.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = k;
          break;
        }
      }

      if (eqIdx === -1 || repIdx === -1 || eqIdx > repIdx) {
        throw new Exit2(`error: parse ${searchLineNo}`);
      }

      const oldLines: string[] = [];
      for (let k = i + 1; k < eqIdx; k++) {
        oldLines.push(lines[k]!);
      }
      const newLines: string[] = [];
      for (let k = eqIdx + 1; k < repIdx; k++) {
        newLines.push(lines[k]!);
      }

      prevEnd = repIdx;
      i = repIdx + 1;

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (oldLines.length === 0) {
          if (tree.exists(path)) throw new Fail('exists', path);
          const model = new FileModel(newLines, false, true);
          tree.now.set(path, model.toString());
        } else {
          if (!tree.exists(path)) throw new Fail('missing', path);
          const origText = tree.get(path) ?? '';
          const model = FileModel.fromString(origText);
          const res = findOccurrences(model.lines, oldLines, strict);
          if (res.tier < 0 || res.indices.length === 0) throw new Fail('no-match', path);
          if (res.indices.length > 1) throw new Fail('ambiguous', path);
          const bestIdx = res.indices[0]!;

          const matchedFirst = model.lines[bestIdx]!;
          const oFirst = oldLines[0]!;
          const nLinesAdjusted = adjustNewLines(newLines, res.tier, matchedFirst, oFirst);

          const currLines = [...model.lines];
          currLines.splice(bestIdx, oldLines.length, ...nLinesAdjusted);
          const newModel = new FileModel(currLines, model.crlf, model.finalBreak);
          tree.now.set(path, newModel.toString());
        }
      });
    } else {
      i++;
    }
  }

  return { edits, errorLine: null };
}

function parseV4A(lines: string[], strict: boolean): { edits: Edit[]; movePairs: Map<string, string>; errorLine: number | null } {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    return { edits: [], movePairs: new Map(), errorLine: firstNonBlank === -1 ? 1 : firstNonBlank + 1 };
  }

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      lastNonBlank = i;
      break;
    }
  }
  if (lastNonBlank === -1 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    return { edits: [], movePairs: new Map(), errorLine: lines.length + 1 };
  }

  const edits: Edit[] = [];
  const movePairs = new Map<string, string>();
  let i = firstNonBlank + 1;

  while (i < lastNonBlank) {
    const l = lines[i]!;
    const lineNo = i + 1;

    if (blank(l)) {
      i++;
      continue;
    }

    const trimmed = l.trim();
    if (trimmed.startsWith('*** Add File: ')) {
      const path = trimmed.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < lastNonBlank) {
        const bl = lines[i]!;
        const blNo = i + 1;
        if (blank(bl)) {
          let nextNB = -1;
          for (let k = i + 1; k < lastNonBlank; k++) {
            if (!blank(lines[k]!)) { nextNB = k; break; }
          }
          if (nextNB === -1) {
            break;
          }
          const nbt = lines[nextNB]!.trim();
          if (nbt.startsWith('*** Add File: ') || nbt.startsWith('*** Delete File: ') || nbt.startsWith('*** Update File: ')) {
            break;
          }
          fileLines.push('');
          i++;
          continue;
        }
        const bTrim = bl.trim();
        if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ')) {
          break;
        }
        if (bl.startsWith('+')) {
          fileLines.push(bl.slice(1));
        } else if (bl === '') {
          fileLines.push('');
        } else {
          return { edits: [], movePairs: new Map(), errorLine: blNo };
        }
        i++;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.exists(path)) throw new Fail('exists', path);
        const model = new FileModel(fileLines, false, true);
        tree.now.set(path, model.toString());
      });
    } else if (trimmed.startsWith('*** Delete File: ')) {
      const path = trimmed.slice(17).trim();
      i++;
      while (i < lastNonBlank) {
        const bl = lines[i]!;
        const blNo = i + 1;
        if (blank(bl)) {
          i++;
          continue;
        }
        const bTrim = bl.trim();
        if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ')) {
          break;
        }
        return { edits: [], movePairs: new Map(), errorLine: blNo };
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (!tree.exists(path)) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (trimmed.startsWith('*** Update File: ')) {
      const updateLineNo = lineNo;
      const path = trimmed.slice(17).trim();
      i++;
      let newPath: string | null = null;
      interface V4AChunk {
        anchor: string | null;
        isEof: boolean;
        body: { type: ' ' | '-' | '+'; text: string; lineNo: number }[];
      }
      const chunks: V4AChunk[] = [];
      let hasMoveTo = false;

      while (i < lastNonBlank && blank(lines[i]!)) i++;
      if (i < lastNonBlank && lines[i]!.trim().startsWith('*** Move to: ')) {
        newPath = lines[i]!.trim().slice(13).trim();
        hasMoveTo = true;
        i++;
      }

      let currentChunk: V4AChunk | null = null;

      while (i < lastNonBlank) {
        const bl = lines[i]!;
        const blNo = i + 1;

        if (blank(bl)) {
          let nextNB = -1;
          for (let k = i + 1; k < lastNonBlank; k++) {
            if (!blank(lines[k]!)) { nextNB = k; break; }
          }
          if (nextNB === -1) {
            i++;
            continue;
          }
          const nbt = lines[nextNB]!.trim();
          if (nbt.startsWith('*** Add File: ') || nbt.startsWith('*** Delete File: ') || nbt.startsWith('*** Update File: ')) {
            i++;
            continue;
          }
          if (currentChunk === null) {
            currentChunk = {
              anchor: null,
              isEof: false,
              body: []
            };
          }
          currentChunk.body.push({
            type: ' ',
            text: '',
            lineNo: blNo
          });
          i++;
          continue;
        }

        const bTrim = bl.trim();
        if (bTrim.startsWith('*** Add File: ') || bTrim.startsWith('*** Delete File: ') || bTrim.startsWith('*** Update File: ')) {
          break;
        }

        if (bTrim.startsWith('*** Move to: ')) {
          return { edits: [], movePairs: new Map(), errorLine: blNo };
        }

        if (bTrim === '*** End of File') {
          if (currentChunk === null) {
            return { edits: [], movePairs: new Map(), errorLine: blNo };
          }
          currentChunk.isEof = true;
          chunks.push(currentChunk);
          currentChunk = null;
          i++;
          continue;
        }

        if (bTrim.startsWith('@@')) {
          if (currentChunk !== null) {
            chunks.push(currentChunk);
          }
          const anchor = bTrim.slice(2).trim();
          currentChunk = {
            anchor: anchor === '' ? null : anchor,
            isEof: false,
            body: []
          };
          i++;
          continue;
        }

        const fc = bl[0];
        if (fc === ' ' || fc === '-' || fc === '+' || bl === '') {
          if (currentChunk === null) {
            currentChunk = {
              anchor: null,
              isEof: false,
              body: []
            };
          }
          currentChunk.body.push({
            type: bl === '' ? ' ' : (fc as ' ' | '-' | '+'),
            text: bl === '' ? '' : bl.slice(1),
            lineNo: blNo
          });
          i++;
          continue;
        }

        return { edits: [], movePairs: new Map(), errorLine: blNo };
      }

      if (currentChunk !== null) {
        chunks.push(currentChunk);
      }

      if (chunks.length === 0 && !hasMoveTo) {
        return { edits: [], movePairs: new Map(), errorLine: updateLineNo };
      }

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
        if (!tree.exists(path)) throw new Fail('missing', path);
        if (newPath !== null && tree.exists(newPath) && newPath !== path) throw new Fail('exists', newPath);

        const origText = tree.get(path) ?? '';
        const model = FileModel.fromString(origText);
        let currLines = [...model.lines];
        let cursor = 0;

        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const anchorStr = chunk.anchor!;
            let foundMatch = false;
            let matchIdx = -1;
            for (let t = 0; t <= 2; t++) {
              if (strict && t > 0) break;
              for (let idx = cursor; idx < currLines.length; idx++) {
                const fLine = currLines[idx]!;
                let matched = false;
                if (t === 0) matched = fLine === anchorStr;
                else if (t === 1) matched = fLine.trimEnd() === anchorStr.trimEnd();
                else if (t === 2) matched = fLine.trim() === anchorStr.trim();
                if (matched) {
                  matchIdx = idx;
                  foundMatch = true;
                  break;
                }
              }
              if (foundMatch) break;
            }
            if (!foundMatch) throw new Fail('no-match', path);
            cursor = matchIdx + 1;
          }

          const oLines: string[] = [];
          for (const b of chunk.body) {
            if (b.type === ' ' || b.type === '-') oLines.push(b.text);
          }

          if (oLines.length > 0) {
            let foundT = -1;
            let foundIndices: number[] = [];
            for (let t = 0; t <= 2; t++) {
              if (strict && t > 0) break;
              const indices: number[] = [];
              for (let idx = cursor; idx <= currLines.length - oLines.length; idx++) {
                if (chunk.isEof && idx + oLines.length !== currLines.length) continue;
                let matched = true;
                for (let j = 0; j < oLines.length; j++) {
                  const f = currLines[idx + j]!;
                  const o = oLines[j]!;
                  if (t === 0) {
                    if (f !== o) { matched = false; break; }
                  } else if (t === 1) {
                    if (f.trimEnd() !== o.trimEnd()) { matched = false; break; }
                  } else if (t === 2) {
                    if (f.trim() !== o.trim()) { matched = false; break; }
                  }
                }
                if (matched) indices.push(idx);
              }
              if (indices.length > 0) {
                foundT = t;
                foundIndices = indices;
                break;
              }
            }

            if (foundT < 0 || foundIndices.length === 0) throw new Fail('no-match', path);

            let bestIdx = foundIndices[0]!;
            if (chunk.isEof) {
              const eofMatch = foundIndices.find((idx) => idx + oLines.length === currLines.length);
              if (eofMatch === undefined) throw new Fail('no-match', path);
              bestIdx = eofMatch;
            }

            const matchedFirst = currLines[bestIdx]!;
            const oFirst = oLines[0]!;

            const nLines: string[] = [];
            let oIndex = 0;
            for (const b of chunk.body) {
              if (b.type === ' ') {
                nLines.push(currLines[bestIdx + oIndex]!);
                oIndex++;
              } else if (b.type === '-') {
                oIndex++;
              } else if (b.type === '+') {
                let tText = b.text;
                if (foundT === 2) {
                  const getIndent = (s: string) => {
                    const m = s.match(/^[ \t]*/);
                    return m ? m[0] : '';
                  };
                  const F = getIndent(matchedFirst);
                  const P = getIndent(oFirst);
                  if (tText !== '' && !blank(tText)) {
                    if (P !== '' && tText.startsWith(P)) {
                      tText = F + tText.slice(P.length);
                    } else if (P === '' && F !== '') {
                      tText = F + tText;
                    }
                  }
                }
                nLines.push(tText);
              }
            }

            currLines.splice(bestIdx, oLines.length, ...nLines);
            cursor = bestIdx + nLines.length;
          } else {
            const insertPos = chunk.isEof ? currLines.length : cursor;
            const nLines: string[] = [];
            for (const b of chunk.body) {
              if (b.type === '+') nLines.push(b.text);
            }
            currLines.splice(insertPos, 0, ...nLines);
            cursor = insertPos + nLines.length;
          }
        }

        const newModel = new FileModel(currLines, model.crlf, model.finalBreak);
        if (newPath !== null && newPath !== path) {
          tree.now.set(path, null);
          tree.now.set(newPath, newModel.toString());
          movePairs.set(path, newPath);
        } else {
          tree.now.set(path, newModel.toString());
        }
      });
    } else {
      return { edits: [], movePairs: new Map(), errorLine: lineNo };
    }
  }

  return { edits, movePairs, errorLine: null };
}

function jsonEdits(text: string, lines: string[]): Edit[] {
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
  let movePairs = new Map<string, string>();
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      const res = parseUnified(lines, strict);
      if (res.errorLine !== null) throw new Exit2(`error: parse ${res.errorLine}`);
      edits = res.edits;
      movePairs = res.movePairs;
    } else if (kind === 'search-replace') {
      const res = parseSearchReplace(lines, strict);
      if (res.errorLine !== null) throw new Exit2(`error: parse ${res.errorLine}`);
      edits = res.edits;
    } else if (kind === 'v4a') {
      const res = parseV4A(lines, strict);
      if (res.errorLine !== null) throw new Exit2(`error: parse ${res.errorLine}`);
      edits = res.edits;
      movePairs = res.movePairs;
    } else {
      edits = [];
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  
  // Determine changes and handle moves (R <old> -> <new>)
  const successfulMoves = new Map<string, string>(); // old -> new
  for (const [oldP, newP] of movePairs) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      successfulMoves.set(oldP, newP);
    }
  }

  const changeItems: { sortPath: string; line: string; p?: string; now?: string | null }[] = [];
  const handledPaths = new Set<string>();

  for (const [oldP, newP] of successfulMoves) {
    handledPaths.add(oldP);
    handledPaths.add(newP);
    changeItems.push({
      sortPath: newP,
      line: `R ${oldP} -> ${newP}`
    });
  }

  for (const p of tree.now.keys()) {
    if (handledPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const type = was === null ? 'A' : now === null ? 'D' : 'M';
    changeItems.push({
      sortPath: p,
      line: `${type} ${p}`,
      p,
      now
    });
  }

  changeItems.sort((a, b) => Buffer.compare(Buffer.from(a.sortPath), Buffer.from(b.sortPath)));

  const rows: string[] = [];
  for (const item of changeItems) {
    rows.push(item.line);
    if (check) continue;
    if (item.p !== undefined && item.now !== undefined) {
      const p = item.p;
      const now = item.now;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  // Also execute file deletions/writes for successful moves
  if (!check) {
    for (const [oldP, newP] of successfulMoves) {
      rmSync(oldP, { force: true });
      const nowNew = tree.now.get(newP)!;
      mkdirSync(dirname(newP), { recursive: true });
      writeFileSync(newP, nowNew);
    }
  }

  return { code: 0, out: [...rows, `ok: ${changeItems.length} ${changeItems.length === 1 ? 'file' : 'files'}`] };
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
