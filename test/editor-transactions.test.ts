import assert from 'node:assert/strict';
import { DEFAULT_EDITING_OPTIONS, Editor } from '../src/editor/editor.js';
import { DocumentSession } from '../src/markdown/session.js';
import { DEFAULT_INLINE_OPTIONS, parseBlocks } from '../src/markdown/parse.js';

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };
function fixture(text='aOLDz', start=4, end=1) {
  const input = Object.assign(new EventTarget(), {value:'', blur() { this.dispatchEvent(new Event('blur')); }});
  const editor = Object.create(Editor.prototype) as any;
  const session = new DocumentSession({path:'A.md',contents:text,lineEnding:'\n'}, {
    open:async()=>null, save:async(path)=>({path}), confirmLeave:async()=>'cancel', loaded:()=>{}, changed:()=>{},
  });
  // The real editor re-parses on the next frame; here it happens at once, so
  // block-aware keys see the document they would see in the app.
  const reparse = () => { editor.blocks = parseBlocks(editor.text).map((block)=>({block})); };
  Object.assign(editor, {text,selStart:start,selEnd:end,caretAffinity:'upstream',composing:null,
    undoStack:[],redoStack:[],lastEditAt:-Infinity,input,canvas:new EventTarget(),host:{},dirty:false,
    typesetter:{options:{inline:DEFAULT_INLINE_OPTIONS}},
    editingOptions:{...DEFAULT_EDITING_OPTIONS},
    invalidate:()=>reparse(),scrollCaretIntoView:()=>{}, onChange:()=>session.updateText(editor.getText())});
  reparse();
  editor.attach();
  const event=(type:string, props:Record<string,unknown>={})=>input.dispatchEvent(Object.assign(new Event(type),props));
  return {editor,session,input,event};
}
{
  const {editor:e,session:s,event}=fixture();
  event('compositionstart'); assert.equal(e.getText(),'aOLDz'); assert.equal(s.dirty,false);
  event('compositionupdate',{data:'n'}); event('compositionupdate',{data:'ni'});
  assert.equal(e.getText(),'aniz'); assert.equal(e.undoStack.length,0); assert.equal(s.dirty,true);
  event('compositionend',{data:''}); assert.equal(e.getText(),'aOLDz');
  assert.deepEqual([e.selStart,e.selEnd,e.caretAffinity],[4,1,'upstream']);
  assert.equal(e.undoStack.length,0); assert.equal(s.dirty,false);
}
{
  const {editor:e,event,input}=fixture();
  event('compositionstart'); event('compositionupdate',{data:'你'}); event('compositionupdate',{data:'你好'});
  event('compositionend',{data:'你好'}); assert.equal(e.getText(),'a你好z'); assert.equal(e.undoStack.length,1);
  input.value='你好'; event('input',{inputType:'insertFromComposition',isComposing:false});
  assert.equal(e.getText(),'a你好z'); assert.equal(input.value,'');
  e.undo(); assert.equal(e.getText(),'aOLDz'); assert.deepEqual([e.selStart,e.selEnd],[4,1]);
  e.redo(); assert.equal(e.getText(),'a你好z');
  e.undo(); event('keydown',{key:'Z',metaKey:true,shiftKey:true});
  assert.equal(e.getText(),'a你好z', 'Shift-Z dispatches uppercase Z in real browsers');
}
{
  const {editor:e,event}=fixture('a',1,1);
  e.insert('b'); event('compositionstart'); event('compositionend',{data:'中'}); e.insert('c');
  assert.equal(e.getText(),'ab中c'); e.undo(); assert.equal(e.getText(),'ab中');
  e.undo(); assert.equal(e.getText(),'ab'); e.undo(); assert.equal(e.getText(),'a');
  e.redo(); e.insert('x'); assert.equal(e.redoStack.length,0);
  e.undo(); assert.equal(e.getText(),'ab');
}
{
  const {editor:e,session:s,event}=fixture();
  event('compositionstart'); event('compositionupdate',{data:'保存'});
  e.finishComposition(); await s.save(); assert.equal(e.getText(),'a保存z'); assert.equal(s.dirty,false);
  event('compositionend',{data:'保存'}); assert.equal(e.undoStack.length,1);
  e.undo(); assert.equal(e.getText(),'aOLDz'); assert.equal(s.dirty,true);
  e.redo(); assert.equal(s.dirty,false);
}
{
  const {editor:e,event}=fixture();
  e.insert('x',false); e.undo(); assert.equal(e.redoStack.length,1);
  event('compositionstart'); event('compositionupdate',{data:'x'}); event('compositionend',{data:''});
  assert.equal(e.redoStack.length,1); e.redo(); assert.equal(e.getText(),'axz');
}
{
  const {editor:e,event,input}=fixture();
  event('compositionstart'); event('compositionupdate',{data:'old'});
  e.setText('new document'); event('compositionend',{data:'old'});
  input.value='old'; event('input',{inputType:'insertCompositionText',isComposing:false});
  assert.equal(e.getText(),'new document'); assert.equal(e.undoStack.length,0);
}
{
  const {editor:e,event}=fixture('hello',1,4);
  event('compositionstart'); event('compositionend',{data:'ell'});
  assert.equal(e.getText(),'hello'); assert.equal(e.undoStack.length,0);
  event('compositionstart'); event('compositionupdate',{data:'\r\n'}); event('compositionend',{data:'\r\n'});
  assert.equal(e.getText(),'hell\no'); e.undo(); assert.equal(e.getText(),'hello');
}

// --- list continuation ----------------------------------------------------
// Enter carries the marker onto the next line, but only where the parser
// actually reads a list: a bullet inside a code fence stays literal.
{
  const enter = (text: string, at: number) => {
    const {editor:e,event} = fixture(text, at, at);
    event('keydown',{key:'Enter'});
    return [e.getText(), e.selEnd] as const;
  };
  assert.deepEqual(enter('- one', 5), ['- one\n- ', 8], 'a bullet continues');
  assert.deepEqual(enter('* one', 5), ['* one\n* ', 8], 'with the character the author chose');
  assert.deepEqual(enter('1. one', 6), ['1. one\n2. ', 10], 'a number continues by counting on');
  assert.deepEqual(enter('7) one', 6), ['7) one\n8) ', 10], 'keeping the delimiter');
  assert.deepEqual(enter('  - deep', 8), ['  - deep\n  - ', 13], 'nesting is kept');
  assert.deepEqual(enter('- [ ] task', 10), ['- [ ] task\n- [ ] ', 17], 'a task list gives another task');
  assert.deepEqual(enter('- [x] done', 10), ['- [x] done\n- [ ] ', 17], 'which is not already ticked');
  assert.deepEqual(enter('- one two', 6), ['- one \n- two', 9], 'splitting an item moves the rest into the new one');
  assert.deepEqual(enter('- one', 2), ['- \n- one', 5], 'and from the start of the content it leaves an empty item above');

  // An empty item is how an author leaves the list.
  assert.deepEqual(enter('- one\n- ', 8), ['- one\n', 6], 'an empty item withdraws its marker');
  assert.deepEqual(enter('- one\n  - ', 10), ['- one\n- ', 8], 'a nested one steps out a level first');
  assert.deepEqual(enter('- [ ] ', 6), ['', 0], 'an empty task item too');

  // Not a list, or not in one.
  assert.deepEqual(enter('```\n- one\n```', 9), ['```\n- one\n\n```', 10], 'a fenced bullet is literal text');
  assert.deepEqual(enter('- one', 1), ['-\n one', 2], 'Enter inside the marker just breaks the line');
  assert.deepEqual(enter('para', 4), ['para\n', 5], 'a paragraph is unaffected');
}
{
  // Shift+Enter still writes a hard break rather than a new item, and the
  // continuation is one undo step.
  const {editor:e,event} = fixture('- one', 5, 5);
  event('keydown',{key:'Enter',shiftKey:true});
  assert.equal(e.getText(), '- one\\\n', 'Shift+Enter breaks within the item');
  event('keydown',{key:'Enter'});
  assert.equal(e.getText(), '- one\\\n\n',
    'a line with no marker of its own is not continued, so the list ends there');
  e.undo(); assert.equal(e.getText(), '- one\\\n');
  e.undo(); assert.equal(e.getText(), '- one');
}
{
  // A selection is replaced by the new item, as any other insertion is.
  const {editor:e,event} = fixture('- one two', 6, 9);
  event('keydown',{key:'Enter'});
  assert.equal(e.getText(), '- one \n- ');
}
// --- delimiter pairing ----------------------------------------------------
{
  const typing = (text: string, start: number, end = start) => {
    const {editor:e,input,event} = fixture(text, start, end);
    return {
      editor: e,
      type: (ch: string) => { input.value = ch; event('input',{inputType:'insertText'}); },
      state: () => [e.getText(), e.selStart, e.selEnd] as const,
    };
  };

  let t = typing('abc', 3);
  t.type('('); assert.deepEqual(t.state(), ['abc()', 4, 4], 'a bracket opens a pair around the caret');
  t.type(')'); assert.deepEqual(t.state(), ['abc()', 5, 5], 'and its closer steps over the one already there');
  t.type(')'); assert.deepEqual(t.state(), ['abc())', 6, 6], 'a closer with nothing to step over is written');

  t = typing('abc', 0);
  t.type('('); assert.deepEqual(t.state(), ['(abc', 1, 1], 'nothing is opened against a word');
  t = typing('abc def', 3);
  t.type('['); assert.deepEqual(t.state(), ['abc[] def', 4, 4], 'but a space after the caret is room enough');

  t = typing('abc', 0, 3);
  t.type('*'); assert.deepEqual(t.state(), ['*abc*', 1, 4], 'a selection is wrapped and stays selected');
  t.type('_'); assert.deepEqual(t.state(), ['*_abc_*', 2, 5], 'so it can be wrapped again');
  t = typing('abc', 3, 0);
  t.type('('); assert.deepEqual(t.state(), ['(abc)', 1, 4], 'a backwards selection wraps the same way');
  t = typing('x', 0, 1);
  t.type('a'); assert.deepEqual(t.state(), ['a', 1, 1], 'an ordinary character still replaces the selection');

  t = typing('', 0);
  t.type('`'); assert.deepEqual(t.state(), ['``', 1, 1], 'a backtick pairs like a bracket');
  t.type('`'); assert.deepEqual(t.state(), ['``', 2, 2], 'stepping over its twin');
  t.type('`'); assert.deepEqual(t.state(), ['```', 3, 3], 'so a fence can still be typed');
  t = typing('code', 4);
  t.type('`'); assert.deepEqual(t.state(), ['code`', 5, 5], 'a symmetric delimiter does not open against a word');

  // Verbatim blocks take what is typed.
  t = typing('```\nx\n```', 5);
  t.type('('); assert.deepEqual(t.state(), ['```\nx(\n```', 6, 6], 'a code fence is literal');

  // Backspace undoes a pair in one keystroke, as it was made in one.
  const {editor:e,input,event} = fixture('', 0, 0);
  input.value = '('; event('input',{inputType:'insertText'});
  event('keydown',{key:'Backspace'});
  assert.equal(e.getText(), '', 'backspace between an empty pair takes both');
  input.value = '('; event('input',{inputType:'insertText'});
  input.value = 'x'; event('input',{inputType:'insertText'});
  event('keydown',{key:'Backspace'});
  assert.equal(e.getText(), '()', 'with something between them it takes only that');
  event('keydown',{key:'Backspace'});
  assert.equal(e.getText(), '', 'and the emptied pair goes together again');
}
{
  // Pasted and IME-committed text is never paired: one is not typing, and the
  // other has a transaction of its own to keep whole.
  const {editor:e,event} = fixture('', 0, 0);
  event('paste',{preventDefault(){}, clipboardData:{getData:()=>'('}});
  assert.equal(e.getText(), '(');
  event('compositionstart'); event('compositionend',{data:'（'});
  assert.equal(e.getText(), '(（');
}
// --- formatting commands --------------------------------------------------
{
  const fmt = (text: string, start: number, end = start) => {
    const {editor:e,event} = fixture(text, start, end);
    return {
      editor: e,
      key: (props: Record<string, unknown>) => event('keydown', {preventDefault(){}, ...props}),
      state: () => [e.getText(), e.selStart, e.selEnd] as const,
    };
  };

  let f = fmt('one two', 0, 3);
  f.key({key:'b', metaKey:true});
  assert.deepEqual(f.state(), ['**one** two', 2, 5], 'Cmd+B wraps the selection and keeps it selected');
  f.key({key:'b', metaKey:true});
  assert.deepEqual(f.state(), ['one two', 0, 3], 'and again takes it off');

  // With nothing selected the word under the caret is taken.
  f = fmt('one two', 5);
  f.key({key:'i', metaKey:true});
  assert.deepEqual(f.state(), ['one *two*', 5, 8], 'Cmd+I takes the word under the caret');
  f = fmt('one two', 3);
  f.key({key:'i', metaKey:true});
  assert.deepEqual(f.state(), ['*one* two', 1, 4], 'a caret just after a word takes that word');
  f = fmt('a  b', 2);
  f.key({key:'i', metaKey:true});
  assert.deepEqual(f.state(), ['a ** b', 3, 3], 'but on a space it gives an empty pair to type into');

  f = fmt('code', 0, 4);
  f.key({key:'`', metaKey:true, shiftKey:true});
  assert.deepEqual(f.state(), ['`code`', 1, 5], 'Cmd+Shift+` is inline code');
  f = fmt('gone', 0, 4);
  f.key({key:'5', code:'Digit5', altKey:true, shiftKey:true});
  assert.deepEqual(f.state(), ['~~gone~~', 2, 6], 'Alt+Shift+5 is strikethrough');

  // Clear format asks the parser what it would drop.
  f = fmt('a **b** and [c](/d)', 0, 19);
  f.key({key:'\\', metaKey:true});
  assert.deepEqual(f.state(), ['a b and c', 0, 9], 'Cmd+\\ strips inline markup');

  // Verbatim blocks take their delimiters literally, so formatting is refused.
  f = fmt('```\ncode\n```', 4, 8);
  f.key({key:'b', metaKey:true});
  assert.deepEqual(f.state(), ['```\ncode\n```', 4, 8], 'a code fence is left alone');
}
// --- indentation ----------------------------------------------------------
{
  const tab = (text: string, start: number, end = start, shiftKey = false) => {
    const {editor:e,event} = fixture(text, start, end);
    event('keydown', {key:'Tab', preventDefault(){}, shiftKey});
    return e.getText();
  };
  assert.equal(tab('- a\n- b', 7), '- a\n  - b', 'Tab nests a list item');
  assert.equal(tab('- a', 3), '- a  ', 'but on the first item it writes an indent');
  assert.equal(tab('plain', 5), 'plain  ', 'and in a paragraph it always does');
  assert.equal(tab('a\nb', 0, 3), '  a\n  b', 'a selected run of lines indents together');
  assert.equal(tab('  a\n  b', 0, 7, true), 'a\nb', 'and Shift+Tab brings it back');
  assert.equal(tab('- a\n  - b', 9, 9, true), '- a\n- b', 'Shift+Tab outdents an item');
}
// --- selection commands ---------------------------------------------------
{
  const sel = (text: string, at: number, props: Record<string, unknown>) => {
    const {editor:e,event} = fixture(text, at, at);
    event('keydown', {preventDefault(){}, ...props});
    return text.slice(Math.min(e.selStart,e.selEnd), Math.max(e.selStart,e.selEnd));
  };
  assert.equal(sel('one two three', 5, {key:'d', metaKey:true}), 'two', 'Cmd+D takes the word');
  assert.equal(sel('中文排版很好', 3, {key:'d', metaKey:true}), '排版', 'segmented, in Han');
  assert.equal(sel('a\nbb\nc', 4, {key:'l', metaKey:true}), 'bb', 'Cmd+L takes the line');
  assert.equal(sel('a **bold** b', 5, {key:'e', metaKey:true}), 'bold',
    'Cmd+E takes the styled run without its markers');
  assert.equal(sel('a **bold** b', 0, {key:'e', metaKey:true}), 'a',
    'and falls back to the word in plain text');
  assert.equal(sel('para one\n\npara two', 3, {key:'l', metaKey:true, shiftKey:true}), 'para one',
    'Cmd+Shift+L takes the block');
}
// --- deleting -------------------------------------------------------------
{
  const del = (text: string, start: number, props: Record<string, unknown>, end = start) => {
    const {editor:e,event} = fixture(text, start, end);
    event('keydown', {preventDefault(){}, ...props});
    return e.getText();
  };
  const word = {key:'d', ctrlKey:true, shiftKey:true};
  assert.equal(del('one two three', 5, word), 'one three', 'the word goes with the space after it');
  assert.equal(del('one two', 7, word), 'one ', 'at the end there is no space to take');
  assert.equal(del('中文排版', 3, word), '中文', 'a Han word is a word');
  assert.equal(del('one two', 0, word, 7), '', 'a selection is what gets deleted instead');

  const line = {key:'Backspace', ctrlKey:true, shiftKey:true};
  assert.equal(del('a\nb\nc', 2, line), 'a\nc', 'the line goes with its newline');
  assert.equal(del('a\nb', 3, line), 'a', 'at the end of the document the one before it goes');
  assert.equal(del('only', 2, line), '', 'a lone line leaves an empty document');
  assert.equal(del('a\nb\nc', 0, line, 3), 'c', 'a selection takes every line it touches');
  // A table row is a line, so the same command deletes it.
  assert.equal(del('| a |\n| - |\n| x |', 14, line), '| a |\n| - |', 'and a table row too');
}
// --- smart punctuation ----------------------------------------------------
{
  const typing = (text: string, start: number, end = start) => {
    const {editor:e,input,event} = fixture(text, start, end);
    return {
      editor: e,
      type: (s: string) => { for (const ch of s) { input.value = ch; event('input',{inputType:'insertText'}); } },
    };
  };
  let t = typing('', 0);
  t.type('He said "no" -- really...');
  assert.equal(t.editor.getText(), 'He said “no” – really…', 'quotes, dashes and dots as they are typed');

  // Blocks that take their text literally keep every character.
  t = typing('```\n', 4);
  t.type('a "b" -- c...');
  assert.equal(t.editor.getText(), '```\na "b" -- c...', 'a code fence is left alone');

  // One press of undo puts the typed character back.
  t = typing('', 0);
  t.type('a--');
  assert.equal(t.editor.getText(), 'a–');
  t.editor.undo();
  assert.equal(t.editor.getText(), '', 'the substitution undoes with the typing it belongs to');

  // Wrapping a selection in quotes uses the pair too.
  t = typing('word', 0, 4);
  t.type('"');
  assert.equal(t.editor.getText(), '“word”', 'a selection is wrapped in a real pair');

  // And the option turns it all off.
  t = typing('', 0);
  t.editor.setEditing({smartPunctuation:false});
  t.type('"a" -- b...');
  assert.equal(t.editor.getText(), '"a" -- b...', 'with the option off, nothing is substituted');
}

// --- line-wise copy and cut -----------------------------------------------
{
  const clip = (text: string, start: number, end: number, type: 'copy' | 'cut') => {
    const {editor:e,event} = fixture(text, start, end);
    let written = '';
    event(type, {preventDefault(){}, clipboardData:{setData:(_: string, v: string) => { written = v; }}});
    return [written, e.getText()] as const;
  };
  assert.deepEqual(clip('a\nb\nc', 2, 2, 'copy'), ['b\n', 'a\nb\nc'],
    'with nothing selected, copy takes the whole line');
  assert.deepEqual(clip('a\nb\nc', 2, 2, 'cut'), ['b\n', 'a\nc'], 'and cut removes it');
  assert.deepEqual(clip('a\nb', 2, 2, 'cut'), ['b', 'a\n'], 'the last line has no newline to take');
  assert.deepEqual(clip('a\nb\nc', 0, 1, 'copy'), ['a', 'a\nb\nc'], 'a real selection is untouched by all this');
}
// --- making room ----------------------------------------------------------
{
  const room = (text: string, at: number, shiftKey = false) => {
    const {editor:e,event} = fixture(text, at, at);
    event('keydown', {key:'Enter', metaKey:true, preventDefault(){}, shiftKey});
    return [e.getText(), e.selEnd] as const;
  };
  assert.deepEqual(room('para', 2), ['para\n\n', 6], 'a paragraph after the block');
  assert.deepEqual(room('para', 2, true), ['\n\npara', 0], 'and before it');
  // The escape hatch: a document that opens with a table has nowhere to put
  // a paragraph in front of it.
  assert.deepEqual(room('| a |\n| - |', 2, true), ['\n\n| a |\n| - |', 0], 'even when the block is a table');
  // In a table, one more of these means one more row.
  assert.deepEqual(room('| a | b |\n| - | - |\n| 1 | 2 |', 22),
    ['| a | b |\n| - | - |\n| 1 | 2 |\n|  |  |', 32], 'a row is added with the caret in its first cell');
}
console.log('all editor transaction tests passing');
