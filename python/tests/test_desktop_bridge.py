from __future__ import annotations

import unittest

from atlas_desktop.__main__ import DesktopBridge


class FakeWindow:
    def __init__(self, selected: object) -> None:
        self.selected = selected

    def create_file_dialog(self, *_args: object, **_kwargs: object) -> object:
        return self.selected


class CapturingBridge(DesktopBridge):
    def __init__(self, selected: object) -> None:
        super().__init__("http://127.0.0.1:4318/desktop/selection", "token")
        self._window = FakeWindow(selected)
        self.registered: tuple[tuple[str, ...], str, str, str | None, str | None] | None = None

    def _register_selection(
        self, paths: tuple[str, ...], *, kind: str, mode: str,
        flow: str | None = None, queue_id: str | None = None,
    ) -> dict[str, object]:
        self.registered = (paths, kind, mode, flow, queue_id)
        return {"status": "selected", "selection_id": "SEL-test"}


class DesktopBridgeTest(unittest.TestCase):
    def test_native_window_is_not_exposed_as_a_public_js_api_object(self) -> None:
        bridge = CapturingBridge(r"F:\Work\report.csv")

        self.assertNotIn("window", [name for name in dir(bridge) if not name.startswith("_")])

    def test_single_path_string_is_not_split_into_characters(self) -> None:
        bridge = CapturingBridge(r"F:\Work\report.csv")

        result = bridge.pick_file()

        self.assertEqual(result["status"], "selected")
        self.assertEqual(bridge.registered, ((r"F:\Work\report.csv",), "file", "single", None, None))

    def test_multiple_paths_are_registered_as_one_queue_selection(self) -> None:
        bridge = CapturingBridge((r"F:\Work\a.csv", r"F:\Work\b.xlsx"))

        bridge.pick_files()

        self.assertEqual(
            bridge.registered,
            ((r"F:\Work\a.csv", r"F:\Work\b.xlsx"), "file", "multiple", None, None),
        )

    def test_import_picker_keeps_one_selection_set_when_adding_files_or_a_folder(self) -> None:
        files = CapturingBridge((r"F:\Work\a.csv", r"F:\Work\b.xlsx"))
        files.pick_import_files("BQS-existing")
        self.assertEqual(
            files.registered,
            ((r"F:\Work\a.csv", r"F:\Work\b.xlsx"), "file", "multiple", "import", "BQS-existing"),
        )

        folder = CapturingBridge(r"F:\Work\drop")
        folder.pick_import_folder("BQS-existing")
        self.assertEqual(
            folder.registered,
            ((r"F:\Work\drop",), "folder", "single", "import", "BQS-existing"),
        )


if __name__ == "__main__":
    unittest.main()
