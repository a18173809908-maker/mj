<?php
/**
 * 往来账 · 云端后端 自检页
 * 浏览器直接打开： https://你的域名/api/setup.php
 * 作用：检查环境是否正常、data 目录有没有被外网直接下载。
 */
require __DIR__ . '/lib.php';

ensure_dirs();

$phpOk      = version_compare(PHP_VERSION, '7.2.0', '>=');
$hashOk     = function_exists('hash_pbkdf2') && in_array('sha256', hash_algos(), true);
$jsonOk     = function_exists('json_encode');
$dirOk      = is_writable(data_dir());
$hasPw      = password_exists();
$cur        = ledger_read();

/* ---- data 目录暴露自检 ---- */
$probeName = 'probe-' . bin2hex(random_bytes(6)) . '.txt';
$probePath = data_dir() . '/' . $probeName;
$probeToken = 'LEDGER_PROBE_' . bin2hex(random_bytes(8));
$exposed = null;
$probeMsg = '';
if (@file_put_contents($probePath, $probeToken) !== false) {
  $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
  $host   = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
  $url    = $scheme . '://' . $host . rtrim(dirname($_SERVER['SCRIPT_NAME']), '/') . '/data/' . $probeName;
  if ($host === '') {
    $probeMsg = '无法判断访问地址，跳过自检';
  } elseif (!ini_get('allow_url_fopen')) {
    $probeMsg = '服务器关闭了 allow_url_fopen，无法自动自检';
  } else {
    $ctx = stream_context_create(array('http' => array('timeout' => 6, 'ignore_errors' => true, 'header' => "User-Agent: ledger-selfcheck\r\n")));
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
      $exposed = false;
      $probeMsg = '请求探测文件失败（可能被安全策略拦截，通常说明是安全的）';
    } elseif (strpos($body, $probeToken) !== false) {
      $exposed = true;
      $probeMsg = '探测文件可以被外网直接下载！';
    } else {
      $exposed = false;
      $probeMsg = 'HTTP ' . (isset($http_response_header[0]) ? $http_response_header[0] : '') . ' 未返回文件内容，视为已保护';
    }
  }
  @unlink($probePath);
} else {
  $probeMsg = '无法写入探测文件（目录不可写）';
}

/* ---- 当前数据统计 ---- */
$counts = $cur ? counts_of($cur['data']) : array('customers' => 0, 'txs' => 0, 'incomes' => 0);

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function row($label, $okState, $detail) {
  $cls = $okState === true ? 'ok' : ($okState === false ? 'bad' : 'warn');
  $mark = $okState === true ? '✓' : ($okState === false ? '✗' : '!');
  echo '<div class="row ' . $cls . '"><span class="mk">' . $mark . '</span><span class="lb">' . h($label) . '</span><span class="dt">' . $detail . '</span></div>';
}
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>云端后端自检 · 往来账</title>
<style>
  :root{--ink:#1c2b25;--ink2:#5a6b64;--line:#e2e6e3;--bg:#f6f8f6;--card:#fff;--brand:#0F4C3A;--red:#c0392b;--amber:#b7791f;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--ink2);font-size:13px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 16px;margin-bottom:14px}
  .card h2{font-size:14px;margin:14px 0 6px;color:var(--ink2);font-weight:600}
  .row{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px dashed var(--line)}
  .row:last-child{border-bottom:0}
  .mk{width:18px;text-align:center;font-weight:700;flex:none}
  .row.ok .mk{color:#1e8e5a}.row.bad .mk{color:var(--red)}.row.warn .mk{color:var(--amber)}
  .lb{flex:none;width:150px;color:var(--ink)}
  .dt{color:var(--ink2);font-size:13px;flex:1;word-break:break-all}
  .big{font-size:16px;font-weight:700;color:var(--brand)}
  pre{background:#f2f5f2;border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto;font-size:13px;margin:8px 0}
  .alert{border-left:4px solid var(--red);background:#fdf2f0;padding:12px 14px;border-radius:8px;margin:12px 0;font-size:14px}
  .alert.good{border-color:#1e8e5a;background:#f0f8f4}
  .alert.amber{border-color:var(--amber);background:#fdf8ee}
  a.btn{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;margin-top:6px}
  code{background:#eef2ef;padding:1px 5px;border-radius:4px;font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <h1>云端后端自检</h1>
  <div class="sub">往来账 · 麻将馆记账 &nbsp;|&nbsp; 后端版本 <?= h(LEDGER_API_VERSION) ?></div>

  <div class="card">
    <h2>环境</h2>
    <?php
      row('PHP 版本', $phpOk, h(PHP_VERSION) . ($phpOk ? '（可用）' : '（需要 7.2 或更高，请在宝塔里换 PHP 版本）'));
      row('hash / PBKDF2', $hashOk, $hashOk ? '可用，密码可安全加密' : '不可用（PHP 异常，请重装 PHP）');
      row('JSON 扩展', $jsonOk, $jsonOk ? '可用' : '不可用（PHP 异常）');
      row('api/data 可写', $dirOk, $dirOk ? '可写' : '不可写！宝塔 → 文件 → 选中 api/data → 权限设为 755、属主 www');
    ?>
  </div>

  <div class="card">
    <h2>数据目录保护（重要）</h2>
    <?php
      if ($exposed === true) {
        row('能否被外网直接下载', false, h($probeMsg));
      } elseif ($exposed === false) {
        row('能否被外网直接下载', true, h($probeMsg));
      } else {
        row('能否被外网直接下载', 'warn', h($probeMsg));
      }
    ?>
    <?php if ($exposed === true): ?>
    <div class="alert">
      <b>必须处理：</b>别人可以直接下载你的账本文件。<br>
      宝塔 → 网站 → 本站 → 设置 → <b>伪静态</b> → 把下面这一行粘进去，保存即可（粘完刷新本页复查）：
      <pre>location ^~ /api/data/ { deny all; return 404; }</pre>
    </div>
    <?php elseif ($exposed === false): ?>
    <div class="alert good"><b>✔ 安全。</b>账本文件无法被浏览器直接下载，只能通过接口读写。</div>
    <?php else: ?>
    <div class="alert amber">未能自动判断。建议顺手把这一行加进宝塔「伪静态」，确保万无一失：
      <pre>location ^~ /api/data/ { deny all; return 404; }</pre>
    </div>
    <?php endif; ?>
  </div>

  <div class="card">
    <h2>账本状态</h2>
    <?php
      row('是否已设云端密码', $hasPw, $hasPw ? '已设置' : '还没设置 —— 打开 App 会让你设');
      row('云端版本号', $cur ? true : 'warn', $cur ? ('v' . (int)$cur['rev'] . ' · ' . h($cur['savedAt'])) : '云端还没有数据');
      row('云端内容', true,
        '客户 <b>' . (int)$counts['customers'] . '</b> 位 · 牌局 <b>' . (int)$counts['incomes'] . '</b> 场 · 流水 <b>' . (int)$counts['txs'] . '</b> 条');
      $histN = count(glob(hist_dir() . '/r*.json') ?: array());
      $dailyN = count(glob(daily_dir() . '/*.json') ?: array());
      row('历史快照', true, '滚动版本 ' . $histN . ' 个 · 每日备份 ' . $dailyN . ' 个');
    ?>
  </div>

  <div class="card">
    <h2>下一步</h2>
    <div class="dt" style="padding:6px 0 12px">
      回到 App 首页，第一次会让你设置「进入密码」——这个密码同时就是云端密码，设完账本会自动同步上来。
      <br>另一台手机用<b>同一个密码</b>登录即可看到同一本账。
    </div>
    <a class="btn" href="../">打开往来账</a>
  </div>

  <div class="sub" style="margin-top:16px">
    本页只是自检工具，可以随时删除（<code>api/setup.php</code>），不影响使用。
  </div>
</div>
</body>
</html>
