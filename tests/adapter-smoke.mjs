// ChatShot adapter smoke test — zero dependencies.
//
// Loads the REAL adapters.js and runs the real selection pipeline (selector →
// outermost filter → getBlocks) against per-platform fixture trees that mirror
// the live DOM structure (verified on real pages, see CHANGELOG 1.5.2/1.5.3).
//
// What this catches (the v1.5.1 regression class):
//   - a responseSelector that resolves "latest response" to a LEAF element
//     (substring [class*=…] matches, or ancestor fallbacks fighting the
//     outermost filter) → block count collapses to 1
//   - getBlocks config changes that drop code/table detection
//
// Run: node tests/adapter-smoke.mjs   (or: npm test)
// Copilot adapter is not covered: its selector uses an escaped class
// (group\/ai-message-item) this mini shim intentionally does not parse.

globalThis.window = globalThis;
await import(new URL('../adapters.js', import.meta.url).href);
const { LLM_ADAPTERS } = window.ChatShotAdapters;

// ---------------------------------------------------------------------------
// Mini DOM: just enough for the adapter pipeline (matches/closest/querySelector
// with comma lists, compound units, and descendant combinators).
// ---------------------------------------------------------------------------
let uidCounter = 0;
class El {
  constructor(tag, cls = '', attrs = {}) {
    this.uid = ++uidCounter;
    this.tagName = tag.toUpperCase();
    this.classList = new Set(String(cls).split(/\s+/).filter(Boolean));
    this.classList.contains = c => this.classList.has(c); // DOMTokenList compat
    this.attrs = attrs;
    this.childNodes = []; // El | string
    this.parentElement = null;
  }
  get children() { return this.childNodes.filter(n => n instanceof El); }
  get className() { return [...this.classList].join(' '); }
  get textContent() {
    return this.childNodes.map(n => typeof n === 'string' ? n : n.textContent).join('');
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.children;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  appendChild(node) {
    if (typeof node === 'string') { this.childNodes.push(node); return node; }
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  add(...nodes) { nodes.forEach(n => this.appendChild(n)); return this; }
  matches(sel) {
    return String(sel).split(',').some(part => part.trim() && this.matchPart(part.trim()));
  }
  matchPart(part) {
    const units = part.split(/\s+/).filter(Boolean);
    if (!El.matchCompound(units[units.length - 1], this)) return false;
    let i = units.length - 2;
    let cur = this.parentElement;
    while (cur && i >= 0) {
      if (El.matchCompound(units[i], cur)) i--;
      cur = cur.parentElement;
    }
    return i < 0;
  }
  static matchCompound(unit, node) {
    let rest = unit;
    const attrs = [];
    // 注意排除 "=" 和 '"'：否则属性名贪婪吞掉 `name="value"` 整段，
    // 值比较退化为存在性检查（chatgpt fixture 首跑踩过）
    const attrRe = /\[([^\s\]~^$|*="]+)(?:([~^$|*]?=)"([^"]*)")?\]/g;
    let m;
    while ((m = attrRe.exec(rest))) attrs.push([m[1], m[2], m[3]]);
    rest = rest.replace(attrRe, '');
    const classes = [];
    const classRe = /\.([\w-]+)/g;
    while ((m = classRe.exec(rest))) classes.push(m[1]);
    rest = rest.replace(classRe, '').trim();
    if (rest && rest !== '*' && node.tagName !== rest.toUpperCase()) return false;
    for (const c of classes) if (!node.classList.has(c)) return false;
    for (const [name, op, val] of attrs) {
      const actual = name === 'class' ? node.className : node.attrs[name];
      if (actual === undefined) return false;
      if (op === undefined) continue;
      if (op === '=') { if (String(actual) !== val) return false; }
      else if (op === '*=') { if (!String(actual).includes(val)) return false; }
      else return false;
    }
    return true;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const seen = new Set();
    const walk = node => {
      for (const c of node.children) {
        if (c.matches(sel) && !seen.has(c.uid)) { seen.add(c.uid); out.push(c); }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const el = (tag, cls, attrs) => new El(tag, cls, attrs);

// Mirrors content.js latestResponseElement(): outermost matches only.
function resolveLatest(adapter, root) {
  const all = root.querySelectorAll(adapter.responseSelector);
  const outer = all.filter(n => !(n.parentElement && n.parentElement.closest(adapter.responseSelector)));
  return { all, outer, latest: outer.length ? outer[outer.length - 1] : null };
}

// ---------------------------------------------------------------------------
// Fixtures — each mirrors the real platform DOM structure.
// ---------------------------------------------------------------------------
function td(txt) { return el('td', '', {}).add(txt); }
function table() { return el('table', '', {}).add(el('tr', '', {}).add(td('A1')), el('tr', '', {}).add(td('B1'))); }
function codePre() { return el('pre', '', {}).add(el('code', '', {}).add(el('span', '', {}).add('const x = 1;'))); }

const FIXTURES = [
  {
    name: 'deepseek',
    minBlocks: 6, needTypes: ['code', 'table'],
    titleIncludes: '给我生成6大段测试内容',
    build() {
      const container = el('div', 'ds-markdown ds-assistant-message-main-content').add(
        el('p', 'ds-markdown-paragraph').add('第一段'),
        el('p', 'ds-markdown-paragraph').add('第二段'),
        el('hr', '', {}),
        el('h2', '', {}).add('标题一'),
        el('p', 'ds-markdown-paragraph').add('段落'),
        el('span', 'katex-display ds-markdown-math').add('E=mc^2'),
        el('div', 'ds-scroll-area').add(table()),
        el('p', 'ds-markdown-paragraph').add('表格后段落'),
        el('div', 'md-code-block').add(codePre()),
        el('p', 'ds-markdown-paragraph').add('代码后'),
        el('hr', '', {}),
        el('h2', '', {}).add('标题二'),
        el('p', 'ds-markdown-paragraph').add('尾段')
      );
      // 裸 .ds-markdown 的思考流内容：选择器收紧后不得命中（1.5.3 锁定）
      const think = el('div', 'ds-think-content').add(
        el('div', 'ds-markdown').add('思考过程片段，不应被选中')
      );
      const row = el('div', '_4f9bf79 d7dc56a8 _43c05b5').add(
        think,
        el('div', 'ds-message _63c77b1').add(container)
      );
      const root = el('div', '', {}).add(
        el('div', '_4f9bf79 _43c05b5').add('给我生成6大段测试内容'),
        row
      );
      return { root, container };
    }
  },
  {
    name: 'chatgpt',
    minBlocks: 4, needTypes: ['code'],
    build() {
      const container = el('div', 'markdown prose').add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('ul', '', {}).add(el('li', '', {}).add('x'), el('li', '', {}).add('y'), el('li', '', {}).add('z')),
        el('ol', '', {}).add(el('li', '', {}).add('1'), el('li', '', {}).add('2')),
        el('p', '', {}).add('b'),
        codePre()
      );
      const root = el('div', '', {}).add(
        el('div', '', { 'data-message-author-role': 'user' }).add('q1'),
        el('div', '', { 'data-message-author-role': 'assistant' }).add(container)
      );
      return { root, container };
    }
  },
  {
    name: 'gemini',
    minBlocks: 3, needTypes: ['code'],
    build() {
      const container = el('div', 'markdown markdown-main-panel').add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('p', '', {}).add('b'),
        el('hr', '', {}),
        el('p', '', {}).add('c'),
        codePre()
      );
      // message-content 是容器祖先：1.5.3 起不得再列为候选（最外层过滤会选中它）
      const root = el('div', '', {}).add(
        el('div', 'query-text').add('q'),
        el('message-content', '').add(container)
      );
      return { root, container };
    }
  },
  {
    name: 'doubao',
    minBlocks: 3, needTypes: ['table'],
    build() {
      const container = el('div', 'flow-markdown-body', { 'data-testid': 'message_text_content' }).add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('div', 'md-box-line-break').add(' '),
        el('hr', '', {}),
        el('p', '', {}).add('b'),
        table()
      );
      return { root: el('div', '', {}).add(container), container };
    }
  },
  {
    name: 'kimi',
    minBlocks: 3, needTypes: ['code'],
    build() {
      const container = el('div', 'markdown').add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('p', '', {}).add('b'),
        el('h3', '', {}).add('S'),
        el('p', '', {}).add('c'),
        codePre()
      );
      const root = el('div', '', {}).add(
        el('div', 'chat-message-item').add(container)
      );
      return { root, container };
    }
  },
  {
    name: 'qianwen',
    minBlocks: 4, needTypes: ['code', 'table'],
    build() {
      const container = el('div', 'qk-markdown').add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('div', 'qk-md-hr').add(' '),
        el('p', '', {}).add('b'),
        el('pre', 'qk-md-code').add(el('code', '', {}).add('x')),
        table()
      );
      return { root: el('div', '', {}).add(container), container };
    }
  },
  {
    name: 'chatglm',
    minBlocks: 3, needTypes: ['code'],
    build() {
      const container = el('div', 'answer-content-wrap').add(
        el('div', 'markdown-body md-body').add(
          el('h3', '', {}).add('T'),
          el('p', '', {}).add('a'),
          el('p', '', {}).add('b')
        ),
        el('div', 'code-no-artifacts').add('code text'),
        el('div', 'markdown-body md-body').add(el('p', '', {}).add('c'))
      );
      return { root: el('div', '', {}).add(container), container };
    }
  },
  {
    name: 'qwenai',
    minBlocks: 4, needTypes: ['code'],
    build() {
      const container = el('div', 'qwen-markdown').add(
        el('div', 'qwen-markdown-space').add(' '),
        el('p', '', {}).add('a'),
        el('div', 'qwen-markdown-hr').add(' '),
        el('div', 'qwen-markdown-space').add(' '),
        el('p', '', {}).add('b'),
        el('h2', 'qwen-markdown-heading').add('T'),
        el('p', '', {}).add('c'),
        el('pre', 'qwen-markdown-code').add(el('code', '', {}).add('x'))
      );
      return { root: el('div', '', {}).add(container), container };
    }
  },
  {
    name: 'notebooklm',
    minBlocks: 2, needTypes: [],
    build() {
      const lab = (txt, heading) => {
        const n = el('labs-tailwind-structural-element-view-v2', '').add(
          heading ? el('div', 'paragraph heading3').add(txt) : txt
        );
        return n;
      };
      const container = el('div', 'message-text-content').add(
        lab('标题', true), lab('段一'), lab('段二')
      );
      const root = el('div', 'chat-message-pair').add(
        el('div', 'from-user-container').add(el('div', 'message-text-content').add('user question')),
        el('div', 'to-user-message-card-content').add(container)
      );
      return { root, container };
    }
  },
  {
    name: 'claude',
    minBlocks: 3, needTypes: ['table'],
    build() {
      const container = el('div', 'font-claude-message').add(
        el('h2', '', {}).add('T'),
        el('p', '', {}).add('a'),
        el('p', '', {}).add('b'),
        el('hr', '', {}),
        el('p', '', {}).add('c'),
        table()
      );
      const root = el('div', '', { 'data-test-render-count': '1' }).add(
        el('div', '', { 'data-testid': 'user-message' }).add('user q'),
        el('div', '', { 'data-testid': 'assistant-message' }).add(container)
      );
      return { root, container };
    }
  }
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let failed = 0;
function check(name, cond, extra) {
  if (!cond) {
    failed++;
    console.log('FAIL  ' + name + (extra !== undefined ? '  <- ' + extra : ''));
  } else {
    console.log('PASS  ' + name);
  }
}

for (const spec of FIXTURES) {
  const adapter = LLM_ADAPTERS[spec.name];
  if (!adapter) { check(spec.name + ': adapter exists', false, 'missing in LLM_ADAPTERS'); continue; }
  const { root, container } = spec.build();
  const { all, outer, latest } = resolveLatest(adapter, root);

  check(spec.name + ': selector matches something', all.length > 0, all.length + ' raw');
  check(spec.name + ': latest resolves to the response container',
    latest === container,
    'got ' + (latest ? latest.tagName + '.' + latest.className : 'null'));

  const blocks = latest ? adapter.getBlocks(latest) : [];
  const types = blocks.map(b => b.type);
  check(spec.name + ': block count >= ' + spec.minBlocks, blocks.length >= spec.minBlocks,
    'got ' + blocks.length + ' [' + types.join(',') + ']');
  for (const t of spec.needTypes) {
    check(spec.name + ': detects "' + t + '" blocks', types.includes(t), '[' + types.join(',') + ']');
  }

  if (spec.titleIncludes) {
    const title = adapter.getResponseTitle(latest, 0);
    check(spec.name + ': title from preceding user turn', title.includes(spec.titleIncludes), JSON.stringify(title));
  }
}

console.log('---');
if (failed) {
  console.log(failed + ' check(s) FAILED');
  process.exit(1);
}
console.log('All adapter smoke checks passed.');
