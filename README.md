<p align="center">
  <a href="https://yogurt.so?utm_source=github&utm_medium=readme&utm_campaign=yogurt">
    <img src="docs/assets/readme-header.svg" width="212" height="86" alt="Yogurt. Take note.">
  </a>
</p>

<p align="center">
  AI meeting notes with agy and Porch provider support. An open-source fork of Yogurt.
</p>

<p align="center">
  <a href="docs/subscription-harness.md">Настройка agy / Porch · Provider setup</a> · <a href="docs/building.md">Build this fork from source</a>
</p>

<p align="center">
  <img src="docs/assets/yogurt-screenshot.webp" width="1074" alt="Yogurt showing the Summary of a launch planning meeting: the plan, next steps by person, and your own reminders">
</p>

<p align="center">
  Yogurt records your calls without adding a bot to the meeting.
</p>
<p></p>
<p align="center">
  <sub>macOS 14.4+ (Apple Silicon) · Windows 10 2004+ (x64) · Ubuntu 22.04+ or similar (x64 AppImage) · 8 GB memory</sub><br><br>
  <a href="https://yogurt.so?utm_source=github&utm_medium=readme&utm_campaign=yogurt">yogurt.so</a> · <a href="docs/README.md">Help</a> · <a href="docs/building.md">Build and run locally</a> · <a href="LICENSE">MIT license</a><br><br>
  Made by <a href="https://frigade.com?utm_source=github&utm_medium=readme&utm_campaign=yogurt">Frigade</a>.
</p>

## What it does

- **Provider choice.** Fresh installs use agy with Gemini 3.8 Flash and medium thinking for audio and text. Select exact Porch profiles or local models in Settings → AI processing.
- **Live transcripts.** Yogurt records calls and turns speech into text as you talk.
- **Meeting summaries.** Yogurt writes up the conversation and any notes you add.
- **Local storage, explicit processing mode.** Meetings are saved on your computer. agy and Porch send audio and text to the chosen providers; local mode processes them on your computer.
- **Open source.** Yogurt is MIT-licensed. Provider modes require separately installed, authenticated CLIs and an eligible account; local mode needs no provider account.
- **Who said what.** Yogurt names speakers from Zoom, Teams and Meet on Mac only.
- **Russian support.** Choose Russian as the spoken language and as the AI output language independently of the interface language.
- **Recording reminders.** Yogurt offers to record when a supported call starts.
- **Answers with sources.** Yogurt answers questions across meetings and links to the source.
- **Folders and search.** You can find meetings by folder, title, notes or transcript.
- **Copy and export.** You can copy notes or transcripts, or save both as Markdown.
- **Local MCP server.** Your chosen assistant app can read your notes when you allow access.
- **Automatic stop.** Yogurt stops recording when the call ends.

## Watch the demo

https://github.com/user-attachments/assets/da16b894-beb1-491a-89e1-fd10666dc9b8

## How it works

1. **Record.** Start recording your microphone and call audio; you can add your own notes.
2. **Transcribe.** The default agy adapter sends real WAV audio to Gemini 3.8 Flash with medium thinking. Porch uses an exact agy audio profile. Local mode uses whisper.cpp and, on supported Macs, Apple SpeechAnalyzer.
3. **Summarize and ask.** Summaries, titles, rewrites, Ask and folder suggestions share the selected text provider. Local mode uses llama.cpp.

Provider mode skips local speech, notes and embedding model downloads, GPU probing and local model loading. Library Ask uses keyword retrieval without embeddings in this mode. Settings remain accessible even when a CLI is missing, and provider changes apply after restart.

See the [Russian-first provider guide](docs/subscription-harness.md) for authentication, exact Porch profiles, privacy, compatibility and known limitations. Upstream Yogurt installers do not include this fork’s changes. Live provider quality and account access must be verified in your environment; this repository’s automated adapter tests use stand-ins.

<details><summary>Where your meetings, recordings, settings and models are stored</summary>

- Mac uses `~/Library/Application Support/Yogurt`.
- Windows uses `%APPDATA%\Yogurt`.
- Linux uses `~/.config/Yogurt`, or `$XDG_CONFIG_HOME/Yogurt` if set.

</details>

## FAQ

<details><summary><strong>What kind of computer do I need?</strong></summary>

<br>

> Recording requires a Mac with Apple silicon and macOS 14.4 or newer, a 64-bit PC with Windows 10 (version 2004) or newer, or a compatible 64-bit Linux computer. Local model mode checks memory and transcription speed during setup. Provider mode skips those model checks but requires internet access and the selected CLI. Calendar and speaker names from calls are Mac only for now.

</details>

<details><summary><strong>Windows says “Windows protected your PC.” What do I do?</strong></summary>

<br>

> Click More info, then Run anyway. Windows shows this for new apps that aren’t signed with a Microsoft certificate yet. Yogurt is open source, so anyone can check what it does.

</details>

<details><summary><strong>Does Yogurt join my meetings?</strong></summary>

<br>

> No. Yogurt records your microphone and the sound playing on your computer. No bot joins the call, so let the other people on the call know you’re recording.

</details>

<details><summary><strong>Are recordings saved?</strong></summary>

<br>

> Yes. Your recordings, transcripts, and notes are saved locally on your computer.

</details>

<details><summary><strong>Is Yogurt free?</strong></summary>

<br>

> Yogurt is free and open source under the MIT license. Local processing needs no provider account. agy and Porch use separately configured provider accounts, whose plans, quotas and terms apply.

</details>

<details><summary><strong>Does Yogurt work offline?</strong></summary>

<br>

> Local mode works offline after downloading its models. agy and Porch need network access for AI processing; existing notes and recordings remain stored on your computer.

</details>

<details><summary><strong>How much does setup download?</strong></summary>

<br>

> The default provider mode downloads no local AI models. Local mode downloads speech, notes and embedding models selected for your computer, including an optional larger notes model. CLI installation and the app’s native build dependencies are separate from model downloads.

</details>

<details><summary><strong>How do I connect my assistant app?</strong></summary>

<br>

> In **Settings → AI apps**, turn on access, copy the helper command, and add it as a local MCP server in your assistant app. Access is off by default. The app can read your meetings, notes and transcripts, but cannot change them. It may send what it reads to its own online model. Turn access off in Yogurt to stop further reads.

</details>

<details><summary><strong>Can other apps read my notes through MCP?</strong></summary>

<br>

> Access is off until you enable it in **Settings → AI apps**. Apps get read-only access to meetings, notes and transcripts. Mac and Linux use a socket in your profile folder with `0600` permissions, so only your user account can open it. Windows uses a named pipe with a new random name each launch, stored only in your profile folder. There is no per-app token, so any app running under your account can read while access is on. Settings shows connected apps by their self-reported names.

</details>

<details><summary><strong>Which AI models does Yogurt use?</strong></summary>

<br>

> Fresh installs use `gemini-3.8-flash` with `medium` effort through agy for transcription and text. Settings can select another supported model or exact Porch profiles. Porch transcription requires an agy profile; text follows the chosen profile. Local mode retains the original Whisper and local text-model pipeline.

</details>

<details><summary><strong>Which languages does Yogurt support?</strong></summary>

<br>

> Choose **Russian**, **English only** or **Multi-language** under **Settings → Language → Spoken language**, or use the note footer. Set **AI processing → AI output language** to Automatic, Russian or English separately. Automatic summaries follow the meeting’s language and answers follow the question. The interface language is independent. This fork’s provider settings are translated into Russian and English, with English fallback for other interface languages.

</details>

<details><summary><strong>Which call apps does Yogurt work with?</strong></summary>

<br>

> You can record calls in any app because Yogurt captures your microphone and system audio. Call detection covers Zoom, Teams and Meet. On Mac, Yogurt can also read their speaker names with Accessibility permission, when the call app shows who is speaking.

</details>

<details><summary><strong>How does Yogurt know a call has started?</strong></summary>

<br>

> It checks which apps are using your microphone. For browser calls, it also checks the tab title or a nearby calendar event with a call link. This triggers an offer to record; recording starts only when you choose to.

</details>

<details><summary><strong>How do I connect my calendar?</strong></summary>

<br>

> On Mac, allow Calendar access in Settings. Yogurt reads the calendars already on your computer and lets you choose which ones to show. You do not sign into a calendar account in Yogurt.

</details>

## Build from source

See [Build and run locally](docs/building.md) for setup, tests and installer builds.

## License

[MIT](LICENSE) · Copyright 2026 Frigade.
