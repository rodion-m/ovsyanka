# План: удобный выбор моделей и поддержка OpenRouter

Состояние на 18 ноября 2026 года, ветка `feat/subscription-harness`. Это проект решения, кода в нём нет.
Данные OpenRouter (схема списка моделей, цены, число моделей) сняты с живого API 18 ноября 2026 года без ключа.
Запросов с ключом не было, поэтому всё, что требует ключа, помечено «не проверено» и вынесено в этап 0.

## 1. Контекст и цели

### Что не так сейчас

Экран **Настройки → Обработка ИИ** (`AiSettings.tsx`):

1. «Профиль расшифровки», «Профиль для текста», «Модель расшифровки», «Модель для текста» — свободные текстовые поля. Нужно помнить точный ID и не ошибиться в символе.
2. Строка «Режим обработки» показывает сохранённое значение («Профили Porch»), а «Сейчас используется» — действующее («agy»), когда приложение запущено с `YOGURT_AI_BACKEND=agy`. Два противоречащих значения рядом и длинный абзац про переменные окружения вместо ответа «что сейчас работает и почему».
3. Провайдера с оплатой по API-ключу нет: только подписочные CLI (agy, Porch) и локальные модели.

### Цели

1. Один понятный элемент выбора модели или профиля для всех режимов: выпадающий список с поиском, подсказками и возможностью ввести свой ID (в том числе для agy).
2. Никаких противоречащих значений: поле всегда показывает то, что реально будет работать, а если оно задано переменной окружения — заблокировано с одной короткой фразой.
3. Новый режим **OpenRouter** для расшифровки и для текста (конспекты, заголовки, вопросы): ключ в Связке ключей, список моделей с сортировкой по новизне и отбором «для расшифровки» / «для текста», понятные сообщения об ошибках и расходе.
4. Работа режется на небольшие этапы для отдельных исполнителей.

### Что не входит

- Переделка конвейера пакетов (`asr/pipeline.ts`, `asr/batch.ts`): OpenRouter подключается к существующему контракту `createHarnessTranscriber`.
- Смена модели без перезапуска приложения. Сегодня одна конфигурация действует весь запуск (`harness/ipc.ts`); это остаётся, см. открытый вопрос 5.
- Выбор локальных моделей: в локальном режиме они подбираются автоматически под железо (`catalog/catalog.json`).

## 2. UX-дизайн

### 2.1. Общая схема экрана

Сверху одна строка состояния, ниже — выбор режима, ниже — поля выбранного режима. Абзац про переменные окружения и отдельный блок «Сейчас используется» с тремя строками убираются.

```
Обработка ИИ
Как Yogurt расшифровывает аудио, пишет конспекты и отвечает на вопросы.

┌─────────────────────────────────────────────────────────────────────────┐
│ ● Сейчас работает: agy · Gemini 3.8 Flash                               │
│   Сохранено: OpenRouter · Gemini 3.8 Flash — применится после           │
│   перезапуска.                                      [Перезапустить]     │
├─────────────────────────────────────────────────────────────────────────┤
│ Режим обработки         [ OpenRouter · по API-ключу              ▾ ]    │
│                                                                         │
│   … поля выбранного режима (разделы 2.3–2.6) …                          │
│                                                                         │
│ Язык ответов ИИ         [ Автоматически                          ▾ ]    │
│ ▸ Дополнительные настройки                                              │
├─────────────────────────────────────────────────────────────────────────┤
│ [Сохранить изменения]                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

Правила строки состояния:

| Ситуация | Что видно |
| --- | --- |
| Сохранённое совпадает с действующим | Одна строка: «Сейчас работает: agy · Gemini 3.8 Flash». |
| Сохранено другое, перезапуска ещё не было | Вторая строка «Сохранено: … — применится после перезапуска» и кнопка «Перезапустить». |
| Расшифровка и текст на разных моделях | «Сейчас работает: OpenRouter · расшифровка Gemini 3.8 Flash, текст GPT-6.2 Sol». |
| Режим задан переменной окружения | Вторая строка не показывается; объяснение стоит у заблокированного поля (2.2). |

Пункты «Режима обработки» (тот же выпадающий список, без поиска и без своего варианта):

| Пункт (RU) | Пункт (EN) | Вторая строка пункта (RU / EN) |
| --- | --- | --- |
| OpenRouter | OpenRouter | по API-ключу, оплата за использование / API key, pay per use |
| agy · Antigravity CLI | agy · Antigravity CLI | подписка Google через CLI / Google subscription via the CLI |
| Профили Porch | Porch profiles | свои профили pragmatic-orchestration / your pragmatic-orchestration profiles |
| На этом Mac | On this Mac | локальные модели, работает без интернета / local models, works offline |

В локальном режиме вместо списков показываются две строки только для чтения в том же оформлении: «Расшифровка: Whisper — подбирается под этот Mac», «Текст: подбирается под этот Mac». Выбирать там нечего, но экран выглядит так же, как в остальных режимах.

### 2.2. Поле, заданное переменной окружения

Поле показывает **действующее** значение, выключено, под ним одна фраза с именем переменной. Сохранённое значение при этом не показывается и не перезаписывается.

```
Режим обработки         [ agy · Antigravity CLI                   🔒 ]
                        Задано при запуске переменной YOGURT_AI_BACKEND.
                        Здесь изменить нельзя.
```

Ниже показываются поля действующего режима (agy), а не сохранённого. Остальные поля редактируются как обычно. То же правило для `YOGURT_AGY_PATH`, `YOGURT_PORCH_PATH` и ключа OpenRouter из переменной (3.2).

### 2.3. Список выбора модели или профиля (один компонент для всех режимов)

Закрытое состояние — поле с названием, под ним мелкая строка с точным ID и ключевыми фактами:

```
Модель расшифровки      [ Gemini 3.8 Flash                        ▾ ]  [Проверить]
                        google/gemini-3.8-flash · ≈ $0.22 за час речи · на OpenRouter с сен 2026
```

Открытое состояние. Само поле становится строкой поиска, список открывается под ним:

```
Модель расшифровки      [ gem|                                    ✕ ]
                        ┌───────────────────────────────────────────────────────┐
                        │ Сначала: (Новые) Дешёвые          Обновлён 2 ч назад ⟳ │
                        │ РЕКОМЕНДУЕМ                                            │
                        │ ✓ Gemini 3.8 Flash               аудио · проверена     │
                        │   google/gemini-3.8-flash    ≈ $0.22/ч · сен 2026      │
                        │ АУДИОМОДЕЛИ · учитывают имена и словарь встречи        │
                        │   Gemini 4 Hydrogen              аудио                 │
                        │   google/gemini-4-hydrogen   ≈ $0.40/ч · ноя 2026      │
                        │   Gemini 4 Carbon                аудио                 │
                        │   google/gemini-4-carbon     ≈ $0.53/ч · ноя 2026      │
                        │ МОДЕЛИ РАСШИФРОВКИ (STT) · быстрые, без словаря        │
                        │   Gemini 3.5 Transcribe          по токенам            │
                        │   google/gemini-3.5-transcribe  $2 / млн · сен 2026    │
                        ├───────────────────────────────────────────────────────┤
                        │ ＋ Использовать свой ID: «gem»                          │
                        └───────────────────────────────────────────────────────┘
```

Цифры в примере посчитаны по живому списку 18 ноября 2026 года по формуле из раздела 4.5; это оценки.

Как это работает для человека:

- **Группы** идут сверху вниз: «Рекомендуем» (то, что команда проверила в Yogurt), затем остальные по назначению, внизу «Бесплатные (с лимитом запросов)» и «Недоступные» (если есть).
- **Подсказки-метки** — короткие слова справа от названия: «аудио», «проверена», «быстрая», «дешёвая», «бесплатная», «по токенам», «скоро отключат», «свой ID», «нет в списке». Метка всегда текстом, не только цветом.
- **Поиск** ищет по названию, ID и производителю, без учёта регистра; несколько слов — все должны совпасть («gemini flash»).
- **Свой ID.** Если набранного текста нет в списке, последней строкой появляется «Использовать свой ID: «…»». Выбранный свой ID показывается с меткой «свой ID». Для agy это ID модели (`gemini-4-hydrogen`), для Porch — ID профиля, для OpenRouter — `производитель/модель`.
- **Сортировка** (только OpenRouter): «Новые» (по умолчанию) или «Дешёвые». Группа «Рекомендуем» всегда сверху.
- **Обновление**: значок ⟳ перечитывает список; рядом время последнего обновления.
- **Кнопка «Проверить»** рядом с полем делает один короткий настоящий запрос к выбранной модели и показывает результат под полем (2.7).

Состояния списка:

| Состояние | Что видно (RU) | EN |
| --- | --- | --- |
| Загрузка | «Загружаем список…» и три серые строки; текущее значение остаётся выбранным | "Loading the list…" |
| Список из кэша, сети нет | «Нет связи. Показан список от 12 ноября.» [Повторить] | "No connection. Showing the list from 12 November." [Try again] |
| Списка нет совсем | «Список недоступен. Введите ID модели вручную.» [Повторить] | "The list is unavailable. Type a model ID instead." |
| Ничего не найдено | «Ничего не найдено. Можно использовать «xyz» как свой ID.» | "Nothing found. You can use "xyz" as a custom ID." |
| Недопустимый свой ID | Строка «свой ID» серая: «В ID допустимы латинские буквы, цифры и знаки . - _ / :» | "IDs may contain Latin letters, digits and . - _ / :" |
| Выбранного значения нет в свежем списке | Метка «нет в списке» у поля и фраза из 2.8 | "not in the list" |
| Задано переменной окружения | Поле выключено, фраза из 2.2 | — |

Клавиатура и экранный диктор (шаблон WAI-ARIA «combobox со списком»):

- Поле — `role="combobox"` с `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`; список — `role="listbox"`, группы — `role="group"` с подписью, строки — `role="option"` с `aria-selected`; недоступные — `aria-disabled` с причиной в тексте.
- `↓`/`↑` открывают список и двигают выделение (фокус остаётся в поле), `Enter` выбирает, `Esc` закрывает и возвращает прежнее значение, `Tab` закрывает без изменения и идёт дальше. Ввод текста фильтрует.
- Название, ID, метки, цена и дата входят в читаемое имя строки. Число найденных строк объявляется через `role="status"`: «Найдено 12».
- Подпись поля связана через `label for`, пояснение и результат проверки — через `aria-describedby`. Видимое кольцо фокуса, цель клика не меньше 28 px по высоте.

### 2.4. Режим agy

```
Режим обработки         [ agy · Antigravity CLI                   ▾ ]
Модель расшифровки      [ Gemini 3.8 Flash                        ▾ ]  [Проверить]
                        gemini-3.8-flash · рекомендуем
Рассуждение при расшифровке   [ Средний · medium                  ▾ ]
Модель для текста       [ Gemini 3.8 Flash                        ▾ ]  [Проверить]
Рассуждение для текста  [ Средний · medium                        ▾ ]
```

- Список = встроенный в приложение перечень (раздел 3.3) с метками «аудио», «проверена», плюс свой ID.
- Для расшифровки показываются только модели с меткой «аудио» (Gemini); остальные доступны через свой ID.
- По ⟳ список дополняется тем, что вернула команда `agy models` (нужен вход в аккаунт). Если команда не сработала, остаётся встроенный перечень и фраза «Не удалось получить список из agy. Показан встроенный список.»
- «Рассуждение» предлагает только уровни, которые есть у выбранной модели; для расшифровки `low` не предлагается никогда (он обрезает длинное аудио).

### 2.5. Режим Porch

```
Профиль расшифровки     [ Antigravity Gemini 3.8 Flash            ▾ ]  [Проверить]
                        agy-gemini-3.8-flash · модель gemini-3.8-flash
Рассуждение при расшифровке   [ Средний · medium                  ▾ ]
Профиль для текста      [ Claude Opus                             ▾ ]  [Проверить]
                        claude-opus · claude-code · модель opus
```

- Список берётся из `porch --list-agents` (ID, название, backend, модель, доступность).
- **Для расшифровки** показываются только профили, которые `porch media capabilities --json` перечисляет в `transcribe` (сегодня это профили на базе agy). Остальные в этот список не попадают вообще.
- **Для текста** показываются все профили, сгруппированные по backend («Antigravity», «Claude Code», «Codex», «Grok», «OpenCode»…). Профили с `backend-available="false"` уходят в группу «Недоступные» с причиной «CLI этого профиля не установлен».
- Отдельное поле «Модель расшифровки» из основного экрана убирается: при выборе профиля модель берётся из профиля. Переопределение остаётся в «Дополнительных настройках» («Модель расшифровки вместо модели профиля»).
- Фраза под текстовым профилем: «Модель и уровень рассуждения для текста задаёт сам профиль.»

### 2.6. Режим OpenRouter

```
Режим обработки         [ OpenRouter · по API-ключу               ▾ ]

API-ключ                [ sk-or-v1-••••••••••••••••3f9a ]  [Заменить] [Удалить]
                        ✓ Ключ работает · «Yogurt» · остаток по ключу $4.20
                        Ключ хранится в Связке ключей macOS и не попадает в файлы настроек.

Модель расшифровки      [ Gemini 3.8 Flash                        ▾ ]  [Проверить]
                        google/gemini-3.8-flash · ≈ $0.22 за час речи · на OpenRouter с сен 2026
Рассуждение при расшифровке   [ Средний · medium                  ▾ ]

[✓] Та же модель для конспектов и вопросов

Модель для текста       [ Gemini 3.8 Flash                        ▾ ]  [Проверить]
                        google/gemini-3.8-flash · $0.83 / $4.13 за млн токенов · контекст 1 млн

Кому можно передавать данные  [ Только провайдерам без хранения и обучения ▾ ]

Расход: сегодня $0.12 · за 30 дней $1.80 (по ответам OpenRouter)
🔒 Аудио и текст встреч уходят в OpenRouter и к провайдеру выбранной модели.
```

Правила:

- **Одна модель или разные.** Флажок «Та же модель для конспектов и вопросов» включён по умолчанию и доступен, когда модель расшифровки — аудиомодель (она умеет и текст). При включённом флажке поле «Модель для текста» повторяет выбор и выключено. Если для расшифровки выбрана модель из группы STT (она текст не пишет), флажок выключается сам с фразой «Эта модель только расшифровывает. Для текста выберите другую.»
- **Список для расшифровки** — три группы: «Рекомендуем», «Аудиомодели · учитывают имена и словарь встречи», «Модели расшифровки (STT) · быстрые, без словаря». **Список для текста** — «Рекомендуем», затем все подходящие по новизне. Правила отбора — раздел 4.
- **«Кому можно передавать данные»**: «Только провайдерам без хранения и обучения» (по умолчанию) / «Только с нулевым хранением (ZDR)» / «Любым провайдерам модели». Подпись: «Строже правило — меньше доступных провайдеров; модель может оказаться недоступной.»
- **Расход** показывается только после первых запросов; «остаток по ключу» — только если у ключа задан лимит, иначе «у ключа нет лимита».

#### Первый запуск режима OpenRouter

1. Человек выбирает «OpenRouter». Видно поле ключа, ссылка «Получить ключ на openrouter.ai» (открывает браузер), фраза о приватности. Списки моделей уже работают (для списка ключ не нужен), стоят значения по умолчанию.
2. Вставляет ключ. Как только текст похож на ключ OpenRouter, приложение само проверяет его (бесплатный запрос, 1–2 с): «✓ Ключ работает · остаток $…» или понятная ошибка. Ключ сразу сохраняется в Связке ключей; кнопка «Сохранить» для ключа не нужна.
3. Модели по умолчанию — Gemini 3.8 Flash для расшифровки и текста. Рядом подсказка: «Нажмите «Проверить», чтобы убедиться, что модель отвечает (один короткий запрос, меньше цента)».
4. «Сохранить изменения» → строка состояния предлагает «Перезапустить».

Совет под полем ключа до его ввода: «Задайте лимит расходов на ключ в кабинете OpenRouter: тогда утёкший ключ не потратит весь баланс.»

### 2.7. Кнопка «Проверить»

| Что проверяется | Что делает | Результат под полем |
| --- | --- | --- |
| Ключ OpenRouter | Бесплатный запрос сведений о ключе | «✓ Ключ работает · «название» · остаток по ключу $4.20» |
| Текстовая модель (любой режим) | Один запрос «ответь OK» | «✓ Модель ответила за 2,1 с» (для OpenRouter ещё « · $0.0004») |
| Модель или профиль расшифровки | Отправляет встроенную 5-секундную запись (не ваши встречи) и проверяет, что вернулся текст с таймкодами | «✓ Расслышала: «Проверка связи, раз, два, три» · 3,4 с» |
| CLI (agy, Porch) | Как сейчас: только наличие и версия, в «Дополнительных настройках» | без изменений |

Под кнопкой для agy и Porch: «Проверка делает один настоящий запрос и расходует квоту подписки.» Для OpenRouter выбор модели расшифровки из группы STT проверяется автоматически при сохранении: без таймкодов Yogurt не может привязать текст ко времени встречи, такую модель сохранить нельзя.

### 2.8. Сообщения об ошибках и расходе

Все сообщения говорят, что случилось, что с записью и что сделать. Аудио при любой ошибке расшифровки остаётся на диске и дорасшифровывается кнопкой «Повторить» (существующий механизм `pending-audio/`).

| Ситуация | RU | EN |
| --- | --- | --- |
| Ключа нет | Добавьте API-ключ OpenRouter в настройках. Запись идёт, расшифровка начнётся после добавления ключа. | Add your OpenRouter API key in Settings. Recording continues; transcription starts once the key is added. |
| Ключ неверный, удалён или просрочен | OpenRouter не принял ключ. Проверьте или замените его в настройках. Аудио сохранено. | OpenRouter rejected the key. Check or replace it in Settings. Your audio is kept. |
| Вставлен ключ другого сервиса | Это не ключ OpenRouter. Он начинается с «sk-or-v1-». | This isn't an OpenRouter key. It starts with "sk-or-v1-". |
| Кончились кредиты | На счёте OpenRouter закончились кредиты. Пополните счёт и нажмите «Повторить». Аудио сохранено. | Your OpenRouter credits have run out. Add credits, then press Retry. Your audio is kept. |
| Исчерпан лимит ключа или бюджет | Достигнут лимит расходов этого ключа. Увеличьте лимит в кабинете OpenRouter или дождитесь сброса. | This key's spending limit is reached. Raise it in your OpenRouter account or wait for the reset. |
| Слишком много запросов | OpenRouter просит подождать. Yogurt повторит запрос сам. | OpenRouter asked to wait. Yogurt will retry by itself. |
| Модель пропала | Модели «…» больше нет в OpenRouter. Выберите другую в настройках. Аудио сохранено. | The model "…" is no longer on OpenRouter. Choose another in Settings. Your audio is kept. |
| Модель скоро отключат | OpenRouter отключит эту модель 22 декабря. Выберите другую заранее. | OpenRouter will remove this model on 22 December. Choose another one in advance. |
| Нет провайдера под правило данных | Ни один провайдер этой модели не подходит под правило «без хранения». Смягчите правило или выберите другую модель. | No provider of this model meets the "no retention" rule. Relax the rule or choose another model. |
| Провайдер недоступен, тайм-аут, нет сети | Не удалось связаться с OpenRouter. Yogurt повторит попытку; аудио сохранено. | Couldn't reach OpenRouter. Yogurt will retry; your audio is kept. |
| Модель не вернула таймкоды | Эта модель не возвращает время фраз, Yogurt не может её использовать. Выберите другую. | This model doesn't return phrase timings, so Yogurt can't use it. Choose another. |
| Ответ отклонён модерацией | Провайдер отказался обрабатывать этот фрагмент. Попробуйте другую модель. | The provider declined to process this part. Try another model. |
| Связка ключей недоступна | Не удалось сохранить ключ в Связке ключей. Ключ не сохранён. | Couldn't save the key to Keychain. The key was not saved. |
| Ключ не читается (другая сборка приложения) | Сохранённый ключ не читается в этой сборке. Введите его заново. | The saved key can't be read by this build. Enter it again. |

Остальные новые подписи:

| Ключ | RU | EN |
| --- | --- | --- |
| `activeNow` | Сейчас работает | Active now |
| `savedPending` | Сохранено: {x} — применится после перезапуска. | Saved: {x} — applies after restart. |
| `lockedByEnv` | Задано при запуске переменной {VAR}. Здесь изменить нельзя. | Set at launch by {VAR}. It can't be changed here. |
| `pickerSearch` | Найти модель или ввести свой ID | Find a model or type your own ID |
| `pickerCustom` | Использовать свой ID: «{x}» | Use custom ID: "{x}" |
| `pickerCount` | Найдено {n} | {n} found |
| `sortNewest` / `sortCheapest` | Новые / Дешёвые | Newest / Cheapest |
| `listUpdated` | Обновлён {когда} | Updated {when} |
| `refresh` | Обновить список | Refresh the list |
| `groupRecommended` | Рекомендуем | Recommended |
| `groupAudio` | Аудиомодели · учитывают имена и словарь встречи | Audio models · use meeting names and vocabulary |
| `groupStt` | Модели расшифровки (STT) · быстрые, без словаря | Speech-to-text models · fast, no vocabulary |
| `groupFree` | Бесплатные · с лимитом запросов | Free · request limits apply |
| `groupUnavailable` | Недоступные | Unavailable |
| `hintAudio` / `hintVerified` / `hintFast` / `hintCheap` | аудио / проверена / быстрая / дешёвая | audio / verified / fast / cheap |
| `hintFree` / `hintTokens` / `hintExpiring` | бесплатная / по токенам / скоро отключат | free / per token / ending soon |
| `hintCustom` / `hintMissing` | свой ID / нет в списке | custom ID / not in the list |
| `pricePerHour` | ≈ ${x} за час речи | ≈ ${x} per hour of speech |
| `pricePerMillion` | ${in} / ${out} за млн токенов | ${in} / ${out} per million tokens |
| `addedOn` | на OpenRouter с {мес год} | on OpenRouter since {mon year} |
| `test` / `testing` | Проверить / Проверяем… | Test / Testing… |
| `testQuota` | Проверка делает один настоящий запрос и расходует квоту подписки. | The test makes one real request and uses your subscription quota. |
| `keyLabel` | API-ключ | API key |
| `keyGet` | Получить ключ на openrouter.ai | Get a key at openrouter.ai |
| `keyStored` | Ключ хранится в Связке ключей macOS и не попадает в файлы настроек. | The key is stored in the macOS Keychain and never in settings files. |
| `keyOk` | Ключ работает · «{label}» · остаток по ключу ${x} | Key works · "{label}" · ${x} left on this key |
| `keyNoLimit` | у ключа нет лимита | this key has no limit |
| `keyAdvice` | Задайте лимит расходов на ключ в кабинете OpenRouter: тогда утёкший ключ не потратит весь баланс. | Set a spending limit on the key in your OpenRouter account, so a leaked key can't spend your whole balance. |
| `keyReplace` / `keyRemove` | Заменить / Удалить | Replace / Remove |
| `sameModel` | Та же модель для конспектов и вопросов | Same model for summaries and questions |
| `sttOnly` | Эта модель только расшифровывает. Для текста выберите другую. | This model only transcribes. Choose another one for text. |
| `dataPolicy` | Кому можно передавать данные | Who may receive your data |
| `dataDeny` / `dataZdr` / `dataAny` | Только провайдерам без хранения и обучения / Только с нулевым хранением (ZDR) / Любым провайдерам модели | Only providers that don't store or train / Zero data retention only / Any provider of the model |
| `dataHelp` | Строже правило — меньше доступных провайдеров; модель может оказаться недоступной. | A stricter rule leaves fewer providers; the model may become unavailable. |
| `spend` | Расход: сегодня ${a} · за 30 дней ${b} (по ответам OpenRouter) | Spent: ${a} today · ${b} in 30 days (from OpenRouter responses) |
| `privacyOpenRouter` | Аудио и текст встреч уходят в OpenRouter и к провайдеру выбранной модели. Встречи и заметки хранятся на этом Mac. | Meeting audio and text go to OpenRouter and the selected model's provider. Meetings and notes stay on this Mac. |
| `porchTextNote` | Модель и уровень рассуждения для текста задаёт сам профиль. | The profile itself sets the model and thinking level for text. |
| `agyListFailed` | Не удалось получить список из agy. Показан встроенный список. | Couldn't get the list from agy. Showing the built-in list. |

## 3. Техническое решение

### 3.1. Модель настроек

`app/src/shared/ai.ts` (поля остаются плоскими, чтобы `validAiSettings` продолжал сравнивать поле в поле):

```ts
export type AiBackend = 'agy' | 'porch' | 'openrouter' | 'local'
export type OpenRouterAudioKind = 'chat' | 'stt'          // какой API обслуживает модель расшифровки
export type OpenRouterDataPolicy = 'deny' | 'zdr' | 'any'

type AiSettings = {
  // …существующие поля без изменений…
  openrouterTranscriptionModel: string      // по умолчанию 'google/gemini-3.8-flash'
  openrouterTranscriptionKind: OpenRouterAudioKind   // 'chat'; записывается при выборе из списка
  openrouterTextModel: string               // по умолчанию 'google/gemini-3.8-flash'
  openrouterDataPolicy: OpenRouterDataPolicy // 'deny'
}
```

- ID модели OpenRouter: `^~?[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$`, до 200 символов. Для своего ID вид (`chat`/`stt`) определяется по списку моделей; если ID в списке нет — `chat`.
- `transcriptionEffort` и `textEffort` используются и для OpenRouter.
- Флажок «та же модель» не хранится: он включён, когда вид `chat` и оба ID равны.
- `YOGURT_AI_BACKEND` принимает `openrouter` (`main/settings.ts`, текст ошибки обновить).
- Комментарий «Yogurt never stores API keys» в `shared/ai.ts` заменить: ключ хранится, но не в настройках.

Блокировки переменными окружения — вместо списка `environmentOverrides`:

```ts
type AiLockedField = 'backend' | 'agyPath' | 'porchPath' | 'openrouterKey'
type AiPreferences = {
  saved: AiSettings; active: AiSettings; restartRequired: boolean
  locked?: Partial<Record<AiLockedField, { variable: string; value: string }>>
}
```

`ai:save` в `harness/ipc.ts` для заблокированных полей оставляет ранее сохранённое значение, а не то, что пришло из формы. Так форма может показывать действующее значение и не портить сохранённый выбор.

### 3.2. Ключ OpenRouter

Новый файл `app/src/main/harness/openrouterKey.ts`:

- Хранение: `safeStorage.encryptString(key)` → файл `<userData>/secrets/openrouter.bin` (права `0600`, запись через временный файл и переименование). На macOS ключ шифрования лежит в Связке ключей. Ключ **никогда** не пишется в `settings.json`, журнал, резервную копию и не возвращается в окно приложения.
- Если `safeStorage.isEncryptionAvailable()` ложно (или на Linux выбран `basic_text`), ключ не сохраняется, пользователь видит ошибку. Сохранения открытым текстом нет.
- Не удалось расшифровать (другая сборка, другая запись в Связке ключей) → состояние `unreadable`, сообщение «введите заново». Приложение при этом запускается.
- Формат: `sk-or-v1-` + 64 шестнадцатеричных символа (документация OpenRouter). Иное отклоняется до сети.
- Проверка: `GET https://openrouter.ai/api/v1/key` → название ключа, `limit_remaining`, `usage_daily`, `usage_monthly`, `is_free_tier`.
- Ключ читается при каждом запросе, поэтому замена ключа действует сразу, без перезапуска.
- Переменная `YOGURT_OPENROUTER_API_KEY` (для запусков разработчика): значение читается при старте, **удаляется из `process.env`** и добавляется в списки удаляемых переменных для дочерних agy и Porch; на диск не пишется; поле ключа в интерфейсе заблокировано по правилу 2.2. `OPENROUTER_API_KEY` приложение не читает, чтобы случайно не взять чужой ключ из окружения.
- Проверить, что `main/backup.ts` не включает папку `secrets/`.

IPC (`preload/index.ts`, `shared/types.ts`):

```ts
ai.openrouter.keyStatus(): Promise<KeyStatus>
ai.openrouter.setKey(key: string): Promise<KeyStatus>    // проверяет формат, GET /key, сохраняет
ai.openrouter.clearKey(): Promise<KeyStatus>
type KeyStatus =
  | { state: 'none' | 'unreadable' | 'unavailable' }
  | { state: 'ok' | 'rejected' | 'unchecked'; source: 'keychain' | 'env'; last4: string
      label?: string; remainingUsd?: number | null; checkedAt?: number; problem?: AiProblemCode }
```

### 3.3. Откуда берутся списки

Один канал для всех режимов:

```ts
ai.options(request: { backend: 'agy' | 'porch' | 'openrouter'; refresh?: boolean
                      agyPath?: string; porchPath?: string }): Promise<AiOptions>

type AiHint = 'audio' | 'verified' | 'fast' | 'cheap' | 'free' | 'tokens' | 'expiring' | 'unavailable'
type AiOption = {
  id: string; label: string; vendor?: string
  group: 'recommended' | 'audio' | 'stt' | 'text' | 'free' | 'alias' | 'unavailable'
  hints: AiHint[]; detail?: string            // вторая строка: backend, модель профиля
  kind?: OpenRouterAudioKind; efforts?: AiEffort[]
  addedAt?: number; expiresOn?: string; contextLength?: number
  price?: { perHourUsd?: number; estimated?: boolean; inPerMillionUsd?: number; outPerMillionUsd?: number }
  disabledReason?: string
}
type AiOptions = {
  transcription: AiOption[]; text: AiOption[]
  source: 'live' | 'cache' | 'builtin'; fetchedAt?: number
  problem?: AiProblemCode                     // почему список не свежий
}
```

**agy.** Встроенный перечень в новом `app/src/shared/aiCatalog.ts` (по выводу `agy models` версии 1.5.11 на 18 ноября 2026 года):

| ID модели | Название | Уровни | Расшифровка |
| --- | --- | --- | --- |
| `gemini-3.8-flash` | Gemini 3.8 Flash | low, medium, high | да · рекомендуем · проверена |
| `gemini-4-hydrogen` | Gemini 4 Hydrogen | low, medium, high, xhigh | да · в Yogurt не проверена |
| `gemini-4-argon` | Gemini 4 Argon | low, medium, high | да · в Yogurt не проверена |
| `claude-opus-5-5`, `claude-sonnet-5-5` | Claude Opus 5.5, Claude Sonnet 5.5 | low, medium, high | только текст |
| `gpt-oss-120b` | GPT-OSS 120B | medium | только текст |

По ⟳ — `agy models` (5 с тайм-аут, через существующий `HarnessProcesses.run`). Вывод — строка «Fetching available models...», затем строки `id<TAB>название`, где ID включает уровень (`gemini-3.8-flash-medium`). Разбор: отрезать суффикс `-(low|medium|high|xhigh|max)`, собрать уровни по базовому ID, объединить со встроенным перечнем (метки берутся из встроенного). Команда ходит в сеть под аккаунтом пользователя, поэтому запускается только по явному нажатию ⟳. Формат вывода не документирован; неразобранный вывод = ошибка списка, показывается встроенный перечень с фразой `agyListFailed`.

**Porch.** Новый `app/src/main/harness/porchProfiles.ts`:

- `bash <porch> --list-agents` → строки `<agent id="…" label="…" backend="…" model="…" enabled="…" backend-available="…"/>`. Разбор регулярным выражением по атрибутам (значения экранированы как XML); ID проверяется тем же `exactProfile`. Неизвестные атрибуты игнорируются; строка без `id` пропускается; ноль разобранных строк = ошибка списка.
- `bash <porch> media capabilities --json` → множество `transcribe` (тот же вызов, что уже есть в `porch.ts`; вынести в общую функцию).
- `transcription` = профили из `transcribe`; `text` = все профили; `backend-available="false"` → группа `unavailable`.
- Окружение дочернего процесса — то же очищенное `environment()` из `porch.ts`. Результат кэшируется в памяти на время открытых настроек; ⟳ перечитывает. Заодно закрывает находку F-CACHE (проверка аудиопрофиля кэшируется на весь запуск).
- На этой машине сегодня: 72 профиля, 9 из них в `transcribe`.

**OpenRouter** — раздел 4.

**Локальный режим** — списков нет.

### 3.4. Адаптер OpenRouter

Новый `app/src/main/harness/openrouter.ts`. HTTP через `net.fetch` из Electron (учитывает системный прокси и VPN; обычный `fetch` Node их не видит); функция `fetch` передаётся параметром, чтобы тесты подставляли свою. Базовый адрес `https://openrouter.ai/api/v1`. Заголовки: `Authorization: Bearer <ключ>`, `Content-Type: application/json`. Заголовки атрибуции приложения (`HTTP-Referer`, `X-OpenRouter-Title`) **не отправляются**: они публикуют приложение в рейтингах OpenRouter.

Подключение в `harness/index.ts`:

```ts
// createSubscriptionHarness: третья ветка рядом с agy и porch
complete:   (prompt, _directory, signal) => openrouter.text(prompt, signal)
transcribe: request => openrouter.transcribe(request)     // AudioRequest → строка JSON по TRANSCRIPT_SCHEMA
```

`createSubscriptionHarness` не должен падать без ключа: как и при неустановленном agy, приложение запускается, а запросы завершаются ошибкой `auth`. В `harness/model.ts` строка `loaded` получает третье значение `openrouter:<модель>`. Параметры конвейера в `main/index.ts:551` (`batchMs`, `firstBatchMs`, `maxQueuedMs`) на первом этапе те же, что у CLI.

#### Текст

`POST /chat/completions`:

```json
{
  "model": "google/gemini-3.8-flash",
  "messages": [{ "role": "user", "content": "<запрос, собранный createHarnessModel>" }],
  "max_tokens": 18432,
  "reasoning": { "effort": "medium" },
  "provider": { "data_collection": "deny" },
  "stream": false
}
```

- Запрос собирает существующий `createHarnessModel` (тот же текст, что проверен на agy): одно сообщение пользователя. Проверка бюджета контекста, пустого ответа и размера ответа остаётся в `model.ts`.
- `max_tokens` = запрошенный приложением лимит + 16 384 на рассуждение, но не больше `top_provider.max_completion_tokens` модели. У моделей с обязательным рассуждением токены рассуждения входят в лимит; ответ с `finish_reason: "length"` и пустым текстом — ошибка `truncated`, а не пустой конспект.
- `reasoning.effort` отправляется, только если в списке моделей у модели есть `reasoning.supported_efforts` с этим уровнем; иначе поле опускается.
- `provider`: `deny` → `{"data_collection":"deny"}`, `zdr` → `{"zdr":true}`, `any` → поле опускается.
- Ответ: `choices[0].message.content`; `usage.cost`, `usage.prompt_tokens`, `usage.completion_tokens` идут в учёт расхода. Тело с полем `error` при статусе 200 — ошибка (так описано в документации).

#### Расшифровка аудиомоделью (вид `chat`)

`POST /chat/completions`:

```json
{
  "model": "google/gemini-3.8-flash",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "<правила расшифровки + язык + instructions из AudioRequest>" },
    { "type": "input_audio", "input_audio": { "data": "<WAV в base64>", "format": "wav" } }
  ]}],
  "response_format": { "type": "json_schema",
    "json_schema": { "name": "transcript", "strict": true, "schema": { "…": "строгий вариант TRANSCRIPT_SCHEMA" } } },
  "reasoning": { "effort": "medium" },
  "provider": { "require_parameters": true, "data_collection": "deny" },
  "stream": false
}
```

- Аудио — тот же `audio.wav`, который `createHarnessTranscriber` кладёт в рабочую папку (16 кГц, моно, 16 бит). Перекодирования нет, длительность и таймкоды те же.
- Текст запроса: общие правила из `transcribe.ts` (фразы с началом и концом в секундах, «не выдумывай», пустой массив только для тишины) выносятся в экспортируемую константу; фразы про `./audio.wav` и инструмент чтения файла остаются только в CLI-варианте. `instructions` из `AudioRequest` уже содержит длительность, запрет перевода и словарь; **правило «мало чёткой речи → без словаря» срабатывает до адаптера и сохраняется без изменений**. Подсказка языка — `Expected spoken language: …`, как сейчас.
- Строгая схема: те же поля, но все обязательные и `additionalProperties: false` (требование строгого режима): `{ language: string, error: string, segments: [{ start, end, text }] }`. Пустые `language` и `error` означают «нет»; существующий `parseTranscript` это уже понимает.
- `require_parameters: true` — запрос идёт только к провайдерам, поддерживающим `response_format`. Модели без `structured_outputs` в списке запрашиваются без `response_format`; ответ всё равно проходит `parseTranscript`.
- Ответ → строка JSON → существующий `parseTranscript` (строгая проверка таймкодов, `packedToMeeting` для сжатых пауз) без изменений.
- Уровень рассуждения: `clampTranscriptionEffort`, как у agy.

Размер: 5 минут такого WAV — 9,6 МБ, в base64 — 12,8 МБ тела запроса. Предел размера тела для `/chat/completions` в документации не найден — проверяется на этапе 0. Документация называет форматы `wav` и `mp3` для Responses API и «любой формат провайдера» для Chat Completions.

#### Расшифровка моделью STT (вид `stt`)

`POST /audio/transcriptions` (JSON):

```json
{
  "model": "x-ai/grok-stt-2.0",
  "input_audio": { "data": "<WAV в base64>", "format": "wav" },
  "language": "ru",
  "temperature": 0,
  "response_format": "verbose_json",
  "timestamp_granularities": ["segment"],
  "provider": { "data_collection": "deny" }
}
```

- Ответ `segments[{start,end,text}]`, `language`, `usage.seconds`, `usage.cost` превращается в ту же строку JSON и идёт в `parseTranscript`.
- **Нет `segments` — ошибка `no-timestamps`.** Строка «весь текст одним куском без времени» не создаётся: это скрыло бы потерю привязки ко времени. По документации часть моделей отклоняет `verbose_json` с кодом 400 (названы `openai/gpt-4o-transcribe`, `microsoft/mai-transcribe-1.5`).
- **Словарь и имена не передаются**: OpenRouter принимает `prompt`, но игнорирует; подсказки возможны только через `provider.options` конкретного провайдера и в первую версию не входят. Поэтому группа подписана «без словаря».
- `language` — код ISO-639-1, если язык встречи известен; иначе поле опускается.
- Ограничения из документации: загрузка до 25 МБ (5 минут нашего WAV проходят), провайдер обрывает запрос через 60 секунд обработки.
- Семейство Whisper выдумывает фразы на тишине. Фильтр `isSilenceGuess` из `asr/hallucination.ts` сегодня применяется только на локальном пути; для вида `stt` его нужно применить к строкам ответа.
- Сегменты STT-моделей могут выходить за длительность файла на доли секунды. `parseTranscript` отвергает весь пакет при выходе больше 1 мс. Какой допуск нужен адаптеру STT, решается по данным этапа 0; до тех пор проверка остаётся строгой.

#### Ошибки, повторы, тайм-ауты

Адаптер бросает `HarnessError` с новым полем `code: AiProblemCode`:

```ts
type AiProblemCode = 'auth' | 'credits' | 'budget' | 'rate-limit' | 'model-gone' | 'no-provider'
  | 'unavailable' | 'timeout' | 'network' | 'too-large' | 'moderation' | 'truncated'
  | 'no-timestamps' | 'bad-response' | 'no-key' | 'keychain'
```

| Ответ OpenRouter | Код | Повтор внутри адаптера |
| --- | --- | --- |
| 401 | `auth` | нет |
| 402, `limit_source: openrouter_credits` | `credits` | нет |
| 402, `openrouter_in_flight_budget` | `rate-limit` | да, по `Retry-After` |
| 402/403, `openrouter_key_limit`, бюджеты | `budget` | нет |
| 403 с `metadata.reasons` | `moderation` | нет |
| 404 или `error_type: not_found` | `model-gone` | нет |
| 404/503 «нет провайдера под требования» | `no-provider` | нет |
| 429 | `rate-limit` | да, по `Retry-After` |
| 502, 503 (`provider_unavailable`, `provider_overloaded`) | `unavailable` | да |
| 408, 504, 524, обрыв соединения | `timeout` / `network` | да |
| 413 | `too-large` | нет |
| 200 с `error` в теле | по `error_type` | по типу |

- Повторы в адаптере: не больше двух, пауза из `Retry-After` (не дольше 60 с), иначе 2 и 8 секунд. Дальше работает существующая логика конвейера: один повтор пакета через 5 с, затем пакет ждёт на диске (`pending-audio/`), до трёх автоматических попыток при следующих запусках и кнопка «Повторить».
- Тайм-аут запроса — существующая настройка: текст `timeoutSeconds`, аудио `max(timeoutSeconds, 600)`. Отмена через общий `AbortSignal` (`harness.stop()` при выходе).
- Ошибки, которые повтором не лечатся (`auth`, `credits`, `budget`, `model-gone`, `no-provider`), сразу показываются человеку. Нужен канал из главного процесса: событие `ai:problem` `{ code, model?, at }` → плашка на заметке и в настройках с текстом из 2.8. Сегодня есть только общий сигнал `transcribe-failed` («Часть встречи не удалось расшифровать»); он остаётся, новая плашка уточняет причину. При следующем успешном запросе плашка снимается.
- Ограничения скорости: у платных моделей нет платформенного лимита запросов; у `:free` — 20 запросов в минуту и 50 (или 1000) в день. Две дорожки дают два одновременных запроса — в пределах любых лимитов. Бесплатные модели поэтому в отдельной группе внизу.
- Никакого скрытого перехода на другую модель, другого провайдера или локальные модели.

#### Журнал и учёт расхода

- В журнал (`logs/main.log`) пишутся: ID модели, код состояния, `error_type`, ID генерации (`id` ответа или `X-Generation-Id`), длительность, размер тела, стоимость. **Не пишутся**: ключ, заголовок `Authorization`, тело запроса и ответа, аудио, текст расшифровки, `metadata.flagged_input`.
- Учёт: новый `app/src/main/harness/openrouterUsage.ts`. По каждому ответу — `usage.cost` (доллары), секунды аудио, вид задачи. Хранится по дням в `<userData>/openrouter-usage.json` (90 дней, без содержимого запросов). `ai.openrouter.usage()` отдаёт «сегодня» и «30 дней», а также измеренную цену часа речи по каждой модели расшифровки — она заменяет оценку в списке (4.5).
- Остаток — из `GET /key` (`limit_remaining`; `null` = у ключа нет лимита). Баланс всего счёта обычному ключу недоступен (нужен management-ключ), поэтому показывается только остаток по ключу.

### 3.5. Приватность

- Аудио и текст уходят в OpenRouter и дальше к провайдеру модели. По документации OpenRouter не хранит запросы и ответы, если пользователь сам не включил журналирование в кабинете; исключения — проверка на CSAM и «Safety Retention»-провайдеры. Провайдеры хранят данные по своим правилам.
- Настройка «Кому можно передавать данные» управляет полем `provider` запроса (3.4). По умолчанию `deny`: исключаются провайдеры, которые могут хранить данные или обучаться на них. Для STT-запросов из настроек маршрутизации действуют только `zdr` и `data_collection`.
- Экран приветствия, нижняя строка настроек (`settings-ai-privacy`) и `docs/subscription-harness.md` получают формулировку для OpenRouter (`privacyOpenRouter`).
- Локальных копий запросов OpenRouter не оставляет (в отличие от agy, который хранит беседы): чистить нечего.

## 4. Список моделей OpenRouter

Новый `app/src/main/harness/openrouterModels.ts` (получение, отбор, кэш) и чистые функции отбора и сортировки в `app/src/shared/aiCatalog.ts` (тестируются без сети).

### 4.1. Запросы

Ключ не нужен. Два запроса при обновлении:

| Запрос | Что возвращает (18.11.2026) |
| --- | --- |
| `GET /api/v1/models` | модели с текстовым выходом: 478 записей, 0,94 МБ |
| `GET /api/v1/models?output_modalities=transcription` | отдельные модели расшифровки (STT): 30 записей, 30 КБ |

Без параметра `output_modalities` сервер отдаёт только модели с текстовым выходом; STT-модели в этот ответ не попадают. Серверные фильтры (`input_modalities`, `supported_parameters`, `sort=newest`, `context`) существуют, но отбор делается на стороне приложения по одному кэшу: так список работает без сети и правила покрыты тестами. Ответ не разбит на страницы, если не задан `limit`.

### 4.2. Поля: на что можно опираться

Схема проверена по живому ответу и по справочнику API.

| Поле | Надёжность | Как используется |
| --- | --- | --- |
| `id` | обязательное | ID для запросов. Суффиксы `:free`, `:batch`; префикс `~` — «плавающий» псевдоним |
| `name` | обязательное | «Google: Gemini 3.8 Flash» → производитель и название |
| `created` | обязательное, было у всех 478 | Дата **появления в OpenRouter**, не дата выпуска модели (у `openai/whisper-1` — апрель 2026). Подпись — «на OpenRouter с …» |
| `architecture.input_modalities`, `output_modalities` | обязательное | Отбор по назначению |
| `endpoints` | обязательное, было у всех | Какой API обслуживает модель: `/api/v1/chat/completions`, `/api/v1/audio/transcriptions`, `/api/v1/batches` |
| `pricing.prompt`, `pricing.completion` | обязательные, строки | Доллары за токен. `"-1"` — роутер с переменной ценой, `"0"` — бесплатно |
| `pricing.audio` | необязательное: есть у 20 из 31 аудиомодели | Цена аудиотокена; если нет — берётся `pricing.prompt`, цена помечается как оценка |
| `context_length` | обязательное; у STT-моделей `0` | Отбор для текста |
| `supported_parameters` | обязательное; у STT-моделей пустое | `structured_outputs`, `response_format`, `reasoning` |
| `reasoning.supported_efforts` | необязательное: есть у 356 из 478 | Какие уровни рассуждения предлагать и отправлять |
| `top_provider.max_completion_tokens` | может быть `null` | Верхняя граница `max_tokens` |
| `expiration_date` | почти всегда `null` (задано у 21) | Метка «скоро отключат» за 30 дней |
| `alias_target` | только у `~`-псевдонимов | Показать, на какую модель указывает псевдоним |
| `knowledge_cutoff`, `per_request_limits`, `benchmarks`, `description` | часто `null` или объёмные | Не используются, в кэш не попадают |

Модели с недостающими полями:

- Нет `architecture` или `id` → запись пропускается (модель доступна через свой ID).
- Нет `created` → дата «—», при сортировке по новизне — в конец.
- Нет `endpoints` → считается чат-моделью, если выход текстовый.
- Цена не разбирается как число → цена «—», при сортировке по цене — в конец.
- Ответ без массива `data` или с нулём пригодных записей → ошибка обновления, кэш не перезаписывается.

### 4.3. Отбор «для расшифровки»

Группа «Аудиомодели» (вид `chat`), из первого запроса. Все условия:

1. `input_modalities` содержит `audio`, `output_modalities` содержит `text`;
2. `endpoints` содержит `/api/v1/chat/completions`;
3. ID не оканчивается на `:batch` и не начинается с `~`;
4. это не роутер: `pricing.prompt` не равен `"-1"` и ID не начинается с `openrouter/`;
5. `expiration_date` пуста или в будущем.

Модели с нулевой ценой (`pricing.prompt = "0"`, обычно суффикс `:free`) → группа «Бесплатные». Модель без `structured_outputs` остаётся в группе, но ниже моделей с ним при равной дате. На 18 ноября под условия подходит 31 платная модель (у 29 есть `structured_outputs`) и одна бесплатная.

Группа «Модели расшифровки (STT)» (вид `stt`), из второго запроса: `output_modalities` содержит `transcription` и `endpoints` содержит `/api/v1/audio/transcriptions`; условие 5 то же. На 18 ноября — 30 моделей. Возвращает ли модель таймкоды, из списка не видно — это выясняет проверка при сохранении (2.7); результат запоминается в кэше на 7 дней.

### 4.4. Отбор «для текста»

Из первого запроса. Все условия:

1. `input_modalities` содержит `text`, а `output_modalities` — ровно `["text"]` (генераторы картинок и модели с аудиовыходом не нужны);
2. `endpoints` содержит `/api/v1/chat/completions`;
3. `context_length` ≥ 32 000 (бюджет контекста приложения по умолчанию — 32 768);
4. не `:batch`, не `~`, не роутер (цена `"-1"` или ID с `openrouter/`), `expiration_date` пуста или в будущем.

Модели с нулевой ценой → «Бесплатные». На 18 ноября под условия подходит 316 платных моделей и 14 бесплатных. Во второй строке показывается контекст («контекст 1 млн»): для длинных встреч это полезнее цены.

«Рекомендуем» в обоих списках — короткий перечень в коде (`aiCatalog.ts`), куда попадают только модели, проверенные в Yogurt. Старт: `google/gemini-3.8-flash` для обеих задач (та же модель проверена через agy). Если рекомендованной модели нет в свежем списке, она в группу не попадает.

### 4.5. Сортировка и цена

- **Новые** (по умолчанию): `created` по убыванию, при равенстве — по ID.
- **Дешёвые**: по цене по возрастанию; для расшифровки — по оценке цены часа речи, для текста — по `pricing.prompt`, затем `pricing.completion`. Записи без цены — в конец.

Цена в строке списка:

| Вид модели | Что показывается | Формула |
| --- | --- | --- |
| Текст | «$0.83 / $4.13 за млн токенов» | `prompt × 1e6`, `completion × 1e6` |
| Аудиомодель | «≈ $0.22 за час речи» | `(цена_аудиотокена × T × 3600) + (completion × 500 × 60)`, где `цена_аудиотокена = pricing.audio ?? pricing.prompt`, `T` — аудиотокенов в секунду, 500 — принятое число выходных токенов на минуту речи |
| STT с оплатой по времени (`completion = "0"`) | «$0.10 за час речи» | `prompt × 3600` |
| STT с оплатой по токенам (`completion > 0`) | «$2 / млн токенов», метка «по токенам» | оценки за час нет |

Оговорки, которые нужно сохранить в коде и интерфейсе:

- `T` в ответе API нет. Для `google/gemini-*` принимается 32 токена в секунду (данные Google для более ранних Gemini; для 3.x и 4 не проверено). Для остальных аудиомоделей оценка за час не показывается — только цена за миллион аудиотокенов. Знак «≈» обязателен.
- Справочник API описывает `pricing.prompt` как цену за токен. У STT-моделей с оплатой по времени значение по факту совпадает с ценой **за секунду** (`openai/whisper-1` = 0.0001 → $0.006 за минуту, как у OpenAI; `google/chirp-3` → $0.016 за минуту). Исключения: `microsoft/mai-transcribe-2` = 0.1 и `mai-transcribe-1.5` = 0.36 — похоже на цену за час. Правило: оценка показывается, только если результат попадает в окно $0.005–$3 за час; иначе «цена на странице модели».
- Как только накоплены собственные данные (`usage.cost` и секунды аудио, 3.4), оценка заменяется измеренной: «$0.21 за час речи · по вашим встречам». Это единственная точная цифра.
- Цены с `overrides` (например, дороже при длинном контексте) показываются по базовым значениям.

### 4.6. Кэш и работа без сети

- Файл `<userData>/openrouter-models.json`: `{ schema: 1, fetchedAt, text: […], stt: […], probes: { "<id>": { timestamps: boolean, at } } }`. Хранится урезанная запись (поля из 4.2), порядка 150 КБ.
- Срок свежести — 24 часа. При открытии настроек список показывается из кэша сразу; если кэш старше 24 часов, в фоне идёт обновление и список заменяется без потери выбора и позиции прокрутки. ⟳ обновляет принудительно.
- Тайм-аут обновления — 15 секунд. Ошибка сети или сервера: кэш не трогается, в списке фраза «Нет связи. Показан список от …».
- Кэша нет и сети нет: список пуст, работает только свой ID и уже сохранённые значения.
- Запросы списка не идут чаще одного раза в 2 минуты (сервер сам кэширует ответ на 120 секунд).
- Заполняется лениво: при первом открытии настроек OpenRouter и раз в сутки при запуске, если режим — OpenRouter (чтобы заметить пропавшую модель).

### 4.7. Модель пропала или скоро пропадёт

- При запуске и при обновлении списка выбранные ID сверяются со **свежим** списком (устаревший кэш поводом для тревоги не считается). Нет в списке → метка «нет в списке» у поля и предупреждение в настройках. Автоматической замены нет.
- `expiration_date` в пределах 30 дней → метка «скоро отключат» и фраза с датой.
- Если запрос вернул `model-gone`, показывается плашка из 2.8; аудио ждёт на диске до выбора другой модели и «Повторить».
- Свой ID, которого нет в списке, не считается пропавшим: он помечен «свой ID», а его работоспособность показывает «Проверить».

## 5. Этапы

Каждый этап — отдельная небольшая задача с зелёными `tsc` и тестами. Порядок: 0 и 1 независимы; 2 после 1; 3 после 2; 4 после 1; 5 независим; 6 после 2, 4, 5; 7 после 4 и 6; 8 после 6.

### Этап 0. Проверка OpenRouter на живом ключе (без кода приложения)

- **Что:** скрипт в `app/test-live/` (вне системы контроля версий, как `route.live.test.ts`). Ключ передаётся переменной окружения при запуске, в вывод и файлы не попадает.
- **Проверить:**
  1. `/chat/completions` с `input_audio` на `google/gemini-3.8-flash`: 15 секунд, 1 минута, 5 минут WAV (12,8 МБ тела) — проходит ли по размеру, время ответа, соблюдается ли строгая схема, точность таймкодов на синтетической русской записи из прежних проверок.
  2. То же на шуме без речи — со словарём и без (находка F-HALLUC).
  3. `/audio/transcriptions` с `verbose_json` на 3–4 моделях STT (по одной от разных провайдеров): есть ли `segments`, выходят ли таймкоды за длительность и на сколько, что на тишине, время на 5 минут (предел 60 с).
  4. Формы ответов: `usage` (стоимость, аудиотокены → число токенов в секунду), тела ошибок для неверного ключа, несуществующей модели, правила `zdr` без подходящего провайдера.
  5. `GET /key` — реальные поля.
- **Результат:** короткий отчёт с цифрами; правки этого плана (допуск таймкодов STT, размер пакета, `T`, единицы цен STT).
- **Риск:** расход порядка $1–2; нужен ключ владельца.

### Этап 1. Настройки без противоречий

- **Файлы:** `shared/ai.ts` (`locked` вместо `environmentOverrides`), `main/harness/ipc.ts` (сохранение не трогает заблокированные поля), `renderer/.../AiSettings.tsx` (строка состояния, заблокированные поля, без абзаца про переменные), `aiCopy.ts`, `AiSettings.css`, `test/aiSettingsUi.test.ts`, `test/aiPreferences.test.ts`, `e2e/aiSettings.spec.ts`.
- **Интерфейс:** `AiPreferences.locked` (3.1).
- **Риски:** `Settings.tsx` и `Onboarding.tsx` читают `AiPreferences` — проверить, что старое поле нигде больше не используется.
- **Проверить:** запуск с `YOGURT_AI_BACKEND=agy` при сохранённом Porch — видно «agy», поле выключено, показаны поля agy; сохранение других полей не меняет сохранённый режим; без переменных — строка «Сохранено: … после перезапуска»; обе локали.

### Этап 2. Компонент выбора и перечень agy

- **Файлы:** новый `renderer/.../components/ModelPicker.tsx` (+ CSS), новый `shared/aiCatalog.ts` (типы `AiOption`, перечень agy, чистые функции поиска, сортировки, проверки своего ID), `AiSettings.tsx` (поля моделей agy и «Режим обработки» через компонент; уровни рассуждения по модели), `aiCopy.ts`, тесты `test/modelPicker.test.ts`, `test/aiCatalog.test.ts`, e2e.
- **Интерфейс:** `<ModelPicker id label value options groups onChange allowCustom validateCustom state locked hint />`; данные — `AiOption[]`.
- **Риски:** доступность поля со списком (проверить VoiceOver); существующие тесты ищут `<input id="ai-transcriptionModel">` и `value="gemini-3.8-flash"`.
- **Проверить:** выбор мышью и только клавиатурой; поиск по части ID; свой ID (`gemini-4-hydrogen`) сохраняется и виден после перезапуска с меткой; недопустимый ID не выбирается; `Esc` возвращает прежнее значение; `low` для расшифровки отсутствует.

### Этап 3. Списки Porch и `agy models`

- **Файлы:** новый `main/harness/porchProfiles.ts`, `main/harness/porch.ts` (общая функция чтения `capabilities`), новый `main/harness/agyModels.ts`, `main/harness/ipc.ts` (`ai:options`), `preload/index.ts`, `shared/types.ts`, `AiSettings.tsx` (Porch: два списка, модель расшифровки из профиля, переопределение в дополнительных настройках), тесты с подставными CLI (`test/harness.test.ts` — образец), e2e в режиме `YOGURT_FAKE`.
- **Интерфейс:** `ai.options({ backend, refresh, agyPath, porchPath })` → `AiOptions`.
- **Риски:** формат `--list-agents` и `agy models` не закреплён контрактом; запуск из Finder с коротким `PATH` (использовать существующие `executablePath`, `prependPath`); свой `PORCH_CONFIG` пользователя меняет состав профилей.
- **Проверить:** в списке расшифровки только профили из `transcribe`; недоступные профили — в «Недоступных»; сломанный или пустой вывод → сообщение и свой ID; Porch не установлен → понятная ошибка, форма работает; выбор профиля подставляет его модель.

### Этап 4. OpenRouter: ключ и адаптер (главный процесс)

- **Файлы:** `shared/ai.ts` (режим, поля, значения по умолчанию, проверка ID), `main/settings.ts` (`openrouter` в `YOGURT_AI_BACKEND`, чтение и удаление `YOGURT_OPENROUTER_API_KEY`), новые `main/harness/openrouterKey.ts`, `openrouter.ts`, `openrouterUsage.ts`, `main/harness/index.ts` (третья ветка, `checkHarness`), `process.ts` (`HarnessError.code`), `model.ts` (`loaded`), `transcribe.ts` (общие правила расшифровки — в константу), `agy.ts` и `porch.ts` (новая переменная в списках удаляемых), `ipc.ts` и `preload` (ключ, расход), тесты `test/openrouter.test.ts`, `test/openrouterKey.test.ts` с подставным `fetch` и подставным `safeStorage`.
- **В этом этапе:** текст и аудиомодели (вид `chat`). Вид `stt` — этап 7.
- **Риски:** поведение `safeStorage` в неподписанной сборке разработчика (запрос доступа к Связке ключей); размер тела 12,8 МБ; строгая схема у разных провайдеров; утечка ключа в журнал через текст ошибки.
- **Проверить:** ключ не появляется в `settings.json`, журнале, резервной копии и ответах IPC (тест ищет строку ключа во всех артефактах); без ключа приложение запускается и открывает настройки; каждый код ошибки из таблицы 3.4 даёт свой `AiProblemCode`; повтор по `Retry-After`; `parseTranscript` получает тот же формат, что от agy; пакет с малой чёткой речью уходит без словаря; отмена при выходе.

### Этап 5. OpenRouter: список моделей (главный процесс)

- **Файлы:** новый `main/harness/openrouterModels.ts`, `shared/aiCatalog.ts` (отбор, сортировка, цена — чистые функции), `ipc.ts` (`ai:options` для `openrouter`), тесты `test/openrouterModels.test.ts` на сохранённом образце ответа (урезанный снимок от 18.11.2026 в `test/fixtures/`).
- **Риски:** OpenRouter меняет схему (за год появились `endpoints`, `reasoning`, `alias_target`); единицы цен STT.
- **Проверить:** отбор 4.3 и 4.4 на снимке (ожидаемые числа на полном снимке: 31 платная и 1 бесплатная аудиомодель, 30 STT, 316 платных и 14 бесплатных текстовых); роутеры, `:batch`, `~` исключены; сортировки; записи с недостающими полями; кэш 24 часа; ошибка сети не стирает кэш; нет кэша и нет сети → пустой список с причиной; оценка цены часа для `google/gemini-3.8-flash`, `openai/whisper-1` и отказ от оценки для `microsoft/mai-transcribe-2`.

### Этап 6. OpenRouter: интерфейс

- **Файлы:** `AiSettings.tsx` (раздел OpenRouter, поле ключа, флажок «та же модель», правило данных, расход), `ModelPicker.tsx` (цена, дата, сортировка, ⟳), `aiCopy.ts`, плашка причины ошибки на заметке (событие `ai:problem`: `main/index.ts`, компонент заметки), `Settings.tsx` и `permissionCopy.ts` (текст приватности), `docs/subscription-harness.md`, тесты и e2e с подставным сервером OpenRouter.
- **Риски:** тест `aiSettingsUi.test.ts` сейчас требует отсутствия `type="password"` — ограничить это требование режимами без ключа; ключ не должен задерживаться в состоянии React после отправки.
- **Проверить:** первый запуск: вставка ключа → автопроверка → значения по умолчанию → сохранение → перезапуск; неверный ключ; ключ другого сервиса; замена и удаление ключа; флажок «та же модель» и его отключение для STT; список из кэша без сети; выбранная модель пропала из свежего списка; плашки `credits`, `auth`, `model-gone` на заметке и их снятие после успеха; клавиатура и VoiceOver; обе локали.

### Этап 7. OpenRouter: модели STT

- **Файлы:** `openrouter.ts` (ветка `/audio/transcriptions`), `asr/hallucination.ts` (использование `isSilenceGuess` для строк STT), `openrouterModels.ts` (`probes`), `AiSettings.tsx` (автопроверка при сохранении), тесты.
- **Зависит от** результатов этапа 0 (допуск таймкодов, размер пакета под 60-секундный предел).
- **Проверить:** модель без `segments` нельзя сохранить; таймкоды за длительностью обрабатываются по принятому правилу; тишина и шум не дают текста; язык передаётся кодом; расход считается по `usage.seconds` и `usage.cost`.

### Этап 8. Живая проверка и настройка (после этапа 6)

- Встреча 10–20 минут в режиме OpenRouter по сценариям `docs/live-verification-plan.md`: расшифровка, конспект, вопросы, выход сразу после «Стоп», повтор.
- Решить по замерам, уменьшать ли пакеты для OpenRouter (у HTTP нет 25–30 секунд запуска CLI, текст может появляться чаще): параметры `batchMs` и `firstBatchMs` в `main/index.ts:551` становятся зависимыми от режима.
- Возможные продолжения, каждое отдельной задачей: настоящий поток токенов для текста (`stream: true`), вход через OpenRouter без копирования ключа (OAuth PKCE с обратным адресом на `localhost`), расход по каждой встрече.

## 6. Открытые вопросы владельцу

1. **Правило данных по умолчанию для OpenRouter.** Предлагаю «только провайдерам без хранения и обучения» (`data_collection: deny`). Цена: у части моделей останется меньше провайдеров, отдельные модели могут оказаться недоступны. Альтернатива — «любым провайдерам» по умолчанию.
2. **Модели STT в первой версии.** Предлагаю сначала выпустить аудиомодели (тот же путь, что проверен с Gemini через agy; учитывают словарь встречи), а отдельные STT-модели — следующим этапом после живой проверки: у них нет словаря, не все возвращают таймкоды, цены в списке ненадёжны. В списке они будут видны сразу, но выбрать их можно будет после этапа 7. Согласны с таким порядком?
3. **Ключ для этапа 0.** Нужен ключ OpenRouter с лимитом $3–5 для живой проверки (передаётся только переменной окружения при запуске скрипта).
4. **Ввод ключа.** В первой версии — только вставка ключа. Вход через OpenRouter в браузере (OAuth PKCE) удобнее, но это отдельная задача. Достаточно ли вставки?
5. **Смена модели без перезапуска.** Сейчас любая смена режима или модели требует перезапуска приложения. Можно сделать применение на лету, когда нет записи и очереди, но это отдельное изменение архитектуры запуска. Нужно ли оно после этих этапов?
6. **Поле «Модель расшифровки» у Porch.** Предлагаю убрать его с основного экрана (модель берётся из выбранного профиля) и оставить переопределение в дополнительных настройках. Возражений нет?

## 7. Что не проверено

- Ни одного запроса с ключом OpenRouter не было: форматы запросов и ответов взяты из документации и справочника API.
- Предел размера тела `/chat/completions` с аудио в base64 (нужно 12,8 МБ на 5 минут WAV) в документации не найден.
- Качество таймкодов Gemini через OpenRouter (через agy расхождение 3–4 с) и поведение STT-моделей с `verbose_json`.
- Число аудиотокенов в секунду у Gemini 3.x и 4 (в оценке цены принято 32).
- Единицы `pricing.prompt` у STT-моделей: справочник говорит «за токен», значения похожи на «за секунду», у двух моделей — на «за час».
- Формат вывода `agy models` и работа пары «базовый ID + `--effort`» для моделей, кроме `gemini-3.8-flash`; умеют ли не-Gemini модели agy слушать аудио.
- Поведение `safeStorage` и Связки ключей в неподписанной сборке разработчика.
- `GET /api/v1/models/user` (список моделей, доступных конкретному ключу с учётом его правил приватности) — возможное улучшение списка, не проверялось.

## 8. Источники

Документация OpenRouter (прочитана 18 ноября 2026 года):

- Models API, параметры и фильтры списка: https://openrouter.ai/docs/api_reference/models.md
- Справочник `GET /models` (схема полей и цен): https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
- Аудио на входе (`input_audio`, форматы): https://openrouter.ai/docs/guides/overview/multimodal/audio.md
- Speech-to-Text (`/audio/transcriptions`, `verbose_json`, пределы 25 МБ и 60 с): https://openrouter.ai/docs/guides/overview/multimodal/stt.md
- Справочник создания расшифровки: https://openrouter.ai/docs/api/api-reference/stt/create-transcription.md
- Справочник Chat Completions (часть `input_audio`, `reasoning`): https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md
- Structured Outputs: https://openrouter.ai/docs/guides/features/structured-outputs.md
- Лимиты, `GET /key`, ошибки 402/403/429: https://openrouter.ai/docs/api_reference/limits.md
- Ошибки и типы ошибок, `Retry-After`: https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- Аутентификация, формат ключа, причины 401: https://openrouter.ai/docs/api_reference/authentication.md
- Учёт использования (`usage.cost`): https://openrouter.ai/docs/cookbook/administration/usage-accounting.md
- Маршрутизация по провайдерам (`data_collection`, `zdr`, `require_parameters`): https://openrouter.ai/docs/guides/routing/provider-selection.md
- Zero Data Retention: https://openrouter.ai/docs/guides/features/zdr.md
- Сбор данных OpenRouter: https://openrouter.ai/docs/guides/privacy/data-collection.md
- Журналы и хранение у провайдеров: https://openrouter.ai/docs/guides/privacy/provider-logging.md
- OAuth PKCE: https://openrouter.ai/docs/guides/overview/auth/oauth.md
- Атрибуция приложения: https://openrouter.ai/docs/app-attribution.md
- Индекс документации: https://openrouter.ai/docs/llms.txt

Живые ответы API без ключа (18 ноября 2026 года): `GET https://openrouter.ai/api/v1/models`, `GET https://openrouter.ai/api/v1/models?output_modalities=transcription`, `GET https://openrouter.ai/api/v1/models/{id}/endpoints`.

Локально: `porch --list-agents`, `porch media capabilities --json`, `agy --help`, `agy models` (agy 1.5.11); код ветки `feat/subscription-harness` (`AiSettings.tsx`, `aiCopy.ts`, `shared/ai.ts`, `main/settings.ts`, `main/harness/*.ts`, `main/asr/pipeline.ts`, `main/asr/batch.ts`, `test/aiSettingsUi.test.ts`, `e2e/aiSettings.spec.ts`); `docs/subscription-harness.md`, `docs/verification-roadmap.md`.
