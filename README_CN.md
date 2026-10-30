# Passbolt Search — electerm 自定义 widget

[English](README.md) | 中文

在 electerm 里搜索 Passbolt 条目，直接开 SSH / FTP / Telnet / RDP 连接。

**没有自带界面**：`package.json` 的 `electerm.configs` 描述表单，electerm 渲染它、提交时调 `run(config)`、再把返回的对象画成结果区。`main.js` 只提供函数，所以这个 widget 不需要改 electerm 核心、不需要新的 IPC、不需要构建。

本 widget 基于 GitHub 用户 [@palsanyi](https://github.com/palsanyi) 的代码实现，在此致谢。

```
package.json     元数据 + 表单定义
main.js          Passbolt 客户端（OpenPGP + JWT）+ 动作
node_modules/    openpgp 6.2.2，随 widget 一起提交
README.md        English docs
README_CN.md     中文文档（本文件）
TESTING.md       真实账号 / 离线 mock 的验证流程
scripts/         一次性的本地 Passbolt 测试服务器（docker）
```

## 安装

**Settings → Widgets → Import**，粘贴

```
electerm/electerm-widget-passbolt-search
```

或者完整地址 `https://github.com/electerm/electerm-widget-passbolt-search`。导入会下载这个仓库并复制到 `<data dir>/widgets/passbolt-search/`，所以导入之后不需要联网装依赖。

从仓库导入需要 electerm **v5.8.0+**。`openpgp`（约 16MB）故意提交在 `node_modules` 里：导入过程不会跑 `npm install`。导入是复制不是链接 —— 之后改本仓库的 `main.js` 不影响已安装的那份，要更新就重新导入并确认覆盖。

本地开发就 `git clone` 下来，在同一个对话框里用 **Import folder** 按钮选目录。

## 表单字段

| 字段 | 类型 | 会被保存吗 |
| --- | --- | --- |
| Server URL | `string`，必填 | 会（本地存储，加密） |
| User ID | `string`，必填 | 会 |
| GPG key file | `file`，必填 | 只存路径 |
| Key passphrase | `password` | **永不** |
| Search | `string` | 会 |

`User ID` 是 UUID：网页版 Users / Manage Users & Groups → 点开自己 → 地址栏 `/app/users/view/<UUID>`。
私钥导出：`gpg --export-secret-keys --armor <你的邮箱> > me.asc`，或 Passbolt 设置里的 "Download my key"。

因为 `"persist": true`，非 password 字段下次会自动回填。password 类型在保存时被排除，口令不可能落到本地存储。

## 动作

| 导出 | 谁调用 | 参数 | 返回 |
| --- | --- | --- | --- |
| `run` | 提交按钮 | `(config)` | 信任提示 / 已连接信息 / 搜索结果 |
| `trust` | “Trust this key and connect” | `(config)` | 已连接信息或搜索结果 |
| `details` | 行按钮 | `(row, config)` | 打码的密码 + 条目字段 |
| `openSsh` / `openFtp` / `openTelnet` / `openRdp` | 行按钮 | `(row, config)` | 带解密凭据的 `{ openTab }` |
| `lock` | “Lock and disconnect” | `(config)` | 状态信息 |

`openTab` 由 electerm 开成普通终端标签，并强制带 `from: widget:passbolt-search`；`tab.js` 对该前缀不写连接历史，所以解密出来的凭据不会进同步数据。

## 安全边界

- 私钥文件只在主进程读取，私钥与口令既不发给 Passbolt 也不发给任何第三方
- 口令不落盘：不在表单存储里（按类型排除），也不在 `.state.json` 里
- `.state.json`（与 `main.js` 同目录，权限 600）**只**保存已接受的服务器公钥指纹；删掉它就会重新要求确认
- 元数据与密码都是本地解密，只存在于内存，`lock` 和退出应用会清掉
- 解密失败只上报计数与阶段，不上报 armor、响应体或异常文本
- 首次连接要求你带外比对服务器指纹；指纹变了就拒绝连接，直到你重新确认

## 已知限制

- 服务器必须启用 JWT 认证插件；UUID 需要手填（未实现 recovery-email 新设备流程）
- **不支持 MFA 账号**（登录时会明确报错）
- 搜索范围是资源元数据（名称、用户名、描述、URI、自定义字段），不搜索密码字段
- 共享条目（`metadata_key_type: shared_key`）需要你对那条的 metadata key 有读权限，否则计入 skipped
- 条目格式支持 v4（明文元数据）和 v5（加密元数据）两种；密码统一走 `GET /secrets/resource/<id>`，因为 v4 的 `contain[secret]` 对 v5 条目会返回 400 `V4 related fields are not supported for V5`
- TOTP 只**展示** secret key 和参数（位数 / 周期 / 算法），不生成动态验证码
- FTP / Telnet 是明文协议，只在可信网络用
- 重新导入会用源目录的 `.state.json` 覆盖，指纹要再确认一次

## 离线自检（不需要 Passbolt）

```sh
node scripts/passbolt-mock-and-run.js
```

起一个 127.0.0.1 的假服务器、现场生成一次性密钥，把 widget 走一遍 connect → trust → search → details → openSsh → lock（资源元数据按 Passbolt 5 的 `user_key` 加密形式）。它打印 `PASS`，跑之前会把已存在的 `.state.json`（已信任的服务器指纹）临时移开、跑完再还原 —— 假服务器每次都是新密钥，否则会被指纹变更保护挡下来。这只证明客户端逻辑，不证明你的服务器配置。
