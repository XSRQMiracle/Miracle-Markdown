import assert from 'node:assert/strict';
import { Editor } from '../src/editor/editor.js';
import { DocumentSession } from '../src/markdown/session.js';
import { parseBlocks } from '../src/markdown/parse.js';

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
console.log('all editor transaction tests passing');
