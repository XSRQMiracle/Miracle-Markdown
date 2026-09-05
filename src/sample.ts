/** The document the editor opens with. Chosen to exercise every rule the
 *  engine implements: mixed scripts, squeezable punctuation, forbidden
 *  breakpoints, long unhyphenatable words, and nested structure. */
export const SAMPLE = `# 像 TeX 一样排版 Markdown

浏览器的断行是**贪心**的：它逐行填字，填不下就换行，从不回头。这种做法快，但每一行都只考虑自己，于是整段文字的右边缘会起伏不定，词距忽松忽紧。TeX 的做法完全不同——它把整段看成一个整体，为每个合法断点计算代价，再用动态规划找出总代价最小的一组断点。

一行「稍微松一点」是可以接受的，只要它能让后面两行都恰到好处。这就是 Knuth-Plass 算法的全部要义。

## 三种原语

TeX 把一段文字拆成三样东西，其余一切都由它们组合而成：

- **盒子（box）**：不可伸缩的实体，一个西文单词或一个汉字。
- **胶水（glue）**：可伸缩的空白，写作「宽度 plus 伸 minus 缩」。
- **惩罚（penalty）**：一个「可以在此断行，但要付出代价」的位置。

> 中文排版里那些看似需要特殊处理的规则，在这个模型下根本不是特例。避头尾就是在禁止的位置放一个无穷大的惩罚；中西文间距就是一段四分之一字宽的胶水；标点挤压就是让全角标点在自己空着的那半边具备收缩能力。

## 代价函数

设一行的调整比为 $r$，则劣度 $\\beta = 100\\,|r|^3$，而这一行的代价是：

$$
d = \\begin{cases}
(l + \\beta + \\pi)^2 & \\pi \\geq 0 \\\\
(l + \\beta)^2 - \\pi^2 & \\pi < 0
\\end{cases}
$$

其中 $l$ 是行惩罚，$\\pi$ 是断点自身的惩罚值。TeX 的默认 $l = 10$。真正让搜索跑得快的
是剪枝：任何调整比 $r < -1$ 的行都不可能再撑到后面的断点，直接从活动集里删掉。

行内公式如 $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ 会让所在行自动变高，
而不是压到上一行——这正是 TeX 的行间胶水在做的事。

更进一步：行内公式还能**跨行断开**。TeX 允许在顶层的二元运算符后与关系符后断行，
分别付出 $\\beta_{\\text{bin}} = 700$ 与 $\\beta_{\\text{rel}} = 500$ 的代价。
所以像 $a_1 + a_2 + a_3 + a_4 + a_5 + a_6 = b_1 + b_2 + b_3 + b_4$ 这样的长公式
不会被整个挪到下一行留下空洞，而是在合适的运算符后断开。分数与成对定界符内部永远不断：
$\\frac{a+b}{c+d}$ 与 $f(x_1, x_2)$ 都是不可分的整体。

\`\`\`text
d = (l + β + π)²      π ≥ 0
d = (l + β)² − π²     π < 0
\`\`\`

连续两行以连字符结尾会额外受罚，相邻两行的松紧等级相差过大也会。真正让搜索跑得快的是剪枝：任何调整比小于 −1 的行都不可能再撑到后面的断点，直接从活动集里删掉。

## 中西文混排

The quick brown fox jumps over the lazy dog. 这句英文和前面的中文之间，引擎会自动插入四分之一个字宽的间距，并且在需要压缩时把它收窄到八分之一。如果这个位置恰好被选为断点，那段间距会自然消失——因为它是胶水，而胶水在断行处本来就要被丢弃。

标点也一样。像「这样」的引号、（这样）的括号，以及句末的句号。它们各自占满一个字身，但字形只占一半，另外半个字身在需要时可以让出来。行尾的标点还会悬挂到版心之外，这样右边缘看起来才是笔直的。

## 试试看

把窗口拉宽或拉窄，整篇文档会实时重排。打开上方的「劣度视图」，每一行会按照它的拉伸量显色：暖色表示这一行偏松，冷色表示偏紧。关掉「两端对齐」再打开，可以看到同一段文字在两种模式下的断点选择差异。

Extraordinary internationalisation transformations accompanied the organisation's administrative reorganisation programme, which is exactly the sort of sentence that forces a line breaker to choose between hyphenating and leaving a gaping hole in the middle of a line.

---

点击任意位置即可编辑；光标所在的段落会显示它的 Markdown 源码，其余段落保持排版后的样子。
`;
