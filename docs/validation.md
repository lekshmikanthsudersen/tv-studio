# Validation notes for 2.0.1

Recorded on 22 October 2026 using a Sony BRAVIA VU3 running Android 14, connected to a Windows PC over the local network. These observations describe that setup, not a benchmark across Android TVs.

## Hardware checks

- Mouse click opened Sony Display & Sound settings.
- Arrows and Enter navigated Sony settings and Free My TV's remote-only menus.
- Letter keys and typed text appeared in an Android text field; the dialog was canceled without saving the sample value.
- Middle mouse returned Home; Alt+Tab returned to the desktop.
- Screenshot saved a valid PNG, and Open image opened the saved file.
- Live-control restart and application exit left no owned scrcpy process on the host or TV in the recorded checks.

## Recorded timings

| Observation | Result | Sample |
| --- | --- | --- |
| Repaired screenshot captures | 11 successes out of 11 attempts | 5 idle, 6 during live control |
| Screenshot duration during live control | Median 1.47 s; range 1.22–6.07 s | 6 captures |
| Warm native startup | 1.794 s and 2.019 s | 2 starts |
| Earlier cold startup | 7.014 s | 1 start |
| Graceful stop | 0.360 s and 0.433 s | 2 cycles |

Before the repair, the observed embedded session produced 3 empty screenshots and 2 timeouts out of 5 attempts. A stale Android scrcpy server was also observed, and captures recovered after it exited. Conditions were not controlled enough to infer a general performance improvement percentage.

Physical input-to-pixel latency and sustained frame rate were not measured. The configured 60 FPS ceiling is an encoder request. Network and device variability still produced captures lasting several seconds.

## Automated checks

- 27 screenshot, live-controller, and main-process lifecycle tests.
- Renderer input/focus/cancellation, device discovery, and 68 renderer/IPC contract bindings.
- A 30-event repeated-key burst allows one outstanding compatibility command.
- 12 layout combinations: two viewport sizes, three display scales, details open and closed. No D-pad overlap, horizontal overflow, or clipped right-side controls in these checks.
- Real Electron startup and Windows portable packaging checks.

See the repository's Windows workflow for the latest automated run. Other TV models, prolonged network outages, audio forwarding, and DRM playback still need hardware testing.

## Capture example

This is an actual PNG saved by TV Studio during the hardware check. It shows the separate [Free My TV](https://github.com/simbasjungles/free-my-tv) launcher, which is not included in TV Studio.

![Actual exported PNG showing Free My TV Home Settings](images/screenshot-export.png)
