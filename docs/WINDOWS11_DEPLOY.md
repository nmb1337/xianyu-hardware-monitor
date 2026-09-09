# Windows 11 与 GitHub 部署

本项目只应上传源代码。不要上传 `data/`、`.env`、AstrBot API Key、NapCat Token、闲鱼登录状态或 QQ 账号数据；这些内容已经在 `.gitignore` 中排除。

## 1. 推送到 GitHub

### 创建 GitHub 仓库

1. 本项目的私有仓库已创建为 `nmb1337/xianyu-hardware-monitor`。
2. 如需创建另一个仓库，登录 GitHub 后创建空仓库，例如 `xianyu-hardware-monitor`。
3. 不要选择自动创建 README、`.gitignore` 或许可证，以免第一次推送产生冲突。
4. 仓库建议设置为私有；闲鱼监控的关键词和使用意图不适合公开暴露。

### 在本项目目录提交并推送

在 PowerShell 进入项目根目录后执行。当前项目已经完成前四个初始化步骤；如重新初始化仓库，可使用完整命令。

```powershell
git init
git add .gitignore .env.example README.md package.json pnpm-lock.yaml start.ps1 src public test docs
git config user.name "你的 GitHub 昵称"
git config user.email "你的 GitHub 邮箱"
git commit -m "Initial Xianyu hardware monitor"
git branch -M main
git remote add origin https://github.com/nmb1337/xianyu-hardware-monitor.git
git push -u origin main
```

首次 `git push` 可能要求在浏览器中登录 GitHub 或创建 Personal Access Token。这是正常的 GitHub 身份验证流程。

### 后续更新

```powershell
git add README.md package.json pnpm-lock.yaml start.ps1 src public test docs .gitignore .env.example
git commit -m "Describe your change"
git push
```

提交前用下面的命令确认没有把私密数据加入暂存区：

```powershell
git status
git check-ignore data/monitor.sqlite .env
```

第二条命令应输出这两个路径，表示它们会被忽略。

## 2. 第二台 Windows 11 的前置条件

1. 安装 Node.js 22.13 或更高版本，并在 PowerShell 执行 `corepack enable`。
2. 安装 Git for Windows。
3. 安装 Google Chrome 或 Microsoft Edge。
4. 安装 AstrBot，并确认 WebUI 可以在 `http://127.0.0.1:6185` 打开。
5. 安装 NapCat，使用一个专门用于发提醒的 QQ 账号登录。不要在 GitHub 或本项目文件中保存 QQ 密码、二维码或登录缓存。

## 3. 配置 AstrBot 与 NapCat

1. 打开 AstrBot WebUI，进入“机器人”，创建并启用 `OneBot v11`。
2. 设置机器人 ID，例如 `napcat-qq`。此 ID 将填入监控控制台。
3. 反向 WebSocket 主机填 `0.0.0.0`，端口填 `6199`。如设置 Token，NapCat 中必须填相同 Token。
4. 在 NapCat WebUI 的“网络配置”新建“WebSocket 客户端”，启用后将地址设为：

```text
ws://127.0.0.1:6199/ws
```

5. 建议把 NapCat 的心跳和重连间隔设为 `1000` 毫秒。
6. 在 AstrBot 的日志中确认出现 OneBot v11 适配器已连接。
7. 在 AstrBot WebUI 的“设置”创建开发者 API Key，只授予 `im` 权限。Key 只显示一次，保存在密码管理器或本机控制台中，不要提交到 GitHub。

NapCat 登录的 QQ 是发信账号；监控控制台填写的“接收 QQ 号”是收信账号。通常两个 QQ 需要互为好友，且机器人 QQ 必须能向接收 QQ 发私聊。

## 4. 在第二台电脑获取并启动项目

```powershell
git clone https://github.com/nmb1337/xianyu-hardware-monitor.git
cd xianyu-hardware-monitor
Copy-Item .env.example .env
pnpm install
.\start.ps1
```

打开：

```text
http://127.0.0.1:8788
```

在控制台的“QQ 提醒”中填写：

| 字段 | 值 |
| --- | --- |
| AstrBot 地址 | `http://127.0.0.1:6185` |
| AstrBot IM API Key | AstrBot 创建的仅 `im` 权限 API Key |
| OneBot 机器人 ID | AstrBot 创建 OneBot v11 时使用的 ID，例如 `napcat-qq` |
| 接收 QQ 号 | 接收提醒的 QQ 号 |

点击“保存设置”，再点击“发送测试”。收到 QQ 私聊后再继续。

## 5. 登录闲鱼并开始监控

1. 在监控控制台点击“打开登录”。
2. 在弹出的浏览器窗口人工完成闲鱼登录和任何安全验证。
3. 回到控制台点击“验证登录”，状态显示“已登录”后再启动监控。
4. 第一轮扫描只建立基线，不对开始监控前已存在的商品提醒。之后新发布、且价格位于规则区间内的商品才会提醒。

不要尝试绕过闲鱼验证码、登录验证或访问限制。电脑需保持开机、联网，且不要进入休眠。

## 6. 配置登录后自动启动

先确认手动运行 `.\start.ps1` 正常后，在项目根目录以当前 Windows 用户打开 PowerShell，执行：

```powershell
$project = (Get-Location).Path
$taskName = "XianyuHardwareMonitor"
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$project\start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "Launch Xianyu Hardware Monitor after Windows sign-in" -Force
```

验证任务：

```powershell
Start-ScheduledTask -TaskName XianyuHardwareMonitor
```

移除自动启动：

```powershell
Unregister-ScheduledTask -TaskName XianyuHardwareMonitor -Confirm:$false
```

Windows 登录后，AstrBot、NapCat 与本监控程序都必须处于运行状态。闲鱼登录状态失效、QQ 账号掉线、AstrBot 或 NapCat 断开时，需要在对应软件中人工恢复。
