<?php
/**
 * 往来账 · 云端备份后端 —— 公共库
 *
 * 设计要点：
 *  - 零数据库依赖：账本以 JSON 文件存放在 api/data/，原子写(临时文件+rename) + flock 排他锁
 *  - 密码：PBKDF2-SHA256，2 万轮，随机盐，只存哈希（hash 扩展是 PHP 内置，无需额外安装）
 *  - 令牌：无状态 HMAC-SHA256 签名（不落盘、不依赖 session），默认 90 天有效
 *  - 版本历史：每次上传都留一份快照，可回滚；另有每日首个版本长期保留
 *  - 兼容 PHP 7.2 ~ 8.3（不使用 7.4+ 的语法糖）
 */

define('LEDGER_API_VERSION', '1.0.0');
define('LEDGER_MAX_HISTORY', 60);     // 滚动保留最近 N 个版本
define('LEDGER_MAX_DAILY', 90);       // 每日首个版本保留 N 天
define('LEDGER_PW_ITER', 20000);
define('LEDGER_TOKEN_DAYS', 90);
define('LEDGER_MAX_FAIL', 8);         // 连续错 N 次
define('LEDGER_FAIL_WAIT', 600);      // 锁 N 秒

/* ---------------- 路径 ---------------- */

function data_dir()  { return __DIR__ . '/data'; }
function ledger_file() { return data_dir() . '/ledger.json'; }
function auth_file()   { return data_dir() . '/auth.json'; }
function conf_file()   { return data_dir() . '/conf.json'; }
function hist_dir()    { return data_dir() . '/history'; }
function daily_dir()   { return data_dir() . '/daily'; }

function ensure_dirs() {
  $dirs = array(data_dir(), hist_dir(), daily_dir());
  foreach ($dirs as $d) {
    if (!is_dir($d)) {
      @mkdir($d, 0755, true);
    }
  }
  // Apache 下的兜底保护（宝塔用 nginx，另有伪静态规则兜底，setup 页会自检并提示）
  $ht = data_dir() . '/.htaccess';
  if (!file_exists($ht)) {
    @file_put_contents($ht,
      "Require all denied\n" .
      "Deny from all\n" .
      "<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule .* - [F,L]\n</IfModule>\n");
  }
  $idx = data_dir() . '/index.html';
  if (!file_exists($idx)) { @file_put_contents($idx, ''); }
}

/* ---------------- 输出 ---------------- */

function jout($arr, $code = 200) {
  if (!headers_sent()) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
  }
  echo json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function ok($extra) {
  $base = array('ok' => true, 'api' => LEDGER_API_VERSION, 'serverTime' => date('c'));
  jout(is_array($extra) ? array_merge($base, $extra) : $base, 200);
}

function fail($msg, $code = 400, $extra = array()) {
  jout(array_merge(array('ok' => false, 'error' => $msg), $extra), $code);
}

function body_json() {
  $raw = @file_get_contents('php://input');
  if ($raw === false || $raw === '') { return array(); }
  $d = json_decode($raw, true);
  return is_array($d) ? $d : array();
}

function param($k, $def = '') {
  return isset($_GET[$k]) ? (string)$_GET[$k] : $def;
}

/* ---------------- 文件读写（加锁 + 原子） ---------------- */

function with_lock($fn) {
  ensure_dirs();
  $lf = data_dir() . '/.lock';
  $fp = @fopen($lf, 'c');
  if (!$fp) { fail('服务器数据目录不可写，请检查 api/data 权限（宝塔里设为 755 且属主 www）', 500); }
  if (!flock($fp, LOCK_EX)) { fclose($fp); fail('获取文件锁失败，请稍后重试', 500); }
  try {
    return $fn();
  } finally {
    @flock($fp, LOCK_UN);
    @fclose($fp);
  }
}

function jread($path) {
  if (!is_file($path)) { return null; }
  $raw = @file_get_contents($path);
  if ($raw === false || $raw === '') { return null; }
  $d = json_decode($raw, true);
  return is_array($d) ? $d : null;
}

function jwrite($path, $data) {
  $tmp = $path . '.tmp.' . getmypid();
  $raw = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  if ($raw === false) { fail('数据序列化失败', 500); }
  if (@file_put_contents($tmp, $raw) === false) { fail('写入失败，请检查 api/data 目录权限', 500); }
  @chmod($tmp, 0644);
  if (!@rename($tmp, $path)) {
    @unlink($tmp);
    fail('落盘失败，请检查 api/data 目录权限', 500);
  }
  return strlen($raw);
}

/* ---------------- 站点配置（密钥） ---------------- */

function conf() {
  $c = jread(conf_file());
  if ($c && !empty($c['secret'])) { return $c; }
  return with_lock(function () {
    $c = jread(conf_file());
    if ($c && !empty($c['secret'])) { return $c; }
    $c = array('secret' => bin2hex(random_bytes(32)), 'createdAt' => date('c'), 'site' => '往来账');
    jwrite(conf_file(), $c);
    return $c;
  });
}

/* ---------------- 令牌 ---------------- */

function b64u($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64ud($s) { return base64_decode(strtr($s, '-_', '+/')); }

function token_make($days = null) {
  if ($days === null) { $days = LEDGER_TOKEN_DAYS; }
  $c = conf();
  $now = time();
  $payload = array('v' => 1, 'iat' => $now, 'exp' => $now + $days * 86400, 'jti' => bin2hex(random_bytes(8)));
  $p = b64u(json_encode($payload));
  $sig = b64u(hash_hmac('sha256', $p, $c['secret'], true));
  return array('token' => $p . '.' . $sig, 'expiresAt' => $payload['exp']);
}

function token_check($tok) {
  if (!$tok || strpos($tok, '.') === false) { return false; }
  $parts = explode('.', $tok, 2);
  $c = conf();
  $want = b64u(hash_hmac('sha256', $parts[0], $c['secret'], true));
  if (!hash_equals($want, $parts[1])) { return false; }
  $d = json_decode(b64ud($parts[0]), true);
  if (!is_array($d) || empty($d['exp']) || (int)$d['exp'] < time()) { return false; }
  return true;
}

function bearer() {
  $h = '';
  if (!empty($_SERVER['HTTP_AUTHORIZATION'])) { $h = $_SERVER['HTTP_AUTHORIZATION']; }
  elseif (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) { $h = $_SERVER['REDIRECT_HTTP_AUTHORIZATION']; }
  elseif (function_exists('getallheaders')) {
    $hs = getallheaders();
    if (is_array($hs)) {
      foreach ($hs as $k => $v) { if (strtolower($k) === 'authorization') { $h = $v; break; } }
    }
  }
  if (stripos($h, 'Bearer ') === 0) { return trim(substr($h, 7)); }
  // 兜底：部分环境（CGI / 部分 nginx 配置）拿不到 Authorization 头，允许用查询参数
  $t = param('t', '');
  return $t !== '' ? $t : null;
}

function require_auth() {
  if (!token_check(bearer())) {
    fail('未登录或登录状态已过期', 401, array('needLogin' => true));
  }
}

/* ---------------- 密码 ---------------- */

function password_set($pw, $hint) {
  $salt = bin2hex(random_bytes(16));
  $rec = array(
    'v' => 1,
    'alg' => 'pbkdf2-sha256',
    'iter' => LEDGER_PW_ITER,
    'salt' => $salt,
    'hash' => bin2hex(hash_pbkdf2('sha256', $pw, $salt, LEDGER_PW_ITER, 32, true)),
    'hint' => utf8_cut($hint, 60),
    'createdAt' => date('c'),
    'changedAt' => date('c')
  );
  jwrite(auth_file(), $rec);
  return $rec;
}

function password_check($pw) {
  $a = jread(auth_file());
  if (!$a || empty($a['hash']) || empty($a['salt'])) { return false; }
  $iter = isset($a['iter']) ? (int)$a['iter'] : LEDGER_PW_ITER;
  $calc = bin2hex(hash_pbkdf2('sha256', $pw, $a['salt'], $iter, 32, true));
  return hash_equals($a['hash'], $calc);
}

function password_exists() {
  $a = jread(auth_file());
  return $a && !empty($a['hash']);
}

/** 不依赖 mbstring 的 UTF-8 安全截断 */
function utf8_cut($s, $maxChars) {
  $s = (string)$s;
  if ($s === '') { return ''; }
  if (preg_match('/^.{0,' . (int)$maxChars . '}/us', $s, $m)) { return $m[0]; }
  return substr($s, 0, $maxChars);
}

/* ---------------- 防爆破 ---------------- */

function client_ip() {
  return isset($_SERVER['REMOTE_ADDR']) ? (string)$_SERVER['REMOTE_ADDR'] : '0.0.0.0';
}

function throttle_check() {
  $f = jread(data_dir() . '/fail.json');
  if (!$f) { return; }
  $k = client_ip();
  if (!empty($f[$k]['until']) && (int)$f[$k]['until'] > time()) {
    $min = (int)ceil(((int)$f[$k]['until'] - time()) / 60);
    fail('密码错误次数过多，请 ' . $min . ' 分钟后再试', 429, array('retryAfter' => (int)$f[$k]['until'] - time()));
  }
}

function throttle_bump() {
  return with_lock(function () {
    $f = jread(data_dir() . '/fail.json');
    if (!$f) { $f = array(); }
    $k = client_ip();
    $n = isset($f[$k]['n']) ? (int)$f[$k]['n'] : 0;
    $n++;
    $until = 0;
    if ($n >= LEDGER_MAX_FAIL) { $until = time() + LEDGER_FAIL_WAIT; }
    $f[$k] = array('n' => $n, 'until' => $until, 'at' => date('c'));
    $now = time();
    foreach ($f as $kk => $vv) {
      if ($kk !== $k && empty($vv['until']) && isset($vv['at']) && strtotime($vv['at']) < $now - 86400) { unset($f[$kk]); }
    }
    jwrite(data_dir() . '/fail.json', $f);
    return $n;
  });
}

/** 错了多少次（还没到锁定的计数） */
function throttle_count() {
  $f = jread(data_dir() . '/fail.json');
  if (!$f) { return 0; }
  $k = client_ip();
  return isset($f[$k]['n']) ? (int)$f[$k]['n'] : 0;
}

function throttle_clear() {
  with_lock(function () {
    $f = jread(data_dir() . '/fail.json');
    if (!$f) { return; }
    unset($f[client_ip()]);
    jwrite(data_dir() . '/fail.json', $f);
  });
}

/* ---------------- 账本 ---------------- */

function counts_of($data) {
  return array(
    'customers' => isset($data['customers']) && is_array($data['customers']) ? count($data['customers']) : 0,
    'txs' => isset($data['txs']) && is_array($data['txs']) ? count($data['txs']) : 0,
    'incomes' => isset($data['incomes']) && is_array($data['incomes']) ? count($data['incomes']) : 0
  );
}

function entry_public($e) {
  $d = isset($e['data']) ? $e['data'] : array();
  return array(
    'rev' => (int)$e['rev'],
    'savedAt' => isset($e['savedAt']) ? $e['savedAt'] : '',
    'ts' => isset($e['ts']) ? (int)$e['ts'] : 0,
    'device' => isset($e['device']) ? $e['device'] : '',
    'counts' => counts_of($d),
    'bytes' => isset($e['bytes']) ? (int)$e['bytes'] : 0
  );
}

function snapshot_write($entry) {
  ensure_dirs();
  $p = hist_dir() . '/r' . sprintf('%06d', (int)$entry['rev']) . '.json';
  jwrite($p, $entry);
}

function daily_write($entry) {
  ensure_dirs();
  $p = daily_dir() . '/' . date('Y-m-d') . '.json';
  if (!file_exists($p)) { jwrite($p, $entry); }
}

function snapshot_prune() {
  $keep = array();
  $files = glob(hist_dir() . '/r*.json');
  if (is_array($files) && count($files) > LEDGER_MAX_HISTORY) {
    sort($files);                                     // 文件名含递增 rev，字典序即版本序
    $drop = array_slice($files, 0, count($files) - LEDGER_MAX_HISTORY);
    foreach ($drop as $f) { @unlink($f); }
  }
  $dfiles = glob(daily_dir() . '/*.json');
  if (is_array($dfiles) && count($dfiles) > LEDGER_MAX_DAILY) {
    sort($dfiles);
    $drop = array_slice($dfiles, 0, count($dfiles) - LEDGER_MAX_DAILY);
    foreach ($drop as $f) { @unlink($f); }
  }
}

function ledger_read() {
  $e = jread(ledger_file());
  if (!$e || !isset($e['data'])) { return null; }
  return $e;
}

/**
 * 提交新版本
 * $baseRev = -1 表示不做冲突校验（强制覆盖）
 * 返回 array('conflict'=>true,...) 或 新的 entry
 */
function ledger_commit($data, $device, $baseRev) {
  return with_lock(function () use ($data, $device, $baseRev) {
    $cur = ledger_read();
    $rev = $cur ? (int)$cur['rev'] : 0;
    if ($baseRev >= 0 && $baseRev !== $rev) {
      return array(
        'conflict' => true,
        'rev' => $rev,
        'savedAt' => $cur ? $cur['savedAt'] : null,
        'device' => $cur ? $cur['device'] : '',
        'counts' => $cur ? counts_of($cur['data']) : array('customers' => 0, 'txs' => 0, 'incomes' => 0)
      );
    }
    $entry = array(
      'rev' => $rev + 1,
      'savedAt' => date('c'),
      'ts' => time(),
      'device' => utf8_cut($device, 40),
      'counts' => counts_of($data),
      'data' => $data
    );
    $bytes = jwrite(ledger_file(), $entry);
    $entry['bytes'] = $bytes;
    snapshot_write($entry);
    daily_write($entry);
    snapshot_prune();
    return $entry;
  });
}

/** 取某个历史版本的 entry（rev 为空则取当前） */
function ledger_version($rev) {
  if ($rev === null || $rev === '' || $rev === 'current') { return ledger_read(); }
  $r = (int)$rev;
  $e = jread(hist_dir() . '/r' . sprintf('%06d', $r) . '.json');
  if ($e && isset($e['data'])) { return $e; }
  $d = jread(daily_dir() . '/' . $rev . '.json');
  if ($d && isset($d['data'])) { return $d; }
  return null;
}

function history_list() {
  $out = array();
  $cur = ledger_read();
  if ($cur) { $out[] = entry_public($cur); }
  $files = glob(hist_dir() . '/r*.json');
  if (is_array($files)) {
    rsort($files);
    foreach ($files as $f) {
      $e = jread($f);
      if (!$e || !isset($e['data'])) { continue; }
      $pub = entry_public($e);
      if ($cur && $pub['rev'] === (int)$cur['rev']) { continue; }
      $out[] = $pub;
    }
  }
  return $out;
}

function daily_list() {
  $out = array();
  $files = glob(daily_dir() . '/*.json');
  if (is_array($files)) {
    rsort($files);
    foreach ($files as $f) {
      $e = jread($f);
      if (!$e || !isset($e['data'])) { continue; }
      $pub = entry_public($e);
      $pub['date'] = basename($f, '.json');
      $out[] = $pub;
    }
  }
  return $out;
}

/** 转成 App「导入备份」能直接吃的扁平格式 */
function export_doc($entry) {
  $d = $entry['data'];
  return array(
    'app' => '麻将馆往来账',
    'version' => isset($d['version']) ? $d['version'] : 2,
    'exportedAt' => date('c'),
    'cloudRev' => (int)$entry['rev'],
    'cloudSavedAt' => isset($entry['savedAt']) ? $entry['savedAt'] : '',
    'customers' => isset($d['customers']) ? $d['customers'] : array(),
    'txs' => isset($d['txs']) ? $d['txs'] : array(),
    'incomes' => isset($d['incomes']) ? $d['incomes'] : array(),
    'settings' => isset($d['settings']) ? $d['settings'] : array()
  );
}

/**
 * 校验并规整客户端上传的账本数据
 * 只接受 4 个已知字段，避免脏数据撑爆存储
 */
function sanitize_data($d) {
  if (!is_array($d)) { fail('数据格式不正确'); }
  $out = array(
    'version' => isset($d['version']) ? (int)$d['version'] : 2,
    'customers' => array(),
    'txs' => array(),
    'incomes' => array(),
    'settings' => array()
  );
  foreach (array('customers', 'txs', 'incomes') as $k) {
    if (!isset($d[$k])) { continue; }
    if (!is_array($d[$k])) { fail('字段 ' . $k . ' 格式不正确'); }
    $out[$k] = array_values($d[$k]);
  }
  if (isset($d['settings']) && is_array($d['settings'])) { $out['settings'] = $d['settings']; }
  return $out;
}
