# Yogurt help

Yogurt records your microphone and call audio, transcribes the meeting, and writes a Summary alongside your own notes. No bot joins the call. This fork defaults to agy with Gemini 3.8 Flash and medium thinking; audio and text are processed by the selected provider. Local model mode remains available.

Start with [Настройка agy / Porch — provider setup](subscription-harness.md) for the Russian-first guide, account setup, profiles, privacy and limitations.

## Install

Build this fork using [Build and run locally](building.md). [Upstream Yogurt releases](https://github.com/FrigadeHQ/yogurt/releases/latest) contain the original local-model app, not these provider adapters. Installer formats and recording requirements are:

- **Mac:** Apple Silicon, macOS 14.4 or later. Open the DMG, drag Yogurt into Applications, then open it from Applications.
- **Windows:** Windows 10 version 2004 or later, x64. Run the `.exe` installer. The installer isn't signed yet: if Windows says it protected your PC, click More info, then Run anyway.
- **Linux:** x64, Ubuntu 22.04 or a compatible newer system, with PulseAudio or PipeWire. Make the `.AppImage` executable in its file properties, then open it. If it doesn't open, install FUSE 2 first: `sudo apt install libfuse2` on Ubuntu 22.04, `sudo apt install libfuse2t64` on 24.04 and newer. GNOME needs the AppIndicator extension to show the tray icon.

On first run, provider mode opens without downloading AI models or probing a GPU. Open **Settings → AI processing** to configure agy or Porch. A missing CLI does not block access to Settings. **Check executable** checks only availability/version; it does not test credentials, model availability or subscription eligibility. Save changes and restart after current recording and transcription finish.

Selecting **Local models** enables the original downloads and hardware checks after restart. Notes and questions work offline once those models are installed. Calendar access and speaker names from calls are available on Mac only.

## Mac permissions

Microphone and call audio access let Yogurt hear both sides of a meeting. Allow them during setup, or open Settings in Yogurt to change them later. macOS lists call audio under Screen & System Audio Recording.

The other permissions are optional:

- **Calendar:** show upcoming meetings and use their titles and attendees.
- **Notifications:** offer to take notes when a call starts.
- **Accessibility:** read speaker names from supported call apps.

If a permission is off, use its button in Yogurt's Settings to open the right system pane. After changing it, return to Yogurt. Recording always waits for your click.

## Privacy

Meetings, recordings, transcripts and notes are saved on your computer. In **agy** or **Porch** mode, the audio and text needed for transcription and text features are sent to the selected provider through its CLI. Authentication and provider-side retention are managed by the CLI/provider. Yogurt stores the selected executable, model/profile and language settings, not provider credentials.

In **Local models** mode, AI processing runs on your computer. That mode downloads model files and, on supported Macs, may download Apple’s speech assets. Provider mode skips those downloads, including embeddings, and uses keyword retrieval for library Ask. Links open in your browser. Copying and exporting does not upload your content.

If you [connect an AI app](#connect-an-ai-app), it may send what it reads to its own online model.

## Your data

Meetings, recordings, settings and downloaded models live here:

| Computer | Folder |
| --- | --- |
| Mac | `~/Library/Application Support/Yogurt` |
| Windows | `%APPDATA%\Yogurt` |
| Linux | `~/.config/Yogurt` (or `$XDG_CONFIG_HOME/Yogurt` if set) |

## Backup and restore

Finish any recording, then open **Settings → Backup** to export your meetings and audio to one ZIP file. Meetings in the Trash are not included.

Import a backup from the same section. It adds meetings that are missing and leaves existing meetings unchanged. Backups work across Mac, Windows and Linux.

## Connect an AI app

In **Settings → AI apps**, turn on access, copy the helper command, and add it as a local MCP server in your AI app. MCP lets that app read your meetings, notes and transcripts; it cannot change them. Yogurt does not edit the other app's configuration.

Access is off by default. A connected AI app may send what it reads to its own online model. Turn access off in Yogurt to stop further reads.

## Uninstall

Quit Yogurt first. On Mac, move Yogurt from Applications to the Trash. On Windows, uninstall it from Settings → Apps. On Linux, delete the AppImage.

Removing the app keeps your data. To remove that too, export a backup if you want one, then delete the Yogurt data folder listed above. This permanently removes your local meetings, recordings, settings and models.

## Report a problem

Report provider-integration problems to this fork’s maintainer, including your operating system, Yogurt and CLI versions, what you did, what you expected and what happened. Use [upstream issues](https://github.com/FrigadeHQ/yogurt/issues) for problems reproduced in the original app. Leave private meeting content and credentials out of screenshots and reports.
