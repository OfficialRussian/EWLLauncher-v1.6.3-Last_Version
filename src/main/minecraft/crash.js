'use strict';
/**
 * Разбор причин вылета игры. Читает хвост лога игры, свежий crash-report и hs_err (если есть)
 * и сопоставляет с известными реальными ошибками Minecraft, Java, Fabric, Forge и драйверов.
 * Результат — список находок { id, title, cause, steps[], action?, mods? }, самые вероятные причины первыми.
 * Никакого запуска процессов и сети: чистая функция analyze() + читалка файлов readCrashContext().
 */
const fsp = require('fs').promises;
const path = require('path');

/** Версия class-файла -> версия Java. */
const CLASS_TO_JAVA = { 52: 8, 53: 9, 54: 10, 55: 11, 56: 12, 57: 13, 58: 14, 59: 15, 60: 16, 61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25, 70: 26 };

/** Коды завершения Windows, которые встречаются при вылете JVM. */
const EXIT_CODES = {
  '-1073741819': 'ошибка доступа к памяти (0xC0000005): чаще всего виноваты драйвер видеокарты, антивирус или оверлей (MSI Afterburner, Discord, Overwolf)',
  '-1073740791': 'нарушение стека (0xC0000409): обычно драйвер видеокарты или программа-оверлей',
  '-1073740940': 'повреждение кучи (0xC0000374): конфликт с драйвером, оверлеем или повреждённый файл',
  '-805306369': 'процесс принудительно завершён (0xCFFFFFFF): его закрыли вручную, антивирус или система из-за нехватки памяти',
  137: 'процесс убит системой (обычно не хватило оперативной памяти)',
  143: 'процесс остановлен (SIGTERM)',
};

const uniq = (a) => [...new Set(a)];
const firstMatch = (text, re) => { const m = re.exec(text); return m ? m : null; };
const allMatches = (text, re) => { const out = []; let m; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); while ((m = g.exec(text))) out.push(m); return out; };

/** Драйверные DLL, видимые в «Problematic frame» / стеке. */
const DRIVER_DLLS = [
  [/nvoglv(32|64)\.dll|nvwgf2um|nvlddmkm|nvd3dum/i, 'NVIDIA'],
  [/atio6axx|atioglxx|aticfx|amdxx|atig6pxx|amdvlk/i, 'AMD'],
  [/ig(9|11|75|xprd|dxx|kmd)\w*\.dll|igd\w*\.dll|ig4icd\w*\.dll|ig9icd\w*\.dll/i, 'Intel'],
];

/** Правила: порядок = приоритет. test(ctx) возвращает null или находку. */
const RULES = [
  {
    id: 'java-too-old',
    test({ text, javaMajor }) {
      const m = firstMatch(text, /UnsupportedClassVersionError[^\n]*?class file version (\d+)(?:\.\d+)?[^\n]*?(?:up to|recognizes class file versions up to) (\d+)/i)
        || firstMatch(text, /class file version (\d+)(?:\.\d+)?\), this version of the Java Runtime only recognizes class file versions up to (\d+)/i);
      const need = m ? CLASS_TO_JAVA[parseInt(m[1], 10)] : null;
      const req = firstMatch(text, /requires (?:any )?version (\d+)(?:\.\d+)* or later of (?:mod )?'?Java(?: Runtime)?'?/i);
      if (!m && !req) return null;
      const java = need || (req ? parseInt(req[1], 10) : null);
      return {
        title: `Нужна более новая Java${java ? ` (${java}+)` : ''}`,
        cause: `Игра или мод собраны для ${java ? `Java ${java}` : 'более новой Java'}, а запущена Java ${javaMajor || 'старее'}.`,
        steps: [
          'В «Настройках» верните «Автоматически скачивать нужную Java от Mojang» и очистите поле «Путь к java.exe».',
          'Если указана своя Java, установите Java нужной версии или нажмите «Авто».',
        ],
        action: 'settings',
      };
    },
  },
  {
    id: 'out-of-memory',
    test({ text, ram }) {
      if (!/OutOfMemoryError|GC overhead limit exceeded|Java heap space|java\.lang\.OutOfMemoryError/i.test(text)) return null;
      return {
        title: 'Не хватило оперативной памяти',
        cause: `Игре выделено ${ram ? `${ram} МБ` : 'мало памяти'}, а модам и миру её не хватило.`,
        steps: [
          'Откройте «Настройки» и увеличьте «Максимум для игры» (для сборок с модами обычно 4–6 ГБ).',
          'Не отдавайте игре больше ~70% всей памяти компьютера и закройте лишние программы.',
          'Уменьшите дальность прорисовки в настройках игры.',
        ],
        action: 'settings',
      };
    },
  },
  {
    id: 'heap-reserve',
    test({ text }) {
      if (!/Could not reserve enough space for (?:\d+KB )?object heap|Invalid maximum heap size|Too small (?:initial|maximum) heap|Initial heap size set to a larger value than the maximum heap size|Error occurred during initialization of VM[\s\S]{0,200}heap/i.test(text)) return null;
      return {
        title: 'Java не смогла выделить память',
        cause: 'Заданный объём памяти слишком велик для этого компьютера (или у Java 32 бита), либо начальный объём больше максимального.',
        steps: [
          'В «Настройках» уменьшите «Максимум для игры» (например, до 2–4 ГБ).',
          'Следите, чтобы «Начальный объём» не превышал максимум.',
          'Если стоит своя 32-битная Java, нажмите «Авто» в настройках Java.',
        ],
        action: 'settings',
      };
    },
  },
  {
    id: 'bad-jvm-args',
    test({ text }) {
      const m = firstMatch(text, /Unrecognized (?:VM )?option[: ]+'?([^'\n]+?)'?(?:\r?\n|$)/i) || firstMatch(text, /Unrecognized option: ([^\n]+)/i);
      if (!m && !/Could not create the Java Virtual Machine/i.test(text)) return null;
      return {
        title: 'Неверные аргументы JVM',
        cause: m ? `Java не понимает параметр «${m[1].trim()}» (он не подходит для этой версии Java).` : 'Java не смогла создать виртуальную машину: вероятно, лишние или неверные аргументы JVM.',
        steps: ['В «Настройках» очистите поле «Дополнительные аргументы JVM» и запустите игру ещё раз.'],
        action: 'settings',
      };
    },
  },
  {
    id: 'module-conflict',
    test({ text }) {
      const m = firstMatch(text, /ResolutionException:[^\n]*(?:export package|contains package)[^\n]*/i);
      if (!m) return null;
      return {
        title: 'Конфликт модулей (дубликат игры или мода)',
        cause: 'Один и тот же код попал в игру дважды: это бывает, если в папке mods лежат две копии одного мода или в профиле Forge/NeoForge лишний клиентский jar.',
        steps: [
          'Откройте папку модов профиля и удалите дубликаты (одинаковые моды разных версий).',
          'Обновите лаунчер до последней версии: профили Forge/NeoForge требуют, чтобы клиентский jar назывался по имени профиля.',
          'Если не помогло, удалите профиль (без папки данных) и установите его заново.',
        ],
        action: 'mods',
        detail: m[0].slice(0, 200),
      };
    },
  },
  {
    id: 'fabric-missing-dep',
    test({ text }) {
      const names = uniq([
        ...allMatches(text, /Install ([a-z0-9_.-]+),? (?:any|version)/gi).map((m) => m[1]),
        ...allMatches(text, /requires (?:any version|version [^\n]*?) of (?:mod )?'?([a-z0-9_.-]+)'?,? which is missing/gi).map((m) => m[1]),
        ...allMatches(text, /Mod '[^']+' \([^)]+\)[^\n]*? depends on [^\n]*?'?([a-z0-9_.-]+)'?[^\n]*?(?:which is missing|not present)/gi).map((m) => m[1]),
      ]).filter((n) => !/^(java|minecraft|fabricloader|fabric-loader|quilt_loader)$/i.test(n));
      if (!names.length) return null;
      const fabricApi = names.some((n) => /^fabric-api|^fabric$/i.test(n));
      return {
        title: fabricApi ? 'Не хватает Fabric API' : 'Не хватает мода-зависимости',
        cause: `Один из модов требует: ${names.join(', ')}. Без этого мод не запускается.`,
        steps: fabricApi
          ? ['В разделе «Версии» нажмите «Библиотеки» у этого профиля: лаунчер поставит Fabric API.', 'Или найдите «Fabric API» в «Маркете модов».']
          : [`Установите недостающий мод (${names.join(', ')}) в «Маркете модов» или положите его в папку mods.`],
        action: fabricApi ? 'libs' : 'market',
        mods: names,
      };
    },
  },
  {
    id: 'forge-missing-dep',
    test({ text }) {
      const rows = allMatches(text, /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']+)', Actual version: '([^']+)'/gi);
      const missing = rows.filter((m) => /MISSING/i.test(m[4]) && !/^(minecraft|forge|neoforge)$/i.test(m[1]));
      const wrong = rows.filter((m) => !/MISSING/i.test(m[4]) && !/^(minecraft)$/i.test(m[1]));
      if (!missing.length && !wrong.length) return null;
      const need = uniq(missing.map((m) => m[1]));
      return {
        title: missing.length ? 'Не хватает модов-зависимостей' : 'Версия мода-зависимости не подходит',
        cause: missing.length
          ? `Моды требуют: ${missing.map((m) => `${m[1]} (нужен для ${m[2]})`).join('; ')}.`
          : `Неподходящая версия: ${wrong.map((m) => `${m[1]} (нужно ${m[3]}, стоит ${m[4]})`).join('; ')}.`,
        steps: ['Откройте «Маркет модов» и установите недостающие моды (или обновите указанные).', 'Убедитесь, что все моды собраны под ту же версию Minecraft и тот же загрузчик.'],
        action: 'market',
        mods: need,
      };
    },
  },
  {
    id: 'wrong-mc-version',
    test({ text }) {
      const m = firstMatch(text, /requires [^\n]*? of (?:mod )?'?minecraft'?[^\n]*(?:wrong version|which is missing|but only)/i)
        || firstMatch(text, /Mod ID: 'minecraft', Requested by: '([^']+)', Expected range: '([^']+)', Actual version: '([^']+)'/i);
      if (!m) return null;
      return {
        title: 'Мод собран для другой версии Minecraft',
        cause: 'Один из модов не подходит к версии игры, в которой вы запускаетесь.',
        steps: ['В «Маркете модов» скачивайте моды под версию профиля: лаунчер фильтрует их автоматически.', 'Удалите из папки mods моды для других версий.'],
        action: 'mods',
      };
    },
  },
  {
    id: 'mod-entrypoint',
    test({ text }) {
      const ms = allMatches(text, /Could not execute entrypoint stage '[^']+' due to errors, provided by '([^']+)'/gi);
      const bad = uniq(ms.map((m) => m[1]));
      if (!bad.length) return null;
      return {
        title: `Ошибка в моде: ${bad.join(', ')}`,
        cause: `Мод ${bad.join(', ')} не смог запуститься. Чаще всего он не подходит к версии игры или конфликтует с другим модом.`,
        steps: ['Временно уберите этот мод из папки mods.', 'Скачайте версию мода, подходящую к вашей версии Minecraft и загрузчику.'],
        action: 'mods',
        mods: bad,
      };
    },
  },
  {
    id: 'mixin',
    test({ text }) {
      if (!/Mixin apply failed|InvalidInjectionException|MixinTransformerError|MixinApplyError|Critical injection failure|Mixin transformation of [^\n]+ failed/i.test(text)) return null;
      const cfg = uniq(allMatches(text, /\[?([a-z0-9_.-]+)\.mixins?\.json/gi).map((m) => m[1])).filter((n) => !/^(minecraft|mixins?)$/i.test(n)).slice(0, 4);
      return {
        title: 'Конфликт модов (Mixin)',
        cause: `Мод не смог изменить код игры: он рассчитан на другую версию Minecraft или конфликтует с другим модом${cfg.length ? ` (в логе: ${cfg.join(', ')})` : ''}.`,
        steps: ['Уберите недавно добавленные моды и проверьте запуск.', 'Обновите моды до версий под вашу версию игры.', 'Не ставьте одновременно моды, делающие одно и то же (например два оптимизатора отрисовки).'],
        action: 'mods',
        mods: cfg,
      };
    },
  },
  {
    id: 'forge-patched-client-missing',
    test({ text }) {
      if (!/(?:NoSuchFileException|FileNotFoundException)[^\n]*client-[^\n]*(?:srg|extra|slim)|Cannot find[^\n]*client-(?:srg|extra)/i.test(text)) return null;
      return {
        title: 'Forge установлен не полностью',
        cause: 'Установщик Forge не создал патченный клиент игры (прервана установка, сработал антивирус или кончилось место).',
        steps: ['В «Версиях» удалите этот профиль (без папки данных) и установите Forge заново.', 'Добавьте папку игры в исключения антивируса.'],
        action: 'versions',
      };
    },
  },
  {
    id: 'missing-class',
    test({ text }) {
      const m = firstMatch(text, /java\.lang\.(NoClassDefFoundError|NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError)[:\s]*([^\n]*)/i);
      if (!m) return null;
      if (/net\/minecraft\/client\/main\/Main|net\.minecraft\.client\.main\.Main/.test(m[0])) return null; // это «повреждённые файлы», разберёт правило ниже
      return {
        title: 'Несовместимость мода с версией игры',
        cause: `Java не нашла нужный код (${m[1]}${m[2] ? `: ${m[2].trim().slice(0, 90)}` : ''}). Так бывает, когда мод собран для другой версии Minecraft или другого загрузчика.`,
        steps: ['Проверьте, что все моды в папке mods подходят по версии Minecraft и загрузчику (Fabric / Forge не взаимозаменяемы).', 'Уберите недавно добавленные моды.'],
        action: 'mods',
      };
    },
  },
  {
    id: 'corrupt-files',
    test({ text }) {
      if (!/Could not find or load main class|ClassNotFoundException: net\.minecraft\.client\.main\.Main|NoClassDefFoundError:\s*net\/minecraft\/client\/main\/Main|Invalid or corrupt jarfile|zip END header not found|invalid LOC header|Invalid central directory signature|ZipException|zip file is empty|invalid CEN header|error in opening zip file/i.test(text)) return null;
      return {
        title: 'Повреждён файл игры',
        cause: 'Один из файлов (jar игры, библиотека или мод) скачан не до конца или повреждён диском/антивирусом.',
        steps: [
          'В «Версиях» удалите эту версию и установите заново: лаунчер проверит все файлы по контрольным суммам.',
          'Если мод в папке mods скачан вручную, перекачайте его.',
          'Добавьте папку игры в исключения антивируса.',
        ],
        action: 'versions',
      };
    },
  },
  {
    id: 'gpu-driver',
    test({ text }) {
      const hit = firstMatch(text, /GLFW error (?:65542|65543|65544|65545)[^\n]*|The driver does not appear to support OpenGL|WGL: (?:The driver|Failed to)[^\n]*|Pixel format not accelerated|Failed to create (?:the )?(?:GLFW )?window|OpenGL (?:\d\.\d )?(?:is )?not supported|requires OpenGL [\d.]+|GLException|Could not initialize class org\.lwjgl|No OpenGL context found/i);
      if (!hit) return null;
      return {
        title: 'Проблема с видеодрайвером / OpenGL',
        cause: 'Игре не удалось создать окно с OpenGL. Обычно драйвер видеокарты старый или не установлен (в том числе при запуске через удалённый стол или в виртуальной машине).',
        steps: [
          'Обновите драйвер видеокарты с сайта производителя (NVIDIA, AMD или Intel).',
          'У ноутбуков с двумя видеокартами выберите для java.exe мощную видеокарту (Параметры Windows → Графика).',
          'Для очень старых видеокарт (ниже OpenGL 3.2) подойдут только старые версии Minecraft (до 1.16) или Fabric с модом Sodium для старых версий.',
        ],
        detail: hit[0].slice(0, 160),
      };
    },
  },
  {
    id: 'jvm-crash',
    test({ text }) {
      if (!/A fatal error has been detected by the Java Runtime Environment|EXCEPTION_ACCESS_VIOLATION|# Problematic frame|SIGSEGV/i.test(text)) return null;
      const frame = firstMatch(text, /# (?:C|V)\s+\[([^\]+]+)(?:\+0x[0-9a-f]+)?\]/i);
      const dll = frame ? frame[1] : '';
      const vendor = (DRIVER_DLLS.find(([re]) => re.test(dll)) || DRIVER_DLLS.find(([re]) => re.test(text)) || [])[1];
      return {
        title: 'Аварийное завершение Java (JVM)',
        cause: `Java упала на уровне системы${dll ? ` в модуле ${dll}` : ''}${vendor ? ` — это драйвер видеокарты ${vendor}` : ''}.`,
        steps: [
          vendor ? `Обновите или переустановите драйвер видеокарты ${vendor}.` : 'Обновите драйвер видеокарты и отключите программы-оверлеи (MSI Afterburner, Overwolf, Discord-оверлей).',
          'Добавьте папку игры и Java в исключения антивируса.',
          'Проверьте оперативную память (Средство проверки памяти Windows) и уберите разгон, если он есть.',
        ],
      };
    },
  },
  {
    id: 'auth',
    test({ text }) {
      if (!/Failed to verify username|Invalid session|Authentication servers are down|Bad login|Status: 401|InsufficientPrivilegesException|multiplayer is disabled|Disconnected: .*Invalid|Not authenticated with Minecraft\.net/i.test(text)) return null;
      return {
        title: 'Проблема с авторизацией',
        cause: 'Сервер или игра не приняли сессию аккаунта: срок входа истёк, или вы играете с офлайн-аккаунтом на сервере с проверкой лицензии.',
        steps: ['Для серверов с лицензией войдите через Microsoft в разделе «Аккаунты» (при необходимости удалите и добавьте аккаунт заново).', 'Для офлайн-серверов хозяин должен выключить online-mode.', 'Проверьте, что в аккаунте Microsoft включён Minecraft: Java Edition и нет ограничений Xbox (семейные настройки).'],
        action: 'accounts',
      };
    },
  },
  {
    id: 'network',
    test({ text }) {
      if (!/UnknownHostException|Connection timed out|Connection refused|ConnectException|SSLHandshakeException|sun\.security\.validator|PKIX path building failed/i.test(text)) return null;
      return {
        title: 'Сетевая ошибка',
        cause: 'Игре не удалось подключиться к серверу (нет интернета, блокировка брандмауэром/провайдером, неверный адрес).',
        steps: ['Проверьте интернет и адрес сервера.', 'Разрешите java.exe в брандмауэре и антивирусе.', 'При ошибке сертификата (PKIX) используйте Java от Mojang: в «Настройках» нажмите «Авто» у пути Java.'],
      };
    },
  },
  {
    id: 'disk-full',
    test({ text }) {
      if (!/No space left on device|There is not enough space on the disk|not enough space on the disk|ENOSPC/i.test(text)) return null;
      return { title: 'Закончилось место на диске', cause: 'Диску не хватило места для записи файлов игры или мира.', steps: ['Освободите место на диске с папкой игры (откройте «Файлы лаунчера» → «Папка игры»).', 'При необходимости смените папку игры в «Настройках».'], action: 'files' };
    },
  },
  {
    id: 'file-locked',
    test({ text }) {
      if (!/AccessDeniedException|Access is denied|being used by another process|FileSystemException:[^\n]*(?:process cannot access|used by another)/i.test(text)) return null;
      return { title: 'Файл занят или нет доступа', cause: 'Файл игры занят другой программой (антивирус, второй запуск игры, другой лаунчер) или нет прав на запись.', steps: ['Закройте остальные копии Minecraft и другие лаунчеры.', 'Добавьте папку игры в исключения антивируса.', 'Не размещайте папку игры в защищённых папках (например, Program Files).'] };
    },
  },
  {
    id: 'natives',
    test({ text }) {
      if (!/UnsatisfiedLinkError|Failed to locate library|Failed to load library|lwjgl[^\n]*(?:dll|native)[^\n]*(?:fail|error|not found)|Unable to load (?:native )?library|lwjgl\.dll/i.test(text)) return null;
      return { title: 'Не загрузились нативные библиотеки (LWJGL)', cause: 'Не удалось загрузить системные библиотеки игры: они удалены антивирусом, не распаковались или Java не подходит по разрядности (32/64 бита).', steps: ['Добавьте папку игры в исключения антивируса.', 'Удалите версию в «Версиях» и установите заново.', 'Используйте 64-битную Java (кнопка «Авто» в «Настройках»).'], action: 'versions' };
    },
  },
  {
    id: 'duplicate-mods',
    test({ text }) {
      if (!/DuplicateModsFoundException|Found duplicate mods|Duplicate mod(?:s)? (?:found|detected|ID)|duplicate mod/i.test(text)) return null;
      return { title: 'В папке mods лежат дубликаты', cause: 'Один и тот же мод установлен дважды (например две версии).', steps: ['Откройте папку модов профиля и оставьте у каждого мода только одну, самую подходящую версию.'], action: 'mods' };
    },
  },
];

/** Описание кода завершения Windows/Unix. */
function describeExit(code) {
  if (code === null || code === undefined) return null;
  return EXIT_CODES[String(code)] || null;
}

/** Краткая суть из crash-report: строка Description и первая строка исключения. */
function summarize(text) {
  const desc = firstMatch(text, /^Description: (.+)$/m);
  const exc = firstMatch(text, /^((?:java|net|org|com|cpw|io)\.[\w.$]+(?:Exception|Error)[^\n]*)$/m);
  const suspects = (() => {
    const m = firstMatch(text, /Suspected Mods?:\s*\n((?:\t[^\n]+\n?)+)/);
    return m ? m[1].split('\n').map((x) => x.trim()).filter((x) => x && !/^None$/i.test(x)).slice(0, 4) : [];
  })();
  return { description: desc ? desc[1].trim() : '', exception: exc ? exc[1].trim().slice(0, 240) : '', suspects };
}

/**
 * Анализ вылета. ctx: { lines[], crashReport?, hsErr?, code, error?, javaMajor?, ram?, kind? }.
 * Возвращает { findings[], summary, exitInfo }.
 */
function analyze(ctx) {
  const text = [ctx.error || '', (ctx.lines || []).join('\n'), ctx.crashReport || '', ctx.hsErr || ''].join('\n');
  const findings = [];
  for (const rule of RULES) {
    let f = null;
    try { f = rule.test({ ...ctx, text }); } catch (_) { f = null; }
    if (f) findings.push({ id: rule.id, ...f });
  }
  const exitInfo = describeExit(ctx.code);
  if (ctx.error && /Не удалось запустить Java/.test(ctx.error)) {
    findings.unshift({
      id: 'java-launch', title: 'Java не запускается', cause: 'Файл java.exe не найден или заблокирован (антивирус, повреждённая установка).',
      steps: ['В «Настройках» нажмите «Авто» у пути к Java и включите автоматическую загрузку Java.', 'Если Java скачана лаунчером, удалите папку runtime (откройте «Файлы лаунчера» → «Папка игры») и запустите игру: Java скачается заново.'], action: 'settings',
    });
  }
  const sum = summarize(text);
  if (!findings.length && exitInfo) {
    findings.push({ id: 'exit-code', title: 'Игра завершилась аварийно', cause: `Код завершения ${ctx.code}: ${exitInfo}.`, steps: ['Обновите драйвер видеокарты.', 'Отключите оверлеи и временно антивирус, затем запустите игру снова.', 'Если вылеты повторяются, пришлите лог (кнопка «Копировать лог»).'] });
  }
  return { findings: findings.slice(0, 5), summary: sum, exitInfo };
}

async function newestFile(dir, re, since) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return null; }
  let best = null;
  for (const n of names) {
    if (!re.test(n)) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.mtime)) best = { file: path.join(dir, n), mtime: st.mtimeMs };
    } catch (_) { /* исчез */ }
  }
  return best;
}

async function readHead(file, maxBytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
}

/** Свежий crash-report и hs_err, созданные после startedAt (мс). Размер ограничен, чтобы не читать гигабайты. */
async function readCrashContext(gameDir, startedAt) {
  const since = (startedAt || 0) - 5000;
  const out = { crashReport: '', hsErr: '', crashFile: '' };
  const cr = await newestFile(path.join(gameDir, 'crash-reports'), /^crash-.*\.txt$/i, since);
  if (cr) { try { out.crashReport = await readHead(cr.file, 96 * 1024); out.crashFile = cr.file; } catch (_) { /* нет доступа */ } }
  const hs = await newestFile(gameDir, /^hs_err_pid\d+\.log$/i, since);
  if (hs) { try { out.hsErr = await readHead(hs.file, 32 * 1024); } catch (_) { /* нет доступа */ } }
  return out;
}

module.exports = { analyze, readCrashContext, describeExit, summarize, CLASS_TO_JAVA, RULES };
