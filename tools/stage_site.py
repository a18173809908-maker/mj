#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把项目静态文件 + server/api 组装成一个可直接部署/可直接本地起服务的目录。

用法：
    python tools/stage_site.py <目标目录>          # 组装（用于本地 php -S 实测）
    python tools/stage_site.py <目标目录> --zip    # 顺便打 deploy 用的 zip
"""
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STATIC_FILES = [
    'index.html', 'manifest.webmanifest', 'sw.js',
    'css/app.css',
    'js/store.js', 'js/ui.js', 'js/lock.js', 'js/cloud.js', 'js/app.js',
    'assets/icon-192.png', 'assets/icon-512.png',
    'assets/icon-maskable-512.png', 'assets/apple-touch-icon.png',
]

SERVER_FILES = ['server/api/index.php', 'server/api/lib.php', 'server/api/setup.php']


def stage(dst, make_zip=False):
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)

    copied = []
    for rel in STATIC_FILES:
        src = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(src):
            print('  MISSING(static):', rel)
            continue
        out = os.path.join(dst, *rel.split('/'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        copied.append(rel)

    for rel in SERVER_FILES:
        src = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(src):
            print('  MISSING(server):', rel)
            continue
        out = os.path.join(dst, 'api', os.path.basename(rel))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        copied.append('api/' + os.path.basename(rel))

    print('staged %d files -> %s' % (len(copied), dst))

    if make_zip:
        zp = os.path.join(ROOT, 'deploy', 'ledger-site.zip')
        os.makedirs(os.path.dirname(zp), exist_ok=True)
        if os.path.exists(zp):
            os.remove(zp)
        with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
            for rel in copied:
                if rel.startswith('api/'):
                    arc = rel                      # api/ 放在站点根
                else:
                    arc = 'ledger/' + rel          # 静态文件放 ledger/，解压后剪切到根
                z.write(os.path.join(dst, *rel.split('/')), arc)
        print('zip -> %s (%d bytes)' % (zp, os.path.getsize(zp)))
    return copied


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    stage(sys.argv[1], '--zip' in sys.argv)
