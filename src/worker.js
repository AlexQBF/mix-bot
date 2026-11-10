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

// Тексты профиля бота. После правки открыть /setup?key=... — Telegram обновит их.
// Описание — на пустом экране до «Старт» (до 512 символов).
const BOT_DESCRIPTION =
  'Привет! Я Sigma Mix, твой карманный кальянщик 💨\n' +
  'Напиши что нравится: «хочу ягодное с кислинкой», «люблю Supernova», «чтобы освежало, но не мята».\n' +
  'Подберу 3 микса с пропорциями и описанием.\n' +
  'Понравилось - бери табачок у нас в VektorSIGMA 🛒\n\n' +
  '🔞 Строго 18+';
// Короткое «О боте» — в профиле и при пересылке ссылки (до 120 символов).
const BOT_ABOUT = 'Подбираю кальянные миксы под твой вкус из табаков VektorSIGMA 💨 18+';

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

  // Понедельник 03:00–03:50 UTC, каждые 10 минут — по одному бренду за запуск
  // (на бесплатном плане лимит 50 внешних запросов на запуск).
  async scheduled(event, env, ctx) {
    const brands = brandList(env);
    const i = Math.floor(new Date(event.scheduledTime).getUTCMinutes() / 10);
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
    else if (update.message) await send(env, update.message.chat.id, 'Напиши текстом, что любишь курить, — подберу миксы.');
  } catch (e) {
    console.log('handler', e && e.stack || e);
    const chat = (update.message || (update.callback_query && update.callback_query.message) || {}).chat;
    if (chat) await send(env, chat.id, 'Что-то пошло не так. Попробуй ещё раз через минуту.');
  }
  return new Response('ok');
}

const HELLO =
  '💨 <b>Не знаешь, что покурить?</b>\n\n' +
  'Напиши в свободной форме, что тебе нравится: вкусы, бренды, конкретные табаки, ' +
  'какое направление хочется (свежее, сладкое, кислое, десертное…) и как крепко куришь.\n\n' +
  'Например: <i>«люблю ягодное с кислинкой, заходит Supernova, курю средне, без мяты»</i>\n\n' +
  'Соберу микс в яблочко и пару запасных из того, что есть у нас.\n\n' +
  '<i>Бот только для совершеннолетних, 18+.</i>';

async function onText(env, msg) {
  const chat = msg.chat.id;
  const text = msg.text.trim();
  if (text === '/start' || text === '/help' || text === '/new') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, HELLO);
  }

  let session = await getSession(env, chat);
  let request = text;
  let force = false;
  if (session && session.stage === 'ask_strength') {
    request = session.text + '\n' + text; // ответ на уточняющий вопрос
    force = true;
  }
  await action(env, chat, 'typing');
  const prefs = await extractPrefs(env, request);
  if (!prefs.relevant) {
    return send(env, chat, 'Я подбираю кальянные миксы. Напиши, какие вкусы и табаки тебе нравятся и как крепко куришь.');
  }
  if (prefs.strength === 'unknown' && !force) {
    await putSession(env, chat, { stage: 'ask_strength', text: request, prefs });
    return send(env, chat, 'Понял по вкусам. А как крепко куришь?', strengthKeyboard());
  }
  if (prefs.strength === 'unknown') prefs.strength = 'any';
  await makeMixes(env, chat, { text: request, prefs, used: [], titles: [] });
}

async function onCallback(env, cq) {
  const chat = cq.message.chat.id;
  const data = cq.data || '';
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const session = await getSession(env, chat);

  if (data === 'new') {
    await env.KV.delete('s:' + chat);
    return send(env, chat, 'Давай заново. Напиши, чего хочется сейчас.');
  }
  if (!session) return send(env, chat, 'Запрос уже устарел. Напиши заново, что хочется покурить.');

  if (data.startsWith('str:')) {
    session.prefs.strength = data.slice(4);
    return makeMixes(env, chat, { text: session.text, prefs: session.prefs, used: [], titles: [] });
  }
  if (data === 'more') {
    if (!session.prefs || session.stage === 'ask_strength') return send(env, chat, 'Сначала расскажи, что любишь.');
    return makeMixes(env, chat, session, true);
  }
}

function strengthKeyboard() {
  return { inline_keyboard: [[
    { text: '🌿 Лёгко', callback_data: 'str:light' },
    { text: '⚖️ Средне', callback_data: 'str:medium' },
    { text: '🔥 Крепко', callback_data: 'str:strong' },
  ], [{ text: 'Без разницы', callback_data: 'str:any' }]] };
}

function resultKeyboard() {
  return { inline_keyboard: [[
    { text: '🔄 Ещё варианты', callback_data: 'more' },
    { text: '✏️ Новый запрос', callback_data: 'new' },
  ]] };
}

/* ───────────────────────── Подбор миксов ───────────────────────── */

async function makeMixes(env, chat, session, more = false) {
  const catalog = await loadCatalog(env);
  if (!catalog.length) return send(env, chat, 'Справочник табаков ещё не загружен. Загляни чуть позже.');

  await send(env, chat, more ? '🔄 Думаю над другими вариантами…' : '🔎 Подбираю миксы…');
  await action(env, chat, 'typing');

  const candidates = pickCandidates(catalog, session.prefs, session.used || [], more);
  if (candidates.length < 4) {
    return send(env, chat, 'Под такой запрос у нас почти ничего нет. Попробуй описать пошире или убрать ограничения.', resultKeyboard());
  }

  let result = await composeMixes(env, session, candidates);
  if (!result.length) result = await composeMixes(env, session, candidates); // одна повторная попытка
  if (!result.length) return send(env, chat, 'Не получилось собрать миксы. Нажми «Ещё варианты» или перефразируй запрос.', resultKeyboard());

  session.stage = 'done';
  session.used = [...(session.used || []), ...result.flatMap((m) => m.parts.map((p) => p.item.k))].slice(-80);
  session.titles = [...(session.titles || []), ...result.map((m) => m.title)].slice(-15);
  await putSession(env, chat, session);

  const blocks = result.map((m, i) => renderMix(m, i));
  const footer = '\n\n🛒 Покажи этот список в магазине — соберём.' + (env.SHOP_URL ? ' ' + env.SHOP_URL : '');

  let photo = null;
  if ((env.IMAGES || 'on') === 'on' && result.imagePrompt) {
    await action(env, chat, 'upload_photo');
    photo = await makeImage(env, result.imagePrompt).catch((e) => (console.log('image', e.message), null));
  }
  if (photo && blocks[0].length <= 1000) {
    await sendPhoto(env, chat, photo, blocks[0]);
    await send(env, chat, blocks.slice(1).join('\n\n') + footer, resultKeyboard());
  } else {
    await send(env, chat, blocks.join('\n\n') + footer, resultKeyboard());
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
async function composeMixes(env, session, candidates) {
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
    '- title — короткое цепляющее название микса по-русски. text — 2–3 вкусных предложения на «ты»: что чувствуется на вдохе и выдохе, почему это подойдёт. Без обещаний про здоровье.\n' +
    '- strength — итоговая крепость микса одним словом: лёгкий, средний или крепкий.\n' +
    '- image — описание картинки для первого микса НА АНГЛИЙСКОМ: натюрморт из ингредиентов вкуса на тёмном фоне, без текста, людей и курительных принадлежностей.\n' +
    'Верни ТОЛЬКО JSON: {"mixes":[{"title":"","parts":[{"n":1,"p":50}],"text":"","strength":""}],"image":""}';
  const user =
    'Запрос клиента: ' + session.text + '\n' +
    'Желаемая крепость: ' + want + '\n' +
    (session.titles && session.titles.length ? 'Уже предлагали, не повторяй: ' + session.titles.join('; ') + '\n' : '') +
    '\nТабаки в наличии:\n' + lines.join('\n');
  const out = await llmJson(env, system, user, 1200);
  const mixes = validateMixes(out, candidates);
  mixes.imagePrompt = out && typeof out.image === 'string' ? out.image.slice(0, 400) : '';
  return mixes;
}

/** Проверяем ответ ИИ: номера существуют, доли сходятся в 100. */
export function validateMixes(out, candidates) {
  const res = [];
  for (const m of (out && Array.isArray(out.mixes) ? out.mixes : []).slice(0, 3)) {
    const seen = new Set();
    let parts = (Array.isArray(m.parts) ? m.parts : [])
      .map((p) => ({ item: candidates[Number(p.n) - 1], p: Number(p.p) }))
      .filter((p) => p.item && p.p > 0 && !seen.has(p.item.k) && seen.add(p.item.k))
      .slice(0, 4);
    if (parts.length < 2) continue;
    const sum = parts.reduce((a, p) => a + p.p, 0);
    parts = parts.map((p) => ({ item: p.item, p: Math.max(5, Math.round((p.p / sum) * 20) * 5) }));
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

export function renderMix(m, i) {
  const head = ['🎯 <b>В яблочко — «' + esc(m.title) + '»</b>', '🥈 <b>Запасной — «' + esc(m.title) + '»</b>', '🥉 <b>Ещё вариант — «' + esc(m.title) + '»</b>'][i];
  const parts = m.parts.map((p) => {
    const it = p.item;
    const line = it.l && it.l !== 'Основная' ? ' ' + it.l : '';
    return `▫️ ${p.p}% · ${esc(it.b + line)} — <b>${esc(it.n)}</b>${it.a ? ' (' + esc(it.a) + ')' : ''}`;
  });
  return head + '\n' + parts.join('\n') + (m.text ? '\n<i>' + esc(m.text) + '</i>' : '') + (m.strength ? '\n💪 Крепость: ' + esc(m.strength) : '');
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

async function makeImage(env, prompt) {
  const model = env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const r = await env.AI.run(model, { prompt: prompt + ', dark moody background, studio food photography, no text', steps: 4 });
  if (r && typeof r.image === 'string') return Uint8Array.from(atob(r.image), (c) => c.charCodeAt(0));
  if (r instanceof ReadableStream) return new Uint8Array(await new Response(r).arrayBuffer());
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r instanceof Uint8Array) return r;
  return null;
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
    await new Promise((res) => setTimeout(res, 250)); // не долбим сайт
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
  await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Подобрать микс' }, { command: 'new', description: 'Новый запрос' }] });
  const d = await tg(env, 'setMyDescription', { description: BOT_DESCRIPTION });
  const a = await tg(env, 'setMyShortDescription', { short_description: BOT_ABOUT });
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

async function sendPhoto(env, chat, bytes, caption) {
  const form = new FormData();
  form.append('chat_id', String(chat));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'mix.jpg');
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.log('tg sendPhoto', JSON.stringify(j).slice(0, 300)); await send(env, chat, caption); }
}
