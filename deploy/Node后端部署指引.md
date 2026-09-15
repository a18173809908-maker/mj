# 往来账 · 云端备份后端 —— Node 版部署指引

> 服务器：`119.23.45.149`（阿里云 ECS）· 宝塔面板 · 站点 `https://mj.aiboxpro.cn`
> 后端：**Node.js 纯内置模块，零依赖，不需要装 PHP，不需要改站点类型，不需要数据库**
> 账本以 JSON 文件形式存在后端自己的 `data/` 目录里

---

## 为什么换 Node 版

你服务器上本来就在跑 Node（`aiboxpro` 就是 Next.js 项目），环境是现成的。
原来的 PHP 方案卡在宝塔那句「当前 PHP版本不兼容此功能」——要么服务器没装 PHP，
要么站点被建成了「静态站点」类型改不了 PHP。**Node 版完全绕开这件事**：
站点继续当纯静态用，只把 `/api/` 这一段转给 Node 进程。

前端一行都没改，接口一个字段都没变——同一套 116 项测试在 PHP 版和 Node 版上跑出的结果一致。

---

## 一、装 Node（如果服务器还没装）

宝塔 → **软件商店** → 搜 `PM2` 或 `Node` → 装任意一个：

- **PM2管理器**（推荐）：装它顺便就把 Node 装好了，还能直接管进程、开机自启
- 或 **Node.js版本管理器**：装 Node 16 以上（推荐 18 / 20 LTS）

装完在面板里确认 Node 版本 **≥ 16**（命令：`node -v`）。

---

## 二、上传并启动后端

1. 把 **`ledger-api-node-v2.0.zip`** 上传到服务器，解压到你要放的位置，例如：

   ```
   /www/wwwroot/ledger-api-node/
   ```

   解压后这个目录里应该是：

   ```
   ledger-api-node/
     server.js            后端主程序
     lib.js               公共库
     package.json
     ecosystem.config.js  PM2 配置
     README.txt           贴身说明（服务器上也能看）
   ```

   > 这个目录**不要**放进网站的 `root` 里，放在 `/www/wwwroot/` 下面平级位置就行。

2. 启动（二选一）：

   **用 PM2（推荐，崩了自动拉起、开机自启）**

   ```bash
   cd /www/wwwroot/ledger-api-node
   pm2 start ecosystem.config.js
   pm2 save
   ```

   如果要用宝塔面板的 **PM2管理器** 那个界面：项目目录选上面这个路径，
   启动文件选 `server.js`，端口填 `8787`，然后点启动。

   **临时试跑（关掉终端就停，只用来验证）**

   ```bash
   cd /www/wwwroot/ledger-api-node
   node server.js
   ```

3. 验证后端活着：

   ```bash
   curl http://127.0.0.1:8787/api/index.php?a=ping
   ```

   应该返回一串 JSON，里面有 `"ok":true`。

---

## 三、让网站找到后端（nginx 反向代理）

宝塔 → **网站** → `mj.aiboxpro.cn` → **设置**。两条路选一条：

### 路子 A：直接改配置文件（推荐，最直观）

**设置 → 配置文件**，在 `server { ... }` 里面加这段：

```nginx
location ^~ /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

保存（宝塔会自动重载 nginx）。

### 路子 B：用宝塔的反向代理功能

**设置 → 反向代理 → 添加反向代理**：

| 填什么 | 值 |
| --- | --- |
| 代理名称 | 随便，比如 `ledger-api` |
| 代理目录 | `/api` |
| 目标 URL | `http://127.0.0.1:8787` |
| 发送域名 | `$host` |

保存即可。

> **关键点**：一定让 **整个 `/api/`** 都转给 Node，不要只转 `/api/index.php`。
> 因为 `/api/data/` 里是账本文件，整段转走之后浏览器就再也够不到它们了——
> 这是最省事的保护方式（比 PHP 版还干净，PHP 版还得额外加一条伪静态挡文件）。

---

## 四、更新前端

1. 上传 **`ledger-site-v2.0.zip`** 到站点根目录
2. 解压 → 进入 `ledger/` → **全选剪切** → 回站点根目录**粘贴覆盖**

（和以前一样的老流程。这个包现在**只含前端**，后端是单独的包。）

> 如果你之前已经把 PHP 版后端的 `api/` 目录传到了站点根目录，**现在可以删掉它**——
> `/api/` 已经整段转给 Node 了，那些 PHP 文件永远不会被用到，留着只是碍事。

---

## 五、自检（务必看一眼）

浏览器打开：

```
https://mj.aiboxpro.cn/api/setup.php
```

页面会逐项告诉你：

- **Node 版本** —— 够不够
- **数据目录可写** —— 能不能记账
- **能否被外网直接下载** —— ← **只需要盯这一项**，必须是绿 ✔
- 账本状态（已设密码没、当前版本号、几条流水、几个历史快照）

如果「能否被外网直接下载」是红 ✗，说明 nginx 只转了一部分 `/api`，
按上一节把整段 `/api/` 转过去，保存后刷新本页复查。

---

## 六、回 App 设密码

手机打开 `https://mj.aiboxpro.cn`：

1. 第一次会让你设「进入密码」——**这个密码同时就是云端密码**，设一个记得住的
2. 设完账本会自动同步上来
3. 另一台手机用**同一个密码**登录，就能看到同一本账

「我的」页多了一块**云端备份**：

| 功能 | 说明 |
| --- | --- |
| 立即同步 | 手动推一次，平时是记完账 4 秒自动同步 |
| 云端版本历史 | 列出版本，可**下载**某个版本、可**回滚**到某个版本 |
| 下载备份 | 把云端当前账本存成 JSON 文件 |
| 重新连接 | 断了之后手动重连 |

---

## 七、日常维护

```bash
pm2 list                    # 看状态
pm2 logs ledger-api         # 看日志（排错先看这里）
pm2 restart ledger-api      # 重启
pm2 stop ledger-api         # 停止
```

**备份**：整个 `data/` 目录下载走就是完整备份，包含账本、密码、全部历史版本。

```
data/ledger.json      当前账本（最关键）
data/auth.json        云端密码（哈希，不是明文）
data/conf.json        签名密钥（删了所有人都要重新登录）
data/history/         每次同步的历史版本（滚动保留 60 个）
data/daily/           每天第一个版本（保留 90 天）
```

**换服务器 / 迁移**：把 `data/` 目录整个拷到新机器同位置，重启服务，密码和账本都还在，手机端什么都不用改。

---

## 八、常见问题

**Q：后端起不来，`pm2 logs` 里报端口占用？**
换个端口：改 `ecosystem.config.js` 里的 `PORT`（比如 8788），`pm2 restart ledger-api`，
同时把 nginx 里 `proxy_pass` 的端口一起改掉。

**Q：手机打开显示「暂时连不上云端」？**
说明 nginx 那段没配好或后端没起来。先在服务器上 `curl http://127.0.0.1:8787/api/index.php?a=ping`，
有返回就是 nginx 的问题，没返回就是后端的问题。

**Q：忘了云端密码怎么办？**
删掉 `/www/wwwroot/ledger-api-node/data/auth.json`，重启服务，
回 App 重新设一个（**账本不会丢**，只是要重新设密码；注意旧手机要重新登录）。

**Q：账本数据在哪？会丢吗？**
在 `data/ledger.json`。本机和云端各存一份，手机清了缓存云端还有；
云端挂了本机照常记账，恢复后自动补传。两边都改过会弹窗让你选，**绝不会自动覆盖**。

**Q：会不会被脱库？**
密码是 PBKDF2-SHA256 加盐 2 万轮，不存明文；令牌是 HMAC 签名、不落盘、90 天过期；
连错 8 次锁 IP 10 分钟；整个 `/api/data/` 在 nginx 层就被拦掉了，外网下不到。

---

## 附：接口清单（前后端约定，两端一致）

| 动作 | 需登录 | 说明 |
| --- | --- | --- |
| `ping` | | 探活 / 看云端状态 |
| `setup` | | 首次初始化密码 |
| `login` | | 登录拿令牌 |
| `pull` | ★ | 拉取云端账本 |
| `push` | ★ | 上传（带 `baseRev` 冲突检测） |
| `history` | ★ | 版本历史列表 |
| `daily` | ★ | 每日备份列表 |
| `restore` | ★ | 回滚到某个版本 |
| `download` | ★ | 下载某版本为可导入备份 |
| `changepw` | ★ | 改密码（旧令牌全失效） |
| `revoke` | ★ | 所有设备下线 |

调用方式：`https://mj.aiboxpro.cn/api/index.php?a=动作`
鉴权：`Authorization: Bearer <token>`（拿不到时可用 `&t=<token>` 兜底）
