import assert from 'node:assert/strict';
import { DocumentSession, type SessionPorts, type LeaveDecision } from '../src/markdown/session.js';
import { Editor } from '../src/editor/editor.js';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const initial = { path: 'A.md', contents: 'disk', lineEnding: '\r\n' as const };
const opened = { path: 'B.md', contents: 'other', lineEnding: '\n' as const };
function setup(overrides: Partial<SessionPorts> = {}) {
  const decisions: LeaveDecision[] = [];
  const loaded: string[] = [];
  const writes: unknown[] = [];
  const ports: SessionPorts = {
    open: async () => async () => opened,
    save: async (path, contents, eol) => { writes.push([path, contents, eol]); return { path: path ?? 'new.md' }; },
    confirmLeave: async () => { assert.ok(decisions.length, 'unexpected unsaved prompt'); return decisions.shift()!; },
    loaded: doc => loaded.push(doc.contents), changed: () => {}, ...overrides,
  };
  return { s: new DocumentSession(initial, ports), ports, decisions, loaded, writes };
}
{
  const gate = deferred<{path: string}>();
  const {s} = setup({save: () => gate.promise});
  s.updateText('snapshot'); const save = s.save(); await tick();
  s.updateText('newer'); gate.resolve({path: 'A.md'}); await save;
  assert.equal(s.dirty, true); s.updateText('snapshot'); assert.equal(s.dirty, false);
  s.updateText('disk'); assert.equal(s.dirty, true);
}
{
  const gate = deferred<{path: string}>();
  const {s, ports, writes} = setup();
  const savePort = ports.save;
  ports.save = async (...args) => { writes.push(args); return gate.promise; };
  s.updateText('one'); const first = s.save(true); await tick();
  ports.save = savePort; s.updateText('two'); const second = s.save(); await tick();
  assert.equal(writes.length, 1); gate.resolve({path:'chosen.md'});
  await Promise.all([first, second]);
  assert.deepEqual(writes, [[null,'one','\r\n'],['chosen.md','two','\r\n']]);
  assert.equal(s.path, 'chosen.md'); assert.equal(s.dirty, false);
}
{
  const {s, ports} = setup({save: async () => null}); s.updateText('edit');
  assert.equal(await s.save(true), false); assert.equal(s.dirty, true); assert.equal(s.path,'A.md');
  ports.save = async () => { throw Error('disk full'); };
  await assert.rejects(s.save(), /disk full/); assert.equal(s.saving, false); assert.equal(s.dirty,true);
  ports.save = async () => ({path:'A.md'}); assert.equal(await s.save(),true); assert.equal(s.dirty,false);
}
{
  const gate = deferred<{path: string}>();
  const {s, decisions, loaded} = setup({save: () => gate.promise});
  s.updateText('older'); const save = s.save(); await tick(); s.updateText('newer');
  decisions.push('cancel'); const open = s.open(); await tick(); assert.deepEqual(loaded,[]);
  gate.resolve({path:'A.md'}); await save; assert.equal(await open,false);
  assert.equal(s.path,'A.md'); assert.equal(s.text,'newer');
  decisions.push('discard'); assert.equal(await s.open(),true); assert.equal(s.path,'B.md'); assert.equal(s.dirty,false);
}
{
  const gate = deferred<{path:string}>(); let finished = false;
  const {s, decisions, ports} = setup({save: () => gate.promise});
  s.updateText('edit'); decisions.push('save','cancel');
  const close = s.close(async () => { finished = true; }); await tick();
  assert.equal(s.saving,true); s.updateText('typed while saving'); gate.resolve({path:'A.md'});
  assert.equal(await close,false); assert.equal(finished,false); assert.equal(s.dirty,true);
  ports.save = async () => ({path:'A.md'}); decisions.push('save');
  assert.equal(await s.close(async () => { finished = true; }),true);
  assert.equal(finished,true); assert.equal(s.isClosing,true); assert.equal(await s.save(),false);
}
{
  const gate = deferred<{path:string}>();
  const {s, decisions} = setup({save: () => gate.promise});
  s.updateText('pending'); const save=s.save(); await tick(); s.updateText('disk');
  assert.equal(s.dirty,false); assert.equal(s.needsUnloadProtection,true);
  decisions.push('cancel'); const close=s.close(async () => { assert.fail('must not close'); });
  gate.resolve({path:'A.md'}); await save; assert.equal(await close,false); assert.equal(s.dirty,true);
}
{
  let disk='disk'; let reads=0;
  const {s, decisions}=setup({
    open: async () => async () => { reads++; return {...initial,contents:disk}; },
    save: async (_path,text) => { disk=text; return {path:'A.md'}; },
  });
  s.updateText('saved before read'); decisions.push('save'); await s.open();
  assert.equal(s.text,'saved before read'); assert.equal(reads,1);
}
{
  const gate=deferred<typeof opened>(); let reads=0;
  const {s,decisions}=setup({open:async()=>async()=>++reads===1 ? gate.promise : opened});
  const open=s.open(); await tick(); s.updateText('during read'); decisions.push('cancel');
  gate.resolve(opened); assert.equal(await open,false); assert.equal(s.text,'during read');
}
{
  const {s}=setup();
  // Exercise the editor's real mutation methods without a DOM/typesetter.
  const editor=Object.create(Editor.prototype) as any;
  Object.assign(editor,{text:'disk',selStart:4,selEnd:4,undoStack:[],redoStack:[],lastEditAt:0,
    invalidate:()=>{},scrollCaretIntoView:()=>{},onChange:()=>s.updateText(editor.getText())});
  editor.insert('!',false); assert.equal(s.text,'disk!'); await s.save();
  editor.undo(); assert.equal(s.text,'disk'); assert.equal(s.dirty,true);
  editor.redo(); assert.equal(s.text,'disk!'); assert.equal(s.dirty,false);
}
console.log('all session race, lifecycle, and editor notification tests passing');
