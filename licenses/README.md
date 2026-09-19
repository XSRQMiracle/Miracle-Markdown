# 随包分发的第三方许可证

这个目录里的许可证文本会打进 macOS 的 `.app` 与 DMG，位置是
`Miracle Markdown.app/Contents/Resources/licenses/`。

放在这里的判断标准只有一条：**这份软件的代码是否真的进入了我们分发的产物**。
仅在构建或测试时用到、不随包出去的依赖不在此列——附上它们的许可证既无必要，
也会让真正需要遵守的那几份淹没在噪音里。

| 组件 | 版本 | 许可证 | 为什么在这里 |
|---|---|---|---|
| [MathJax](https://github.com/mathjax/MathJax-src) | 3.2.1 | Apache-2.0 | 公式排版引擎，`mathjax-full` 被 Vite 打进前端产物，随 App 一起分发。 |

Apache-2.0 第 4 条要求随分发附上许可证副本，并保留原始的版权、专利与归属声明；
[MathJax-Apache-2.0.txt](MathJax-Apache-2.0.txt) 是从 `node_modules/mathjax-full/LICENSE`
原样复制的，未作任何改动。

## 与本项目自身许可证的关系

Miracle Markdown 以 GPL-3.0-or-later 分发，见仓库根目录的 [LICENSE](../LICENSE)。
两者的方向是相容的：Apache-2.0 的代码可以并入 GPLv3 作品，反之不行。所以聚合后的
产物整体按 GPLv3 分发，而 MathJax 那一部分仍然保留它自己的 Apache-2.0 条款——这正是
上面那份副本存在的原因。

## 新增依赖时

如果新依赖的代码会进入分发产物，就把它的许可证原文加到这个目录并在上表补一行。
然后重新构建，并**从实际的 `.app` 里确认文本真的在**，而不是只检查 `node_modules`：

```bash
ls "target/release/bundle/macos/Miracle Markdown.app/Contents/Resources/licenses/"
```
