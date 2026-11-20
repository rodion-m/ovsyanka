# Build and run Yogurt locally

## You need

- Node.js 24 and pnpm 10.7.0
- CMake
- **Mac:** Xcode Command Line Tools
- **Windows:** Rust, the Vulkan SDK, Visual Studio C++ Build Tools
- **Linux:** Rust, the Vulkan SDK, `libpulse-dev`, `pkg-config`

## Run it

```sh
# Run from your checkout of this fork, not the upstream release source.
pnpm install --frozen-lockfile
pnpm -C app native   # builds the audio, system and transcription helpers (first time, and after they change)
pnpm dev             # opens Yogurt from source
```

The first run uses agy provider mode and downloads no local AI models. Install and authenticate the CLI separately, then configure it in **Settings → AI processing**; see [the provider guide](subscription-harness.md). Selecting Local models restores the original model downloads after restart. Native build dependencies and helpers are still required for recording.

- **Separate profile:** `YOGURT_USER_DATA=/tmp/yogurt-dev pnpm dev` keeps your real meetings out of it.
- **Offline development:** `YOGURT_FAKE=1 pnpm dev` uses fake local setup, transcription, notes and call audio unless saved AI settings or `YOGURT_AI_BACKEND` explicitly select a provider. Use a fresh `YOGURT_USER_DATA` directory for a predictable fake run.

## Test

```sh
pnpm -C app typecheck
pnpm -C app test   # unit tests
pnpm -C app e2e    # builds, then drives the app with Playwright in fake mode
```

Tests take profiles and scratch folders from `tempDir(name)` (`app/test/support/tempDir.ts` for unit tests, `app/e2e/support/playwright.ts` for e2e specs, which also import `test`, `expect` and `_electron` from there). Each folder is `yogurt-<name>-XXXXXX` in the system temp folder and is removed when its test ends; an e2e test's apps are closed first, also after a failure or timeout. `YOGURT_KEEP_TEMP=1` keeps them for debugging: e2e lists them on the test's annotations, unit tests print them. `test/tempDirGuard.test.ts` fails when a test makes a temp folder another way.

## Build an installer

```sh
pnpm -C app build
pnpm -C app exec electron-builder --mac   # or --win, --linux, on that platform
```

Installers land in `app/dist/`. They're unsigned unless signing is set up; see `app/scripts/release-mac.sh` for the Mac.

## Release

The inherited `sh app/scripts/release.sh X.Y.Z` script sets the version, tags it and pushes; review its repository and signing configuration before using it for a fork. This subscription build disables upstream automatic updates so an official Yogurt release cannot replace the provider integration. Distribute this fork’s builds separately and configure an independent update feed before enabling automatic updates.
