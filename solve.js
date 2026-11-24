// A faster drop-in for makefun-site 1.0.0: the same output tree, built in one
// fused pass per case. Every rule below mirrors the reference generator's own
// dialect (front matter, Markdown subset, template dialect, slug rule, report);
// the code is structured differently so it runs faster: blocks render straight
// into the output, inline text is buffered and escaped in runs, slugs are
// memoised per build, and templates render from a frame stack.

const CMP = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const WS_ONLY = /^[\t ]*$/;
const FENCE_OPEN_RX = /^```([\w+\-]*)[\t ]*$/;
const FENCE_SHUT_RX = /^```[\t ]*$/;
const HEAD_RX = /^(#{1,6})[\t ]+(.*?)[\t ]*$/;
const RULE_RX = /^(?:---|\*\*\*)[\t ]*$/;
const BULLET_RX = /^[*-] (.*)$/;
const ORDER_RX = /^([0-9]{1,9})\. (.*)$/;
const CONT_RX = /^  +\S/;
const FM_LINE_RX = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE_RX = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const LAYOUT_RX = /^[a-z0-9-]+$/;
const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RX = /^[^\[\]"]+$/;
const SCHEME_RX = /^[A-Za-z][A-Za-z0-9.+-]*:/;
const PATH_RX = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const FOR_RX = /^for ([A-Za-z_]\w*) in (\S+)$/;
const IF_RX = /^if (not )?(\S+)$/;
const INC_RX = /^include "([a-z0-9-]+)"$/;

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPECIALS = ['\\', '`', '*', '['];
const RESERVED_DIRS = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text bits

function escText(s) {
  const at = s.search(/[&<>"']/);
  if (at === -1) return s;
  let out = s.slice(0, at);
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : c === "'" ? '&#39;' : c;
  }
  return out;
}

function trimEnds(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const WS128 = new Uint8Array(128);
WS128[9] = 1;
WS128[10] = 1;
WS128[11] = 1;
WS128[12] = 1;
WS128[13] = 1;
WS128[32] = 1;

function slugOf(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    else {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

function freshSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDateOf(date) {
  const parts = date.split('-');
  return Number(parts[2]) + ' ' + MONTH_NAMES[Number(parts[1]) - 1] + ' ' + parts[0];
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function dirOfPath(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    if (s.error !== undefined) return { error: 'key "' + key + '": ' + s.error };
    return s;
  }
  if (key === 'date') {
    const m = FM_DATE_RX.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !TAG_RX.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (LAYOUT_RX.test(raw)) return { value: raw };
    return { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    if (SLUG_RX.test(raw) && raw.length <= 64) return { value: raw };
    return { error: 'key "slug": not a slug' };
  }
  return { error: 'unknown key "' + key + '"' };
}

function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (WS_ONLY.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE_RX.exec(line);
    if (m === null) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[\t ]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValue(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ------------------------------------------------------------------ Markdown

function findSeq(s, what, from) {
  for (let j = from; j + what.length <= s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function nextSpecial(s, from) {
  let j = s.length;
  for (const ch of SPECIALS) {
    const k = s.indexOf(ch, from);
    if (k !== -1 && k < j) j = k;
  }
  return j;
}

function inlineMd(s, linkFn) {
  const parts = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = nextSpecial(s, i);
    if (j > i) parts.push(escText(s.slice(i, j)));
    if (j >= n) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        parts.push(escText(s[j + 1]));
        i = j + 2;
      } else {
        parts.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        parts.push('<code>' + escText(s.slice(j + 1, k)) + '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findSeq(s, '**', j + 2);
        if (k > j + 2) {
          parts.push('<strong>' + inlineMd(s.slice(j + 2, k), linkFn) + '</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findStar(s, j + 1);
      if (k > j + 1) {
        parts.push('<em>' + inlineMd(s.slice(j + 1, k), linkFn) + '</em>');
        i = k + 1;
      } else {
        parts.push('*');
        i = j + 1;
      }
      continue;
    }
    const k = findSeq(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      parts.push('<a href="' + escText(linkFn(target)) + '">' + inlineMd(s.slice(j + 1, k), linkFn) + '</a>');
      i = m + 1;
      continue;
    }
    parts.push('[');
    i = j + 1;
  }
  return parts.join('');
}

function headingParts(line) {
  const m = HEAD_RX.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

function isBlankLn(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function endsPara(line) {
  if (isBlankLn(line)) return true;
  const c = line[0];
  if (c === '`') return FENCE_OPEN_RX.test(line);
  if (c === '#') return headingParts(line) !== null;
  if (c === '-' || c === '*') return RULE_RX.test(line);
  return false;
}

function renderBody(src, linkFn, memo) {
  const lines = src.split('\n');
  let words = 0;
  for (const ln of lines) {
    let inWord = false;
    for (let k = 0; k < ln.length; k++) {
      const code = ln.charCodeAt(k);
      if (code < 128 ? WS128[code] === 1 : /\s/.test(ln[k])) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  }
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let seenPara = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLn(line)) {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === '`') {
      const fence = FENCE_OPEN_RX.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !FENCE_SHUT_RX.test(lines[i])) body.push(lines[i++]);
        i++;
        let code = '';
        for (const bl of body) code += escText(bl) + '\n';
        parts.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escText(lang) + '"') + '>' + code + '</code></pre>\n');
        continue;
      }
    } else if (c0 === '#') {
      const head = headingParts(line);
      if (head !== null) {
        const id = freshSlug(slugOf(head.text, memo), ids);
        const html = inlineMd(head.text, linkFn);
        parts.push('<h' + head.depth + ' id="' + id + '">' + html + '</h' + head.depth + '>\n');
        if (head.depth === 2 || head.depth === 3) toc.push({ level: head.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') body.push(trimEnds(lines[i++].replace(/^> ?/, '')));
      const keptLines = body.filter((l) => l !== '');
      if (keptLines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>' + inlineMd(keptLines.join('\n'), linkFn) + '</p>\n</blockquote>\n');
      continue;
    }
    let listRx = null;
    let listOrdered = false;
    let listStart = 1;
    if (c0 === '-' || c0 === '*') {
      if (RULE_RX.test(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      if (BULLET_RX.test(line)) {
        listRx = BULLET_RX;
      }
    } else if (c0 >= '0' && c0 <= '9') {
      const o = ORDER_RX.exec(line);
      if (o !== null) {
        listRx = ORDER_RX;
        listOrdered = true;
        listStart = Number(o[1]);
      }
    }
    if (listRx !== null) {
      const items = [];
      while (i < lines.length) {
        const mm = listRx.exec(lines[i]);
        if (mm !== null) {
          items.push([trimEnds(listOrdered ? mm[2] : mm[1])]);
          i++;
        } else if (CONT_RX.test(lines[i])) {
          items[items.length - 1].push(trimEnds(lines[i]));
          i++;
        } else break;
      }
      const tag = listOrdered ? 'ol' : 'ul';
      const open = listOrdered && listStart !== 1 ? '<ol start="' + listStart + '">' : '<' + tag + '>';
      let inner = '';
      for (const item of items) inner += '<li>' + inlineMd(item.join('\n'), linkFn) + '</li>\n';
      parts.push(open + '\n' + inner + '</' + tag + '>\n');
      continue;
    }
    const acc = [trimEnds(line)];
    i++;
    while (i < lines.length && !endsPara(lines[i])) acc.push(trimEnds(lines[i++]));
    const html = inlineMd(acc.join('\n'), linkFn);
    if (!seenPara) {
      excerpt = html;
      seenPara = true;
    }
    parts.push('<p>' + html + '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt, words };
}

// ------------------------------------------------------------------ templates

class TplErr extends Error {
  constructor(name, why) {
    super('template "' + name + '": ' + why);
    this.name = 'TplErr';
  }
}

function pathParts(name, text) {
  if (!PATH_RX.test(text)) throw new TplErr(name, JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenizeTpl(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplErr(name, 'a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') {
        toks.push({ k: 0, s: text });
        text = '';
      }
      toks.push({ k: raw ? 2 : 1, p: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(name, 'a {% is not closed');
    const end = close + 2;
    const ls = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const le = nl === -1 ? src.length : nl;
    const alone = WS_ONLY.test(src.slice(ls, open)) && WS_ONLY.test(src.slice(end, le));
    if (alone) text = text.slice(0, text.length - (open - ls));
    if (text !== '') {
      toks.push({ k: 0, s: text });
      text = '';
    }
    toks.push({ k: 6, s: src.slice(open + 2, close).trim() });
    i = alone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push({ k: 0, s: text });
  return toks;
}

function parseTpl(name, src) {
  const root = [];
  const stack = [{ node: null, body: root }];
  for (const tok of tokenizeTpl(name, src)) {
    const top = stack[stack.length - 1];
    if (tok.k === 0) {
      top.body.push({ k: 0, s: tok.s });
    } else if (tok.k === 1 || tok.k === 2) {
      top.body.push({ k: tok.k, p: tok.p });
    } else {
      const tag = tok.s;
      let m;
      if ((m = FOR_RX.exec(tag)) !== null) {
        const node = { k: 3, v: m[1], p: pathParts(name, m[2]), body: [] };
        top.body.push(node);
        stack.push({ node, body: node.body });
      } else if ((m = IF_RX.exec(tag)) !== null) {
        const node = { k: 4, neg: m[1] !== undefined, p: pathParts(name, m[2]), a: [], b: null };
        top.body.push(node);
        stack.push({ node, body: node.a });
      } else if (tag === 'else') {
        if (top.node === null || top.node.k !== 4 || top.node.b !== null) throw new TplErr(name, 'an else outside an if');
        top.node.b = [];
        top.body = top.node.b;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 3 : 4;
        if (top.node === null || top.node.k !== want) throw new TplErr(name, 'an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
      } else if ((m = INC_RX.exec(tag)) !== null) {
        top.body.push({ k: 5, name: m[1] });
      } else {
        throw new TplErr(name, '{% ' + tag + ' %} is not a tag');
      }
    }
  }
  if (stack.length > 1) {
    const open = stack[stack.length - 1].node;
    throw new TplErr(name, 'a ' + (open.k === 3 ? 'for' : 'if') + ' is not closed');
  }
  return root;
}

function resolvePath(frames, path) {
  let f = frames.length - 1;
  while (f >= 0 && !Object.hasOwn(frames[f], path[0])) f--;
  if (f < 0) return undefined;
  let v = frames[f][path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOfVal(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfVal).join(', ');
  return '';
}

function truthyOf(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderTpl(nodes, frames, tpls, depth, parts) {
  for (const nd of nodes) {
    if (nd.k === 0) parts.push(nd.s);
    else if (nd.k === 1) parts.push(escText(textOfVal(resolvePath(frames, nd.p))));
    else if (nd.k === 2) parts.push(textOfVal(resolvePath(frames, nd.p)));
    else if (nd.k === 4) {
      const branch = truthyOf(resolvePath(frames, nd.p)) !== nd.neg ? nd.a : nd.b;
      if (branch !== null) renderTpl(branch, frames, tpls, depth, parts);
    } else if (nd.k === 3) {
      const xs = resolvePath(frames, nd.p);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          frames.push({ [nd.v]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
          renderTpl(nd.body, frames, tpls, depth, parts);
          frames.pop();
        }
      }
    } else if (nd.k === 5) {
      const t = tpls.get(nd.name);
      if (t !== undefined && depth < 8) renderTpl(t, frames, tpls, depth + 1, parts);
    }
  }
}

// ------------------------------------------------------------------ the build

export function run(input) {
  const memo = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const rep = [];
  const tpls = new Map();
  for (const name of Object.keys(input.templates).sort(CMP)) {
    try {
      tpls.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TplErr) rep.push(err.message);
      else throw err;
    }
  }
  const ordered = [...input.files].sort((a, b) => CMP(a.path, b.path));
  const srcs = [];
  const stats = [];
  for (const f of ordered) {
    if (f.path.endsWith('.md')) srcs.push({ path: f.path, raw: f.content.replace(/\r\n?/g, '\n') });
    else stats.push(f);
  }
  const kept = [];
  for (const s of srcs) {
    const fm = parseFM(s.raw);
    if ('error' in fm) {
      rep.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.isPost = s.path.startsWith('posts/');
    const ownDir = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : '';
    if (ownDir !== '') {
      rep.push('refused ' + s.path + ': ' + ownDir + '/ is the generator\'s own');
      continue;
    }
    if (s.isPost && !Object.hasOwn(s.data, 'date')) {
      rep.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layoutName = s.data.layout !== undefined ? s.data.layout : s.isPost ? 'post' : 'page';
    if (!tpls.has(layoutName)) {
      rep.push('refused ' + s.path + ': layout "' + layoutName + '" is no template that parses');
      continue;
    }
    s.layout = layoutName;
    if (s.data.draft === true) {
      rep.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }
  const byPath = new Map();
  const takenByDir = new Map();
  for (const s of kept) {
    const dir = s.isPost ? 'posts' : dirOfPath(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    s.slug = freshSlug(s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title, memo), taken);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    byPath.set(s.path, s);
  }
  const staticSet = new Set(stats.map((f) => f.path));
  const brokenSet = new Set();
  for (const s of kept) {
    const dir = dirOfPath(s.path);
    const linkFn = (target) => {
      if (SCHEME_RX.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hashAt = target.indexOf('#');
      const rel = hashAt === -1 ? target : target.slice(0, hashAt);
      const frag = hashAt === -1 ? '' : target.slice(hashAt);
      const resolved = rel === '' ? null : resolveRel(dir, rel);
      if (resolved !== null && byPath.has(resolved)) return byPath.get(resolved).url + frag;
      if (resolved !== null && staticSet.has(resolved)) return base + '/' + resolved + frag;
      brokenSet.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const rendered = renderBody(s.body, linkFn, memo);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
    s.words = rendered.words;
  }
  const postsArr = kept.filter((s) => s.isPost);
  postsArr.sort((x, y) => CMP(y.data.date, x.data.date) || CMP(x.slug, y.slug));
  postsArr.forEach((p, k) => {
    p.newer = k === 0 ? null : postsArr[k - 1];
    p.older = k === postsArr.length - 1 ? null : postsArr[k + 1];
  });
  const tagBySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (const name of names) {
      const slug = slugOf(name, memo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of postsArr) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugOf(name, memo);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.isPost) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugOf(name, memo);
      const found = tagBySlug.get(slug);
      return found !== undefined ? found : { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || CMP(x.slug, y.slug));
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cardByPost = new Map(postsArr.map((p) => [p, cardOf(p)]));
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
  });
  const pageOf = (s) => {
    const card = cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.isPost,
    };
  };
  const siteCtx = { title: input.site.title, base_url: base };
  const tagsCtx = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCtx = postsArr.slice(0, input.site.recent).map((p) => cardByPost.get(p));
  const out = {};
  const renderPage = (name, extra) => {
    const nodes = tpls.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderTpl(nodes, [{ site: siteCtx, tags: tagsCtx, recent: recentCtx, ...extra }], tpls, 0, parts);
    return parts.join('');
  };
  for (const s of kept) out[s.outDir + '/index.html'] = renderPage(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(postsArr.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = renderPage('index', {
      posts: postsArr.slice((k - 1) * per, k * per).map((p) => cardByPost.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) out[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tagList) {
    const html = renderPage('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cardByPost.get(p)),
      },
    });
    if (html !== null) out['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = renderPage('tags', {});
  if (tagsHtml !== null) out['tags/index.html'] = tagsHtml;
  for (const f of stats) {
    if (Object.hasOwn(out, f.path)) rep.push('shadowed ' + f.path + ': a built page has its path');
    else out[f.path] = f.content;
  }
  const lines = [...rep, ...brokenSet].sort(CMP);
  lines.push('built ' + kept.filter((s) => !s.isPost).length + ' pages, ' + postsArr.length + ' posts, ' + tagList.length + ' tags and ' + stats.length + ' static files');
  out['build-report.txt'] = lines.join('\n') + '\n';
  return out;
}
