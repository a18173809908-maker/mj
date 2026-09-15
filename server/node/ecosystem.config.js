/**
 * PM2 配置 —— 让云端后端常驻、开机自启、崩了自动拉起
 *
 * 用法（在本文件所在目录）：
 *   pm2 start ecosystem.config.js
 *   pm2 save                保存进程列表（配合 pm2 startup 实现开机自启）
 *
 * 注意 instances 固定为 1：本服务用同步文件读写保证原子性，单实例最稳。
 * 真要开多实例，代码里的跨进程锁文件也能兜住，但没必要。
 */
module.exports = {
  apps: [
    {
      name: 'ledger-api',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        HOST: '127.0.0.1'
      }
    }
  ]
};
