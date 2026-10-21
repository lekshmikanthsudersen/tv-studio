# Changelog

## 2.0.1 — 2026-10-22

Initial public source release of the repaired desktop controller.

- Use scrcpy's decorated companion window with SDK mouse and keyboard input.
- Fix D-pad alignment, checkbox sizing, and keyboard focus conflicts.
- Bound compatibility key requests and serialize preview captures.
- Validate screenshot PNG data, report errors, and open saved images from the app.
- Wait for live-control shutdown before restart; cancel stale startup and connection work.
- Clean up owned sessions on disconnect and application exit.
- Add regression, layout, and lifecycle checks, with hardware verification on a Sony BRAVIA running Android 14.
- Pin the desktop dependency and document a reproducible Windows source setup.

Free My TV remains a separate optional launcher. It is not part of this release.
