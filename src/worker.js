/**
 * Sigma Mix — Telegram-бот подбора кальянных миксов на Cloudflare Workers.
 *
 * Клиент пишет в свободной форме, что любит и как крепко курит →
 * ИИ разбирает запрос → код отбирает подходящие табаки из справочника →
 * ИИ собирает 3 микса по инструкции из Google Таблицы → одна картинка + три карточки.
 *
 * Google Таблица (CONFIG_SHEET_ID) — пульт управления:
 *   «Инструкция»   — как собирать миксы и писать описания, обычным языком;
 *   «Ограничения»  — что менеджер заметил на проверке («X не сочетать с Y»), главнее инструкции;
 *   «Настройки»    — граммы, доли, повторы, крепкое только по запросу, картинки, админы;
 *   «Бренды». Тексты бота — в коде (DEFAULT_TEXTS).
 * Бот раз в 15 минут (или по /reload) читает таблицу, проверяет и кладёт копию в KV.
 * Клиентские запросы в таблицу не ходят. Ошибка в таблице — работает прежняя копия.
 *
 * Секреты:  BOT_TOKEN, WEBHOOK_SECRET, LLM_API_KEY (для Claude и других платных мозгов)
 * Биндинги: KV (хранилище), AI (Workers AI)
 * wrangler.toml [vars]: CONFIG_SHEET_ID, ADMIN_IDS, LLM_PROVIDER, LLM_MODEL, LLM_MODEL_FAST, LLM_BASE_URL,
 *                      IMAGE_PROVIDER, IMAGE_MODEL, IMAGE_QUALITY
 * Секреты: BOT_TOKEN, WEBHOOK_SECRET, LLM_API_KEY (платный ИИ), IMAGE_API_KEY (картинки OpenAI),
 *          SHEET_SECRET (скрипт Google: журнал и чтение закрытой таблицы; адрес — SHEET_SCRIPT_URL)
 */

/* ═════════════════════════ Значения по умолчанию ═════════════════════════
 * То же самое лежит в Google Таблице. Таблица главнее; здесь — страховка, если таблица недоступна.
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
  picking: ['🔎 Подбираю миксы…', '🔎 Միքսեր եմ ընտրում…', 'Пока бот думает — первая фраза'],
  progress: ['📦 Шуршим пакетиками с табаком… | 👃 Принюхиваемся к вкусам… | 🗄 Перебираем полки с банками… | ⚖️ Отмеряем граммы… | 🧪 Пробуем сочетания… | 🍋 Добавляем кислинку… | 🍯 Проверяем, не слишком ли сладко… | 🧊 Кидаем лёд в колбу… | 🔥 Раздуваем угли… | 🫧 Продуваем шахту… | 🤔 Спорим с кальянщиком о пропорциях… | ✍️ Придумываем названия… | 💋 Подбираем слова повкуснее… | 🎨 Смешиваем краски для картинки… | 🖌 Рисуем твои миксы… | 📸 Выставляем свет… | ✨ Наводим глянец… | 🧐 Проверяем, что всё сходится… | 🎁 Упаковываем красиво… | 💨 Почти готово, выдыхаем…',
    '📦 Խշխշացնում ենք ծխախոտի տուփերը… | 👃 Հոտոտում ենք համերը… | 🗄 Նայում ենք դարակները… | ⚖️ Չափում ենք գրամները… | 🧪 Փորձում ենք համադրությունները… | 🍋 Ավելացնում ենք թթվաշություն… | 🍯 Ստուգում ենք՝ շատ քաղցր չէ՞… | 🧊 Սառույց ենք գցում կոլբայի մեջ… | 🔥 Վառում ենք ածուխները… | 🫧 Փչում ենք նարգիլեն… | 🤔 Վիճում ենք վարպետի հետ համամասնությունների մասին… | ✍️ Անուններ ենք հորինում… | 💋 Համեղ բառեր ենք ընտրում… | 🎨 Խառնում ենք ներկերը նկարի համար… | 🖌 Նկարում ենք քո միքսերը… | 📸 Լույսն ենք ուղղում… | ✨ Փայլ ենք տալիս… | 🧐 Ստուգում ենք, որ ամեն ինչ համընկնի… | 🎁 Գեղեցիկ փաթեթավորում ենք… | 💨 Գրեթե պատրաստ է…',
    'Фразы, которые сменяют друг друга, пока бот думает. Разделяются знаком |'],
  strength_remembered: ['Крепость — как в прошлый раз: {s}. Захочешь иначе — просто напиши.', 'Թնդությունը՝ նախորդի պես․ {s}։ Եթե ուզում ես այլ կերպ, պարզապես գրիր։',
    'Под «Подбираю миксы…», если бот взял крепость из прошлого запроса'],
  out_of_stock: ['Сейчас нет в наличии: {name}. Собрали миксы с похожим вкусом из того, что есть 👇', 'Հիմա առկա չէ՝ {name}։ Հավաքել ենք նման համով միքսեր առկա տեսականուց 👇',
    'Строка перед миксами, если клиент попросил табак, которого нет в наличии'],
  picking_more: ['🔄 Думаю над другими вариантами…', '🔄 Մտածում եմ այլ տարբերակների մասին…', 'После кнопки «Ещё варианты»'],
  gram: ['г', 'գ', 'Сокращение «грамм» в составе микса'],
  strength_label: ['Крепость:', 'Թնդություն՝', 'Подпись перед крепостью микса'],
  strength_1: ['лёгкая', 'թեթև', 'Крепость микса'],
  strength_2: ['средне-лёгкая', 'միջին-թեթև', 'Крепость микса'],
  strength_3: ['средняя', 'միջին', 'Крепость микса'],
  strength_4: ['средне-крепкая', 'միջին-թունդ', 'Крепость микса'],
  strength_5: ['крепкая', 'թունդ', 'Крепость микса'],
  order_hint: ['🛒 Понравился микс? Нажми на него ниже — откроется чат с менеджером, заказ уже будет вписан.', '🛒 Հավանեցի՞ր միքսը։ Սեղմիր ներքևում՝ կբացվի զրույց մենեջերի հետ, պատվերն արդեն գրված կլինի։',
    'Под последним миксом, над кнопками заказа'],
  order_btn: ['🛒 Заказать: {name}', '🛒 Պատվիրել՝ {name}', 'Кнопка заказа под миксами; {name} — название микса'],
  order_text: ['Здравствуйте! Хочу заказать табаки для микса «{name}»:', 'Բարև Ձեզ։ Ուզում եմ պատվիրել ծխախոտներ «{name}» միքսի համար․', 'Первая строка готового сообщения менеджеру'],
  pack_one: ['пачка {g} г', '{g} գ տուփ', 'Пометка у табака: в какой пачке он есть; {g} — вес пачки'],
  pack_many: ['пачки {g} г', 'տուփեր՝ {g} գ', 'Пометка у табака, если есть несколько пачек; {g} — веса через «/»'],
  pack_note: ['только пачка {g} г', 'միայն {g} գ տուփ', 'Пометка у табака, которого нет в маленькой пачке; {g} — вес пачки'],
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

// Какие тексты показываем в таблице (остальные — служебные, живут в коде, но их тоже можно добавить строкой в таблицу).
const MAIN_TEXT_KEYS = ['hello', 'choose_lang', 'lang_set', 'picking', 'progress', 'ask_strength', 'strength_remembered', 'btn_light', 'btn_medium', 'btn_strong', 'btn_any',
  'strength_label', 'bowl_note', 'footer', 'btn_more', 'btn_new', 'description', 'about'];

// Настройки: то, что код гарантирует сам, независимо от ИИ. Видно и меняется в таблице.
export const DEFAULT_SETTINGS = [
  { key: 'text_ai', def: 'chatgpt', type: 'choice',
    options: { chatgpt: ['chatgpt', 'gpt', 'openai', 'чатгпт', 'чат гпт', 'чат-гпт'], claude: ['claude', 'клод', 'anthropic'], 'бесплатно': ['бесплатно', 'бесплатные', 'free', 'cloudflare', 'llama'] },
    desc: 'Кто собирает миксы и пишет тексты: «chatgpt», «claude» или «бесплатно» (Llama на Cloudflare). Модели — в wrangler.toml.' },
  { key: 'image_ai', def: 'chatgpt', type: 'choice',
    options: { chatgpt: ['chatgpt', 'gpt', 'openai', 'чатгпт', 'чат гпт', 'чат-гпт'], 'бесплатно': ['бесплатно', 'бесплатные', 'free', 'cloudflare', 'flux'] },
    desc: 'Кто рисует картинку: «chatgpt» или «бесплатно» (FLUX на Cloudflare). Claude картинки не рисует.' },
  { key: 'bowl_grams', def: '20', type: 'int', min: 5, max: 60, desc: 'Сколько грамм в чаше. Граммы каждого табака = его доля × чаша.' },
  { key: 'min_tobaccos', def: '2', type: 'int', min: 2, max: 6, desc: 'Минимум табаков в одном миксе.' },
  { key: 'max_tobaccos', def: '4', type: 'int', min: 2, max: 6, desc: 'Максимум табаков в одном миксе.' },
  { key: 'share_step', def: '5', type: 'int', min: 1, max: 25, desc: 'Доли в миксе кратны этому числу, %. Сумма долей всегда 100%.' },
  { key: 'no_repeats', def: 'да', type: 'yesno', desc: 'Один табак — только в одном миксе из трёх (да / нет).' },
  { key: 'strong_only_on_request', def: 'да', type: 'yesno', desc: 'Крепкие табаки и крепкие линейки — только если клиент сам попросил крепко (да / нет).' },
  { key: 'strong_words', def: 'hard, strong, ligero, zombie, зомби, крепк, хард', type: 'list',
    desc: 'По каким словам в названии линейки или вкуса табак считается крепким. Через запятую.' },
  { key: 'logo_overlay', def: 'да', type: 'yesno', desc: 'Накладывать на картинку готовый логотип (файл src/logo.png) вместо надписи, которую рисует модель (да / нет).' },
  { key: 'strength_memory_hours', def: '3', type: 'int', min: 0, max: 72,
    desc: 'Сколько часов бот помнит выбранную клиентом крепость и не переспрашивает в следующих запросах. 0 — спрашивать каждый раз.' },
  { key: 'only_in_stock', def: 'да', type: 'yesno', desc: 'Только то, что есть на складе (да / нет). Заработает, когда подключим выгрузку склада; до этого — все вкусы наших брендов.' },
  { key: 'images', def: 'да', type: 'yesno', desc: 'Рисовать картинку к миксам (да / нет). Как она выглядит — во вкладке «Инструкция».' },
  { key: 'image_style', def: 'круги', type: 'choice', options: { 'круги': ['круги', 'кружки', 'соусы', 'circles'], 'образы': ['образы', 'образ', 'предметы', 'objects'] },
    desc: 'Стиль картинки: «круги» — три круга-соуса в цветах вкусов; «образы» — три разных предмета по названиям миксов (пломбир, бокал, брауни). У каждого стиля свой раздел во вкладке «Инструкция»: «КАРТИНКА: КРУГИ» и «КАРТИНКА: ОБРАЗЫ».' },
  { key: 'image_first', def: 'да', type: 'yesno',
    desc: '«да» — картинка и текст приходят вместе, пока готовятся — бот показывает «загрузку» со сменой фраз. «нет» — сначала текст, картинка следом (быстрее).' },
  { key: 'order_contact', def: 'yurybadalian', type: 'text', desc: 'Кому в Telegram уходит заказ: имя пользователя без @. Под миксами появляются кнопки «Заказать» с готовым текстом заказа. Пусто — кнопок нет, под миксами ссылка на магазин.' },
  { key: 'shop_url', def: 'https://vektorsigma.am', type: 'text', desc: 'Ссылка на магазин под миксами. Пусто — без ссылки.' },
  { key: 'admins', def: '', type: 'ids', desc: 'Telegram ID админов через запятую: могут /reload и /config и получают уведомления. Свой ID — команда /id у бота.' },
];

// Бренды: код на htreviews.org/tobaccos/<код>, название, включён.
export const DEFAULT_BRANDS = [
  { code: 'deus', name: 'Deus', on: true },
  { code: 'khuligan', name: 'Хулиган', on: true },
  { code: 'spectrum', name: 'Spectrum', on: true },
  { code: 'kraken', name: 'Kraken', on: true },
  { code: 'satyr', name: 'Satyr', on: true },
  { code: 'original-virginia', name: 'Original Virginia', on: true },
  { code: 'morpheus', name: 'Morpheus', on: true },
];

// Инструкция для ИИ — обычным языком. В таблице: одна ячейка = один раздел (заголовок БОЛЬШИМИ БУКВАМИ + текст).
export const DEFAULT_INSTRUCTION = [
  'КТО ТЫ',
  'Ты — опытный кальянный мастер магазина VektorSIGMA. Подбираешь клиенту 3 микса из табаков, которые есть у нас.',
  'КАК СОБИРАТЬ',
  'Все три микса должны отвечать на запрос. Если клиент просит миксы с конкретным вкусом или табаком («миксы с Кэтминтом», «что-нибудь с манго») — он есть в каждом из трёх миксов, а отличаются они сочетаниями вокруг него. Первый — самое точное попадание, второй и третий — другие по характеру, чтобы было из чего выбрать.',
  'Микс не должен быть однобоким. Если основа сладкая (десерт, сливки, шоколад, выпечка, орехи, карамель) — обязательно оттени её кислинкой, цитрусом или свежестью на 15–25%. Три десерта в одном миксе — нельзя, если клиент прямо не просил «чистый десерт».',
  'Яркие вкусы забивают остальные: гуава, мята, холодок, корица, кардамон, гвоздика, кофе, роза, лаванда, хвоя, эвкалипт, табак, сигара. Давай их только акцентом — до 20%, если клиент сам не просил именно этот вкус.',
  'Не ставь в один микс два почти одинаковых вкуса (две мяты, две малины), если клиент не просил усилить именно его.',
  'Необычные и гастрономические вкусы (сыр, бекон, мясо, рыба, чеснок, грибы, томат, кактус и подобные) бери, только если клиент сам просит что-то странное, дикое, несъедобное или прямо называет такой вкус. На обычный запрос (ягоды, фрукты, свежесть, десерты, «удиви меня») такие табаки не ставь: удивлять нужно сочетанием привычных вкусов, а не едой.',
  'КРЕПОСТЬ',
  'Учитывай, как крепко курит клиент. Если лёгко или средне — табаков с крепостью «средне-крепкая» не больше 30% в миксе.',
  'Kraken на деле крепче, чем пишут на htreviews: считай его средне-крепким.',
  'ИДЕЯ, НАЗВАНИЕ, ОПИСАНИЕ',
  'Клиент приходит за «отвалом башки», а не за списком табаков. Каждый микс — узнаваемый образ, который можно представить на вкус ещё до первой затяжки: коктейль, напиток, десерт, блюдо. Простой микс из двух вкусов — понятная классика: «Виски-кола». Сложный из трёх-четырёх — как продуманный коктейль: «Виски сауэр» — виски, лимон, сладкий сироп, шелковистая пенка.',
  'Сначала придумай образ, потом подбери табаки, которые его складывают, — а не наоборот. Образ собирай только из табаков, которые есть в списке; если для образа чего-то не хватает — выбери другой образ, не натягивай.',
  'Хотя бы один из трёх миксов должен удивлять: неожиданное, но логичное сочетание, до которого клиент сам бы не додумался.',
  'Название — это и есть образ: 1–3 слова, сразу рисует картинку и вкус («Виски сауэр», «Малиновый мохито», «Тирамису на террасе», «Пина колада»). Не перечисляй табаки в названии: «Кэтминт с лимоном» — плохо.',
  'Описание — 2–3 коротких предложения, до 45 слов, на «ты». Это не состав, а соблазн: клиент должен захотеть этот микс, ещё не дочитав. Каждый раз выбирай один ход и строй описание вокруг него: сцена (где и когда это курят), движение вкуса (что сначала, что потом, что на выдохе), ощущение в теле (холодок, тепло, тягучесть, пузырьки), сравнение с десертом или коктейлем, характер микса (дерзкий, ленивый, нежный).',
  'Три описания в одном ответе — три разных хода, разное начало и разный ритм. Не повторяй одни и те же слова и обороты из микса в микс. Конкретика вместо общих слов: не «приятный вкус», а «ириска, которая тянется». Без воды, канцелярита, «ты почувствуешь» и обещаний про здоровье. Не называй вкусов, которых нет в составе.',
  'Примеры тона (не копируй обороты, бери настроение): «Летняя терраса, в бокале звенит лёд. Гранатовый апероль горчит ровно настолько, чтобы захотелось ещё, а белый персик смягчает финал.» «Сначала ежевика — тёмная, винная, почти терпкая. Потом её накрывает черничный йогурт, и всё становится бархатным. Персик на выдохе — как мёд с ложки.» «Игристое бьёт в нос пузырьками, манго с ананасом тянут в тропики. Юдзу щиплет язык и не даёт расслабиться.»',
  // Два стиля картинки. Какой работает — настройка image_style; ИИ получает только раздел выбранного стиля.
  'КАРТИНКА: КРУГИ',
  'Одна квадратная картинка на все три микса, премиальная рекламная фуд-съёмка сверху. Светлый почти белый фон с лёгкой серой геометрией: тонкие круги, треугольники, плюсики, пунктир, штриховка.',
  'Композиция занимает весь квадрат, без больших пустых мест. Сверху по центру оставь небольшое пустое место под логотип (чуть меньше трети ширины) — его добавят отдельно: ничего там не рисуй и не пиши, никаких рамок и плашек, просто тот же фон. Верхние углы заполни ингредиентами так же плотно, как нижние, вплотную к этому месту.',
  'В середине кадра в один ряд три крупных круга одинакового размера — микс 1, 2, 3 слева направо. Каждый круг — густые глянцевые соусы цвета вкусов микса, перетекающие друг в друга как инь-ян, с капелькой снизу.',
  'Рядом с каждым соусом, снаружи круга, — короткая подпись вкуса: «печенье», «карамель», «лимон». Мелко, аккуратно, тёмно-серым. Без линий, стрелок и выносок — и так понятно, к чему подпись.',
  'Под каждым кругом — название этого микса заглавными жирными чёрными буквами. Цифр и номеров нет.',
  'По краям и в нижних углах кадра свежие ингредиенты миксов, частично обрезанные краем. Сочные цвета, мягкие тени. Без брендов и процентов. Без людей, рук, кальянов, сигарет и дыма.',
  'КАРТИНКА: ОБРАЗЫ',
  'Одна квадратная картинка на все три микса, премиальная рекламная фуд-съёмка сверху. Светлый почти белый фон с лёгкой серой геометрией: тонкие круги, треугольники, плюсики, пунктир, штриховка.',
  'Композиция занимает весь квадрат, без больших пустых мест. Сверху по центру оставь небольшое пустое место под логотип (чуть меньше трети ширины) — его добавят отдельно: ничего там не рисуй и не пиши, никаких рамок и плашек, просто тот же фон. Верхние углы заполни ингредиентами так же плотно, как нижние, вплотную к этому месту.',
  'В середине кадра в один ряд три крупных изображения одинакового размера — микс 1, 2, 3 слева направо. Каждое изображение — это сам образ микса из его названия, а не абстрактный круг: если микс «Клубничный пломбир» — шарик пломбира с клубникой, если «Виски сауэр» — бокал коктейля с пенкой и лимоном, если «Брауни» — кусок брауни. Аппетитно, сочно, с глянцем, в цветах вкусов этого микса. Все три разные.',
  'Рядом с каждым изображением 2–3 коротких подписи вкусов из состава микса: «клубника», «сливки», «лёд». Мелко, аккуратно, тёмно-серым, без линий и стрелок.',
  'Под каждым изображением — название этого микса заглавными жирными чёрными буквами. Цифр и номеров нет.',
  'По краям и в нижних углах кадра свежие ингредиенты миксов, частично обрезанные краем. Сочные цвета, мягкие тени. Без брендов и процентов. Без людей, рук, кальянов, сигарет и дыма.',
  // Этот раздел идёт не миксологу, а на первый шаг — разбор сообщения клиента. Бот находит его по названию.
  'РАЗБОР ЗАПРОСА',
  'Клиент пишет боту в Telegram своими словами — по-русски или по-армянски, с опечатками и сокращениями, кириллицей или латиницей («деус», «хулиган», «кракен», «вирджиния»).',
  'Пойми из его сообщения: какие вкусы он хочет, каких не хочет, какие конкретные табаки и бренды назвал и как крепко курит.',
  'Если клиент назвал только настроение или направление («что-то свежее», «как десерт», «летнее») — подбери 3–6 вкусов, которые этому соответствуют.',
  'Крепость понимай по смыслу: «курю средне», «покрепче», «чтобы не давило», «я новичок» — это тоже ответ про крепость. Если про крепость ничего нет — так и отметь, бот сам спросит.',
  'Если сообщение вообще не про кальян, табак или вкусы — отметь, что запрос не по теме.',
];

// Ограничения — то, что менеджер заметил на проверке. Модель считает их главнее инструкции.
export const DEFAULT_LIMITS = [
  { text: 'Guava Supreme и любая гуава забивают всё — не больше 15% и только с яркими фруктами.', who: 'Команда', when: '10.11.2026' },
  { text: 'Не собирать микс только из десертов: Rum Cake + Cream Waffles + Creme Brulee — приторно, так нельзя.', who: 'Команда', when: '10.11.2026' },
];

export const DEFAULTS = {
  settings: Object.fromEntries(DEFAULT_SETTINGS.map((s) => [s.key, parseSetting(s, s.def).value])),
  instruction: DEFAULT_INSTRUCTION,
  limits: DEFAULT_LIMITS.map((l) => l.text),
  brands: DEFAULT_BRANDS,
  texts: Object.fromEntries(Object.entries(DEFAULT_TEXTS).map(([k, v]) => [k, { ru: v[0], hy: v[1] }])),
};

/* ═════════════════════════ Google Таблица ═════════════════════════
 * Названия вкладок и первая строка (заголовки) — не менять: по ним бот понимает, что читает.
 */
export const SHEET_TABS = [
  { name: 'Инструкция', head: ['Инструкция для миксолога'] },
  { name: 'Ограничения', head: ['Ограничение'] }, // одна колонка; старые «Кто добавил» и «Когда» не мешают, бот их не читает
  { name: 'Настройки', head: ['Параметр', 'Значение', 'Что это'] },
  { name: 'Бренды', head: ['Код на htreviews', 'Название', 'Включён'] },
];
const SECTION_NAMES = { instruction: 'инструкция', limits: 'ограничения', settings: 'настройки', brands: 'бренды' };

/** Инструкция по разделам для таблицы: одна ячейка = заголовок БОЛЬШИМИ БУКВАМИ + текст раздела. */
export function instructionSections(lines) {
  const out = [];
  for (const x of lines) {
    if (isSectionTitle(x) || !out.length) out.push([x]);
    else out[out.length - 1].push(x);
  }
  return out.map((s) => s.join('\n'));
}
const isSectionTitle = (x) => x.length < 40 && x === x.toUpperCase() && /[A-ZА-ЯЁ]/.test(x);
const isParseTitle = (x) => isSectionTitle(x) && /^РАЗБОР ЗАПРОС/i.test(x.trim());

/**
 * Делим инструкцию: раздел «РАЗБОР ЗАПРОСА» — для первого шага (понять сообщение клиента),
 * всё остальное — миксологу. Нет такого раздела в таблице — для разбора берём текст из кода.
 */
const IMAGE_STYLES = { 'круги': /КРУГ/i, 'образы': /ОБРАЗ/i };
const isImageTitle = (x) => isSectionTitle(x) && /^КАРТИНК/i.test(x.trim());

/**
 * Инструкция для миксолога с разделом про картинку только выбранного стиля (image_style).
 * Раздел стиля — «КАРТИНКА: КРУГИ» / «КАРТИНКА: ОБРАЗЫ»; просто «КАРТИНКА» считается кругами.
 * Нет нужного раздела в таблице — берём его текст из кода (fromTable = false).
 */
export function mixInstruction(lines, style = 'круги') {
  const re = IMAGE_STYLES[style] || IMAGE_STYLES['круги'];
  const sections = [];
  for (const x of splitInstruction(lines).mix) {
    if (isSectionTitle(x) || !sections.length) sections.push([x]); else sections[sections.length - 1].push(x);
  }
  const matches = (sec) => isImageTitle(sec[0]) && (re.test(sec[0]) || (style === 'круги' && !Object.values(IMAGE_STYLES).some((r) => r.test(sec[0]))));
  const rest = sections.filter((sec) => !isImageTitle(sec[0]));
  let mine = sections.find(matches);
  const fromTable = !!mine && mine.length > 1;
  if (!fromTable) mine = lines === DEFAULT_INSTRUCTION ? ['КАРТИНКА'] : mixInstruction(DEFAULT_INSTRUCTION, style).image;
  return { lines: [...rest, ['КАРТИНКА', ...mine.slice(1)]].flat(), image: mine, fromTable };
}

export function splitInstruction(lines) {
  const parse = [], mix = [];
  let inParse = false;
  for (const x of lines) {
    if (isSectionTitle(x)) inParse = isParseTitle(x);
    (inParse ? parse : mix).push(x);
  }
  return { parse: parse.length > 1 ? parse : splitInstruction(DEFAULT_INSTRUCTION).parse, parseFromTable: parse.length > 1, mix };
}

/** Содержимое таблицы по умолчанию (вкладка → строки с заголовком). Из него заполнена Google Таблица. */
export function sheetRows() {
  const H = Object.fromEntries(SHEET_TABS.map((t) => [t.name, t.head]));
  return {
    'Инструкция': [H['Инструкция'], ...instructionSections(DEFAULT_INSTRUCTION).map((x) => [x])],
    'Ограничения': [H['Ограничения'], ...DEFAULT_LIMITS.map((l) => [l.text])],
    'Настройки': [H['Настройки'], ...DEFAULT_SETTINGS.map((s) => [s.key, s.def, s.desc])],
    'Бренды': [H['Бренды'], ...DEFAULT_BRANDS.map((b) => [b.code, b.name, b.on ? 'да' : 'нет'])],
  };
}

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
  if (def.type === 'choice') {
    const low = v.toLowerCase();
    const hit = Object.entries(def.options).find(([, words]) => words.includes(low));
    if (!hit) return { error: `должно быть одно из: ${Object.keys(def.options).map((x) => '«' + x + '»').join(', ')}, а стоит «${v}»` };
    return { value: hit[0] };
  }
  if (def.type === 'ids') {
    const ids = v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const bad = ids.find((x) => !/^\d{4,15}$/.test(x));
    if (bad) return { error: `«${bad}» — не похоже на Telegram ID (только цифры). Свой ID — команда /id у бота` };
    return { value: ids };
  }
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

  // Инструкция: просто строки текста
  const ins = body('Инструкция');
  if (ins) {
    // Ячейка = раздел. Но можно и всё одной ячейкой, и по абзацу в строке — бот склеит и разобьёт сам.
    cfg.instruction = ins.flatMap((r) => r.c[0].split(/\r?\n/)).map((x) => x.trim()).filter(Boolean);
    if (cfg.instruction.join(' ').length < 50) errors.push('Инструкция: почти пустая — так ИИ не поймёт, как собирать миксы');
    else if (!splitInstruction(cfg.instruction).parseFromTable) warnings.push('Инструкция: нет раздела «РАЗБОР ЗАПРОСА» — сообщения клиентов разбираю по тексту из кода');
  }

  // Ограничения: по одному правилу в строке, первая колонка
  const lim = body('Ограничения');
  if (lim) cfg.limits = lim.map((r) => r.c[0]).filter(Boolean);

  // Настройки
  const st = body('Настройки');
  if (st) {
    for (const r of st) {
      const def = DEFAULT_SETTINGS.find((d) => d.key === r.c[0]);
      if (r.c[0] === 'brains') { warnings.push(`Настройки, строка ${r.n}: «brains» больше не используется — вместо неё text_ai и image_ai. Строку можно удалить`); continue; }
      if (!def) { warnings.push(`Настройки, строка ${r.n}: неизвестный параметр «${r.c[0]}» — пропущен`); continue; }
      const p = parseSetting(def, r.c[1]);
      if (p.error) errors.push(`Настройки, строка ${r.n} (${def.key}): ${p.error}`);
      else cfg.settings[def.key] = p.value;
    }
    if (cfg.settings.min_tobaccos > cfg.settings.max_tobaccos) errors.push('Настройки: min_tobaccos больше, чем max_tobaccos');
  }

  // Бренды
  const br = body('Бренды');
  if (br) {
    const list = [];
    for (const r of br) {
      const [code, name, on] = r.c;
      if (!/^[a-z0-9-]+$/.test(code || '')) { errors.push(`Бренды, строка ${r.n}: код «${code}» — только латиница, цифры и дефис, как в адресе htreviews.org/tobaccos/<код>`); continue; }
      const v = (on || '').toLowerCase();
      const isOn = v === '' ? true : YES.includes(v) ? true : NO.includes(v) ? false : null;
      if (isOn === null) { errors.push(`Бренды, строка ${r.n}: «Включён» должно быть «да» или «нет»`); continue; }
      list.push({ code, name: name || code, on: isOn });
    }
    if (!list.some((b) => b.on)) errors.push('Бренды: должен быть включён хотя бы один бренд');
    if (list.filter((b) => b.on).length > 30) errors.push('Бренды: включено больше 30 — еженедельное обновление не успеет скачать все');
    cfg.brands = list;
  }

  // Тексты бота живут только в коде (DEFAULT_TEXTS): вкладка «Тексты бота» больше не читается, её можно удалить.
  cfg.texts = DEFAULTS.texts;
  if (cfg.instruction.length && !mixInstruction(cfg.instruction, cfg.settings.image_style).fromTable) {
    warnings.push(`Инструкция: выбран стиль картинки «${cfg.settings.image_style}», а раздела «КАРТИНКА: ${cfg.settings.image_style.toUpperCase()}» нет — рисую по тексту из кода`);
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
  const cfg = { ...d, ...c, settings: { ...d.settings, ...c.settings }, texts: d.texts, _at: stored ? stored.at : null };
  cfgCache = { at: Date.now(), cfg };
  return cfg;
}

/**
 * Скрипт Google (Apps Script), подключённый к таблице: отдаёт вкладки с настройками и пишет журнал.
 * Адрес — SHEET_SCRIPT_URL в wrangler.toml, общий секрет — SHEET_SECRET (секрет в Cloudflare и константа в скрипте).
 */
async function sheetScript(env, payload, fetcher = fetch) {
  const r = await fetcher(env.SHEET_SCRIPT_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, key: env.SHEET_SECRET }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('скрипт ответил не JSON, код ' + r.status + ': ' + text.slice(0, 120)); }
  if (!j.ok) throw new Error(j.error || 'ошибка скрипта');
  return j;
}

const STRENGTH_LOG = { light: 'Лёгко', medium: 'Средне', strong: 'Крепко', any: 'Без разницы' };
const STRENGTHS = ['light', 'medium', 'strong', 'any'];

/** Память о крепости клиента: сколько часов — настройка strength_memory_hours (0 — не помнить). */
async function rememberStrength(env, chat, strength) {
  const h = (await loadConfig(env)).settings.strength_memory_hours;
  if (h > 0 && STRENGTHS.includes(strength)) await env.KV.put('strength:' + chat, strength, { expirationTtl: Math.max(60, h * 3600) });
}
async function recallStrength(env, chat) {
  if (!((await loadConfig(env)).settings.strength_memory_hours > 0)) return null;
  const s = await env.KV.get('strength:' + chat);
  return STRENGTHS.includes(s) ? s : null;
}

/** Журнал во вкладке «Журнал»: что написал клиент и какую крепость выбрал кнопкой. Пишется в фоне — клиент не ждёт. */
function logToSheet(env, ctx, payload) {
  if (!env.SHEET_SCRIPT_URL || !env.SHEET_SECRET) return;
  const job = sheetScript(env, payload).catch((e) => {
    console.log('journal', e.message);
    return reportProblem(env, 'journal', '⚠️ Не получилось записать в журнал (вкладка «Журнал»): ' + e.message);
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else return job;
}

/** Читает таблицу, проверяет и, если что-то изменилось, сохраняет копию. Ничего не ломает при ошибке. */
export async function syncConfig(env, fetcher = fetch, withStock = false) {
  if (!env.CONFIG_SHEET_ID) return { ok: false, errors: ['в wrangler.toml не указан CONFIG_SHEET_ID'], warnings: [] };
  let tabs = {};
  let stockRows = null;
  if (env.SHEET_SCRIPT_URL && env.SHEET_SECRET) {
    // Через скрипт Google, подключённый к таблице: таблицу можно закрыть от посторонних.
    try {
      const j = await sheetScript(env, { action: 'config', tabs: SHEET_TABS.map((t) => t.name) }, fetcher);
      if (withStock) stockRows = await fetchStockRows(env, fetcher);
      for (const t of SHEET_TABS) if (Array.isArray(j.tabs && j.tabs[t.name])) tabs[t.name] = j.tabs[t.name].map((r) => r.map((c) => String(c)));
    } catch (e) {
      return { ok: false, warnings: [], errors: [`не могу прочитать таблицу через скрипт Google (${e.message}). Проверьте, что скрипт развёрнут и секрет в нём совпадает с SHEET_SECRET`] };
    }
  } else {
    try {
      await Promise.all(SHEET_TABS.map(async (t) => {
        const r = await fetchRetry(fetcher, sheetUrl(env.CONFIG_SHEET_ID, t.name), { headers: { accept: 'text/csv' } }, [1500, 4000]);
        const text = await r.text();
        if (!r.ok || /^\s*</.test(text)) throw new Error(r.ok ? 'нет доступа' : 'код ' + r.status);
        tabs[t.name] = parseCSV(text);
      }));
      if (withStock) stockRows = await fetchStockRows(env, fetcher);
    } catch (e) {
      return { ok: false, warnings: [], errors: [`не могу прочитать таблицу (${e.message}). Проверьте доступ: «Все, у кого есть ссылка» — «Читатель»`] };
    }
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
  const stock = withStock ? await syncStock(env, stockRows, cfg, false, stockRows && stockRows.match).catch((e) => (console.log('stock', e.message), { state: 'error', error: e.message })) : null;
  if (stock) stock.rows = stockRows;
  return { ok: true, changed: !prev || sections.length > 0, sections: prev ? sections : Object.keys(SECTION_NAMES), newBrands, warnings, cfg, stock };
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
  if (r.stock && r.stock.state === 'error') s += '\n\n📦 Наличие: не получилось разобрать вкладку — ' + r.stock.error;
  else if (r.stock && (r.stock.state === 'ok' || r.stock.changed)) s += '\n\n' + stockLine(r.stock) + (r.stock.changed ? ' Обновлено.' : '');
  else if (!r.stock) s += '\n\n📦 Наличие обновляется отдельно: само раз в 15 минут или сразу по команде /stock.';
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
    progress: g('progress').split('|').map((x) => x.trim()).filter(Boolean),
    strengthRemembered: (s) => fill(g('strength_remembered'), { s }),
    outOfStock: (name) => fill(g('out_of_stock'), { name }),
    tooFew: g('too_few'), failed: g('failed'), more: g('btn_more'), newReq: g('btn_new'),
    strengthLabel: g('strength_label'),
    strengthNames: ['', g('strength_1'), g('strength_2'), g('strength_3'), g('strength_4'), g('strength_5')],
    gram: g('gram'), packNote: (w) => fill(g('pack_note'), { g: w }), packOne: (w) => fill(g('pack_one'), { g: w }), orderHint: g('order_hint'), orderBtn: (name) => fill(g('order_btn'), { name }), orderText: (name) => fill(g('order_text'), { name }), packMany: (w) => fill(g('pack_many'), { g: w }), bowlNote: (gr) => fill(g('bowl_note'), { g: gr }), footer: g('footer'),
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
// Бесплатные мозги Cloudflare — для «бесплатно» в text_ai / image_ai и как запасной вариант, если платный ИИ не ответил.
const FREE_LLM = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const FREE_IMAGE = '@cf/black-forest-labs/flux-2-klein-4b';

/**
 * Кто работает — решает таблица (text_ai, image_ai), какие именно модели — wrangler.toml.
 * Ключи: OpenAI — секрет OPENAI_API_KEY или IMAGE_API_KEY; Anthropic — ANTHROPIC_API_KEY или LLM_API_KEY.
 */
export function applyBrains(env, cfg) {
  const s = (cfg && cfg.settings) || {};
  const text = s.text_ai || 'chatgpt', image = s.image_ai || 'chatgpt';
  const openaiKey = env.OPENAI_API_KEY || env.IMAGE_API_KEY;
  const e = { ...env };
  if (text === 'claude') {
    Object.assign(e, { LLM_PROVIDER: 'anthropic', LLM_MODEL: env.CLAUDE_MODEL || 'claude-sonnet-5-5', LLM_MODEL_FAST: env.CLAUDE_MODEL_FAST || 'claude-haiku-5-5',
      LLM_API_KEY: env.ANTHROPIC_API_KEY || env.LLM_API_KEY, LLM_BASE_URL: '' });
  } else if (text === 'chatgpt') {
    Object.assign(e, { LLM_PROVIDER: 'openai', LLM_MODEL: env.OPENAI_MODEL || 'gpt-6.1-terra', LLM_MODEL_FAST: env.OPENAI_MODEL_FAST || 'gpt-6-luna',
      LLM_API_KEY: openaiKey, LLM_BASE_URL: '' });
  } else {
    Object.assign(e, { LLM_PROVIDER: 'cloudflare', LLM_MODEL: FREE_LLM, LLM_MODEL_FAST: '' });
  }
  if (image === 'chatgpt') Object.assign(e, { IMAGE_PROVIDER: 'openai', IMAGE_MODEL: env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare', IMAGE_API_KEY: openaiKey });
  else Object.assign(e, { IMAGE_PROVIDER: 'cloudflare', IMAGE_MODEL: FREE_IMAGE });
  return e;
}

/** Для тестов: сбросить кэш настроек и справочника в памяти. */
export function resetCaches() { cfgCache = { at: 0, cfg: null }; catCache = { at: 0, sig: '', items: [] }; }
// Сколько подходящих табаков показываем ИИ на выбор, и сколько «для баланса» (свежесть, цитрус, ягоды).
const CANDIDATES = 60;
const HELPERS = 15;
const HELPER_GROUPS = ['Освежающий', 'Цитрусовый', 'Ягодный'];

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
  const r = await syncConfig(env, fetch, true);
  const statusChanged = await saveStatus(env, r);
  if (!r.ok && statusChanged) await notifyAdmins(env, '⚠️ Автопроверка таблицы.\n' + syncReport(r));
  if (r.ok && (r.changed || statusChanged || (r.stock && r.stock.changed))) await notifyAdmins(env, '🔄 Автопроверка таблицы.\n' + syncReport(r));
  if (r.ok && r.stock && r.stock.pending) {
    const n = await resolveStock(env, r.cfg, r.stock.rows).catch((e) => (console.log('resolveStock', e.message), 0));
    if (n) await notifyAdmins(env, '📦 Разобрал с помощью ИИ нераспознанные позиции склада.\n' + stockReport(await env.KV.get('stock', 'json')).slice(0, 3500));
  }
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
  return [...new Set([...(cfg.settings.admins || []), ...String(env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)])];
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
    if (update.callback_query) await onCallback(env, update.callback_query, ctx);
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
    await env.KV.delete('strength:' + chat); // начать заново — и крепость спросим заново
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
  // Служебные команды: /id — всем (чтобы узнать свой ID для настройки admins), остальные — только админам.
  if (cmd === '/id') return send(env, chat, `Твой Telegram ID: <code>${msg.from && msg.from.id}</code>`);
  if (cmd === '/reload' || cmd === '/config' || cmd === '/stock' || cmd === '/find') {
    if (!(await adminIds(env)).includes(String(msg.from && msg.from.id))) return send(env, chat, 'Эта команда только для админов бота.');
    if (cmd === '/find') {
      // Поиск по справочнику htreviews: /find spectrum honey
      const q = words(text.replace(/^\/find\S*/i, ''));
      if (!q.length) return send(env, chat, 'Напиши, что искать: /find spectrum honey');
      const all = await allBrandItems(env, await loadConfig(env));
      const stock = await env.KV.get('stock', 'json').catch(() => null);
      const hit = all.filter((x) => { const hay = squash(x.b + ' ' + x.l + ' ' + x.n + ' ' + x.a); return q.every((w) => hay.includes(w)); });
      const lines = [...new Set(all.filter((x) => q.some((w) => squash(x.b).includes(w))).map((x) => x.b + ' · ' + (x.l || '—')))];
      return send(env, chat, esc(`В справочнике всего ${all.length} табаков. Найдено: ${hit.length}\n` +
        hit.slice(0, 40).map((x) => `${stock && stock.items && stock.items[x.k] ? '✅' : '▫️'} ${x.b} · ${x.l || '—'} · ${x.n}${x.a ? ' (' + x.a + ')' : ''}${x.d ? ' — снят с производства' : ''}`).join('\n') +
        (lines.length ? '\n\nЛинейки в справочнике: ' + lines.join('; ') : '')).slice(0, 4000));
    }
    if (cmd === '/stock') {
      await send(env, chat, '⏳ Читаю вкладку «Наличие»…');
      const cfg = await loadConfig(env);
      if (/заново|retry|ещ[её]/i.test(text)) {
        // Забываем ответы «не нашёл» — ИИ посмотрит на эти позиции ещё раз.
        const map = (await env.KV.get('stockmap', 'json').catch(() => null)) || {};
        for (const k of Object.keys(map)) if (!map[k]) delete map[k];
        await env.KV.put('stockmap', JSON.stringify(map));
      }
      try {
        const rows = await fetchStockRows(env);
        const st = await syncStock(env, rows, cfg, /заново|retry|ещ[её]/i.test(text), rows && rows.match);
        if (st.state === 'ok' && st.pending) {
          await send(env, chat, `Нашёл сразу ${st.flavors} вкусов, ещё ${st.pending} позиций отдаю ИИ на разбор — это до минуты…`);
          await resolveStock(env, cfg, rows);
        }
      } catch (e) {
        return send(env, chat, '❌ Не получилось прочитать наличие: ' + esc(e.message));
      }
      return send(env, chat, esc(stockReport(await env.KV.get('stock', 'json').catch(() => null))).slice(0, 4000));
    }
    if (cmd === '/config') return send(env, chat, configSummary(await loadConfig(env), env, await env.KV.get('stock', 'json').catch(() => null)));
    await send(env, chat, '⏳ Читаю таблицу…');
    const r = await syncConfig(env);
    await saveStatus(env, r);
    await send(env, chat, esc(syncReport(r)));
    if (r.ok && r.newBrands.length && ctx) ctx.waitUntil(crawlMissingBrand(env));
    return;
  }

  // Журнал: кто, когда и что написал.
  const from = msg.from || {};
  if (!cmd.startsWith('/')) {
    await logToSheet(env, ctx, { action: 'message', ts: (msg.date ? msg.date * 1000 : Date.now()), userId: from.id || chat,
      username: from.username || '', name: [from.first_name, from.last_name].filter(Boolean).join(' '), text: text.slice(0, 2000) });
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
    if (session.askId) await tg(env, 'deleteMessage', { chat_id: chat, message_id: session.askId }).catch(() => {});
  }
  await action(env, chat, 'typing');
  // Продолжение разговора: «то же самое, только лёгкое», «а без мяты?». Показываем разбору прошлый запрос —
  // он сам решает, продолжение это или новая тема. Кнопка «Новый запрос» прошлый запрос стирает.
  const prev = session && session.stage === 'done' && session.text ? String(session.text) : '';
  const prefs = await extractPrefs(env, request, force ? '' : prev);
  if (!prefs.relevant) return send(env, chat, t.notRelevant);
  const carry = prev && prefs.followup ? { used: session.used || [], titles: session.titles || [] } : { used: [], titles: [] };
  if (prev && prefs.followup) request = (prev + '\n' + text).slice(-1500);
  let note = '';
  if (prefs.strength !== 'unknown') {
    await rememberStrength(env, chat, prefs.strength); // назвал сам — запоминаем
  } else if (!force) {
    const remembered = await recallStrength(env, chat);
    if (remembered) {
      prefs.strength = remembered; // уже выбирал недавно — не переспрашиваем
      note = t.strengthRemembered(t.strength[STRENGTHS.indexOf(remembered)]);
    } else {
      const asked = await send(env, chat, t.askStrength, strengthKeyboard(t));
      // Запоминаем номер вопроса, чтобы убрать его, когда клиент ответит.
      return putSession(env, chat, { stage: 'ask_strength', text: request, prefs, askId: (asked && asked.result && asked.result.message_id) || 0 });
    }
  }
  if (prefs.strength === 'unknown') prefs.strength = 'any';
  await makeMixes(env, chat, { text: request, prefs, ...carry }, false, lang, note);
}

/** /config — коротко, что сейчас действует. */
const CODE_VERSION = '12.11 · 14 (логотип меньше, больше ингредиентов вокруг)';
export function configSummary(cfg, env = {}, stock = null) {
  const at = cfg._at ? new Date(cfg._at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК' : 'ещё не загружалась — работают значения из кода';
  const s = cfg.settings;
  const e = applyBrains(env, cfg);
  const on = cfg.brands.filter((b) => b.on);
  const yn = (b) => (b ? 'да' : 'нет');
  return '⚙️ <b>Настройки бота</b>\n' +
    `Версия кода: ${CODE_VERSION}\n` +
    `Таблица: ${env.CONFIG_SHEET_ID ? `<a href="https://docs.google.com/spreadsheets/d/${env.CONFIG_SHEET_ID}/edit">открыть</a>` : 'не подключена'}\n` +
    `Последнее изменение из таблицы: ${at}\n` +
    `Журнал и чтение таблицы через скрипт Google: ${env.SHEET_SCRIPT_URL ? (env.SHEET_SECRET ? 'подключено' : 'адрес есть, но нет секрета SHEET_SECRET') : 'не подключено (SHEET_SCRIPT_URL пустой)'}\n` +
    `В таблице: тексты — <b>${esc(s.text_ai)}</b>, картинки — <b>${esc(s.image_ai)}</b>\n` +
    `Тексты: ${esc(e.LLM_PROVIDER || 'cloudflare')} · ${esc(e.LLM_MODEL || 'llama-3.3-70b')}` +
    (e.LLM_MODEL_FAST ? ` (разбор запроса — ${esc(e.LLM_MODEL_FAST)})` : '') + '\n' +
    `Картинки: ${esc(e.IMAGE_PROVIDER || 'cloudflare')} · ${esc(e.IMAGE_MODEL || 'flux-2-klein-4b')}` +
    (e.IMAGE_PROVIDER === 'openai' ? ` · качество ${esc(e.IMAGE_QUALITY || 'medium')}` : '') + '\n\n' +
    `Бренды (${on.length}): ${esc(on.map((b) => b.name).join(', '))}\n` +
    `Инструкция: ${cfg.instruction.filter(isSectionTitle).length} разделов, ${cfg.instruction.join(' ').length} знаков · ` +
    `разбор запроса: ${splitInstruction(cfg.instruction).parseFromTable ? 'из таблицы' : 'текст из кода'} · ограничений: ${cfg.limits.length}\n` +
    `Чаша ${s.bowl_grams} г · табаков в миксе ${s.min_tobaccos}–${s.max_tobaccos} · доли кратны ${s.share_step}% · без повторов: ${yn(s.no_repeats)}\n` +
    `Логотип на картинке: ${s.logo_overlay ? (env.IMAGES ? 'готовый файл' : 'рисует модель (нет привязки IMAGES в wrangler.toml)') : 'рисует модель'}\n` +
    `Стиль картинки: ${esc(s.image_style)} (${mixInstruction(cfg.instruction, s.image_style).fromTable ? 'раздел из таблицы' : 'текст из кода'})\n` +
    stockLine(stock ? { state: 'ok', ...stockStats(stock) } : null) + '\n' +
    `Крепкое только по запросу: ${yn(s.strong_only_on_request)} · только из наличия: ${yn(s.only_in_stock)} · картинки: ${yn(s.images)}\n` +
    `Админов: ${s.admins.length + String(env.ADMIN_IDS || '').split(',').filter((x) => x.trim()).length}\n\n` +
    'Изменения в таблице подтягиваются сами раз в 15 минут, или сразу — командой /reload.';
}

async function onCallback(env, cq, ctx) {
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
    // Вопрос с кнопками больше не нужен — убираем, чтобы в чате остались только запрос и миксы.
    if (cq.message.message_id) await tg(env, 'deleteMessage', { chat_id: chat, message_id: cq.message.message_id }).catch(() => {});
    await rememberStrength(env, chat, session.prefs.strength);
    await logToSheet(env, ctx, { action: 'strength', userId: (cq.from && cq.from.id) || chat, strength: STRENGTH_LOG[session.prefs.strength] || session.prefs.strength });
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

function resultKeyboard(t, orders = []) {
  return { inline_keyboard: [
    ...orders.map((o) => [{ text: o.text, url: o.url }]),
    [{ text: t.more, callback_data: 'more' }, { text: t.newReq, callback_data: 'new' }],
  ] };
}

/**
 * Кнопки «Заказать»: ссылка открывает чат с менеджером, в поле ввода уже стоит текст заказа —
 * табаки этого микса и пачки (самая маленькая из тех, что есть). Клиенту остаётся нажать «Отправить».
 */
export function orderButtons(mixes, t, contact) {
  const user = String(contact || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  if (!/^[a-z][a-z0-9_]{3,31}$/i.test(user)) return [];
  return mixes.map((m) => {
    const title = m.title.toLocaleUpperCase(t.lang === 'hy' ? 'hy' : 'ru');
    const line = (p, full) => {
      const it = p.item;
      const w = Array.isArray(it.w) && it.w.length ? Math.min(...it.w) : 0;
      const ln = full && it.l && it.l !== 'Основная' ? ' ' + it.l : '';
      return `— ${it.n} · ${it.b}${ln}` + (w ? `, ${t.packOne(w)}` : '');
    };
    const link = (full) => `https://t.me/${user}?text=` + encodeURIComponent(t.orderText(title) + '\n' + m.parts.map((p) => line(p, full)).join('\n'));
    let url = link(true);
    if (url.length > 1900) url = link(false); // слишком длинная ссылка — без названий линеек
    if (url.length > 1900) url = `https://t.me/${user}?text=` + encodeURIComponent(t.orderText(title));
    return { text: t.orderBtn(title).slice(0, 60), url };
  });
}

/* ═════════════════════════ Подбор миксов ═════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Сообщение-«загрузка»: каждые ~2,5 с меняет фразу, пока бот работает. stop() убирает его. */
async function startProgress(env, chat, first, phrases, note = '') {
  const tail = note ? '\n<i>' + esc(note) + '</i>' : '';
  const j = await send(env, chat, first + tail);
  const id = j && j.result && j.result.message_id;
  let done = false;
  if (id && phrases.length) {
    (async () => {
      for (let i = 0; !done && i < 60; i++) {
        await sleep(2500);
        if (done) break;
        await tg(env, 'editMessageText', { chat_id: chat, message_id: id, text: esc(phrases[i % phrases.length]) + tail, parse_mode: 'HTML' }).catch(() => {});
      }
    })();
  }
  return { stop: async (remove = true) => { done = true; if (id && remove) await tg(env, 'deleteMessage', { chat_id: chat, message_id: id }).catch(() => {}); } };
}

async function makeMixes(env, chat, session, more = false, lang = 'ru', note = '') {
  const cfg = await loadConfig(env);
  env = applyBrains(env, cfg);
  const t = tx(cfg, lang);
  const catalog = await loadCatalog(env);
  if (!catalog.length) return send(env, chat, t.noCatalog);

  const progress = await startProgress(env, chat, more ? t.pickingMore : t.picking, t.progress, note);
  await action(env, chat, 'typing');

  // Клиент назвал табак, которого сейчас нет в наличии: не отказываем, а подбираем похожее по вкусу.
  if (!session.missing) {
    const all = await allBrandItems(env, cfg);
    const inStock = new Set(catalog.map((x) => x.k));
    const gone = [...new Map(all.filter((x) => !inStock.has(x.k)).map((x) => [x.k, x])).values()];
    const hit = askedKeys(gone, session.prefs, session.text);
    // Тот же вкус есть в наличии в другой линейке — это не «нет в наличии».
    const sameInStock = (x) => catalog.some((c) => c.b === x.b && similarName(c.n, x.n));
    session.missing = gone.filter((x) => hit.has(x.k) && !sameInStock(x)).slice(0, 2).map((x) => ({ name: `${x.b} ${x.n}`, t: x.t, g: x.g }));
    if (session.missing.length) {
      session.prefs = { ...session.prefs,
        like: [...new Set([...(session.prefs.like || []), ...session.missing.flatMap((m) => m.t)])],
        groups: [...new Set([...(session.prefs.groups || []), ...session.missing.flatMap((m) => m.g)])] };
    }
  }
  const candidates = pickCandidates(catalog, session.prefs, session.used || [], more, cfg);
  if (candidates.length < 4) { await progress.stop(false); return send(env, chat, t.tooFew, resultKeyboard(t)); }

  let result = await composeMixes(env, session, candidates, lang, cfg);
  if (!result.length) result = await composeMixes(env, session, candidates, lang, cfg); // одна повторная попытка
  if (!result.length) { await progress.stop(false); return send(env, chat, t.failed, resultKeyboard(t)); }

  session.stage = 'done';
  session.used = [...(session.used || []), ...result.flatMap((m) => m.parts.map((p) => p.item.k))].slice(-80);
  session.titles = [...(session.titles || []), ...result.map((m) => m.title)].slice(-15);
  await putSession(env, chat, session);

  const bowl = cfg.settings.bowl_grams;
  const shop = cfg.settings.shop_url;
  // Одной строкой перед миксами: чего нет в наличии. Дальше миксы как обычно, без оговорок в описаниях.
  const orders = orderButtons(result, t, cfg.settings.order_contact);
  const gone = !more && (session.missing || []).length ? esc(t.outOfStock(session.missing.map((m) => m.name).join(', '))) + '\n\n' : '';
  const text = gone + result.map((m, i) => renderMix(m, i, t, result.length, bowl)).join('\n\n') +
    '\n\n<i>' + t.bowlNote(bowl) + '</i>\n' + (orders.length ? t.orderHint : t.footer + (shop ? ' ' + shop : ''));
  // Если Telegram не принял кнопки-ссылки, клиент всё равно получает миксы — с обычными кнопками и ссылкой на магазин.
  const sendMixes = async () => {
    const j = await send(env, chat, text, resultKeyboard(t, orders));
    if (orders.length && j && j.ok === false) await send(env, chat, text.replace(t.orderHint, t.footer + (shop ? ' ' + shop : '')), resultKeyboard(t));
  };
  if (cfg.settings.images && cfg.settings.image_first) {
    // Вместе: «загрузка» крутится, пока рисуется картинка, потом сразу картинка и текст.
    const photo = await coverImage(env, result, cfg);
    await progress.stop();
    if (photo) await sendPhoto(env, chat, photo, '');
    await sendMixes();
  } else {
    await progress.stop();
    await sendMixes();
    if (cfg.settings.images) {
      await action(env, chat, 'upload_photo');
      const photo = await coverImage(env, result, cfg);
      if (photo) await sendPhoto(env, chat, photo, '');
    }
  }
}

/** Общая картинка: две попытки основной моделью, потом запасная. */
async function coverImage(env, mixes, cfg) {
  // Задание от ИИ берём, если оно полноценное; иначе — запасной шаблон.
  let own = String(mixes.image || '');
  const good = own.length > 200;
  const labels = env.IMAGE_PROVIDER === 'openai';
  // Готовый логотип: модель надпись не рисует и оставляет наверху пустое место, код кладёт туда файл logo.png.
  const logo = cfg.settings.logo_overlay && env.IMAGES && !(await env.KV.get('logo:off').catch(() => null)) ? await logoBytes(env) : null;
  const noLogo = (x) => (logo ? x.replace(/the "SIGMA MIX" logo; /, '').replace(/The only text in the image is the "SIGMA MIX" logo: no other/, 'No text in the image at all: no') .replace(/ or the logo\./, '.') + ' ' + LOGO_ZONE : x);
  if (logo) own = own.split(/(?<=[.!])\s+/).filter((x) => !/sigma|logo/i.test(x)).join(' ');
  // Наложение выключено или временно не работает, а в инструкции логотипа уже нет — просим модель нарисовать надпись, как раньше.
  else if (!/sigma/i.test(own)) own += ' ' + IMAGE_TEMPLATE.logo + '.';
  const prompt = noLogo(good ? own + ' ' + (labels ? IMAGE_LABELS[cfg.settings.image_style] || IMAGE_LABELS['круги'] : IMAGE_SAFETY) : imagePrompt(mixes, !!logo));
  let lastErr = '';
  const attempt = (e2) => makeImage(e2, prompt).catch((e) => (console.log('image', e.message), lastErr = e.message, null));
  let photo = await attempt(env);
  if (!photo) photo = await attempt(env);
  if (!photo && lastErr) {
    await reportProblem(env, 'image', `⚠️ Картинка не получилась (${env.IMAGE_PROVIDER || 'cloudflare'} · ${env.IMAGE_MODEL || 'flux'}):\n${lastErr}` +
      (env.IMAGE_PROVIDER === 'openai' ? '\nРисую запасную на Cloudflare.' : ''));
  }
  if (!photo) {
    // Запасной вариант — бесплатно на Cloudflare: FLUX.2, если основная — OpenAI; иначе FLUX.1 (проще).
    const fallback = env.IMAGE_PROVIDER === 'openai' ? '@cf/black-forest-labs/flux-2-klein-4b'
      : (env.IMAGE_MODEL || '').includes('flux-1') ? null : '@cf/black-forest-labs/flux-1-schnell';
    // Бесплатная модель с текстом не дружит — ей даём шаблон без выносок.
    if (fallback) photo = await makeImage({ ...env, IMAGE_PROVIDER: 'cloudflare', IMAGE_MODEL: fallback }, labels ? noLogo(imagePrompt(mixes, !!logo)) : prompt)
      .catch((e) => (console.log('image fallback', e.message), null));
  }
  if (photo && logo) {
    try {
      photo = await drawLogo(env, photo, logo);
    } catch (e) {
      // Наложение не сработало (например, кончился месячный лимит Cloudflare Images): эта картинка уйдёт без логотипа,
      // а следующие 6 часов логотип снова рисует сама модель.
      console.log('logo', e.message);
      await env.KV.put('logo:off', '1', { expirationTtl: 6 * 3600 }).catch(() => {});
      await reportProblem(env, 'logo', '⚠️ Не получилось наложить логотип на картинку: ' + e.message + '\nБлижайшие 6 часов надпись SIGMA MIX рисует сама модель, потом попробую снова.');
    }
  }
  return photo;
}

/** Файл логотипа лежит рядом с кодом (src/logo.png) и попадает в бота при сборке. Нет файла — работаем без наложения. */
let logoCache;
async function logoBytes(env) {
  if (env && env.LOGO_BYTES) return env.LOGO_BYTES; // для тестов
  if (logoCache === undefined) {
    try { const m = await import('./logo.png'); logoCache = new Uint8Array(m.default); } catch (e) { logoCache = null; }
  }
  return logoCache;
}
const asStream = (bytes) => new Response(bytes).body;

/** Кладёт логотип сверху по центру. Размер и отступ — доли от ширины картинки, поэтому масштаб всегда один. */
export async function drawLogo(env, photo, logo) {
  let W = 1024;
  try { const info = await env.IMAGES.info(asStream(photo)); if (info && info.width) W = info.width; } catch (e) { /* размер по умолчанию */ }
  const width = Math.round(W * LOGO_BOX.width);
  const out = await env.IMAGES.input(asStream(photo))
    .draw(env.IMAGES.input(asStream(logo)).transform({ width }), { top: Math.round(W * LOGO_BOX.top), left: Math.round((W - width) / 2) })
    .output({ format: 'image/jpeg', quality: 92 });
  const bytes = new Uint8Array(await out.response().arrayBuffer());
  if (bytes.length < 1000) throw new Error('пустой ответ сервиса картинок');
  return bytes;
}

/** Шаг 1. ИИ превращает свободный текст в структуру предпочтений. */
async function extractPrefs(env, text, prev = '') {
  const cfg = await loadConfig(env);
  env = applyBrains(env, cfg);
  const catalog = await loadCatalog(env);
  const system = parsePrompt(cfg, catalog, !!prev);
  // Разбор — простая задача: можно отдать быстрой дешёвой модели (LLM_MODEL_FAST), сборку — умной (LLM_MODEL).
  const fastEnv = env.LLM_MODEL_FAST ? { ...env, LLM_MODEL: env.LLM_MODEL_FAST, LLM_EFFORT: env.OPENAI_EFFORT_FAST || 'none' } : env;
  const input = prev ? 'ПРЕДЫДУЩИЙ ЗАПРОС КЛИЕНТА (на него уже ответили):\n' + prev + '\n\nНОВОЕ СООБЩЕНИЕ КЛИЕНТА:\n' + text : text;
  const out = await llmJson(fastEnv, system, input, 400);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 12) : []);
  const strength = ['light', 'medium', 'strong', 'any', 'unknown'].includes(out && out.strength) ? out.strength : 'unknown';
  return {
    relevant: !out || out.relevant !== false, // если ИИ не ответил — не блокируем человека
    like: arr(out && out.like), avoid: arr(out && out.avoid), groups: arr(out && out.groups),
    flavors: arr(out && out.flavors), brands: arr(out && out.brands), strength, followup: !!(prev && out && out.followup === true),
  };
}

/** Задание для шага 1: раздел «РАЗБОР ЗАПРОСА» из таблицы + формат ответа (он в коде — от него зависит, поймёт ли бот ответ). */
export function parsePrompt(cfg, catalog = [], withPrev = false) {
  const brands = [...new Set(catalog.map((x) => x.b))];
  const groups = [...new Set(catalog.flatMap((x) => x.g))];
  return splitInstruction(cfg.instruction).parse.join('\n') + '\n\n' +
    'ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ:\n' +
    'Верни ТОЛЬКО JSON без пояснений:\n' +
    '{"relevant":true,"like":[],"avoid":[],"groups":[],"flavors":[],"brands":[],"strength":"light|medium|strong|any|unknown"' + (withPrev ? ',"followup":false' : '') + '}\n' +
    '- relevant: false, если сообщение не по теме.\n' +
    '- like — вкусы, которые клиент хочет, avoid — которых не хочет: по одному слову в именительном падеже ("Малина", "Лайм", "Мята"), ВСЕГДА по-русски (с армянского переводи).\n' +
    '- groups: подходящие направления строго из списка: ' + (groups.join(', ') || 'Фруктовый, Ягодный, Цитрусовый, Освежающий, Десертный') + '.\n' +
    '- flavors: конкретные табаки, которые клиент назвал. Если узнаёшь табак — в оригинальном написании ("Creme Brulee", "Epic Mint"), иначе как написал клиент.\n' +
    '- brands: бренды, которые клиент любит, строго из списка: ' + (brands.join(', ') || '—') + '. Написание клиента сопоставь с ближайшим брендом из списка.\n' +
    '- strength: light — курит лёгкое, medium — среднее, strong — крепкое, any — всё равно, unknown — не сказал.' +
    (withPrev ? '\n- followup: тебе дан предыдущий запрос клиента и его новое сообщение. true — если новое сообщение продолжает или уточняет предыдущий запрос («то же самое, только лёгкое», «такое же направление», «а без мяты?», «ещё что-нибудь такое»): тогда вкусы, табаки и общую идею бери из ОБОИХ сообщений вместе, а там, где они расходятся (крепость, «без …»), главнее новое. false — если новое сообщение само по себе полная новая просьба: тогда предыдущий запрос не учитывай вообще.' : '');
}

/** Шаг 2. Код отбирает из справочника кандидатов под предпочтения. */
export function pickCandidates(catalog, prefs, used = [], more = false, cfg = DEFAULTS) {
  const st = cfg.settings;
  const like = prefs.like.map(stem), avoid = prefs.avoid.map(stem);
  const flavors = prefs.flavors, brands = prefs.brands;
  const usedSet = new Set(used);
  const jitter = more ? 1.5 : 0.5;

  // Крепкое — только если клиент сам попросил (настройка strong_only_on_request). Крепкие табаки и линейки (Hard, Strong, Ligero…).
  const okStrength = (it) => {
    const s = it.s, strongLine = isStrongLine(it, st.strong_words);
    if (prefs.strength === 'strong') return !s || s >= 3 || strongLine;
    if (st.strong_only_on_request && (strongLine || s >= 5)) return false;
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

  const main = scored.filter((x) => x.base > 0).sort((a, b) => b.score - a.score).slice(0, CANDIDATES);
  const chosen = new Set(main.map((x) => x.it.k));
  // «Помощники» для баланса: свежесть, цитрус, кислые ягоды с хорошим рейтингом.
  const helpers = scored
    .filter((x) => !chosen.has(x.it.k) && x.it.c >= 5 && x.it.g.some((g) => HELPER_GROUPS.includes(g)))
    .sort((a, b) => b.it.r - a.it.r + (b.score - a.score) * 0.1)
    .slice(0, HELPERS);
  return [...main, ...helpers].map((x) => x.it);
}

/**
 * Шаг 3. ИИ собирает три микса из кандидатов.
 * Смысл — из таблицы («Инструкция» + «Ограничения»), технические рамки — из «Настроек», формат ответа — здесь.
 */
export function composePrompt(cfg, lang = 'ru') {
  const t = tx(cfg, lang);
  const st = cfg.settings;
  const style = cfg.settings.image_style || 'круги';
  return mixInstruction(cfg.instruction, style).lines.join('\n') + '\n\n' +
    (cfg.limits.length ? 'ОБЯЗАТЕЛЬНЫЕ ОГРАНИЧЕНИЯ ОТ КОМАНДЫ — они важнее всего остального:\n' + cfg.limits.map((x) => '- ' + x).join('\n') + '\n\n' : '') +
    // ↓ технические рамки и формат ответа: от них зависит, сможет ли бот разобрать ответ.
    'ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ:\n' +
    '- Собери ровно 3 микса ТОЛЬКО из табаков списка. Формат строки списка: номер|табак|крепость по htreviews|рейтинг|вкусы [группы].\n' +
    '- Никогда не возвращай пустой список миксов и не проси что-то добавить. Если табака или вкуса, который назвал клиент, в списке нет — подбери самое близкое по вкусу из списка.\n' +
    `- В миксе от ${st.min_tobaccos} до ${st.max_tobaccos} табаков, доли — целые числа, кратные ${st.share_step}, в сумме ровно 100.\n` +
    (st.no_repeats ? '- Каждый табак — только в одном из трёх миксов (кроме отмеченных ★).\n' : '') +
    '- Табаки с пометкой ★ клиент назвал сам: такой табак должен быть в КАЖДОМ из трёх миксов, в разных сочетаниях.\n' +
    '- title и text пиши на ' + t.llmLang + ' языке. Названия брендов и табаков не переводи.\n' +
    '- strength — итоговая крепость микса числом от 1 до 5 (1 лёгкая, 2 средне-лёгкая, 3 средняя, 4 средне-крепкая, 5 крепкая), с учётом инструкции.\n' +
    '- У каждого табака "look" НА АНГЛИЙСКОМ: густой глянцевый соус цвета этого вкуса, 3–6 слов ("glossy deep purple blackberry syrup").\n' +
    '- garnish в каждом миксе — НА АНГЛИЙСКОМ свежие ингредиенты этого микса, 3–5 штук через запятую.\n' +
    '- image — задание для модели рисования НА АНГЛИЙСКОМ, 80–180 слов: одна картинка на все три микса строго по разделу инструкции про картинку, ' +
    'с конкретным описанием изображения каждого микса (слева направо — микс 1, 2, 3): что нарисовано, цвета, ингредиенты. Без людей, кальянов, сигарет и дыма.\n' +
    (cfg.settings.image_ai === 'chatgpt'
      ? (style === 'образы'
        ? '  Стиль «образы»: три РАЗНЫХ предмета — каждый изображает сам образ своего микса из названия (десерт, напиток, блюдо), никаких абстрактных кругов и одинаковых форм. '
        : '  Стиль «круги»: три одинаковых по размеру круга из глянцевых соусов; назови точный цвет каждого соуса каждого круга. Никаких других предметов вместо кругов. ') +
        'Текст на картинке — на ' + t.llmLang + ' языке: подписи вкусов по 1–2 слова («печенье», «карамель», «лимон») рядом с тем, что они называют, БЕЗ линий и стрелок; под каждым миксом его название заглавными буквами, без цифр и номеров. ' +
        'Каждую подпись и каждое название дай в задании дословно в кавычках и укажи, к какому миксу и к какой его части они относятся. Бренды и проценты не пиши.\n'
      : '  На картинке никакого текста, кроме логотипа, даже если в инструкции сказано иначе: ни подписей, ни названий, ни цифр.\n') +
    'Верни ТОЛЬКО JSON: {"mixes":[{"title":"","parts":[{"n":1,"p":50,"look":""}],"text":"","strength":3,"garnish":""}],"image":""}';
}

async function composeMixes(env, session, candidates, lang = 'ru', cfg = DEFAULTS) {
  const asked = askedKeys(candidates, session.prefs, session.text);
  const lines = candidates.map((it, i) =>
    `${asked.has(it.k) ? '★' : ''}${i + 1}|${it.b}${it.l && it.l !== 'Основная' ? ' ' + it.l : ''} — ${it.n}${it.a ? ' (' + it.a + ')' : ''}|` +
    `${STRENGTH_NAME[effStrength(it, cfg.settings.strong_words)] || '?'}|${it.c >= 3 ? it.r : '-'}|${it.t.join(', ')}${it.g.length ? ' [' + it.g.join(', ') + ']' : ''}`);
  const want = { light: 'лёгкая', medium: 'средняя', strong: 'крепкая' }[session.prefs.strength] || 'любая';
  const user =
    'Запрос клиента: ' + session.text + '\n' +
    'Желаемая крепость: ' + want + '\n' +
    (session.titles && session.titles.length ? 'Уже предлагали, не повторяй: ' + session.titles.join('; ') + '\n' : '') +
    ((session.missing || []).length ? 'Сейчас нет в наличии: ' + session.missing.map((m) => `${m.name} (вкус: ${m.t.join(', ') || '—'})`).join('; ') +
      '. Не отказывай и не предлагай ждать поступления: собери три микса с максимально похожим вкусом из списка. Клиенту уже отдельно сказали, что этого табака нет: в названиях и описаниях миксов его не упоминай и не пиши про замену — описывай миксы как обычно.\n' : '') +
    '\nТабаки в наличии:\n' + lines.join('\n');
  const out = await llmJson(env, composePrompt(cfg, lang), user, 4000);
  const mixes = validateMixes(out, candidates, cfg, asked);
  if (out && !mixes.length) {
    await reportProblem(env, 'nomix', '⚠️ ИИ ответил, но ни один микс не прошёл проверку (номера табаков, доли). Начало ответа:\n' + JSON.stringify(out).slice(0, 600));
  }
  const common = out && typeof out.garnish === 'string' ? out.garnish.slice(0, 200) : ''; // если ИИ вернул по-старому
  for (const m of mixes) if (!m.garnish) m.garnish = common;
  mixes.image = out && typeof out.image === 'string' ? out.image.slice(0, 2500) : '';
  return mixes;
}

/**
 * Проверяем ответ ИИ по «Настройкам» — это гарантирует код, а не модель:
 * только табаки из списка, от min до max табаков, доли кратны share_step и в сумме 100,
 * без повторов табаков между миксами (no_repeats).
 */
/** Табаки, которые клиент назвал сам («миксы с Кэтминтом»): их ставим во все три микса, повторы для них разрешены. */
const ASKED_STOP = /^(микс\S{0,3}|mix(es)?|табак\S{0,3}|кальян\S{0,3}|вкус\S{0,3}|чаш\S{0,3}|забив\S{0,3}|собер\S{0,3}|сдела\S{0,3}|хочу|хочется|дай(те)?|нужн\S{0,2}|что|для|или|без|чтобы|какой|какие|есть|можно|пожалуйста|крепк\S{0,3}|легк\S{0,3}|лёгк\S{0,3}|средн\S{0,3})$/i;
export function askedKeys(candidates, prefs, text = '') {
  // Берём только то, что клиент действительно написал сам: название должно встречаться в его сообщении
  // (с опечатками и транслитом). Иначе ИИ на шаге разбора может «додумать» табаки — и мы заставим ставить их везде.
  // Общие слова запроса — не названия табаков: иначе «миксы» цепляет «Ягодный микс», и бот считает, что клиент назвал его.
  const w = String(text).toLowerCase().split(/[^a-zа-яёԱ-֏0-9]+/i).filter((x) => x.length >= 3 && !ASKED_STOP.test(x));
  // «с кэтминтом», «с брауни», «манго» — пробуем слово и без падежного окончания
  const bare = (x) => x.replace(/(ами|ями|ом|ем|ой|ей|ою|ах|ях|ов|ев|а|у|ы|и|е|ю|я)$/i, '');
  const grams = [...w, ...w.map(bare).filter((x) => x.length >= 4), ...w.slice(0, -1).map((x, i) => x + ' ' + w[i + 1])];
  // Название должно быть в тексте ЦЕЛИКОМ. Одного общего слова мало: «потный вайб» — это не табак «Заельцовский вайб»,
  // а «с мятой» — не «Марокканская мята». Иначе бот ставит такой табак во все миксы или объявляет, что его нет в наличии.
  const inText = (name) => {
    if (!name) return false;
    if (grams.some((g) => sameName(g, name))) return true;
    const nw = words(name).filter((x) => x.length >= 2);
    return nw.length > 1 && nw.every((x) => grams.some((g) => sameName(g, x)));
  };
  const flavors = ((prefs && prefs.flavors) || []).filter(inText);
  const hits = candidates.filter((it) => inText(it.n) || inText(it.a) || flavors.some((f) => sameName(f, it.n) || (it.a && sameName(f, it.a))));
  // Больше двух обязательных табаков в каждом миксе — уже не микс: оставляем два самых рейтинговых.
  return new Set(hits.sort((x, y) => (y.r || 0) - (x.r || 0)).slice(0, 2).map((it) => it.k));
}

export function validateMixes(out, candidates, cfg = DEFAULTS, asked = new Set()) {
  if (cfg && !cfg.settings && cfg.strength !== undefined) cfg = DEFAULTS; // старый вызов (prefs вместо cfg)
  const st = (cfg || DEFAULTS).settings;
  const step = st.share_step;
  const res = [];
  const usedAll = new Set();
  for (const m of (out && Array.isArray(out.mixes) ? out.mixes : []).slice(0, 3)) {
    const seen = new Set();
    let parts = (Array.isArray(m.parts) ? m.parts : [])
      .map((p) => ({ item: candidates[Number(String(p.n).replace(/\D/g, '')) - 1], p: Number(p.p), look: typeof p.look === 'string' ? p.look.slice(0, 80) : '' }))
      .filter((p) => p.item && p.p > 0 && !seen.has(p.item.k) && seen.add(p.item.k))
      .sort((a, b) => b.p - a.p)
      .slice(0, st.max_tobaccos);
    // Табак уже был в предыдущем миксе — убираем повтор, если без него в миксе остаётся минимум табаков.
    if (st.no_repeats) {
      const fresh = parts.filter((p) => !usedAll.has(p.item.k) || asked.has(p.item.k));
      if (fresh.length < parts.length) {
        const repeats = parts.filter((p) => usedAll.has(p.item.k) && !asked.has(p.item.k)).sort((a, b) => b.p - a.p);
        parts = fresh.length >= st.min_tobaccos ? fresh : [...fresh, ...repeats.slice(0, st.min_tobaccos - fresh.length)];
      }
    }
    if (parts.length < Math.max(2, st.min_tobaccos)) continue;

    // Доли → кратно share_step, сумма 100. Остаток — основному табаку.
    const sum = parts.reduce((a, p) => a + p.p, 0);
    parts = parts.map((p) => ({ item: p.item, look: p.look, p: Math.max(step, Math.round((p.p / sum) * 100 / step) * step) }));
    parts.sort((a, b) => b.p - a.p);
    parts[0].p += 100 - parts.reduce((a, p) => a + p.p, 0);
    if (parts[0].p <= 0) continue;
    parts.sort((a, b) => b.p - a.p);
    parts.forEach((p) => usedAll.add(p.item.k));

    const sNum = Math.round(Number(m.strength));
    res.push({
      title: String(m.title || 'Микс').slice(0, 60),
      text: String(m.text || '').slice(0, 700),
      // Крепость — от ИИ (он знает поправки из инструкции); если не дал — считаем по табакам.
      strength: sNum >= 1 && sNum <= 5 ? sNum : mixStrength(parts, st.strong_words),
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

/** Запасной расчёт крепости микса 1–5: среднее по долям. */
export function mixStrength(parts, words) {
  const avg = parts.reduce((a, p) => a + p.p * effStrength(p.item, words), 0) / 100;
  return avg < 1.5 ? 1 : avg < 2.5 ? 2 : avg < 3.5 ? 3 : avg < 4.5 ? 4 : 5;
}

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
  const parts = m.parts.map((p) => {
    const it = p.item;
    const line = it.l && it.l !== 'Основная' ? ' ' + it.l : '';
    const g = Math.round((p.p * bowl) / 100 * 2) / 2; // до полуграмма
    // Фасовка из наличия: «пачка 25 г», «пачки 25 / 100 г», а если есть только большая — «только пачка 200 г».
    const w = Array.isArray(it.w) ? [...new Set(it.w)].sort((a, b) => a - b) : [];
    const pack = !w.length ? '' : ` · <i>${esc(w.length > 1 ? t.packMany(w.join(' / ')) : w[0] > 40 ? t.packNote(w[0]) : t.packOne(w[0]))}</i>`;
    return `${p.p}% · ${String(g).replace('.', ',')} ${t.gram} — <b>${esc(it.n)}</b> · ${esc(it.b + line)}${pack}`;
  });
  const strength = typeof m.strength === 'number' ? t.strengthNames[m.strength] : m.strength;
  return (
    `<b>${esc(m.title.toLocaleUpperCase(t.lang === 'hy' ? 'hy' : 'ru'))}</b>\n` +
    (m.text ? `<i>${esc(m.text)}</i>\n` : '') +
    `<blockquote>${parts.join('\n')}</blockquote>` +
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
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(j).slice(0, 400));
    const out = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    if (!out) throw new Error('anthropic: пустой ответ, stop_reason=' + j.stop_reason);
    return out;
  }
  if (provider === 'openai' && !env.LLM_BASE_URL) {
    // Модели GPT-6 «думают» перед ответом: effort — сколько. low — хороший баланс для миксов, none — для простого разбора.
    const call = async (effort) => {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.LLM_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model, instructions: system, input: user, reasoning: { effort },
          max_output_tokens: maxTokens + (effort === 'none' ? 0 : 6000) }),
      });
      return { r, j: await r.json().catch(() => ({})) };
    };
    const effort = env.LLM_EFFORT || env.OPENAI_EFFORT || 'low';
    let { r, j } = await call(effort);
    // Модель не умеет effort=none (например, GPT-6.1 Sol) — повторяем с low.
    if (!r.ok && effort === 'none' && /effort|reasoning/i.test(JSON.stringify(j))) ({ r, j } = await call('low'));
    if (!r.ok) throw new Error('openai ' + r.status + ' ' + JSON.stringify(j).slice(0, 400));
    const out = typeof j.output_text === 'string' && j.output_text ? j.output_text
      : (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text || '').join('');
    if (!out) throw new Error('openai: пустой ответ, status=' + j.status + (j.incomplete_details ? ' ' + JSON.stringify(j.incomplete_details) : ''));
    return out;
  }
  if (provider === 'openai') {
    // Совместимые с OpenAI сервисы (LLM_BASE_URL задан) — старый формат chat/completions.
    const base = env.LLM_BASE_URL.replace(/\/$/, '');
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
  const who = `${env.LLM_PROVIDER || 'cloudflare'} · ${env.LLM_MODEL || 'llama'}`;
  let text;
  try {
    text = await llm(env, system, user, maxTokens);
  } catch (e) {
    console.log('llm', e.message);
    const canFallback = (env.LLM_PROVIDER || 'cloudflare') !== 'cloudflare' && env.AI;
    await reportProblem(env, 'llm', `⚠️ ИИ не ответил (${who}):\n${e.message}` +
      (canFallback ? '\nПока отвечает бесплатная модель Cloudflare — клиенты миксы получают.' : ''));
    if (!canFallback) return null;
    try {
      text = await llm({ ...env, LLM_PROVIDER: 'cloudflare', LLM_MODEL: FREE_LLM }, system, user, maxTokens);
    } catch (e2) {
      console.log('llm fallback', e2.message);
      return null;
    }
  }
  const json = parseJson(text);
  if (!json) {
    console.log('llm bad json', String(text).slice(0, 500));
    await reportProblem(env, 'llmjson', `⚠️ ИИ ответил не в том формате (${who}). Начало ответа:\n${String(text).slice(0, 400)}`);
  }
  return json;
}

/**
 * Сообщить админам о сбое — с точной причиной, но не чаще раза в 10 минут на один вид проблемы,
 * чтобы не заспамить, если сломалось надолго.
 */
async function reportProblem(env, kind, text) {
  try {
    if (await env.KV.get('problem:' + kind)) return;
    await env.KV.put('problem:' + kind, '1', { expirationTtl: 600 });
    await notifyAdmins(env, text.slice(0, 3500));
  } catch (e) { console.log('reportProblem', e.message); }
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
 * Обычно задание для картинки пишет ИИ по разделу «КАРТИНКА» из инструкции.
 * Этот шаблон — запасной, если ИИ задание не вернул. К любому заданию добавляется IMAGE_SAFETY.
 */
const IMAGE_TEXT_RULES = 'Text in the image: the "SIGMA MIX" logo; the name of each mix in bold black capitals centered right under it, no digits or numbering; and the short flavor labels given above — small neat dark-grey sans-serif words placed right next to the part they describe, with NO leader lines, arrows or pointers. All text spelled exactly as written, never overlapping the visuals or the logo. No brand names, no percentages, no other text. No people, no hands, no hookah, no cigarettes, no smoke.';
const IMAGE_LABELS = {
  'круги': 'Composition: fill the whole square — exactly three large round sauce swirls of the same size in one row in the vertical center, no big empty areas, especially below the swirls. ' + IMAGE_TEXT_RULES,
  'образы': 'Composition: fill the whole square — exactly three large, clearly different hero objects of similar size in one row in the vertical center, each one depicting its own mix as the dessert, drink or dish from its name; no abstract circles, no repeated shapes, no big empty areas. ' + IMAGE_TEXT_RULES,
};
// Место под готовый логотип: сверху по центру. Те же доли использует наложение (LOGO_BOX).
const LOGO_ZONE = 'IMPORTANT, this overrides anything above: do NOT draw any logo, title, brand name or the words "SIGMA" or "MIX" anywhere. Keep only one small spot at the top center free for a logo that will be added later: the middle 30% of the width, between 8% and 26% of the height. In that spot the same light background simply continues — no objects and no text there, and do NOT draw any box, panel, frame, card or patch of a different shade: the spot must be invisible, with no visible edges. Everything around that spot must be as rich and dense as the bottom of the picture: fill the top-left and top-right corners with large lush clusters of the fresh ingredients, partially cropped by the frame edges and reaching right up to the sides of the spot, plus the light-grey geometric decorations between them. No big empty white areas anywhere, especially not at the top.';
const LOGO_BOX = { width: 0.235, top: 0.105 }; // доли от ширины картинки
const IMAGE_SAFETY = 'The only text in the image is the "SIGMA MIX" logo: no other words, labels, numbers or percentages. No people, no hands, no hookah, no cigarettes, no smoke.';
const IMAGE_TEMPLATE = {
  background: 'Square premium advertising poster for flavor mixes, top-down view, light off-white studio background with subtle minimal light-grey geometric decorations: thin outline circles, small solid triangles, plus signs, dashed lines and diagonal hatching',
  logo: 'At the top center, a modern logo: the word "SIGMA" in thin black sans-serif capitals, directly below it the word "MIX" in heavy bold black sans-serif capitals',
  layout: 'Below the logo, {count} separate round swirls of the same size arranged in one horizontal row from left to right, evenly spaced',
  swirl: 'Each swirl is made of thick glossy liquid sauces flowing into each other like a yin-yang, with clear borders between colors, realistic shiny reflections and one small drip at the bottom edge',
  garnish: 'Fresh ingredients scattered around the edges of the frame, partially cropped',
  quality: 'High-end commercial food photography, soft natural shadows, vibrant saturated colors, crisp focus, clean balanced composition, lots of white space',
};
export function imagePrompt(mixes, noLogo = false) {
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
  const garnish = [...new Set(mixes.flatMap((m) => String(m.garnish || '').split(',').map((g) => g.trim().toLowerCase()).filter(Boolean)))].slice(0, 8).join(', ');
  const T = IMAGE_TEMPLATE;
  return [T.background + '.', noLogo ? '' : T.logo + '.', fill(T.layout, { count: count[n] || n }) + '.', T.swirl + ` — ${swirls}.`,
    garnish ? T.garnish + `: ${garnish}.` : '', T.quality + '.', IMAGE_SAFETY].filter(Boolean).join(' ');
}

/** Кириллицу — латиницей: модель рисования не умеет русские буквы. */
export function latin(s) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(s).replace(/[а-яё]/gi, (c) => { const l = map[c.toLowerCase()]; return c === c.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); })
    .replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim();
}

async function makeImage(env, prompt) {
  if ((env.IMAGE_PROVIDER || 'cloudflare') === 'openai') {
    // OpenAI (картинки ChatGPT). Нужен секрет IMAGE_API_KEY — ключ с platform.openai.com.
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.IMAGE_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.IMAGE_MODEL || 'gpt-image-2.5-flare', prompt, size: '1024x1024', quality: env.IMAGE_QUALITY || 'medium', n: 1 }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.data || !j.data[0] || !j.data[0].b64_json) throw new Error('openai image ' + res.status + ' ' + JSON.stringify(j).slice(0, 200));
    return Uint8Array.from(atob(j.data[0].b64_json), (c) => c.charCodeAt(0));
  }
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
  const sig = JSON.stringify([brands, cfg.settings.only_in_stock]);
  if (catCache.items.length && catCache.sig === sig && Date.now() - catCache.at < 10 * 60 * 1000) return catCache.items;
  const parts = await Promise.all(brands.map((b) => env.KV.get('cat:' + b, 'json')));
  let items = parts.flatMap((p) => (p && p.items) || []);
  // Наличие: оставляем только табаки, которые есть на складе, и запоминаем, в каких пачках (w).
  const stock = cfg.settings.only_in_stock ? await env.KV.get('stock', 'json').catch(() => null) : null;
  if (stock && stock.items && Object.keys(stock.items).length >= STOCK_MIN) {
    items = items.filter((x) => stock.items[x.k]).map((x) => ({ ...x, w: stock.items[x.k] }));
  } else {
    items = items.filter((x) => !x.d); // без склада снятые с производства не предлагаем
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
    // Сайт иногда «зависает» и не отвечает вовсе — ждём не больше 20 секунд на попытку.
    try { r = await fetcher(url, { ...opts, signal: AbortSignal.timeout(20000) }); } catch (e) { if (i >= waits.length) throw new Error('сайт не ответил за 20 секунд'); }
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
  return { slug, total: raw.length, active: items.filter((x) => !x.d).length };
}

/** Сырые записи сайта → компактные записи справочника. Снятые с производства выкидываем. */
export function toItems(raw) {
  const seen = new Set();
  const items = [];
  for (const x of raw) {
    if (!x || !x.name || seen.has(x.slug)) continue;
    seen.add(x.slug);
    // Снятые с производства оставляем с пометкой d: в подбор они идут, только если реально лежат у нас на складе.
    const gone = /снят/i.test(x.status || '');
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
      ...(gone ? { d: 1 } : {}),
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
/** То же название целиком (с опечатками и транслитом), без правила «одно слово из названия». */
export function sameName(a, b) {
  const x = squash(a), y = squash(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  const sx = skel(a), sy = skel(b);
  if (sx.length >= 4 && sy.length >= 4) {
    if (sx === sy) return true;
    if (Math.min(sx.length, sy.length) >= 6 && Math.abs(sx.length - sy.length) <= 1 && editDistance(sx, sy) <= 1) return true;
  }
  if (Math.abs(x.length - y.length) > 2) return false;
  return editDistance(x, y) <= (Math.min(x.length, y.length) >= 10 ? 2 : x.length >= 5 ? 1 : 0);
}
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

/* ═════════════════════════ Наличие (выгрузка склада) ═════════════════════════
 * Менеджер вставляет выгрузку «Остатки» из МоегоСклада как есть на вкладку «Наличие».
 * Бот берёт из неё табаки наших брендов, сопоставляет со справочником htreviews и собирает миксы только из них.
 */
export const STOCK_TAB = 'Наличие';
export const MATCH_TAB = 'Соответствия';
const itemLabel = (it) => `${it.b} · ${it.l || '—'} · ${it.n}${it.a ? ' (' + it.a + ')' : ''}`;
const cellNum = (v) => Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')) || 0;

/** Строки вкладки → позиции с остатком: { group, name, qty }. Группа — строка-заголовок вида «DEUS 30г». */
export function parseStock(rows) {
  const hi = (rows || []).findIndex((r) => r.some((c) => String(c).trim() === 'Наименование') && r.some((c) => String(c).trim() === 'Доступно'));
  if (hi < 0) return null;
  const h = rows[hi].map((c) => String(c).trim());
  const iName = h.indexOf('Наименование'), iQty = h.indexOf('Доступно'), iCode = h.indexOf('Код');
  const out = [];
  let group = '';
  for (const r of rows.slice(hi + 1)) {
    const name = String(r[iName] || '').trim();
    const code = String(r[iCode >= 0 ? iCode : 0] || '').trim();
    if (!name) { if (code && !/^\d+$/.test(code)) group = code; continue; }
    if (/^итого/i.test(name)) continue;
    if (group && cellNum(r[iQty]) > 0) out.push({ group, name, qty: cellNum(r[iQty]) });
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WEIGHT_RE = /(\d{2,3})\s*гр?\.?(?![а-яёa-z])/i;

/** Из «Kraken/KRAKEN Medium Seco 30 гр» + «KRAKEN Medium Seco  Фисташки  30 гр» → бренд, линейка, вес, варианты названия вкуса. */
const groupCache = new Map();
/** Всё, что зависит только от группы («Kraken/KRAKEN Medium Seco 30 гр»), считаем один раз на группу. */
function groupInfo(group, brandNames) {
  const ck = group + '\u0001' + brandNames.join('|');
  if (groupCache.has(ck)) return groupCache.get(ck);
  const brand = brandNames.find((b) => squash(group).includes(squash(b))) || null;
  let info = null;
  if (brand && !/сигар[аы]/i.test(group)) {
    const brandRe = new RegExp(escRe(brand), 'gi');
    const cut = (s) => s.replace(brandRe, ' ').replace(WEIGHT_ALL, ' ').replace(/[\/"«»]/g, ' ');
    const line = cut(group).replace(/\s+/g, ' ').trim();
    const words = line.split(' ').filter((x) => x.length > 1);
    const lineRe = words.length ? new RegExp('(^|\\s)(?:' + words.map(escRe).join('|') + ')(?=\\s|$)', 'gi') : null;
    info = { brand, line, cut, lineRe, weight: Number((group.match(WEIGHT_RE) || [])[1]) || 0 };
  }
  if (groupCache.size > 500) groupCache.clear();
  groupCache.set(ck, info);
  return info;
}
const WEIGHT_ALL = new RegExp(WEIGHT_RE.source, 'gi');

/** Из «Kraken/KRAKEN Medium Seco 30 гр» + «KRAKEN Medium Seco  Фисташки  30 гр» → бренд, линейка, вес, варианты названия вкуса. */
export function stockEntry(pos, brandNames) {
  const gi = groupInfo(pos.group, brandNames);
  if (!gi || /сигар[аы]/i.test(pos.name)) return null;
  const { brand, line } = gi;
  const w = (pos.name.match(WEIGHT_RE) || [])[1];
  let flavor = gi.cut(pos.name);
  if (gi.lineRe) { flavor = flavor.replace(gi.lineRe, ' ').replace(gi.lineRe, ' '); }
  flavor = flavor.replace(/\s+HL\s*$/i, '').replace(/[.,;\s]+$/g, '').replace(/^[.,;\s]+/g, '').replace(/\s+/g, ' ').trim();
  if (!flavor) flavor = line;
  const m = flavor.match(/^(.*?)\s*\((.+)\)\s*$/);
  const names = (m ? [m[1], m[2], m[2].replace(/^аромат\w*\s+/i, '')] : [flavor]).map((x) => x.trim()).filter((x) => x.length >= 2);
  return { brand, line, weight: Number(w) || gi.weight, flavor, names: [...new Set(names)], id: (brand + '|' + line + '|' + flavor).toLowerCase() };
}

// Признаки линейки — чтобы «Strong Ligero» не сопоставился с «Medium Seco», а «Поп» — с обычным Хулиганом.
const LINE_TAGS = [
  ['strong', /strong|ligero|hard|хард|стронг|крепк/i], ['medium', /medium|middle|медиум|мидл|seco/i], ['classic', /classic|классик/i],
  ['mix', /(^|\s)mix|микс/i], ['kitchen', /kitchen|китчен|кухн/i], ['prime', /prime|прайм/i], ['pop', /(^|\s)(pop|поп)(\s|$)/i],
  ['old', /old\s*school|олд/i], ['perfume', /perfume|парфюм/i], ['caviar', /caviar/i], ['cigar', /cigar|reflection/i],
];
const lineTags = (s) => new Set(LINE_TAGS.filter(([, re]) => re.test(s || '')).map(([t]) => t));
function lineScore(stockLine, catLine) {
  const a = lineTags(stockLine), b = lineTags(catLine);
  let s = 0;
  for (const t of a) s += b.has(t) ? 2 : 0;
  for (const t of b) if (!a.has(t)) s -= 1;
  if (a.has('strong') !== b.has('strong')) s -= 3;
  if (a.has('pop') !== b.has('pop')) s -= 3;
  return s;
}

/**
 * Сопоставляем позиции склада со справочником. map — готовые ответы (от ИИ или прошлых запусков): id → ключ табака или ''.
 * Возвращает items: { ключ: [веса пачек] } и список нераспознанного.
 */
export function matchStock(positions, catalog, map = {}, manual = {}) {
  const brandNames = [...new Set(catalog.map((x) => x.b))];
  // Индекс справочника: бренд + «сжатое» название → табаки. Поиск по нему мгновенный —
  // это важно: у бесплатного Cloudflare очень мало процессорного времени на запрос.
  const index = new Map();
  const add = (b, name, it) => { const q = squash(name); if (q.length < 2) return; const k = b + '|' + q; (index.get(k) || index.set(k, []).get(k)).push(it); };
  for (const it of catalog) { add(it.b, it.n, it); if (it.a) add(it.b, it.a, it); }
  const items = {}, unmatched = [];
  let tobaccos = 0;
  const done = new Map(); // одна и та же позиция в разных фасовках ищется один раз
  const pairs = new Map();
  for (const pos of positions) {
    const e = stockEntry(pos, brandNames);
    if (!e) continue;
    tobaccos++;
    if (!done.has(e.id)) {
      let key = manual[e.id], who = 'вручную';
      if (key === undefined) { key = map[e.id]; who = 'ИИ'; }
      if (key === undefined) {
        who = 'по названию';
        const hits = [...new Set(e.names.flatMap((v) => index.get(e.brand + '|' + squash(v)) || []))]
          .map((it) => ({ it, line: lineScore(e.line, it.l) }))
          .sort((x, y) => y.line - x.line || (y.it.c || 0) - (x.it.c || 0));
        // Совпало название, но линейка явно другая (Strong ↔ Medium) — не берём: это другой по крепости табак.
        key = hits.length && hits[0].line > -3 ? hits[0].it.k : undefined;
      }
      done.set(e.id, key);
      pairs.set(e.id, { pos: `${e.brand} | ${e.line} | ${e.flavor}`, key: key || '', who: key === undefined ? 'ждёт разбора ИИ' : who, w: [] });
      if (!key) unmatched.push({ id: e.id, brand: e.brand, line: e.line, flavor: e.flavor, tried: key === '' });
    }
    const key = done.get(e.id);
    if (key) (items[key] = items[key] || []).includes(e.weight) || items[key].push(e.weight);
    const pr = pairs.get(e.id); if (!pr.w.includes(e.weight)) pr.w.push(e.weight);
  }
  for (const k of Object.keys(items)) items[k].sort((a, b) => a - b);
  return { items, unmatched, tobaccos, pairs: [...pairs.values()] };
}

/**
 * Правки менеджера из колонки «Исправить вручную»: «нет» — такого табака в справочнике нет;
 * иначе — слова, по которым табак ищется в справочнике («Spectrum Медиум Honey peach»).
 */
export function manualFixes(tabRows, catalog) {
  const manual = {}, notes = {};
  for (const r of (tabRows || []).slice(1)) {
    const pos = String(r[0] || '').trim(), fix = String(r[4] || '').trim();
    if (!pos || !fix) continue;
    const id = pos.split('|').map((x) => x.trim()).join('|').toLowerCase();
    if (/^(нет|no|-|0|—)$/i.test(fix)) { manual[id] = ''; continue; }
    const q = words(fix);
    const hits = catalog.filter((x) => { const hay = squash(itemLabel(x)); return q.length && q.every((wd) => hay.includes(wd)); })
      .sort((x, y) => squash(itemLabel(x)).length - squash(itemLabel(y)).length);
    if (hits.length) manual[id] = hits[0].k; else notes[id] = 'правка не понята: такого нет в справочнике';
  }
  return { manual, notes };
}

async function allBrandItems(env, cfg) {
  const parts = await Promise.all(cfg.brands.filter((b) => b.on).map((b) => env.KV.get('cat:' + b.code, 'json')));
  return parts.flatMap((p) => (p && p.items) || []);
}
const quickHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };

/** Пересчитать наличие по строкам вкладки. Ничего не меняет, если выгрузка и справочник те же. */
export async function syncStock(env, rows, cfg, force = false, matchRows = null) {
  const prev = await env.KV.get('stock', 'json').catch(() => null);
  const map = (await env.KV.get('stockmap', 'json').catch(() => null)) || {};
  // Дешёвая проверка до разбора: та же выгрузка, те же ответы ИИ, тот же день — ничего не делаем.
  const fixes = (matchRows || []).slice(1).filter((r) => r[4]).map((r) => [r[0], r[4]]);
  const hash = quickHash(JSON.stringify(rows || [])) + ':' + Object.keys(map).length + ':' + quickHash(JSON.stringify(fixes)) + ':' + new Date().toISOString().slice(0, 10);
  if (!force && prev && prev.hash === hash) return { state: 'ok', changed: false, ...stockStats(prev) };
  const positions = parseStock(rows);
  if (!positions || !positions.length) {
    if (prev) { await env.KV.delete('stock'); catCache = { at: 0, sig: '', items: [] }; }
    return { state: 'none', changed: !!prev };
  }
  const catalog = await allBrandItems(env, cfg);
  let tabError = '';
  const { manual, notes } = manualFixes(matchRows, catalog);
  const res = matchStock(positions, catalog, map, manual);
  const stock = { at: new Date().toISOString(), hash, positions: positions.length, tobaccos: res.tobaccos, items: res.items, unmatched: res.unmatched };
  await env.KV.put('stock', JSON.stringify(stock));
  // Вкладка «Соответствия»: что с чем склеено. Пишем, только когда что-то пересчитали.
  if (env.SHEET_SCRIPT_URL && env.SHEET_SECRET) {
    const byKey = new Map(catalog.map((x) => [x.k, x]));
    const tab = res.pairs.sort((a, b) => a.pos.localeCompare(b.pos, 'ru')).map((p) => {
      const id = p.pos.split('|').map((x) => x.trim()).join('|').toLowerCase();
      const it = byKey.get(p.key);
      return [p.pos, it ? itemLabel(it) + (it.d ? ' — снят с производства' : '') : 'не найдено — в подборе не участвует', notes[id] || p.who, p.w.sort((a, b) => a - b).join(', ')];
    });
    tabError = await sheetScript(env, { action: 'match', rows: tab }).then(() => '', (e) => e.message);
    if (tabError) {
      console.log('match tab', tabError);
      if (/unknown action|не знает действие/i.test(tabError)) tabError = 'в таблице развёрнута старая версия скрипта Google — обновите его (Управление развертываниями → карандаш → Новая версия)';
      await reportProblem(env, 'matchtab', '⚠️ Не получилось записать вкладку «Соответствия»: ' + tabError);
    }
  }
  catCache = { at: 0, sig: '', items: [] };
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(stock.items) && (prev.unmatched || []).length === stock.unmatched.length;
  if (tabError) { stock.tabError = tabError; await env.KV.put('stock', JSON.stringify(stock)); }
  return { state: 'ok', changed: !same, ...stockStats(stock), tabError };
}

/** Прочитать вкладку «Наличие» (через скрипт Google или по открытой ссылке). null — вкладки нет. */
export async function fetchStockRows(env, fetcher = fetch) {
  if (env.SHEET_SCRIPT_URL && env.SHEET_SECRET) {
    const j = await sheetScript(env, { action: 'config', tabs: [STOCK_TAB, MATCH_TAB] }, fetcher);
    const get = (n) => (Array.isArray(j.tabs && j.tabs[n]) ? j.tabs[n].map((r) => r.map((c) => String(c))) : null);
    const rows = get(STOCK_TAB);
    if (rows) rows.match = get(MATCH_TAB);
    return rows;
  }
  return fetcher(sheetUrl(env.CONFIG_SHEET_ID, STOCK_TAB).replace('headers=1', 'headers=0'), { headers: { accept: 'text/csv' } })
    .then((r) => r.text()).then((x) => (/^\s*</.test(x) ? null : parseCSV(x))).catch(() => null);
}
const STOCK_MIN = 20; // меньше — считаем, что с выгрузкой что-то не так, и наличие не применяем
const stockStats = (s) => ({ positions: s.positions, tobaccos: s.tobaccos, flavors: Object.keys(s.items || {}).length,
  unmatched: (s.unmatched || []).length, pending: (s.unmatched || []).filter((u) => !u.tried).length, at: s.at });

export function stockLine(st) {
  if (!st || st.state === 'none') return '📦 Наличие: вкладка «Наличие» пустая или её нет — подбираю из всего справочника.';
  return `📦 Наличие: в выгрузке ${st.positions} позиций, из них наших табаков ${st.tobaccos} → ${st.flavors} вкусов в подборе` +
    (st.unmatched ? `, не распознано ${st.unmatched}` + (st.pending ? ' (разберу с помощью ИИ в течение 15 минут или сразу по команде /stock)' : ' — список по команде /stock') : '') + '.' +
    (st.flavors < STOCK_MIN ? `\n⚠️ Распознано меньше ${STOCK_MIN} вкусов — наличие пока НЕ применяю, подбираю из всего справочника.` : '');
}

/** Нераспознанные позиции отдаём ИИ: по каждому бренду — список со склада и список из справочника. */
export async function resolveStock(env, cfg, rows = null) {
  const stock = await env.KV.get('stock', 'json').catch(() => null);
  const todo = ((stock && stock.unmatched) || []).filter((u) => !u.tried);
  if (!todo.length) return 0;
  const catalog = await allBrandItems(env, cfg);
  const map = (await env.KV.get('stockmap', 'json').catch(() => null)) || {};
  const e = applyBrains(env, cfg);
  const brands = [...new Set(todo.map((u) => u.brand))];
  await Promise.all(brands.map(async (brand) => {
    const cat = catalog.filter((x) => x.b === brand);
    const mine = todo.filter((u) => u.brand === brand).slice(0, 120);
    if (!cat.length) { for (const u of mine) map[u.id] = ''; return; }
    const sys = 'Ты сопоставляешь позиции склада кальянного магазина со справочником табаков бренда ' + brand + '. ' +
      'Для каждой позиции склада найди ТОТ ЖЕ табак в справочнике. Название на складе и в справочнике часто на разных языках: ' +
      'переводи в обе стороны (Honeycomb = Медовые соты, Pine Wood = Сосна / Хвоя, Rye Bread = Ржаной хлеб, Никарагуанский кофе = Nicaragua Coffee), учитывай транслит, сокращения и другое написание; ' +
      'смотри и на название, и на второе название. Линейки тоже пишут по-разному: Classic Line = Классик, Hard Line = Хард, Medium Line = Медиум, Mix Line = Микс — это одна и та же линейка. ' +
      'Крепость линейки должна совпадать: Strong / Hard / Ligero не равно Medium / Classic. Если такого же вкуса в той же линейке в справочнике нет, но он есть в другой линейке той же крепости или линейка в справочнике не указана — бери его. ' +
      'Если этого вкуса в справочнике нет совсем — ставь 0, не подбирай «похожий вкус». ' +
      'Верни ТОЛЬКО JSON: {"номер позиции склада": номер из справочника или 0}.';
    const user = 'СПРАВОЧНИК (номер|линейка|название|второе название):\n' + cat.map((x, i) => `${i + 1}|${x.l}|${x.n}|${x.a}`).join('\n') +
      '\n\nСКЛАД (номер|линейка|название):\n' + mine.map((u, i) => `${i + 1}|${u.line}|${u.flavor}`).join('\n');
    const out = await llmJson(e, sys, user, 4000);
    if (!out) return; // ИИ не ответил — попробуем в следующий раз
    mine.forEach((u, i) => { const it = cat[Number(out[String(i + 1)]) - 1]; map[u.id] = it ? it.k : ''; });
  }));
  await env.KV.put('stockmap', JSON.stringify(map));
  if (rows) await syncStock(env, rows, cfg, true, rows.match);
  return todo.length;
}

/** Ответ на /stock: сводка и список нераспознанного. */
export function stockReport(stock) {
  if (!stock) return stockLine(null);
  const st = { state: 'ok', ...stockStats(stock) };
  let s = stockLine(st) + '\nОбновлено: ' + new Date(stock.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';
  const by = {};
  for (const k of Object.keys(stock.items)) { const b = k.split('/')[0]; by[b] = (by[b] || 0) + 1; }
  if (stock.tabError) s += '\n\n⚠️ Вкладка «Соответствия» не записана: ' + stock.tabError;
  s += '\n\nПо брендам: ' + Object.entries(by).map(([b, n]) => `${b} — ${n}`).join(', ');
  if (stock.unmatched.length) {
    s += '\n\n❓ Не распознано (в подборе не участвуют). Спросить ИИ ещё раз: /stock заново. Посмотреть, что есть в справочнике: /find spectrum honey\n' + stock.unmatched.slice(0, 60).map((u) => `• ${u.brand} ${u.line} — ${u.flavor}`).join('\n') +
      (stock.unmatched.length > 60 ? `\n…и ещё ${stock.unmatched.length - 60}` : '');
  }
  return s;
}
