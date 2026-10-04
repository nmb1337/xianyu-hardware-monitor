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
| 接收 QQ 号 | 接收提醒的 QQ 号；可填多个，用逗号、空格或分号分隔（最多 10 个） |

点击“保存设置”，再点击“发送测试”。页面成功只代表 AstrBot 接口接受了请求，还要在接收 QQ 和 NapCat 日志中确认实际收到私聊后再继续。测试不会启动闲鱼扫描。填写多个接收 QQ 时，消息会逐个发送；个别接收人发送失败只重试未成功的人，已收到的不会重复。

如果接口测试成功但 QQ 没收到，检查 NapCat QQ 在线状态、AstrBot OneBot WebSocket 连接、机器人 ID、机器人 QQ 与接收 QQ 的好友关系，以及接收 QQ 的陌生人消息设置。

## 5. 登录闲鱼并开始监控

1. 在监控控制台点击“打开登录”。
2. 在弹出的浏览器窗口人工完成闲鱼登录和任何安全验证。需要扫码登录时，窗口会保持打开，等待期间程序不会关闭、切换或刷新它；扫码成功后状态会自动变为“已登录”。建议另一种浏览器也点“切换浏览器”后各登录一次；Chrome 与 Edge 的登录资料分别保存在 `data/chrome-profile` 和 `data/edge-profile`。遇到访问验证或登录失效时，程序会自动改用已登录的另一种浏览器，确认登录后自动继续查询。
3. 回到控制台点击“验证登录”，状态显示“已登录”后再启动监控。
4. 第一轮扫描只建立基线，不对开始监控前已存在的商品提醒；之后程序按规则顺序查询。普通规则每条至少间隔 600 秒，整机估价规则每条至少间隔 900 秒，轮询间隔默认随机 120–300 秒并叠加 45–90 秒冷却。普通规则看“新发布”商品；整机估价规则按关键词直接搜索（不切换排序），读取商品详情文案估算整机价值，估值落在提醒区间内才提醒。
5. 如果频繁出现“访问验证/登录失效”，且换浏览器、换账号都无效，通常是网络出口 IP 被风控：在“闲鱼浏览器”中把“网络出口”切换为“直连（不使用代理）”（国内宽带/移动 IP 通常更安全），或填写另一条代理线路；保存后点“关闭浏览器”再点“打开登录”。仍不行时可点“重置资料”清空浏览器环境（等于换新设备，需重新扫码）再试。

不要尝试绕过闲鱼验证码、登录验证或访问限制。电脑需保持开机、联网，且不要进入休眠。

## 6. 配置登录后自动启动

先确认手动运行 `.\run-monitor.ps1` 正常后，在项目根目录以当前 Windows 用户打开 PowerShell，执行：

```powershell
$project = (Get-Location).Path
$taskName = "XianyuHardwareMonitor"
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$project\run-monitor.ps1`""
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

## 7. 设置桌面图标

项目提供了图标更新脚本。把 PNG 图片路径替换为你自己的图片后，在项目根目录运行：

```powershell
.\scripts\set-desktop-icon.ps1 -ImagePath "C:\path\to\your\icon.png"
```

脚本会生成 `assets\xianyu-hardware-monitor.ico`，并更新桌面的 `闲鱼硬件监控.lnk`；快捷方式会后台启动当前项目的 `run-monitor.ps1`，等待 8788 端口就绪后打开控制台。图片会被缩放为 Windows 图标使用的 256×256 尺寸。
