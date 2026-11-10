/**
 * Миксолог — Telegram-бот на Cloudflare Workers.
 *
 * Клиент пишет в свободной форме, что любит и как крепко курит →
 * ИИ разбирает запрос → код отбирает подходящие табаки из справочника →
 * ИИ собирает 3 микса: один «в яблочко» и два запасных. Кнопка «Ещё варианты».
 *
 * Справочник собирается с htreviews.org по брендам из BRANDS и лежит в KV.
 * Обновление: по расписанию раз в неделю или вручную через /refresh?key=...
 *
 * Секреты:  BOT_TOKEN, WEBHOOK_SECRET, LLM_API_KEY (только для внешних мозгов)
 * Биндинги: KV (хранилище), AI (Workers AI)
 * Настройки (wrangler.toml [vars]): LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL,
 *           BRANDS, IMAGES, IMAGE_MODEL, SHOP_URL
 */

/* ───────────────────────── Тексты ─────────────────────────
 * Все фразы бота на двух языках: ru — русский, hy — армянский.
 * Меняются сразу после деплоя. <b>жирный</b>, <i>курсив</i>, \n — перенос строки.
 */
const T = {
  ru: {
    hello:
      'Привет! Я <b>Sigma Mix</b>, твой карманный кальянщик 💨\n\n' +
      'Напиши что нравится: <i>«хочу ягодное с кислинкой»</i>, <i>«люблю Deus»</i>, <i>«чтобы освежало, но не мята»</i>.\n\n' +
      'Подберу 3 микса с пропорциями и описанием.\n' +
      'Понравилось - бери табачок у нас в VektorSIGMA 🛒\n\n' +
      '<i>Строго 18+</i>',
    langSet: 'Отлично, общаемся по-русски 🇷🇺\nНапиши, что тебе нравится, — подберу миксы.',
    askStrength: 'Понял по вкусам. А как крепко куришь?',
    strength: ['🌿 Лёгко', '⚖️ Средне', '🔥 Крепко', 'Без разницы'],
    notRelevant: 'Я подбираю кальянные миксы. Напиши, какие вкусы и табаки тебе нравятся и как крепко куришь.',
    notText: 'Напиши текстом, что любишь курить, — подберу миксы.',
    error: 'Что-то пошло не так. Попробуй ещё раз через минуту.',
    restart: 'Давай заново. Напиши, чего хочется сейчас.',
    expired: 'Запрос уже устарел. Напиши заново, что хочется покурить.',
    tellFirst: 'Сначала расскажи, что любишь.',
    noCatalog: 'Справочник табаков ещё не загружен. Загляни чуть позже.',
    picking: '🔎 Подбираю миксы…',
    pickingMore: '🔄 Думаю над другими вариантами…',
    tooFew: 'Под такой запрос у нас почти ничего нет. Попробуй описать пошире или убрать ограничения.',
    failed: 'Не получилось собрать миксы. Нажми «Ещё варианты» или перефразируй запрос.',
    more: '🔄 Ещё варианты',
    newReq: '✏️ Новый запрос',
    mixOf: (i, n) => `Микс ${i} из ${n}`,
    best: 'лучшее попадание',
    strengthLabel: 'Крепость: ',
    footer: '🛒 Покажи этот список в магазине — соберём.',
    mixWord: 'Микс',
    llmLang: 'русском',
    llmStrength: 'лёгкая, средняя или крепкая',
  },
  hy: {
    hello:
      'Բարև՛։ Ես <b>Sigma Mix</b>-ն եմ՝ քո գրպանի կալյանի վարպետը 💨\n\n' +
      'Գրիր, թե ինչ է քեզ դուր գալիս՝ <i>«ուզում եմ հատապտղային՝ թթվաշությամբ»</i>, <i>«սիրում եմ Deus»</i>, <i>«որ թարմացնի, բայց ոչ անանուխ»</i>։\n\n' +
      'Կընտրեմ 3 միքս՝ համամասնություններով և նկարագրությամբ։\n' +
      'Հավանեցի՞ր՝ ծխախոտը գնիր մեզ մոտ՝ VektorSIGMA-ում 🛒\n\n' +
      '<i>Խիստ 18+</i>',
    langSet: 'Հիանալի՛, խոսում ենք հայերեն 🇦🇲\nԳրիր, թե ինչ է քեզ դուր գալիս, և ես միքսեր կընտրեմ։',
    askStrength: 'Հասկացա համերը։ Իսկ որքա՞ն թունդ ես ծխում։',
    strength: ['🌿 Թեթև', '⚖️ Միջին', '🔥 Թունդ', 'Միևնույն է'],
    notRelevant: 'Ես կալյանի միքսեր եմ ընտրում։ Գրիր, թե որ համերն ու ծխախոտներն են քեզ դուր գալիս և որքան թունդ ես ծխում։',
    notText: 'Տեքստով գրիր, թե ինչ ես սիրում ծխել, և ես միքսեր կընտրեմ։',
    error: 'Ինչ-որ բան սխալ գնաց։ Փորձիր նորից մեկ րոպեից։',
    restart: 'Եկ նորից սկսենք։ Գրիր, թե հիմա ինչ ես ուզում։',
    expired: 'Հարցումն արդեն հնացել է։ Նորից գրիր, թե ինչ ես ուզում ծխել։',
    tellFirst: 'Նախ պատմիր, թե ինչ ես սիրում։',
    noCatalog: 'Ծխախոտների տեղեկատուն դեռ բեռնված չէ։ Մի փոքր ուշ նայիր։',
    picking: '🔎 Միքսեր եմ ընտրում…',
    pickingMore: '🔄 Մտածում եմ այլ տարբերակների մասին…',
    tooFew: 'Այս հարցման համար մեզ մոտ գրեթե ոչինչ չկա։ Փորձիր ավելի լայն նկարագրել կամ հանել սահմանափակումները։',
    failed: 'Չստացվեց միքսեր կազմել։ Սեղմիր «Այլ տարբերակներ» կամ վերաձևակերպիր հարցումը։',
    more: '🔄 Այլ տարբերակներ',
    newReq: '✏️ Նոր հարցում',
    mixOf: (i, n) => `Միքս ${i}՝ ${n}-ից`,
    best: 'լավագույն համընկնում',
    strengthLabel: 'Թնդություն՝ ',
    footer: '🛒 Ցույց տուր այս ցուցակը խանութում, և մենք կհավաքենք։',
    mixWord: 'Միքս',
    llmLang: 'армянском (восточноармянский литературный, армянским алфавитом)',
    llmStrength: 'թեթև, միջին կամ թունդ',
  },
};
const LANG_SEPARATOR = '\n\n————————————\n\n';
const LANG_PROMPT = '\n\nВыбери язык 👇 Ընտրիր լեզուն 👇';

// Тексты профиля бота. После правки открыть /setup?key=... — Telegram обновит их.
// Описание — на пустом экране до «Старт» (до 512 символов). hy увидят те, у кого Telegram на армянском.
const BOT_DESCRIPTION = {
  ru: 'Не знаешь, что покурить?\nПодберу микс под твой вкус 💨',
  hy: 'Չգիտե՞ս՝ ինչ ծխել։\nԿընտրեմ միքս քո ճաշակով 💨',
};
// Короткое «О боте» — в профиле и при пересылке ссылки (до 120 символов).
const BOT_ABOUT = {
  ru: 'Подбираю кальянные миксы под твой вкус из табаков VektorSIGMA 💨 18+',
  hy: 'Ընտրում եմ կալյանի միքսեր քո ճաշակով՝ VektorSIGMA-ի ծխախոտներից 💨 18+',
};

const SOURCE = 'https://htreviews.org';
const PAGE = 20; // сайт сам грузит по 20, большие порции отдают неполный список
const STRENGTH = { 'лёгкая': 1, 'легкая': 1, 'средне-лёгкая': 2, 'средне-легкая': 2, 'средняя': 3, 'средне-крепкая': 4, 'крепкая': 5 };
const STRENGTH_NAME = ['', 'лёгкая', 'средне-лёгкая', 'средняя', 'средне-крепкая', 'крепкая'];
const HELPER_GROUPS = ['Освежающий', 'Цитрусовый'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhook' && request.method === 'POST') return await onWebhook(request, env);
      if (url.pathname === '/setup') return await onSetup(url, env);
      if (url.pathname === '/refresh') return await onRefresh(url, env);
      return new Response('ok');
    } catch (e) {
      console.log('fatal', e && e.stack || e);
      return new Response('ok'); // Telegram не должен повторять запрос из-за нашей ошибки
    }
  },

  // Понедельник 03:00–07:50 UTC, каждые 10 минут — по одному бренду за запуск
  // (на бесплатном плане лимит 50 внешних запросов на запуск).
  async scheduled(event, env, ctx) {
    const brands = brandList(env);
    const t = new Date(event.scheduledTime);
    const i = (t.getUTCHours() - 3) * 6 + Math.floor(t.getUTCMinutes() / 10);
    if (brands[i]) ctx.waitUntil(crawlBrand(env, brands[i]).catch((e) => console.log('crawl', brands[i], e.message)));
  },
};

/* ───────────────────────── Telegram ───────────────────────── */

async function onWebhook(request, env) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json();

  // Telegram повторяет доставку, если мы долго думаем, — не обрабатываем дважды.
  const seenKey = 'upd:' + update.update_id;
  if (await env.KV.get(seenKey)) return new Response('ok');
  await env.KV.put(seenKey, '1', { expirationTtl: 600 });

  try {
    if (update.callback_query) await onCallback(env, update.callback_query);
    else if (update.message && update.message.text) await onText(env, update.message);
    else if (update.message) await send(env, update.message.chat.id, T[await getLang(env, update.message.chat.id)].notText);
  } catch (e) {
    console.log('handler', e && e.stack || e);
    const chat = (update.message || (update.callback_query && update.callback_query.message) || {}).chat;
    if (chat) await send(env, chat.id, T[await getLang(env, chat.id)].error);
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

async function onText(env, msg) {
  const chat = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, T.ru.hello + LANG_SEPARATOR + T.hy.hello + LANG_PROMPT, langKeyboard());
  }
  if (cmd === '/language' || cmd === '/lang') {
    return send(env, chat, 'Выбери язык 👇\nԸնտրիր լեզուն 👇', langKeyboard());
  }
  if (cmd === '/new') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, T[await getLang(env, chat)].restart);
  }

  // Пишет на другом языке — переключаемся на него.
  let lang = await getLang(env, chat);
  const detected = detectLang(text);
  if (detected && detected !== lang) { lang = detected; await setLang(env, chat, lang); }
  const t = T[lang];

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
    return send(env, chat, t.askStrength, strengthKeyboard(lang));
  }
  if (prefs.strength === 'unknown') prefs.strength = 'any';
  await makeMixes(env, chat, { text: request, prefs, used: [], titles: [] }, false, lang);
}

async function onCallback(env, cq) {
  const chat = cq.message.chat.id;
  const data = cq.data || '';
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });

  if (data.startsWith('lang:')) {
    const lang = data.slice(5) === 'hy' ? 'hy' : 'ru';
    await setLang(env, chat, lang);
    return send(env, chat, T[lang].langSet);
  }

  const lang = await getLang(env, chat);
  const t = T[lang];
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

function strengthKeyboard(lang) {
  const s = T[lang].strength;
  return { inline_keyboard: [[
    { text: s[0], callback_data: 'str:light' },
    { text: s[1], callback_data: 'str:medium' },
    { text: s[2], callback_data: 'str:strong' },
  ], [{ text: s[3], callback_data: 'str:any' }]] };
}

function resultKeyboard(lang) {
  return { inline_keyboard: [[
    { text: T[lang].more, callback_data: 'more' },
    { text: T[lang].newReq, callback_data: 'new' },
  ]] };
}

/* ───────────────────────── Подбор миксов ───────────────────────── */

async function makeMixes(env, chat, session, more = false, lang = 'ru') {
  const t = T[lang];
  const catalog = await loadCatalog(env);
  if (!catalog.length) return send(env, chat, t.noCatalog);

  await send(env, chat, more ? t.pickingMore : t.picking);
  await action(env, chat, 'typing');

  const candidates = pickCandidates(catalog, session.prefs, session.used || [], more);
  if (candidates.length < 4) return send(env, chat, t.tooFew, resultKeyboard(lang));

  let result = await composeMixes(env, session, candidates, lang);
  if (!result.length) result = await composeMixes(env, session, candidates, lang); // одна повторная попытка
  if (!result.length) return send(env, chat, t.failed, resultKeyboard(lang));

  session.stage = 'done';
  session.used = [...(session.used || []), ...result.flatMap((m) => m.parts.map((p) => p.item.k))].slice(-80);
  session.titles = [...(session.titles || []), ...result.map((m) => m.title)].slice(-15);
  await putSession(env, chat, session);

  // Каждый микс — отдельным сообщением. Первый — с картинкой, у последнего — подвал и кнопки.
  const blocks = result.map((m, i) => renderMix(m, i, lang, result.length));
  const footer = '\n\n' + t.footer + (env.SHOP_URL ? ' ' + env.SHOP_URL : '');
  blocks[blocks.length - 1] += footer;

  let photo = null;
  if ((env.IMAGES || 'on') === 'on') {
    await action(env, chat, 'upload_photo');
    const prompt = imagePrompt(result[0], result.garnish, env.IMAGE_TEXT || 'full');
    photo = await makeImage(env, prompt).catch((e) => (console.log('image', e.message), null));
    // Основная модель не ответила — пробуем простую запасную, без текста.
    if (!photo && !(env.IMAGE_MODEL || '').includes('flux-1')) {
      photo = await makeImage({ ...env, IMAGE_MODEL: '@cf/black-forest-labs/flux-1-schnell' }, imagePrompt(result[0], result.garnish, 'none'))
        .catch((e) => (console.log('image fallback', e.message), null));
    }
  }
  for (let i = 0; i < blocks.length; i++) {
    const kb = i === blocks.length - 1 ? resultKeyboard(lang) : undefined;
    if (i === 0 && photo && blocks[0].length <= 1000) await sendPhoto(env, chat, photo, blocks[0], kb);
    else await send(env, chat, blocks[i], kb);
  }
}

/** Шаг 1. ИИ превращает свободный текст в структуру предпочтений. */
async function extractPrefs(env, text) {
  const catalog = await loadCatalog(env);
  const brands = [...new Set(catalog.map((x) => x.b))];
  const groups = [...new Set(catalog.flatMap((x) => x.g))];
  const system =
    'Ты разбираешь запрос клиента кальянного магазина. Верни ТОЛЬКО JSON без пояснений:\n' +
    '{"relevant":true,"like":[],"avoid":[],"groups":[],"flavors":[],"brands":[],"strength":"light|medium|strong|any|unknown"}\n' +
    'Клиент может писать по-русски или по-армянски. Поля like и avoid ВСЕГДА заполняй по-русски, переводя с армянского.\n' +
    '- relevant: false, если сообщение вообще не про кальян, табак или вкусы.\n' +
    '- like: вкусы, которые человек хочет, по одному слову в именительном падеже ("Малина", "Лайм", "Мята").\n' +
    '  Если назвал только настроение ("свежее", "десертное") — подбери 3–6 подходящих вкусов сам.\n' +
    '- avoid: вкусы, которых человек не хочет, в том же виде.\n' +
    '- groups: подходящие направления строго из списка: ' + (groups.join(', ') || 'Фруктовый, Ягодный, Цитрусовый, Освежающий, Десертный') + '.\n' +
    '- flavors: названия конкретных табаков, которые человек упомянул, в оригинальном написании ("Supernova", "Pinkman").\n' +
    '- brands: бренды, которые человек любит, строго из списка: ' + (brands.join(', ') || '—') + '.\n' +
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
export function pickCandidates(catalog, prefs, used = [], more = false) {
  const like = prefs.like.map(stem), avoid = prefs.avoid.map(stem);
  const flavors = prefs.flavors.map(norm), brands = prefs.brands.map(norm);
  const usedSet = new Set(used);
  const jitter = more ? 1.5 : 0.5;

  const okStrength = (s) => {
    if (!s || prefs.strength === 'any' || prefs.strength === 'unknown') return true;
    if (prefs.strength === 'light') return s <= 2;
    if (prefs.strength === 'medium') return s >= 2 && s <= 4;
    return s >= 3;
  };

  const scored = [];
  for (const it of catalog) {
    if (!okStrength(it.s)) continue;
    const tagStems = it.t.map(stem);
    const nameWords = norm(it.n + ' ' + it.a).split(/[^a-zа-я0-9]+/).filter(Boolean).map(stem);
    if (avoid.some((a) => tagStems.includes(a) || nameWords.includes(a))) continue;

    let score = 0;
    for (const l of like) {
      if (tagStems.includes(l)) score += 3;
      else if (nameWords.includes(l)) score += 2;
    }
    score += it.g.filter((g) => prefs.groups.includes(g)).length;
    const nm = norm(it.n);
    if (flavors.some((f) => f.length > 2 && (nm.includes(f) || f.includes(nm)))) score += 4;
    if (brands.includes(norm(it.b))) score += 1.5;
    const base = score;
    if (it.c >= 5) score += (it.r - 3.5) * 0.8;
    if (usedSet.has(it.k)) score -= 3;
    score += Math.random() * jitter;
    scored.push({ it, score, base });
  }

  const main = scored.filter((x) => x.base > 0).sort((a, b) => b.score - a.score).slice(0, 45);
  const chosen = new Set(main.map((x) => x.it.k));
  // «Помощники»: свежесть и цитрус с хорошим рейтингом — ими удобно доводить микс.
  const helpers = scored
    .filter((x) => !chosen.has(x.it.k) && x.it.c >= 5 && x.it.g.some((g) => HELPER_GROUPS.includes(g)))
    .sort((a, b) => b.it.r - a.it.r + (b.score - a.score) * 0.1)
    .slice(0, 12);
  return [...main, ...helpers].map((x) => x.it);
}

/** Шаг 3. ИИ собирает три микса из кандидатов. */
async function composeMixes(env, session, candidates, lang = 'ru') {
  const t = T[lang];
  const lines = candidates.map((it, i) =>
    `${i + 1}|${it.b}${it.l && it.l !== 'Основная' ? ' ' + it.l : ''} — ${it.n}${it.a ? ' (' + it.a + ')' : ''}|` +
    `${STRENGTH_NAME[it.s] || '?'}|${it.c >= 3 ? it.r : '-'}|${it.t.join(', ')}`);
  const want = { light: 'лёгкая', medium: 'средняя', strong: 'крепкая' }[session.prefs.strength] || 'любая';
  const system =
    'Ты опытный кальянный мастер магазина. Собери 3 микса под запрос клиента ТОЛЬКО из табаков списка.\n' +
    'Формат строки списка: номер|табак|крепость|рейтинг|вкусы.\n' +
    'Правила:\n' +
    '- Первый микс — максимально точное попадание в запрос. Второй и третий — альтернативы с другим характером.\n' +
    '- В миксе 2–4 табака, доли кратны 5, в сумме ровно 100. Один табак — не больше чем в двух миксах.\n' +
    '- Учитывай желаемую крепость и не бери вкусы, которых клиент просил избегать.\n' +
    '- title — короткое цепляющее название микса, 2–4 слова.\n' +
    '- text — ОДНО сочное предложение на «ты», до 20 слов: что чувствуется на вдохе и что на выдохе. ' +
    'Конкретные вкусы, без воды вроде «гармоничный опыт», «идеально сочетает», «погрузись в мир». Без обещаний про здоровье.\n' +
    '- strength — итоговая крепость микса одним словом: ' + t.llmStrength + '.\n' +
    '- title, text и strength пиши на ' + t.llmLang + ' языке. Названия брендов и табаков в текст не переводи.\n' +
    '- Для картинки, только в ПЕРВОМ миксе, у каждого табака добавь "look" НА АНГЛИЙСКОМ: густой глянцевый соус цвета этого вкуса, ' +
    '3–6 слов, например "glossy deep purple blackberry syrup", "creamy white vanilla cream", "bright orange mango puree".\n' +
    '- garnish — НА АНГЛИЙСКОМ свежие ингредиенты первого микса для декора вокруг, 3–5 штук через запятую, например "fresh blackberries, blueberries, lemon wedges, mint leaves". ' +
    'Только еда и напитки: без людей, кальянов и сигарет.\n' +
    'Верни ТОЛЬКО JSON: {"mixes":[{"title":"","parts":[{"n":1,"p":50,"look":""}],"text":"","strength":""}],"garnish":""}';
  const user =
    'Запрос клиента: ' + session.text + '\n' +
    'Желаемая крепость: ' + want + '\n' +
    (session.titles && session.titles.length ? 'Уже предлагали, не повторяй: ' + session.titles.join('; ') + '\n' : '') +
    '\nТабаки в наличии:\n' + lines.join('\n');
  const out = await llmJson(env, system, user, 1200);
  const mixes = validateMixes(out, candidates);
  mixes.garnish = out && typeof out.garnish === 'string' ? out.garnish.slice(0, 200) : '';
  return mixes;
}

/** Проверяем ответ ИИ: номера существуют, доли сходятся в 100. */
export function validateMixes(out, candidates) {
  const res = [];
  for (const m of (out && Array.isArray(out.mixes) ? out.mixes : []).slice(0, 3)) {
    const seen = new Set();
    let parts = (Array.isArray(m.parts) ? m.parts : [])
      .map((p) => ({ item: candidates[Number(p.n) - 1], p: Number(p.p), look: typeof p.look === 'string' ? p.look.slice(0, 80) : '' }))
      .filter((p) => p.item && p.p > 0 && !seen.has(p.item.k) && seen.add(p.item.k))
      .slice(0, 4);
    if (parts.length < 2) continue;
    const sum = parts.reduce((a, p) => a + p.p, 0);
    parts = parts.map((p) => ({ item: p.item, look: p.look, p: Math.max(5, Math.round((p.p / sum) * 20) * 5) }));
    parts.sort((a, b) => b.p - a.p);
    parts[0].p += 100 - parts.reduce((a, p) => a + p.p, 0); // остаток — в основной табак
    if (parts[0].p <= 0) continue;
    parts.sort((a, b) => b.p - a.p);
    res.push({
      title: String(m.title || 'Микс').slice(0, 60),
      text: String(m.text || '').slice(0, 500),
      strength: String(m.strength || '').slice(0, 20),
      parts,
    });
  }
  return res;
}

/**
 * Карточка микса:
 *   Микс 1 из 3 · лучшее попадание
 *   ПЕЧЕНЬЕ С АРБУЗОМ И МЯТОЙ
 *   ┃ Kraken Strong Ligero · Cookie — 50%      ← цитата Telegram (серая плашка)
 *   Описание одной фразой.
 *   Крепость: средняя
 */
export function renderMix(m, i, lang = 'ru', total = 3) {
  const t = T[lang];
  const label = t.mixOf(i + 1, total) + (i === 0 ? ' · ' + t.best : '');
  const parts = m.parts.map((p) => {
    const it = p.item;
    const line = it.l && it.l !== 'Основная' ? ' ' + it.l : '';
    // Русское название показываем, только если оно добавляет смысл (2+ слова), а не просто перевод.
    const alt = it.a && /[а-яё]/i.test(it.a) && !/[а-яё]/i.test(it.n) && it.a.trim().split(/\s+/).length > 1 ? ' (' + esc(it.a) + ')' : '';
    return `${esc(it.b + line)} · <b>${esc(it.n)}</b>${alt} — ${p.p}%`;
  });
  return (
    `<i>${esc(label)}</i>\n` +
    `<b>${esc(m.title.toLocaleUpperCase(lang === 'hy' ? 'hy' : 'ru'))}</b>\n\n` +
    `<blockquote>${parts.join('\n')}</blockquote>\n` +
    (m.text ? esc(m.text) + '\n' : '') +
    (m.strength ? '\n' + t.strengthLabel + esc(m.strength) : '')
  ).trim();
}

/* ───────────────────────── Мозги (сменные) ───────────────────────── */

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

/* ───────────────────────── Картинка ─────────────────────────
 * Стиль — как карточки «SIGMA MIX» на vektorsigma.am/weekly_mix:
 * светлый фон с серой геометрией, логотип SIGMA MIX сверху, в центре круг-«инь-ян»
 * из глянцевых соусов цвета каждого вкуса, подписи с долями, свежие ингредиенты по краям.
 * IMAGE_TEXT: full — логотип и подписи с долями; logo — только логотип; none — без текста.
 */
export function imagePrompt(mix, garnish, textMode = 'full') {
  const parts = mix.parts.slice(0, 4);
  const n = parts.length;
  const words = ['', '', 'two', 'three', 'four'][n] || String(n);
  const sauces = parts.map((p, i) => `segment ${i + 1}: ${p.look || 'a glossy colorful fruit sauce'}`).join('; ');
  const where = ['upper left', 'upper right', 'bottom', 'lower left'];
  const labels = parts.map((p, i) =>
    `at the ${where[i]} of the circle the label "${latin(p.item.n).toUpperCase()}" with "${latin(p.item.b).toUpperCase()}" in bold below it and a large thin "${p.p}%"`).join('; ');

  let text = '';
  if (textMode === 'full' || textMode === 'logo') {
    text = 'At the top center, a modern logo: the word "SIGMA" in thin black sans-serif capitals, directly below it the word "MIX" in heavy bold black sans-serif capitals. ';
  }
  if (textMode === 'full') {
    text += `Around the circle, clean minimal uppercase sans-serif labels in dark grey connected with thin dashed lines: ${labels}. All text sharp, correctly spelled, no other text. `;
  } else {
    text += textMode === 'none' ? 'No text, no letters, no logos anywhere. ' : 'No other text. ';
  }

  return (
    'Square premium advertising poster for a flavor mix, top-down view, light off-white studio background ' +
    'with subtle minimal light-grey geometric decorations: thin outline circles, small solid triangles, plus signs, dashed lines and diagonal hatching. ' +
    text +
    `In the center, a perfect round swirl made of ${words} thick glossy liquid sauces flowing into each other like a yin-yang, ` +
    `with clear borders between colors, realistic shiny reflections and one small drip at the bottom edge — ${sauces}. ` +
    (garnish ? `Fresh ingredients scattered around the edges of the frame, partially cropped: ${garnish}. ` : '') +
    'High-end commercial food photography, soft natural shadows, vibrant saturated colors, crisp focus, clean balanced composition, lots of white space. ' +
    'No people, no hands, no hookah, no cigarettes, no smoke.'
  );
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

/* ───────────────────────── Справочник ───────────────────────── */

function brandList(env) {
  return (env.BRANDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

let cache = { at: 0, items: [] };

async function loadCatalog(env) {
  if (cache.items.length && Date.now() - cache.at < 10 * 60 * 1000) return cache.items;
  const parts = await Promise.all(brandList(env).map((b) => env.KV.get('cat:' + b, 'json')));
  let items = parts.flatMap((p) => (p && p.items) || []);
  // Наличие: когда появится выгрузка склада, в KV кладётся ключ stock — список ключей табаков.
  const stock = await env.KV.get('stock', 'json');
  if (Array.isArray(stock) && stock.length) {
    const set = new Set(stock);
    items = items.filter((x) => set.has(x.k));
  }
  cache = { at: Date.now(), items };
  return items;
}

/** Забирает все вкусы одного бренда и кладёт в KV. */
export async function crawlBrand(env, slug, fetcher = fetch) {
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; VektorSigmaMixBot/1.0)', accept: 'text/html,application/json' };
  const page = await fetcher(`${SOURCE}/tobaccos/${slug}`, { headers });
  if (!page.ok) throw new Error(`${slug}: страница бренда вернула ${page.status}`);
  const html = await page.text();
  const tag = (html.match(/<[^>]*object_wrapper[^>]*>/) || [''])[0];
  const id = (tag.match(/data-id="(\d+)"/) || [])[1];
  if (!id) throw new Error(`${slug}: не нашёл номер бренда на странице`);

  const raw = [];
  for (let offset = 0; offset < 900; ) { // до 45 запросов — в пределах лимита запуска
    const r = await fetcher(`${SOURCE}/postData`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'objectByBrand', data: { id, limit: PAGE, offset, sort: { s: 'rating', d: 'desc' } } }),
    });
    if (!r.ok) throw new Error(`${slug}: список вернул ${r.status} на позиции ${offset}`);
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
  cache = { at: 0, items: [] };
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

/* ───────────────────────── Служебные страницы ───────────────────────── */

async function onSetup(url, env) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const r = await tg(env, 'setWebhook', {
    url: url.origin + '/webhook', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'],
  });
  // Меню команд: по умолчанию русское, для Telegram на армянском — армянское.
  await tg(env, 'setMyCommands', { commands: [
    { command: 'start', description: 'Подобрать микс' },
    { command: 'new', description: 'Новый запрос' },
    { command: 'language', description: 'Сменить язык / Փոխել լեզուն' },
  ] });
  await tg(env, 'setMyCommands', { language_code: 'hy', commands: [
    { command: 'start', description: 'Ընտրել միքս' },
    { command: 'new', description: 'Նոր հարցում' },
    { command: 'language', description: 'Փոխել լեզուն / Сменить язык' },
  ] });
  const d = await tg(env, 'setMyDescription', { description: BOT_DESCRIPTION.ru });
  const a = await tg(env, 'setMyShortDescription', { short_description: BOT_ABOUT.ru });
  await tg(env, 'setMyDescription', { language_code: 'hy', description: BOT_DESCRIPTION.hy });
  await tg(env, 'setMyShortDescription', { language_code: 'hy', short_description: BOT_ABOUT.hy });
  return Response.json({ webhook: r, description: d, about: a });
}

/** /refresh?key=… — страница, которая по очереди обновляет все бренды. /refresh?key=…&brand=slug — один бренд. */
async function onRefresh(url, env) {
  if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const brand = url.searchParams.get('brand');
  if (brand) {
    if (!brandList(env).includes(brand)) return Response.json({ ok: false, error: 'бренда нет в BRANDS' });
    try { return Response.json({ ok: true, ...(await crawlBrand(env, brand)) }); }
    catch (e) { return Response.json({ ok: false, error: e.message }); }
  }
  const brands = brandList(env);
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

/* ───────────────────────── Мелочи ───────────────────────── */

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
/** Грубая основа слова, чтобы «малиновый» находил «Малина». */
export const stem = (s) => { const n = norm(s); return n.length > 5 ? n.slice(0, 5) : n; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getSession(env, chat) { return env.KV.get('s:' + chat, 'json'); }
async function putSession(env, chat, s) { return env.KV.put('s:' + chat, JSON.stringify(s), { expirationTtl: 6 * 3600 }); }

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.log('tg', method, JSON.stringify(j).slice(0, 300));
  return j;
}
const send = (env, chat, text, reply_markup) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
const action = (env, chat, a) => tg(env, 'sendChatAction', { chat_id: chat, action: a });

async function sendPhoto(env, chat, bytes, caption, reply_markup) {
  const form = new FormData();
  form.append('chat_id', String(chat));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'mix.jpg');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.log('tg sendPhoto', JSON.stringify(j).slice(0, 300)); await send(env, chat, caption, reply_markup); }
}
