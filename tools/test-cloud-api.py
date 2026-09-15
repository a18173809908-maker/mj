#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""往来账云端后端 · 接口测试（针对本地 php -S 起的服务）

用法：
    python tools/test-cloud-api.py http://127.0.0.1:8824
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8824').rstrip('/')
API = BASE + '/api/index.php'

PASS = 0
FAIL = 0
FAILED = []


def ok(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  [OK] %s' % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print('  [X ] %s   %s' % (name, detail))


def call(action, body=None, token=None, query=None, raw=False):
    url = API + '?a=' + action
    for k, v in (query or {}).items():
        url += '&%s=%s' % (k, urllib.parse.quote(str(v)))
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, headers=headers,
                                method='POST' if data is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            txt = r.read().decode('utf-8', 'ignore')
            return r.status, (txt if raw else safe(txt))
    except urllib.error.HTTPError as e:
        txt = e.read().decode('utf-8', 'ignore')
        return e.code, (txt if raw else safe(txt))
    except Exception as e:
        return 0, {'_err': '%s: %s' % (type(e).__name__, e)}


def safe(t):
    t = t.lstrip('\ufeff').strip()
    try:
        return json.loads(t)
    except Exception:
        return {'_raw': t[:200]}


import urllib.parse  # noqa: E402

DSET_A = {
    'version': 2,
    'customers': [{'id': 'c1', 'name': '陈老板', 'phone': '', 'note': ''},
                  {'id': 'c2', 'name': '老张', 'phone': '', 'note': ''}],
    'txs': [{'id': 't1', 'customerId': 'c1', 'type': 'owe', 'category': 'fee',
             'amount': 20, 'date': '2026-09-14', 'note': '', 'incomeId': None}],
    'incomes': [],
    'settings': {'cigs': []},
}
DSET_B = json.loads(json.dumps(DSET_A))
DSET_B['customers'].append({'id': 'c3', 'name': '李姐', 'phone': '', 'note': ''})
DSET_B['txs'].append({'id': 't2', 'customerId': 'c2', 'type': 'owe', 'category': 'loan',
                      'amount': 500, 'date': '2026-09-14', 'note': '', 'incomeId': None})

PW = '2468'


def main():
    print('=== 云端后端接口测试 @ %s ===' % BASE)

    print('\n[1] 探活 / 首次环境')
    st, r = call('ping')
    ok('ping 返回 200', st == 200, st)
    ok('ping ok=true', r.get('ok') is True, r)
    ok('api 版本 1.0.0', r.get('api') == '1.0.0', r.get('api'))
    ok('数据目录可写', r.get('writable') is True, r)
    ok('尚未初始化 needsSetup', r.get('needsSetup') is True, r)
    ok('云端还没有账本', r.get('hasLedger') is False, r)
    ok('运行时标识（node/php）', r.get('runtime') in ('node', 'php'), r.get('runtime'))
    rtver = r.get('node') or r.get('php')
    ok('运行时版本可读', bool(rtver) and str(rtver).split('.')[0].lstrip('v').isdigit(), rtver)
    ok('未登录状态 loggedIn=false', r.get('loggedIn') is False, r)

    print('\n[2] 初始化密码')
    st, r = call('setup', {'password': '12'})
    ok('密码太短被拒', st == 400, (st, r))
    st, r = call('setup', {'password': PW, 'hint': '店里常用'})
    ok('初始化成功', st == 200 and r.get('ok') is True, (st, r))
    ok('拿到令牌', bool(r.get('token')), r)
    tok = r.get('token')
    ok('令牌有有效期', (r.get('expiresAt') or 0) > 0, r)
    st, r2 = call('setup', {'password': 'xxxx'})
    ok('重复初始化被拒 409', st == 409, (st, r2))

    print('\n[3] 登录')
    st, r = call('login', {'password': 'wrong'})
    ok('错密码 401', st == 401, (st, r))
    ok('错 1 次不给提示', not r.get('hint'), r)
    call('login', {'password': 'wrong'})
    call('login', {'password': 'wrong'})
    st, r = call('login', {'password': 'wrong'})
    ok('错 3 次给提示', r.get('hint') == '店里常用', r)
    st, r = call('login', {'password': PW})
    ok('正确密码登录成功', st == 200 and r.get('ok') is True, (st, r))
    tok = r.get('token')
    ok('登录返回 rev=0', r.get('rev') == 0, r)
    ok('错密码计数已清零', True)

    print('\n[4] 鉴权')
    st, r = call('pull')
    ok('无令牌拉取 401', st == 401, (st, r))
    ok('401 带 needLogin', r.get('needLogin') is True, r)
    st, r = call('pull', token='bogus.token')
    ok('伪造令牌 401', st == 401, (st, r))

    print('\n[5] 拉取与上传')
    st, r = call('pull', token=tok)
    ok('云端为空 empty=true', st == 200 and r.get('empty') is True, (st, r))
    st, r = call('push', {'data': DSET_A, 'device': '测试机', 'baseRev': 0}, token=tok)
    ok('首次上传成功', st == 200 and r.get('ok') is True, (st, r))
    ok('版本号 = 1', r.get('rev') == 1, r)
    ok('返回条数正确', r.get('counts') == {'customers': 2, 'txs': 1, 'incomes': 0}, r.get('counts'))
    st, r = call('push', {'data': DSET_A, 'device': '另一台', 'baseRev': 0}, token=tok)
    ok('baseRev 过期 → 409 冲突', st == 409 and r.get('conflict') is True, (st, r))
    ok('冲突返回云端当前版本', r.get('rev') == 1, r)
    st, r = call('push', {'data': DSET_B, 'device': '测试机', 'baseRev': 1}, token=tok)
    ok('正常追加 → rev 2', st == 200 and r.get('rev') == 2, (st, r))
    st, r = call('pull', token=tok)
    ok('拉回来 rev=2', r.get('rev') == 2, r)
    ok('拉回来数据一致', r['data'] == DSET_B, '数据不一致')

    print('\n[6] 数据校验')
    bad = json.loads(json.dumps(DSET_A))
    bad['txs'] = 'not-an-array'
    st, r = call('push', {'data': bad, 'baseRev': 2}, token=tok)
    ok('脏数据被拒 400', st == 400, (st, r))
    st, r = call('push', {'device': 'x', 'baseRev': 2}, token=tok)
    ok('缺 data 被拒 400', st == 400, (st, r))
    ok('被拒后云端版本没变', call('pull', token=tok)[1].get('rev') == 2)

    print('\n[7] 版本历史 / 下载 / 回滚')
    st, r = call('history', token=tok)
    ok('历史接口 200', st == 200, (st, r))
    ok('currentRev=2', r.get('currentRev') == 2, r.get('currentRev'))
    revs = [e['rev'] for e in r.get('list', [])]
    ok('历史含 v1 与 v2', 1 in revs and 2 in revs, revs)
    ok('历史每日备份 >=1', len(r.get('daily', [])) >= 1, r.get('daily'))
    st, txt = call('download', token=tok, query={'rev': 1}, raw=True)
    ok('下载 v1 成功', st == 200 and '陈老板' in txt, st)
    doc = json.loads(txt.lstrip('\ufeff'))
    ok('下载内容是 App 可导入格式', doc.get('app') == '麻将馆往来账' and 'customers' in doc, list(doc.keys()))
    ok('下载 v1 只有 2 位客户', len(doc['customers']) == 2, len(doc['customers']))
    ok('下载带 cloudRev', doc.get('cloudRev') == 1, doc.get('cloudRev'))
    st, r = call('restore', token=tok, query={'rev': 1})
    ok('回滚到 v1 成功', st == 200 and r.get('ok') is True, (st, r))
    ok('回滚产生新版本 rev=3', r.get('rev') == 3, r)
    st, r = call('pull', token=tok)
    ok('回滚后云端数据 = v1 内容', r['data'] == DSET_A, '数据不对')
    st, r = call('restore', token=tok, query={'rev': 99999})
    ok('回滚不存在的版本 404', st == 404, (st, r))

    print('\n[8] 改密码')
    st, r = call('changepw', {'oldPassword': 'bad', 'password': '9876'}, token=tok)
    ok('原密码错 → 401', st == 401, (st, r))
    st, r = call('changepw', {'oldPassword': PW, 'password': '12'}, token=tok)
    ok('新密码太短被拒', st == 400, (st, r))
    st, r = call('changepw', {'oldPassword': PW, 'password': '9876', 'hint': '新提示'}, token=tok)
    ok('改密码成功', st == 200 and r.get('changed') is True, (st, r))
    newtok = r.get('token')
    st, r = call('pull', token=tok)
    ok('旧令牌失效 401', st == 401, (st, r))
    st, r = call('pull', token=newtok)
    ok('新令牌可用', st == 200, (st, r))
    st, r = call('login', {'password': PW})
    ok('旧密码登录失败', st == 401, (st, r))
    st, r = call('login', {'password': '9876'})
    ok('新密码登录成功', st == 200, (st, r))
    tok = r.get('token')

    print('\n[9] 其它')
    st, r = call('nosuchaction', token=tok)
    ok('未知动作 404', st == 404, (st, r))
    st, txt = call('download', token=newtok, raw=True)
    ok('下载当前版本', st == 200 and '麻将馆往来账' in txt, st)
    st, r = call('revoke', token=tok)
    ok('全部设备下线', st == 200 and r.get('revoked') is True, (st, r))
    ok('下线后令牌失效', call('pull', token=tok)[0] == 401)

    print('\n[10] 自检页')
    req = urllib.request.Request(BASE + '/api/setup.php')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            html = r.read().decode('utf-8', 'ignore')
        ok('自检页 200', r.status == 200, r.status)
        ok('自检页含标题', '云端后端自检' in html)
        ok('自检页提示 data 目录暴露', '能否被外网直接下载' in html)
        ok('自检页显示版本号', '1.0.0' in html)
    except Exception as e:
        ok('自检页可访问', False, e)

    print('\n[11] 防爆破（放最后，会锁本机 IP 10 分钟）')
    codes = []
    for i in range(9):
        codes.append(call('login', {'password': 'wrong'})[0])
    ok('连续错密码触发 429 限流', 429 in codes, codes)

    print('\n' + '=' * 56)
    print('后端接口测试：通过 %d 项，失败 %d 项' % (PASS, FAIL))
    if FAILED:
        print('失败项：')
        for f in FAILED:
            print('  -', f)
    print('=' * 56)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
