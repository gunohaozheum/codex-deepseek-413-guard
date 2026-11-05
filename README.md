# Codex DeepSeek 413 Guard

**A reversible Windows proxy that prevents Codex from exceeding the official
DeepSeek Responses API request-size limit.**

[![Windows](https://img.shields.io/badge/platform-Windows-0078D4)](#requirements)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933)](#requirements)
[![Tests](https://github.com/gunohaozheum/codex-deepseek-413-guard/actions/workflows/test.yml/badge.svg)](https://github.com/gunohaozheum/codex-deepseek-413-guard/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

一个独立、可撤销的 Windows 本机代理，用于解决 Codex 通过官方 DeepSeek
Responses API 使用长对话或图片时出现的：

```text
413 Payload Too Large: Failed to buffer the request body: length limit exceeded
```

项目只使用 Node.js 内置模块，不依赖其他本地项目，也不需要安装 npm 依赖。

## 为什么需要它

`413 Payload Too Large` 是 HTTP 请求体超过上游大小限制，不是普通的上下文
token 用尽。Codex 的长对话会反复发送历史内容；历史截图和 Base64 图片尤其容易
在达到 token 上限之前先超过 DeepSeek 的请求体限制。

本工具在请求离开本机前做两层保护：

1. 请求超过 **44 MiB**：保留当前轮图片，移除更早用户轮次中的 Base64 图片。
2. 修剪后仍超过 **47 MiB**：本地返回清楚的 413，不再发送必然失败的上游请求。

## 功能边界

| 会做 | 不会做 |
| --- | --- |
| 修改 Codex 的 `[model_providers.deepseek]` 地址 | 修改模型、消息或 API Key |
| 把官方 DeepSeek 请求转到 `127.0.0.1:18766` | 向局域网开放端口 |
| 修剪历史内联图片 | 修剪当前用户轮次的图片 |
| 提供暂停、关闭和彻底还原 | 删除聊天历史或 Codex 数据 |
| 提供 Windows 双击控制脚本 | 记录聊天正文或图片 |

此项目只处理明确配置为经过 `deepseek` provider 的请求。`deepseek_direct`、
curl 或其他 API 客户端直接连接官方 API 时不会经过本保护。

## Requirements

- Windows 10 or Windows 11
- Node.js 18 or newer
- An existing official DeepSeek provider in Codex

Codex 配置中应已经有类似段落。本项目不会读取或改写 Key，下面是通用示例：

```toml
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
experimental_bearer_token = "<由你自己配置的 Key>"
```

如果没有该 provider，请先完成 Codex 官方 DeepSeek 配置，再运行本项目。

## 三步开始

1. 确认电脑已安装 Node.js 18+。
2. 双击 `enable.cmd`。
3. 在 Codex 中使用 `deepseek` provider；必要时重启 Codex。

启用后，provider 地址会变为：

```text
http://127.0.0.1:18766/v1
```

以后需要管理时，双击 [control.cmd](control.cmd) 即可。

## 双击脚本

| 文件 | 作用 |
| --- | --- |
| [control.cmd](control.cmd) | 打开完整菜单，推荐日常使用 |
| [enable.cmd](enable.cmd) | 安装/启动代理并启用保护 |
| [pause.cmd](pause.cmd) | 暂停修剪与本地拦截，但保留代理 |
| [resume.cmd](resume.cmd) | 恢复保护逻辑 |
| [disable.cmd](disable.cmd) | 恢复官方 URL、停止代理、移除自动启动 |
| [restore.cmd](restore.cmd) | 彻底恢复并清理运行时状态 |

`control.cmd` 的菜单：

```text
1. Enable or repair protection
2. Pause image pruning (proxy stays active)
3. Resume image pruning
4. Disable and restore the official URL
5. Show status
6. Remove automatic startup and restore everything
0. Exit
```

## 请求路径

```text
Codex
  -> 127.0.0.1:18766/v1/responses
  -> historical image pruning + 47 MiB local preflight
  -> https://api.deepseek.com/responses
```

代理只监听回环地址。Bearer Token 从 Codex 请求头原样转发，或从进程环境变量
`DEEPSEEK_API_KEY` 读取；不会写入仓库、日志或状态文件。

## 暂停、关闭和还原

- **暂停**：代理继续运行，但不修剪图片，也不执行 47 MiB 本地拦截。
- **关闭**：把 Codex 恢复为 `https://api.deepseek.com/` 并停止代理。
- **彻底还原**：在关闭的基础上删除自动启动项、暂停标志和 PID 文件。

自动启动使用当前用户的 Windows“启动”文件夹快捷方式，不需要管理员权限。
移动项目目录后，请重新运行 `enable.cmd`。删除整个项目目录前，请先运行
`restore.cmd`，否则 Codex 仍可能指向已经停止的本地端口。

## 配置

编辑 [guard.config.json](guard.config.json)：

```json
{
  "host": "127.0.0.1",
  "port": 18766,
  "upstreamBaseUrl": "https://api.deepseek.com",
  "maxRequestMiB": 128,
  "pruneAtMiB": 44,
  "hardLimitMiB": 47,
  "upstreamTimeoutMinutes": 15
}
```

修改端口后重新运行 `enable.cmd`，Codex 配置和健康检查地址会一起更新。

开发或排查时也可以使用环境变量：

```powershell
$env:DEEPSEEK_GUARD_PAUSE = '1'
node .\src\proxy.mjs
```

## 状态检查

```powershell
Invoke-RestMethod http://127.0.0.1:18766/health
```

健康接口只返回服务状态、PID、暂停状态和大小阈值。

## 常见问题

### 启动后 Codex 没有使用新代理

确认当前模型 provider 是 `deepseek`，并重启 Codex。默认 provider 为
`codex_router` 或其他名称时，本工具不会接管那些请求。

### 提示找不到 `[model_providers.deepseek]`

先在 Codex 中配置官方 DeepSeek provider。启用脚本只修改该 provider 的
`base_url`，不会自动创建或覆盖 Key。

### 健康检查失败

检查 `18766` 是否被其他程序占用，或修改 [guard.config.json](guard.config.json)
中的端口后重新运行 `enable.cmd`。

### 关闭后仍有请求失败

运行 `restore.cmd`，然后重启 Codex，确认 provider 地址已恢复为
`https://api.deepseek.com/`。

## 开发与测试

```powershell
node --test
```

测试覆盖历史图片修剪、当前轮超限拦截、传输层超限响应、远程图片保留、
暂停透传、配置切换和健康接口，共 12 项。

## 隐私与安全

- 仓库不含 API Key、Cookie、聊天正文、用户名或本机绝对项目路径。
- `runtime/`、`logs/`、`.env`、PID 文件均在 `.gitignore` 中忽略。
- 服务只绑定回环地址，不向局域网开放。
- 错误和日志只包含状态码、请求大小、图片数量和耗时。
- 本项目不会自动上传任何数据，也不会发送遥测。

## License

[MIT](LICENSE)
