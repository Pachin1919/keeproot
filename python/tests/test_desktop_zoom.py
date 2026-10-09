from __future__ import annotations

from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

from atlas_desktop.__main__ import _configure_native_zoom


class DesktopZoomTest(unittest.TestCase):
    def window(self, invoke_required: bool = False) -> SimpleNamespace:
        settings = SimpleNamespace(IsZoomControlEnabled=True)
        view = SimpleNamespace(CoreWebView2=SimpleNamespace(Settings=settings), ZoomFactor=4.0)
        return SimpleNamespace(native=SimpleNamespace(webview=view, InvokeRequired=invoke_required))

    def test_disables_engine_zoom_and_resets_previous_factor(self) -> None:
        window = self.window()
        _configure_native_zoom(window)
        self.assertFalse(window.native.webview.CoreWebView2.Settings.IsZoomControlEnabled)
        self.assertEqual(window.native.webview.ZoomFactor, 1.0)

    def test_worker_event_marshals_the_operation_to_native_ui_thread(self) -> None:
        window = self.window(True)
        calls = []

        def invoke(callback):
            self.assertTrue(window.native.webview.CoreWebView2.Settings.IsZoomControlEnabled)
            calls.append("invoke")
            callback()

        window.native.Invoke = invoke
        with patch.dict(sys.modules, {"System": SimpleNamespace(Action=lambda callback: callback)}):
            _configure_native_zoom(window)
        self.assertEqual(calls, ["invoke"])
        self.assertFalse(window.native.webview.CoreWebView2.Settings.IsZoomControlEnabled)

    def test_unready_engine_is_reported_and_not_claimed_configured(self) -> None:
        window = self.window()
        window.native.webview.CoreWebView2 = None
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            _configure_native_zoom(window)


if __name__ == "__main__":
    unittest.main()
