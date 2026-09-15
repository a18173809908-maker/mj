<?php
/**
 * 往来账 · 云端备份后端 —— 单入口
 *
 * 所有请求：  https://你的域名/api/index.php?a=动作
 *
 * 动作一览（★ 需要登录）：
 *   ping        探活 / 看云端状态（无需登录）
 *   setup       首次初始化：设置云端密码（仅当服务器还没设过密码时可用）
 *   login       登录，拿令牌
 *   pull    ★   拉取云端账本
 *   push    ★   上传账本（带 baseRev 做冲突检测）
 *   history ★   版本历史列表
 *   daily   ★   每日备份列表
 *   restore ★   把某个历史版本恢复成当前版本
 *   download★   下载某个版本（或当前）为可导入的备份文件
 *   changepw★   修改云端密码（旧令牌全部失效）
 *   revoke  ★   让所有已登录设备下线
 *
 * 兼容 PHP 7.2 ~ 8.3
 */

require __DIR__ . '/lib.php';

$action = param('a', 'ping');

try {
  switch ($action) {

    /* ---------------- 探活 ---------------- */
    case 'ping': {
      ensure_dirs();
      $cur = ledger_read();
      $writable = is_writable(data_dir());
      ok(array(
        'ready' => $writable,
        'writable' => $writable,
        'needsSetup' => !password_exists(),
        'hasLedger' => $cur ? true : false,
        'rev' => $cur ? (int)$cur['rev'] : 0,
        'savedAt' => $cur ? $cur['savedAt'] : null,
        'device' => $cur ? $cur['device'] : '',
        'counts' => $cur ? counts_of($cur['data']) : array('customers' => 0, 'txs' => 0, 'incomes' => 0),
        'php' => PHP_VERSION,
        'loggedIn' => token_check(bearer())
      ));
      break;
    }

    /* ---------------- 首次初始化 ---------------- */
    case 'setup': {
      if (password_exists()) { fail('云端已经设置过密码了，请直接登录', 409, array('needLogin' => true)); }
      $b = body_json();
      $pw = isset($b['password']) ? (string)$b['password'] : '';
      $hint = isset($b['hint']) ? (string)$b['hint'] : '';
      if (strlen($pw) < 4) { fail('密码至少 4 位'); }
      if (strlen($pw) > 64) { fail('密码太长（最多 64 位）'); }
      with_lock(function () use ($pw, $hint) {
        if (password_exists()) { fail('云端已经设置过密码了，请直接登录', 409, array('needLogin' => true)); }
        password_set($pw, $hint);
      });
      $t = token_make();
      ok(array('token' => $t['token'], 'expiresAt' => $t['expiresAt'], 'created' => true));
      break;
    }

    /* ---------------- 登录 ---------------- */
    case 'login': {
      if (!password_exists()) { fail('云端还没初始化，请先设置密码', 409, array('needsSetup' => true)); }
      throttle_check();
      $b = body_json();
      $pw = isset($b['password']) ? (string)$b['password'] : '';
      if (!password_check($pw)) {
        throttle_bump();
        $a = jread(auth_file());
        $extra = array();
        // 连着错 3 次才给提示，避免被人一上来就试出提示
        if (throttle_count() >= 3 && $a && !empty($a['hint'])) { $extra['hint'] = $a['hint']; }
        fail('密码不正确', 401, $extra);
      }
      throttle_clear();
      $t = token_make();
      $cur = ledger_read();
      ok(array(
        'token' => $t['token'],
        'expiresAt' => $t['expiresAt'],
        'rev' => $cur ? (int)$cur['rev'] : 0,
        'savedAt' => $cur ? $cur['savedAt'] : null,
        'counts' => $cur ? counts_of($cur['data']) : array('customers' => 0, 'txs' => 0, 'incomes' => 0)
      ));
      break;
    }

    /* ---------------- 拉取 ---------------- */
    case 'pull': {
      require_auth();
      $cur = ledger_read();
      if (!$cur) {
        ok(array('empty' => true, 'rev' => 0, 'data' => null));
      }
      ok(array(
        'empty' => false,
        'rev' => (int)$cur['rev'],
        'savedAt' => $cur['savedAt'],
        'device' => $cur['device'],
        'counts' => counts_of($cur['data']),
        'data' => $cur['data']
      ));
      break;
    }

    /* ---------------- 上传 ---------------- */
    case 'push': {
      require_auth();
      $b = body_json();
      if (!isset($b['data'])) { fail('缺少 data 字段'); }
      $data = sanitize_data($b['data']);
      $device = isset($b['device']) ? (string)$b['device'] : '';
      $baseRev = isset($b['baseRev']) ? (int)$b['baseRev'] : -1;
      $force = !empty($b['force']);
      if ($force) { $baseRev = -1; }

      $r = ledger_commit($data, $device, $baseRev);
      if (isset($r['conflict']) && $r['conflict']) {
        jout(array(
          'ok' => false,
          'error' => '云端已有更新的版本',
          'conflict' => true,
          'rev' => $r['rev'],
          'savedAt' => $r['savedAt'],
          'device' => $r['device'],
          'counts' => $r['counts']
        ), 409);
      }
      ok(array(
        'rev' => (int)$r['rev'],
        'savedAt' => $r['savedAt'],
        'bytes' => isset($r['bytes']) ? (int)$r['bytes'] : 0,
        'counts' => counts_of($data)
      ));
      break;
    }

    /* ---------------- 版本历史 ---------------- */
    case 'history': {
      require_auth();
      ok(array(
        'currentRev' => (function () { $c = ledger_read(); return $c ? (int)$c['rev'] : 0; })(),
        'list' => history_list(),
        'daily' => daily_list()
      ));
      break;
    }

    /* ---------------- 恢复某个版本 ---------------- */
    case 'restore': {
      require_auth();
      $rev = param('rev', '');
      if ($rev === '') { fail('缺少 rev 参数'); }
      $e = ledger_version($rev);
      if (!$e) { fail('找不到这个版本（可能已被清理）', 404); }
      $r = ledger_commit(sanitize_data($e['data']), '回滚自 v' . (int)$e['rev'], -1);
      ok(array(
        'rev' => (int)$r['rev'],
        'restoredFrom' => (int)$e['rev'],
        'savedAt' => $r['savedAt'],
        'counts' => counts_of($e['data'])
      ));
      break;
    }

    /* ---------------- 下载某版本（可导入的备份文件） ---------------- */
    case 'download': {
      require_auth();
      $rev = param('rev', 'current');
      $e = ledger_version($rev);
      if (!$e) { fail('找不到这个版本', 404); }
      $doc = export_doc($e);
      $name = '往来账-云端备份-v' . (int)$e['rev'] . '-' . date('Ymd-His') . '.json';
      $json = json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
      if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $name . '"; filename*=UTF-8\'\'' . rawurlencode($name));
        header('Cache-Control: no-store');
        header('Content-Length: ' . strlen($json));
      }
      echo $json;
      exit;
    }

    /* ---------------- 修改密码 ---------------- */
    case 'changepw': {
      require_auth();
      $b = body_json();
      $old = isset($b['oldPassword']) ? (string)$b['oldPassword'] : '';
      $pw = isset($b['password']) ? (string)$b['password'] : '';
      $hint = isset($b['hint']) ? (string)$b['hint'] : '';
      if (!password_check($old)) { throttle_bump(); fail('原密码不正确', 401); }
      if (strlen($pw) < 4) { fail('新密码至少 4 位'); }
      with_lock(function () use ($pw, $hint) { password_set($pw, $hint); });
      // 换密码 = 换签名密钥，所有旧令牌自然失效
      with_lock(function () {
        $c = conf();
        $c['secret'] = bin2hex(random_bytes(32));
        jwrite(conf_file(), $c);
      });
      $t = token_make();
      ok(array('token' => $t['token'], 'expiresAt' => $t['expiresAt'], 'changed' => true));
      break;
    }

    /* ---------------- 全部设备下线 ---------------- */
    case 'revoke': {
      require_auth();
      with_lock(function () {
        $c = conf();
        $c['secret'] = bin2hex(random_bytes(32));
        jwrite(conf_file(), $c);
      });
      ok(array('revoked' => true));
      break;
    }

    default:
      fail('未知动作：' . $action, 404);
  }
} catch (Throwable $e) {
  fail('服务器内部错误：' . $e->getMessage(), 500);
}
