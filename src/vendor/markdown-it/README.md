# Bundled Markdown parser

Upstream: https://github.com/markdown-it/markdown-it
Version: 15.0.2; commit: 3c51991c32aaa2b002a52c009334ebe5752c84b3.
Original file: dist/browser/markdown-it.esm.min.mjs from the official npm package.
The npm tarball SHA-512 matches its registry integrity record. This ESM bundle is copied without code changes, including its license banner. It needs no npm installation and contains no native component. The source-map reference is retained; the map is not distributed.

THIRD-PARTY-NOTICES.txt retains upstream and bundled dependency licenses:
markdown-it (MIT), mdurl 2.1.0 (MIT, including Node URL attribution), uc.micro 3.0.0 (MIT), entities 8.0.0 (BSD-2-Clause), linkify-it 6.1.0 (MIT), punycode.js 2.3.1 (MIT).
Dependency versions come from the pinned upstream package-lock and bundle source-map paths; each license tarball was verified against the lock integrity.

Atlas's src/markdown-reader.js disables HTML, remote image rendering and automatic linkification. Only explicitly supported external links and Atlas-resolved Resource links are rendered. Source bytes and filesystem operations remain in the Resource reader service. Parser updates require these same boundary tests; upstream tests were inspected, not executed.
