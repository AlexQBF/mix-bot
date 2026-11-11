/**
 * Sigma Mix — Telegram-бот подбора кальянных миксов на Cloudflare Workers.
 *
 * Клиент пишет в свободной форме, что любит и как крепко курит →
 * ИИ разбирает запрос → код отбирает подходящие табаки из справочника →
 * ИИ собирает 3 микса → одна картинка на три микса + три карточки текстом.
 *
 * ВСЕ правила, тексты и параметры живут в Google Таблице (CONFIG_SHEET_ID).
 * Бот раз в 15 минут (или по команде /reload) читает таблицу, проверяет её
 * и кладёт копию в KV. Клиентские запросы в таблицу не ходят — только в копию.
 * Если таблица недоступна или заполнена с ошибкой — работает прежняя копия,
 * а если копии ещё нет — значения по умолчанию из этого файла (DEFAULTS).
 *
 * Справочник вкусов собирается с htreviews.org по брендам из таблицы и лежит в KV.
 *
 * Секреты:  BOT_TOKEN, WEBHOOK_SECRET, LLM_API_KEY (только для внешних мозгов)
 * Биндинги: KV (хранилище), AI (Workers AI)
 * wrangler.toml [vars]: CONFIG_SHEET_ID, ADMIN_IDS, LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL, IMAGE_MODEL
 */

/* ═════════════════════════ Значения по умолчанию ═════════════════════════
 * Это же содержимое лежит в Google Таблице. Таблица главнее: всё, что в ней заполнено,
 * перекрывает эти значения. Здесь — страховка на случай, если таблица недоступна.
 */

// «Да» / «нет» в таблице — любые привычные варианты.
const YES = ['да', 'yes', 'y', '1', '+', 'вкл', 'on', 'true', 'այո'];
const NO = ['нет', 'no', 'n', '0', '-', 'выкл', 'off', 'false', 'ոչ', ''];

// Тексты бота: ключ → [русский, армянский, где показывается].
// <b>жирный</b>, <i>курсив</i>; {i}, {n}, {g} — подставляемые числа.
export const DEFAULT_TEXTS = {
  hello: [
    'Привет! Я <b>Sigma Mix</b>, твой карманный кальянщик 💨\n\n' +
    'Напиши что нравится: <i>«хочу ягодное с кислинкой»</i>, <i>«люблю Deus»</i>, <i>«чтобы освежало, но не мята»</i>.\n\n' +
    'Подберу 3 микса с пропорциями и описанием.\n' +
    'Понравилось - бери табачок у нас в VektorSIGMA 🛒\n\n' +
    '<i>Строго 18+</i>',
    'Բարև՛։ Ես <b>Sigma Mix</b>-ն եմ՝ քո գրպանի կալյանի վարպետը 💨\n\n' +
    'Գրիր, թե ինչ է քեզ դուր գալիս՝ <i>«ուզում եմ հատապտղային՝ թթվաշությամբ»</i>, <i>«սիրում եմ Deus»</i>, <i>«որ թարմացնի, բայց ոչ անանուխ»</i>։\n\n' +
    'Կընտրեմ 3 միքս՝ համամասնություններով և նկարագրությամբ։\n' +
    'Հավանեցի՞ր՝ ծխախոտը գնիր մեզ մոտ՝ VektorSIGMA-ում 🛒\n\n' +
    '<i>Խիստ 18+</i>',
    'Приветствие после /start (показываются оба языка подряд)'],
  choose_lang: ['Выбери язык 👇', 'Ընտրիր լեզուն 👇', 'Под приветствием и по команде /language, над кнопками языка'],
  lang_set: ['Отлично, общаемся по-русски 🇷🇺\nНапиши, что тебе нравится, — подберу миксы.',
    'Հիանալի՛, խոսում ենք հայերեն 🇦🇲\nԳրիր, թե ինչ է քեզ դուր գալիս, և ես միքսեր կընտրեմ։', 'После выбора языка'],
  ask_strength: ['Понял по вкусам. А как крепко куришь?', 'Հասկացա համերը։ Իսկ որքա՞ն թունդ ես ծխում։', 'Вопрос о крепости, если клиент не сказал'],
  btn_light: ['🌿 Лёгко', '🌿 Թեթև', 'Кнопка крепости'],
  btn_medium: ['⚖️ Средне', '⚖️ Միջին', 'Кнопка крепости'],
  btn_strong: ['🔥 Крепко', '🔥 Թունդ', 'Кнопка крепости'],
  btn_any: ['Без разницы', 'Միևնույն է', 'Кнопка крепости'],
  picking: ['🔎 Подбираю миксы…', '🔎 Միքսեր եմ ընտրում…', 'Пока бот думает'],
  picking_more: ['🔄 Думаю над другими вариантами…', '🔄 Մտածում եմ այլ տարբերակների մասին…', 'После кнопки «Ещё варианты»'],
  cover: ['Твои {n} микса 👇 слева направо — по порядку', 'Քո {n} միքսերը 👇 ձախից աջ՝ ըստ հերթականության', 'Подпись под картинкой; {n} — сколько миксов'],
  mix_of: ['Микс {i} из {n}', 'Միքս {i}՝ {n}-ից', 'Над названием микса; {i} — номер, {n} — всего'],
  best: ['лучшее попадание', 'լավագույն համընկնում', 'Пометка у первого микса'],
  gram: ['г', 'գ', 'Сокращение «грамм» в составе микса'],
  strength_label: ['Крепость:', 'Թնդություն՝', 'Подпись перед крепостью микса'],
  strength_1: ['лёгкая', 'թեթև', 'Крепость микса'],
  strength_2: ['средне-лёгкая', 'միջին-թեթև', 'Крепость микса'],
  strength_3: ['средняя', 'միջին', 'Крепость микса'],
  strength_4: ['средне-крепкая', 'միջին-թունդ', 'Крепость микса'],
  strength_5: ['крепкая', 'թունդ', 'Крепость микса'],
  bowl_note: ['Граммы указаны на чашу {g} г.', 'Գրամները նշված են {g} գ թասի համար։', 'Под последним миксом; {g} — граммы в чаше'],
  footer: ['🛒 Покажи этот список в магазине — соберём.', '🛒 Ցույց տուր այս ցուցակը խանութում, և մենք կհավաքենք։', 'Под последним миксом, перед ссылкой на сайт'],
  btn_more: ['🔄 Ещё варианты', '🔄 Այլ տարբերակներ', 'Кнопка под миксами'],
  btn_new: ['✏️ Новый запрос', '✏️ Նոր հարցում', 'Кнопка под миксами'],
  not_relevant: ['Я подбираю кальянные миксы. Напиши, какие вкусы и табаки тебе нравятся и как крепко куришь.',
    'Ես կալյանի միքսեր եմ ընտրում։ Գրիր, թե որ համերն ու ծխախոտներն են քեզ դուր գալիս և որքան թունդ ես ծխում։', 'Если написали не про кальян'],
  not_text: ['Напиши текстом, что любишь курить, — подберу миксы.', 'Տեքստով գրիր, թե ինչ ես սիրում ծխել, և ես միքսեր կընտրեմ։', 'Если прислали фото, голосовое и т.п.'],
  too_few: ['Под такой запрос у нас почти ничего нет. Попробуй описать пошире или убрать ограничения.',
    'Այս հարցման համար մեզ մոտ գրեթե ոչինչ չկա։ Փորձիր ավելի լայն նկարագրել կամ հանել սահմանափակումները։', 'Если подходящих табаков почти нет'],
  failed: ['Не получилось собрать миксы. Нажми «Ещё варианты» или перефразируй запрос.',
    'Չստացվեց միքսեր կազմել։ Սեղմիր «Այլ տարբերակներ» կամ վերաձևակերպիր հարցումը։', 'Если ИИ не справился'],
  restart: ['Давай заново. Напиши, чего хочется сейчас.', 'Եկ նորից սկսենք։ Գրիր, թե հիմա ինչ ես ուզում։', 'Кнопка «Новый запрос» и /new'],
  expired: ['Запрос уже устарел. Напиши заново, что хочется покурить.', 'Հարցումն արդեն հնացել է։ Նորից գրիր, թե ինչ ես ուզում ծխել։', 'Нажали старую кнопку'],
  tell_first: ['Сначала расскажи, что любишь.', 'Նախ պատմիր, թե ինչ ես սիրում։', 'Нажали «Ещё варианты» до запроса'],
  no_catalog: ['Справочник табаков ещё не загружен. Загляни чуть позже.', 'Ծխախոտների տեղեկատուն դեռ բեռնված չէ։ Մի փոքր ուշ նայիր։', 'Если база вкусов пустая'],
  error: ['Что-то пошло не так. Попробуй ещё раз через минуту.', 'Ինչ-որ բան սխալ գնաց։ Փորձիր նորից մեկ րոպեից։', 'Любая ошибка'],
  description: ['Не знаешь, что покурить?\nПодберу микс под твой вкус 💨', 'Չգիտե՞ս՝ ինչ ծխել։\nԿընտրեմ միքս քո ճաշակով 💨',
    'Описание бота на пустом экране до «Начать» (до 512 знаков, без форматирования)'],
  about: ['Подбираю кальянные миксы под твой вкус из табаков VektorSIGMA 💨 18+', 'Ընտրում եմ կալյանի միքսեր քո ճաշակով՝ VektorSIGMA-ի ծխախոտներից 💨 18+',
    '«О боте» в профиле (до 120 знаков, без форматирования)'],
  cmd_start: ['Подобрать микс', 'Ընտրել միքս', 'Меню команд: /start'],
  cmd_new: ['Новый запрос', 'Նոր հարցում', 'Меню команд: /new'],
  cmd_language: ['Сменить язык / Փոխել լեզուն', 'Փոխել լեզուն / Сменить язык', 'Меню команд: /language'],
};

// Параметры: ключ → значение по умолчанию, описание, проверка.
export const DEFAULT_SETTINGS = [
  { key: 'bowl_grams', def: '20', type: 'int', min: 5, max: 60, desc: 'Сколько грамм в чаше. От этого считаются граммы каждого табака в миксе.' },
  { key: 'max_tobaccos', def: '4', type: 'int', min: 2, max: 6, desc: 'Максимум табаков в одном миксе (минимум всегда 2).' },
  { key: 'strongish_max', def: '30', type: 'int', min: 5, max: 100, desc: 'Если клиент хочет лёгкое или среднее: табаки «средне-крепкая» — не больше этой доли микса, %.' },
  { key: 'strong_words', def: 'hard, strong, ligero, zombie, зомби, крепк, хард', type: 'list',
    desc: 'Слова в названии линейки или вкуса, по которым табак считается крепким. Такие табаки предлагаем, только если клиент сам попросил крепко.' },
  { key: 'helper_groups', def: 'Освежающий, Цитрусовый, Ягодный', type: 'list',
    desc: 'Группы вкусов, которые бот всегда подмешивает ИИ «для баланса» (кислинка, свежесть). Названия групп — как на htreviews.' },
  { key: 'candidates', def: '45', type: 'int', min: 10, max: 80, desc: 'Сколько самых подходящих табаков бот даёт ИИ на выбор. Больше — богаче выбор, но ИИ дольше думает и тратит больше лимита.' },
  { key: 'helpers', def: '12', type: 'int', min: 0, max: 30, desc: 'Сколько табаков «для баланса» добавлять к ним.' },
  { key: 'images', def: 'да', type: 'yesno', desc: 'Рисовать картинку к миксам: да / нет. Картинка — около трети расхода бесплатного лимита ИИ.' },
  { key: 'image_logo', def: 'да', type: 'yesno', desc: 'Надпись SIGMA MIX на картинке: да / нет.' },
  { key: 'shop_url', def: 'https://vektorsigma.am', type: 'text', desc: 'Ссылка на магазин под миксами. Пусто — без ссылки.' },
];

// Бренды: код на htreviews.org/tobaccos/<код>, название, включён, как ещё пишут клиенты.
export const DEFAULT_BRANDS = [
  { code: 'deus', name: 'Deus', on: true, aliases: 'деус, деуc, deus tobacco' },
  { code: 'khuligan', name: 'Хулиган', on: true, aliases: 'хулик, хулиган поп, hooligan, huligan' },
  { code: 'spectrum', name: 'Spectrum', on: true, aliases: 'спектр, спектрум, спектрим' },
  { code: 'kraken', name: 'Kraken', on: true, aliases: 'кракен, крякен' },
  { code: 'satyr', name: 'Satyr', on: true, aliases: 'сатир, сатyр, сатирь' },
  { code: 'original-virginia', name: 'Original Virginia', on: true, aliases: 'ориджинал, оригинал вирджиния, вирджиния, OV, ОВ' },
  { code: 'morpheus', name: 'Morpheus', on: true, aliases: 'морфеус, морфей' },
];

// Поправки крепости: бренд или бренд/линейка (как в адресе htreviews) → крепость 1–5 «не ниже».
export const DEFAULT_STRENGTH = [
  { key: 'kraken', s: 4, note: 'Kraken на деле крепче, чем пишет htreviews (фидбек команды)' },
];

// Акцентные вкусы: забивают остальные, поэтому в миксе только акцентом — не больше max %, если клиент сам их не просил.
export const DEFAULT_ACCENTS = ['Гуава', 'Кардамон', 'Корица', 'Гвоздика', 'Анис', 'Бадьян', 'Кофе', 'Роза', 'Лаванда', 'Хвоя', 'Мята', 'Холодок',
  'Перец', 'Имбирь', 'Чай', 'Табак', 'Сигара', 'Полынь', 'Эвкалипт', 'Жвачка', 'Абсент', 'Базилик', 'Тархун']
  .map((tag) => ({ tag, max: 20, note: '' }));

// Правила сборки миксов — смысловая часть задания для ИИ. {max_tobaccos}, {strongish_max} подставляются из настроек.
export const DEFAULT_RULES = [
  'Первый микс — максимально точное попадание в запрос. Второй и третий — альтернативы с другим характером.',
  'В миксе от 2 до {max_tobaccos} табаков, доли кратны 5, в сумме ровно 100.',
  'Каждый табак — только в ОДНОМ из трёх миксов, не повторяй.',
  'БАЛАНС: микс не должен быть однобоким. Если основа сладкая (десерт, сливки, шоколад, выпечка, орехи, карамель), обязательно добавь контрастную ноту 15–25%: кислая ягода, цитрус, фрукт с кислинкой или свежесть. Три десертных вкуса в одном миксе — нельзя, если клиент прямо не просил «чистый десерт».',
  'Табаки с пометкой «ТОЛЬКО АКЦЕНТ» сильно забивают остальные — давай им не больше указанного процента.',
  'Учитывай желаемую крепость. Если клиент хочет лёгкое или среднее, табаки с крепостью «средне-крепкая» — не больше {strongish_max}% в миксе.',
  'Не бери вкусы, которых клиент просил избегать.',
].map((text) => ({ on: true, text }));

// Стиль названий и описаний миксов.
export const DEFAULT_STYLE = [
  { key: 'title_rule', text: 'короткое аппетитное название микса, 2–3 слова, как десерт или коктейль: «Аперольный закат», «Игристые тропики», «Черничный чизкейк», «Апельсиновый брауни».' },
  { key: 'text_rule', text: '1–2 предложения, до 30 слов. У каждого вкуса — сочный эпитет (спелый, тягучий, ледяной, бархатный, хрустящий), скажи, чем вкусы дополняют друг друга и какое ощущение в итоге. Чувственно и аппетитно, без воды вроде «гармоничный опыт», «погрузись в мир». Без обещаний про здоровье.' },
  { key: 'example', text: 'Яркий гранатовый апероль, сочный апельсин и нежный белый персик создают летний коктейльный вкус с мягкой горчинкой.' },
  { key: 'example', text: 'Насыщенная ежевика с винной ноткой сочетается со сливочным черничным йогуртом, а медовый персик делает вкус мягким и округлым.' },
  { key: 'example', text: 'Лёгкое игристое вино, сочный манго-ананас и яркая цитрусовая кислинка юдзу создают освежающий тропический вкус.' },
  { key: 'extra', text: 'Описание должно честно соответствовать вкусам: не называй микс «освежающим», если в нём нет свежести или цитруса.' },
  { key: 'extra', text: 'Следи за грамматикой и родом слов: «бархатная карамель», «тягучий шоколад».' },
];

// Картинка — части задания для модели рисования (по-английски: так она понимает лучше). {count} — сколько миксов.
export const DEFAULT_IMAGE = [
  { key: 'background', text: 'Square premium advertising poster for flavor mixes, top-down view, light off-white studio background with subtle minimal light-grey geometric decorations: thin outline circles, small solid triangles, plus signs, dashed lines and diagonal hatching.',
    desc: 'Фон и общий стиль' },
  { key: 'logo', text: 'At the top center, a modern logo: the word "SIGMA" in thin black sans-serif capitals, directly below it the word "MIX" in heavy bold black sans-serif capitals. The SIGMA MIX logo is the ONLY text in the image: no other words, no labels, no numbers, no percentages anywhere.',
    desc: 'Логотип (если в настройках image_logo = да)' },
  { key: 'no_text', text: 'No text, no letters, no logos anywhere.', desc: 'Вместо логотипа, если image_logo = нет' },
  { key: 'layout', text: 'Below the logo, {count} separate round swirls of the same size arranged in one horizontal row from left to right, evenly spaced.',
    desc: 'Раскладка кругов; {count} — сколько миксов' },
  { key: 'swirl', text: 'Each swirl is made of thick glossy liquid sauces flowing into each other like a yin-yang, with clear borders between colors, realistic shiny reflections and one small drip at the bottom edge',
    desc: 'Как выглядит один круг. Дальше бот сам допишет цвета соусов каждого микса' },
  { key: 'garnish', text: 'Fresh ingredients scattered around the edges of the frame, partially cropped:', desc: 'Ингредиенты по краям. Дальше бот допишет ингредиенты миксов' },
  { key: 'quality', text: 'High-end commercial food photography, soft natural shadows, vibrant saturated colors, crisp focus, clean balanced composition, lots of white space.',
    desc: 'Качество и подача' },
  { key: 'bans', text: 'No people, no hands, no hookah, no cigarettes, no smoke.', desc: 'Что запрещено рисовать' },
];

export const DEFAULTS = {
  settings: Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.key, parseSetting(s, s.def).value])),
  brands: DEFAULT_BRANDS,
  strength: DEFAULT_STRENGTH,
  accents: DEFAULT_ACCENTS,
  rules: DEFAULT_RULES.map((r) => r.text),
  style: {
    title_rule: DEFAULT_STYLE.find((x) => x.key === 'title_rule').text,
    text_rule: DEFAULT_STYLE.find((x) => x.key === 'text_rule').text,
    examples: DEFAULT_STYLE.filter((x) => x.key === 'example').map((x) => x.text),
    extra: DEFAULT_STYLE.filter((x) => x.key === 'extra').map((x) => x.text),
  },
  image: Object.fromEntries(DEFAULT_IMAGE.map((x) => [x.key, x.text])),
  texts: Object.fromEntries(Object.entries(DEFAULT_TEXTS).map(([k, v]) => [k, { ru: v[0], hy: v[1] }])),
  admins: [],
};

/* ═════════════════════════ Google Таблица ═════════════════════════
 * Вкладки и их колонки. Названия вкладок и первая строка (заголовки) — не менять:
 * по ним бот понимает, что читает. Строки ниже заголовка — можно править, добавлять, удалять.
 */
export const SHEET_TABS = [
  { name: 'Настройки', head: ['Параметр', 'Значение', 'Что это'] },
  { name: 'Бренды', head: ['Код на htreviews', 'Название', 'Включён', 'Как ещё пишут клиенты'] },
  { name: 'Крепость', head: ['Бренд или линейка', 'Крепость 1–5', 'Комментарий'] },
  { name: 'Акценты', head: ['Вкус', 'Макс. доля %', 'Комментарий'] },
  { name: 'Правила миксов', head: ['Включено', 'Правило'] },
  { name: 'Стиль описаний', head: ['Что', 'Текст'] },
  { name: 'Картинка', head: ['Часть', 'Текст (по-английски)', 'Что это'] },
  { name: 'Тексты бота', head: ['Ключ', 'Русский', 'Армянский', 'Где показывается'] },
  { name: 'Админы', head: ['Имя', 'Telegram ID'] },
];
/** Содержимое таблицы по умолчанию (вкладка → строки с заголовком). Из него заполнена Google Таблица. */
export function sheetRows() {
  const H = Object.fromEntries(SHEET_TABS.map((t) => [t.name, t.head]));
  const yn = (b) => (b ? 'да' : 'нет');
  return {
    'Настройки': [H['Настройки'], ...DEFAULT_SETTINGS.map((s) => [s.key, s.def, s.desc])],
    'Бренды': [H['Бренды'], ...DEFAULT_BRANDS.map((b) => [b.code, b.name, yn(b.on), b.aliases])],
    'Крепость': [H['Крепость'], ...DEFAULT_STRENGTH.map((x) => [x.key, String(x.s), x.note])],
    'Акценты': [H['Акценты'], ...DEFAULT_ACCENTS.map((x) => [x.tag, String(x.max), x.note])],
    'Правила миксов': [H['Правила миксов'], ...DEFAULT_RULES.map((r) => [yn(r.on), r.text])],
    'Стиль описаний': [H['Стиль описаний'], ...DEFAULT_STYLE.map((x) => [x.key, x.text])],
    'Картинка': [H['Картинка'], ...DEFAULT_IMAGE.map((x) => [x.key, x.text, x.desc])],
    'Тексты бота': [H['Тексты бота'], ...Object.entries(DEFAULT_TEXTS).map(([k, v]) => [k, v[0], v[1], v[2]])],
    'Админы': [H['Админы']],
  };
}

const SECTION_NAMES = {
  settings: 'настройки', brands: 'бренды', strength: 'крепость', accents: 'акценты', rules: 'правила миксов',
  style: 'стиль описаний', image: 'картинка', texts: 'тексты бота', admins: 'админы',
};

/** CSV одной вкладки. gviz отдаёт вкладку по названию; headers=1 — первая строка всегда заголовок. */
function sheetUrl(id, tab) {
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
}

/** Разбор CSV с кавычками, запятыми и переносами строк внутри ячеек. */
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}


function parseSetting(def, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (def.type === 'int') {
    const n = Number(v.replace(',', '.').replace(/[^\d.]/g, ''));
    if (!v || !Number.isFinite(n) || n < def.min || n > def.max) return { error: `должно быть число от ${def.min} до ${def.max}, а стоит «${v}»` };
    return { value: Math.round(n) };
  }
  if (def.type === 'yesno') {
    if (YES.includes(v.toLowerCase())) return { value: true };
    if (NO.includes(v.toLowerCase())) return { value: false };
    return { error: `должно быть «да» или «нет», а стоит «${v}»` };
  }
  if (def.type === 'list') return { value: v.split(',').map((x) => x.trim()).filter(Boolean) };
  return { value: v };
}

/**
 * Таблица (вкладка → строки CSV) → конфиг. Ошибки — таблица не применяется;
 * предупреждения — применяется, проблемное место берётся из значений по умолчанию.
 */
export function buildConfig(tabs) {
  const errors = [], warnings = [];
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const body = (name) => {
    const rows = tabs[name];
    const spec = SHEET_TABS.find((t) => t.name === name);
    if (!rows || !rows.length) { errors.push(`Вкладка «${name}» не найдена или пустая`); return null; }
    const head = rows[0].map((h) => h.trim());
    // gviz при неверном названии вкладки молча отдаёт первую — проверяем заголовки.
    if (spec.head.some((h, i) => (head[i] || '').toLowerCase() !== h.toLowerCase())) {
      errors.push(`Вкладка «${name}»: первая строка должна быть «${spec.head.join(' | ')}». Не переименовывайте вкладки и заголовки`);
      return null;
    }
    return rows.slice(1).map((r, i) => ({ n: i + 2, c: r.map((x) => String(x == null ? '' : x).trim()) }))
      .filter((r) => r.c.some((x) => x));
  };

  // Настройки
  const st = body('Настройки');
  if (st) {
    for (const r of st) {
      const def = DEFAULT_SETTINGS.find((d) => d.key === r.c[0]);
      if (!def) { warnings.push(`Настройки, строка ${r.n}: неизвестный параметр «${r.c[0]}» — пропущен`); continue; }
      const p = parseSetting(def, r.c[1]);
      if (p.error) errors.push(`Настройки, строка ${r.n} (${def.key}): ${p.error}`);
      else cfg.settings[def.key] = p.value;
    }
  }

  // Бренды
  const br = body('Бренды');
  if (br) {
    const list = [];
    for (const r of br) {
      const [code, name, on, aliases] = r.c;
      if (!/^[a-z0-9-]+$/.test(code || '')) { errors.push(`Бренды, строка ${r.n}: код «${code}» — только латиница, цифры и дефис, как в адресе htreviews.org/tobaccos/<код>`); continue; }
      const isOn = on === '' ? true : YES.includes(on.toLowerCase()) ? true : NO.includes(on.toLowerCase()) ? false : null;
      if (isOn === null) { errors.push(`Бренды, строка ${r.n}: «Включён» должно быть «да» или «нет»`); continue; }
      list.push({ code, name: name || code, on: isOn, aliases: aliases || '' });
    }
    if (!list.some((b) => b.on)) errors.push('Бренды: должен быть включён хотя бы один бренд');
    if (list.filter((b) => b.on).length > 30) errors.push('Бренды: включено больше 30 — еженедельное обновление не успеет скачать все');
    cfg.brands = list;
  }

  // Крепость
  const sr = body('Крепость');
  if (sr) {
    cfg.strength = [];
    for (const r of sr) {
      const [key, s, note] = r.c;
      const n = Number(s);
      if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(key || '')) { errors.push(`Крепость, строка ${r.n}: «${key}» — нужен код бренда или бренд/линейка латиницей, как в адресе htreviews (например kraken или khuligan/hard)`); continue; }
      if (!(n >= 1 && n <= 5 && Number.isInteger(n))) { errors.push(`Крепость, строка ${r.n}: крепость — целое число от 1 до 5`); continue; }
      cfg.strength.push({ key, s: n, note: note || '' });
    }
  }

  // Акценты
  const ac = body('Акценты');
  if (ac) {
    cfg.accents = [];
    for (const r of ac) {
      const [tag, max, note] = r.c;
      const n = Number(String(max).replace('%', '').replace(',', '.'));
      if (!tag) continue;
      if (!(n >= 5 && n <= 100)) { errors.push(`Акценты, строка ${r.n} (${tag}): доля — число от 5 до 100`); continue; }
      cfg.accents.push({ tag, max: Math.round(n), note: note || '' });
    }
  }

  // Правила миксов
  const ru = body('Правила миксов');
  if (ru) {
    cfg.rules = ru.filter((r) => r.c[1] && !NO.includes((r.c[0] || 'да').toLowerCase())).map((r) => r.c[1]);
    if (!cfg.rules.length) errors.push('Правила миксов: должно быть включено хотя бы одно правило');
  }

  // Стиль описаний
  const sy = body('Стиль описаний');
  if (sy) {
    const get = (k) => sy.filter((r) => r.c[0] === k && r.c[1]).map((r) => r.c[1]);
    cfg.style = {
      title_rule: get('title_rule')[0] || '', text_rule: get('text_rule')[0] || '',
      examples: get('example').map((x) => x.replace(/^[«"]+|[»"]+$/g, '')), extra: get('extra'),
    };
    if (!cfg.style.title_rule) errors.push('Стиль описаний: нет строки title_rule (как называть миксы)');
    if (!cfg.style.text_rule) errors.push('Стиль описаний: нет строки text_rule (как писать описание)');
    for (const r of sy) if (!['title_rule', 'text_rule', 'example', 'extra'].includes(r.c[0])) warnings.push(`Стиль описаний, строка ${r.n}: неизвестное «${r.c[0]}» — пропущено`);
  }

  // Картинка
  const im = body('Картинка');
  if (im) {
    for (const r of im) {
      if (!(r.c[0] in DEFAULTS.image)) { warnings.push(`Картинка, строка ${r.n}: неизвестная часть «${r.c[0]}» — пропущена`); continue; }
      if (!r.c[1]) { warnings.push(`Картинка, строка ${r.n} (${r.c[0]}): пусто — беру текст по умолчанию`); continue; }
      cfg.image[r.c[0]] = r.c[1];
    }
  }

  // Тексты бота
  const tx = body('Тексты бота');
  if (tx) {
    for (const r of tx) {
      const [key, ruT, hyT] = r.c;
      if (!(key in DEFAULT_TEXTS)) { warnings.push(`Тексты бота, строка ${r.n}: неизвестный ключ «${key}» — пропущен`); continue; }
      for (const [lang, val] of [['ru', ruT], ['hy', hyT]]) {
        if (!val) { warnings.push(`Тексты бота, строка ${r.n} (${key}, ${lang === 'ru' ? 'русский' : 'армянский'}): пусто — беру текст по умолчанию`); continue; }
        const bad = checkHtml(val);
        if (bad) { warnings.push(`Тексты бота, строка ${r.n} (${key}): ${bad} — беру текст по умолчанию`); continue; }
        if (key === 'description' && val.length > 512) { warnings.push(`Тексты бота (description): длиннее 512 знаков — беру по умолчанию`); continue; }
        if (key === 'about' && val.length > 120) { warnings.push(`Тексты бота (about): длиннее 120 знаков — беру по умолчанию`); continue; }
        cfg.texts[key][lang] = val;
      }
    }
  }

  // Админы
  const ad = body('Админы');
  if (ad) {
    cfg.admins = [];
    for (const r of ad) {
      const id = (r.c[1] || '').replace(/\s/g, '');
      if (!id) continue;
      if (!/^\d{4,15}$/.test(id)) { warnings.push(`Админы, строка ${r.n}: «${r.c[1]}» — не похоже на Telegram ID (только цифры). Узнать свой: команда /id у бота`); continue; }
      cfg.admins.push(id);
    }
  }
  return { cfg, errors, warnings };
}

/** Разрешены только <b> <i> <u> <s>, и каждый открытый тег должен быть закрыт. */
export function checkHtml(s) {
  const tags = String(s).match(/<\/?([a-z]+)[^>]*>/gi) || [];
  const stack = [];
  for (const t of tags) {
    const m = t.match(/^<(\/?)([a-z]+)/i);
    const name = m[2].toLowerCase();
    if (!['b', 'i', 'u', 's'].includes(name)) return `тег <${name}> не поддерживается (можно <b>, <i>, <u>, <s>)`;
    if (m[1]) { if (stack.pop() !== name) return `тег </${name}> закрыт не по порядку`; } else stack.push(name);
  }
  return stack.length ? `не закрыт тег <${stack[stack.length - 1]}>` : '';
}

let cfgCache = { at: 0, cfg: null };

/** Текущий конфиг: память (60 с) → копия в KV → значения по умолчанию. */
export async function loadConfig(env) {
  if (cfgCache.cfg && Date.now() - cfgCache.at < 60 * 1000) return cfgCache.cfg;
  const stored = await env.KV.get('config', 'json').catch(() => null);
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  const c = stored && stored.cfg ? stored.cfg : {};
  // Глубоко сливаем с умолчаниями: если в коде появился новый параметр или текст, а в копии его ещё нет.
  const cfg = { ...d, ...c, settings: { ...d.settings, ...c.settings }, image: { ...d.image, ...c.image }, texts: { ...d.texts, ...c.texts }, _at: stored ? stored.at : null };
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

/** Читает таблицу, проверяет и, если что-то изменилось, сохраняет копию. Ничего не ломает при ошибке. */
export async function syncConfig(env, fetcher = fetch) {
  if (!env.CONFIG_SHEET_ID) return { ok: false, errors: ['в wrangler.toml не указан CONFIG_SHEET_ID'], warnings: [] };
  const tabs = {};
  try {
    await Promise.all(SHEET_TABS.map(async (t) => {
      const r = await fetchRetry(fetcher, sheetUrl(env.CONFIG_SHEET_ID, t.name), { headers: { accept: 'text/csv' } }, [1500, 4000]);
      const text = await r.text();
      if (!r.ok || /^\s*</.test(text)) throw new Error(r.ok ? 'нет доступа' : 'код ' + r.status);
      tabs[t.name] = parseCSV(text);
    }));
  } catch (e) {
    return { ok: false, warnings: [], errors: [`не могу прочитать таблицу (${e.message}). Проверьте доступ: «Все, у кого есть ссылка» — «Читатель»`] };
  }
  const { cfg, errors, warnings } = buildConfig(tabs);
  if (errors.length) return { ok: false, errors, warnings };

  const prev = await env.KV.get('config', 'json').catch(() => null);
  const old = prev && prev.cfg ? prev.cfg : DEFAULTS;
  const sections = Object.keys(SECTION_NAMES).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(cfg[k]));
  const newBrands = cfg.brands.filter((b) => b.on && !(old.brands || []).some((o) => o.on && o.code === b.code)).map((b) => b.code);
  if (!prev || sections.length) {
    await env.KV.put('config', JSON.stringify({ at: new Date().toISOString(), cfg }));
    cfgCache = { at: 0, cfg: null };
    catCache = { at: 0, sig: '', items: [] };
    const tChanged = ['description', 'about', 'cmd_start', 'cmd_new', 'cmd_language']
      .some((k) => JSON.stringify((old.texts || {})[k]) !== JSON.stringify(cfg.texts[k]));
    if (tChanged || !prev) await applyProfile(env, cfg);
  }
  return { ok: true, changed: !prev || sections.length > 0, sections: prev ? sections : Object.keys(SECTION_NAMES), newBrands, warnings, cfg };
}

/** Описание, «О боте» и меню команд — в Telegram, на двух языках. */
async function applyProfile(env, cfg) {
  const t = (k, l) => cfg.texts[k][l];
  for (const [lang, code] of [['ru', undefined], ['hy', 'hy']]) {
    const lc = code ? { language_code: code } : {};
    await tg(env, 'setMyCommands', { ...lc, commands: [
      { command: 'start', description: t('cmd_start', lang) },
      { command: 'new', description: t('cmd_new', lang) },
      { command: 'language', description: t('cmd_language', lang) },
    ] });
    await tg(env, 'setMyDescription', { ...lc, description: t('description', lang) });
    await tg(env, 'setMyShortDescription', { ...lc, short_description: t('about', lang) });
  }
}

/** Отчёт о синхронизации — для админов в Telegram. */
export function syncReport(r) {
  if (!r.ok) return '❌ Изменения из таблицы НЕ применены — бот работает на прежних настройках.\n\n' + r.errors.map((e) => '• ' + e).join('\n') +
    (r.warnings && r.warnings.length ? '\n\n⚠️ Ещё:\n' + r.warnings.map((e) => '• ' + e).join('\n') : '');
  let s = r.changed ? '✅ Применено из таблицы. Изменилось: ' + r.sections.map((k) => SECTION_NAMES[k]).join(', ') + '.' : '✅ Таблица прочитана, изменений нет.';
  if (r.newBrands && r.newBrands.length) s += '\n\n🆕 Новые бренды: ' + r.newBrands.join(', ') + '. Скачаю их вкусы с htreviews в течение ~15 минут на бренд и напишу.';
  if (r.warnings && r.warnings.length) s += '\n\n⚠️ Предупреждения:\n' + r.warnings.map((e) => '• ' + e).join('\n');
  return s;
}

/** Запоминаем последний статус синхронизации, чтобы писать админам только когда он поменялся. */
async function saveStatus(env, r) {
  const status = r.ok ? 'ok' : r.errors.join('\n');
  const prev = (await env.KV.get('config:status')) || 'ok';
  if (status !== prev) await env.KV.put('config:status', status);
  return status !== prev;
}

/** Тексты на языке клиента. */
export function tx(cfg, lang = 'ru') {
  const g = (k) => (cfg.texts[k] && cfg.texts[k][lang]) || DEFAULT_TEXTS[k][lang === 'hy' ? 1 : 0];
  return {
    lang,
    hello: g('hello'), chooseLang: g('choose_lang'), langSet: g('lang_set'), askStrength: g('ask_strength'),
    strength: [g('btn_light'), g('btn_medium'), g('btn_strong'), g('btn_any')],
    notRelevant: g('not_relevant'), notText: g('not_text'), error: g('error'), restart: g('restart'), expired: g('expired'),
    tellFirst: g('tell_first'), noCatalog: g('no_catalog'), picking: g('picking'), pickingMore: g('picking_more'),
    tooFew: g('too_few'), failed: g('failed'), more: g('btn_more'), newReq: g('btn_new'),
    mixOf: (i, n) => fill(g('mix_of'), { i, n }), best: g('best'), strengthLabel: g('strength_label'),
    strengthNames: ['', g('strength_1'), g('strength_2'), g('strength_3'), g('strength_4'), g('strength_5')],
    gram: g('gram'), cover: (n) => fill(g('cover'), { n }), bowlNote: (gr) => fill(g('bowl_note'), { g: gr }), footer: g('footer'),
    llmLang: lang === 'hy' ? 'армянском (восточноармянский литературный, армянским алфавитом)' : 'русском',
  };
}
const txt = async (env, lang) => tx(await loadConfig(env), lang);
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

const LANG_SEPARATOR = '\n\n————————————\n\n';
const SOURCE = 'https://htreviews.org';
const PAGE = 20; // сайт сам грузит по 20, большие порции отдают неполный список
const STRENGTH = { 'лёгкая': 1, 'легкая': 1, 'средне-лёгкая': 2, 'средне-легкая': 2, 'средняя': 3, 'средне-крепкая': 4, 'крепкая': 5 };
const STRENGTH_NAME = ['', 'лёгкая', 'средне-лёгкая', 'средняя', 'средне-крепкая', 'крепкая'];
const CRON_CONFIG = '*/15 * * * *';

/* ═════════════════════════ Входные точки ═════════════════════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhook' && request.method === 'POST') return await onWebhook(request, env, ctx);
      if (url.pathname === '/setup') return await onSetup(url, env);
      if (url.pathname === '/refresh') return await onRefresh(url, env);
      return new Response('ok');
    } catch (e) {
      console.log('fatal', e && e.stack || e);
      return new Response('ok'); // Telegram не должен повторять запрос из-за нашей ошибки
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === CRON_CONFIG) return ctx.waitUntil(cronConfig(env));
    // Понедельник 03:00–07:50 UTC, каждые 10 минут — по одному бренду (лимит 50 внешних запросов на запуск).
    const brands = (await loadConfig(env)).brands.filter((b) => b.on).map((b) => b.code);
    const t = new Date(event.scheduledTime);
    const i = (t.getUTCHours() - 3) * 6 + Math.floor(t.getUTCMinutes() / 10);
    if (brands[i]) ctx.waitUntil(crawlBrand(env, brands[i]).catch((e) => console.log('crawl', brands[i], e.message)));
  },
};

/** Раз в 15 минут: таблица → копия; новый бренд без вкусов → скачать (по одному за раз). */
async function cronConfig(env) {
  const r = await syncConfig(env);
  const statusChanged = await saveStatus(env, r);
  if (!r.ok && statusChanged) await notifyAdmins(env, '⚠️ Автопроверка таблицы.\n' + syncReport(r));
  if (r.ok && (r.changed || statusChanged)) await notifyAdmins(env, '🔄 Автопроверка таблицы.\n' + syncReport(r));
  await crawlMissingBrand(env);
}

async function crawlMissingBrand(env) {
  const cfg = await loadConfig(env);
  for (const b of cfg.brands.filter((x) => x.on)) {
    if (await env.KV.get('cat:' + b.code)) continue;
    if (await env.KV.get('crawlfail:' + b.code)) continue; // недавно не получилось — не долбим сайт
    try {
      const res = await crawlBrand(env, b.code);
      await notifyAdmins(env, `✅ Бренд ${b.name}: скачано ${res.active} вкусов, уже участвует в подборе.`);
    } catch (e) {
      await env.KV.put('crawlfail:' + b.code, e.message, { expirationTtl: 6 * 3600 });
      await notifyAdmins(env, `❌ Бренд ${b.name} (${b.code}): не получилось скачать вкусы — ${e.message}. Проверьте код на htreviews.org/tobaccos/${b.code}. Повторю через 6 часов.`);
    }
    return; // по одному бренду за запуск
  }
}

async function adminIds(env) {
  const cfg = await loadConfig(env);
  return [...new Set([...(cfg.admins || []), ...String(env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)])];
}
async function notifyAdmins(env, text) {
  for (const id of await adminIds(env)) await tg(env, 'sendMessage', { chat_id: id, text, disable_web_page_preview: true });
}

/* ═════════════════════════ Telegram ═════════════════════════ */

async function onWebhook(request, env, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json();

  // Telegram повторяет доставку, если мы долго думаем, — не обрабатываем дважды.
  const seenKey = 'upd:' + update.update_id;
  if (await env.KV.get(seenKey)) return new Response('ok');
  await env.KV.put(seenKey, '1', { expirationTtl: 600 });

  try {
    if (update.callback_query) await onCallback(env, update.callback_query);
    else if (update.message && update.message.text) await onText(env, update.message, ctx);
    else if (update.message) await send(env, update.message.chat.id, (await txt(env, await getLang(env, update.message.chat.id))).notText);
  } catch (e) {
    console.log('handler', e && e.stack || e);
    const chat = (update.message || (update.callback_query && update.callback_query.message) || {}).chat;
    if (chat) await send(env, chat.id, (await txt(env, await getLang(env, chat.id))).error);
  }
  return new Response('ok');
}

/* ───────────────────────── Язык ───────────────────────── */

/** Язык сообщения по алфавиту: армянские буквы → hy, кириллица → ru, иначе не понять (латиница, эмодзи). */
export function detectLang(text) {
  const hy = (String(text).match(/[Ա-֏]/g) || []).length;
  const ru = (String(text).match(/[а-яё]/gi) || []).length;
  if (hy >= 2 && hy > ru) return 'hy';
  if (ru >= 2 && ru >= hy) return 'ru';
  return null;
}
async function getLang(env, chat) {
  const l = await env.KV.get('lang:' + chat);
  return l === 'hy' ? 'hy' : 'ru';
}
async function setLang(env, chat, lang) {
  await env.KV.put('lang:' + chat, lang); // без срока: язык помним всегда
}
function langKeyboard() {
  return { inline_keyboard: [[
    { text: '🇷🇺 Русский', callback_data: 'lang:ru' },
    { text: '🇦🇲 Հայերեն', callback_data: 'lang:hy' },
  ]] };
}

/* ───────────────────────── Диалог ───────────────────────── */

async function onText(env, msg, ctx) {
  const chat = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await env.KV.delete('s:' + chat);
    const ru = await txt(env, 'ru'), hy = await txt(env, 'hy');
    return send(env, chat, ru.hello + LANG_SEPARATOR + hy.hello + '\n\n' + ru.chooseLang + ' ' + hy.chooseLang, langKeyboard());
  }
  if (cmd === '/language' || cmd === '/lang') {
    const ru = await txt(env, 'ru'), hy = await txt(env, 'hy');
    return send(env, chat, ru.chooseLang + '\n' + hy.chooseLang, langKeyboard());
  }
  if (cmd === '/new') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, (await txt(env, await getLang(env, chat))).restart);
  }
  // Служебные команды: /id — всем (чтобы узнать свой ID для вкладки «Админы»), остальные — только админам.
  if (cmd === '/id') return send(env, chat, `Твой Telegram ID: <code>${msg.from && msg.from.id}</code>`);
  if (cmd === '/reload' || cmd === '/config') {
    if (!(await adminIds(env)).includes(String(msg.from && msg.from.id))) return send(env, chat, 'Эта команда только для админов бота.');
    if (cmd === '/config') return send(env, chat, configSummary(await loadConfig(env), env));
    await send(env, chat, '⏳ Читаю таблицу…');
    const r = await syncConfig(env);
    await saveStatus(env, r);
    await send(env, chat, esc(syncReport(r)));
    if (r.ok && r.newBrands.length && ctx) ctx.waitUntil(crawlMissingBrand(env));
    return;
  }

  // Пишет на другом языке — переключаемся на него.
  let lang = await getLang(env, chat);
  const detected = detectLang(text);
  if (detected && detected !== lang) { lang = detected; await setLang(env, chat, lang); }
  const t = await txt(env, lang);

  const session = await getSession(env, chat);
  let request = text;
  let force = false;
  if (session && session.stage === 'ask_strength') {
    request = session.text + '\n' + text; // ответ на уточняющий вопрос
    force = true;
  }
  await action(env, chat, 'typing');
  const prefs = await extractPrefs(env, request);
  if (!prefs.relevant) return send(env, chat, t.notRelevant);
  if (prefs.strength === 'unknown' && !force) {
    await putSession(env, chat, { stage: 'ask_strength', text: request, prefs });
    return send(env, chat, t.askStrength, strengthKeyboard(t));
  }
  if (prefs.strength === 'unknown') prefs.strength = 'any';
  await makeMixes(env, chat, { text: request, prefs, used: [], titles: [] }, false, lang);
}

/** /config — коротко, что сейчас действует. */
export function configSummary(cfg, env = {}) {
  const at = cfg._at ? new Date(cfg._at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК' : 'ещё не загружалась — работают значения из кода';
  const s = cfg.settings;
  const on = cfg.brands.filter((b) => b.on);
  return '⚙️ <b>Настройки бота</b>\n' +
    `Таблица: ${env.CONFIG_SHEET_ID ? `<a href="https://docs.google.com/spreadsheets/d/${env.CONFIG_SHEET_ID}/edit">открыть</a>` : 'не подключена'}\n` +
    `Последнее изменение из таблицы: ${at}\n\n` +
    `Бренды (${on.length}): ${esc(on.map((b) => b.name).join(', '))}\n` +
    `Правил миксов: ${cfg.rules.length} · акцентных вкусов: ${cfg.accents.length} · поправок крепости: ${cfg.strength.length}\n` +
    `Чаша: ${s.bowl_grams} г · табаков в миксе: до ${s.max_tobaccos} · средне-крепких при среднем запросе: до ${s.strongish_max}%\n` +
    `Картинки: ${s.images ? 'да' : 'нет'}${s.images ? (s.image_logo ? ', с SIGMA MIX' : ', без текста') : ''}\n` +
    `Админов: ${cfg.admins.length + String(env.ADMIN_IDS || '').split(',').filter((x) => x.trim()).length}\n\n` +
    'Изменения в таблице подтягиваются сами раз в 15 минут, или сразу — командой /reload.';
}

async function onCallback(env, cq) {
  const chat = cq.message.chat.id;
  const data = cq.data || '';
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });

  if (data.startsWith('lang:')) {
    const lang = data.slice(5) === 'hy' ? 'hy' : 'ru';
    await setLang(env, chat, lang);
    return send(env, chat, (await txt(env, lang)).langSet);
  }

  const lang = await getLang(env, chat);
  const t = await txt(env, lang);
  const session = await getSession(env, chat);

  if (data === 'new') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, t.restart);
  }
  if (!session) return send(env, chat, t.expired);

  if (data.startsWith('str:')) {
    session.prefs.strength = data.slice(4);
    return makeMixes(env, chat, { text: session.text, prefs: session.prefs, used: [], titles: [] }, false, lang);
  }
  if (data === 'more') {
    if (!session.prefs || session.stage === 'ask_strength') return send(env, chat, t.tellFirst);
    return makeMixes(env, chat, session, true, lang);
  }
}

function strengthKeyboard(t) {
  const s = t.strength;
  return { inline_keyboard: [[
    { text: s[0], callback_data: 'str:light' },
    { text: s[1], callback_data: 'str:medium' },
    { text: s[2], callback_data: 'str:strong' },
  ], [{ text: s[3], callback_data: 'str:any' }]] };
}

function resultKeyboard(t) {
  return { inline_keyboard: [[
    { text: t.more, callback_data: 'more' },
    { text: t.newReq, callback_data: 'new' },
  ]] };
}

/* ═════════════════════════ Подбор миксов ═════════════════════════ */

async function makeMixes(env, chat, session, more = false, lang = 'ru') {
  const cfg = await loadConfig(env);
  const t = tx(cfg, lang);
  const catalog = await loadCatalog(env);
  if (!catalog.length) return send(env, chat, t.noCatalog);

  await send(env, chat, more ? t.pickingMore : t.picking);
  await action(env, chat, 'typing');

  const candidates = pickCandidates(catalog, session.prefs, session.used || [], more, cfg);
  if (candidates.length < 4) return send(env, chat, t.tooFew, resultKeyboard(t));

  let result = await composeMixes(env, session, candidates, lang, cfg);
  if (!result.length) result = await composeMixes(env, session, candidates, lang, cfg); // одна повторная попытка
  if (!result.length) return send(env, chat, t.failed, resultKeyboard(t));

  session.stage = 'done';
  session.used = [...(session.used || []), ...result.flatMap((m) => m.parts.map((p) => p.item.k))].slice(-80);
  session.titles = [...(session.titles || []), ...result.map((m) => m.title)].slice(-15);
  await putSession(env, chat, session);

  const bowl = cfg.settings.bowl_grams;
  const blocks = result.map((m, i) => renderMix(m, i, t, result.length, bowl));
  const shop = cfg.settings.shop_url;
  blocks[blocks.length - 1] += '\n\n<i>' + t.bowlNote(bowl) + '</i>\n' + t.footer + (shop ? ' ' + shop : '');

  // Сначала одна общая картинка со всеми миксами, потом карточки миксов текстом.
  if (cfg.settings.images) {
    await action(env, chat, 'upload_photo');
    const photo = await coverImage(env, result, cfg);
    if (photo) await sendPhoto(env, chat, photo, t.cover(result.length));
  }
  for (let i = 0; i < blocks.length; i++) {
    await send(env, chat, blocks[i], i === blocks.length - 1 ? resultKeyboard(t) : undefined);
  }
}

/** Общая картинка: две попытки основной моделью, потом запасная. */
async function coverImage(env, mixes, cfg) {
  const prompt = imagePrompt(mixes, cfg.image, cfg.settings.image_logo);
  let photo = await makeImage(env, prompt).catch((e) => (console.log('image', e.message), null));
  if (!photo) photo = await makeImage(env, prompt).catch((e) => (console.log('image retry', e.message), null));
  if (!photo && !(env.IMAGE_MODEL || '').includes('flux-1')) {
    photo = await makeImage({ ...env, IMAGE_MODEL: '@cf/black-forest-labs/flux-1-schnell' }, prompt)
      .catch((e) => (console.log('image fallback', e.message), null));
  }
  return photo;
}

/** Шаг 1. ИИ превращает свободный текст в структуру предпочтений. */
async function extractPrefs(env, text) {
  const cfg = await loadConfig(env);
  const catalog = await loadCatalog(env);
  const brands = [...new Set(catalog.map((x) => x.b))];
  const groups = [...new Set(catalog.flatMap((x) => x.g))];
  const aliases = cfg.brands.filter((b) => b.on && b.aliases).map((b) => `«${b.aliases.split(',').map((x) => x.trim()).filter(Boolean).join('», «')}» → ${b.name}`).join('; ');
  const system =
    'Ты разбираешь запрос клиента кальянного магазина. Верни ТОЛЬКО JSON без пояснений:\n' +
    '{"relevant":true,"like":[],"avoid":[],"groups":[],"flavors":[],"brands":[],"strength":"light|medium|strong|any|unknown"}\n' +
    'Клиент может писать по-русски или по-армянски. Поля like и avoid ВСЕГДА заполняй по-русски, переводя с армянского.\n' +
    '- relevant: false, если сообщение вообще не про кальян, табак или вкусы.\n' +
    '- like: вкусы, которые человек хочет, по одному слову в именительном падеже ("Малина", "Лайм", "Мята").\n' +
    '  Если назвал только настроение ("свежее", "десертное") — подбери 3–6 подходящих вкусов сам.\n' +
    '- avoid: вкусы, которых человек не хочет, в том же виде.\n' +
    '- groups: подходящие направления строго из списка: ' + (groups.join(', ') || 'Фруктовый, Ягодный, Цитрусовый, Освежающий, Десертный') + '.\n' +
    '- flavors: названия конкретных табаков, которые человек упомянул. Если узнаёшь табак — в оригинальном написании ("Creme Brulee", "Epic Mint"), иначе как написал человек.\n' +
    '- brands: бренды, которые человек любит, строго из списка: ' + (brands.join(', ') || '—') + '. ' +
    'Человек может писать с опечатками, сокращениями, кириллицей или латиницей. Как ещё пишут бренды: ' + (aliases || '—') + '. Сопоставь с ближайшим брендом из списка.\n' +
    '- strength: light — курит лёгкое, medium — среднее, strong — крепкое, any — ему всё равно, unknown — не сказал.';
  const out = await llmJson(env, system, text, 400);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 12) : []);
  const strength = ['light', 'medium', 'strong', 'any', 'unknown'].includes(out && out.strength) ? out.strength : 'unknown';
  return {
    relevant: !out || out.relevant !== false, // если ИИ не ответил — не блокируем человека
    like: arr(out && out.like), avoid: arr(out && out.avoid), groups: arr(out && out.groups),
    flavors: arr(out && out.flavors), brands: arr(out && out.brands), strength,
  };
}

/** Шаг 2. Код отбирает из справочника кандидатов под предпочтения. */
export function pickCandidates(catalog, prefs, used = [], more = false, cfg = DEFAULTS) {
  const st = cfg.settings;
  const like = prefs.like.map(stem), avoid = prefs.avoid.map(stem);
  const flavors = prefs.flavors, brands = prefs.brands;
  const usedSet = new Set(used);
  const jitter = more ? 1.5 : 0.5;

  // Крепкое — только если клиент сам попросил. Иначе убираем крепкие табаки и крепкие линейки (Hard, Strong, Ligero…).
  const okStrength = (it) => {
    const s = it.s, strongLine = isStrongLine(it, st.strong_words);
    if (prefs.strength === 'strong') return !s || s >= 3 || strongLine;
    if (strongLine || s >= 5) return false;
    if (prefs.strength === 'light') return !s || s <= 2;
    if (prefs.strength === 'medium') return !s || s >= 2;
    return true; // «без разницы» / не сказал — всё, кроме крепкого
  };

  const scored = [];
  for (const it of catalog) {
    if (!okStrength(it)) continue;
    const tagStems = it.t.map(stem);
    const nameWords = norm(it.n + ' ' + it.a).split(/[^a-zа-я0-9]+/).filter(Boolean).map(stem);
    if (avoid.some((a) => tagStems.includes(a) || nameWords.includes(a))) continue;

    let score = 0;
    for (const l of like) {
      if (tagStems.includes(l)) score += 3;
      else if (nameWords.includes(l)) score += 2;
    }
    score += it.g.filter((g) => prefs.groups.includes(g)).length;
    if (flavors.some((f) => similarName(f, it.n) || (it.a && similarName(f, it.a)))) score += 4;
    if (brands.some((b) => similarName(b, it.b))) score += 1.5;
    const base = score;
    if (it.c >= 5) score += (it.r - 3.5) * 0.8;
    if (usedSet.has(it.k)) score -= 3;
    score += Math.random() * jitter;
    scored.push({ it, score, base });
  }

  const main = scored.filter((x) => x.base > 0).sort((a, b) => b.score - a.score).slice(0, st.candidates);
  const chosen = new Set(main.map((x) => x.it.k));
  // «Помощники» для баланса: свежесть, цитрус, кислые ягоды с хорошим рейтингом.
  const helpers = scored
    .filter((x) => !chosen.has(x.it.k) && x.it.c >= 5 && x.it.g.some((g) => st.helper_groups.includes(g)))
    .sort((a, b) => b.it.r - a.it.r + (b.score - a.score) * 0.1)
    .slice(0, st.helpers);
  return [...main, ...helpers].map((x) => x.it);
}

/** Шаг 3. ИИ собирает три микса из кандидатов. Смысловые правила — из таблицы, технический хвост — здесь. */
export function composePrompt(cfg, lang = 'ru') {
  const t = tx(cfg, lang);
  const st = cfg.settings, sy = cfg.style;
  const vars = { max_tobaccos: st.max_tobaccos, strongish_max: st.strongish_max };
  return 'Ты опытный кальянный мастер магазина. Собери 3 микса под запрос клиента ТОЛЬКО из табаков списка.\n' +
    'Формат строки списка: номер|табак|крепость|рейтинг|вкусы [группы]|пометки.\n' +
    'Правила:\n' +
    cfg.rules.map((r) => '- ' + fill(r, vars)).join('\n') + '\n' +
    '- title — ' + sy.title_rule + '\n' +
    '- text — ' + sy.text_rule + '\n' +
    (sy.examples.length ? '  Пиши в стиле этих описаний нашего магазина:\n' + sy.examples.map((e) => '  «' + e + '»').join('\n') + '\n' : '') +
    sy.extra.map((x) => '  ' + x + '\n').join('') +
    // ↓ технический хвост: от него зависит, сможет ли бот разобрать ответ. В таблицу не выносится.
    '- title и text пиши на ' + t.llmLang + ' языке. Названия брендов и табаков в текст не переводи.\n' +
    '- Доли — целые числа, кратные 5, в сумме ровно 100. Номера табаков — только из списка.\n' +
    '- Для картинки КАЖДОГО микса у каждого табака добавь "look" НА АНГЛИЙСКОМ: густой глянцевый соус цвета этого вкуса, ' +
    '3–6 слов, например "glossy deep purple blackberry syrup", "creamy white vanilla cream", "bright orange mango puree".\n' +
    '- garnish в каждом миксе — НА АНГЛИЙСКОМ свежие ингредиенты этого микса для декора вокруг, 3–5 штук через запятую, например "fresh blackberries, blueberries, lemon wedges, mint leaves". ' +
    'Только еда и напитки: без людей, кальянов и сигарет.\n' +
    'Верни ТОЛЬКО JSON: {"mixes":[{"title":"","parts":[{"n":1,"p":50,"look":""}],"text":"","garnish":""}]}';
}

async function composeMixes(env, session, candidates, lang = 'ru', cfg = DEFAULTS) {
  const lines = candidates.map((it, i) => {
    const acc = accentMax(it, session.prefs, cfg.accents);
    return `${i + 1}|${it.b}${it.l && it.l !== 'Основная' ? ' ' + it.l : ''} — ${it.n}${it.a ? ' (' + it.a + ')' : ''}|` +
      `${STRENGTH_NAME[effStrength(it, cfg.settings.strong_words)] || '?'}|${it.c >= 3 ? it.r : '-'}|${it.t.join(', ')}${it.g.length ? ' [' + it.g.join(', ') + ']' : ''}` +
      (acc ? `|ТОЛЬКО АКЦЕНТ ≤${acc}%` : '');
  });
  const want = { light: 'лёгкая', medium: 'средняя', strong: 'крепкая' }[session.prefs.strength] || 'любая';
  const user =
    'Запрос клиента: ' + session.text + '\n' +
    'Желаемая крепость: ' + want + '\n' +
    (session.titles && session.titles.length ? 'Уже предлагали, не повторяй: ' + session.titles.join('; ') + '\n' : '') +
    '\nТабаки в наличии:\n' + lines.join('\n');
  const out = await llmJson(env, composePrompt(cfg, lang), user, 1600);
  const mixes = validateMixes(out, candidates, session.prefs, cfg);
  const common = out && typeof out.garnish === 'string' ? out.garnish.slice(0, 200) : ''; // если ИИ вернул по-старому
  for (const m of mixes) if (!m.garnish) m.garnish = common;
  return mixes;
}

/**
 * Проверяем ответ ИИ и правим то, что бесплатная модель часто нарушает:
 * номера существуют, доли = 100, табак не повторяется в разных миксах,
 * акцентные вкусы — не больше своего %, для лёгкого/среднего запроса средне-крепкие — не больше strongish_max %.
 * Крепость микса считается кодом по табакам, а не со слов ИИ.
 */
export function validateMixes(out, candidates, prefs = null, cfg = DEFAULTS) {
  const st = cfg.settings;
  const res = [];
  const usedAll = new Set();
  for (const m of (out && Array.isArray(out.mixes) ? out.mixes : []).slice(0, 3)) {
    const seen = new Set();
    let parts = (Array.isArray(m.parts) ? m.parts : [])
      .map((p) => ({ item: candidates[Number(p.n) - 1], p: Number(p.p), look: typeof p.look === 'string' ? p.look.slice(0, 80) : '' }))
      .filter((p) => p.item && p.p > 0 && !seen.has(p.item.k) && seen.add(p.item.k))
      .sort((a, b) => b.p - a.p)
      .slice(0, st.max_tobaccos);
    // Табак уже был в предыдущем миксе — убираем повторы, оставляя в миксе минимум 2 табака.
    const fresh = parts.filter((p) => !usedAll.has(p.item.k));
    if (fresh.length < parts.length) {
      const repeats = parts.filter((p) => usedAll.has(p.item.k)).sort((a, b) => b.p - a.p);
      parts = fresh.length >= 2 ? fresh : [...fresh, ...repeats.slice(0, 2 - fresh.length)];
    }
    if (parts.length < 2) continue;

    // Доли → кратно 5, сумма 100.
    const sum = parts.reduce((a, p) => a + p.p, 0);
    parts = parts.map((p) => ({ item: p.item, look: p.look, p: Math.max(5, Math.round((p.p / sum) * 20) * 5) }));
    parts.sort((a, b) => b.p - a.p);
    parts[0].p += 100 - parts.reduce((a, p) => a + p.p, 0);
    if (parts[0].p <= 0) continue;

    // Потолки долей: лишнее отдаём табаку с наибольшей долей, у которого этого ограничения нет.
    // Сначала акцентные вкусы (важнее), потом средне-крепкие при лёгком/среднем запросе.
    const strongish = prefs && ['light', 'medium', 'any', 'unknown'].includes(prefs.strength);
    const limits = [
      (p) => (prefs && accentMax(p.item, prefs, cfg.accents)) || 100,
      (p) => (strongish && effStrength(p.item, st.strong_words) >= 4 ? st.strongish_max : 100),
    ];
    limits.forEach((capOf, li) => {
      for (const p of parts) {
        const cap = capOf(p);
        if (p.p <= cap) continue;
        const free = parts
          .filter((q) => q !== p && capOf(q) >= 100 && limits.slice(0, li).every((prev) => prev(q) >= 100))
          .sort((a, b) => b.p - a.p)[0];
        if (!free) continue; // некуда отдать — оставляем как есть
        free.p += p.p - cap;
        p.p = cap;
      }
    });
    parts.sort((a, b) => b.p - a.p);
    parts.forEach((p) => usedAll.add(p.item.k));

    res.push({
      title: String(m.title || 'Микс').slice(0, 60),
      text: String(m.text || '').slice(0, 500),
      strength: mixStrength(parts, st.strong_words),
      garnish: typeof m.garnish === 'string' ? m.garnish.slice(0, 200) : '',
      parts,
    });
  }
  return res;
}

/** Крепость табака с учётом крепких линеек (Hard, Strong Ligero, Зомби…). Неизвестная — считаем средней. */
export function effStrength(it, words) {
  const s = it.s || 3;
  return isStrongLine(it, words) ? Math.max(s, 5) : s;
}

/** Итоговая крепость микса 1–5: среднее по долям. */
export function mixStrength(parts, words) {
  const avg = parts.reduce((a, p) => a + p.p * effStrength(p.item, words), 0) / 100;
  return avg < 1.5 ? 1 : avg < 2.5 ? 2 : avg < 3.5 ? 3 : avg < 4.5 ? 4 : 5;
}

/** Акцентный вкус, который клиент сам не просил: возвращает максимум %, иначе 0. */
export function accentMax(it, prefs, accents = DEFAULTS.accents) {
  const tags = (it.t || []).map(stem);
  const hit = accents.filter((a) => tags.includes(stem(a.tag)));
  if (!hit.length) return 0;
  const wanted = (prefs && prefs.like || []).map(stem);
  if (hit.some((h) => wanted.includes(stem(h.tag)))) return 0;
  if (prefs && (prefs.flavors || []).some((f) => similarName(f, it.n) || (it.a && similarName(f, it.a)))) return 0;
  return Math.min(...hit.map((h) => h.max));
}
export const isAggressive = (it, prefs, accents) => accentMax(it, prefs, accents) > 0;

/**
 * Карточка микса:
 *   Микс 1 из 3 · лучшее попадание
 *   ПЕЧЕНЬЕ С АРБУЗОМ И МЯТОЙ
 *   ┃ Kraken Strong Ligero · Cookie — 50% · 10 г   ← цитата Telegram (серая плашка)
 *   Описание.
 *   Крепость: средняя      ← считается кодом по табакам
 */
export function renderMix(m, i, t = 'ru', total = 3, bowl = 20) {
  if (typeof t === 'string') t = tx(DEFAULTS, t);
  const label = t.mixOf(i + 1, total) + (i === 0 ? ' · ' + t.best : '');
  const parts = m.parts.map((p) => {
    const it = p.item;
    const line = it.l && it.l !== 'Основная' ? ' ' + it.l : '';
    // Русское название показываем, только если оно добавляет смысл (2+ слова), а не просто перевод.
    const alt = it.a && /[а-яё]/i.test(it.a) && !/[а-яё]/i.test(it.n) && it.a.trim().split(/\s+/).length > 1 ? ' (' + esc(it.a) + ')' : '';
    const g = Math.round((p.p * bowl) / 100 * 2) / 2; // до полуграмма
    return `${esc(it.b + line)} · <b>${esc(it.n)}</b>${alt} — ${p.p}% · ${String(g).replace('.', ',')} ${t.gram}`;
  });
  const strength = typeof m.strength === 'number' ? t.strengthNames[m.strength] : m.strength;
  return (
    `<i>${label}</i>\n` +
    `<b>${esc(m.title.toLocaleUpperCase(t.lang === 'hy' ? 'hy' : 'ru'))}</b>\n\n` +
    `<blockquote>${parts.join('\n')}</blockquote>\n` +
    (m.text ? esc(m.text) + '\n' : '') +
    (strength ? '\n' + t.strengthLabel + ' ' + esc(strength) : '')
  ).trim();
}

/* ═════════════════════════ Мозги (сменные) ═════════════════════════ */

/**
 * Единственное место, где бот разговаривает с языковой моделью.
 * Сменить мозги = поменять LLM_PROVIDER и LLM_MODEL в настройках.
 *   cloudflare — бесплатные модели Workers AI (ключ не нужен)
 *   anthropic  — Claude (нужен секрет LLM_API_KEY)
 *   openai     — OpenAI и любые совместимые сервисы (LLM_API_KEY, при необходимости LLM_BASE_URL)
 */
async function llm(env, system, user, maxTokens) {
  const provider = env.LLM_PROVIDER || 'cloudflare';
  const model = env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];

  if (provider === 'cloudflare') {
    const r = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.7 });
    const c = r && (r.response !== undefined ? r.response : r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
    return typeof c === 'string' ? c : JSON.stringify(c || '');
  }
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.LLM_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    return (j.content || []).map((b) => b.text || '').join('');
  }
  if (provider === 'openai') {
    const base = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.LLM_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('openai ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    return j.choices[0].message.content || '';
  }
  throw new Error('Неизвестный LLM_PROVIDER: ' + provider);
}

async function llmJson(env, system, user, maxTokens) {
  try {
    return parseJson(await llm(env, system, user, maxTokens));
  } catch (e) {
    console.log('llm', e.message);
    return null;
  }
}

/** Модели любят обернуть JSON в текст или ```json — достаём сам объект. */
export function parseJson(text) {
  if (!text) return null;
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/* ═════════════════════════ Картинка ═════════════════════════
 * Стиль — как карточки «SIGMA MIX» на vektorsigma.am/weekly_mix. Части задания — во вкладке «Картинка».
 * Бот сам дописывает цвета соусов каждого микса и ингредиенты.
 */
export function imagePrompt(mixes, image = DEFAULTS.image, withLogo = true) {
  if (!Array.isArray(mixes)) mixes = [mixes];
  mixes = mixes.slice(0, 3);
  const n = mixes.length;
  const pos = n === 3 ? ['left', 'center', 'right'] : n === 2 ? ['left', 'right'] : ['center'];
  const count = ['', 'one', 'two', 'three', 'four'];
  const swirls = mixes.map((m, i) => {
    const parts = m.parts.slice(0, 4);
    const sauces = parts.map((p) => p.look || 'a glossy colorful fruit sauce').join(', ');
    return `swirl ${i + 1} (${pos[i]}): ${count[parts.length] || parts.length} sauces — ${sauces}`;
  }).join('; ');
  // Ингредиенты всех миксов вместе, без повторов, не больше 8.
  const garnish = [...new Set(mixes.flatMap((m) => String(m.garnish || '').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean)))].slice(0, 8).join(', ');
  const img = { ...DEFAULTS.image, ...image };
  const dot = (s) => String(s).trim().replace(/[.:;,\s]+$/, '');
  return [
    dot(img.background) + '.',
    dot(withLogo ? img.logo : img.no_text) + '.',
    dot(fill(img.layout, { count: count[n] || n })) + '.',
    dot(img.swirl) + ` — ${swirls}.`,
    garnish ? dot(img.garnish) + `: ${garnish}.` : '',
    dot(img.quality) + '.',
    dot(img.bans) + '.',
  ].filter(Boolean).join(' ');
}

/** Кириллицу — латиницей: модель рисования не умеет русские буквы. */
export function latin(s) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(s).replace(/[а-яё]/gi, (c) => { const l = map[c.toLowerCase()]; return c === c.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); })
    .replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim();
}

async function makeImage(env, prompt) {
  const model = env.IMAGE_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
  let r;
  if (model.includes('flux-2')) {
    // Модели FLUX.2 принимают параметры формой (multipart).
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('width', '1024');
    form.append('height', '1024');
    const fr = new Response(form);
    r = await env.AI.run(model, { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } });
  } else {
    r = await env.AI.run(model, { prompt, steps: 4 });
  }
  if (r && typeof r.image === 'string') return Uint8Array.from(atob(r.image), (c) => c.charCodeAt(0));
  if (r && r.result && typeof r.result.image === 'string') return Uint8Array.from(atob(r.result.image), (c) => c.charCodeAt(0));
  if (r instanceof ReadableStream) return new Uint8Array(await new Response(r).arrayBuffer());
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r instanceof Uint8Array) return r;
  throw new Error('неизвестный ответ модели картинок: ' + JSON.stringify(r).slice(0, 200));
}

/* ═════════════════════════ Справочник ═════════════════════════ */

let catCache = { at: 0, sig: '', items: [] };

async function loadCatalog(env) {
  const cfg = await loadConfig(env);
  const brands = cfg.brands.filter((b) => b.on).map((b) => b.code);
  const sig = JSON.stringify([brands, cfg.strength]);
  if (catCache.items.length && catCache.sig === sig && Date.now() - catCache.at < 10 * 60 * 1000) return catCache.items;
  const parts = await Promise.all(brands.map((b) => env.KV.get('cat:' + b, 'json')));
  let items = parts.flatMap((p) => (p && p.items) || []);
  // Поправки крепости из вкладки «Крепость»: бренд или бренд/линейка не слабее указанного.
  if (cfg.strength.length) {
    items = items.map((it) => {
      const f = cfg.strength.filter(({ key }) => it.k === key || it.k.startsWith(key.replace(/\/$/, '') + '/'));
      return f.length ? { ...it, s: Math.max(it.s || 0, ...f.map((x) => x.s)) } : it;
    });
  }
  // Наличие: когда появится выгрузка склада, в KV кладётся ключ stock — список ключей табаков.
  const stock = await env.KV.get('stock', 'json');
  if (Array.isArray(stock) && stock.length) {
    const set = new Set(stock);
    items = items.filter((x) => set.has(x.k));
  }
  catCache = { at: Date.now(), sig, items };
  return items;
}

/** Забирает все вкусы одного бренда и кладёт в KV. */
/**
 * Запрос к сайту с повторами: при сбоях 5xx и 429 (сайт перегружен или притормаживает нас)
 * ждём 3, 8 и 15 секунд и пробуем снова.
 */
async function fetchRetry(fetcher, url, opts, waits = [3000, 8000, 15000]) {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetcher(url, opts); } catch (e) { if (i >= waits.length) throw e; }
    if (r && (r.ok || (r.status < 500 && r.status !== 429))) return r;
    if (i >= waits.length) return r;
    await new Promise((res) => setTimeout(res, waits[i]));
  }
}

export async function crawlBrand(env, slug, fetcher = fetch, waits) {
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; VektorSigmaMixBot/1.0)', accept: 'text/html,application/json' };
  const page = await fetchRetry(fetcher, `${SOURCE}/tobaccos/${slug}`, { headers }, waits);
  if (!page.ok) throw new Error(`${slug}: страница бренда вернула ${page.status}`);
  const html = await page.text();
  const tag = (html.match(/<[^>]*object_wrapper[^>]*>/) || [''])[0];
  const id = (tag.match(/data-id="(\d+)"/) || [])[1];
  if (!id) throw new Error(`${slug}: не нашёл номер бренда на странице`);

  const raw = [];
  for (let offset = 0; offset < 600; ) { // до 30 страниц + повторы — в пределах лимита 50 запросов на запуск
    const r = await fetchRetry(fetcher, `${SOURCE}/postData`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'objectByBrand', data: { id, limit: PAGE, offset, sort: { s: 'rating', d: 'desc' } } }),
    }, waits);
    if (!r.ok) throw new Error(`${slug}: сайт не ответил (код ${r.status}) после 4 попыток, старые данные бренда сохранены`);
    const chunk = await r.json();
    if (!Array.isArray(chunk) || !chunk.length) break;
    raw.push(...chunk);
    offset += chunk.length;
    if (chunk.length < PAGE) break;
    await new Promise((res) => setTimeout(res, 1000)); // не долбим сайт: при частых запросах он перестаёт отвечать
  }

  const items = toItems(raw);
  if (!items.length) throw new Error(`${slug}: пустой список, старые данные не трогаю`);
  await env.KV.put('cat:' + slug, JSON.stringify({ updated: new Date().toISOString(), total: raw.length, items }));
  catCache = { at: 0, sig: '', items: [] };
  return { slug, total: raw.length, active: items.length };
}

/** Сырые записи сайта → компактные записи справочника. Снятые с производства выкидываем. */
export function toItems(raw) {
  const seen = new Set();
  const items = [];
  for (const x of raw) {
    if (!x || !x.name || seen.has(x.slug)) continue;
    seen.add(x.slug);
    if (/снят/i.test(x.status || '')) continue;
    const tags = Array.isArray(x.tags) ? x.tags : [];
    items.push({
      k: x.slug,                                     // ключ: brand/line/flavor
      n: String(x.name).trim(),
      a: String(x.alt_name || '').trim(),
      b: String(x.brand || '').trim(),
      l: String(x.line || '').trim(),
      s: STRENGTH[String(x.strength || '').toLowerCase()] || 0,
      r: Number(x.rating) || 0,
      c: parseInt(x.ratings_count, 10) || 0,
      t: [...new Set(tags.map((t) => t.name).filter(Boolean))],
      g: [...new Set(tags.map((t) => t.group).filter(Boolean))],
    });
  }
  return items;
}

/* ═════════════════════════ Служебные страницы ═════════════════════════ */

async function onSetup(url, env) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const r = await tg(env, 'setWebhook', {
    url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'],
  });
  // Сразу подтягиваем таблицу; описание и меню команд ставятся из неё (или из значений по умолчанию).
  const s = env.CONFIG_SHEET_ID ? await syncConfig(env) : null;
  if (s) await saveStatus(env, s);
  if (!s || !s.ok || !s.changed) await applyProfile(env, await loadConfig(env));
  return Response.json({ webhook: r, sheet: s ? (s.ok ? { ok: true, changed: s.changed, warnings: s.warnings } : { ok: false, errors: s.errors }) : 'CONFIG_SHEET_ID не задан' });
}

/** /refresh?key=… — страница, которая по очереди обновляет все бренды. /refresh?key=…&brand=code — один бренд. */
async function onRefresh(url, env) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const brands = (await loadConfig(env)).brands.filter((b) => b.on).map((b) => b.code);
  const brand = url.searchParams.get('brand');
  if (brand) {
    if (!brands.includes(brand)) return Response.json({ ok: false, error: 'бренд не включён во вкладке «Бренды»' });
    try { return Response.json({ ok: true, ...(await crawlBrand(env, brand)) }); }
    catch (e) { return Response.json({ ok: false, error: e.message }); }
  }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Обновление справочника</title><body style="font:16px system-ui;padding:24px;max-width:560px">
<h3>Обновление справочника</h3><div id="log"></div><script>
const brands=${JSON.stringify(brands)},log=document.getElementById('log');
(async()=>{for(const b of brands){const p=document.createElement('p');p.textContent=b+': загружаю…';log.append(p);
try{const r=await fetch(location.pathname+location.search+'&brand='+encodeURIComponent(b)).then(r=>r.json());
p.textContent=r.ok?'✅ '+b+': '+r.active+' вкусов в продаже (всего на сайте '+r.total+')':'❌ '+b+': '+r.error;}
catch(e){p.textContent='❌ '+b+': '+e.message;}}
const d=document.createElement('p');d.textContent='Готово.';log.append(d);})();
</script>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* ═════════════════════════ Мелочи ═════════════════════════ */

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

/** Крепкие линейки по словам из настройки strong_words: Хулиган Hard, Kraken Strong Ligero, Хулиган Зомби и т.п. */
export const isStrongLine = (it, words = DEFAULTS.settings.strong_words) => {
  const x = norm((it.l || '') + ' ' + (it.n || ''));
  return words.some((w) => {
    const ww = norm(w);
    if (!ww) return false;
    // Латинские слова — целиком (чтобы «hard» не ловил «Hardcore»), кириллические — как начало слова («крепк» → «крепкая»).
    return /^[a-z0-9 ]+$/.test(ww) ? new RegExp('\\b' + ww + '\\b').test(x) : new RegExp('(^|[^а-яa-z])' + ww).test(x);
  });
};

/** Название к сравнению: латиницей, без пробелов, дефисов и регистра. «Крем-брюле» → «krembryule». */
const squash = (s) => latin(norm(s)).toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => latin(norm(s)).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** «Скелет» из согласных — гасит разницу транслита: «креме брюле» и «Creme Brulee» → «krmbrl». */
const skel = (s) => squash(s).replace(/dzh/g, 'g').replace(/j/g, 'g').replace(/kh/g, 'h').replace(/ck/g, 'k').replace(/[cq]/g, 'k').replace(/ph/g, 'f')
  .replace(/w/g, 'v').replace(/x/g, 'ks').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');

/** Похожи ли названия с учётом опечаток и транслита: «креме брюле» ≈ «Creme Brulee», «эпик минт» ≈ «Epic Mint». */
export function similarName(a, b) {
  const x = squash(a), y = squash(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  // Одно название — целые слова другого: «Mango» ≈ «Mango Lassi», но «Grape» ≠ «Grapefruit».
  const wa = words(a), wb = words(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length && short.join('').length >= 4 && short.every((w) => long.includes(w))) return true;
  const sx = skel(a), sy = skel(b);
  if (sx.length >= 4 && sy.length >= 4) {
    if (sx === sy) return true;
    if (Math.min(sx.length, sy.length) >= 6 && Math.abs(sx.length - sy.length) <= 1 && editDistance(sx, sy) <= 1) return true;
  }
  if (Math.abs(x.length - y.length) > 2) return false;
  return editDistance(x, y) <= (Math.min(x.length, y.length) >= 10 ? 2 : x.length >= 5 ? 1 : 0);
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** Грубая основа слова, чтобы «малиновый» находил «Малина». */
export const stem = (s) => { const n = norm(s); return n.length > 5 ? n.slice(0, 5) : n; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getSession(env, chat) { return env.KV.get('s:' + chat, 'json'); }
async function putSession(env, chat, s) { return env.KV.put('s:' + chat, JSON.stringify(s), { expirationTtl: 6 * 3600 }); }

/* ───────────────────────── Отправка в Telegram ───────────────────────── */

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log('tg', method, JSON.stringify(j).slice(0, 300));
  return j;
}
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Отправка с HTML. Если в тексте из таблицы сломано форматирование — отправляем без него, но отправляем. */
async function send(env, chat, text, reply_markup) {
  const base = { chat_id: chat, disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) };
  const j = await tg(env, 'sendMessage', { ...base, text, parse_mode: 'HTML' });
  if (!j.ok && /parse entities/i.test(j.description || '')) return tg(env, 'sendMessage', { ...base, text: stripTags(text) });
  return j;
}
const action = (env, chat, a) => tg(env, 'sendChatAction', { chat_id: chat, action: a });

async function sendPhoto(env, chat, bytes, caption, reply_markup) {
  const form = new FormData();
  form.append('chat_id', String(chat));
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'mix.jpg');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.log('tg sendPhoto', JSON.stringify(j).slice(0, 300)); if (caption) await send(env, chat, caption, reply_markup); }
}
