#!/usr/bin/env python3
"""Unit tests for disabled installation helper; never call install()."""
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock, patch
import unittest

spec = importlib.util.spec_from_file_location(
    "genesis_disabled_installer", Path(__file__).with_name("install_disabled.py")
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerHelperTests(unittest.TestCase):
    def test_http_helper_uses_http_client_without_name_shadowing(self):
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 503
        response.read.return_value = b'{"status":"publication_disabled"}'
        with patch.object(installer.http_client, "HTTPConnection", return_value=connection) as factory:
            status, body = installer.http(5097, "/signals")
        self.assertEqual(status, 503)
        self.assertEqual(body, b'{"status":"publication_disabled"}')
        factory.assert_called_once_with("127.0.0.1", 5097, timeout=3)
        connection.request.assert_called_once_with(
            "GET", "/signals", headers={"Host": "127.0.0.1"}
        )
        connection.close.assert_called_once()

    def test_staging_service_is_disabled_and_confined(self):
        unit = installer.UNIT
        self.assertIn("Environment=GENESIS_SIGNALS_PUBLISH_ENABLED=false", unit)
        self.assertIn("DynamicUser=yes", unit)
        self.assertIn("ProtectHome=yes", unit)
        self.assertIn("IPAddressDeny=any", unit)
        self.assertIn("IPAddressAllow=localhost", unit)
        self.assertIn("Restart=no", unit)

if __name__ == "__main__":
    unittest.main()
