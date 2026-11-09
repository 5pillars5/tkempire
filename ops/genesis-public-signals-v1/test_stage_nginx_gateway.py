#!/usr/bin/env python3
"""Offline tests of authenticated staging gateway. Does not contact or modify VPS."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "genesis_stage_gateway", Path(__file__).with_name("stage_nginx_gateway.py")
)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

SAMPLE = '''server {
    listen 80;
    server_name api.tkempire.io;
    location / { return 404; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.tkempire.io;
    location = /internal/genesis/health {
        auth_basic "Genesis private";
        auth_basic_user_file /etc/nginx/.htpasswd-genesis;
        proxy_pass http://127.0.0.1:5000/health;
    }
    location = /internal/genesis/status {
        auth_basic "Genesis private";
        auth_basic_user_file /etc/nginx/.htpasswd-genesis;
        proxy_pass http://127.0.0.1:5000/status;
    }
    location / { return 404; }
}
'''


class GatewayTests(unittest.TestCase):
    def test_exact_route_only_inside_tls(self):
        result = gateway.transform(SAMPLE)
        self.assertEqual(result.count('location = /internal/genesis/signals {'), 1)
        self.assertIn('proxy_pass http://127.0.0.1:5097/signals;', result)
        self.assertIn('proxy_pass_request_headers off;', result)
        self.assertIn('proxy_set_header Authorization "";', result)
        self.assertIn('limit_except GET { deny all; }', result)
        self.assertIn('auth_basic "Genesis private";', result)
        self.assertIn('auth_basic_user_file /etc/nginx/.htpasswd-genesis;', result)
        self.assertNotIn('/internal/genesis/signals', result.split('server {')[1])
        self.assertEqual(result.count('proxy_pass http://127.0.0.1:5000/health;'), 1)
        self.assertEqual(result.count('proxy_pass http://127.0.0.1:5000/status;'), 1)

    def test_duplicate_signals_route_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'SIGNALS_ROUTE_ALREADY_EXISTS'):
            gateway.transform(gateway.transform(SAMPLE))

    def test_mismatched_auth_fails(self):
        corrupt = SAMPLE.replace('auth_basic "Genesis private";', 'auth_basic "Other";', 1)
        with self.assertRaisesRegex(RuntimeError, 'EXISTING_AUTH_SETTINGS_DIFFER'):
            gateway.transform(corrupt)

    def test_missing_auth_fails(self):
        corrupt = SAMPLE.replace('auth_basic_user_file /etc/nginx/.htpasswd-genesis;', '', 1)
        with self.assertRaisesRegex(RuntimeError, 'MISSING_OR_DUPLICATE_AUTH_BASIC_USER_FILE'):
            gateway.transform(corrupt)

    def test_duplicate_tls_vhost_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'HTTPS_API_VHOST_MISSING_OR_DUPLICATE'):
            gateway.transform(SAMPLE + SAMPLE)

    def test_unbalanced_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'UNBALANCED_NGINX_CONFIG'):
            list(gateway.server_blocks('server {\nlocation / {\n'))

    def test_comments_and_strings_do_not_confuse_braces(self):
        text = SAMPLE.replace('    location / { return 404; }', '    # fake { } comment\n    location / { return 404; }')
        self.assertIn('proxy_pass http://127.0.0.1:5097/signals;', gateway.transform(text))


if __name__ == "__main__":
    unittest.main()
