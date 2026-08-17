# SMS 译信 (SMS Translator)

Windows 桌面短信收件箱：把安卓手机的短信同步到电脑，用 Claude 翻译成你的语言，
并按类别 / 风险 / 关键词筛查。

这是一个**独立应用**，与本仓库其它代码无关，源码全部在 `apps/sms-translator/` 下。

---

## 它能做什么

- **读取手机短信**：通过 ADB 直接读手机的短信数据库，手机上**不需要装任何 App**。
- **双语显示**：每条短信同时显示原文和译文，可一键隐藏原文。
- **发短信**：在电脑上写，可先翻译成对方的语言再发。
- **筛查**：全文搜索（原文+译文同时匹配）、按类别筛（验证码 / 银行 / 物流 /
  营销 / 垃圾 / 疑似诈骗…）、按诈骗风险分筛、仅未读、仅未翻译。
- **诈骗识别**：每条短信给 0–5 的风险分和一句话摘要，高风险的会标红。

---

## 先决条件

1. **Windows 10/11**，Node.js 20+（仅开发/打包需要，最终用户装 exe 即可）。
2. **Android Platform Tools（adb）**：从
   <https://developer.android.com/tools/releases/platform-tools> 下载解压，
   把目录加进 PATH，或在应用设置里填 `adb.exe` 的完整路径。
3. **手机开启 USB 调试**：设置 → 关于手机 → 连点「版本号」7 次 → 返回 →
   开发者选项 → 打开「USB 调试」。插上数据线后，手机会弹出授权框，勾选
   「一律允许」。
4. **Anthropic API key**：<https://console.anthropic.com/> 创建，首次启动时填进设置。

验证连接：

```powershell
adb devices
# 应该看到:  ABCDEF123456    device
```

`unauthorized` 表示手机上的授权框还没点；空列表表示线/驱动/USB 调试有问题。

---

## 运行与打包

```powershell
cd apps\sms-translator
npm install

npm run dev      # 开发模式（Vite HMR + Electron）
npm test         # 跑短信解析测试
npm run build    # 编译
npm run dist     # 打包成 Windows 安装包，输出在 release\
```

---

## 必须知道的限制

这几条是安卓平台本身的限制，不是实现偷懒，请先看完再用。

### 1. 只支持 Android，不支持 iPhone

iOS 不向第三方开放读取或发送短信的接口。这个应用对 iPhone 无解。

### 2. 发短信是"半自动"的，不是真正的直接发送

安卓**没有**提供给电脑的直发短信接口。`service call isms` 那套办法依赖每个
安卓版本各不相同的事务号，极其脆弱。所以本应用的做法是：

1. 用 `am start` 唤起手机的默认短信 App，并把收件人和内容预填好；
2. 模拟按下「方向键右 + 回车」，落在发送按钮上。

后果：

- **发送时手机屏幕会亮起并短暂显示短信 App**，这是正常的。
- 在高度定制的 ROM（部分 MIUI / ColorOS / Flyme）上，按键可能点不中发送按钮。
  **第一次发送请盯着手机屏幕确认**；如果没点中，去设置里改成「仅填好草稿，
  由我在手机上确认发送」，或把「点击发送前等待」调大（App 启动慢时）。
- 发出的短信会先以「发送中」的样子出现在界面上，等下一次同步从手机数据库读到
  真正那条之后自动替换。30 分钟内手机数据库里没有出现对应记录的，会被判定为
  没发出去并移除。

### 3. 少数 ROM 不让电脑读短信库

本应用读的是 `content://sms`。AOSP 和大多数 OEM 系统允许 `shell` 用户读它，
但有些锁得比较死的系统会拒绝，表现为报错 "The phone refused to share
content://sms"。这种情况下**没有绕过办法**（除非 root），只能换个方案。

自己验证一下：

```powershell
adb shell content query --uri content://sms --projection _id:body
```

有输出就没问题；出现 `Permission Denial` 就是被拒了。

### 4. 已读状态是本地的

`shell` 用户一般没有写短信库的权限，所以在电脑上把会话标为已读**不会**同步回
手机。已读状态只保存在电脑本地。

### 5. 联系人姓名是尽力而为

姓名通过联系人 provider 查询，很多系统不允许，查不到就只显示号码。这不影响其它功能。

---

## 隐私

- 短信内容存在本机：`%APPDATA%\sms-translator\data\messages.jsonl`（明文）。
- API key 存在 `%APPDATA%\sms-translator\settings.json`，在 Windows 上用系统
  凭据接口（DPAPI）加密。
- **开启翻译后，短信正文会发送到 Anthropic 的 API**。不想让某些短信出去，就在设置里
  关掉「新短信自动翻译」，只对需要的会话手动点翻译。
- 除 Anthropic API 外，应用不向任何其它服务器发送数据。

---

## 费用

按 Anthropic 的 API 计费。默认 20 条短信打包成一次请求、effort 设为 `low`，
一条短信通常只有几十个 token。想更省可以在设置里换成 `claude-sonnet-5` 或
`claude-haiku-4-5`，或者关掉「分类与风险评估」。

---

## 代码结构

```
electron/            主进程
  adb/adb.ts         adb 进程封装、设备发现、shell 引号转义
  adb/sms.ts         content://sms 查询与行解析（最脆弱的一块，有测试）
  adb/send.ts        通过 SENDTO intent 发送
  adb/contacts.ts    联系人姓名查询（尽力而为）
  store.ts           JSONL 追加式存储 + 定期压缩（无原生依赖）
  settings.ts        设置持久化，API key 走 safeStorage
  sync/syncer.ts     轮询同步、增量游标、乐观发送记录的回收
  translate/claude.ts  Claude 调用（结构化输出）
  translate/queue.ts   串行批量翻译队列
  ipc.ts             IPC 处理器
  preload.ts         contextBridge 暴露的 window.sms
src/                 渲染进程（React）
  lib/derive.ts      会话分组、筛选、格式化
  components/        Sidebar / Thread / Composer / SettingsModal
shared/types.ts      主进程与渲染进程共用的类型
test/parse-sms.js    短信解析测试
```

### 一些实现上的取舍

- **存储不用 SQLite**：`better-sqlite3` 是原生模块，每个 Electron 版本都要重新
  编译，对一个只有几万条短行记录的收件箱不值得。改用追加式 JSONL + 定期压缩。
- **行解析靠列名锚定**：`content query` 输出没有任何转义，正文里出现逗号、换行、
  甚至 `foo=bar` 都是合法的。解析时用**下一个列名**作为锚点做非贪婪匹配，并把
  `body` 强制放在投影的最后一列，这样只有最后一个字段可以包含任意文本。
- **同步游标带 60 秒重叠**：手机偶尔会写入时间戳略早于上一条的记录（校时、
  长短信重组），严格的 `date >` 游标会永久漏掉它们。
