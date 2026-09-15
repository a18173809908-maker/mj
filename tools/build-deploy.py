#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包部署产物

产出（都在 deploy/ 下，并在桌面放同版本副本）：
  ledger-site.zip            前端（解压出 ledger/，全选剪切到站点根）
  ledger-api-node.zip        Node 后端（解压出 ledger-api-node/，用 PM2 启动）
  ledger-cloud-server.zip    PHP 后端（备选方案，解压出 api/）

用法：python tools/build-deploy.py
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

NODE_DIR = os.path.join(ROOT, 'server', 'node')
NODE_FILES = ['server.js', 'lib.js', 'package.json', 'ecosystem.config.js', 'README.txt']


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

    site = os.path.join(dep, 'ledger-site.zip')
    php = os.path.join(dep, 'ledger-cloud-server.zip')
    node = os.path.join(dep, 'ledger-api-node.zip')
    for p in (site, php, node):
        if os.path.exists(p):
            os.remove(p)

    # 1) 前端（只含静态文件；后端单独打包）
    with zipfile.ZipFile(site, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in copied:
            if rel.startswith('api/'):
                continue
            z.write(os.path.join(stage, *rel.split('/')), 'ledger/' + rel)

    # 2) PHP 后端（备选方案，保留一份以免以后要用）
    with zipfile.ZipFile(php, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in copied:
            if rel.startswith('api/'):
                z.write(os.path.join(stage, *rel.split('/')), rel)

    # 3) Node 后端（当前主用）
    missing = []
    with zipfile.ZipFile(node, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in NODE_FILES:
            src = os.path.join(NODE_DIR, name)
            if not os.path.exists(src):
                missing.append(name)
                continue
            z.write(src, 'ledger-api-node/' + name)

    # ---- 自检 ----
    print('=' * 58)
    with zipfile.ZipFile(site) as z:
        names = z.namelist()
        app = z.read('ledger/js/app.js').decode('utf-8')
        sw = z.read('ledger/sw.js').decode('utf-8')
        idx = z.read('ledger/index.html').decode('utf-8')
        m = re.search(r"VERSION\s*=\s*'([^']+)'", app)
        m2 = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
        print('前端 VERSION      :', m.group(1) if m else '?')
        print('前端 SW CACHE     :', m2.group(1) if m2 else '?')
        print('前端 clamp cloud.js:', 'js/cloud.js' in idx)
        print('前端文件数        :', len(names))
        print('前端含后端 api/ 吗:', any(n.startswith('api/') for n in names))

    with zipfile.ZipFile(node) as z:
        nn = sorted(z.namelist())
        js = z.read('ledger-api-node/server.js').decode('utf-8')
        print('Node 后端文件     :', nn)
        print('Node 后端零依赖   :', 'require(' in js and 'node_modules' not in str(nn))
    if missing:
        print('!! Node 后端缺文件 :', missing)

    with zipfile.ZipFile(php) as z:
        print('PHP 后端文件      :', sorted(z.namelist()))
    print('=' * 58)

    # ---- 桌面副本 ----
    pairs = [
        (site, 'ledger-site-v%s.zip' % short),
        (php, 'ledger-cloud-server-v%s.zip' % short),
        (node, 'ledger-api-node-v%s.zip' % short),
    ]
    for src, name in pairs:
        shutil.copy2(src, os.path.join(DESKTOP, name))

    # ---- 清掉桌面旧版本包 ----
    keep = set(n for _, n in pairs)
    for f in os.listdir(DESKTOP):
        if not f.endswith('.zip'):
            continue
        if not re.match(r'ledger-(site|cloud-server|api-node)-v[\d.]+\.zip$', f):
            continue
        if f not in keep:
            try:
                os.remove(os.path.join(DESKTOP, f))
                print('删除旧包:', f)
            except OSError as e:
                print('删不掉旧包:', f, e)

    print()
    print('deploy/ledger-site.zip         %8d bytes' % os.path.getsize(site))
    print('deploy/ledger-api-node.zip     %8d bytes' % os.path.getsize(node))
    print('deploy/ledger-cloud-server.zip %8d bytes' % os.path.getsize(php))
    print('桌面副本:')
    for _, name in pairs:
        print('  ', os.path.join(DESKTOP, name))
    shutil.rmtree(stage, ignore_errors=True)
    return ver


if __name__ == '__main__':
    build()
