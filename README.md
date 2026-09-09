# 闲鱼硬件低价监控

本地运行的闲鱼电脑及硬件价格监控工具。为每个关键词设置最低价和最高价，首次扫描建立已有商品基线；之后发现价格处于区间内的新商品时，通过 AstrBot 和 NapCat 向指定 QQ 私聊发送提醒。

支持笔记本、台式整机、CPU、主板、显卡、内存、硬盘/SSD、显示器、电源、机箱、散热器、网卡和自定义品类。

## 启动

需要 Node.js 22.13 或更高版本，并安装 Google Chrome 或 Microsoft Edge。

```powershell
pnpm install
pnpm start
```

打开 `http://127.0.0.1:8788`。

第一次使用时，在“闲鱼浏览器”中打开登录窗口并完成登录，然后验证登录状态。Chrome 用户数据、SQLite 数据库和 AstrBot API Key 保存在 `data/`，该目录已被 Git 忽略。

## AstrBot + NapCat

1. 安装 AstrBot 和 NapCat，并在 NapCat 登录用于发消息的 QQ。
2. 在 AstrBot WebUI 的“机器人”中创建并启用 `OneBot v11` 机器人。记下其 ID，例如 `napcat-qq`。
3. 在 AstrBot OneBot 设置中使用反向 WebSocket 端口 `6199`；在 NapCat 的网络配置创建“WebSocket 客户端”，地址填写 `ws://127.0.0.1:6199/ws`。AstrBot 日志显示 OneBot 适配器已连接后再继续。
4. 在 AstrBot WebUI 的“设置”创建开发者 API Key，仅勾选 `im` 权限。
5. 在本工具的“QQ 提醒”中填写 AstrBot 地址（默认 `http://127.0.0.1:6185`）、IM API Key、OneBot 机器人 ID 与接收 QQ 号，然后点击“发送测试”。

提醒由 NapCat 已登录的 QQ 发出，接收 QQ 是你的收件账号；两者不是同一个概念。通常需要让机器人 QQ 与接收 QQ 互为好友。QQ 消息和本地控制台都会包含商品原链接。

## 运行行为

- 每条规则默认 120 秒扫描一次，并额外加入随机等待。
- 程序串行扫描，避免并发浏览器请求。
- 首次扫描只建立基线，不提醒扫描开始前已经存在的商品；后续新出现的商品价格处于设定区间时提醒一次。
- 同一商品不会重复提醒；已有商品后续降价不会被当成新发布商品提醒。
- 修改关键词、价格区间或筛选条件会清除该规则旧基线，并在下次扫描重新建立基线。
- 遇到登录失效、验证码或访问验证时，浏览器会保留在前台，需人工处理。
- 不绕过验证码、登录验证或平台访问限制。

## 测试

```powershell
pnpm test
```

## 屏蔽商品

低价商品表中点击“屏蔽”后，该闲鱼商品 ID 会被持久化过滤：不再显示、不再入队提醒；已有的待发提醒会取消。可在“已屏蔽商品”中恢复，恢复后商品重新显示，因屏蔽取消的待发提醒会继续发送。

## Windows 11 与 GitHub 部署

完整的第二台电脑部署、GitHub 推送和开机自启流程见 [Windows 11 部署说明](docs/WINDOWS11_DEPLOY.md)。

GitHub 私有仓库：<https://github.com/nmb1337/xianyu-hardware-monitor>
