# Contributing to TV Studio

TV Studio is a Windows desktop workflow around ADB and scrcpy. Improvements should preserve the native live-control window, predictable focus, and reliable process cleanup.

## Development

Use the setup steps in the README, then run:

```powershell
npm run check
npm test
npm run smoke
npm run test:layout
```

Keep changes focused. Reuse existing platform and scrcpy capabilities before adding dependencies. Test the behavior that changed, including cancellation and shutdown when working on live control or discovery. The Windows workflow checks the source, renderer, Electron startup, and portable packaging.

For hardware changes, record the TV model, Android version, connection method, and observed result. Distinguish configured frame-rate limits from measurements. Do not generalize one TV's behavior to every Android device.

## Reporting an issue

Include:

- TV Studio version and Windows version.
- TV model, Android version, and connection method.
- Exact steps, expected result, and actual result.
- Relevant error text and a screenshot if helpful.

Remove device addresses, serial numbers, pairing codes, account details, and personal screen content before sharing logs or screenshots. Never submit ADB keys or credentials.

Some TV menus only implement remote navigation; compare mouse behavior with arrows and Enter when reporting an input issue.

## Pull requests

Explain the user-visible problem, the resulting behavior, and how it was tested. Keep runtime binaries, dependency folders, device data, and generated builds out of commits. Preserve upstream notices when changing packaging.
