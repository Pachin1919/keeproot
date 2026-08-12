from __future__ import annotations

import argparse
import ctypes
import sys
from pathlib import Path
from urllib.parse import urlparse

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
    command.add_argument("--width", type=int, default=1180)
    command.add_argument("--height", type=int, default=760)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    mutex = acquire_instance_mutex()
    if mutex is False:
        print("ATLAS_DESKTOP_UI_ALREADY_RUNNING", file=sys.stderr, flush=True)
        return 2
    storage_path = Path(args.storage_path).resolve()
    storage_path.mkdir(parents=True, exist_ok=True)
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
    )

    def shown() -> None:
        print("ATLAS_DESKTOP_UI_READY", flush=True)

    window.events.shown += shown
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
