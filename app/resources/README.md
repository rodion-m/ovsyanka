# OpenRouter transcription probe audio

`openrouter-test.wav` is a 2.8-second, mono, 16 kHz, signed 16-bit PCM Russian speech sample used only when a person presses **Test** for the transcription model. It is bundled so the app never invokes a text-to-speech utility at runtime. File size is 90,022 bytes.

Created once on macOS with:

```sh
say -v Milena -r 170 -o /tmp/yogurt-openrouter-smoke.aiff 'Привет. Это короткая проверка расшифровки.'
ffmpeg -y -v error -i /tmp/yogurt-openrouter-smoke.aiff -ar 16000 -ac 1 -sample_fmt s16 app/resources/openrouter-test.wav
```
