import type { ScenarioInfo } from './model/timeline'
import type { ReasonCategory } from './player/reason'

// Tiny i18n layer: two static dictionaries (RU is the source of truth, EN must
// match its shape — enforced by `typeof RU`), a module-level current language
// persisted in localStorage, and translation helpers for the scenario metadata
// that arrives from the backend in Russian. Switching the language reloads the
// page (chrome/controls bake their strings at construction), so t() is read
// once per boot everywhere except the per-frame caption/log builders.
export type Lang = 'ru' | 'en'

const KEY = 'gmp.lang'

let lang: Lang = (() => {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'ru'
  } catch {
    return 'ru' // non-browser environment (vitest) or blocked storage
  }
})()

export function getLang(): Lang {
  return lang
}

export function setLang(l: Lang): void {
  lang = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    // headless/test environment — in-memory value is enough
  }
}

const RU = {
  units: { ns: 'нс', us: 'мкс', ms: 'мс' },

  chrome: {
    source: 'runtime/trace · записанные факты',
    stats: ['Running', 'Runnable', 'Waiting', 'Syscall'],
    statsTip: 'Все наблюдаемые G, включая скрытые за +N. Состояние на текущем времени trace.',
    snapshot: 'Состояние runtime',
    procStates: { running: 'с M', idle: 'idle', syscall: 'syscall', inactive: 'неактивен', unknown: '?' },
    titleMain: 'Планировщик Go ',
    titleAccent: '· G·M·P',
    subtitleDefault: 'выберите сценарий ниже',
    gcTip: 'Фаза сборщика мусора: простой · конкурентная разметка (идёт вместе с горутинами) · stop-the-world (записанный интервал остановки и возобновления P)',
    heapCap: 'heap',
    heapTip: 'Куча: выделенные объекты / цель GC. Это не объём живых объектов после GC. Цель мягкая; возможны значения выше 100%. Цвет = фаза GC: серый — простой, бирюза — разметка, красный — STW',
    readout: (cycles: number, maxStw: string) => `${cycles} фаз mark · STW ≤ ${maxStw}`,
    readoutNone: 'без полных фаз mark',
    banner: (dur: string) => `Записанный STW-интервал: ${dur}`,
    customFacts: (events: number, numProcs: number, numGoroutines: number) =>
      `${events} событий, ${numProcs} P, ${numGoroutines} G`,
    langBtn: 'EN',
    langTip: 'Switch the interface to English',
  },

  inspector: {
    open: 'Инспектор', close: 'Закрыть инспектор', previous: 'Назад', next: 'Следующее событие',
    title: 'Инспектор trace', choose: 'Объект', snapshot: 'На текущем времени',
    state: 'Состояние', bindingP: 'Выполняется на P', bindingM: 'Связанный M', origin: 'P до syscall',
    owner: 'Владелец P', goroutine: 'Выполняемая G', bindings: 'Наблюдаемые связи',
    unknown: 'неизвестно', unseen: 'ещё не наблюдалось', knownBindings: 'связи записаны', unknownBindings: 'текущие связи неизвестны',
    reason: 'Причина перехода', history: 'События объекта', empty: 'До этого времени событий нет.',
    prompt: 'Выберите G, M или P на сцене либо в списке. Выбор приостанавливает воспроизведение.',
    boundary: 'Очереди, runnext и work stealing runtime/trace не раскрывает.',
    mBoundary: 'Отсутствие связи не означает, что M запаркован или завершён. mid в событии — ThreadID исполняющего контекста.',
    group: 'События с одинаковым временем применяются вместе. Карточка показывает полный снимок на этой отметке.',
    normalized: 'Нормализованное событие runtime/trace', context: 'P/M в create и unblock — контекст создателя или будильщика, не новая привязка G.',
    initial: 'Начальный снимок: начало этого состояния могло быть до записи trace.',
    latest: 'Последние события до текущего времени', exact: 'Точное время от начала trace',
    events: {
      g_status: 'Начальное состояние G', g_create: 'Создание G', g_run_start: 'Начало выполнения G',
      g_run_stop: 'G стала Runnable', g_block: 'G перешла в ожидание', g_unblock: 'Пробуждение G → Runnable',
      g_syscall_enter: 'G вошла в syscall', g_syscall_exit: 'G вернулась из syscall → Running', g_exit: 'Завершение G',
      p_start: 'M получил P', p_stop: 'P освободился от M', gc_range_active: 'Начальный активный диапазон',
      gc_range_begin: 'Начало диапазона runtime', gc_range_end: 'Конец диапазона runtime', metric: 'Измерение runtime', trace_end: 'Конец записи',
    },
  },

  timeline: {
    tip: 'Хронология всего прогона: янтарь — плотность событий, бирюза — конкурентная разметка, красные тики — STW-паузы, Клик/перетаскивание — переход',
    density: 'плотность событий',
    mark: 'парал. маркировка',
    stw: 'STW-пауза',
  },

  factory: {
    sign: 'GO SCHEDULER',
    signSub: 'цех планирования · смена 24/7',
    spawn: 'main()',
    exit: 'ВЫХОД',
    board: 'RUNNABLE',
  },

  gcPhase: {
    idle: 'GC: простой',
    mark: 'GC: парал. маркировка',
    stw: 'STW · runtime',
  },

  reasonCat: {
    канал: 'канал',
    сон: 'сон',
    sync: 'sync',
    GC: 'GC',
    прочее: 'прочее',
  } as Record<ReasonCategory, string>,

  legend: [
    ['Выполняется', 'Горутина бежит на P — прямо сейчас занимает слот выполнения'],
    ['Готова', 'Готова к выполнению; сейчас не выполняется'],
    ['Ожидание', 'Заблокирована: канал, sync, сон, GC-ассист — P не занимает'],
    ['Syscall', 'G находится в syscall на своём M. P может сохраняться в состоянии syscall до освобождения или возврата'],
    ['M — OS-поток', 'OS-поток: тележка с номером у P-станции и под горутиной в syscall. На бирке — порядковый номер M; настоящий id — в tooltip. Связи с G и P взяты из trace'],
    ['GC mark', 'Конкурентная разметка: GC работает ОДНОВРЕМЕННО с горутинами (это не пауза)'],
    ['STW', 'Записанный интервал координации остановки и возобновления P. Причина есть в журнале; это может быть GC или операция runtime'],
    ['Завершён', 'Горутина отработала и исчезает'],
  ] as ReadonlyArray<readonly [string, string]>,

  legendHint: 'колесо — зум · перетаскивание — панорама · двойной клик — сбросить вид',

  pills: {
    pstation: ['P-станции · выполнение', 'Слоты выполнения (=GOMAXPROCS); на каждом не больше одной бегущей горутины'],
    global: ['Runnable · готовы', 'Все готовые к выполнению G. Принадлежность локальным и глобальной очередям неизвестна'],
    waiting: ['Ожидание', 'Заблокированные горутины: канал, sync, сон, GC-ассист — P не занимают'],
    syscall: ['Syscall', 'G в syscall связана с M. Освобождение P и его следующий владелец показаны отдельными событиями'],
  } as Record<string, readonly [string, string]>,

  assumptions: {
    summary: 'Допущения: что в этом мире условно, а что — настоящие данные трейса',
    groups: [
      [
        'Неизвестно — trace этого не раскрывает',
        [
          'Состав локальных и глобальной очередей trace не раскрывает. Все Runnable показаны в общей области без назначения P.',
          'Work stealing нельзя установить по смене P. Кражи, runnext и перелив очередей не изображаются как записанные события.',
          'При пробуждении трейс называет P будильщика — в чью очередь встала горутина, неизвестно.',
        ],
      ],
      [
        'Масштаб и время',
        [
          'Скорость 1× — весь прогон за ~90 с; длительность реального trace указана на шкале. Пауза останавливает воспроизведение и декоративные движения.',
          'STW-вспышка растянута до ~⅓ секунды, чтобы её было видно; реальная пауза — микросекунды-миллисекунды (честная цифра — в подписи).',
          'Лимит спрайтов относится только к рисованию. +N считает скрытые G; это не ёмкость очереди.',
        ],
      ],
      [
        'Опущено',
        [
          'GC: фазы sweep и mark-assist; то, что фоновые mark-воркеры забирают ~25% CPU; цель кучи мягкая — реальная heap может её превышать.',
          'Детали вытеснения (записанная причина перехода сохраняется), netpoller и sysmon как отдельные сущности, внутренности аллокатора (gFree, mcache).',
          'Запаркованные M: их жизненного цикла в трейсе нет — тележка просто исчезает. На бирке — порядковый номер, id потока из trace — в тултипе.',
        ],
      ],
      [
        'Данные и сценарии',
        [
          'Кривая кучи даунсэмплена: точки не чаще раза в 2 мс.',
          'Сценарии нарочно замедлены CPU-работой, чтобы поток событий был обозримым, — продовый код так не пишут.',
        ],
      ],
      [
        'Декоративные элементы — визуальная сцена, не данные',
        [
          'Неоновая вывеска, ворота main()/выхода, постеры, конвейерные ленты, койки, телефонные будки, будки-станции (стекло/крыша/вентилятор), робот-уборщик и сирена — это «цех», антураж.',
          'Реальны данные, которые они показывают: занятость P (будка занята), наблюдаемое число Runnable на табло, размер кучи (плитки), фаза конкурентной разметки (робот метёт, heap пульсирует), паузы STW (сирена + виньетка). Плитки heap — условная шкала, не реальное расположение объектов.',
          'Позиции G меняются в момент события; движения внутри спрайта декоративны. STW-интервал включает координацию остановки и возобновления P: состояния G берутся из событий, общая заморозка не выводится.',
        ],
      ],
    ] as ReadonlyArray<readonly [string, readonly string[]]>,
    real: 'Настоящее — всё остальное, напрямую из runtime/trace: события и их время, состояния горутин, привязки P и M, фазы mark и интервалы STW, метрики кучи, причины блокировок.',
  },

  controls: {
    play: 'Играть',
    pause: 'Пауза',
    step: 'Шаг',
    run: 'Запустить',
    running: 'Запуск…',
    ariaBar: 'управление проигрыванием',
    ariaScrub: 'позиция во времени',
    ariaRun: 'запустить выбранный сценарий',
    idTip: 'показать номера горутин',
    mTip: 'показать OS-потоки (M)',
    scenario: 'сценарий',
    scenarioCap: 'СЦЕНАРИЙ',
    goroutines: 'горутины',
    procsTip: 'GOMAXPROCS — число P (слотов выполнения). Ограничено 1–8 под размер изо-сцены',
    gorTip: 'Сколько горутин запустить в сценарии (диапазон зависит от сценария)',
    ms: 'мс',
  },

  mode: {
    more: 'Подробнее',
    less: 'Свернуть',
    moreTip: 'показать журнал событий и легенду',
    lessTip: 'скрыть журнал событий и легенду',
  },

  present: {
    enterTip: 'Режим презентации (F)',
    exitTip: 'Выйти из режима презентации (Esc)',
  },

  intro: {
    defaultTitle: 'Планировщик Go',
    gotIt: 'Понятно',
    primer:
      '<b>G</b> — горутина. <b>M</b> — OS-поток, который её исполняет. <b>P</b> — ресурс runtime, необходимый M для выполнения Go.<br>' +
      'На каждом P выполняется не больше одной G. Waiting освобождает P; Syscall сохраняет связь G с M.<br>' +
      'Снизу — состояния G, без догадок о составе очередей. Номера и переходы взяты из trace. ',
  },

  boot: {
    noScenarios: 'сервер не вернул ни одного сценария',
    loadFail: 'Не удалось загрузить сценарии',
    backendHint: (m: string) => `${m} — запустите бэкенд (go run ./cmd/server -addr :8085) и обновите страницу.`,
    retry: 'Повторить',
    runError: (m: string) => `Ошибка запуска: ${m}. Проверьте, что бэкенд запущен.`,
  },

  api: {
    demoIndex: (status: number) => `демо-индекс: HTTP ${status}`,
    demoRun: (status: number) => `демо-прогон: HTTP ${status}`,
    noBaked: (scenario: string) => `в демо нет запечённого прогона для «${scenario}»`,
  },

  demo: {
    hint: 'демо-режим: без бэкенда',
    tip: 'На этой странице нет Go-бэкенда: показываются трейсы, записанные заранее в CI. Параметры выбирают ближайший запечённый прогон, а не пишут новый. Локальный запуск записывает trace для новой конфигурации; повтор воспроизводит кэш.',
    group: 'Демо-режим — эта страница без бэкенда',
    items: [
      'Трейсы записаны заранее в CI командой `cmd/bake` — настоящим конвейером, но не в момент вашего клика.',
      'GOMAXPROCS выбирает ближайший запечённый прогон (испечены 1, 4 и 8 для каждого сценария).',
      'Число горутин на прогон здесь не влияет: испечено значение по умолчанию для каждого сценария.',
      'Чтобы записывать трейс своими параметрами, запустите проект локально — см. README.',
    ],
  },

  narrate: {
    stw: 'STW: записанный интервал остановки и возобновления Go',
    mark: 'GC: фаза разметки (concurrent mark)',
    sysEnter: (gid: number, mName: string | null) =>
      `G${gid} ушла в syscall${mName ? ` — ${mName} выполняет системный вызов` : ''}`,
    sysExit: (gid: number, pid: number) => `G${gid} вернулась из syscall на P${pid}`,
    block: (gid: number, reason: string) => `G${gid} заблокирован: ${reason}`,
    exit: (gid: number) => `G${gid} завершилась`,
  },

  log: {
    snapshot: (gid: number, state: string) => `G${gid}: ${state} — первое наблюдаемое состояние`,
    gcActive: (name: string) => `Runtime: ${name} — уже активно при первом наблюдении`,
    header: 'журнал событий',
    headerTip: 'Все события трейса (кроме heap-метрик). Строка сверху показывает только самое заметное; здесь — всё.',
    cats: { sched: 'план', wait: 'ожид', syscall: 'syscall', gc: 'GC', proc: 'P' } as Record<string, string>,
    created: (gid: number, by: number | undefined) => `G${gid} создана${by !== undefined ? ` горутиной G${by}` : ''}`,
    whyFirst: (dur: string) => ` — ждала ${dur} (первый запуск)`,
    whyAfterSyscall: (dur: string) => ` — ждала ${dur} (после syscall)`,
    whyWoken: (dur: string, waker: number | undefined) =>
      ` — ждала ${dur}${waker !== undefined ? ` (разбужена G${waker})` : ''}`,
    gotP: (gid: number, pid: number, m: string | null, why: string) =>
      `G${gid} встала на P${pid}${m ? ` · ${m}` : ''}${why}`,
    offP: (gid: number, pid: number, ran: string | null) =>
      `G${gid} освободила P${pid}, стала Runnable${ran ? ` (бежала ${ran})` : ''}`,
    blocked: (gid: number, reason: string | undefined, ran: string | null) =>
      `G${gid} заблокирована${reason ? `: ${reason}` : ''}${ran ? ` (бежала ${ran})` : ''}`,
    sysReturnRunnable: (gid: number, dur: string) =>
      `G${gid} завершила syscall, стала Runnable (в syscall ${dur})`,
    woken: (gid: number, by: number | undefined, reason: string | undefined, dur: string | null) =>
      `G${gid} разбужена${by !== undefined ? ` горутиной G${by}` : ''}${
        dur ? ` — ждала${reason ? ` «${reason}»` : ''} ${dur}` : ''
      }`,
    sysEnter: (gid: number, m: string | null) => `G${gid} ушла в syscall${m ? ` — ${m} выполняет системный вызов` : ''}`,
    sysExit: (gid: number, pid: number, dur: string | null) =>
      `G${gid} вернулась из syscall на P${pid}${dur ? ` (в syscall ${dur})` : ''}`,
    exited: (gid: number, lived: string | null) => `G${gid} завершилась${lived ? ` (жила ${lived})` : ''}`,
    pSnapshot: (pid: number, state: string) => `P${pid}: ${state} — первое наблюдаемое состояние`,
    pStart: (pid: number, m: string | null) => `P${pid} запущен${m ? ` · ${m}` : ''}`,
    pStopRetake: (pid: number, m: string, gid: number) =>
      `P${pid} освобождён; G${gid} остаётся в syscall на ${m}`,
    pStop: (pid: number) => `P${pid} остановлен`,
    gcBegin: (name: string) => `Runtime: ${name} — начало`,
    gcEnd: (name: string) => `Runtime: ${name} — конец`,
  },

  scene: {
    states: { running: 'бежит', runnable: 'готова', waiting: 'ждёт', syscall: 'syscall', dead: 'завершилась' } as Record<string, string>,
    mName: (alias: number, mid: number) => `M${alias} • OS-поток (id ${mid})`,
    inSyscallWith: (gid: number) => ` · в syscall с G${gid}`,
    boundTo: (pid: number) => ` · привязан к P${pid}`,
    carries: (gid: number) => ` · несёт G${gid}`,
  },

  custom: {
    chip: 'Мой трейс',
    panelTitle: 'Загрузить свой трейс',
    close: 'Закрыть загрузку',
    step1: '1. Запишите трейс в своей Go-программе:',
    step2: '2. Остановите запись, как только собрали интересный момент — трейсы быстро становятся большими.',
    step3: '3. Выберите файл .trace ниже или перетащите его сюда.',
    choose: 'Выбрать файл',
    copy: 'Копировать',
    copied: 'Скопировано',
    uploading: 'Загрузка…',
    needsServer: 'Загрузка трейса требует локального бэкенда — см. README.',
    error: {
      tooBig: 'Файл больше 16 МБ — это лимит демки.',
      unreadable: 'Не похоже на трейс Go: файл не читается как runtime/trace.',
      tooDense: 'Трейс слишком плотный: больше 200 000 событий — демка не потянет.',
      tooManyProcs: (n: number) => `Трейс использует ${n} P, эта демка поддерживает до 8 — попробуйте \`GOMAXPROCS=8 go run .\` при записи.`,
      notATrace: 'В трейсе нет активности ни одного P — нечего показывать.',
      generic: (status: number) => `Не удалось загрузить трейс: HTTP ${status}.`,
    },
    assumeTitle: 'Мой трейс — что здесь условно',
    assumeItems: [
      'данные настоящие, но что в них — отвечает файл',
      'GOMAXPROCS берётся из записанной метрики. Для старых файлов без неё число P — нижняя граница по наблюдаемым ID.',
      'не кэшируется, share-ссылки нет',
    ],
  },
}

export type Strings = typeof RU

const EN: Strings = {
  units: { ns: 'ns', us: 'µs', ms: 'ms' },

  chrome: {
    source: 'runtime/trace · recorded facts',
    stats: ['Running', 'Runnable', 'Waiting', 'Syscall'],
    statsTip: 'All observed Gs, including those hidden behind +N. State at the current trace time.',
    snapshot: 'Runtime state',
    procStates: { running: 'with M', idle: 'idle', syscall: 'syscall', inactive: 'inactive', unknown: '?' },
    titleMain: 'Go Scheduler ',
    titleAccent: '· G·M·P',
    subtitleDefault: 'pick a scenario below',
    gcTip: 'Garbage-collector phase: idle · concurrent mark (runs alongside goroutines) · STW (recorded coordination interval of stopping and restarting Ps)',
    heapCap: 'heap',
    heapTip: 'Heap: allocated objects / GC goal, not the post-GC live set. The goal is soft and the ratio may exceed 100%. Color = GC phase: gray — idle, teal — mark, red — STW',
    readout: (cycles: number, maxStw: string) => `${cycles} mark phases · STW ≤ ${maxStw}`,
    readoutNone: 'no complete mark phases',
    banner: (dur: string) => `Recorded STW interval: ${dur}`,
    customFacts: (events: number, numProcs: number, numGoroutines: number) => `${events} events, ${numProcs} P, ${numGoroutines} G`,
    langBtn: 'RU',
    langTip: 'Переключить интерфейс на русский',
  },

  inspector: {
    open: 'Inspector', close: 'Close inspector', previous: 'Back', next: 'Next event',
    title: 'Trace inspector', choose: 'Resource', snapshot: 'At the playhead',
    state: 'State', bindingP: 'Executing on P', bindingM: 'Associated M', origin: 'P before syscall',
    owner: 'P owner', goroutine: 'Executing G', bindings: 'Observed bindings',
    unknown: 'unknown', unseen: 'not yet observed', knownBindings: 'recorded bindings', unknownBindings: 'current bindings unknown',
    reason: 'Transition reason', history: 'Resource events', empty: 'No events before this time.',
    prompt: 'Select G, M or P in the scene or the list. Selection pauses playback.',
    boundary: 'runtime/trace does not expose queues, runnext or work stealing.',
    mBoundary: 'A missing binding does not establish that M is parked or terminated. Event mid is the executing context’s ThreadID.',
    group: 'Events with the same timestamp apply together. The card shows the complete snapshot at that time.',
    normalized: 'Normalized runtime/trace event', context: 'P/M in create and unblock describe the creator or unblocker, not a new G binding.',
    initial: 'Initial snapshot: this state may have started before trace recording.',
    latest: 'Latest events up to the playhead', exact: 'Exact time since trace start',
    events: {
      g_status: 'Initial G state', g_create: 'G created', g_run_start: 'G started running',
      g_run_stop: 'G became Runnable', g_block: 'G started waiting', g_unblock: 'G unblocked → Runnable',
      g_syscall_enter: 'G entered syscall', g_syscall_exit: 'G returned from syscall → Running', g_exit: 'G terminated',
      p_start: 'M acquired P', p_stop: 'P released from M', gc_range_active: 'Initially active range',
      gc_range_begin: 'Runtime range began', gc_range_end: 'Runtime range ended', metric: 'Runtime measurement', trace_end: 'Recording ended',
    },
  },

  timeline: {
    tip: 'Timeline of the whole run: amber — event density, teal — concurrent mark, red ticks — recorded STW pauses. Click/drag to seek',
    density: 'event density',
    mark: 'concurrent mark',
    stw: 'STW pause',
  },

  factory: {
    sign: 'GO SCHEDULER',
    signSub: 'scheduling floor · shift 24/7',
    spawn: 'main()',
    exit: 'EXIT',
    board: 'RUNNABLE',
  },

  gcPhase: {
    idle: 'GC: idle',
    mark: 'GC: concurrent mark',
    stw: 'STW · runtime',
  },

  reasonCat: {
    канал: 'chan',
    сон: 'sleep',
    sync: 'sync',
    GC: 'GC',
    прочее: 'other',
  } as Record<ReasonCategory, string>,

  legend: [
    ['Running', 'The goroutine runs on a P — it occupies an execution slot right now'],
    ['Runnable', 'Ready to run; currently not executing'],
    ['Waiting', 'Blocked: channel, sync, sleep, GC assist — takes no P'],
    ['Syscall', 'G is in a syscall on its M. P may remain in syscall state until release or return'],
    ['M — OS thread', 'OS thread: the numbered carrier at a P station and under a goroutine in a syscall. The tag uses an M ordinal; the tooltip includes its trace id. G/P bindings come from the trace'],
    ['GC mark', 'Concurrent mark: the GC works AT THE SAME TIME as goroutines (this is not a pause)'],
    ['STW', 'Recorded coordination interval of stopping and restarting Ps. The log carries its reason; GC or another runtime operation may cause it'],
    ['Done', 'The goroutine finished and disappears'],
  ] as ReadonlyArray<readonly [string, string]>,

  legendHint: 'wheel — zoom · drag — pan · double-click — reset view',

  pills: {
    pstation: ['P stations · running', 'Execution slots (=GOMAXPROCS); at most one running goroutine on each'],
    global: ['Runnable · ready', 'All runnable Gs. Local and global queue membership is unknown'],
    waiting: ['Waiting', 'Blocked goroutines: channel, sync, sleep, GC assist — they take no P'],
    syscall: ['Syscall', 'A G in syscall stays associated with M. P release and its next owner are shown as separate events'],
  } as Record<string, readonly [string, string]>,

  assumptions: {
    summary: 'Assumptions: what is stylized in this world and what is real trace data',
    groups: [
      [
        'Unknown — the trace does not expose this',
        [
          'The trace does not expose local or global queue membership. All Runnable Gs appear in one unassigned pool.',
          'A change of P does not prove work stealing. Steals, runnext and queue overflow are not shown as recorded events.',
          'On wakeup the trace names the waker’s P — which queue the goroutine actually joined is unknown.',
        ],
      ],
      [
        'Scale and time',
        [
          'Speed 1× plays the entire trace in ~90 s; the time axis shows its recorded duration. Pause stops playback and decorative movement.',
          'The STW flash is stretched to ~⅓ s to be visible; the real pause is microseconds-to-milliseconds (the honest number is in the caption).',
          'Crowded state areas show a limited number of sprites. The +N badge counts hidden Gs; this is a drawing limit, not queue capacity.',
        ],
      ],
      [
        'Omitted',
        [
          'GC: sweep and mark-assist phases; the ~25% of CPU taken by background mark workers; the heap goal is soft — the real heap may overshoot it.',
          'Preemption internals (the recorded transition reason is preserved), netpoller and sysmon as entities, allocator internals (gFree, mcache).',
          'Parked M’s: the trace has no M lifecycle — the carrier simply disappears. The tag shows an ordinal; the trace thread id is in the tooltip.',
        ],
      ],
      [
        'Data and scenarios',
        [
          'The heap curve is downsampled: points at most once per 2 ms.',
          'Scenarios are deliberately paced with CPU work to keep the event stream readable — production code is not written like this.',
        ],
      ],
      [
        'Decorative elements — visual staging, not data',
        [
          'The neon sign, main()/exit gates, posters, conveyor belts, bunks, phone stalls, booth stations (glass/roof/fan), the cleaning robot and the siren are "factory" set dressing.',
          'What they reflect IS real: P occupancy (a busy booth), the observed Runnable count on the board, the heap size (the tiles), the concurrent-mark phase (the robot sweeps, the heap pulses), STW pauses (siren + vignette).',
          'G and M positions change with trace events. Poses and scenery are decorative. STW ranges include stopping and restarting Ps; G states come from their events, without inferring a global freeze.',
        ],
      ],
    ] as ReadonlyArray<readonly [string, readonly string[]]>,
    real: 'Everything else is real, straight from runtime/trace: events and their timing, goroutine states, P and M bindings, mark phases and STW intervals, heap metrics, block reasons.',
  },

  controls: {
    play: 'Play',
    pause: 'Pause',
    step: 'Step',
    run: 'Run',
    running: 'Running…',
    ariaBar: 'playback controls',
    ariaScrub: 'position in time',
    ariaRun: 'run the selected scenario',
    idTip: 'show goroutine ids',
    mTip: 'show OS threads (M)',
    scenario: 'scenario',
    scenarioCap: 'SCENARIO',
    goroutines: 'goroutines',
    procsTip: 'GOMAXPROCS — the number of P (execution slots). Limited to 1–8 to fit the iso scene',
    gorTip: 'How many goroutines the scenario starts (the range depends on the scenario)',
    ms: 'ms',
  },

  mode: {
    more: 'More',
    less: 'Less',
    moreTip: 'show the event log and legend',
    lessTip: 'hide the event log and legend',
  },

  present: {
    enterTip: 'Presentation mode (F)',
    exitTip: 'Exit presentation mode (Esc)',
  },

  intro: {
    defaultTitle: 'Go Scheduler',
    gotIt: 'Got it',
    primer:
      '<b>G</b> is a goroutine. <b>M</b> is its OS thread. <b>P</b> is the runtime resource an M needs to execute Go.<br>' +
      'Each P executes at most one G. Waiting releases the P; Syscall keeps the G associated with its M.<br>' +
      'The lower areas show G states, without guessing queue membership. Identities and transitions come from the trace. ',
  },

  boot: {
    noScenarios: 'the server returned no scenarios',
    loadFail: 'Failed to load scenarios',
    backendHint: (m: string) => `${m} — start the backend (go run ./cmd/server -addr :8085) and reload the page.`,
    retry: 'Retry',
    runError: (m: string) => `Run failed: ${m}. Check that the backend is up.`,
  },

  api: {
    demoIndex: (status: number) => `demo index: HTTP ${status}`,
    demoRun: (status: number) => `demo run: HTTP ${status}`,
    noBaked: (scenario: string) => `the demo has no baked run for “${scenario}”`,
  },

  demo: {
    hint: 'demo mode: no backend',
    tip: 'This page has no Go backend: it replays traces recorded ahead of time in CI. Parameters select the nearest pre-baked run rather than recording a new one. Local runs record a trace for each new configuration; repeated runs replay the cached trace.',
    group: 'Demo mode — this page has no backend',
    items: [
      'Traces were recorded ahead of time in CI by `cmd/bake` — the real pipeline, just not at the moment you clicked.',
      'GOMAXPROCS selects the nearest baked run (1, 4 and 8 are baked for every scenario).',
      'The goroutine count has no effect here: each scenario is baked at its default.',
      'To record a trace with your own parameters, run the project locally — see the README.',
    ],
  },

  narrate: {
    stw: 'STW: recorded interval of stopping and restarting Go',
    mark: 'GC: mark phase (concurrent mark)',
    sysEnter: (gid: number, mName: string | null) =>
      `G${gid} entered a syscall${mName ? ` — ${mName} executes the system call` : ''}`,
    sysExit: (gid: number, pid: number) => `G${gid} returned from syscall to P${pid}`,
    block: (gid: number, reason: string) => `G${gid} blocked: ${reason}`,
    exit: (gid: number) => `G${gid} finished`,
  },

  log: {
    snapshot: (gid: number, state: string) => `G${gid}: ${state} — first observed state`,
    gcActive: (name: string) => `Runtime: ${name} — active when first observed`,
    header: 'event log',
    headerTip: 'All trace events (except heap metrics). The caption above shows only the most salient; here is everything.',
    cats: { sched: 'sched', wait: 'wait', syscall: 'syscall', gc: 'GC', proc: 'P' } as Record<string, string>,
    created: (gid: number, by: number | undefined) => `G${gid} created${by !== undefined ? ` by goroutine G${by}` : ''}`,
    whyFirst: (dur: string) => ` — waited ${dur} (first run)`,
    whyAfterSyscall: (dur: string) => ` — waited ${dur} (after syscall)`,
    whyWoken: (dur: string, waker: number | undefined) =>
      ` — waited ${dur}${waker !== undefined ? ` (woken by G${waker})` : ''}`,
    gotP: (gid: number, pid: number, m: string | null, why: string) =>
      `G${gid} got P${pid}${m ? ` · ${m}` : ''}${why}`,
    offP: (gid: number, pid: number, ran: string | null) =>
      `G${gid} released P${pid}, became Runnable${ran ? ` (ran ${ran})` : ''}`,
    blocked: (gid: number, reason: string | undefined, ran: string | null) =>
      `G${gid} blocked${reason ? `: ${reason}` : ''}${ran ? ` (ran ${ran})` : ''}`,
    sysReturnRunnable: (gid: number, dur: string) =>
      `G${gid} finished its syscall, became Runnable (in syscall ${dur})`,
    woken: (gid: number, by: number | undefined, reason: string | undefined, dur: string | null) =>
      `G${gid} woken${by !== undefined ? ` by goroutine G${by}` : ''}${
        dur ? ` — waited${reason ? ` “${reason}”` : ''} ${dur}` : ''
      }`,
    sysEnter: (gid: number, m: string | null) => `G${gid} entered a syscall${m ? ` — ${m} executes the system call` : ''}`,
    sysExit: (gid: number, pid: number, dur: string | null) =>
      `G${gid} returned from syscall to P${pid}${dur ? ` (in syscall ${dur})` : ''}`,
    exited: (gid: number, lived: string | null) => `G${gid} finished${lived ? ` (lived ${lived})` : ''}`,
    pSnapshot: (pid: number, state: string) => `P${pid}: ${state} — first observed state`,
    pStart: (pid: number, m: string | null) => `P${pid} started${m ? ` · ${m}` : ''}`,
    pStopRetake: (pid: number, m: string, gid: number) =>
      `P${pid} released; G${gid} remains in syscall on ${m}`,
    pStop: (pid: number) => `P${pid} stopped`,
    gcBegin: (name: string) => `Runtime: ${name} — begin`,
    gcEnd: (name: string) => `Runtime: ${name} — end`,
  },

  scene: {
    states: { running: 'running', runnable: 'ready', waiting: 'waiting', syscall: 'syscall', dead: 'finished' } as Record<string, string>,
    mName: (alias: number, mid: number) => `M${alias} • OS thread (id ${mid})`,
    inSyscallWith: (gid: number) => ` · in syscall with G${gid}`,
    boundTo: (pid: number) => ` · bound to P${pid}`,
    carries: (gid: number) => ` · carries G${gid}`,
  },

  custom: {
    chip: 'My trace',
    panelTitle: 'Upload your own trace',
    close: 'Close upload',
    step1: '1. Record a trace in your Go program:',
    step2: '2. Stop it once you have captured the moment you want — traces get large fast.',
    step3: '3. Choose a .trace file below, or drag it onto the stage.',
    choose: 'Choose file',
    copy: 'Copy',
    copied: 'Copied',
    uploading: 'Uploading…',
    needsServer: 'Uploading a trace needs the local backend — see the README.',
    error: {
      tooBig: 'File is over 16 MB — that is this demo\'s limit.',
      unreadable: 'Does not look like a Go trace: the file could not be read as a runtime/trace.',
      tooDense: 'Trace is too dense: more than 200,000 events — this demo cannot handle it.',
      tooManyProcs: (n: number) => `The trace uses ${n} Ps; this demo supports up to 8 — try \`GOMAXPROCS=8 go run .\` when recording.`,
      notATrace: 'The trace has no P activity — nothing to show.',
      generic: (status: number) => `Failed to load the trace: HTTP ${status}.`,
    },
    assumeTitle: 'Your trace — what is conventional here',
    assumeItems: [
      'the data is real, but what is in it is on the file',
      'GOMAXPROCS comes from the recorded metric. In older payloads without it, the P count is a lower bound from observed IDs.',
      'not cached, no share links',
    ],
  },
}

export function t(): Strings {
  return lang === 'en' ? EN : RU
}

// The backend ships scenario titles/descriptions in Russian; the EN texts live
// here, keyed by scenario id, with a graceful fallback to the backend strings
// for scenarios this map does not know yet.
const SCENARIO_EN: Record<string, { title: string; description: string }> = {
  workstealing: {
    title: 'CPU scheduling',
    description: 'CPU goroutines run across Ps. The trace records execution, but not queue membership or steals.',
  },
  pingpong: {
    title: 'Channels (ping-pong)',
    description: 'A ring of goroutines passes tokens over channels: a few run, the rest wait on chan receive.',
  },
  gcpressure: {
    title: 'GC pressure (allocations)',
    description: 'Goroutines churn garbage fast: the heap grows and the GC runs in cycles with mark and stop-the-world phases.',
  },
  syscalls: {
    title: 'Blocking syscalls (M handoff)',
    description: 'Goroutines block in real syscall reads from a pipe: the M blocks with the goroutine, sysmon retakes the P and hands it to another M.',
  },
  mutex: {
    title: 'Hot mutex (contention)',
    description: 'N workers share one sync.Mutex: the critical section serializes the work — one runs, the rest wait, no matter how many Ps there are.',
  },
  leak: {
    title: 'Goroutine leak',
    description: 'Some goroutines wait on a channel nobody ever writes to: the Waiting zone only grows — this is what a production leak looks like.',
  },
}

export function scenarioTitle(info: ScenarioInfo | undefined): string {
  if (!info) return ''
  if (lang === 'en') return SCENARIO_EN[info.id]?.title ?? info.title
  return info.title
}

export function scenarioDesc(info: ScenarioInfo | undefined): string {
  if (!info) return ''
  if (lang === 'en') return SCENARIO_EN[info.id]?.description ?? info.description
  return info.description
}
