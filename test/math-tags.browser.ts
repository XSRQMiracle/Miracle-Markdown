// Open /test/math-tags.html under Vite. This exercises the real browser
// MathJax runtime, SVG DOM/Path2D, numbering pass, WASM and canvas together.
import { DEFAULT_MATH_OPTIONS, initMath, renderMath, renderDisplayMath } from '../src/engine/mathjax.js';
import { DEFAULT_OPTIONS, DEFAULT_THEME, initEngine, numberEquations, Typesetter, resolveLatex } from '../src/engine/typeset.js';
import { parseBlocks } from '../src/markdown/parse.js';
import { Renderer } from '../src/render/canvas.js';
const results = document.querySelector('#results')!;
const lines: string[] = [];
let failures = 0;
function assert(value: unknown, message: string) { if (!value) throw Error(message); }
function eq(actual: unknown, expected: unknown) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function test(name: string, action: () => void) {
  try { action(); lines.push(`PASS ${name}`); }
  catch (error) { failures++; lines.push(`FAIL ${name}: ${error}`); }
  results.textContent = lines.join('\n');
}
try {
  await initEngine();
  await initMath({...DEFAULT_MATH_OPTIONS});
  test('explicit tags have one owner and noncollapsed full-width geometry', () => {
    const geometry = renderDisplayMath(String.raw`x \tag{A.1}`, '1', 80);
    eq(geometry.error, null); eq(geometry.equation?.tags, ['A.1']); eq(geometry.hasTags, true); eq(geometry.widthEx, 80);
    assert(geometry.commands!.length >= 4, 'body and tag must both contain ink');
    assert(geometry.commands!.every(({transform:[a,b,c,d]}) => Math.abs(a*d-b*c)>1e-10), 'no collapsed SVG viewport');
    const wider = renderDisplayMath(String.raw`x \tag{A.1}`, '1', 100);
    eq(wider.widthEx, 100); assert(wider !== geometry, 'container width participates in geometry identity');
  });
  test('automatic tags also use native SVG layout', () => {
    const geometry = renderDisplayMath('x', '9', 80);
    eq(geometry.error, null); eq(geometry.equation?.tags, ['9']); eq(geometry.hasTags, true);
    eq(renderDisplayMath('x', null, 80).hasTags, false);
  });
  test('starred and nested tags remain intact', () => {
    const starred = renderDisplayMath(String.raw`x\tag*{A}`, '1', 80);
    const normal = renderDisplayMath(String.raw`x\tag{A}`, '1', 80);
    eq(starred.error, null); eq(starred.equation?.tags, ['A']);
    assert(starred.commands!.length < normal.commands!.length, 'tag* must not gain parentheses');
    const nested = renderDisplayMath(String.raw`x\tag{A{.1}}`, '1', 80);
    eq(nested.error, null); eq(nested.equation?.tags, ['A{.1}']);
  });
  test('macro-expanded and multi-row tags are parsed, not guessed from source', () => {
    const macro = renderDisplayMath(String.raw`\newcommand{\numberme}{\tag{M}}x\numberme`, '1', 80);
    eq(macro.error, null); eq(macro.equation?.tags, ['M']);
    const source = String.raw`\begin{align}x&=1\tag{A}\label{a}\\y&=2\tag{B}\label{b}\end{align}`;
    const geometry = renderDisplayMath(source, '1', 80);
    eq(geometry.error, null); eq(geometry.equation?.tags, ['A','B']);
    const numbering = numberEquations(parseBlocks('$$\n'+source+'\n$$'), 'all');
    eq([...numbering.labels], [['a','A'],['b','B']]);
  });
  test('comments, unused macro definitions and escaped commands cannot steal numbering', () => {
    const source = String.raw`\newcommand{\unused}{\tag{wrong}}x % \tag{comment}`;
    const geometry = renderDisplayMath(source, '3', 80);
    eq(geometry.error, null); eq(geometry.equation?.tags, ['3']);
    eq(numberEquations(parseBlocks('$$\nx % \\label{ignored}\n$$'), 'none').labels.size, 0);
  });
  test('native parse preserves automatic labels and suppression rules', () => {
    const doc = '$$ x \\label{a} $$\n\n$$ y $$\n\n$$ z \\label{b} $$';
    eq([...numberEquations(parseBlocks(doc), 'none').labels], [['a','1'],['b','2']]);
    eq([...numberEquations(parseBlocks(doc), 'all').labels], [['a','1'],['b','3']]);
    eq(numberEquations(parseBlocks('$$x\\notag$$'), 'all').tags.size, 0);
    eq(numberEquations(parseBlocks(String.raw`$$\begin{align*}x&=1\end{align*}$$`), 'ams').tags.size, 0);
    eq(numberEquations(parseBlocks(String.raw`$$\begin{equation}x=1\end{equation}$$`), 'ams').tags.get(0), '1');
  });
  test('source metadata rewriting preserves TeX structure', () => {
    eq(resolveLatex(String.raw`x\tag{A{.1}}\label{a}`, new Map()), String.raw`x\tag{A{.1}}`);
    eq(resolveLatex('% \\label{a}\nx\\label{real}',new Map()), '% \\label{a}\nx');
    eq(resolveLatex(String.raw`\text{\label{literal}}+\eqref{a}`,new Map([['a','7']])),String.raw`\text{\label{literal}}+(7)`);
  });
  test('document references inside macro bodies and tag text still resolve', () => {
    const resolved = resolveLatex(String.raw`\newcommand{\cite}{\eqref{a}}\cite`,new Map([['a','7']]));
    eq(resolved, String.raw`\newcommand{\cite}{(7)}\cite`);
    eq(renderMath(resolved, false).error, null);
    eq(resolveLatex(String.raw`x\tag{see \ref{a}}`,new Map([['a','7']])),String.raw`x\tag{see 7}`);
    const aligned = renderDisplayMath(String.raw`\begin{align}a&=b\\c&=d\end{align}`, '4', 80);
    eq(aligned.error,null); eq(aligned.equation?.tags,['4']);
  });
  test('typesetter emits no second label and keeps source offsets', () => {
    const typesetter = new Typesetter({...DEFAULT_THEME},{...DEFAULT_OPTIONS,inline:{...DEFAULT_OPTIONS.inline},numbering:'all'});
    const source = '$$\nx\\tag{A.1}\\label{x}\n$$\n\nReference $\\eqref{x}$.\n\n$$\ny\n$$';
    const layout = typesetter.layoutDocument(source, 640, -1);
    const blocks = layout.blocks.filter(b => b.block.type === 'math');
    eq(blocks.map(b=>b.lines[0].runs.length), [1,1]);
    eq(blocks[0].lines[0].runs[0].math?.geometry.equation?.tags, ['A.1']);
    eq(blocks[1].lines[0].runs[0].math?.geometry.equation?.tags, ['2']);
    const renderer = new Renderer(document.querySelector('#preview') as HTMLCanvasElement);
    renderer.resize(720,Math.ceil(layout.height+60));
    renderer.draw(layout.blocks,{width:720,height:layout.height+60,scrollTop:0,originX:40,originY:30},DEFAULT_THEME,[],null,false,false);
  });
  await initMath({...DEFAULT_MATH_OPTIONS, physics:true});
  test('package reconfiguration retains the live engine and native tags', () => {
    const geometry=renderDisplayMath(String.raw`\dv{x}{t}\tag{P}`, null,80);
    eq(geometry.error,null); eq(geometry.equation?.tags,['P']);
  });
  await initMath({...DEFAULT_MATH_OPTIONS});
} catch (error) { failures++; lines.push(`FAIL initialization: ${error}`); }
results.textContent = `${failures ? 'FAILED' : 'PASS'}: ${failures} failures\n`+lines.join('\n');
document.title = `${failures ? 'FAIL' : 'PASS'} Math tag regression tests`;
