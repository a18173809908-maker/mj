#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包部署产物

产出：
  deploy/ledger-site.zip            前端 + 后端（前端在 ledger/ 下，后端在 api/ 下）
  deploy/ledger-cloud-server.zip    只含后端 api/（第一次给服务器装云端用）
  并在桌面放同版本副本，方便宝塔上传时直接选。

用法：python tools/build-deploy.py [版本号，如 2.0]
"""
import os
import re
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import stage_site  # noqa: E402

DESKTOP = os.path.join(os.environ.get('USERPROFILE', r'C:\Users\Administrator'), 'Desktop')


def version():
    s = open(os.path.join(ROOT, 'js', 'app.js'), encoding='utf-8').read()
    m = re.search(r"VERSION\s*=\s*'([^']+)'", s)
    return m.group(1) if m else '0.0.0'


def build():
    ver = version()
    short = '.'.join(ver.split('.')[:2])
    stage = os.path.join(tempfile.gettempdir(), 'mjstage-build')
    copied = stage_site.stage(stage)

    dep = os.path.join(ROOT, 'deploy')
    os.makedirs(dep, exist_ok=True)

    full = os.path.join(dep, 'ledger-site.zip')
    srv = os.path.join(dep, 'ledger-cloud-server.zip')
    for p in (full, srv):
        if os.path.exists(p):
            os.remove(p)

    # 1) 前端 + 后端
    with zipfile.ZipFile(full, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in copied:
            arc = rel if rel.startswith('api/') else 'ledger/' + rel
            z.write(os.path.join(stage, *rel.split('/')), arc)

    # 2) 只含后端
    with zipfile.ZipFile(srv, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in copied:
            if rel.startswith('api/'):
                z.write(os.path.join(stage, *rel.split('/')), rel)

    # 自检
    with zipfile.ZipFile(full) as z:
        names = z.namelist()
        app = z.read('ledger/js/app.js').decode('utf-8')
        sw = z.read('ledger/sw.js').decode('utf-8')
        idx = z.read('ledger/index.html').decode('utf-8')
        m = re.search(r"VERSION\s*=\s*'([^']+)'", app)
        m2 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
        print('VERSION   =', m.group(1) if m else '?')
        print('SW CACHE  =', m2.group(1) if m2 else '?')
        print('index 引入 cloud.js :', 'js/cloud.js' in idx)
        print('后端文件            :', [n for n in names if n.startswith('api/')])
        print('前端文件数          :', len([n for n in names if n.startswith('ledger/')]))
        print('含 data 目录吗      :', any('/data/' in n for n in names))

    # 桌面副本
    desk_full = os.path.join(DESKTOP, 'ledger-site-v%s.zip' % short)
    desk_srv = os.path.join(DESKTOP, 'ledger-cloud-server-v%s.zip' % short)
    shutil.copy2(full, desk_full)
    shutil.copy2(srv, desk_srv)
    # 清掉旧的版本包
    for f in os.listdir(DESKTOP):
        if re.match(r'ledger-site-v[\d.]+\.zip$', f) and f != os.path.basename(desk_full):
            os.remove(os.path.join(DESKTOP, f)); print('删除旧包:', f)
        if re.match(r'ledger-cloud-server-v[\d.]+\.zip$', f) and f != os.path.basename(desk_srv):
            os.remove(os.path.join(DESKTOP, f)); print('删除旧包:', f)

    print()
    print('deploy/ledger-site.zip         %8d bytes' % os.path.getsize(full))
    print('deploy/ledger-cloud-server.zip %8d bytes' % os.path.getsize(srv))
    print('桌面:', desk_full)
    print('桌面:', desk_srv)
    shutil.rmtree(stage, ignore_errors=True)
    return ver


if __name__ == '__main__':
    build()
