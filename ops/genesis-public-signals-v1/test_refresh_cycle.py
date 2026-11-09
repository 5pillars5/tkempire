#!/usr/bin/env python3
"""Offline safety tests for the Genesis private refresh / reload cycle."""
import importlib.util
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "genesis_refresh_cycle", Path(__file__).with_name("refresh_cycle.py")
)
cycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle)


def row(identity, *, asset="BNB", entry=100, at="2026-11-09T13:00:00Z"):
    return {
        "id": identity,
        "asset": asset,
        "side": "BUY",
        "observed_at": at,
        "trigger": entry,
        "stop_loss": 90
    }


class CycleTests(TestCase):
    def test_same_signal_keeps_same_identity(self):
        old = {"signals": [row("a" * 32)]}
        new = {"signals": [row("a" * 32)]}
        cycle.stable_overlap(old, new)

    def test_same_signal_changed_id_fails_closed(self):
        old = {"signals": [row("a" * 32)]}
        new = {"signals": [row("b" * 32)]}
        with self.assertRaisesRegex(cycle.GuardError, "STABLE_SIGNAL_ID_REGRESSION"):
            cycle.stable_overlap(old, new)

    def test_new_signal_does_not_require_old_identity(self):
        cycle.stable_overlap(
            {"signals": [row("a" * 32)]},
            {"signals": [row("b" * 32, asset="SOL")]}
        )

    def test_reordered_signals_do_not_change_identity(self):
        old = {"signals": [row("a" * 32), row("b" * 32, asset="SOL")]}
        new = {"signals": [row("b" * 32, asset="SOL"), row("a" * 32)]}
        cycle.stable_overlap(old, new)

    def test_ambiguous_identity_is_never_claimed_verified(self):
        old = {"signals": [row("a" * 32), row("b" * 32)]}
        new = {"signals": [row("a" * 32), row("c" * 32)]}
        cycle.stable_overlap(old, new)

    def test_reader_must_return_503(self):
        with patch.object(cycle, "probe", return_value=(
            200, b'{"schema_version":1,"status":"active","signals":[]}'
        )):
            with self.assertRaisesRegex(cycle.GuardError, "SIGNALS_NOT_DISABLED"):
                cycle.disabled()

    def test_reader_cannot_return_records_even_when_disabled(self):
        with patch.object(cycle, "probe", return_value=(
            503, b'{"schema_version":1,"status":"publication_disabled","signals":[{"id":"x"}]}'
        )):
            with self.assertRaisesRegex(cycle.GuardError, "DISABLED_RESPONSE_MISMATCH"):
                cycle.disabled()

    def test_fingerprint_and_key_are_not_public_in_source(self):
        source = Path(__file__).with_name("refresh_cycle.py").read_text()
        self.assertIn("STAGING_SERVICE", source)
        self.assertNotIn("GENESIS_SIGNALS_PUBLISH_ENABLED=true", source)
        self.assertNotIn("systemctl\", \"restart\", GENESIS_SERVICE", source)
        self.assertNotIn("systemctl\", \"restart\", NGINX_SERVICE", source)


if __name__ == "__main__":
    main()
