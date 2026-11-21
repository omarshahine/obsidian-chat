const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Use the actual input handlers and view lifecycle, with a synthetic host and
// controllable response promises. Browser checks also exercise native focus.
const component = fs.readFileSync('src/ui/ChatContainer.svelte', 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const ast = ts.createSourceFile('ChatContainer.ts', script, ts.ScriptTarget.Latest, true);
const names = new Set(['handleSend', 'handleKeydown', 'keepFocus', 'resetHeight', 'setInputEnabled', 'focus', 'showAskUser', 'cancelAskUser', 'handleSessionChange']);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(declarations.length, names.size);
const handlers = ts.transpile(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n'), { target: ts.ScriptTarget.ES2022 });
const viewCode = ts.transpileModule(fs.readFileSync('src/ui/chat-view.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({ immediate = false } = {}) {
  let active = 'textarea', focusCalls = 0, saved = 0, pending;
  const turns = [], callbacks = [], notices = [], sent = [], answers = [];
  const context = vm.createContext({
    inputText: '', inputEnabled: true, placeholder: 'Ask anything...', selection: null,
    askUserResolve: null, textareaEl: { style: {}, focus() { active = 'textarea'; focusCalls++; } },
    addUserMessage: text => answers.push(text),
    addAssistantMessage() {},
    onSend: (text, selection) => { sent.push({ text, selection }); pending = view.handleUserMessage(text, selection); },
  });
  vm.runInContext(handlers, context);
  const session = { id: 'test', title: 'Test', chatHistory: [], touch() {}, maybeTitleFrom() {}, agent: {
    run(_prompt, handlers) {
      callbacks.push(handlers);
      if (immediate) return Promise.resolve();
      return new Promise(resolve => turns.push(resolve));
    }, abort() {}, clear() {},
  } };
  const plugin = { sessions: { active: () => session, list: () => [session] }, saveChatHistory() { saved++; } };
  const exports = {};
  const host = vm.createContext({ exports, require(name) {
    if (name === 'obsidian') return { ItemView: class {}, Notice: function(text) { notices.push(text); } };
    if (name === 'svelte') return { unmount() {} };
    if (name === './ChatContainer.svelte') return {};
    if (name === '../settings') return {};
    throw new Error('Unexpected import: ' + name);
  } });
  vm.runInContext(viewCode, host);
  const view = new exports.ObsidianChatView({}, plugin);
  view.chatContainer = {
    setInputEnabled: context.setInputEnabled, focus: context.focus,
    showAskUser: context.showAskUser, cancelAskUser: context.cancelAskUser,
    addUserMessage() {}, setSessions() {}, hideThinking() {}, clearMessages() {},
  };
  return { context, view, turns, callbacks, sent, answers, notices,
    get active() { return active; }, get focusCalls() { return focusCalls; }, get saved() { return saved; },
    moveFocus(target = 'other pane') { active = target; },
    send(text = 'hello') { context.inputText = text; context.handleSend(); return pending; },
    key(options) { const event = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, prevented: false,
      preventDefault() { this.prevented = true; }, ...options }; context.handleKeydown(event); return event; },
  };
}

for (const immediate of [true, false]) {
  test(`${immediate ? 'short' : 'delayed'} completion preserves deliberately moved focus and draft`, async () => {
    const f = fixture({ immediate });
    const pending = f.send();
    f.context.inputText = 'next draft';
    f.moveFocus();
    const focusBeforeCompletion = f.focusCalls;
    if (!immediate) f.turns[0]();
    await pending;
    assert.equal(f.active, 'other pane');
    assert.equal(f.focusCalls, focusBeforeCompletion);
    assert.equal(f.context.inputText, 'next draft');
    assert.equal(f.context.inputEnabled, true);
    assert.equal(f.saved, 1);
  });
}

test('explicit keyboard send restores textarea focus, then a busy Enter keeps its draft', async () => {
  const f = fixture();
  f.moveFocus('send button');
  const pending = f.send(' first ');
  assert.equal(f.active, 'textarea');
  assert.equal(f.sent[0].text, 'first');
  f.context.inputText = 'next draft';
  assert.equal(f.key({}).prevented, true);
  assert.equal(f.context.inputText, 'next draft');
  assert.equal(f.sent.length, 1);
  assert.equal(f.focusCalls, 1);
  assert.equal(f.key({ shiftKey: true }).prevented, false);
  f.turns[0]();
  await pending;
});

test('Stop focuses the input immediately; stale completion cannot take focus later', async () => {
  const f = fixture();
  const old = f.send();
  f.context.inputText = 'draft after stop';
  f.moveFocus('stop button');
  f.view.handleStop();
  assert.equal(f.active, 'textarea');
  assert.equal(f.context.inputText, 'draft after stop');
  assert.equal(f.context.inputEnabled, true);
  const focusAfterStop = f.focusCalls;
  f.moveFocus();
  f.turns[0]();
  await old;
  assert.equal(f.active, 'other pane');
  assert.equal(f.focusCalls, focusAfterStop);
});

test('a stopped turn cannot unlock a new running turn', async () => {
  const f = fixture();
  const old = f.send('old');
  f.view.handleStop();
  const current = f.send('new');
  f.moveFocus();
  f.turns[0]();
  await old;
  assert.equal(f.context.inputEnabled, false);
  assert.equal(f.active, 'other pane');
  f.turns[1]();
  await current;
  assert.equal(f.context.inputEnabled, true);
  assert.equal(f.active, 'other pane');
});

for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`IME Enter remains untouched: ${JSON.stringify(options)}`, () => {
    const f = fixture();
    f.context.inputText = '候補';
    const e = f.key(options);
    assert.equal(e.prevented, false);
    assert.equal(f.context.inputText, '候補');
    assert.equal(f.sent.length, 0);
    assert.equal(f.focusCalls, 0);
  });
}

test('mouse/touch compatibility mousedown cancels only default focus movement', () => {
  const f = fixture();
  let prevented = false;
  f.context.keepFocus({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.active, 'textarea');
  assert.equal(f.sent.length, 0);
});

test('answering ask_user keeps its answer path and restores explicit-send focus', () => {
  const f = fixture();
  let answer;
  f.context.askUserResolve = text => answer = text;
  f.moveFocus('send button');
  f.send(' answer ');
  assert.equal(answer, 'answer');
  assert.deepEqual(f.answers, ['answer']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.active, 'textarea');
});


test('pending question cue follows the free-text answer lifecycle', async () => {
  const f = fixture();
  assert.equal(f.context.askUserResolve, null);
  const answer = f.context.showAskUser('Which note?');
  assert.equal(typeof f.context.askUserResolve, 'function');
  assert.equal(f.context.placeholder, 'Type your answer...');
  f.send('the second note');
  assert.equal(await answer, 'the second note');
  assert.equal(f.context.askUserResolve, null);
});

test('stopping a pending question releases it and next send starts a new turn', async () => {
  const f = fixture({ immediate: true });
  const answer = f.context.showAskUser('Which note?');
  f.view.handleStop();
  assert.equal(await answer, '');
  assert.equal(f.context.askUserResolve, null);
  assert.equal(f.context.placeholder, 'Ask anything...');
  await f.send('new message');
  assert.equal(f.sent[0].text, 'new message');
  assert.deepEqual(f.answers, []);
});


test('a rejected switch restores the selected chat without rebuilding a pending transcript', async () => {
  const f = fixture();
  f.context.activeSessionId = 'test';
  f.context.onSelectSession = id => f.view.switchSession(id);
  const pending = f.send();
  const question = f.context.showAskUser('Which note?');
  const select = { value: 'other' };
  f.context.handleSessionChange({ currentTarget: select });
  assert.equal(select.value, 'test');
  assert.equal(typeof f.context.askUserResolve, 'function');
  f.send('the second note');
  assert.equal(await question, 'the second note');
  f.turns[0]();
  await pending;
});


for (const cancel of ['handleClear', 'onClose']) {
  test(`${cancel} releases a pending question and frees the current chat`, async () => {
    const f = fixture();
    const pending = f.send();
    const question = f.context.showAskUser('Which note?');
    await f.view[cancel]();
    assert.equal(await question, '');
    assert.equal(f.context.askUserResolve, null);
    assert.equal(f.view.canSwitchSession(), true);
    f.turns[0]();
    await pending;
  });
}


test('a canceled question callback cannot disable the next turn’s pending answer', async () => {
  const f = fixture();
  const oldTurn = f.send('first prompt');
  const oldQuestion = f.callbacks[0].onAskUser('Which note first?');
  f.view.handleClear();

  // The first question's async callback resumes in a microtask. Start an
  // independent turn with its own question before that continuation runs.
  const newTurn = f.send('next prompt');
  const newQuestion = f.callbacks[1].onAskUser('Which note next?');
  assert.equal(await oldQuestion, '');
  assert.equal(f.context.inputEnabled, true);
  assert.equal(f.context.placeholder, 'Type your answer...');
  f.send('the second note');
  assert.equal(await newQuestion, 'the second note');
  assert.equal(f.context.inputEnabled, false);

  f.turns[0]();
  f.turns[1]();
  await Promise.all([oldTurn, newTurn]);
  assert.equal(f.context.inputEnabled, true);
});
