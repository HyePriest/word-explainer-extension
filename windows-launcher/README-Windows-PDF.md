# 在 Windows 文件管理器中打开 PDF

这个可选启动器会在当前 Windows 用户的 PDF 右键菜单中加入 `Open with Word Explainer`，并把 `Word Explainer` 加入“打开方式”。它不会修改 PDF 的默认应用，也不需要管理员权限。

## 安装前

1. 在 Chrome 中加载本仓库的 Word Explainer 插件。
2. 打开 `chrome://extensions`，确认插件已启用。
3. 开启开发者模式，复制本机显示的插件 ID。安装时必须填写这个 ID；加载目录变化后，ID 也可能变化。
4. 确认要使用哪个 Chrome 个人资料。两个 Chrome 帐号需要分别安装插件，启动器一次只绑定一个个人资料。

## 安装

双击：

```text
Install-WordExplainer.cmd
```

安装脚本会询问插件 ID，并列出本机 Chrome 个人资料。选择安装了 Word Explainer 的那一个即可。它会在本机用随附的 C# 源码生成一个很小的 `WordExplainerLauncher.exe`，使 Windows 能在“打开方式”中显示正确的应用名称。这个过程不联网，也不会安装额外运行库。启动器文件会放到：

```text
%LOCALAPPDATA%\WordExplainerLauncher
```

随后会写入当前用户注册表。安装完成后，在 PDF 上单击右键：

```text
Open with Word Explainer
```

Windows 11 可能把传统右键命令放在“显示更多选项”中。“打开方式”列表受 Windows 缓存影响，重装后仍显示旧的 PowerShell 项时可以重新打开一次文件管理器；新的 `Word Explainer` 项应独立出现。即使列表暂时没有刷新，直接右键命令仍然可以使用。

## 工作原理

Windows 调用具名的 `WordExplainerLauncher.exe`，它再隐藏启动 PowerShell 传输脚本。脚本接收 PDF 路径，在 `127.0.0.1` 上临时开启一个只监听本机的一次性端口，生成随机令牌，然后打开指定 Chrome 个人资料中的插件阅读器。阅读器取走 PDF 后，端口立即关闭；120 秒内没有取走也会自动关闭。PDF 文件本身不会上传到互联网；但你主动请求解释的选中文字或本机 OCR 识别结果会发送给 DeepSeek。

启动器只保存 Chrome 路径、个人资料目录名和插件 ID，不保存 PDF。故障日志只记录 PDF 文件名，不记录完整文件夹路径，并限制在约 256 KB，不会随着使用无限增大。

## 更换 Chrome 帐号或插件 ID

重新运行 `Install-WordExplainer.cmd`，再次选择个人资料或输入新的插件 ID。原有配置会被覆盖。

## 卸载

双击：

```text
Uninstall-WordExplainer.cmd
```

它会删除当前用户的右键菜单、打开方式记录和 `%LOCALAPPDATA%\WordExplainerLauncher` 文件夹，不会删除浏览器插件或生词数据。

## 故障排查

- 出现“Chrome did not request the PDF”：通常是 Chrome 个人资料选错、插件 ID 不对，或该个人资料没有启用插件。重新运行安装脚本。
- 插件更新后 ID 变化：在 `chrome://extensions` 复制新 ID，然后重新安装启动器。
- 中文或带空格的文件名可以正常传递；如果仍然失败，查看 `%LOCALAPPDATA%\WordExplainerLauncher\launcher.log`。
- 公司或学校管理的电脑可能禁止 PowerShell、注册表修改或本机监听端口，这种环境需要管理员策略允许。
