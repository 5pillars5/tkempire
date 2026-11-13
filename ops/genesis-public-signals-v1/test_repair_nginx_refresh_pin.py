#!/usr/bin/env python3
"""Offline contract tests for byte-exact Nginx revision repair."""
from __future__ import annotations
import importlib.util
from pathlib import Path
from unittest import TestCase, main

src=Path(__file__).with_name("repair_nginx_refresh_pin.py")
spec=importlib.util.spec_from_file_location("repair_nginx_refresh_pin",src)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class RepairTests(TestCase):
    def fixture(self):
        baseline=b"server {\n  location = /internal/genesis/signals {\n    auth_basic \"Private\";\n  }\n}\n"
        pos=baseline.rfind(b"}")
        block=b"".join((line+"\n").encode() for line in mod.EXPECTED_BLOCK)
        current=baseline[:pos]+block+baseline[pos:]
        return baseline,current

    def verify(self,baseline,current):
        mod.validated_diff(baseline,current,mod.sha(baseline),mod.sha(current))

    def test_only_one_exact_monitor_block(self):
        before,after=self.fixture()
        self.verify(before,after)

    def test_refuse_unreviewed_replacement(self):
        before,after=self.fixture()
        with self.assertRaisesRegex(mod.Block,"UNAPPROVED_NGINX_DIFF"):
            self.verify(before.replace(b"Private",b"Changed"),after)

    def test_refuse_extra_directive(self):
        before,after=self.fixture()
        after=after.replace(b"server {",b"server {\n  satisfy any;")
        with self.assertRaisesRegex(mod.Block,"UNAPPROVED_NGINX_DIFF"):
            self.verify(before,after)

    def test_refuse_monitor_auth_change(self):
        before,after=self.fixture()
        after=after.replace(b"genesis-auto-monitor.htpasswd",b"genesis-status.htpasswd")
        with self.assertRaisesRegex(mod.Block,"MONITOR_BLOCK_NOT_APPROVED"):
            self.verify(before,after)

    def test_refuse_direct_public_proxy(self):
        before,after=self.fixture()
        after=after.replace(b"127.0.0.1:5099",b"0.0.0.0:5099")
        with self.assertRaisesRegex(mod.Block,"MONITOR_BLOCK_NOT_APPROVED"):
            self.verify(before,after)

    def test_refuse_non_get_monitor(self):
        before,after=self.fixture()
        after=after.replace(b"limit_except GET",b"limit_except POST")
        with self.assertRaisesRegex(mod.Block,"MONITOR_BLOCK_NOT_APPROVED"):
            self.verify(before,after)

    def test_refuse_missing_block(self):
        before,after=self.fixture()
        with self.assertRaisesRegex(mod.Block,"MONITOR_BLOCK_MISSING_OR_DUPLICATE"):
            self.verify(before,before)

    def test_refuse_duplicate_block(self):
        before,after=self.fixture()
        start=after.index(mod.MARKER_START.encode())
        end=after.index(mod.MARKER_END.encode())+len(mod.MARKER_END)
        after=after[:end]+b"\n"+after[start:end]+after[end:]
        with self.assertRaisesRegex(mod.Block,"MONITOR_BLOCK_MISSING_OR_DUPLICATE"):
            self.verify(before,after)


if __name__=="__main__":
    main()
