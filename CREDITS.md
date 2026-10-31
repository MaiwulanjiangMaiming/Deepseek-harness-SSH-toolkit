# Credits

This project is an independent continuation of the ideas and the initial
implementation of **[dsh-ssh/dsh-ssh](https://github.com/dsh-ssh/dsh-ssh)**
(MIT, Copyright (c) 2026 dsh-ssh). The host/tool architecture, the routing
strategy and parts of the SSH pool originate there, and the MIT license of the
original project is retained in [LICENSE](./LICENSE).

It is **not** a fork that tracks upstream commits. The DSH 0.2 migration
(storage-domain host store, Typert strict-codec contract, new primitives) and
everything built on top of it — the `~/.ssh/config` importer, the redesigned
settings page, the single-package layout and the new test harness — are
maintained here.

If you want the original 0.1.x plugin, use the upstream repository. If you want
a plugin that runs on current DSH (0.2.x) and imports the SSH hosts you already
have, use this one.
