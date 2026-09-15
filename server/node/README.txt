往来账 · 云端备份后端（Node 版）
================================

零依赖：不用 npm install，不用装 PHP，不用建数据库。
账本就是一个 JSON 文件，存在 data/ 目录里。

--------------------------------------------------
一、目录里都有什么
--------------------------------------------------
  server.js            后端主程序（HTTP 服务 + 所有接口）
  lib.js               公共库（密码、令牌、账本读写）
  package.json         包描述（只用来看，不影响运行）
  ecosystem.config.js  PM2 配置（常驻 + 开机自启）
  data/                账本数据（首次运行自动创建，别删）

--------------------------------------------------
二、怎么跑起来（在宝塔上）
--------------------------------------------------
1) 装 Node：宝塔 → 软件商店 → 搜 Node.js版本管理器（或 PM2管理器）→ 装 Node 16 以上

2) 把这个文件夹上传到服务器，例如：
      /www/wwwroot/ledger-api-node/

3) 用 PM2 启动（推荐）：
      cd /www/wwwroot/ledger-api-node
      pm2 start ecosystem.config.js
      pm2 save                 保存，重开机自动拉起

   临时试跑（关掉终端就停）：
      cd /www/wwwroot/ledger-api-node
      node server.js

4) 确认起来了：
      curl http://127.0.0.1:8787/api/index.php?a=ping

--------------------------------------------------
三、让网站能找到它（nginx 反向代理）
--------------------------------------------------
宝塔 → 网站 → 你的站点 → 设置 → 配置文件，在 server { } 里加：

    location ^~ /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

保存后重载 nginx。注意是整段 /api/ 都转过去（不要只转 /api/index.php），
这样 data 目录才不会被人直接下载。

--------------------------------------------------
四、自检
--------------------------------------------------
浏览器打开： https://你的域名/api/setup.php

页面会逐项告诉你：Node 版本、数据目录能不能写、
账本文件能不能被外网直接下载、当前账本状态。

--------------------------------------------------
五、常用命令
--------------------------------------------------
  pm2 list                    看运行状态
  pm2 logs ledger-api         看日志
  pm2 restart ledger-api      重启
  pm2 stop ledger-api         停止

--------------------------------------------------
六、备份与迁移
--------------------------------------------------
账本就在 data/ 目录里：

  data/ledger.json            当前账本（最重要的是这个）
  data/auth.json              云端密码（哈希，不是明文）
  data/conf.json              签名密钥（删了所有人要重新登录）
  data/history/               每次同步的历史版本（滚动保留 60 个）
  data/daily/                 每天第一个版本（保留 90 天）

整包备份：把整个 data/ 目录下载走即可。
换服务器：把 data/ 目录拷到新机器的同位置，重启服务，密码和数据都在。

注意：data/ 里是明文账本（没加密存储），别放到能被公开下载的地方。

--------------------------------------------------
七、环境变量（可选）
--------------------------------------------------
  PORT             监听端口，默认 8787
  HOST             监听地址，默认 127.0.0.1（只给本机 nginx 用，安全）
  LEDGER_DATA_DIR  数据目录，默认本文件同级的 data/

改端口就在 ecosystem.config.js 的 env 里改，然后 pm2 restart ledger-api。
