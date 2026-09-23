import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "Summary-Tracker";
const extensionVersion = "1.3.0";

// Папка на диске задаёт путь к статике, а не название расширения: установка через
// Extensions → Install даёт "Summary-Tracker", а ZIP с GitHub распаковывается в
// "Summary-Tracker-main". Хардкод одного из вариантов ломал загрузку example.html
// у половины пользователей, поэтому берём реальный путь у самого модуля.
const extensionFolderPath = (() => {
    try {
        return new URL(".", import.meta.url).pathname.replace(/\/+$/, "");
    } catch {
        return `scripts/extensions/third-party/${extensionName}`;
    }
})();

// Ключ, под которым память лежит в chat_metadata открытого чата.
const METADATA_KEY = "summaryTracker";

// Одна партия скана: и по числу сообщений, и по объёму, потому что двадцать
// коротких реплик и двадцать длинных постов — это разные промпты.
const SCAN_CHUNK_MESSAGES = 20;
const SCAN_CHUNK_CHARS = 24000;
// Порог сжатия по объёму нужен в дополнение к «сжимать после N фактов»: один
// fallback-факт на всю партию считается за единицу и иначе рос бы бесконечно.
const COMPRESS_CHARS = 8000;
const CUSTOM_REQUEST_TIMEOUT_MS = 60000;

const defaultSettings = {
    autoScan: false,
    autoHide: false,
    skipCount: 2,
    scanInterval: 1,
    compressAfter: 20,
    useCustomProvider: false,
    customApiUrl: "",
    customApiKey: "",
    customApiModel: "",
    // Словари ниже — формат до 1.3.0. Живут только до миграции чата в chat_metadata.
    isHiddenByChatId: {},
    factsByChatId: {},
    lastScannedByChatId: {},
    layerSummaryByChatId: {}
};

let isScanning = false; // одновременно допускаем только один запрос к суммаризатору
let isEditingSummary = false; // перерисовка панели не должна убивать открытый редактор
let pendingLegacyHidden = null; // глобальный isHidden из версий до 1.2 ждёт открытия чата

// Скан асинхронный: пока модель думает, пользователь может уйти в другой чат.
// chat_metadata к этому моменту принадлежит уже другому чату, писать туда нельзя,
// поэтому результат паркуется здесь и применяется при возвращении.
const pendingCommits = new Map();

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

function getCompressAfter() {
    const raw = parseInt(extension_settings[extensionName].compressAfter);
    return Number.isFinite(raw) && raw >= 2 ? raw : 20;
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

// --- ХРАНИЛИЩЕ ---
// Память живёт в chat_metadata: она лежит внутри файла чата, переживает
// переименование и не путается между персонажами с одинаковым именем чата.
// Глобальные настройки остаются в extension_settings — они не привязаны к чату.

function defaultState() {
    return { facts: [], layerSummary: "", isHidden: false, lastScanned: 0 };
}

function normalizeState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const lastScanned = Number(source.lastScanned);
    return {
        facts: Array.isArray(source.facts) ? source.facts.filter(f => typeof f === "string") : [],
        layerSummary: typeof source.layerSummary === "string" ? source.layerSummary : "",
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

function flushPendingCommit() {
    const chatId = getCurrentChatId();
    if (!chatId || !pendingCommits.has(chatId)) return;
    const state = pendingCommits.get(chatId);
    pendingCommits.delete(chatId);
    if (writeState(state)) {
        toastr.info("Результаты сканирования, законченного в другом чате, применены", "Summary Tracker");
    }
}

function getFacts() { return readState().facts; }
function getLayerSummary() { return readState().layerSummary; }
function getIsHidden() { return readState().isHidden; }
function getLastScanned() { return readState().lastScanned; }

function buildContextFromState(state) {
    const parts = [];
    if (state.layerSummary) parts.push(state.layerSummary);
    if (state.facts.length > 0) parts.push(state.facts.join(" "));
    return parts.join(" ");
}

function buildFullContext() {
    return buildContextFromState(readState());
}

// --- МИГРАЦИЯ СО СТАРОГО ФОРМАТА ---

// До 1.2 флаг скрытия был один на всё расширение. Применяем его к первому
// открытому чату: в loadSettings чат ещё не открыт и запись просто пропала бы.
function migrateLegacyHidden() {
    if (pendingLegacyHidden === null) return;
    const chatId = getCurrentChatId();
    if (!chatId) return;
    if (pendingLegacyHidden === true) {
        extension_settings[extensionName].isHiddenByChatId[chatId] = true;
    }
    pendingLegacyHidden = null;
    saveSettingsDebounced();
}

// Старый курсор считался по сырым индексам chat, новый — по позиции среди
// видимых модели сообщений. Без пересчёта первый же скан после обновления
// уехал бы мимо непрочитанных сообщений.
function rawIndexToVisiblePosition(rawIndex) {
    const chat = getChatArray();
    if (!chat || !Number.isFinite(rawIndex) || rawIndex <= 0) return 0;
    const limit = Math.min(rawIndex, chat.length);
    let count = 0;
    for (let i = 0; i < limit; i++) {
        if (!chat[i].is_system) count++;
    }
    return count;
}

function migrateChatFromSettings() {
    const chatId = getCurrentChatId();
    const context = getContext();
    if (!chatId || !context?.chatMetadata) return;
    if (context.chatMetadata[METADATA_KEY]) return;

    const settings = extension_settings[extensionName];
    const facts = settings.factsByChatId?.[chatId];
    const layerSummary = settings.layerSummaryByChatId?.[chatId];
    const isHidden = settings.isHiddenByChatId?.[chatId];
    const lastScanned = settings.lastScannedByChatId?.[chatId];

    const hasData = (Array.isArray(facts) && facts.length > 0)
        || Boolean(layerSummary)
        || isHidden === true
        || Number(lastScanned) > 0;
    if (!hasData) return;

    const migrated = normalizeState({
        facts,
        layerSummary,
        isHidden,
        lastScanned: rawIndexToVisiblePosition(Number(lastScanned))
    });
    if (!writeState(migrated)) return;

    delete settings.factsByChatId[chatId];
    delete settings.layerSummaryByChatId[chatId];
    delete settings.isHiddenByChatId[chatId];
    delete settings.lastScannedByChatId[chatId];
    saveSettingsDebounced();
    console.log(`[${extensionName}] Migrated chat "${chatId}" into chat_metadata`);
}

// Переименование чата меняет chatId, а вместе с ним и ключ в старых словарях.
// Сама память уже в chat_metadata и переезжает вместе с файлом, но у тех, кто
// ещё не открывал чат после обновления, данные лежат в settings.
function handleChatRenamed(payload) {
    const settings = extension_settings[extensionName];
    const stripExtension = name => String(name ?? "").replace(/\.jsonl$/i, "");
    const oldKey = stripExtension(payload?.oldFileName);
    const newKey = stripExtension(payload?.newFileName);
    if (!oldKey || !newKey || oldKey === newKey) return;

    const maps = [
        settings.factsByChatId,
        settings.layerSummaryByChatId,
        settings.isHiddenByChatId,
        settings.lastScannedByChatId
    ];
    let moved = false;
    for (const map of maps) {
        if (map[oldKey] === undefined) continue;
        map[newKey] = map[oldKey];
        delete map[oldKey];
        moved = true;
    }
    if (moved) saveSettingsDebounced();
}

// Осколки старого формата от чатов, которые больше не откроют. Записи без фактов
// и без сжатого саммари бесполезны — выкидываем, чтобы settings.json не пух.
function pruneEmptyChats() {
    const settings = extension_settings[extensionName];
    const maps = [
        settings.factsByChatId,
        settings.layerSummaryByChatId,
        settings.isHiddenByChatId,
        settings.lastScannedByChatId
    ];
    const currentChatId = getCurrentChatId();
    const keys = new Set(maps.flatMap(map => Object.keys(map)));

    for (const key of keys) {
        if (key === currentChatId) continue;
        const hasFacts = Array.isArray(settings.factsByChatId[key]) && settings.factsByChatId[key].length > 0;
        const hasLayer = Boolean(settings.layerSummaryByChatId[key]);
        if (hasFacts || hasLayer) continue;
        for (const map of maps) delete map[key];
    }
}

// --- ЗАПРОСЫ К СУММАРИЗАТОРУ ---

async function callSummarizerLLM(promptText, systemPrompt) {
    if (!extension_settings[extensionName].useCustomProvider) {
        // Параметр называется systemPrompt — ключ `system` ядро молча игнорирует.
        // generateRaw не проходит через Generate(), поэтому свой же интерцептор
        // отсюда не вызывается и рекурсии нет.
        return await getContext().generateRaw({
            prompt: promptText,
            quietToLoud: false,
            systemPrompt: systemPrompt
        });
    }
    return await sendCustomProviderRequest(promptText, systemPrompt);
}

async function sendCustomProviderRequest(userPrompt, systemPrompt) {
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

    // Без таймаута зависший провайдер оставлял бы isScanning навсегда взведённым:
    // finally не отрабатывает, и автоскан молча умирал до перезагрузки страницы.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CUSTOM_REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.3,
                max_tokens: 2048
            })
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(`Custom provider timed out after ${CUSTOM_REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`Custom provider request failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    // Reasoning-модели кладут текст в reasoning_content, оставляя content пустым.
    const content = message?.content || message?.reasoning_content;
    if (!content) throw new Error("Custom provider returned empty response");
    return content;
}

async function testCustomProviderConnection() {
    try {
        const result = await sendCustomProviderRequest(
            "Respond with exactly: CONNECTION_OK",
            "You are a test assistant."
        );
        toastr.success(`Соединение работает! Ответ: "${result.substring(0, 80)}"`, "Summary Tracker");
    } catch (error) {
        toastr.error(`Ошибка соединения: ${error.message}`, "Summary Tracker");
    }
}

function shouldCompressFacts(facts) {
    if (facts.length >= getCompressAfter()) return true;
    return facts.reduce((sum, fact) => sum + fact.length, 0) >= COMPRESS_CHARS;
}

async function maybeCompressFacts(state) {
    if (!shouldCompressFacts(state.facts)) return;

    const promptText = `TASK: Compress the following list of facts into a single concise paragraph that preserves all key story details for context continuity. Do not use markdown, headers, or lists — output plain text only, one paragraph. Write in the same language as the input.\n\nEXISTING COMPRESSED SUMMARY (merge with this, do not repeat, keep or update as needed):\n${state.layerSummary || "(none yet)"}\n\nNEW FACTS TO COMPRESS:\n${state.facts.join("\n")}`;

    toastr.info(`Сжатие ${state.facts.length} фактов в единый саммари...`, "Summary Tracker");

    try {
        const response = await callSummarizerLLM(
            promptText,
            "You are a helpful assistant. Compress the facts into a single concise paragraph. Output only plain text, no markdown, no lists, no headers."
        );

        const compressed = typeof response === "string" ? response.trim() : "";
        if (compressed.length > 10) {
            state.layerSummary = compressed;
            state.facts = [];
            toastr.success("Саммари сжат!", "Summary Tracker");
        } else {
            // Пустой ответ не должен уничтожать накопленные факты.
            console.warn(`[${extensionName}] Compression returned too short a result, facts kept`);
        }
    } catch (error) {
        console.error(`[${extensionName}] Compression error:`, error);
        toastr.error("Ошибка сжатия", "Summary Tracker");
    }
}

// --- СКРЫТИЕ ---

// Резать историю можно только когда есть чем её заменить, иначе это чистая потеря
// контекста.
function isHidingActive() {
    return getIsHidden() && buildFullContext().length > 0;
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
 * @param {object[]} coreChat Копия истории, из которой ядро соберёт промпт.
 * @param {number} _contextSize Лимит токенов, посчитанный ядром.
 * @param {function} _abort Позволяет отменить генерацию.
 * @param {string} type Тип генерации: swipe, continue, quiet, impersonate и т.д.
 */
function interceptGeneration(coreChat, _contextSize, _abort, type) {
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
    // актуальная память, даже если факты меняли между генерациями.
    setPromptInjection(buildFullContext());
}

globalThis.summaryTracker_interceptGeneration = interceptGeneration;

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
        $(this).toggleClass("fmt-hidden", hiddenIds.has(mesId));
    });

    setPromptInjection(hiddenIds.size > 0 ? buildFullContext() : "");
}

// --- ПАНЕЛЬ НАСТРОЕК ---

function updateHideButton() {
    const hasMemory = buildFullContext().length > 0;
    if (!hasMemory) {
        $("#fmt_toggle_hide").val("No facts").prop("disabled", true);
    } else {
        $("#fmt_toggle_hide").val(getIsHidden() ? "Show" : "Hide").prop("disabled", false);
    }
}

function renderFactsCount() {
    const count = getFacts().length;
    // Счётчик показывал только несжатые факты, из-за чего сразу после сжатия
    // выглядел как «памяти нет», хотя кнопка Hide оставалась активной.
    $("#fmt_facts_count").text(getLayerSummary() ? `${count} (+ compressed summary)` : String(count));
}

function renderSummary() {
    if (isEditingSummary) return;

    const container = $("#fmt_summary_combined");
    const combinedText = buildFullContext();

    if (!combinedText) {
        container.html('<small class="fmt-placeholder">Empty...</small>');
        return;
    }

    container.html(`
        <div class="fmt-summary-card">
            <div id="fmt_summary_text" class="fmt-summary-text">${escapeHtml(combinedText)}</div>
            <div class="fmt-summary-actions">
                <i class="fa-solid fa-pen-to-square fmt-edit-icon" id="fmt_summary_edit_btn" title="Редактировать"></i>
                <i class="fa-solid fa-trash fmt-delete-icon" id="fmt_summary_delete_btn" title="Удалить"></i>
            </div>
        </div>`);

    $("#fmt_summary_delete_btn").on("click", () => {
        if (!confirm("Delete summary?")) return;
        // Курсор обязан сброситься вместе с фактами: без этого Scan считает всю
        // историю уже учтённой и отвечает «No new messages to scan», хотя памяти нет.
        patchState(defaultState());
        refreshUi();
        toastr.info("Summary deleted", "Summary Tracker");
    });

    $("#fmt_summary_edit_btn").on("click", openSummaryEditor);
}

// prompt() не годится для абзаца на пару тысяч символов: часть браузеров режет
// текст, и вся правка происходит в одну строку без переносов.
function openSummaryEditor() {
    const container = $("#fmt_summary_combined");
    isEditingSummary = true;

    container.html(`
        <textarea id="fmt_summary_editor" class="text_bg fmt-summary-editor" rows="10"></textarea>
        <div class="fmt-editor-actions">
            <input id="fmt_summary_save" class="menu_button" type="button" value="Save" />
            <input id="fmt_summary_cancel" class="menu_button" type="button" value="Cancel" />
        </div>`);

    $("#fmt_summary_editor").val(buildFullContext());

    $("#fmt_summary_cancel").on("click", () => {
        isEditingSummary = false;
        renderSummary();
    });

    $("#fmt_summary_save").on("click", () => {
        const edited = String($("#fmt_summary_editor").val() ?? "").trim();
        isEditingSummary = false;
        if (edited === "") {
            renderSummary();
            return;
        }
        // Ручная правка схлопывает всю память в один сжатый слой: разложить
        // отредактированный текст обратно на отдельные факты невозможно.
        patchState({ layerSummary: edited, facts: [] });
        refreshUi();
        toastr.success("Summary updated", "Summary Tracker");
    });
}

function refreshUi() {
    renderFactsCount();
    renderSummary();
    applyVisualHiding();
    updateHideButton();
}

function updateMaxSkip() {
    $("#fmt_skip_count").attr("max", Math.max(2, getVisibleCount()));
}

// Удаление сообщений может увести курсор за конец чата — тогда следующий скан решит,
// что сканировать нечего, и новые сообщения молча выпадут из памяти.
function clampScanCursor() {
    if (!getCurrentChatId() || !getChatArray()) return;
    const visibleCount = getVisibleCount();
    if (getLastScanned() > visibleCount) patchState({ lastScanned: visibleCount });
}

// --- ЛОГИКА СКАНИРОВАНИЯ ---

/**
 * Возвращает массив элементов саммари или null, если ответ разобрать не удалось.
 */
function parseBatchResponse(response) {
    if (typeof response !== "string" || response.trim() === "") {
        console.error(`[${extensionName}] Batch response is empty or not a string:`, response);
        return null;
    }

    let clean = response.replace(/```json|```/g, "").trim();
    // Модель часто добавляет текст до/после массива — вырезаем сам массив.
    const first = clean.indexOf("[");
    const last = clean.lastIndexOf("]");
    if (first !== -1 && last > first) {
        clean = clean.slice(first, last + 1);
    }

    let parsed;
    try {
        parsed = JSON.parse(clean);
    } catch (e) {
        console.error(`[${extensionName}] Failed to parse batch response:`, e, response);
        return null;
    }

    if (Array.isArray(parsed)) return parsed;
    // Иногда приходит одиночный объект вместо массива.
    if (parsed && typeof parsed === "object" && typeof parsed.summary === "string") return [parsed];

    console.error(`[${extensionName}] Batch response is not an array:`, parsed);
    return null;
}

/**
 * Раскладывает ответ модели по номерам сообщений партии.
 * @returns {Map<number, string>} номер сообщения (с единицы) → саммари
 */
function mapBatchSummaries(parsed, expectedCount) {
    const byNumber = new Map();
    let sawAnyNumber = false;

    for (const item of parsed) {
        const summary = item && typeof item.summary === "string" ? item.summary.trim() : "";
        if (summary.length <= 5) continue;
        const number = Number(item.msg);
        if (Number.isInteger(number) && number >= 1 && number <= expectedCount) {
            sawAnyNumber = true;
            if (!byNumber.has(number)) byNumber.set(number, summary);
        }
    }

    if (sawAnyNumber) return byNumber;

    // Поле msg модель не заполнила — единственное, на что можно опереться, это
    // порядок элементов.
    const positional = new Map();
    parsed.forEach((item, i) => {
        const summary = item && typeof item.summary === "string" ? item.summary.trim() : "";
        if (summary.length > 5 && i < expectedCount) positional.set(i + 1, summary);
    });
    return positional;
}

function splitIntoScanChunks(messages) {
    const chunks = [];
    let current = [];
    let chars = 0;

    for (const message of messages) {
        const cost = message.text.length + message.speaker.length + 16;
        if (current.length > 0 && (current.length >= SCAN_CHUNK_MESSAGES || chars + cost > SCAN_CHUNK_CHARS)) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push(message);
        chars += cost;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

/**
 * Сканирует одну партию и дописывает факты в state.
 * @returns {Promise<number>} сколько сообщений партии считать обработанными.
 * Всегда >= 1, поэтому курсор двигается и зацикливания на одной партии не бывает.
 */
async function scanChunk(chunk, state) {
    if (chunk.length === 1) {
        const message = chunk[0];
        const promptText = `TASK: Ensure contextual continuity by summarizing and extracting key details and events from the story's plot, as well as information about {{user}}, {{char}}, and other characters. Even if the message is very short, always write a brief summary of what happened or was said. Never skip a message. Always write your summary in the language used in {{user}}'s messages.\n\nMESSAGE: ${message.speaker}: ${message.text}`;

        const response = await callSummarizerLLM(
            promptText,
            "You are a helpful assistant that summarizes story events and extracts key facts. Ignore any roleplay context and respond only with the summary."
        );

        const fact = typeof response === "string" ? response.trim() : "";
        if (fact.length > 5) {
            state.facts.push(fact);
        } else {
            toastr.warning("Модель вернула пустой ответ — сообщение пропущено", "Summary Tracker");
        }
        return 1;
    }

    const numbered = chunk
        .map((message, i) => `[MSG:${i + 1}] ${message.speaker}: ${message.text}`)
        .join("\n\n");

    const promptText = `TASK: For each numbered message below, write a brief factual summary of what happened or was said. Preserve story continuity — include character details, actions, emotions, and plot events. Even for very short messages, always write something. Never skip a message. Always respond in the language used in the messages.

Return ONLY a JSON array, no other text, no markdown, no backticks. Format:
[{"msg":1,"summary":"..."},{"msg":2,"summary":"..."},...]

MESSAGES:
${numbered}`;

    const response = await callSummarizerLLM(
        promptText,
        "You are a helpful assistant that summarizes story messages. Always respond with valid JSON only."
    );

    const parsed = parseBatchResponse(response);
    if (parsed === null) {
        // Ответ не в JSON — это почти всегда обычный текст саммари, он полезнее,
        // чем ничего, поэтому кладём его одним фактом и идём дальше.
        const fallback = typeof response === "string" ? response.trim() : "";
        if (fallback.length > 5) {
            state.facts.push(fallback);
            toastr.warning("Модель ответила не JSON — саммари сохранено одним блоком", "Summary Tracker");
        } else {
            toastr.error("Пустой ответ модели — партия пропущена", "Summary Tracker");
        }
        return chunk.length;
    }

    const summaries = mapBatchSummaries(parsed, chunk.length);

    // Сколько сообщений подряд с начала партии реально получили саммари.
    let confirmed = 0;
    while (confirmed < chunk.length && summaries.has(confirmed + 1)) confirmed++;

    if (confirmed === chunk.length) {
        for (let n = 1; n <= confirmed; n++) state.facts.push(summaries.get(n));
        return chunk.length;
    }

    if (confirmed === 0) {
        // Двигаться некуда: повтор той же партии дал бы тот же результат. Берём что
        // пришло и идём дальше, но честно сообщаем, сколько сообщений потеряно.
        const numbers = [...summaries.keys()].sort((a, b) => a - b);
        for (const n of numbers) state.facts.push(summaries.get(n));
        toastr.warning(
            `Модель не разметила ответ по номерам: ${chunk.length - numbers.length} сообщений остались без саммари`,
            "Summary Tracker"
        );
        return chunk.length;
    }

    for (let n = 1; n <= confirmed; n++) state.facts.push(summaries.get(n));
    toastr.warning(
        `Модель вернула ${confirmed} саммари из ${chunk.length} — остальные будут пересканированы`,
        "Summary Tracker"
    );
    return confirmed;
}

async function runAutoScan() {
    if (isScanning) return;

    // Чат фиксируем один раз: все записи ниже идут по этому id, даже если
    // пользователь переключится в другой чат, пока модель думает.
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.warning("Open the chat first", "Summary Tracker");
        return;
    }

    const chat = getChatArray();
    if (!chat) return;

    const visible = getModelVisibleIndices(chat);
    const skipCount = getSkipCount();
    if (visible.length <= skipCount) {
        // Молчаливый выход выглядит как сломанная кнопка: пользователь жмёт Scan,
        // и не происходит вообще ничего.
        toastr.info(`All ${visible.length} messages are inside the "leave visible" window`, "Summary Tracker");
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
        toastr.info("No new messages to scan", "Summary Tracker");
        // Только вперёд: увеличенный skipCount уменьшает endIndex, и безусловная
        // запись откатила бы курсор, заставив пересканировать уже учтённое.
        if (endIndex > state.lastScanned) {
            state.lastScanned = endIndex;
            commitState(chatId, state);
        }
        return;
    }

    isScanning = true;
    const chunks = splitIntoScanChunks(messagesToScan);
    toastr.info(
        chunks.length > 1
            ? `Сканирование ${messagesToScan.length} сообщений (${chunks.length} партиями)...`
            : `Сканирование ${messagesToScan.length} сообщений...`,
        "Summary Tracker"
    );

    try {
        let interrupted = false;

        for (const chunk of chunks) {
            const consumed = await scanChunk(chunk, state);
            const reached = chunk[consumed - 1]?.position;
            if (Number.isFinite(reached)) {
                state.lastScanned = Math.max(state.lastScanned, reached + 1);
            }
            // Курсор фиксируем после каждой партии: ошибка на середине не должна
            // отправлять уже обработанные сообщения в модель заново.
            commitState(chatId, state);
            if (consumed < chunk.length) {
                interrupted = true;
                break;
            }
        }

        if (!interrupted) {
            state.lastScanned = Math.max(state.lastScanned, endIndex);
        }

        await maybeCompressFacts(state);

        if (extension_settings[extensionName].autoHide && buildContextFromState(state).length > 0) {
            state.isHidden = true;
        }

        commitState(chatId, state);

        // Пока шёл запрос, пользователь мог уйти в другой чат — тогда панель и подсветка
        // относятся уже не к тому чату, который мы сканировали.
        if (getCurrentChatId() === chatId) refreshUi();
        toastr.success("Готово!", "Summary Tracker");
    } catch (error) {
        console.error(`[${extensionName}] Error:`, error);
        // Факты и курсор, набранные до ошибки, сохраняем — иначе успешные партии
        // пропадут вместе с неудачной.
        commitState(chatId, state);
        if (getCurrentChatId() === chatId) refreshUi();
        toastr.error("Ошибка сканирования", "Summary Tracker");
    } finally {
        isScanning = false;
    }
}

async function handleChatEvent() {
    if (!extension_settings[extensionName].autoScan) return;
    if (!getCurrentChatId() || !getChatArray()) return;

    const endIndex = getVisibleCount() - getSkipCount();
    if (endIndex <= 0) return;

    const lastScanned = Math.max(0, Math.min(getLastScanned(), endIndex));
    if ((endIndex - lastScanned) >= getScanInterval()) {
        await runAutoScan();
    }
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

    if (settings.isHidden !== undefined) {
        pendingLegacyHidden = settings.isHidden === true;
        delete settings.isHidden;
    }
    migrateLegacyHidden();
    migrateChatFromSettings();

    $("#fmt_auto_scan").prop("checked", settings.autoScan);
    $("#fmt_auto_hide").prop("checked", settings.autoHide);
    $("#fmt_skip_count").val(getSkipCount());
    $("#fmt_scan_interval").val(getScanInterval());
    $("#fmt_compress_after").val(getCompressAfter());
    $("#fmt_use_custom_provider").prop("checked", settings.useCustomProvider);
    $("#fmt_custom_api_url").val(settings.customApiUrl);
    $("#fmt_custom_api_key").val(settings.customApiKey);
    $("#fmt_custom_api_model").val(settings.customApiModel);
    $("#fmt_custom_provider_panel").css("display", settings.useCustomProvider ? "block" : "none");

    $("#fmt_scan_interval").prop("disabled", !settings.autoScan);
    $("#fmt_scan_interval_row").css("display", settings.autoScan ? "flex" : "none");

    pruneEmptyChats();
    updateMaxSkip();
    refreshUi();
}

// Пустое поле ввода — это промежуточное состояние набора, а не «поставь минимум».
// Раньше очистка поля молча писала в настройки 2, и UI расходился со стейтом.
function bindNumberSetting(selector, key, minimum) {
    $(selector).on("input", (e) => {
        const text = String($(e.target).val() ?? "").trim();
        if (text === "") return;
        const raw = parseInt(text);
        if (!Number.isFinite(raw) || raw < minimum) return;
        extension_settings[extensionName][key] = raw;
        saveSettingsDebounced();
    });

    // Ушли из поля с мусором — возвращаем то, что реально лежит в настройках.
    $(selector).on("blur", () => {
        $(selector).val(extension_settings[extensionName][key]);
    });
}

function bindSettingsHandlers() {
    $("#fmt_auto_scan").on("input", (e) => {
        const checked = Boolean($(e.target).prop("checked"));
        extension_settings[extensionName].autoScan = checked;
        saveSettingsDebounced();
        $("#fmt_scan_interval").prop("disabled", !checked);
        $("#fmt_scan_interval_row").css("display", checked ? "flex" : "none");
    });

    $("#fmt_auto_hide").on("input", (e) => {
        extension_settings[extensionName].autoHide = Boolean($(e.target).prop("checked"));
        saveSettingsDebounced();
    });

    bindNumberSetting("#fmt_skip_count", "skipCount", 2);
    $("#fmt_skip_count").on("input", applyVisualHiding);

    bindNumberSetting("#fmt_scan_interval", "scanInterval", 1);
    bindNumberSetting("#fmt_compress_after", "compressAfter", 2);

    $("#fmt_use_custom_provider").on("input", (e) => {
        const checked = Boolean($(e.target).prop("checked"));
        extension_settings[extensionName].useCustomProvider = checked;
        saveSettingsDebounced();
        $("#fmt_custom_provider_panel").css("display", checked ? "block" : "none");
    });

    $("#fmt_custom_api_url").on("input", (e) => {
        extension_settings[extensionName].customApiUrl = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#fmt_custom_api_key").on("input", (e) => {
        extension_settings[extensionName].customApiKey = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#fmt_custom_api_model").on("input", (e) => {
        extension_settings[extensionName].customApiModel = $(e.target).val().trim();
        saveSettingsDebounced();
    });

    $("#fmt_test_custom_provider").on("click", testCustomProviderConnection);

    $("#fmt_manual_scan").on("click", () => runAutoScan());

    $("#fmt_clear_facts").on("click", () => {
        if (!confirm("Очистить всё?")) return;
        isEditingSummary = false;
        patchState(defaultState());
        refreshUi();
    });

    $("#fmt_toggle_hide").on("click", () => {
        if (buildFullContext().length === 0) return;
        patchState({ isHidden: !getIsHidden() });
        applyVisualHiding();
        updateHideButton();
    });
}

function bindChatEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        isEditingSummary = false;
        migrateLegacyHidden();
        migrateChatFromSettings();
        flushPendingCommit();
        pruneEmptyChats();
        clampScanCursor();
        updateMaxSkip();
        refreshUi();
    });

    eventSource.on(event_types.CHAT_RENAMED, handleChatRenamed);

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        updateMaxSkip();
        refreshUi();
        // Не блокируем пайплайн ST: он ждёт этот обработчик перед сохранением чата.
        handleChatEvent().catch(err => console.error(`[${extensionName}] Auto-scan failed:`, err));
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
        window.SummaryTracker = {
            version: extensionVersion,
            folderPath: extensionFolderPath,
            get settings() { return extension_settings[extensionName]; },
            get state() { return readState(); },
            get isScanning() { return isScanning; },
            get pendingCommits() { return pendingCommits; },
            getCurrentChatId, getChatArray, getVisibleCount,
            readState, writeState, patchState, commitState, flushPendingCommit,
            getFacts, getLayerSummary, getIsHidden, getLastScanned,
            buildFullContext, buildContextFromState, isHidingActive, getModelVisibleIndices,
            getSkipCount, getScanInterval, getCompressAfter, shouldCompressFacts,
            escapeHtml, parseBatchResponse, mapBatchSummaries, splitIntoScanChunks,
            pruneEmptyChats, clampScanCursor, rawIndexToVisiblePosition,
            migrateChatFromSettings, handleChatRenamed,
            interceptGeneration, applyVisualHiding, setPromptInjection,
            refreshUi, renderSummary, renderFactsCount, updateHideButton, loadSettings,
            runAutoScan, scanChunk, maybeCompressFacts, handleChatEvent,
            callSummarizerLLM, sendCustomProviderRequest, testCustomProviderConnection
        };

        console.log(`[${extensionName}] ✅ Loaded (v${extensionVersion}) from ${extensionFolderPath}. Debug API: window.SummaryTracker`);
    } catch (error) {
        console.error(`[${extensionName}] ❌ Load failed:`, error);
        // Молчаливый провал выглядел как «расширение просто не появилось в списке».
        if (typeof toastr !== "undefined") {
            toastr.error(`Не удалось загрузить панель настроек из ${extensionFolderPath}: ${error?.message ?? error}`, "Summary Tracker");
        }
    }
});
