# 划词解释 · Word Explainer

在网页和 PDF 中划词查阅解释，用区域 OCR 读取图片里的英文，并把生词连同上下文整理下来。

面向桌面 Chromium 浏览器的 Manifest V3 扩展。无需构建即可加载；解释与翻译使用用户自己的 DeepSeek API Key。

## 下载与安装

**[⬇ 下载最新版插件 ZIP](https://github.com/HyePriest/word-explainer-extension/releases/latest/download/word-explainer.zip)** · [查看版本与更新说明](https://github.com/HyePriest/word-explainer-extension/releases)

适用于电脑上的 Chrome、Edge 浏览器。下载后即可安装，不需要编译。

1. 点击上面的下载链接，**解压 ZIP**。
2. Chrome 地址栏输入 `chrome://extensions`；Edge 输入 `edge://extensions`。
3. 开启右上角的**开发者模式**，点击**加载已解压的扩展程序**。
4. 选择解压后的 **`word-explainer` 文件夹**，里面应当直接有 `manifest.json`。
5. 打开浏览器工具栏里的插件，在**设置与其他工具**中填写并保存自己的 **DeepSeek API Key**。

也可以点击仓库的 `Code → Download ZIP` 下载源码，解压后选择里面直接包含 `manifest.json` 的文件夹安装。

## 怎么用

- **网页查词**：在插件里开启“划词解释”，刷新网页，然后选中文字，点击解释按钮。
- **粘贴翻译**：按 `Ctrl+Shift+X` 打开插件，粘贴文字就会翻译。手动输入后，点击“翻译”或按 `Ctrl+Enter`。
- **读 PDF**：在插件里打开 PDF 阅读器，再选择或拖入 PDF 文件。
- **识别图片英文**：点击“区域 OCR”，框选要识别的区域。
- **整理生词**：保存单词后，在“生词本”查看、复制或导出。

解释与翻译需要你自己的 API Key，会产生相应的服务费用；图片 OCR 在本机运行，目前支持英文。

**快捷键没反应？** 在 `chrome://extensions/shortcuts`（Edge 使用 `edge://extensions/shortcuts`）中，将本插件的“激活扩展程序”设为 `Ctrl+Shift+X`，也可以直接点击工具栏里的插件图标。

**更新插件**：先导出生词备份，将新版解压后覆盖原插件文件夹，再到扩展管理页点击插件的“重新加载”，并刷新网页。保留原安装目录，不要先删除插件。

需要 Windows 的 PDF 右键打开功能，可另外按 [Windows PDF 使用说明](windows-launcher/README-Windows-PDF.md) 安装启动器。

## 数据与隐私

设置、API Key 和生词本保存在当前浏览器个人资料的本地扩展存储中。主动请求解释的文字会发送到 DeepSeek；区域 OCR 的图像识别在本机完成。完整数据流及权限用途见 [隐私说明](PRIVACY.md)。

生词本通过 JSON 文件手动备份、迁移，不自动跨设备同步。更换浏览器、删除扩展或清理个人资料前，请先导出备份。

## 已知限制

- 浏览器内置页面、扩展商店及部分受保护页面不允许注入划词或 OCR 功能。
- 浏览器自带 PDF 查看器与本插件的 PDF 阅读器不同；需要 PDF 划词和 OCR 时，请使用插件内的阅读器。
- 访问 `file://` 页面时，可能需要在扩展详情中开启“允许访问文件网址”。
- 内置 OCR 语言数据为英语，不提供中文等其他语言的完整 OCR 支持。识别效果受清晰度、排版和字体影响。
- 本地 PDF 上限为 256 MiB；在线 PDF 还受网站登录状态和访问限制影响。
- 解释与翻译结果可能有误；OCR 原文可用于核对识别内容。
- 未提供 Firefox、Safari 或移动浏览器的专用版本。Windows 启动器不适用于 macOS / Linux。

## 开发与检查

项目使用原生 JavaScript、HTML 和 CSS，无需安装 npm 依赖。修改文件后，在扩展管理页重新加载，再刷新相关网页和插件页面。

安装 Node.js 后，在项目根目录运行：

```sh
node tests/run-tests.js
```

测试覆盖弹框定位、请求缓存、输出格式及 OCR 布局等逻辑；`tests/` 还包含浏览器交互检查页面。自动测试不代替真实浏览器中的划词、OCR、API 请求和 Windows 启动器验证。

| 目录 / 文件 | 用途 |
| --- | --- |
| `background.js` | 后台消息处理及模型请求 |
| `content.js`、`popover.css` | 网页划词与解释框 |
| `popup/` | 扩展设置 |
| `pdf/` | PDF 阅读器及随附组件 |
| `ocr/` | 网页 OCR 后台识别 |
| `vocabulary/`、`vocabulary-store.js` | 生词界面及存储 |
| `windows-launcher/` | Windows PDF 右键启动器 |
| `tests/` | 回归测试及交互检查页面 |

## 反馈问题

请在仓库 Issues 中提供浏览器与插件版本、复现步骤、预期表现和实际表现。涉及特定网页或 PDF 时，可提供能够公开分享的最小示例。不要提交 API Key 或包含私人内容的生词备份。

## 第三方组件

PDF 阅读与 OCR 使用随项目分发的第三方组件；版本和许可证索引见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 许可证

项目自身代码采用 [MIT License](LICENSE)，作者 HyePriest。随附第三方组件保留各自的许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

