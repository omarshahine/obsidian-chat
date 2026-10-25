const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path').posix;
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the component's actual handlers without loading Obsidian or a
// browser. Extract declarations through the TypeScript AST so tests track
// production code while keeping the host/DOM boundary explicitly stubbed.
const component = fs.readFileSync('src/ui/ChatContainer.svelte', 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('ChatContainer.ts', script, ts.ScriptTarget.Latest, true);
const names = new Set(['renderMarkdown', 'markdown', 'panePreference', 'handleLinkClick', 'openPath']);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && (names.has(node.name?.text) || node.name?.text === 'decodeLinkText'));
assert.equal(declarations.filter(node => names.has(node.name.text)).length, names.size);
const handlers = ts.transpile(declarations.map(node => node.getText(ast)).join('\n'), { target: ts.ScriptTarget.ES2022 });

function fixture({ activePath = 'folder/Source.md', files = ['folder/Source.md', 'folder/Note.md', 'Other.md', 'A B.md', 'literal%20name.md', 'literal%23name.md'] } = {}) {
  const opened = [], notices = [], lookups = [], rendered = [];
  const existing = new Set(files);
  const app = {
    metadataCache: {
      getFirstLinkpathDest(target, source) {
        lookups.push({ target, source });
        if (!target) return existing.has(source) ? { path: source } : null;
        const relative = path.normalize(path.dirname(source) + '/' + target);
        const candidates = target.startsWith('./') || target.startsWith('../')
          ? [relative, relative + '.md']
          : [target, target + '.md', relative, relative + '.md'];
        const found = candidates.find(candidate => existing.has(candidate));
        return found ? { path: found } : null;
      }
    },
    vault: { getFileByPath: target => existing.has(target) ? { path: target } : null },
    workspace: {
      getActiveFile: () => activePath ? { path: activePath } : null,
      openLinkText: (link, source, pane) => opened.push({ link, source, pane }),
      getLeaf: pane => ({ openFile: file => opened.push({ file: file.path, pane }) })
    }
  };
  const ctx = vm.createContext({
    app, component: {},
    MarkdownRenderer: { render: (...args) => rendered.push(args) },
    Notice: function(message) { notices.push(message); },
    Keymap: { isModEvent: event => event.metaKey || event.ctrlKey ? (event.altKey ? 'split' : true) : false }
  });
  vm.runInContext(handlers, ctx);
  function click(href, options = {}) {
    const { type = 'click', button = 0, internal = true, dataHref = true, metaKey = false, ctrlKey = false, altKey = false, nested = false } = options;
    const anchor = {
      getAttribute: key => key === 'data-href' ? (dataHref ? href : null) : key === 'href' ? href : null,
      classList: { contains: cls => internal && cls === 'internal-link' }
    };
    const event = {
      type, button, metaKey, ctrlKey, altKey,
      target: { closest: selector => { assert.equal(selector, 'a'); return anchor; }, ...(nested ? { tagName: 'STRONG' } : {}) },
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    ctx.handleLinkClick(event);
    return event;
  }
  return { ctx, click, opened, notices, lookups, rendered };
}

for (const link of ['Note', './Note.md', '../Other.md', 'A B.md', 'Note#A heading', 'Note#^block', 'literal%20name', 'literal%23name']) {
  test(`opens existing rendered target exactly: ${link}`, () => {
    const f = fixture();
    const event = f.click(link, { nested: true });
    assert.equal(f.opened.length, 1);
    assert.equal(f.opened[0].link, link);
    assert.equal(f.opened[0].source, 'folder/Source.md');
    assert.equal(f.opened[0].pane, false);
    assert.equal(f.notices.length, 0);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  });
}

for (const link of ['#Heading', '#^block']) {
  test(`self-link requires an existing source note: ${link}`, () => {
    for (const activePath of ['', 'Deleted.md', 'folder/Source.md']) {
      const f = fixture({ activePath });
      f.click(link);
      assert.equal(f.lookups[0].target, '');
      assert.equal(f.lookups[0].source, activePath);
      assert.equal(f.opened.length, activePath === 'folder/Source.md' ? 1 : 0);
      assert.equal(f.notices.length, activePath === 'folder/Source.md' ? 0 : 1);
    }
  });
}

for (const link of ['Missing', 'Missing#Heading', 'A%20B', '%23Heading', 'A%2520B', 'Bad%escape']) {
  test(`missing/literal encoded target never falls back or creates: ${link}`, () => {
    const f = fixture();
    f.click(link);
    assert.equal(f.opened.length, 0);
    assert.equal(f.notices.length, 1);
    assert.equal(f.lookups.length, 1);
    assert.equal(f.lookups[0].target, link.split('#')[0]);
  });
}

test('literal encoded note wins even when decoded note also exists', () => {
  const f = fixture({ files: ['A%20B.md', 'A B.md'] });
  f.click('A%20B');
  assert.equal(f.opened[0].link, 'A%20B');
});

test('rendered Markdown target with spaces is not decoded a second time', () => {
  // Obsidian converts [label](A%20B.md) to data-href="A B.md".
  const f = fixture();
  f.click('A B.md');
  assert.equal(f.opened[0].link, 'A B.md');
});

for (const href of ['https://example.com', 'mailto:test@example.com', '#fn-1', '#tag', 'javascript:alert(1)']) {
  test(`ordinary external/tag/footnote anchor is left alone: ${href}`, () => {
    const f = fixture();
    const event = f.click(href, { internal: false, dataHref: false });
    assert.equal(f.opened.length, 0);
    assert.equal(f.lookups.length, 0);
    assert.equal(event.prevented, undefined);
  });
}

test('href fallback supports internal anchors without data-href', () => {
  const f = fixture();
  f.click('Note', { dataHref: false });
  assert.equal(f.opened[0].link, 'Note');
});

for (const [options, pane] of [[{ metaKey: true }, true], [{ ctrlKey: true }, true], [{ metaKey: true, altKey: true }, 'split'], [{ type: 'auxclick', button: 1 }, 'tab']]) {
  test(`navigation respects pane preference ${JSON.stringify(options)}`, () => {
    const f = fixture();
    f.click('Note', options);
    assert.equal(f.opened[0].pane, pane);
  });
}

test('right auxclick does not intercept context menus', () => {
  const f = fixture();
  const event = f.click('Note', { type: 'auxclick', button: 2 });
  assert.equal(f.opened.length, 0);
  assert.equal(event.prevented, undefined);
});

test('non-link and null click targets are harmless', () => {
  const f = fixture();
  for (const target of [null, { closest: () => null }]) f.ctx.handleLinkClick({ type: 'click', target });
  assert.equal(f.opened.length, 0);
});

test('markdown action installs listeners once, updates, and removes on destroy', () => {
  const f = fixture();
  const listeners = new Map();
  const node = { empty() {}, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type, fn) => { assert.equal(listeners.get(type), fn); listeners.delete(type); } };
  const action = f.ctx.markdown(node, '[[Note]]');
  assert.deepEqual([...listeners.keys()], ['click', 'auxclick']);
  action.update('[[Other]]');
  assert.equal(f.rendered.length, 2);
  assert.equal(listeners.size, 2);
  action.destroy();
  assert.equal(listeners.size, 0);
});

test('tool result links use middle-click tabs and reject missing files', () => {
  const f = fixture();
  const event = { button: 1, preventDefault() { this.prevented = true; } };
  f.ctx.openPath('folder/Note.md', event);
  assert.equal(event.prevented, true);
  assert.equal(f.opened[0].pane, 'tab');
  assert.equal(f.opened[0].file, 'folder/Note.md');
  f.ctx.openPath('Missing.md', event);
  assert.equal(f.opened.length, 1);
  assert.equal(f.notices.length, 1);
});
