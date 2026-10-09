from __future__ import annotations

import argparse
import ctypes
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

import webview


ERROR_ALREADY_EXISTS = 183


def acquire_instance_mutex() -> tuple[object, int] | None | bool:
    if sys.platform != "win32":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.CreateMutexW(None, False, "Local\\AtlasDesktopUI-v1")
    if not handle:
        raise OSError(ctypes.get_last_error(), "Atlas Desktop UI mutex could not be created")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return False
    return kernel32, handle


def loopback_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise argparse.ArgumentTypeError("Atlas Desktop UI accepts only a local loopback HTTP URL.")
    if parsed.username or parsed.password or parsed.fragment:
        raise argparse.ArgumentTypeError("Atlas Desktop UI URL contains unsupported authority or fragment data.")
    return value


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="atlas-desktop")
    command.add_argument("--url", required=True, type=loopback_url)
    command.add_argument("--storage-path", required=True)
    command.add_argument("--picker-registration-url", type=loopback_url)
    command.add_argument("--picker-token")
    command.add_argument("--width", type=int, default=1180)
    command.add_argument("--height", type=int, default=760)
    return command


class DesktopBridge:
    def __init__(self, registration_url: str | None, token: str | None) -> None:
        self.registration_url = registration_url
        self.token = token
        # pywebview recursively exposes every public object on js_api.  Keeping the
        # Window public makes it traverse the entire native window graph on every
        # page load, consuming a CPU core and unbounded memory.
        self._window = None

    def _register_selection(
        self,
        paths: tuple[str, ...],
        *,
        kind: str,
        mode: str,
        flow: str | None = None,
        queue_id: str | None = None,
    ) -> dict[str, object]:
        if not self._window or not self.registration_url or not self.token:
            return {"status": "unavailable"}
        try:
            data = [("file_path", selected) for selected in paths]
            data.extend([("kind", kind), ("mode", mode)])
            if flow:
                data.append(("flow", flow))
            if queue_id:
                data.append(("queue_id", queue_id))
            request = Request(
                self.registration_url,
                data=urlencode(data).encode("utf-8"),
                method="POST",
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Atlas-Desktop-Token": self.token,
                },
            )
            with urlopen(request, timeout=10) as response:  # nosec B310: loopback_url validates the endpoint
                payload = json.loads(response.read().decode("utf-8"))
            if not payload.get("ok"):
                return {"status": "failed", "message": payload.get("error", "Atlas could not register this selection.")}
            if payload.get("queue_id"):
                return {"status": "selected", "queue_id": payload["queue_id"], "count": payload.get("count", 0)}
            if not payload.get("selection_id"):
                return {"status": "failed"}
            return {
                "status": "selected",
                "selection_id": payload["selection_id"],
                "name": payload.get("name", "Selected file"),
            }
        except HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
                message = payload.get("error")
            except (OSError, ValueError, json.JSONDecodeError):
                message = None
            return {"status": "failed", "message": message or "Atlas rejected this desktop selection."}
        except (OSError, URLError, ValueError, json.JSONDecodeError) as error:
            return {"status": "failed", "message": f"Desktop selection registration failed: {error}"}

    @staticmethod
    def _selection_paths(selected: object) -> tuple[str, ...]:
        if isinstance(selected, (str, Path)):
            return (str(selected),)
        return tuple(str(selected_path) for selected_path in selected)  # type: ignore[union-attr]

    def _pick(
        self,
        *,
        kind: str,
        mode: str,
        allow_multiple: bool,
        flow: str | None = None,
        queue_id: str | None = None,
    ) -> dict[str, object]:
        if not self._window:
            return {"status": "unavailable", "message": "The Atlas Desktop window is not ready."}
        dialog = webview.FileDialog.FOLDER if kind == "folder" else webview.FileDialog.OPEN
        try:
            selected = self._window.create_file_dialog(dialog, allow_multiple=allow_multiple)
            if not selected:
                return {"status": "cancelled"}
            return self._register_selection(
                self._selection_paths(selected), kind=kind, mode=mode, flow=flow, queue_id=queue_id
            )
        except (OSError, TypeError, ValueError) as error:
            return {"status": "failed", "message": f"The desktop file picker failed: {error}"}

    def pick_file(self) -> dict[str, object]:
        return self._pick(kind="file", mode="single", allow_multiple=False)

    def pick_files(self) -> dict[str, object]:
        return self._pick(kind="file", mode="multiple", allow_multiple=True)

    def pick_folder(self) -> dict[str, object]:
        return self._pick(kind="folder", mode="single", allow_multiple=False)

    def pick_import_files(self, queue_id: str | None = None) -> dict[str, object]:
        return self._pick(
            kind="file", mode="multiple", allow_multiple=True, flow="import", queue_id=queue_id
        )

    def pick_import_folder(self, queue_id: str | None = None) -> dict[str, object]:
        return self._pick(
            kind="folder", mode="single", allow_multiple=False, flow="import", queue_id=queue_id
        )

    def picker_ready(self) -> dict[str, object]:
        return {"ready": bool(self._window and self.registration_url and self.token)}


def _configure_native_zoom(window: object) -> None:
    """Keep WebView2 at 100%; the UI supplies the bounded display scale.

    pywebview 6.2.1 enables WebView2 zoom even when zoomable=False. Its
    documented native.webview access lets us set the actual engine policy.
    Window events run on worker threads, so native changes use Invoke.
    """
    native = window.native

    def apply() -> None:
        view = native.webview
        if view.CoreWebView2 is None:
            raise RuntimeError("WebView2 is not ready for the display scale policy.")
        view.CoreWebView2.Settings.IsZoomControlEnabled = False
        view.ZoomFactor = 1.0

    if native.InvokeRequired:
        from System import Action
        native.Invoke(Action(apply))
    else:
        apply()


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if bool(args.picker_registration_url) != bool(args.picker_token):
        parser().error("--picker-registration-url and --picker-token must be provided together")
    mutex = acquire_instance_mutex()
    if mutex is False:
        print("ATLAS_DESKTOP_UI_ALREADY_RUNNING", file=sys.stderr, flush=True)
        return 2
    storage_path = Path(args.storage_path).resolve()
    storage_path.mkdir(parents=True, exist_ok=True)
    bridge = DesktopBridge(args.picker_registration_url, args.picker_token)
    window = webview.create_window(
        "Atlas",
        url=args.url,
        width=max(args.width, 760),
        height=max(args.height, 560),
        min_size=(760, 560),
        resizable=True,
        background_color="#f4f6f5",
        text_select=True,
        zoomable=False,
        js_api=bridge,
    )
    bridge._window = window

    def shown() -> None:
        print("ATLAS_DESKTOP_UI_READY", flush=True)

    window.events.shown += shown

    def loaded() -> None:
        try:
            _configure_native_zoom(window)
        except Exception as error:
            print(f"ATLAS_DESKTOP_ZOOM_POLICY_ERROR: {error}", file=sys.stderr, flush=True)

    window.events.loaded += loaded
    try:
        webview.start(
            gui="edgechromium",
            debug=False,
            private_mode=True,
            storage_path=str(storage_path),
        )
    except Exception as error:  # pragma: no cover - platform GUI failure
        print(f"ATLAS_DESKTOP_UI_ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        if mutex:
            kernel32, handle = mutex
            kernel32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
