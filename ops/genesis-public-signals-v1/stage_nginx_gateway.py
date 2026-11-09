#!/usr/bin/env python3
"""Add authenticated, publication-disabled Genesis Signals route to HTTPS vhost.

Does not enable signal publication or modify Genesis trading. The new route
proxies only to the disabled loopback staging service on 127.0.0.1:5097.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time

ENABLED = Path('/etc/nginx/sites-enabled/tkempire-genesis-api-stage')
BASE_SHA256 = '46cef9b5a902cb82054dd9f554ee8bf19d17887446adb020de3ae7b1658e914e'
BACKUP_ROOT = Path('/root/tkempire/backups/security')
STAGING_SERVICE = 'genesis-public-signals-staging.service'
EXACT_HOST = 'api.tkempire.io'
EXACT_ROUTE = '/internal/genesis/signals'


def run(*argv, timeout=15):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def balanced(source, brace):
    """Find matching brace while ignoring comments and quoted strings."""
    depth, quote, escaped, comment = 0, None, False, False
    for i in range(brace, len(source)):
        c = source[i]
        if comment:
            if c == '\n':
                comment = False
            continue
        if escaped:
            escaped = False
            continue
        if c == '\\':
            escaped = True
            continue
        if quote:
            if c == quote:
                quote = None
            continue
        if c in ('"', "'"):
            quote = c
            continue
        if c == '#':
            comment = True
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
    raise RuntimeError('UNBALANCED_NGINX_CONFIG')


def server_blocks(source):
    for m in re.finditer(r'(?m)^[ \t]*server[ \t]*\{', source):
        brace = source.index('{', m.start(), m.end())
        close = balanced(source, brace)
        yield m.start(), brace, close, source[m.start():close+1]


def find_location(server, endpoint):
    re_location = re.compile(
        r'(?m)^[ \t]*location[ \t]*=[ \t]*'
        + re.escape('/internal/genesis/' + endpoint)
        + r'[ \t]*\{'
    )
    found = list(re_location.finditer(server))
    require(len(found) == 1, 'PROTECTED_' + endpoint.upper() + '_LOCATION_MISSING_OR_DUPLICATE')
    hit = found[0]
    brace = server.index('{', hit.start(), hit.end())
    return server[hit.start():balanced(server, brace) + 1]


def auth_directives(block):
    directives = []
    for name in ('auth_basic', 'auth_basic_user_file'):
        matches = re.findall(
            r'(?m)^[ \t]*' + name + r'[ \t]+([^;\n]+);[ \t]*(?:\#.*)?$', block
        )
        require(len(matches) == 1 and bool(matches[0].strip()), 'MISSING_OR_DUPLICATE_' + name.upper())
        value = matches[0].strip()
        require(value != 'off', 'AUTHENTICATION_DISABLED')
        directives.append('        ' + name + ' ' + value + ';')
    return tuple(directives)


def transform(source):
    require(EXACT_ROUTE not in source, 'SIGNALS_ROUTE_ALREADY_EXISTS')
    targets = []
    for begin, brace, close, block in server_blocks(source):
        listens = re.findall(r'(?m)^[ \t]*listen[ \t]+([^;\n]+);', block)
        names = re.findall(r'(?m)^[ \t]*server_name[ \t]+([^;\n]+);', block)
        if (any(re.search(r'(?:^|[ \t])(?:\[::\]:)?443(?:[ \t]|$)', x)
                and 'ssl' in x.split() for x in listens)
                and any(EXACT_HOST in x.split() for x in names)):
            targets.append((begin, close, block))
    require(len(targets) == 1, 'HTTPS_API_VHOST_MISSING_OR_DUPLICATE')
    _, close, tls_block = targets[0]
    health_auth = auth_directives(find_location(tls_block, 'health'))
    status_auth = auth_directives(find_location(tls_block, 'status'))
    require(health_auth == status_auth, 'EXISTING_AUTH_SETTINGS_DIFFER')
    require(not re.search(r'(?m)^[ \t]*satisfy[ \t]+any[ \t]*;', tls_block), 'SATISFY_ANY_UNSAFE')
    guard = '\n    # Empire Signals v1: restricted, publication-disabled loopback staging.\n'
    guard += '    location = /internal/genesis/signals {\n'
    guard += '\n'.join(health_auth) + '\n'
    guard += '''        limit_except GET { deny all; }
        proxy_pass http://127.0.0.1:5097/signals;
        proxy_http_version 1.1;
        proxy_pass_request_headers off;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_connect_timeout 2s;
        proxy_read_timeout 3s;
        proxy_send_timeout 3s;
        proxy_intercept_errors off;
        proxy_cache off;
        proxy_buffering off;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
    }
'''
    return source[:close] + guard + source[close:]


def check_http(url, *, resolve=False):
    argv = [
        'curl', '--silent', '--show-error', '--noproxy', '*',
        '--connect-timeout', '3', '--max-time', '5', '--max-redirs', '0',
        '-o', '/dev/null', '-w', '%{http_code}'
    ]
    if resolve:
        argv += ['--resolve', 'api.tkempire.io:443:127.0.0.1']
    argv.append(url)
    result = run(*argv, timeout=8)
    return (result.returncode, result.stdout.strip())


def local_baseline():
    for service in ('nginx.service', 'tkempire.service', STAGING_SERVICE):
        require(run('systemctl', 'is-active', '--quiet', service).returncode == 0,
                'SERVICE_NOT_ACTIVE')
    require(run('nginx', '-t').returncode == 0, 'NGINX_SYNTAX_INVALID')
    require(check_http('http://127.0.0.1:5000/health') == (0, '200'), 'LOCAL_GENESIS_UNAVAILABLE')
    require(check_http('http://127.0.0.1:5097/signals') == (0, '503'), 'STAGING_NOT_DISABLED')
    require(check_http('http://127.0.0.1/health') == (0, '404'), 'DEFAULT_HTTP_UNPROTECTED')
    require(check_http('https://api.tkempire.io/internal/genesis/health', resolve=True) == (0, '401'),
            'EXISTING_HTTPS_AUTH_UNVERIFIED')
    listeners = run('ss', '-H', '-lnt')
    require(listeners.returncode == 0, 'LISTENER_AUDIT_FAILED')
    port5097 = [row.split()[3] for row in listeners.stdout.splitlines()
                if len(row.split()) >= 4 and row.split()[3].rsplit(':', 1)[-1] == '5097']
    require(port5097 == ['127.0.0.1:5097'], 'STAGING_NOT_LOOPBACK_ONLY')


def atomic_write(target, raw, info):
    descriptor, temporary = tempfile.mkstemp(prefix='.genesis-signals-', dir=str(target.parent))
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, stat.S_IMODE(info.st_mode))
        os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, target)
        dir_fd = os.open(str(target.parent), os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--preflight', action='store_true')
    group.add_argument('--install', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    require(ENABLED.is_symlink(), 'ACTIVE_SITE_SYMLINK_NOT_FOUND')
    target = ENABLED.resolve(strict=True)
    require(target.is_file() and target.parent == Path('/etc/nginx/sites-available'),
            'TARGET_OUTSIDE_APPROVED_DIRECTORY')
    info = target.stat()
    require(info.st_uid == 0, 'CONFIG_NOT_ROOT_OWNED')
    old = target.read_bytes()
    require(sha(old) == BASE_SHA256, 'CONFIG_HASH_CHANGED_REAUDIT_REQUIRED')
    new = transform(old.decode('utf-8')).encode('utf-8')
    local_baseline()
    print('GATEWAY_PREFLIGHT=PASS', flush=True)
    print('OLD_SHA256=' + sha(old), flush=True)
    print('NEW_SHA256=' + sha(new), flush=True)
    if args.preflight:
        print('FILES_MODIFIED=NONE')
        return
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    backup_dir = Path(tempfile.mkdtemp(prefix='nginx-genesis-signals-', dir=BACKUP_ROOT))
    backup_dir.chmod(0o700)
    backup = backup_dir / 'original.conf'
    shutil.copy2(target, backup)
    backup.chmod(0o600)
    require(sha(backup.read_bytes()) == BASE_SHA256, 'BACKUP_HASH_MISMATCH')
    print('BACKUP_PATH=' + str(backup), flush=True)
    print('BACKUP_SHA256=' + sha(backup.read_bytes()), flush=True)
    changed = False
    try:
        atomic_write(target, new, info)
        changed = True
        require(run('nginx', '-t').returncode == 0, 'CHANGED_CONFIG_SYNTAX_INVALID')
        require(run('systemctl', 'reload', 'nginx').returncode == 0, 'NGINX_RELOAD_FAILED')
        passed = False
        last = None
        for _ in range(24):
            last = (
                check_http('https://api.tkempire.io/internal/genesis/signals', resolve=True),
                check_http('https://api.tkempire.io/internal/genesis/health', resolve=True),
                check_http('https://api.tkempire.io/internal/genesis/status', resolve=True),
            )
            if last == ((0, '401'), (0, '401'), (0, '401')):
                passed = True
                break
            time.sleep(0.25)
        require(passed, 'UNAUTHENTICATED_HTTPS_ROUTE_NOT_VERIFIED')
        local_baseline()
        require(sha(target.read_bytes()) == sha(new), 'POSTWRITE_SHA256_MISMATCH')
        print('UNAUTH_SIGNALS_HTTP=401')
        print('UNAUTH_HEALTH_HTTP=401')
        print('UNAUTH_STATUS_HTTP=401')
        print('LOCAL_DISABLED_PUBLISHER_HTTP=503')
        print('PUBLISHER_PUBLICATION_ENABLED=NO')
        print('NGINX_AUTH_REUSE=VERIFIED')
        print('GENESIS_TRADING_CONFIG_MODIFIED=NO')
        print('NGINX_SIGNALS_ROUTE_STAGING=PASS')
    except Exception as error:
        if changed:
            try:
                atomic_write(target, old, info)
                require(sha(target.read_bytes()) == sha(old), 'ROLLBACK_HASH_MISMATCH')
                require(run('nginx', '-t').returncode == 0, 'ROLLBACK_CONFIG_SYNTAX_INVALID')
                require(run('systemctl', 'reload', 'nginx').returncode == 0, 'ROLLBACK_RELOAD_FAILED')
                print('ROLLBACK_VERIFIED=PASS')
            except Exception as rollback_error:
                print('ROLLBACK_VERIFIED=FAIL')
                print('ROLLBACK_ERROR_TYPE=' + type(rollback_error).__name__)
        print('NGINX_SIGNALS_ROUTE_STAGING=FAIL')
        print('ERROR_TYPE=' + type(error).__name__)
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('GATEWAY_OPERATION=BLOCKED')
        print('ERROR_TYPE=' + type(error).__name__)
        raise SystemExit(1)
