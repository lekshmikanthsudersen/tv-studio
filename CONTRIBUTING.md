# Contributing to TV Studio

Bug reports, documentation improvements, and testing on other TVs are welcome.

## Report an issue

Include the TV Studio and Windows versions, TV model, Android version, connection method, and steps to reproduce the issue. Describe what you expected and what happened. Include a screenshot or error message when useful.

Remove device addresses, serial numbers, pairing codes, account details, and personal screen content before sharing logs or screenshots. Never submit ADB keys or credentials.

## Run the checks

Complete the [source setup](README.md#run-from-source), then run:

~~~powershell
npm run check
npm test
npm run smoke
npm run test:layout
~~~

The tests cover device discovery, input behavior, screenshots, session cleanup, and the connection between the interface and desktop process. The smoke check starts Electron. Layout checks cover two window sizes at 100%, 125%, and 150% display scaling.

The [Windows workflow](https://github.com/lekshmikanthsudersen/tv-studio/actions/workflows/windows.yml) also checks installation and packaging. Changes involving the TV connection or input should be tested on a real device. Include the model and Android version in the pull request.

## Build a portable Windows folder

~~~powershell
npm run package:win
~~~

Run the TVStudio.exe file in the dist/TVStudio-win32-x64 folder. Keep the entire folder together; it contains the desktop runtime, scrcpy, and ADB.

The scrcpy installer downloads version 4.1 from its official release and verifies its SHA-256 checksum. Electron is pinned in the dependency lockfile. Preserve their licenses when distributing a build.

## Optional tools

The legacy H.264 compatibility view can use a separate FFmpeg installation:

~~~powershell
npm run install:ffmpeg:win
~~~

To use existing tool installations, set ANDROID_TV_CONTROLLER_ADB, ANDROID_TV_CONTROLLER_SCRCPY, or ANDROID_TV_CONTROLLER_FFMPEG to their executable paths.

## Submit a change

Explain the user-visible change and how it was tested. Keep runtime binaries, dependency folders, device data, and generated builds out of commits. Retain the [third-party notices](THIRD_PARTY_NOTICES.md).
