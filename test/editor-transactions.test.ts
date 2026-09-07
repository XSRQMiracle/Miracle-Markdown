import assert from 'node:assert/strict';
import { Editor } from '../src/editor/editor.js';
import { DocumentSession } from '../src/markdown/session.js';

(globalThis as any).window = Object.assign(new EventTarget(), { setInterval: () => 0 });
(globalThis as any).ResizeObserver = class { observe() {} };
function fixture(text='aOLDz', start=4, end=1) {
  const input = Object.assign(new EventTarget(), {value:'', blur() { this.dispatchEvent(new Event('blur')); }});
  const editor = Object.create(Editor.prototype) as any;
  const session = new DocumentSession({path:'A.md',contents:text,lineEnding:'\n'}, {
    open:async()=>null, save:async(path)=>({path}), confirmLeave:async()=>'cancel', loaded:()=>{}, changed:()=>{},
  });
  Object.assign(editor, {text,selStart:start,selEnd:end,caretAffinity:'upstream',composing:null,
    undoStack:[],redoStack:[],lastEditAt:-Infinity,input,canvas:new EventTarget(),host:{},
    invalidate:()=>{},scrollCaretIntoView:()=>{}, onChange:()=>session.updateText(editor.getText())});
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
console.log('all editor composition transaction tests passing');
