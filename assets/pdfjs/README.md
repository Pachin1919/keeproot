# PDF.js browser rendering assets

Unmodified selected files from Mozilla PDF.js **6.4.299**, commit
`d0991a0d53f3bb3a7307e3b83f279c1d117aafb3`.

Source: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299

The core library and worker use Apache-2.0; see `LICENSE` and their retained
file headers. CMaps, standard fonts, image decoders and the ICC profile have
their own notices alongside the respective files. Preserve those notices.

Atlas uses the rendering library, not the upstream viewer, editor or scripting
sandbox. The upstream example is `examples/learning/helloworld.html`; loading,
invalid-file and password failure tests are in `test/unit/api_spec.js`.

Selected assets exclude source maps, the scripting sandbox, QuickJS and the
Liberation font binaries. Standard sans-serif fonts use browser/system fallback;
rendering can therefore vary with locally available fonts. Included Foxit fonts
retain `standard_fonts/LICENSE_FOXIT`.

These static files ship with the existing portable Runtime. No npm installation,
external CDN, native executable or browser extension is required. Keep the core
and worker versions together when updating and rerun Atlas PDF reading checks.
