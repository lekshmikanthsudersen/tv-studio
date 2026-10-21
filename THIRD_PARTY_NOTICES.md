# Third-party software

TV Studio's application source is licensed under the MIT License in `LICENSE`.
External tools and their dependencies retain their own licenses. This source
repository does not vendor their executables or shared libraries.

## Desktop runtime

- **Electron 42.4.0** — [MIT License](https://github.com/electron/electron/blob/v42.4.0/LICENSE).
  Copyright belongs to Electron contributors and the upstream copyright holders.
  Electron also includes Chromium, Node.js, and other components with their own
  notices. Keep the Electron distribution's `LICENSE` and
  `LICENSES.chromium.html` files with a generated portable package.
- npm dependencies used to install Electron are resolved in `package-lock.json`.
  Their license files remain in their respective installed packages.

## Android display and control

- **scrcpy 4.1** — [Apache License 2.0](https://github.com/Genymobile/scrcpy/blob/v4.1/LICENSE),
  maintained by Genymobile and Romain Vimont. TV Studio invokes the upstream
  client and server; it does not replace their implementation.
  The Windows installer downloads the official
  [scrcpy 4.1 release](https://github.com/Genymobile/scrcpy/releases/tag/v4.1)
  and verifies its pinned SHA-256 checksum before extraction.
- **Android Debug Bridge (ADB)** — provided with the scrcpy Windows archive or
  through a configured Android SDK Platform-Tools installation. See the
  [Android ADB documentation](https://developer.android.com/tools/adb) and the
  notices accompanying the selected Platform-Tools distribution.

The inspected scrcpy Windows runtime also uses these upstream libraries:

| Component | Upstream license or licensing reference |
| --- | --- |
| SDL 3.4.12 | [zlib license](https://github.com/libsdl-org/SDL/blob/release-3.4.12/LICENSE.txt) |
| libusb 1.0.30 | [LGPL 2.1](https://github.com/libusb/libusb/blob/v1.0.30/COPYING) |
| FFmpeg libraries (`libavcodec`, `libavformat`, `libavutil`, `libswresample`) | [FFmpeg licensing information](https://www.ffmpeg.org/legal.html); applicable terms depend on the binary's build configuration |

Keep upstream copyright and license notices when distributing these runtime
files. The scrcpy `LICENSE.txt` describes scrcpy itself; it does not replace the
licenses of its bundled dependencies.

## Optional legacy video fallback

The optional FFmpeg installer downloads a Windows build from
[Gyan's FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/). It is separate from
the FFmpeg libraries in scrcpy. Its installer keeps the downloaded build's
license and README alongside `ffmpeg.exe` in the local `bin/` directory.
The standalone executable is not included by TV Studio's portable packager.

Use the license and source information supplied with the exact FFmpeg build
being distributed. The TV Studio MIT License does not alter those terms.
