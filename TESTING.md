# Passbolt widget — 验证流程 / Verification walkthrough

两种验证方式：**A. 真实账号**（推荐，能证明你的服务器配置也通）和 **B. 离线 mock**（不需要服务器，只证明客户端逻辑）。按顺序勾一遍即可；最后的「故障对照表」用来判断卡在哪一步。

不要在任何 issue / 截图里贴私钥、口令或解密出来的密码。

## 支持，先看最短路径

这个 widget 对**真实账号**是支持的：登录走的就是 Passbolt 的 JWT challenge（`POST /auth/jwt/login.json`，
用你的私钥签名、服务器公钥验签），和网页版是同一套流程，只是没有浏览器、没有 MFA。

需要四样东西，缺一不可：

1. **服务器启用了 JWT 认证插件** —— Passbolt 5.x 默认启用；`curl -s https://<server>/auth/verify.json` 有 JSON 就说明服务在
2. **你的 user UUID** —— 网页版 Users / Manage Users & Groups → 点开自己 → 地址栏 `/app/users/view/<UUID>`
3. **你当前那把私钥** —— `gpg --export-secret-keys --armor <你的邮箱> > /tmp/me.asc`（或网页版设置里的 "Download my key"）
4. **私钥口令** —— 这把 key 有口令才需要

然后：Import → 填 Server URL / User ID / key file / passphrase（Search 先留空）→ **Connect / search**
→ 首次出现服务器指纹，带外核对一致 → **Trust this key and connect** → 填 Search 再提交 → 行上的 **Details** / **SSH**。

**MFA 账号不支持**（登录时会明确报 `requires MFA`），服务器必须能走 JWT 插件。逐项勾选见下面 A 节。

---

## 本仓库自带一台：本地 Passbolt

不想拿生产服务器练手，也不想在别人的实例上试错误路径：用 docker 起一台一次性的。

```sh
./scripts/passbolt-start.sh     # mariadb + passbolt CE，映射到 http://localhost:8088
./scripts/passbolt-init.sh      # 造一个可登录的测试账号，打印 widget 要填的值
./scripts/passbolt-stop.sh      # 停掉，数据留着；--purge 连容器和卷一起删
```

`passbolt-init.sh` 结束时会打印 **Server URL / User ID / GPG key file / Passphrase / 服务器指纹**，
私钥落在 `scripts/.passbolt/me.asc`。照着填进 widget，第一次 Connect 出现的指纹和打印的那行比对，
一致就 Trust —— 这一步本身就是在验证「带外核对指纹」这条设计。

为什么不是「注册 → 浏览器设口令」：Passbolt 5 的 setup 页面要求先装 Passbolt 浏览器扩展，没装只显示
"Please install the browser extension"（那个 Unsafe mode 只是个文档链接）。所以默认走数据库播种：
写入和完成 setup 等价的 `users` / `profiles` / `gpgkeys` 三行，账号可以正常走 JWT challenge 登录，
只是没消耗 setup token。想要真实页面流程：`./scripts/passbolt-init.sh --browser`（先装扩展）。

- 服务器是 **http**（`http://localhost:8088`），对 widget 没问题；扩展那套要求是给网页版用的
- 不要在这个账号上开 **MFA**，widget 不支持，这正好也是 A.8 要验证的边界
- 账号自带 8 条样例条目（见下），不需要网页版造数据；`--no-samples` 可以不要它们
- Docker Hub 不通时：`PASSBOLT_REGISTRY_MIRROR=docker.1panel.live ./scripts/passbolt-start.sh`

通道本身已在 **Passbolt CE 5.17.0** 上实测：connect → 指纹 → trust → search → lock 全通过。

清空重来：`./scripts/passbolt-stop.sh --purge && ./scripts/passbolt-init.sh`。

## 样例条目（init 默认播种）

| 条目 | 资源类型 | 用途 |
| --- | --- | --- |
| Jenkins API token | 简单密码（v4） | 没有用户名、没有 URI，检查空列显示 |
| Example website | 密码+描述（v4） | https，正常的一条 |
| Router SSH | 密码+描述（v4） | `ssh://root@10.0.0.12:2222`，检查 **SSH** 按钮读端口 |
| Deploy FTP | 密码+描述（v4） | `ftp://deploy@files.example.com:2121`，检查 **FTP** 按钮 |
| VPN gateway | 密码+描述+TOTP（v4） | v4 的 totp 是 JSON **字符串** |
| v5 default entry | v5 默认 | 元数据加密（user_key），secret 是 `{object_type, data}` |
| v5 with TOTP | v5 带 TOTP | v5 的 totp 是**对象** |
| v5 note | v5 note | 没有密码、没有用户名，只有描述 |

全部用账号自己的公钥加密并签名（`users` / `resources` / `secrets` / `secret_revisions` / `permissions` 五张表，权限 type=15），和网页版新建的条目等价。重复运行 `init` 会先删掉这 8 个固定 id 再插入，所以不会越积越多。

照着这 8 条勾：Search 里能看到「Scanned 8 entries, decrypted 8」，每条 **Details** 都能出密码（v5 那几条以前会报 `V4 related fields are not supported for V5`，已修），两条 TOTP 显示 `TOTP secret` + `TOTP settings`，v5 note 只有描述，SSH 按钮开出来是 `10.0.0.12:2222`。

## A. 真实 Passbolt 账号

### 0. 前置条件

- [ ] electerm 带 user widget 支持（未发布前：electerm 仓库里 `npm run compile && cp -r src/app/. work/app/ && npm run t`）
- [ ] 网页版能正常登录你的账号
- [ ] 服务器启用了 **JWT authentication plugin**（Passbolt 5.x 默认启用；自建老版本可能没有）
- [ ] 知道自己的 **user UUID**：Users / Manage Users & Groups → 点开自己 → 地址栏 `/app/users/view/<UUID>`
- [ ] 至少一条**带 URI**、**有密码**的条目（个人或共享都可以）

### 1. 准备私钥

```sh
gpg --list-secret-keys --keyid-format long          # 找到自己的 key
gpg --export-secret-keys --armor <邮箱或 key id> > /tmp/me.asc
```

- [ ] 文件开头是 `-----BEGIN PGP PRIVATE KEY BLOCK-----`
- [ ] 记得这个 key 有没有口令（升级过 Passbolt 的账号通常有）
- [ ] 如果你在 Passbolt 里换过设备/重过 key，确认导出的是**当前**那把（网页版设置里 "Download my key" 最稳）

### 2. 导入 widget

- [ ] Settings → Widgets → Import，粘贴 `electerm/electerm-widget-passbolt-search`（或本地 clone 后选本仓库根目录）
- [ ] 列表里出现 **Passbolt Search**；点它，右侧是自动生成的表单（没有 iframe、没有 HTML）
- [ ] 顶部没有红色错误条（有的话说明 `package.json` 或 `main.js` 有问题，见对照表）

### 3. 第一次提交（信任服务器钥匙）

填表：Server URL、User ID、GPG key file（按钮选文件）、passphrase、Search 先留空 → 点 **Connect / search**。

- [ ] 出现黄色提示 + 一行 **Server key** 指纹（4 字符一组）
- [ ] 这个指纹和你管理员给的、或 `<server>/auth/verify.json` 里的一致
- [ ] 点 **Trust this key and connect** → 出现绿色「Connected to …」，并列出 **Server key** 和 **Your key** 两个指纹
- [ ] 同目录出现 `.state.json`，内容只有 `trustedFingerprint`：

```sh
cat "$(electerm data dir)/widgets/passbolt-search/.state.json"   # 或源目录，若你直接在源目录试
```

### 4. 搜索

- [ ] Search 里填一个**你在网页版确定存在**的关键词（主机名 / 用户名 / IP 都行）→ 再点提交
- [ ] 结果是一张表：Name / Username / URI / Type，行数与网页版对得上
- [ ] 提示行显示 `Scanned N entries, decrypted N. M match(es).`
- [ ] 如果显示 `skipped K`，说明有 K 条元数据解不开或签名不可信 —— 记下 K，第 8 步再看

### 5. Details（解密）

- [ ] 点某行的 **Details**
- [ ] 密码显示为 `••••••`，点眼睛能揭示，点复制能进剪贴板
- [ ] 用户名、URI 与网页版一致；自定义字段会平铺在后面

### 6. 打开连接

- [ ] 点某行的 **SSH** → 新标签打开，标题是条目名，用户名/密码已填
- [ ] 同一个连接**不出现在**「连接历史」里（tab 带 `from: widget:passbolt-search`）
- [ ] FTP / Telnet / RDP 同理（端口取 URI 里的，没写则用 22/21/23/3389）

### 7. Lock 与持久化

- [ ] 点 **Lock and disconnect** → 提示 tokens/keys 已清空
- [ ] 再点行上的 Details → 报「session is closed. Connect again.」
- [ ] 关掉设置面板再打开：非 password 字段被回填，**passphrase 是空的**
- [ ] 重启 electerm → 再提交一次，**不再问指纹**（走 `.state.json`）

### 8. 边界情况（可选，但能证明限制是真的）

- [ ] 把 Server URL 改成 `http://` 的公网地址 → 报「must use HTTPS」
- [ ] 把 User ID 改成一个乱写的字符串 → 报 UUID 格式错
- [ ] 换个没权限的 key 文件 → 报「Could not unlock the selected GPG private key」
- [ ] 如果账号开了 MFA → 报「requires MFA (…), which this widget does not support yet.」这是已知限制，不是 bug
- [ ] 共享条目如果没读 metadata key 的权限 → 该条被计入 skipped，其它条目照常

### 9. 卸载

- [ ] 列表里 hover 该 widget → 删除按钮 → 确认
- [ ] `<data dir>/widgets/passbolt-search` 消失

---

## B. 离线 mock（不需要服务器）

```sh
node scripts/passbolt-mock-and-run.js
```

- [ ] 输出 `PASS: connect -> trust -> search -> details -> openSsh -> lock`
- [ ] 脚本结束时删掉了自己生成的 `.state.json`（所以文件夹还能正常导入）

它起一个 127.0.0.1 的假服务器、现场生成一次性密钥，覆盖 connect（指纹信任）、search（Passbolt 5 的 `user_key` 加密元数据）、details、openSsh、lock。**不能**证明你服务器的 shared_key 条目、真实 MFA 行为或网络策略。

---

## 故障对照表

| 看到的提示 | 大概率原因 |
| --- | --- |
| `The Passbolt server URL must use HTTPS` | 用了 http 且不是 localhost |
| `Add your Passbolt user ID (UUID) …` | UUID 没填/填错（注意要带连字符） |
| `did not return a JSON response` | URL 指到了网页而不是 API，或被反代拦截 |
| `did not return a JWT login challenge` | 服务器没启用 JWT 插件 |
| `This Passbolt account requires MFA` | 账号开了 MFA，当前不支持 |
| `The selected file is not a readable OpenPGP private key` | 导出的是公钥，或文件是 keygrip/二进制格式不对 |
| `Could not unlock the selected GPG private key` | 口令错，或这个 key 不是服务器上那把的私钥 |
| `The Passbolt server key fingerprint changed` | 服务器换过 key / 中间人；先确认服务器再删 `.state.json` |
| 搜索结果 `skipped K` 且 K=全部 | 你的 key 与账号不匹配，或账号在等 key 更新（Passbolt 里完成 setup） |
| `Does the widget list show a red error` | `package.json` 不合规（id 与目录名不一致、entry 不存在、JSON 语法错） |

---

# English

Two ways to verify: **A. real account** (recommended — it also proves your server config) and **B. offline mock** (no server; proves the client logic only). Work through it top to bottom; the troubleshooting table at the end tells you where you stopped.

Never paste keys, passphrases or decrypted passwords into an issue or screenshot.

## Supported — the short path

Real accounts work: login is Passbolt's JWT challenge (`POST /auth/jwt/login.json`, signed with your
private key and verified against the server key), i.e. the same flow the web UI uses — no browser, no MFA.

Four things, all required:

1. **The JWT authentication plugin is enabled** — default on Passbolt 5.x; `curl -s https://<server>/auth/verify.json` returning JSON means the API is up
2. **Your user UUID** — web UI: Users / Manage Users & Groups → yourself → `/app/users/view/<UUID>`
3. **Your current private key** — `gpg --export-secret-keys --armor <you@example.com> > /tmp/me.asc`, or "Download my key" in Passbolt
4. **The key passphrase** — only if that key has one

Then: Import → fill Server URL / User ID / key file / passphrase (leave Search empty) → **Connect / search**
→ compare the server fingerprint out of band on first connect → **Trust this key and connect** → fill Search
and submit → row buttons **Details** / **SSH**.

**MFA accounts are not supported** (the login fails with an explicit `requires MFA` message). The tick-list is section A below.

## Built in: a local Passbolt

If you would rather not experiment against a production instance, this repo can bring up a throwaway one.

```sh
./scripts/passbolt-start.sh     # mariadb + passbolt CE on http://localhost:8088
./scripts/passbolt-init.sh      # create a login-capable test account, print the widget values
./scripts/passbolt-stop.sh      # stop, keep data; --purge removes containers and volumes
```

`passbolt-init.sh` prints **Server URL / User ID / GPG key file / Passphrase / server fingerprint** and
leaves the private key at `scripts/.passbolt/me.asc`. Paste those in, then compare the fingerprint the widget
shows on the first Connect with the printed one before trusting — that comparison is the point of the design.

Why not "register, then set a passphrase in the browser": Passbolt 5's setup page requires the Passbolt
browser extension and otherwise only says "Please install the browser extension" (the Unsafe mode link is
just documentation). So the default seeds the account into the database — the same `users` / `profiles` /
`gpgkeys` rows a finished setup would leave. It logs in through the normal JWT challenge, it just never
consumed a setup token. For the real page: `./scripts/passbolt-init.sh --browser` (install the extension first).

- The server is plain **http** on localhost — fine for the widget (the extension rule does not apply)
- Do not enable **MFA** on this account; the widget has no TOTP prompt, which is exactly what step A.8 checks
- The account ships with eight sample entries (below), so you do not need the web UI to get data; `--no-samples` leaves them out
- Behind a blocked Docker Hub: `PASSBOLT_REGISTRY_MIRROR=docker.1panel.live ./scripts/passbolt-start.sh`

The whole path was exercised against **Passbolt CE 5.17.0**: connect → fingerprint → trust → search → lock.

Start over with `./scripts/passbolt-stop.sh --purge && ./scripts/passbolt-init.sh`.

## Sample entries (seeded by init)

| Entry | Resource type | What it exercises |
| --- | --- | --- |
| Jenkins API token | Simple password (v4) | no username, no URI — the empty-column path |
| Example website | Password with description (v4) | the ordinary case, https |
| Router SSH | Password with description (v4) | `ssh://root@10.0.0.12:2222` — the **SSH** button must pick up the port |
| Deploy FTP | Password with description (v4) | `ftp://deploy@files.example.com:2121` — the **FTP** button |
| VPN gateway | Password, description and TOTP (v4) | v4 keeps the TOTP as a JSON **string** |
| v5 default entry | v5 default | encrypted metadata (user_key), secret is `{object_type, data}` |
| v5 with TOTP | v5 with TOTP | v5 keeps the TOTP as an **object** |
| v5 note | v5 note | no password, no username, description only |

All of them are encrypted to the account's own key and signed with it (rows in `users` / `resources` / `secrets` / `secret_revisions` / `permissions`, permission type 15) — the same thing the web UI would write. Re-running `init` deletes those eight fixed ids first, so they do not pile up.

Walk through them: Search should say "Scanned 8 entries, decrypted 8", every **Details** must produce a password (the v5 ones used to fail with `V4 related fields are not supported for V5`), both TOTP entries show `TOTP secret` + `TOTP settings`, the v5 note shows only a description, and **SSH** on Router SSH opens `10.0.0.12:2222`.

## A. Real Passbolt account

### 0. Before you start

- [ ] an electerm build with user-widget support (before release: `npm run compile && cp -r src/app/. work/app/ && npm run t` in the electerm repo)
- [ ] your account works in the web UI
- [ ] the server has the **JWT authentication plugin** enabled (default in Passbolt 5.x; old self-hosted installs may not)
- [ ] you know your **user UUID**: Users / Manage Users & Groups → yourself → `/app/users/view/<UUID>`
- [ ] at least one entry with a **URI** and a **password**

### 1. Export the key

```sh
gpg --list-secret-keys --keyid-format long
gpg --export-secret-keys --armor <email or key id> > /tmp/me.asc
```

- [ ] the file starts with `-----BEGIN PGP PRIVATE KEY BLOCK-----`
- [ ] you know whether it has a passphrase
- [ ] it is the **current** key for that account ("Download my key" in Passbolt settings is the safe source)

### 2. Import

- [ ] Settings → Widgets → Import, paste `electerm/electerm-widget-passbolt-search` (or pick this repo root after a local clone)
- [ ] **Passbolt Search** appears; selecting it shows a generated form (no iframe, no HTML)
- [ ] no red error block (if there is one, see the table)

### 3. First submit (trust the server key)

Fill Server URL, User ID, GPG key file, passphrase; leave Search empty → **Connect / search**.

- [ ] a warning block shows **Server key** as a grouped fingerprint
- [ ] it matches what your administrator published / what `<server>/auth/verify.json` returns
- [ ] **Trust this key and connect** → green "Connected to …" with both **Server key** and **Your key**
- [ ] `.state.json` appears next to `main.js`, containing only `trustedFingerprint`

### 4. Search

- [ ] enter a keyword you know exists in the web UI → submit
- [ ] a table appears: Name / Username / URI / Type, same rows as the web UI
- [ ] the message reads `Scanned N entries, decrypted N. M match(es).`
- [ ] `skipped K` means K entries could not be decrypted or had an untrusted signature

### 5. Details

- [ ] **Details** shows the password masked; the eye reveals it, copy puts it on the clipboard
- [ ] username and URI match the web UI; custom fields are listed after them

### 6. Open a connection

- [ ] **SSH** opens a tab titled with the entry name, username/password prefilled
- [ ] the connection does **not** appear in connection history (`from: widget:passbolt-search`)
- [ ] FTP / Telnet / RDP behave the same (port from the URI, else 22/21/23/3389)

### 7. Lock and persistence

- [ ] **Lock and disconnect** reports that tokens and keys were cleared
- [ ] pressing Details again says "session is closed. Connect again."
- [ ] reopening the panel restores the non-password fields; **passphrase is empty**
- [ ] after an app restart, submitting again does **not** ask for the fingerprint

### 8. Edge cases (optional, they prove the limits are real)

- [ ] `http://` on a public host → "must use HTTPS"
- [ ] a malformed User ID → UUID format error
- [ ] an unrelated key file → "Could not unlock the selected GPG private key"
- [ ] an MFA account → "requires MFA (…), which this widget does not support yet." (known limit)
- [ ] a shared entry without metadata key access → counted as skipped, the rest still works

### 9. Uninstall

- [ ] hover the widget in the list → delete → confirm
- [ ] `<data dir>/widgets/passbolt-search` is gone

## B. Offline mock

```sh
node scripts/passbolt-mock-and-run.js
```

- [ ] prints `PASS: connect -> trust -> search -> details -> openSsh -> lock`
- [ ] removes the `.state.json` it created, so the folder stays importable

It starts a throwaway server on 127.0.0.1 with throwaway keys and covers connect (fingerprint trust), search (Passbolt 5 `user_key` encrypted metadata), details, openSsh and lock. It does **not** prove shared_key entries, real MFA behaviour or your network setup.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| `The Passbolt server URL must use HTTPS` | plain http on a non-localhost host |
| `Add your Passbolt user ID (UUID) …` | UUID missing or malformed (hyphens required) |
| `did not return a JSON response` | the URL points at the web page, or a proxy intercepted the API |
| `did not return a JWT login challenge` | JWT plugin disabled on the server |
| `This Passbolt account requires MFA` | MFA account; not supported yet |
| `The selected file is not a readable OpenPGP private key` | you exported the public key, or the file is not a key |
| `Could not unlock the selected GPG private key` | wrong passphrase, or the key is not the one on the server |
| `The Passbolt server key fingerprint changed` | the server key changed (or MITM); verify the server, then delete `.state.json` |
| every entry `skipped` | your key does not match the account, or the account is awaiting setup |
| red error block in the widget list | invalid `package.json` (id ≠ folder name, missing entry, JSON syntax) |
