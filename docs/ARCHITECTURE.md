# EWLLauncher — архитектура (для разработчиков и ИИ)

Стек: **Electron** (main = Node.js, renderer = чистый HTML/CSS/JS без фреймворков). Единственная зависимость рантайма — `adm-zip`.
Запуск: `npm start` / `RUN-DEV.bat`. Сборка: `BUILD.bat` (electron-builder → `dist/*.exe`). Тесты: `npm test` (без Electron и сети).

## Слои и правила зависимостей

```
renderer (UI)  ──IPC──>  main/ipc/register.js  ──>  сервисы
                                                     ├─ settings/    настройки
                                                     ├─ accounts/    офлайн + Microsoft
                                                     ├─ minecraft/   версии, установка, Java, запуск
                                                     ├─ multiplayer/ сервер, подключение, приглашения
                                                     └─ core/        paths, http, store, secrets, logger
```
- Модули в `core/` ни от кого не зависят. `minecraft/`, `accounts/`, `multiplayer/` не знают про Electron и UI (кроме `ipc/register.js`, `index.js`, `secrets.js` — опциональный `safeStorage`).
- UI **никогда** не получает токены и не имеет доступа к Node: только `window.ewl.invoke/on` из `preload.js` (белый список каналов).
- Сборка объектов — `src/main/services.js` (composition root).

## Карта файлов

| Файл | Назначение |
|---|---|
| `main/index.js` | окно, CSP/sandbox, single instance, корректное завершение (останов сервера, закрытие UPnP) |
| `main/preload.js` | мост `window.ewl`; регэксп допустимых каналов и список событий |
| `main/ipc/register.js` | **все** IPC-обработчики; формат ответа `{ok,data}`/`{ok:false,error}`; события `evt:*` |
| `core/paths.js` | пути (`userDataDir`, `defaultGameDir`, `gamePaths`), `assertSafeId` против path traversal |
| `core/http.js` | `request` с повторами, `downloadFile` (SHA-1, размер, `.part`→rename), `runPool`, `friendlyNetworkError` |
| `core/store.js` | JSON-хранилище, атомарная запись, `.corrupt` при повреждении |
| `core/secrets.js` | шифрование токенов (DPAPI через `safeStorage`) |
| `core/logger.js` | лог в файл + кольцевой буфер + событие `line`; `redact` для секретов |
| `settings/settings.js` | значения по умолчанию, **валидация** (`normalize`), сохранение `settings.json` |
| `accounts/offline.js` | проверка ника, офлайн-UUID (как у Minecraft) |
| `accounts/microsoft.js` | Device Code → XBL → XSTS → Minecraft token → profile; refresh; понятные ошибки |
| `accounts/accounts.js` | `accounts.json`, `getLaunchProfile` (авто-обновление токена) |
| `minecraft/versions.js` | манифест Mojang (кэш оффлайн), установленные версии, `resolveVersion` (inheritsFrom) |
| `minecraft/rules.js` | правила `rules` для библиотек и аргументов |
| `minecraft/install.js` | скачивание client.jar, библиотек, ассетов, логконфига; распаковка natives |
| `minecraft/java.js` | поиск Java, загрузка рантайма Mojang, выбор Java (`ensureJava`) |
| `minecraft/loaders.js` | загрузчики Fabric, Quilt (профиль JSON с meta-сервера) и Forge (официальный installer.jar): список версий, установка, определение типа профиля |
| `minecraft/libs.js` | обязательные библиотеки загрузчика (Fabric API, Quilted Fabric API) с Modrinth; манифест `mods/.ewl-libs.json`, оптимизация их не удаляет |
| `minecraft/crash.js` | разбор причин вылета: правила `RULES` по логу игры, crash-report и hs_err; `analyze()` — чистая функция, `readCrashContext()` читает файлы |
| `market/market.js` | маркет модов: реестр источников `SOURCES` (сейчас Modrinth), `search`, `install` (с зависимостями и sha1), `listInstalled`, `remove`; манифест `mods/.ewl-market.json` |
| `skins/skins.js` | библиотека PNG-скинов (`SkinService`), проверка PNG, текущий скин и загрузка в аккаунт Microsoft |
| `minecraft/optimize.js` | моды производительности с Modrinth (Sodium, Lithium, FerriteCore…): план с зависимостями, проверка SHA-1, учёт установленных файлов в `mods/.ewl-optimize.json` |
| `minecraft/launch.js` | подготовка и сборка аргументов (`prepareLaunch`, `buildArguments`) — без запуска процесса |
| `minecraft/game.js` | `GameManager`: жизненный цикл процесса, события `progress/started/exit` |
| `multiplayer/server.js` | `ServerManager`: server.jar, eula, server.properties, whitelist, консоль |
| `multiplayer/session.js` | `HostSession`: проверка сервера → STUN → UPnP → IPv6 → самопроверка → код |
| `multiplayer/join.js` | `inspectInvite`: разбор кода + проверка доступности каждого адреса |
| `multiplayer/invite.js` | формат `EWL1-…` (deflate + контрольная сумма + срок) |
| `multiplayer/probe.js` | Server List Ping (версия, игроки, MOTD, задержка), `describeProbeError` |
| `multiplayer/stun.js`, `upnp.js`, `netinfo.js` | STUN-клиент, UPnP IGD, классификация IP (LAN/CGNAT/IPv6) |
| `renderer/ui.js` | `window.EWL`: `h()` (DOM без innerHTML), toast, modal, кэш состояния |
| `renderer/app.js` | роутер, строка прогресса, реакция на события игры |
| `renderer/optimize-ui.js` | окна оптимизации: предложение при запуске (`EWL.offerOptimization`) и управление (`EWL.manageOptimization`) |
| `renderer/welcome.js`, `renderer/files-ui.js` | приветствие при входе (`EWL.welcome`) и окно «Файлы лаунчера» (`EWL.openFiles`) |
| `renderer/pages/*.js` | страницы: `play`, `versions`, `market`, `accounts`, `skins`, `friend`, `settings` |
| `renderer/styles.css`, `hero.svg` | дизайн «тёмное стекло»; акцент задаётся CSS-переменными (`EWL.applyAccent`) |

## IPC-каналы
Invoke (`window.ewl.invoke(channel, ...args)`): `app:info|openExternal|openPath|logs`, `dialog:pickFolder|pickFile`, `settings:get|update`,
`accounts:list|addOffline|select|remove|msLogin|msCancel`, `versions:manifest|installed|install|loaders|installLoader|cancel|remove`, `java:detect`, `opt:status|install|remove|decline|createProfile`,
`versions:installLibs|libsStatus`, `market:sources|search|installed|install|remove`, `skin:list|save|remove|import|export|current|upload`, `app:paths`,
`game:status|launch|cancel|stop`, `mp:server:info|start|stop|cancel|command|whitelistAdd`, `mp:host:start|stop|status`, `mp:net:diagnose`, `mp:join:inspect|launch`.
События (`window.ewl.on`): `evt:progress|log|game|ms-code|ms-done|host-step|server-log|server-state`.

**Как добавить функцию:** логика в нужном модуле → `handle('x:y', …)` в `register.js` → при новом префиксе расширить `INVOKE_RE` в `preload.js` → вызвать `EWL.api('x:y')` из страницы → тест в `tests/smoke.js`.

## Подключение к другу (без прокси и VPN)
Прямое TCP-соединение игрок↔игрок. Никакой трафик игры не идёт через посредников.

**Хозяин** (`HostSession.start`):
1. `probe(127.0.0.1:port)` — сервер действительно запущен.
2. STUN (UDP, только чтобы узнать внешний IPv4; порт не используется для игры).
3. UPnP IGD: SSDP-поиск → `AddPortMapping` (аренда 1 ч с продлением каждые 30 мин, fallback на бессрочную при ошибке 725; при занятом порте — случайный внешний). Опция «проброшено вручную» пропускает UPnP.
4. Проверка: если `GetExternalIPAddress` вернул приватный/CGNAT-адрес — предупреждение, IPv4 исключается.
5. Глобальный IPv6 добавляется кандидатом.
6. Самопроверка внешнего адреса (может не пройти из-за отсутствия NAT loopback — это предупреждение, не ошибка).
7. Код `EWL1-…` со сроком действия (5 мин – 24 ч). При остановке/истечении проброс снимается.

**Друг** (`inspectInvite` → `mp:join:launch`): декодирование (формат, контрольная сумма, срок) → фильтр публичных адресов (если не разрешены локальные) → параллельный `probe` каждого адреса → выбор самого быстрого → установка нужной версии и запуск игры с автоподключением (`--quickPlayMultiplayer` для 1.20+, иначе `--server/--port`).

**Безопасность:** в коде нет паролей/токенов; доступ защищают online-mode и whitelist сервера (по умолчанию включены); `maxOutputLength` при распаковке кода; IP-адреса в приглашении валидируются; команды консоли сервера — одной строкой; ник для whitelist проверяется regexp-ом.

**Ограничения (физические, не баги):** CGNAT без IPv6 и роутер без UPnP/ручного проброса не дают принять входящее соединение без посредника. Лаунчер диагностирует это и объясняет причину.

## Forge
- Список версий: `maven-metadata.xml` (maven.minecraftforge.net) + метка «рекомендуемая» из `promotions_slim.json`. Поддерживается Minecraft от 1.12.2 (`forgeSupportsMc`).
- Установка (`installForge`): ванильная версия → `java -jar forge-<mc>-<ver>-installer.jar --installClient <папка игры>` (Java берётся как для родительской версии, окно не показывается) → проверка, что профиль появился → `installVersion` профиля (библиотеки, которые создаёт установщик, обязаны существовать).
- Установщик скачивается во временную папку `.ewl-tmp` с проверкой sha1 (файл `.sha1` с maven) и структуры архива, после установки удаляется. Для установщика создаётся минимальный `launcher_profiles.json`.
- Тип профиля определяет `versions.loaderFromId` (по id и `inheritsFrom`). Моды производительности Forge не ставятся (`optimize.status.supported` = только Fabric/Quilt).
- Для тестов `installLoader(..., { java, run })` позволяют подменить Java и запуск установщика (`tests/smoke.js`).

## Маркет модов, скины, библиотеки, разбор вылетов
- **Маркет:** `market.search` строит фасеты Modrinth (тип «мод», версия игры, загрузчики профиля, клиентская сторона); `install` использует `optimize.buildPlan` (обязательные зависимости до 2 уровней, sha1) и кладёт файлы в `instances/<профиль>/mods`. Новый источник = запись в `SOURCES` + ветка в `search`/`install`.
- **Библиотеки:** при установке Fabric/Quilt лаунчер вызывает `libs.installLibraries`; сбой сети не отменяет установку профиля (в ответе поле `library.error`).
- **Сборки:** отображаемое имя хранится в настройках `profileNames` (id → имя), папка и id версии не меняются. Удаление: `versions:remove {id, withData}`.
- **Скины:** редактор целиком в `renderer/pages/skins.js` (canvas 64×64, раскладка UV в `parts()/face()`); в main только проверка PNG и работа с файлами/Mojang API. Офлайн-аккаунтам скин загрузить нельзя.
- **Вылеты:** `GameManager` при ненулевом коде вызывает `crash.analyze`; результат (`analysis`) идёт в событии `evt:game` и рисуется окном в `app.js`. Новая причина = новое правило в `crash.js` + тест в `tests/smoke.js`.

## Профили и оптимизация
- Чистая версия играет в общей папке игры. Профили Fabric/Quilt (`inheritsFrom`) получают отдельную папку `<папка игры>\instances\<id профиля>` (свои моды, миры, настройки): `launch.js` подставляет её в `game_directory` и `cwd`.
- Оптимизация = установка модов производительности в `instances\<id>\mods`. Для чистой версии `opt:createProfile` создаёт профиль Fabric + моды. Лаунчер трогает только файлы из `.ewl-optimize.json`; чужие моды не удаляет и не дублирует.
- Перед запуском `EWL.offerOptimization` предлагает оптимизацию (можно отказаться навсегда для версии или во всех настройках).

## Данные на диске
- `%APPDATA%\EWLLauncher\` — `settings.json`, `accounts.json` (токены шифруются), `logs\launcher.log`.
- `%APPDATA%\.ewllauncher\` (папка игры, меняется в настройках) — `versions`, `libraries`, `assets`, `runtime` (Java), `servers\main`, миры/моды.

## Известные границы / куда развивать
- Загрузчики: Vanilla, Fabric, Quilt, Forge. NeoForge не реализован (схема та же, что у Forge: официальный установщик, другой maven `maven.neoforged.net`).
- Forge проверен только на моках: реальный запуск установщика и игры на Windows нужно проверить вручную.
- Вход Microsoft требует собственного Azure Client ID (см. README).
- Нет автообновления лаунчера и подписи кода (SmartScreen покажет предупреждение для неподписанного exe).
- Не проверено на реальной Windows в окружении автора кода: см. список ручных проверок в README.

## Модули 1.4–1.5
- `src/main/profiles/profiles.js` — бэкапы миров, копия, экспорт/импорт сборок (zip, защита от zip-slip).
- `src/main/market/modpacks.js` — модпаки Modrinth (.mrpack); `market.js` — моды, обновления/откат, ресурспаки и шейдеры.
- `src/main/multiplayer/ping.js` — Server List Ping; список серверов хранится в `settings.serverList`.
- `src/main/stats/stats.js` — время игры (`stats.json`); скриншоты читаются в IPC (`app:screenshots`, миниатюры через nativeImage).
- `src/main/updates.js` — проверка релиза GitHub; темы — `data-theme` на `<html>` и CSS-переменные.
- `src/main/market/curseforge.js` — CurseForge API (ключ из `settings.curseforgeKey`, загрузки только с *.forgecdn.net); `src/main/discord.js` — Rich Presence по локальному IPC, Application ID задаётся в `services.js`.
