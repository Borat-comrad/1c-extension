const BASE_URL =
  "http://192.168.11.240:8282/crm/hs/service_avtm_vne1c/information_code_producer";
const MAX_CODES_PER_SEARCH = 20;
const MAX_PARALLEL_REQUESTS = 2;

const codeInput = document.getElementById("code");
const loginInput = document.getElementById("login");
const passwordInput = document.getElementById("password");
const fetchButton = document.getElementById("fetchButton");
const resetButton = document.getElementById("resetButton");
const statusBlock = document.getElementById("status");
const resultBlock = document.getElementById("result");
const EMPTY_TEXT = "нет данных";
const EXPECTED_RESPONSE_KEYS = [
  "ИсторияПоставок",
  "ИсторияЦен",
  "ДанынеРекламаций",
  "ДанныеРекламаций",
  "СписокСапКодов",
  "КодКонечногоПроизводителя",
  "РасширенноеНаименование",
  "Группа"
];

document.addEventListener("DOMContentLoaded", async () => {
  const savedData = await chrome.storage.local.get(["lastCode", "login"]);

  if (savedData.lastCode) {
    codeInput.value = savedData.lastCode;
  }

  if (savedData.login) {
    loginInput.value = savedData.login;
  }
});

resetButton.addEventListener("click", async () => {
  await chrome.storage.local.remove(["lastCode", "login"]);

  codeInput.value = "";
  loginInput.value = "";
  passwordInput.value = "";

  setResultMessage("Сохранённые данные сброшены.");
  showOk("Код и логин удалены из локального хранилища.");
});

fetchButton.addEventListener("click", async () => {
  const rawCodeInput = codeInput.value.trim();
  const codes = parseCodeInput(rawCodeInput);
  const login = loginInput.value.trim();
  const password = passwordInput.value;

  clearStatus();

  if (codes.length === 0) {
    showError("Введите хотя бы один код");
    return;
  }

  if (codes.length > MAX_CODES_PER_SEARCH) {
    showError(`Слишком много кодов за один поиск. Максимум: ${MAX_CODES_PER_SEARCH}.`);
    return;
  }

  if (!login) {
    showError("Введите логин 1С.");
    return;
  }

  if (!password) {
    showError("Введите пароль 1С.");
    return;
  }

  await chrome.storage.local.set({
    lastCode: rawCodeInput,
    login: login
  });

  fetchButton.disabled = true;
  fetchButton.textContent = "Запрос выполняется...";
  setResultMessage(codes.length === 1 ? "Ждём ответ от 1С..." : `Обработано 0 из ${codes.length}`);

  try {
    if (codes.length === 1) {
      const result = await fetchPriceHistoryForCode(codes[0], login, password);
      renderSingleFetchResult(result);
      return;
    }

    const results = await runWithConcurrencyLimit(
      codes,
      MAX_PARALLEL_REQUESTS,
      (code) => fetchPriceHistoryForCode(code, login, password),
      (completed, total) => {
        renderMultiProgress(completed, total);
      }
    );

    renderMultiResults(results);
  } catch (error) {
    showError(makeNetworkErrorMessage(error));
    renderTechnicalFallback("Запрос не выполнен.", String(error && error.stack ? error.stack : error));
  } finally {
    fetchButton.disabled = false;
    fetchButton.textContent = "Получить историю цен";
  }
});

function makeBasicAuthHeader(login, password) {
  const raw = `${login}:${password}`;

  const utf8Bytes = new TextEncoder().encode(raw);

  let binaryString = "";
  utf8Bytes.forEach((byte) => {
    binaryString += String.fromCharCode(byte);
  });

  const encoded = btoa(binaryString);

  return `Basic ${encoded}`;
}

function parseCodeInput(input) {
  const seenCodes = new Set();
  const codes = [];

  String(input || "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0)
    .forEach((code) => {
      if (!seenCodes.has(code)) {
        seenCodes.add(code);
        codes.push(code);
      }
    });

  return codes;
}

async function runWithConcurrencyLimit(items, limit, worker, onItemSettled) {
  const results = new Array(items.length);
  const normalizedLimit = Math.max(1, Math.floor(limit || 1));
  let nextIndex = 0;
  let activeCount = 0;
  let completedCount = 0;

  if (items.length === 0) {
    return results;
  }

  return new Promise((resolve) => {
    const runNext = () => {
      if (completedCount === items.length) {
        resolve(results);
        return;
      }

      while (activeCount < normalizedLimit && nextIndex < items.length) {
        const currentIndex = nextIndex;
        const item = items[currentIndex];
        nextIndex += 1;
        activeCount += 1;

        Promise.resolve()
          .then(() => worker(item, currentIndex))
          .then((result) => {
            results[currentIndex] = result;
          })
          .catch((error) => {
            results[currentIndex] = {
              code: item,
              ok: false,
              error: makeNetworkErrorMessage(error),
              rawText: String(error && error.stack ? error.stack : error)
            };
          })
          .finally(() => {
            activeCount -= 1;
            completedCount += 1;

            if (typeof onItemSettled === "function") {
              onItemSettled(completedCount, items.length, results[currentIndex], currentIndex);
            }

            runNext();
          });
      }
    };

    runNext();
  });
}

async function fetchPriceHistoryForCode(code, login, password) {
  const url = `${BASE_URL}/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": makeBasicAuthHeader(login, password),
        "Accept": "application/json, text/plain, */*"
      }
    });

    const responseText = await response.text();

    if (!response.ok) {
      return buildHttpErrorResult(code, response.status, response.statusText, responseText);
    }

    try {
      return {
        code,
        ok: true,
        status: response.status,
        data: JSON.parse(responseText)
      };
    } catch {
      return {
        code,
        ok: false,
        status: response.status,
        error: "Ответ получен, но JSON не удалось разобрать.",
        rawText: responseText || "Тело ответа пустое.",
        errorType: "invalid_json"
      };
    }
  } catch (error) {
    return {
      code,
      ok: false,
      error: makeNetworkErrorMessage(error),
      rawText: String(error && error.stack ? error.stack : error),
      errorType: "network"
    };
  }
}

function buildHttpErrorResult(code, status, statusText, responseText) {
  const result = {
    code,
    ok: false,
    status,
    error: makeHttpErrorMessage(status, statusText),
    rawText: responseText || "Тело ответа пустое.",
    errorType: "http"
  };

  if (!responseText) {
    return result;
  }

  try {
    const data = JSON.parse(responseText);
    result.data = data;
    result.error = extractErrorMessage(data) || result.error;
  } catch {
    // Keep the raw text in details; the main error message stays readable.
  }

  return result;
}

function extractErrorMessage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }

  const preferredKeys = ["message", "error", "detail", "description", "Сообщение", "Ошибка"];
  const key = preferredKeys.find((candidate) => !isEmptyValue(data[candidate]));

  if (!key) {
    return "";
  }

  return typeof data[key] === "object" ? "1С вернула ошибку в структурированном формате." : String(data[key]);
}

function renderSingleFetchResult(result) {
  if (result.ok) {
    showOk(`Запрос успешен. HTTP-статус: ${result.status}`);
    renderResult(result.data, result.code);
    return;
  }

  showError(result.error || "Запрос завершился ошибкой.");

  if (result.errorType === "http" && result.data) {
    renderBackendErrorResponse(result.status, "", result.data, result.rawText);
    return;
  }

  renderTechnicalFallback(result.error || "Запрос завершился ошибкой.", result.rawText || "Технический ответ пустой.");
}

function handleSuccessfulResponse(responseText, code) {
  try {
    const data = JSON.parse(responseText);
    renderResult(data, code);
  } catch {
    showError("Ответ получен, но JSON не удалось разобрать.");
    renderTechnicalFallback("Ответ получен, но JSON не удалось разобрать.", responseText || "Тело ответа пустое.");
  }
}

function handleHttpErrorResponse(status, statusText, responseText) {
  if (!responseText) {
    renderTechnicalFallback("1С вернула ошибку.", "Тело ответа пустое.");
    return;
  }

  try {
    const data = JSON.parse(responseText);
    renderBackendErrorResponse(status, statusText, data, responseText);
  } catch {
    renderTechnicalFallback("1С вернула ошибку.", responseText);
  }
}

function renderResult(data, code) {
  const resultView = buildResultView(data, code);
  resultBlock.className = resultView.className;
  resultBlock.innerHTML = resultView.html;
}

function buildResultView(data, code) {
  if (!isExpectedResponseShape(data)) {
    return {
      className: "result-card",
      html: renderTechnicalFallbackSection(
        "Ответ получен, но формат отличается от ожидаемого.",
        JSON.stringify(data, null, 2)
      )
    };
  }

  return {
    className: "result-card",
    html: `
    <section class="summary-grid" aria-label="Краткая информация">
      ${renderSummaryField("Код производителя", code)}
      ${renderSummaryField("Расширенное наименование", data["РасширенноеНаименование"])}
      ${renderSummaryField("Группа", data["Группа"])}
      ${renderSummaryField("Код конечного производителя", data["КодКонечногоПроизводителя"])}
    </section>
    ${renderPricesSection(data["ИсторияЦен"])}
    ${renderShipmentsSection(data)}
    ${renderClaimsSection(data)}
    ${renderSapCodesSection(data)}
    ${renderInfoSection(data)}
    ${renderAdditionalInfoSection(data)}
  `
  };
}

function renderPricesSection(prices) {
  if (!Array.isArray(prices) || prices.length === 0) {
    return `
      <section class="section-card">
        <h3>История цен</h3>
        <div class="metrics-grid">
          <div class="metric-card primary">
            <div class="metric-label">Последняя цена</div>
            <div class="metric-value">${renderEmptyValue(null)}</div>
          </div>
          <div class="metric-card accent">
            <div class="metric-label">Средняя цена</div>
            <div class="metric-value">${renderEmptyValue(null)}</div>
          </div>
        </div>
        <div class="price-list">
          <h4>Все цены</h4>
          <div class="empty-value">${EMPTY_TEXT}</div>
        </div>
      </section>
    `;
  }

  const lastPrice = getLastPrice(prices);
  const averagePrice = calculateAveragePrice(prices);
  const lastPriceValue = lastPrice && !isEmptyValue(lastPrice["Цена"])
    ? `${renderPriceValue(lastPrice["Цена"])} ${renderCurrency(lastPrice["Валюта"])}`
    : renderEmptyValue(null);
  const averagePriceValue = averagePrice
    ? `${escapeHtml(averagePrice.value)} ${renderCurrency(averagePrice.currency)}`
    : renderEmptyValue(null);

  return `
    <section class="section-card">
      <h3>История цен</h3>
      <div class="metrics-grid">
        <div class="metric-card primary">
          <div class="metric-label">Последняя цена</div>
          <div class="metric-value">${lastPriceValue}</div>
          <div class="metric-note">${renderEmptyValue(lastPrice && lastPrice["Контрагент"])}</div>
        </div>
        <div class="metric-card accent">
          <div class="metric-label">Средняя цена</div>
          <div class="metric-value">${averagePriceValue}</div>
        </div>
      </div>
      <div class="price-list">
        <h4>Все цены</h4>
        ${prices.map((price, index) => renderPriceItem(price, index)).join("")}
      </div>
    </section>
  `;
}

function renderInfoSection(data) {
  return `
    <section class="section-card">
      <h3>Основная информация</h3>
      ${renderFieldRow("РасширенноеНаименование", data["РасширенноеНаименование"])}
      ${renderFieldRow("Группа", data["Группа"])}
      ${renderFieldRow("КодКонечногоПроизводителя", data["КодКонечногоПроизводителя"])}
    </section>
  `;
}

function renderShipmentsSection(data) {
  return renderDataSection("История поставок", data["ИсторияПоставок"]);
}

function renderClaimsSection(data) {
  return renderDataSection("Данные рекламаций", getClaimsData(data));
}

function renderSapCodesSection(data) {
  return renderDataSection("Список SAP-кодов", data["СписокСапКодов"]);
}

function renderEmptyValue(value) {
  if (isEmptyValue(value)) {
    return `<span class="empty-value">${EMPTY_TEXT}</span>`;
  }

  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function calculateAveragePrice(prices) {
  if (!Array.isArray(prices)) {
    return null;
  }

  const numericPrices = prices
    .map((price) => ({
      value: normalizeNumber(price && price["Цена"]),
      currency: normalizeCurrency(price && price["Валюта"])
    }))
    .filter((price) => price.value !== null);

  if (numericPrices.length === 0) {
    return null;
  }

  const sum = numericPrices.reduce((total, price) => total + price.value, 0);
  const currencies = [...new Set(numericPrices.map((price) => price.currency).filter(Boolean))];
  const average = sum / numericPrices.length;
  const roundedAverage = Math.round((average + 1e-9) * 100) / 100;

  return {
    value: roundedAverage.toFixed(2),
    currency: currencies.length > 1 ? "разные валюты" : (currencies[0] || "")
  };
}

function renderBackendErrorResponse(status, statusText, data, rawText) {
  resultBlock.className = "result-card";
  resultBlock.innerHTML = renderBackendErrorSection(status, statusText, data, rawText);
}

function renderBackendErrorSection(status, statusText, data, rawText) {
  return `
    <section class="section-card error-card">
      <h3>1С вернула ошибку</h3>
      ${renderFieldRow("HTTP-статус", `${status} ${statusText || ""}`.trim())}
      ${data && typeof data === "object" && !Array.isArray(data)
        ? renderStructuredValue(data)
        : renderFieldRow("Ответ", data)}
      <details class="details-block">
        <summary>Технический ответ</summary>
        <pre class="technical-response">${escapeHtml(rawText || "Тело ответа пустое.")}</pre>
      </details>
    </section>
  `;
}

function getLastPrice(prices) {
  return Array.isArray(prices) && prices.length > 0 ? prices[prices.length - 1] : null;
}

function renderSummaryField(label, value) {
  return `
    <div class="summary-item">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="field-value">${renderEmptyValue(value)}</div>
    </div>
  `;
}

function renderPriceItem(price, index) {
  if (!price || typeof price !== "object" || Array.isArray(price)) {
    return `
      <article class="price-item">
        <div class="price-title">${index + 1}. ${renderEmptyValue(price)}</div>
      </article>
    `;
  }

  const extraFields = Object.entries(price).filter(([key]) => (
    key !== "Контрагент" && key !== "Цена" && key !== "Валюта"
  ));
  const priceValue = !isEmptyValue(price["Цена"])
    ? `${renderPriceValue(price["Цена"])} ${renderCurrency(price["Валюта"])}`
    : renderEmptyValue(null);

  return `
    <article class="price-item">
      <div class="price-title">${index + 1}. ${renderEmptyValue(price["Контрагент"])}</div>
      <div class="field-row">
        <div class="field-label">Цена</div>
        <div class="field-value">${priceValue}</div>
      </div>
      ${extraFields.length > 0 ? `
        <div class="additional-data">
          <div class="field-label">Дополнительно</div>
          ${extraFields.map(([key, value]) => renderFieldRow(key, value)).join("")}
        </div>
      ` : ""}
    </article>
  `;
}

function renderAdditionalInfoSection(data) {
  const entries = Object.entries(data).filter(([key]) => !EXPECTED_RESPONSE_KEYS.includes(key));

  if (entries.length === 0) {
    return "";
  }

  return `
    <section class="section-card">
      <h3>Дополнительные данные</h3>
      ${entries.map(([key, value]) => renderFieldRow(key, value)).join("")}
    </section>
  `;
}

function renderDataSection(title, value) {
  return `
    <section class="section-card">
      <h3>${escapeHtml(title)}</h3>
      ${renderStructuredValue(value)}
    </section>
  `;
}

function renderStructuredValue(value) {
  if (isEmptyValue(value)) {
    return `<div class="empty-value">${EMPTY_TEXT}</div>`;
  }

  if (Array.isArray(value)) {
    return `
      <div class="records-count">Записей: ${value.length}</div>
      <div class="records-list">
        ${value.map((item, index) => renderRecordItem(item, index)).join("")}
      </div>
    `;
  }

  if (typeof value === "object") {
    return `
      <div class="fields-list">
        ${Object.entries(value).map(([key, itemValue]) => renderFieldRow(key, itemValue)).join("")}
      </div>
    `;
  }

  return `<div class="field-value">${escapeHtml(value)}</div>`;
}

function renderRecordItem(item, index) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return `
      <article class="record-item">
        <div class="record-title">${index + 1}.</div>
        ${Object.entries(item).map(([key, value]) => renderFieldRow(key, value)).join("")}
      </article>
    `;
  }

  return `
    <article class="record-item">
      <div class="record-title">${index + 1}.</div>
      <div class="field-value">${renderEmptyValue(item)}</div>
    </article>
  `;
}

function renderFieldRow(label, value) {
  const valueHtml = value && typeof value === "object"
    ? renderStructuredValue(value)
    : renderEmptyValue(value);

  return `
    <div class="field-row">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="field-value">${valueHtml}</div>
    </div>
  `;
}

function renderCurrency(currency) {
  return isEmptyValue(currency) ? "" : escapeHtml(currency);
}

function renderPriceValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return escapeHtml(Number.isInteger(value) ? String(value) : value.toFixed(2));
  }

  return escapeHtml(value);
}

function renderTechnicalFallback(message, rawText) {
  resultBlock.className = "result-card";
  resultBlock.innerHTML = renderTechnicalFallbackSection(message, rawText);
}

function renderTechnicalFallbackSection(message, rawText) {
  return `
    <section class="section-card error-card">
      <h3>${escapeHtml(message)}</h3>
      <details class="details-block">
        <summary>Технический ответ</summary>
        <pre class="technical-response">${escapeHtml(rawText)}</pre>
      </details>
    </section>
  `;
}

function renderMultiProgress(completed, total) {
  resultBlock.className = "multi-results";
  resultBlock.innerHTML = `
    <section class="multi-summary-card">
      <h3>Результаты поиска</h3>
      <div class="multi-progress">Обработано ${escapeHtml(completed)} из ${escapeHtml(total)}</div>
    </section>
  `;
}

function renderMultiResults(results) {
  const successfulCount = results.filter((result) => result && result.ok).length;
  const failedCount = results.length - successfulCount;

  resultBlock.className = "multi-results";
  resultBlock.innerHTML = `
    <section class="multi-summary-card">
      <h3>Результаты поиска</h3>
      <div class="summary-grid multi-summary-grid" aria-label="Итоги поиска">
        ${renderSummaryField("Кодов", results.length)}
        ${renderSummaryField("Успешно", successfulCount)}
        ${renderSummaryField("Ошибок", failedCount)}
      </div>
    </section>
    ${results.map((result) => renderMultiResultCard(result)).join("")}
  `;

  if (failedCount === 0) {
    showOk(`Поиск завершён. Успешно: ${successfulCount}. Ошибок: 0.`);
    return;
  }

  showError(`Поиск завершён. Успешно: ${successfulCount}. Ошибок: ${failedCount}.`);
}

function renderMultiResultCard(result) {
  if (result && result.ok) {
    return renderMultiSuccessCard(result);
  }

  return renderMultiErrorCard(result || {
    code: "",
    ok: false,
    error: "Запрос завершился ошибкой."
  });
}

function renderMultiSuccessCard(result) {
  const resultView = buildResultView(result.data, result.code);

  return `
    <article class="code-result-card success">
      <header class="code-result-header">
        <h3>Код: ${escapeHtml(result.code)}</h3>
        <span class="code-result-badge ok">HTTP ${escapeHtml(result.status)}</span>
      </header>
      <div class="${escapeHtml(resultView.className)} nested-result">
        ${resultView.html}
      </div>
    </article>
  `;
}

function renderMultiErrorCard(result) {
  const statusValue = result.status ? `HTTP ${result.status}` : "";
  const rawText = result.rawText || "Технический ответ пустой.";

  return `
    <article class="code-result-card failed">
      <header class="code-result-header">
        <h3>Код: ${escapeHtml(result.code || "")}</h3>
        <span class="code-result-badge error">Ошибка</span>
      </header>
      <section class="section-card error-card">
        ${statusValue ? renderFieldRow("HTTP-статус", statusValue) : ""}
        ${renderFieldRow("Сообщение", result.error || "Запрос завершился ошибкой.")}
        <details class="details-block">
          <summary>Технический ответ</summary>
          <pre class="technical-response">${escapeHtml(rawText)}</pre>
        </details>
      </section>
    </article>
  `;
}

function setResultMessage(message) {
  resultBlock.className = "result-card empty";
  resultBlock.textContent = message;
}

function isEmptyValue(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }

  return false;
}

function normalizeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

function normalizeCurrency(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getClaimsData(data) {
  const typoValue = data["ДанынеРекламаций"];
  const correctedValue = data["ДанныеРекламаций"];

  if (isEmptyValue(typoValue)) {
    return correctedValue;
  }

  if (isEmptyValue(correctedValue)) {
    return typoValue;
  }

  if (Array.isArray(typoValue) && Array.isArray(correctedValue)) {
    return [...typoValue, ...correctedValue];
  }

  return {
    "ДанынеРекламаций": typoValue,
    "ДанныеРекламаций": correctedValue
  };
}

function isExpectedResponseShape(data) {
  return Boolean(
    data
    && typeof data === "object"
    && !Array.isArray(data)
    && EXPECTED_RESPONSE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(data, key))
  );
}

function showOk(message) {
  statusBlock.textContent = message;
  statusBlock.className = "status ok";
}

function showError(message) {
  statusBlock.textContent = message;
  statusBlock.className = "status error";
}

function clearStatus() {
  statusBlock.textContent = "";
  statusBlock.className = "status";
}

function makeHttpErrorMessage(status, statusText) {
  if (status === 401) {
    return "Ошибка 401: неверный логин или пароль 1С.";
  }

  if (status === 403) {
    return "Ошибка 403: доступ запрещён. У пользователя 1С нет прав на этот HTTP-сервис.";
  }

  if (status === 404) {
    return "Ошибка 404: код не найден или адрес HTTP-сервиса неправильный.";
  }

  if (status >= 500) {
    return `Ошибка ${status}: 1С-сервер ответил с внутренней ошибкой. ${statusText}`;
  }

  return `HTTP-ошибка ${status}: ${statusText}`;
}

function makeNetworkErrorMessage(error) {
  const message = String(error && error.message ? error.message : error);

  if (message.includes("Failed to fetch")) {
    return "Не удалось выполнить запрос. Возможные причины: нет доступа к локальной сети/VPN, 1С не отвечает, Chrome заблокировал запрос, проблема CORS или неверный адрес.";
  }

  return `Сетевая ошибка: ${message}`;
}
