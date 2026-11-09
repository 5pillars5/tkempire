#!/usr/bin/env python3
"""Offline safety checks for the pilot Genesis PAPER private refresh timer."""
import importlib.util
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "genesis_private_timer", Path(__file__).with_name("install_refresh_timer.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TimerSafetyTests(TestCase):
    def test_service_only_starts_private_refresh(self):
        content = mod.SERVICE_SOURCE
        self.assertIn("Type=oneshot", content)
        self.assertIn("ExecStart=/usr/bin/python3 -B /usr/local/lib/tkempire-genesis-public-signals/refresh_cycle.py", content)
        self.assertIn("ProtectSystem=strict", content)
        self.assertIn("ReadWritePaths=/var/lib/tkempire-genesis-signals-staging", content)
        self.assertIn("IPAddressDeny=any", content)
        self.assertIn("IPAddressAllow=localhost", content)
        self.assertNotIn("GENESIS_SIGNALS_PUBLISH_ENABLED=true", content)
        self.assertNotIn("ExecStart=/usr/bin/python3 -B /root/tkempire/bot.py", content)

    def test_timer_does_not_autostart_at_install(self):
        content = mod.TIMER_SOURCE
        self.assertIn("OnActiveSec=30s", content)
        self.assertIn("OnUnitActiveSec=60s", content)
        self.assertIn("Persistent=false", content)
        self.assertIn("WantedBy=timers.target", content)

    def test_source_hashes_pinned(self):
        for digest in (mod.CYCLE_SHA256, mod.REFRESH_LIB_SHA256,
                       mod.READER_SHA256, mod.NGINX_SHA256, mod.SNAPSHOT_SHA256):
            self.assertEqual(len(digest), 64)

    def test_disabled_reader_http_gate(self):
        with patch.object(mod, "local_request",
                          return_value=(200, b'{"status":"active"}')):
            with self.assertRaises(mod.GuardError):
                mod.protected()

    def test_fails_on_records_exposed_as_503(self):
        with patch.object(mod, "local_request",
                          return_value=(503, b'{"schema_version":1,"status":"publication_disabled","signals":[{"secret":"x"}]}')):
            with self.assertRaises(mod.GuardError):
                mod.protected()


if __name__ == "__main__":
    main()
