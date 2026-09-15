#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""云端后端一体化测试：组装干净站点 → 起服务 → 跑接口测试 → 跑端到端 → 收尾

用法：
    python tools/run-cloud-tests.py                     # 默认测 Node 后端
    python tools/run-cloud-tests.py --backend=php       # 测 PHP 后端
    python tools/run-cloud-tests.py --api-only          # 只跑接口断言，不跑浏览器

两种后端的差别只在「怎么把服务起起来」，接口测试与端到端测试完全共用：
    php  → php -S 一个进程，静态 + /api 全包
    node → node server.js 只跑 /api；再用 tools/dev-gateway.js 提供静态并反代 /api
           （这样浏览器测试跑在与生产 nginx 相同的路径结构下）

环境变量：
    MJ_PHP    PHP 可执行文件路径（默认用托管目录里的便携版）
    MJ_NODE   Node 可执行文件路径（默认用托管目录里的版本）
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
DEFAULT_NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
NODE_WORKSPACE = r'C:\Users\Administrator\.workbuddy\binaries\node\workspace'


def php_bin():
    p = os.environ.get('MJ_PHP') or DEFAULT_PHP
    if not os.path.exists(p):
        sys.exit('找不到 PHP：%s（可用环境变量 MJ_PHP 指定）' % p)
    return p


def node_bin():
    p = os.environ.get('MJ_NODE') or DEFAULT_NODE
    if not os.path.exists(p):
        sys.exit('找不到 Node：%s（可用环境变量 MJ_NODE 指定）' % p)
    return p


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_ready(base, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(base + '/api/index.php?a=ping', timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def start_php_backend(stage, port):
    """PHP：一个内置服务器同时提供静态文件与 /api"""
    print('启动 PHP 内置服务 http://127.0.0.1:%d ...' % port)
    proc = subprocess.Popen(
        [php_bin(), '-S', '127.0.0.1:%d' % port, '-t', stage],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=stage)
    return [proc]


def start_node_backend(stage, port):
    """Node：server.js 只跑 /api，dev-gateway.js 提供静态并反代 /api（模拟 nginx）"""
    api_port = free_port()
    env = dict(os.environ)
    env['PORT'] = str(api_port)
    env['HOST'] = '127.0.0.1'
    # 数据落到 stage/api/data，与 PHP 版位置一致，方便统一清理
    env['LEDGER_DATA_DIR'] = os.path.join(stage, 'api', 'data')
    env['NODE_PATH'] = os.path.join(NODE_WORKSPACE, 'node_modules')

    print('启动 Node 后端 127.0.0.1:%d（仅 /api）...' % api_port)
    api = subprocess.Popen(
        [node_bin(), os.path.join(ROOT, 'server', 'node', 'server.js')],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)

    print('启动测试网关 http://127.0.0.1:%d（静态 + /api 反代）...' % port)
    gw = subprocess.Popen(
        [node_bin(), os.path.join(HERE, 'dev-gateway.js'), stage, str(port), str(api_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    return [api, gw]


def main():
    api_only = '--api-only' in sys.argv
    backend = 'node'
    for a in sys.argv[1:]:
        if a.startswith('--backend='):
            backend = a.split('=', 1)[1].strip().lower()
    if backend not in ('node', 'php'):
        sys.exit('--backend 只支持 node 或 php')

    port = free_port()
    base = 'http://127.0.0.1:%d' % port
    stage = os.path.join(tempfile.gettempdir(), 'mjcloud-test')

    print('后端类型：%s' % backend)
    print('组装干净站点 ...')
    stage_site.stage(stage)

    procs = start_php_backend(stage, port) if backend == 'php' else start_node_backend(stage, port)

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
            e2e = subprocess.run(
                [node_bin(), os.path.join(NODE_WORKSPACE, 'test-v20.js')],
                cwd=NODE_WORKSPACE, env=env).returncode
            if e2e != 0:
                code = e2e
    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=8)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        time.sleep(0.4)
        shutil.rmtree(stage, ignore_errors=True)
        print('\n已收尾（服务已停止，测试站点已清理）')
    return code


if __name__ == '__main__':
    sys.exit(main())
