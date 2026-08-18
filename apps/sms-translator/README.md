# SMS 译信 (SMS Translator)

Windows 桌面短信收件箱：把安卓手机的短信同步到电脑，用 Claude 翻译成你的语言，
并按类别 / 风险 / 关键词筛查。

这是一个**独立应用**，与本仓库其它代码无关，源码全部在 `apps/sms-translator/` 下。

---

## 下载（Windows）

不需要自己编译。每次代码推到这个分支，GitHub Actions 会在真正的 Windows 机器上
打好包：

- **打了 tag 的正式版**：仓库 → **Releases** → 下载
  - `SMS Translator-x.y.z-Setup.exe` — 安装版
  - `SMS Translator-x.y.z-Portable.exe` — 免安装，双击就跑
- **最新构建**：仓库 → **Actions** → 选 `Build SMS Translator (Windows)` 最近一次
  运行 → 页面底部 **Artifacts** → `sms-translator-windows`（zip，解压后是同样两个 exe）

> **SmartScreen 会拦一下。** 这个 exe 没有代码签名证书（签名证书要花钱买），
> Windows 首次运行会弹「Windows 已保护你的电脑」。点**「更多信息」→「仍要运行」**
> 即可。介意的话就自己编译（见下方）。

下载完还需要装 adb 并打开手机的 USB 调试，见「先决条件」。

---

## 它能做什么

- **读取手机短信**：通过 ADB 直接读手机的短信数据库，手机上**不需要装任何 App**。
- **双语显示**：每条短信同时显示原文和译文，可一键隐藏原文。
- **发短信**：在电脑上写，可先翻译成对方的语言再发。
- **筛查**：全文搜索（原文+译文同时匹配）、按类别筛（验证码 / 银行 / 物流 /
  营销 / 垃圾 / 疑似诈骗…）、按诈骗风险分筛、仅未读、仅未翻译。
- **诈骗识别**：每条短信给 0–5 的风险分和一句话摘要，高风险的会标红。
- **图片短信（MMS）**：图片会下载下来在会话里显示，并可让 Claude 描述内容 +
  **识别图中文字**——截图式的诈骗短信只有靠这个才筛得出来。**只收不发**，见下方说明。

---

## 先决条件

1. **Windows 10/11**，Node.js 20+（仅开发/打包需要，最终用户装 exe 即可）。
2. **Android Platform Tools（adb）**：从
   <https://developer.android.com/tools/releases/platform-tools> 下载解压即可。
   **不用配环境变量**——软件会自动在这些位置找：PATH、`C:\platform-tools`、
   `C:\Android\platform-tools`、下载文件夹、桌面、Android Studio 的 SDK 目录
   （`%LOCALAPPDATA%\Android\Sdk`）、`ANDROID_HOME`。都找不到时，才需要在设置里
   手填 `adb.exe` 的完整路径。找到之后路径会自动写回设置里显示出来。
3. **三星手机先关掉「自动拦截器」**：One UI 6.1 起，设置 → 安全和隐私 →
   **自动拦截器（Auto Blocker）** 默认会拦下 USB 指令，开发者选项里的「USB 调试」和
   「无线调试」会变成**灰色、点不动**，下面小字写着 `Blocked by Auto Blocker`。
   把它关掉（或关掉其中拦 USB 的那一项）之后开关才可用。用完想恢复可以再打开，
   但下次连电脑还得再关一次。
4. **手机开启调试**：设置 → 关于手机 → 连点「版本号」7 次 → 返回 → 开发者选项。
   然后二选一：
   - **USB**：打开「USB 调试」，插上数据线，手机弹授权框时勾「一律允许」。
   - **WiFi 无线（安卓 11+，不用插线）**：打开「无线调试」，在软件设置的
     「无线连接」里配对一次即可。详见下方「无线连接」。
5. **Anthropic API key**：<https://console.anthropic.com/> 创建，首次启动时填进设置。

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
npm test         # 跑解析与发送按钮识别测试
npm run build    # 编译
npm run dist     # 打包成 Windows 安装包，输出在 release\
```

---

## 图片短信（MMS）

**只支持接收，不支持发送。** 这不是偷懒，是两边难度差得太远：

| | 状况 |
| --- | --- |
| **接收 / 查看图片** | 已实现。图片在 `content://mms/part`，通过 `adb exec-out content read` 取出二进制存到本机 |
| **发送图片** | **没做。** 安卓 7 起禁止把 `file://` 传给其它 App（`FileUriExposedException`），必须用 `content://` 授权；从 adb 这种「外部」身份构造别的 App 认的 content URI 没有干净办法，各家 ROM 表现还不一样。电脑端发送保持纯文字 |

相关设置（默认都开着）：

- **同时同步图片短信（MMS）** — 关掉就只读纯文字短信
- **让 Claude 读图** — 描述图片内容 + 识别图中文字。**每张图一次请求，比纯文字贵不少**，
  不需要筛图片就关掉
- **单个附件大小上限** — 默认 2048 KB，超过就跳过并在那条短信上标注原因

图片存在 `%APPDATA%\sms-translator\data\media\`。为了不让消息日志膨胀，
图片不进日志，界面显示时按需读取。

MMS 和 SMS 的存储结构完全不同，有两个坑值得记下来（都有测试覆盖）：

- **`mms.date` 的单位是秒，不是毫秒**。直接用会让所有图片短信掉到 1970 年。
- **发件人不在消息表里**，在单独的 `content://mms/<id>/addr`，靠 PDU 头类型区分
  （137 = 发件人，151 = 收件人），里面还混着一行代表「我自己」的占位地址。

另外图片二进制必须走 `adb exec-out` 而不是 `adb shell`——后者会改写换行符，
悄悄把图片弄坏，而且要等到很久以后打开文件才发现。

---

## 无线连接（不用一直插着数据线）

**蓝牙不行**——adb 没有蓝牙通道；蓝牙的 MAP 协议是另一套东西，Windows 上第三方
程序基本用不了，而且只能拿到最近少量消息。**WiFi 可以，而且完全不用 USB。**

要求：手机和电脑在**同一个 WiFi**；安卓 11 及以上。

1. 手机：设置 → 开发者选项 → 打开**「无线调试」**
2. 点进「无线调试」→**「使用配对码配对设备」**，会弹出一组 `IP:端口` 和 6 位配对码
3. 软件设置 →「无线连接」→ **第 1 步** 填这组地址和配对码 → 点「配对」（只需一次）
4. 回到手机「无线调试」**主界面**，上面还显示一组 `IP:端口`
5. 软件里 **第 2 步** 填这一组 → 点「连接」

> ⚠️ **最容易错的地方**：第 3 步和第 5 步的**端口不一样**。配对用的是弹窗里那个，
> 连接用的是主界面上那个。填错会提示「配对失败」或「连接失败」。

**关于掉线**：手机息屏、切换 WiFi、路由器抖动都会断开，这是无线调试的正常现象。
软件默认开启「断线后自动重连」——发现设备不在了会自己重跑 `adb connect`，一般
你不会察觉。但有两种情况必须手动重来：

- **手机把「无线调试」关掉再打开** → 端口会变，要回软件里重新填连接地址
- **重启手机** → 通常要重新配对

安卓 10 及更早没有「无线调试」界面，可以用软件里那个「先插线，点这里切到无线」
按钮：它会在手机上执行 `adb tcpip 5555` 并读出手机 WiFi 地址填好，之后就能拔线。
缺点是手机重启后失效，要再插一次线。

---

## 三星用户请先做这一步

三星 One UI 允许电脑读短信库，所以正常情况下可以直接用。插上手机后先跑一次
这条命令确认：

```powershell
adb shell content query --uri content://sms --projection _id:body
```

- 有 `Row: 0 _id=... body=...` 这样的输出 → 没问题，正常使用。
- 出现 `Permission Denial` → 你这台的系统禁掉了，除非 root 否则无解。

另外几点三星相关的：

- **开关是灰的、写着 `Blocked by Auto Blocker`** → 设置 → 安全和隐私 → 自动拦截器，
  关掉它。这是三星拦 USB 指令的功能，USB 调试和无线调试都会被它锁住。

- **一定要在手机上点「允许 USB 调试」的授权框**，勾上「一律允许」，否则
  `adb devices` 只会显示 `unauthorized`。
- 三星的默认短信 App 是 **Samsung Messages**（`com.samsung.android.messaging`），
  发送按钮识别已经按它的控件 id 做了适配和测试。如果你把默认短信 App 换成了
  Google Messages，也同样支持。

---

## 必须知道的限制

这几条是安卓平台本身的限制，不是实现偷懒，请先看完再用。

### 1. 只支持 Android，不支持 iPhone

iOS 不向第三方开放读取或发送短信的接口。这个应用对 iPhone 无解。

### 2. 发短信是"半自动"的，不是真正的直接发送

安卓**没有**提供给电脑的直发短信接口。`service call isms` 那套办法依赖每个
安卓版本各不相同的事务号，极其脆弱。所以本应用的做法是：

1. 用 `am start` 唤起手机的默认短信 App，把收件人和内容预填好；
2. 读取手机当前界面（`uiautomator dump`），找到发送按钮，`input tap` 点它。

三档发送方式（设置里可切）：

| 方式 | 说明 |
| --- | --- |
| **识别发送按钮**（默认，三星适用） | 从界面层级里找 `send_button` 之类的控件再点。跨 ROM 可靠。找不到时自动退回模拟按键，并在界面上提示你去手机确认 |
| 模拟方向键+回车 | 原生 AOSP 界面能用，三星 One UI 上多半点不中。保留作为备选 |
| 仅填好草稿 | 只预填，发送键由你在手机上按。最稳妥 |

按钮识别做了防误触：`resend`（重发）、`sender`（发件人）、`send_later`（定时发送）、
附件/表情/相机等控件会被显式排除，置信度不够就宁可不点。这部分有测试覆盖
（`npm test`，含三星 One UI 和 Google Messages 的真实界面层级样本）。

后果：

- **发送时手机屏幕会亮起并短暂显示短信 App**，这是正常的。
- **第一次发送请盯着手机屏幕确认**。这一步无法在没有真机的情况下验证。
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
  adb/adb.ts         adb 进程封装、设备发现、shell 引号转义、二进制安全输出
  adb/rows.ts        content query 输出的通用行解析（靠列名锚定）
  adb/mms.ts         MMS 消息/分部/地址查询、附件读取（有测试）
  adb/locate.ts      自动查找 adb（常见安装位置，有测试）
  adb/sms.ts         content://sms 查询（有测试）
  adb/send.ts        SENDTO intent + 界面发送按钮识别（有测试）
  adb/wireless.ts    WiFi 无线调试：配对/连接/断开、自动重连（有测试）
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
test/send-button.js  发送按钮识别测试
test/locate-adb.js   adb 自动查找测试
test/wireless.js     无线连接输出解析测试
test/parse-mms.js    MMS 解析测试（秒/毫秒、addr 类型、SMIL 过滤）
build/make-icon.py   纯 Python 生成应用图标（无需 Pillow）
preview/            用假数据渲染界面并截图（没手机时验证 UI 用）
```

### 一些实现上的取舍

- **存储不用 SQLite**：`better-sqlite3` 是原生模块，每个 Electron 版本都要重新
  编译，对一个只有几万条短行记录的收件箱不值得。改用追加式 JSONL + 定期压缩。
- **行解析靠列名锚定**：`content query` 输出没有任何转义，正文里出现逗号、换行、
  甚至 `foo=bar` 都是合法的。解析时用**下一个列名**作为锚点做非贪婪匹配，并把
  `body` 强制放在投影的最后一列，这样只有最后一个字段可以包含任意文本。
- **同步游标带 60 秒重叠**：手机偶尔会写入时间戳略早于上一条的记录（校时、
  长短信重组），严格的 `date >` 游标会永久漏掉它们。
- **发送按钮靠界面识别而非固定坐标**：坐标会随机型、分辨率、字号、深浅色主题变化，
  读界面层级则跨 ROM 稳定。宁可识别不出来退回备选方案，也不乱点。
- **图片不进消息日志**：base64 塞进 JSONL 会让它膨胀到不可用。图片按文件存，
  界面要显示时通过 IPC 按需读成 data URL（页面 CSP 只允许 `data:` 图片，
  直接给文件路径也用不了）。
- **`adb connect` 的成功与否只能看输出，不能看退出码**：连接失败时它照样返回 0，
  信了退出码就会报告一个根本不存在的连接，然后在后面莫名其妙地失败。
- **Windows 包在 GitHub Actions 上打**：在 Linux 上交叉编译 Windows 目标需要 Wine
  才能给 exe 写图标和版本信息，用真正的 Windows runner 更省事也更可靠。
