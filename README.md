# LaTeX2Docx 当前实现状态

本文档记录截至当前开发进度，系统已经实现了什么、距离原始产品计划还差什么，以及已实现功能中仍然存在的缺陷。

## 项目目标

LaTeX2Docx 的目标是做一个 macOS 优先的 Electron 桌面应用，用于将受控 LaTeX 论文转换成符合指定 Word 模板要求的 `.docx`。

这个项目不是通用 LaTeX/Word 转换器，而是面向中文高校论文模板的本地优先、规则驱动、schema 驱动转换系统。

核心设计原则仍然是：

- `schema.json` 是唯一真值。
- 用户上传的 Word 模板只作为分析输入。
- `source-template.docx` / `source-template.doc` 不等于运行时模板。
- `render-reference.docx` 必须由 `schema.json` 生成或同步，用于 Pandoc 转换。
- AI 只能辅助 schema、解释问题、生成固定 LaTeX 模板，不能直接作为最终排版引擎。

## 当前完成度概览

当前系统已经具备 Phase 0 到 Phase 3 的一部分闭环能力：

1. Electron + React + TypeScript 桌面应用骨架已经存在。
2. 开发环境数据目录已放在项目内：
   `.latex2docx-data/dev`
3. SQLite 元数据层已经初始化，用于保存模板、schema、job 等元数据。
4. 支持导入 `.doc` / `.docx` 模板。
5. `.doc` 会通过 macOS `textutil` 转成临时 `.docx`，并带硬超时和进程终止。
6. Phase 2 已实现三层模板分析的主要骨架：
   - Raw Extraction
   - Semantic Mapping
   - Schema Generation
7. 已能生成：
   - `schema.json`
   - `extraction-debug.json`
   - `role-candidates.json`
   - `render-reference.docx`
   - `render-reference-manifest.json`
8. Phase 3 已有基础能力：
   - 生成固定 LaTeX 模板 `fixed-template.tex`
   - 调用 Pandoc 转换 LaTeX 到 `.docx`
   - 使用 schema 生成的 `render-reference.docx`
   - 对 Pandoc 输出做有限 OOXML 后处理
9. 已针对中文本科论文模板增强了：
   - 中文封面字段识别
   - 中文摘要/关键词识别
   - 英文 Abstract / Key Words 识别和输出
   - 目录标题识别和 Pandoc TOC 输出
   - 一级/二级标题识别
   - 正文样式识别
   - 图题/表题识别
   - 参考文献/致谢/附录识别
10. 已加入模板导入阶段化日志：
    `.latex2docx-data/dev/logs/template-import.log`

## 已实现但仍有缺陷的功能

### 1. 模板导入和 schema 生成

当前模板导入已经能跑通，但仍然不是高保真模板恢复。

已知缺陷：

- 当前主要依赖 OOXML 的 `document.xml` 直接格式。
- 对 `.doc` 文件依赖 macOS `textutil` 转换。
- `textutil` 转出来的 `.docx` 经常缺少：
  - `styles.xml`
  - `numbering.xml`
  - `header*.xml`
  - `footer*.xml`
- 因此很多样式信息只能靠段落直接格式、文本模式和中文论文规则推断。
- schema 中的字体、行距、标题规则仍有启发式成分。
- 如果源模板自身是 `.docx` 且包含完整 OOXML，保真度理论上会更好，但尚未系统验证。

### 2. 中文模板语义识别

当前已经偏向中文论文模板，而不是英文论文模板。

已知缺陷：

- 目前只针对一个本科毕业论文模板做过实际调试。
- 规则还没有经过多校、多格式、多版本模板验证。
- “题目”“姓名”“学号”“学院”“专业”“指导教师”等字段已能识别，但还没有真正生成完整封面页。
- TOC field / HYPERLINK 段落已能排除出正文和标题，但目录内容仍依赖 Word/Pandoc 字段刷新。
- 参考文献、致谢、附录能识别标题，但正文内容结构化还比较浅。

### 3. render-reference.docx

`render-reference.docx` 已经不是直接复制原模板，而是由 schema 生成。

已知缺陷：

- 目前主要生成 Pandoc 可识别的 paragraph styles。
- 已补中文字体：
  - 正文/摘要/关键词/参考文献条目：宋体 + Times New Roman
  - 一级标题/摘要标题/参考文献标题：黑体 + Times New Roman
- 已补基础行距和缩进：
  - 正文 1.5 倍行距
  - 正文首行缩进
  - 参考文献悬挂缩进
- 但还没有完整覆盖：
  - 封面复杂排版
  - 承诺书
  - 页眉页脚内容
  - 页码格式
  - 分节分页规则
  - 表格线型/宽度/单元格内边距
  - 图片尺寸和位置
  - 多级编号完整规则

### 4. LaTeX 固定模板

当前可以生成固定 LaTeX 模板。

已知缺陷：

- fixed template 仍是 deterministic 简化模板，不是 AI 根据 schema 高质量生成的最终版本。
- 已包含：
  - `\title{}`
  - `\author{}`
  - 中文摘要
  - 中文关键词
  - 英文 Abstract
  - English Key Words
  - `\section{}`
  - `\subsection{}`
  - figure/table/caption
  - `thebibliography`
- 尚未实现严格 LaTeX 子集检查。
- 用户如果使用旧的 `.tex`，例如没有英文 Abstract 块，转换结果也不会自动凭空生成英文摘要。

### 5. Pandoc 转换和后处理

当前已经可以通过 Pandoc 生成 `.docx`。

已知缺陷：

- Pandoc 是主转换器，但 Pandoc 对中文论文模板的高保真支持有限。
- 当前 OOXML 后处理只做了有限修正：
  - Abstract 标题映射
  - 中文摘要标题映射
  - 英文摘要样式映射
  - 关键词样式映射
  - 参考文献标题和条目样式映射
  - 一级标题编号文本修正
  - TOC 位置移动到英文关键词之后
- 还没有完整后处理：
  - 页眉页脚
  - 页码
  - 分节
  - 封面表格/下划线字段
  - 图表自动编号
  - 交叉引用
  - 文献引用格式检查

### 6. UI

当前 UI 可以展示基础运行时信息、模板导入、schema 预览、工具检测和转换入口。

已知缺陷：

- UI 仍是开发态工作台，不是最终产品交互。
- schema preview 能看主要中文 roles，但还不支持人工修正 schema。
- 没有 Word 页面预览。
- 没有格式检查报告 UI 的完整闭环。
- 没有针对失败原因的分层修复建议。

## 原计划中尚未实现或未完成的功能

### Phase 1 相关

已基本完成：

- Electron app shell
- React + TypeScript
- 本地数据目录初始化
- Pandoc 检测
- SQLite 元数据初始化
- 基础 job runner

仍不完善：

- 设置页仍较基础。
- 工具链安装提示不够完整。
- 打包态路径兼容性还没有验证。

### Phase 2 相关

已完成主要骨架：

- 模板导入
- `.doc` 转 `.docx`
- raw extraction
- semantic mapping
- schema generation
- debug JSON 输出
- import log
- render-reference.docx 生成

仍不完善：

- 没有多模板泛化验证。
- 对 `.doc` 的保真度受 `textutil` 限制。
- header/footer、numbering、styles 缺失时只能启发式补全。
- schema 还没有人工校正 UI。
- schema 还没有稳定版本迁移策略。

### Phase 3 相关

部分完成：

- fixed LaTeX template 生成
- Pandoc 转换
- reference docx 使用
- 基础 OOXML 后处理
- `thebibliography` 路径可用

未完成或不完善：

- AI 生成 fixed LaTeX 模板尚未真正接入。
- LaTeX 支持子集校验器尚未实现。
- unsupported feature 检测尚未实现。
- 转换失败诊断还不完整。
- 转换结果高保真程度仍不足。

### Phase 4 相关

基本未完成：

- 基于 `schema.json` 的格式 checker 尚未完整实现。
- issue report UI 尚未完整实现。
- 格式问题报告还没有稳定 JSON schema。
- AI 解释格式问题和修复建议尚未接入。

### Phase 5 相关

未完成：

- macOS packaging preparation
- 打包态 Pandoc 检测/路径策略
- 应用签名、公证、权限处理
- 崩溃日志和用户级错误恢复

### Phase 6 相关

仅规划，未实现：

- BibTeX / CSL / citeproc
- 内置 Pandoc
- 更完整的 Python 后处理
- 多模板管理
- 云同步
- PDF 模板识别

## 当前只验证过一个模板

当前所有模板识别和转换修正，主要围绕这个样例完成：

`examples/（1）本科毕业设计（论文）文本模板.doc`

这意味着：

- 当前规则不能证明对其他学校模板泛化有效。
- 尚未测试硕士/博士模板。
- 尚未测试原生 `.docx` 模板。
- 尚未测试包含完整 `styles.xml`、`numbering.xml`、页眉页脚的模板。
- 尚未测试复杂封面、多分节、罗马页码、奇偶页页眉等情况。

因此当前系统状态应被视为：

> 单模板中文本科论文转换闭环原型，而不是稳定泛化产品。

## 当前数据目录

开发态数据目录固定在：

`.latex2docx-data/dev`

主要内容包括：

- `settings.json`
- `metadata.sqlite`
- `templates/*`
- `jobs/*`
- `cache/*`
- `logs/*`

## 常用命令

```bash
pnpm dev
pnpm typecheck
pnpm --filter @latex2docx/desktop build
```

当前开发约束：

- 不要把 `.docx`、`.tex`、图片等大文件直接塞进 SQLite。
- SQLite 只保存元数据、路径、hash、状态、时间戳和版本信息。
- 大文件和中间产物放在 `.latex2docx-data/dev` 下。

## 下一步建议

最高优先级：

1. 增加 5 到 10 个真实中文高校模板做泛化测试。
2. 优先测试原生 `.docx` 模板，而不是只测 `.doc`。
3. 做 schema 人工校正 UI。
4. 实现 LaTeX 子集检查器。
5. 实现基于 schema 的格式 checker 和 issue report。
6. 专门实现封面/承诺书/页眉页脚/页码的后处理模块。

在这些完成前，不应把当前系统视为“能一比一复刻任意 Word 模板”的工具。
