#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""云端后端一体化测试：组装干净站点 → 起 PHP 服务 → 跑接口测试 → 收尾

用法：
    python tools/run-cloud-tests.py
环境变量：
    MJ_PHP   PHP 可执行文件路径（默认用托管目录里的便携版）
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import stage_site  # noqa: E402

DEFAULT_PHP = r'C:\Users\Administrator\.workbuddy\binaries\php\php83\php.exe'
NODE_WORKSPACE = r'C:\Users\Administrator\.workbuddy\binaries\node\workspace'
DEFAULT_NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'


def php_bin():
    p = os.environ.get('MJ_PHP') or DEFAULT_PHP
    if not os.path.exists(p):
        sys.exit('找不到 PHP：%s（可用环境变量 MJ_PHP 指定）' % p)
    return p


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_ready(base, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(base + '/api/index.php?a=ping', timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main():
    api_only = '--api-only' in sys.argv
    php = php_bin()
    port = free_port()
    base = 'http://127.0.0.1:%d' % port
    stage = os.path.join(tempfile.gettempdir(), 'mjcloud-test')

    print('组装干净站点 ...')
    stage_site.stage(stage)

    print('启动 PHP 内置服务 %s ...' % base)
    proc = subprocess.Popen(
        [php, '-S', '127.0.0.1:%d' % port, '-t', stage],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=stage)

    code = 1
    try:
        if not wait_ready(base):
            print('服务未能就绪')
            return 1

        print('\n########## 一、后端接口测试 ##########\n')
        code = subprocess.run(
            [sys.executable, os.path.join(HERE, 'test-cloud-api.py'), base],
            cwd=ROOT).returncode

        if not api_only:
            # 端到端测试要从「全新服务器」开始：清掉刚才接口测试留下的数据
            shutil.rmtree(os.path.join(stage, 'api', 'data'), ignore_errors=True)
            time.sleep(0.5)
            print('\n########## 二、云端端到端测试（浏览器） ##########\n')
            env = dict(os.environ)
            env['MJ_BASE'] = base
            env['NODE_PATH'] = os.path.join(NODE_WORKSPACE, 'node_modules')
            node = os.environ.get('MJ_NODE') or DEFAULT_NODE
            e2e = subprocess.run(
                [node, os.path.join(NODE_WORKSPACE, 'test-v20.js')],
                cwd=NODE_WORKSPACE, env=env).returncode
            if e2e != 0:
                code = e2e
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        time.sleep(0.4)
        shutil.rmtree(stage, ignore_errors=True)
        print('\n已收尾（PHP 服务已停止，测试站点已清理）')
    return code


if __name__ == '__main__':
    sys.exit(main())
