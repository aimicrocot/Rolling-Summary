import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "Rolling-Summary";
const extensionVersion = "1.0.1";

// Папка на диске задаёт путь к статике, а не название расширения: установка через
// Extensions → Install даёт "Rolling-Summary", а ZIP с GitHub распаковывается в
// "Rolling-Summary-main". Хардкод одного из вариантов ломал загрузку example.html
// у половины пользователей, поэтому берём реальный путь у самого модуля.
const extensionFolderPath = (() => {
    try {
        return new URL(".", import.meta.url).pathname.replace(/\/+$/, "");
    } catch {
        return `scripts/extensions/third-party/${extensionName}`;
    }
})();

// Ключ, под которым память лежит в chat_metadata открытого чата.
const METADATA_KEY = "rollingSummary";

// После неудачного автоскана не долбим API на каждом сообщении, а делаем паузу.
const AUTO_SCAN_COOLDOWN_MS = 120000;

// Предупреждение (не ограничение!) о слишком большом запросе.
const BIG_PROMPT_WARN_TOKENS = 24000;

const defaultSettings = {
    autoScan: false,
    autoHide: false,
    skipCount: 2,
    scanInterval: 1,
    // Лимит самого саммари, в токенах. Токены — не настоящие, а посчитанные по
    // символам через charsPerToken (см. ниже): у разных моделей/языков разное
    // соотношение символ/токен, поэтому коэффициент отдан пользователю.
    summaryTokenLimit: 500,
    charsPerToken: 4,
    // Сколько ждём ответ модели, прежде чем считать запрос зависшим.
    requestTimeoutSec: 120,
    useCustomProvider: false,
    customApiUrl: "",
    customApiKey: "",
    customApiModel: ""
};

let isScanning = false; // одновременно допускаем только один запрос к суммаризатору
let isEditingSummary = false; // перерисовка панели не должна убивать открытый редактор
let pendingCommits = new Map(); // скан асинхронный — если чат сменился, паркуем результат здесь
let activeScanController = null; // позволяет отменить зависший запрос кнопкой Cancel
let autoScanPausedUntil = 0;
let scanTimerId = null;

class ScanCancelledError extends Error {
    constructor() {
        super("Отменено пользователем");
        this.name = "ScanCancelledError";
    }
}

// --- ХЕЛПЕРЫ ---

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getSkipCount() {
    const raw = parseInt(extension_settings[extensionName].skipCount);
    return Number.isFinite(raw) && raw >= 2 ? raw : 2;
}

function getScanInterval() {
    const raw = parseInt(extension_settings[extensionName].scanInterval);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

function getSummaryTokenLimit() {
    const raw = parseInt(extension_settings[extensionName].summaryTokenLimit);
    return Number.isFinite(raw) && raw >= 50 ? raw : 500;
}

function getCharsPerToken() {
    const raw = parseFloat(extension_settings[extensionName].charsPerToken);
    return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

function getRequestTimeoutMs() {
    const raw = parseInt(extension_settings[extensionName].requestTimeoutSec);
    const sec = Number.isFinite(raw) && raw >= 10 ? raw : 120;
    return sec * 1000;
}

function getSummaryCharLimit() {
    return Math.round(getSummaryTokenLimit() * getCharsPerToken());
}

function estimateTokens(text) {
    return Math.ceil(String(text ?? "").length / getCharsPerToken());
}

function getChatArray() {
    const chat = getContext()?.chat;
    return Array.isArray(chat) ? chat : null;
}

function getCurrentChatId() {
    return getContext()?.chatId || null;
}

// Ядро выбрасывает из истории сообщения с is_system (скрытые «призраком») ещё до
// того, как расширение получает управление. И скрытие, и сканирование считают
// границы по этому же набору: иначе призрачные сообщения уезжали бы в
// суммаризатор, а граница «оставить N последних» расходилась бы с промптом.
function getModelVisibleIndices(chat) {
    const indices = [];
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i].is_system) indices.push(i);
    }
    return indices;
}

function getVisibleCount() {
    const chat = getChatArray();
    return chat ? getModelVisibleIndices(chat).length : 0;
}

// Модели-«думалки» иногда оставляют рассуждения прямо в тексте ответа.
function cleanSummaryText(text) {
    return String(text ?? "")
        .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
        .trim();
}

// --- ХРАНИЛИЩЕ ---
// Память живёт в chat_metadata: она лежит внутри файла чата, переживает
// переименование и не путается между персонажами с одинаковым именем чата.
// Глобальные настройки остаются в extension_settings — они не привязаны к чату.

function defaultState() {
    return { summary: "", isHidden: false, lastScanned: 0 };
}

function normalizeState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const lastScanned = Number(source.lastScanned);
    return {
        summary: typeof source.summary === "string" ? source.summary : "",
        isHidden: source.isHidden === true,
        lastScanned: Number.isFinite(lastScanned) && lastScanned > 0 ? Math.floor(lastScanned) : 0
    };
}

// Всегда берём свежий getContext(): chatMetadata — это снимок, а ядро
// переприсваивает chat_metadata при каждой загрузке чата.
function readState() {
    return normalizeState(getContext()?.chatMetadata?.[METADATA_KEY]);
}

function writeState(state) {
    const context = getContext();
    // Без открытого чата chat_metadata — пустой объект-сирота: запись туда никуда
    // не сохранится, зато дёрнет лишнее сохранение чата.
    if (!context?.chatMetadata || !context.chatId) return false;
    // updateChatMetadata делает поверхностный merge верхнего уровня, поэтому
    // объект памяти передаём целиком.
    context.updateChatMetadata({ [METADATA_KEY]: state }, false);
    context.saveMetadataDebounced();
    return true;
}

function patchState(patch) {
    const state = readState();
    Object.assign(state, patch);
    return writeState(state);
}

// Записывает результат в тот чат, для которого он считался.
function commitState(chatId, state) {
    if (chatId && chatId === getCurrentChatId()) return writeState(state);
    if (chatId) pendingCommits.set(chatId, state);
    return false;
}

// Результат скана накладываем на СВЕЖЕЕ состояние чата, а не пишем снимок,
// сделанный до запроса: пока модель думала, пользователь мог нажать Hide/Show,
// и перезапись снимком молча откатила бы это.
function commitScanResult(chatId, scanned, hideNow) {
    if (chatId && chatId === getCurrentChatId()) {
        const fresh = readState();
        fresh.summary = scanned.summary;
        fresh.lastScanned = scanned.lastScanned;
        if (hideNow) fresh.isHidden = true;
        return writeState(fresh);
    }
    if (chatId) {
        if (hideNow) scanned.isHidden = true;
        pendingCommits.set(chatId, scanned);
    }
    return false;
}

function flushPendingCommit() {
    const chatId = getCurrentChatId();
    if (!chatId || !pendingCommits.has(chatId)) return;
    const state = pendingCommits.get(chatId);
    pendingCommits.delete(chatId);
    if (writeState(state)) {
        toastr.info("Результаты сканирования, законченного в другом чате, применены", "Rolling Summary");
    }
}

function getSummary() { return readState().summary; }
function getIsHidden() { return readState().isHidden; }
function getLastScanned() { return readState().lastScanned; }

// --- СКРЫТИЕ ---

// Резать историю можно только когда есть чем её заменить, иначе это чистая потеря
// контекста.
function isHidingActive() {
    return getIsHidden() && getSummary().length > 0;
}

function setPromptInjection(text) {
    // Позиция 1 (IN_CHAT) + глубина 9999: память встаёт в самое начало истории.
    getContext().setExtensionPrompt(extensionName, text, 1, 9999, false, 0);
}

/**
 * Ядро зовёт это через "generate_interceptor" из manifest.json и передаёт СВОЮ копию
 * истории. Настоящий массив chat при этом не трогается вообще: не портится нумерация
 * mesid, стриминг пишет в правильный пузырь, а saveChatConditional по ходу генерации
 * сохраняет чат целиком, а не обрезанный.
 * Функция синхронная и ничего не ждёт: от неё зависит каждая генерация в ST.
 * @param {object[]} coreChat Копия истории, из которой ядро соберёт промпт.
 * @param {number} _contextSize Лимит токенов, посчитанный ядром.
 * @param {function} _abort Позволяет отменить генерацию.
 * @param {string} type Тип генерации: swipe, continue, quiet, impersonate и т.д.
 */
function interceptGeneration(coreChat, _contextSize, _abort, type) {
    try {
        // Тихие генерации — это чужие служебные запросы: встроенный Summarize, /gen,
        // промпт для картинки. Им нужна полная история, обрезать её нельзя.
        if (type === "quiet" || !isHidingActive()) {
            setPromptInjection("");
            return;
        }

        // Для свайпа ядро уже выбросило последнее сообщение из coreChat, поэтому без
        // поправки граница уехала бы на одно сообщение вглубь относительно экрана.
        const effectiveLength = coreChat.length + (type === "swipe" ? 1 : 0);
        const cutCount = Math.min(effectiveLength - getSkipCount(), coreChat.length);
        if (cutCount <= 0) {
            setPromptInjection("");
            return;
        }

        coreChat.splice(0, cutCount);
        // Инъекцию ставим здесь, а не только при перерисовке панели: так в промпт уходит
        // актуальная память, даже если саммари менялся между генерациями.
        setPromptInjection(getSummary());
    } catch (error) {
        // Исключение в интерцепторе не должно ронять чужую генерацию.
        console.error(`[${extensionName}] Interceptor error:`, error);
    }
}

globalThis.rollingSummary_interceptGeneration = interceptGeneration;

function applyVisualHiding() {
    const chat = getChatArray();

    let hiddenIds = new Set();
    if (chat && isHidingActive()) {
        const visible = getModelVisibleIndices(chat);
        const cutCount = visible.length - getSkipCount();
        if (cutCount > 0) hiddenIds = new Set(visible.slice(0, cutCount));
    }

    $("#chat .mes").each(function () {
        const mesId = parseInt($(this).attr("mesid"));
        $(this).toggleClass("rs-hidden", hiddenIds.has(mesId));
    });

    setPromptInjection(hiddenIds.size > 0 ? getSummary() : "");
}

// --- ЗАПРОСЫ К СУММАРИЗАТОРУ ---

/**
 * Запускает асинхронную задачу с жёстким дедлайном и возможностью отмены.
 * Главная причина «зависания» в прежней версии: запрос через основной API
 * (generateRaw) не имел таймаута. Если ответ не приходил, промис висел вечно,
 * isScanning навсегда оставался true, а Scan молча ничего не делал.
 * Здесь внешний промис ГАРАНТИРОВАННО завершается: ответом, ошибкой, таймаутом
 * или отменой — даже если нижележащий запрос так и не вернулся.
 * @param {(signal: AbortSignal) => Promise<any>} taskFactory
 * @param {{timeoutMs: number, cancelSignal?: AbortSignal}} options
 */
function runCancellable(taskFactory, { timeoutMs, cancelSignal }) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timer = null;

        const finish = (settle, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancelSignal?.removeEventListener("abort", onCancel);
            settle(value);
            // При неудаче рвём и сетевой запрос, если он поддерживает signal.
            if (settle === reject) controller.abort();
        };
        const onCancel = () => finish(reject, new ScanCancelledError());

        timer = setTimeout(() => {
            finish(reject, new Error(`Нет ответа от модели за ${Math.round(timeoutMs / 1000)} с`));
        }, timeoutMs);

        if (cancelSignal) {
            if (cancelSignal.aborted) {
                onCancel();
                return;
            }
            cancelSignal.addEventListener("abort", onCancel, { once: true });
        }

        let promise;
        try {
            promise = Promise.resolve(taskFactory(controller.signal));
        } catch (error) {
            finish(reject, error);
            return;
        }
        promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
}

// generateRaw менял сигнатуру: старые версии ST принимают позиционные аргументы,
// новые — объект. Объект, переданный в старую версию, превращался в промпт
// "[object Object]". Новая версия объявлена как (...args), у неё length === 0.
async function callMainApi(promptText, systemPrompt) {
    const context = getContext();
    if (typeof context?.generateRaw !== "function") {
        throw new Error("В этой версии SillyTavern нет generateRaw — обновите SillyTavern");
    }

    // generateRaw не проходит через Generate(), поэтому свой же интерцептор
    // отсюда не вызывается и рекурсии нет.
    if (context.generateRaw.length > 1) {
        return await context.generateRaw(promptText, null, false, false, systemPrompt);
    }
    // Параметр называется systemPrompt — ключ `system` ядро молча игнорирует.
    return await context.generateRaw({
        prompt: promptText,
        quietToLoud: false,
        systemPrompt: systemPrompt
    });
}

async function callSummarizerLLM(promptText, systemPrompt, cancelSignal) {
    const useCustom = extension_settings[extensionName].useCustomProvider;
    return await runCancellable(
        (signal) => useCustom
            ? sendCustomProviderRequest(promptText, systemPrompt, signal)
            : callMainApi(promptText, systemPrompt),
        { timeoutMs: getRequestTimeoutMs(), cancelSignal }
    );
}

async function postJson(endpoint, headers, body, signal) {
    try {
        return await fetch(endpoint, {
            method: "POST",
            headers,
            signal,
            body: JSON.stringify(body)
        });
    } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new Error(
            `Не удалось выполнить запрос к провайдеру (${error?.message ?? error}). ` +
            "Проверьте URL; часть API блокирует запросы прямо из браузера (CORS)."
        );
    }
}

function extractMessageText(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    // Некоторые провайдеры отдают content массивом частей.
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === "string" ? part : part?.text ?? "")).join("");
    }
    return "";
}

async function sendCustomProviderRequest(userPrompt, systemPrompt, signal) {
    const apiUrl = extension_settings[extensionName].customApiUrl;
    const apiKey = extension_settings[extensionName].customApiKey;
    const model = extension_settings[extensionName].customApiModel;

    if (!apiUrl || !model) {
        throw new Error("Custom provider URL or model not configured");
    }

    let endpoint = apiUrl.replace(/\/+$/, "");
    if (!endpoint.endsWith("/chat/completions")) {
        endpoint = /\/v\d+([a-z]*)?$/.test(endpoint) || endpoint.endsWith("/openai")
            ? endpoint + "/chat/completions"
            : endpoint + "/v1/chat/completions";
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const body = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        temperature: 0.3,
        // Небольшой запас: обрыв саммари на полуслове хуже лёгкого перебора.
        max_tokens: Math.ceil(getSummaryTokenLimit() * 1.5)
    };

    let response = await postJson(endpoint, headers, body, signal);

    // Новые модели (o-серия, gpt-5 и т.п.) не принимают max_tokens и temperature.
    // Повторяем один раз в их формате.
    if (!response.ok && (response.status === 400 || response.status === 422)) {
        const errText = await response.text().catch(() => "");
        if (/max_tokens|max_completion_tokens|temperature/i.test(errText)) {
            const retryBody = { ...body };
            delete retryBody.max_tokens;
            delete retryBody.temperature;
            // В max_completion_tokens входят и токены рассуждений — даём запас.
            retryBody.max_completion_tokens = Math.max(body.max_tokens * 4, 4000);
            response = await postJson(endpoint, headers, retryBody, signal);
        } else {
            throw new Error(`Custom provider request failed (${response.status}): ${errText.substring(0, 300)}`);
        }
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`Custom provider request failed (${response.status}): ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    // reasoning_content — это рассуждения модели, а не саммари: раньше они молча
    // подставлялись вместо ответа и записывались в память.
    const content = extractMessageText(choice?.message);
    if (!content.trim()) {
        if (choice?.finish_reason === "length") {
            throw new Error("Пустой ответ: модель исчерпала лимит токенов (reasoning-модели тратят его на рассуждения)");
        }
        throw new Error("Custom provider returned empty response");
    }
    return content;
}

async function testCustomProviderConnection() {
    const button = $("#rs_test_custom_provider");
    button.prop("disabled", true);
    try {
        const result = await runCancellable(
            (signal) => sendCustomProviderRequest(
                "Respond with exactly: CONNECTION_OK",
                "You are a test assistant.",
                signal
            ),
            { timeoutMs: getRequestTimeoutMs() }
        );
        toastr.success(`Соединение работает! Ответ: "${String(result).substring(0, 80)}"`, "Rolling Summary");
    } catch (error) {
        toastr.error(`Ошибка соединения: ${error.message}`, "Rolling Summary", { timeOut: 10000 });
    } finally {
        button.prop("disabled", false);
    }
}

// --- ЛОГИКА СКАНИРОВАНИЯ (rolling summary, не список фактов) ---
// По требованию пользователя — без разбиения на партии: все новые сообщения
// с последнего скана уходят модели одним запросом, каким бы большим он ни был.

function buildMergePrompt(existingSummary, messages, tokenLimit) {
    const numbered = messages
        .map(message => `${message.speaker}: ${message.text}`)
        .join("\n\n");

    return `TASK: You maintain a single running summary of an ongoing roleplay/story for context continuity. Merge the NEW MESSAGES below into the EXISTING SUMMARY, producing one updated summary that replaces it entirely.

Rules:
- Preserve all plot-critical details, character facts, relationships, and unresolved threads from the existing summary unless they are now outdated or contradicted by the new messages.
- Integrate the new events concisely — do not just append, actually merge and re-condense.
- The result MUST fit within approximately ${tokenLimit} tokens (roughly ${Math.round(tokenLimit * getCharsPerToken())} characters). If needed, compress older/less important details to make room for new ones.
- Output plain text only: no markdown, no headers, no lists, no preamble, no explanations — just the updated summary paragraph(s).
- Write in the same language as the messages.

EXISTING SUMMARY:
${existingSummary || "(empty — this is the first summary)"}

NEW MESSAGES:
${numbered}`;
}

/**
 * Сканирует все переданные сообщения одним запросом и перезаписывает state.summary
 * результатом слияния.
 * @returns {Promise<boolean>} true, если модель вернула валидный результат и курсор
 * можно двигать; false, если ответ пуст/некорректен и сканирование нужно прервать.
 */
async function scanMessages(messages, state, cancelSignal) {
    const tokenLimit = getSummaryTokenLimit();
    const promptText = buildMergePrompt(state.summary, messages, tokenLimit);

    // Только предупреждение: лимит на размер запроса сознательно не вводится.
    const promptTokens = estimateTokens(promptText);
    if (promptTokens > BIG_PROMPT_WARN_TOKENS) {
        toastr.warning(
            `Запрос большой (~${promptTokens} токенов). Если модель не вмещает такой контекст, ответ может не прийти.`,
            "Rolling Summary",
            { timeOut: 8000 }
        );
    }

    const response = await callSummarizerLLM(
        promptText,
        "You are a helpful assistant that maintains a single running summary of a story. Always respond with plain text only — the updated summary and nothing else.",
        cancelSignal
    );

    const updated = cleanSummaryText(typeof response === "string" ? response : "");
    if (updated.length > 5) {
        state.summary = updated;
        return true;
    }

    // Пустой/мусорный ответ не должен уничтожать уже накопленный саммари —
    // курсор в этом случае не двигаем.
    toastr.warning("Модель вернула пустой ответ — саммари не обновлён", "Rolling Summary");
    return false;
}

// Индикатор состояния в панели: видно, что запрос идёт, сколько он уже длится,
// и что его можно отменить. Раньше при зависании не было вообще никаких признаков.
function setScanningUi(active, count = 0) {
    clearInterval(scanTimerId);
    scanTimerId = null;

    const button = $("#rs_manual_scan");
    const status = $("#rs_status");

    if (!active) {
        button.val("Scan");
        status.text("");
        return;
    }

    button.val("Cancel");
    const startedAt = Date.now();
    const render = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        status.text(`Идёт запрос (${count} сообщ.)… ${seconds} с. Нажмите Cancel, чтобы отменить.`);
    };
    render();
    scanTimerId = setInterval(render, 1000);
}

function cancelActiveScan() {
    if (!activeScanController) return;
    activeScanController.abort();
}

/**
 * @param {{manual?: boolean}} options manual — запуск кнопкой: тогда о причинах отказа
 * сообщаем тостами, а при ошибке не включаем паузу автоскана.
 */
async function runScan({ manual = false } = {}) {
    if (isScanning) {
        if (manual) toastr.info("Саммаризация уже идёт", "Rolling Summary");
        return;
    }

    // Чат фиксируем один раз: все записи ниже идут по этому id, даже если
    // пользователь переключится в другой чат, пока модель думает.
    const chatId = getCurrentChatId();
    if (!chatId) {
        if (manual) toastr.warning("Open the chat first", "Rolling Summary");
        return;
    }

    const chat = getChatArray();
    if (!chat) return;

    const visible = getModelVisibleIndices(chat);
    const skipCount = getSkipCount();
    if (visible.length <= skipCount) {
        // Молчаливый выход выглядит как сломанная кнопка: пользователь жмёт Scan,
        // и не происходит вообще ничего.
        if (manual) toastr.info(`All ${visible.length} messages are inside the "leave visible" window`, "Rolling Summary");
        return;
    }

    const endIndex = visible.length - skipCount;
    const state = readState();
    const startIndex = Math.max(0, Math.min(state.lastScanned, endIndex));

    const messagesToScan = [];
    for (let position = startIndex; position < endIndex; position++) {
        const message = chat[visible[position]];
        if (!message || !message.mes) continue;
        messagesToScan.push({
            position,
            speaker: message.is_user ? "User" : (message.name || "Character"),
            text: message.mes
        });
    }

    if (messagesToScan.length === 0) {
        if (manual) toastr.info("No new messages to scan", "Rolling Summary");
        // Только вперёд: увеличенный skipCount уменьшает endIndex, и безусловная
        // запись откатила бы курсор, заставив пересканировать уже учтённое.
        if (endIndex > state.lastScanned) {
            state.lastScanned = endIndex;
            commitState(chatId, state);
        }
        return;
    }

    isScanning = true;
    activeScanController = new AbortController();
    setScanningUi(true, messagesToScan.length);
    console.log(`[${extensionName}] Scan started: ${messagesToScan.length} messages, chat ${chatId}`);

    try {
        const ok = await scanMessages(messagesToScan, state, activeScanController.signal);

        if (ok) {
            const scanned = {
                ...state,
                lastScanned: Math.max(state.lastScanned, endIndex)
            };
            const hideNow = Boolean(extension_settings[extensionName].autoHide && scanned.summary.length > 0);
            commitScanResult(chatId, scanned, hideNow);
            toastr.success("Готово!", "Rolling Summary");
        }

        // Пока шёл запрос, пользователь мог уйти в другой чат — тогда панель и подсветка
        // относятся уже не к тому чату, который мы сканировали.
        if (getCurrentChatId() === chatId) refreshUi();
    } catch (error) {
        if (error instanceof ScanCancelledError) {
            console.log(`[${extensionName}] Scan cancelled`);
            toastr.info("Саммаризация отменена", "Rolling Summary");
        } else {
            console.error(`[${extensionName}] Scan error:`, error);
            toastr.error(
                `Ошибка саммаризации: ${error?.message ?? error}`,
                "Rolling Summary",
                { timeOut: 10000 }
            );
            if (!manual) autoScanPausedUntil = Date.now() + AUTO_SCAN_COOLDOWN_MS;
        }
    } finally {
        // Гарантированно снимаем блокировку, что бы ни случилось внутри.
        isScanning = false;
        activeScanController = null;
        setScanningUi(false);
    }
}

async function handleChatEvent() {
    if (!extension_settings[extensionName].autoScan) return;
    if (isScanning || Date.now() < autoScanPausedUntil) return;
    if (!getCurrentChatId() || !getChatArray()) return;

    const endIndex = getVisibleCount() - getSkipCount();
    if (endIndex <= 0) return;

    const lastScanned = Math.max(0, Math.min(getLastScanned(), endIndex));
    if ((endIndex - lastScanned) >= getScanInterval()) {
        await runScan({ manual: false });
    }
}

// --- ПАНЕЛЬ НАСТРОЕК ---

function updateHideButton() {
    const hasMemory = getSummary().length > 0;
    if (!hasMemory) {
        $("#rs_toggle_hide").val("No summary").prop("disabled", true);
    } else {
        $("#rs_toggle_hide").val(getIsHidden() ? "Show" : "Hide").prop("disabled", false);
    }
}

function renderSummaryMeta() {
    const summary = getSummary();
    const limit = getSummaryTokenLimit();
    if (!summary) {
        $("#rs_summary_meta").text(`0 / ~${limit} tokens`).removeClass("rs-over-limit");
        return;
    }
    const tokens = estimateTokens(summary);
    $("#rs_summary_meta").text(`~${tokens} / ~${limit} tokens`);
    $("#rs_summary_meta").toggleClass("rs-over-limit", tokens > limit);
}

// Пока идёт запрос, правка/удаление саммари привели бы к гонке: результат скана
// перезаписал бы то, что пользователь только что поменял.
function guardNotScanning() {
    if (!isScanning) return true;
    toastr.warning("Подождите окончания саммаризации или нажмите Cancel", "Rolling Summary");
    return false;
}

function renderSummary() {
    if (isEditingSummary) return;

    const container = $("#rs_summary_combined");
    const summary = getSummary();

    if (!summary) {
        container.html('<small class="rs-placeholder">Empty...</small>');
        renderSummaryMeta();
        return;
    }

    container.html(`
        <div class="rs-summary-card">
            <div id="rs_summary_text" class="rs-summary-text">${escapeHtml(summary)}</div>
            <div class="rs-summary-actions">
                <i class="fa-solid fa-pen-to-square rs-edit-icon" id="rs_summary_edit_btn" title="Редактировать"></i>
                <i class="fa-solid fa-trash rs-delete-icon" id="rs_summary_delete_btn" title="Удалить"></i>
            </div>
        </div>`);

    renderSummaryMeta();

    $("#rs_summary_delete_btn").on("click", () => {
        if (!guardNotScanning()) return;
        if (!confirm("Delete summary?")) return;
        // Курсор обязан сброситься вместе с саммари: без этого Scan считает всю
        // историю уже учтённой и отвечает «No new messages to scan», хотя памяти нет.
        patchState(defaultState());
        refreshUi();
        toastr.info("Summary deleted", "Rolling Summary");
    });

    $("#rs_summary_edit_btn").on("click", () => {
        if (!guardNotScanning()) return;
        openSummaryEditor();
    });
}

// prompt() не годится для абзаца на пару тысяч символов: часть браузеров режет
// текст, и вся правка происходит в одну строку без переносов.
function openSummaryEditor() {
    const container = $("#rs_summary_combined");
    isEditingSummary = true;

    container.html(`
        <textarea id="rs_summary_editor" class="text_bg rs-summary-editor" rows="10"></textarea>
        <div class="rs-editor-meta" id="rs_editor_meta"></div>
        <div class="rs-editor-actions">
            <input id="rs_summary_save" class="menu_button" type="button" value="Save" />
            <input id="rs_summary_cancel" class="menu_button" type="button" value="Cancel" />
        </div>`);

    $("#rs_summary_editor").val(getSummary());

    const updateEditorMeta = () => {
        const tokens = estimateTokens(String($("#rs_summary_editor").val() ?? ""));
        const limit = getSummaryTokenLimit();
        $("#rs_editor_meta").text(`~${tokens} / ~${limit} tokens`).toggleClass("rs-over-limit", tokens > limit);
    };
    updateEditorMeta();
    $("#rs_summary_editor").on("input", updateEditorMeta);

    $("#rs_summary_cancel").on("click", () => {
        isEditingSummary = false;
        renderSummary();
    });

    $("#rs_summary_save").on("click", () => {
        const edited = String($("#rs_summary_editor").val() ?? "").trim();
        isEditingSummary = false;
        if (edited === "") {
            renderSummary();
            return;
        }
        patchState({ summary: edited });
        refreshUi();
        toastr.success("Summary updated", "Rolling Summary");
    });
}

function refreshUi() {
    renderSummary();
    applyVisualHiding();
    updateHideButton();
}

function updateMaxSkip() {
    $("#rs_skip_count").attr("max", Math.max(2, getVisibleCount()));
}

// Удаление сообщений может увести курсор за конец чата — тогда следующий скан решит,
// что сканировать нечего, и новые сообщения молча выпадут из памяти.
function clampScanCursor() {
    if (!getCurrentChatId() || !getChatArray()) return;
    const visibleCount = getVisibleCount();
    if (getLastScanned() > visibleCount) patchState({ lastScanned: visibleCount });
}

// --- ИНИЦИАЛИЗАЦИЯ ---

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const settings = extension_settings[extensionName];

    // Поключевое слияние: старые установки расширения не пересоздаются с нуля,
    // но получают недостающие поля новых версий.
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = (value && typeof value === "object") ? structuredClone(value) : value;
        }
    }

    $("#rs_auto_scan").prop("checked", settings.autoScan);
    $("#rs_auto_hide").prop("checked", settings.autoHide);
    $("#rs_skip_count").val(getSkipCount());
    $("#rs_scan_interval").val(getScanInterval());
    $("#rs_summary_token_limit").val(getSummaryTokenLimit());
    $("#rs_chars_per_token").val(getCharsPerToken());
    $("#rs_request_timeout").val(Math.round(getRequestTimeoutMs() / 1000));
    $("#rs_use_custom_provider").prop("checked", settings.useCustomProvider);
    $("#rs_custom_api_url").val(settings.customApiUrl);
    $("#rs_custom_api_key").val(settings.customApiKey);
    $("#rs_custom_api_model").val(settings.customApiModel);
    $("#rs_custom_provider_panel").css("display", settings.useCustomProvider ? "block" : "none");

    $("#rs_scan_interval").prop("disabled", !settings.autoScan);
    $("#rs_scan_interval_row").css("display", settings.autoScan ? "flex" : "none");

    updateMaxSkip();
    refreshUi();
}

// Пустое поле ввода — это промежуточное состояние набора, а не «поставь минимум».
// Раньше очистка поля молча писала в настройки минимум, и UI расходился со стейтом.
function bindNumberSetting(selector, key, minimum, { isFloat = false, onChange } = {}) {
    $(selector).on("input", (e) => {
        const text = String($(e.target).val() ?? "").trim();
        if (text === "") return;
        const raw = isFloat ? parseFloat(text) : parseInt(text);
        if (!Number.isFinite(raw) || raw < minimum) return;
        extension_settings[extensionName][key] = raw;
        saveSettingsDebounced();
        if (onChange) onChange();
    });

    // Ушли из поля с мусором — возвращаем то, что реально лежит в настройках.
    $(selector).on("blur", () => {
        $(selector).val(extension_settings[extensionName][key]);
    });
}

function bindSettingsHandlers() {
    $("#rs_auto_scan").on("input", (e) => {
        const checked = Boolean($(e.target).prop("checked"));
        extension_settings[extensionName].autoScan = checked;
        saveSettingsDebounced();
        $("#rs_scan_interval").prop("disabled", !checked);
        $("#rs_scan_interval_row").css("display", checked ? "flex" : "none");
        // Включили автоскан руками — снимаем паузу после прошлых ошибок.
        if (checked) autoScanPausedUntil = 0;
    });

    $("#rs_auto_hide").on("input", (e) => {
        extension_settings[extensionName].autoHide = Boolean($(e.target).prop("checked"));
        saveSettingsDebounced();
    });

    bindNumberSetting("#rs_skip_count", "skipCount", 2, { onChange: applyVisualHiding });
    bindNumberSetting("#rs_scan_interval", "scanInterval", 1);
    bindNumberSetting("#rs_summary_token_limit", "summaryTokenLimit", 50, { onChange: () => { renderSummaryMeta(); } });
    bindNumberSetting("#rs_chars_per_token", "charsPerToken", 1, { isFloat: true, onChange: () => { renderSummaryMeta(); } });
    bindNumberSetting("#rs_request_timeout", "requestTimeoutSec", 10);

    $("#rs_use_custom_provider").on("input", (e) => {
        const checked = Boolean($(e.target).prop("checked"));
        extension_settings[extensionName].useCustomProvider = checked;
        saveSettingsDebounced();
        $("#rs_custom_provider_panel").css("display", checked ? "block" : "none");
    });

    $("#rs_custom_api_url").on("input", (e) => {
        extension_settings[extensionName].customApiUrl = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#rs_custom_api_key").on("input", (e) => {
        extension_settings[extensionName].customApiKey = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#rs_custom_api_model").on("input", (e) => {
        extension_settings[extensionName].customApiModel = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#rs_test_custom_provider").on("click", testCustomProviderConnection);

    // Пока идёт запрос, эта же кнопка работает как Cancel.
    $("#rs_manual_scan").on("click", () => {
        if (isScanning) {
            cancelActiveScan();
            return;
        }
        runScan({ manual: true });
    });

    $("#rs_clear_summary").on("click", () => {
        if (!guardNotScanning()) return;
        if (!confirm("Очистить саммари?")) return;
        isEditingSummary = false;
        patchState(defaultState());
        refreshUi();
    });

    $("#rs_toggle_hide").on("click", () => {
        if (getSummary().length === 0) return;
        patchState({ isHidden: !getIsHidden() });
        applyVisualHiding();
        updateHideButton();
    });
}

function bindChatEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        isEditingSummary = false;
        flushPendingCommit();
        clampScanCursor();
        updateMaxSkip();
        refreshUi();
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        updateMaxSkip();
        refreshUi();
        // Не блокируем пайплайн ST: он ждёт этот обработчик перед сохранением чата.
        // Небольшая задержка — чтобы фоновый запрос не стартовал посреди финализации
        // сообщения (сохранение чата, события других расширений).
        setTimeout(() => {
            handleChatEvent().catch(err => console.error(`[${extensionName}] Auto-scan failed:`, err));
        }, 500);
    });

    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateMaxSkip();
        refreshUi();
    });

    eventSource.on(event_types.MESSAGE_DELETED, () => {
        clampScanCursor();
        updateMaxSkip();
        refreshUi();
    });

    eventSource.on(event_types.MESSAGE_SWIPED, () => refreshUi());
    eventSource.on(event_types.MESSAGE_UPDATED, () => refreshUi());
    // Подгрузка старых сообщений добавляет в DOM элементы без класса скрытия.
    eventSource.on(event_types.MORE_MESSAGES_LOADED, applyVisualHiding);
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
        $("#extensions_settings2").append(settingsHtml);

        bindSettingsHandlers();
        loadSettings();
        bindChatEvents();

        // Отладочный API для проверки сценариев из консоли DevTools.
        window.RollingSummary = {
            version: extensionVersion,
            folderPath: extensionFolderPath,
            get settings() { return extension_settings[extensionName]; },
            get state() { return readState(); },
            get isScanning() { return isScanning; },
            get pendingCommits() { return pendingCommits; },
            getCurrentChatId, getChatArray, getVisibleCount,
            readState, writeState, patchState, commitState, flushPendingCommit,
            getSummary, getIsHidden, getLastScanned,
            isHidingActive, getModelVisibleIndices,
            getSkipCount, getScanInterval, getSummaryTokenLimit, getCharsPerToken,
            getSummaryCharLimit, estimateTokens,
            escapeHtml, buildMergePrompt,
            clampScanCursor,
            interceptGeneration, applyVisualHiding, setPromptInjection,
            refreshUi, renderSummary, renderSummaryMeta, updateHideButton, loadSettings,
            runScan, cancelActiveScan, scanMessages, handleChatEvent,
            callSummarizerLLM, callMainApi, sendCustomProviderRequest, testCustomProviderConnection
        };

        console.log(`[${extensionName}] ✅ Loaded (v${extensionVersion}) from ${extensionFolderPath}. Debug API: window.RollingSummary`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Load failed:`, error);
        // Молчаливый провал выглядел как «расширение просто не появилось в списке».
        if (typeof toastr !== "undefined") {
            toastr.error(`Не удалось загрузить панель настроек из ${extensionFolderPath}: ${error?.message ?? error}`, "Rolling Summary");
        }
    }
});
