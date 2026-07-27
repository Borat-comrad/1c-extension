const BASE_URL =
  "http://192.168.11.240:8282/crm/hs/service_avtm_vne1c/information_code_producer";
const MAX_CODES_PER_SEARCH = 20;
const MAX_PARALLEL_REQUESTS = 2;
const PURCHASE_LIST_INITIAL_LIMIT = 4;
const QUOTE_GROUPS_INITIAL_LIMIT = 3;
const SAP_CODES_INITIAL_LIMIT = 5;
const SHOW_RAW_1C_RESPONSE = true;

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
  "КодЗапроса",
  "КодКонечногоПроизводителя",
  "ПроизводительОборудования",
  "Бренд",
  "РасширенноеНаименование",
  "Группа"
];

resultBlock.addEventListener("click", handleResultClick);

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
    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      return buildHttpErrorResult(code, response.status, response.statusText, contentType, responseText);
    }

    try {
      return {
        code,
        ok: true,
        status: response.status,
        contentType,
        rawText: responseText,
        data: JSON.parse(responseText)
      };
    } catch {
      return {
        code,
        ok: false,
        status: response.status,
        contentType,
        error: "Ответ получен, но JSON не удалось разобрать.",
        rawText: responseText,
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

function buildHttpErrorResult(code, status, statusText, contentType, responseText) {
  const result = {
    code,
    ok: false,
    status,
    contentType,
    error: makeHttpErrorMessage(status, statusText),
    rawText: responseText,
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
    renderResult(result.data, result.code, result);
    return;
  }

  showError(result.error || "Запрос завершился ошибкой.");

  if (result.errorType === "http" && result.data) {
    renderBackendErrorResponse(result.status, "", result.data, result.rawText, result);
    return;
  }

  renderTechnicalFallback(
    result.error || "Запрос завершился ошибкой.",
    result.rawText || "Технический ответ пустой.",
    result
  );
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

function renderResult(data, code, diagnosticResult) {
  const resultView = buildResultView(data, code, {
    showTechnicalResponse: !diagnosticResult
  });
  resultBlock.className = resultView.className;
  resultBlock.innerHTML = `${resultView.html}${diagnosticResult ? renderRawResponseBlock(diagnosticResult) : ""}`;
}

function buildResultView(data, code, options = {}) {
  if (!isExpectedResponseShape(data)) {
    return {
      className: "result-card",
      html: renderTechnicalFallbackSection(
        "Ответ получен, но формат отличается от ожидаемого.",
        JSON.stringify(data, null, 2),
        { showTechnicalResponse: options.showTechnicalResponse !== false }
      )
    };
  }

  return {
    className: "result-card",
    html: `
    ${renderProductSummary(data, code)}
    ${renderLatestEfesQuoteSection(data)}
    ${renderPurchasePricesSection(data)}
    ${renderQuoteHistorySection(data)}
    ${renderSapCodesSection(data)}
    ${renderShipmentsSection(data)}
    ${renderClaimsSection(data)}
    ${renderAdditionalInfoSection(data)}
  `
  };
}

function renderProductSummary(data, code) {
  const titleValue = getProductTitle(data, code);

  return `
    <section class="product-summary-card" aria-label="Карточка детали">
      <h3 class="product-title">${renderEmptyValue(titleValue)}</h3>
      <div class="product-summary-grid summary-grid">
        ${renderProductField("Код запроса", data["КодЗапроса"])}
        ${renderProductField("Код, введённый пользователем", code)}
        ${renderProductField("Код конечного производителя", data["КодКонечногоПроизводителя"])}
        ${renderProductField("Бренд", data["Бренд"])}
        ${renderProductField("Производитель оборудования", data["ПроизводительОборудования"])}
        ${renderProductField("Группа / производитель", data["Группа"])}
        ${renderProductField("Расширенное наименование", data["РасширенноеНаименование"], {
          fullWidth: true,
          multiline: true
        })}
      </div>
    </section>
  `;
}

function getProductTitle(data, code) {
  if (!isEmptyValue(data["РасширенноеНаименование"])) {
    const firstMeaningfulLine = String(data["РасширенноеНаименование"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "");

    if (firstMeaningfulLine) {
      return firstMeaningfulLine;
    }
  }

  return !isEmptyValue(data["Бренд"]) ? data["Бренд"] : code;
}

function renderProductField(label, value, options = {}) {
  const itemClasses = ["product-field", "summary-item"];
  const valueClasses = ["product-field-value", "field-value"];

  if (options.fullWidth) {
    itemClasses.push("product-field-wide", "summary-item-wide");
  }

  if (options.multiline) {
    valueClasses.push("multiline-value");
  }

  return `
    <div class="${itemClasses.join(" ")}">
      <div class="product-field-label field-label">${escapeHtml(label)}</div>
      <div class="${valueClasses.join(" ")}">${renderEmptyValue(value)}</div>
    </div>
  `;
}

function renderPurchasePricesSection(data) {
  const purchaseEntries = getPurchaseEntries(data["ИсторияЦен"]);
  const latestSelection = getLatestPurchaseSelection(purchaseEntries);
  const latestEntry = latestSelection.entry;
  const averageGroups = calculateAveragePurchasePricesByCurrency(purchaseEntries);

  return `
    <section class="section-card purchase-price-section">
      <h3>Закупочные цены</h3>
      <div class="purchase-metric-row metrics-grid">
        <div class="purchase-metric-card metric-card primary">
          <div class="metric-label">Последняя закупочная цена</div>
          <div class="metric-value">${latestEntry
            ? escapeHtml(formatMoney(getPurchasePrice(latestEntry), getPurchaseCurrency(latestEntry)))
            : renderEmptyValue(null)}</div>
          <div class="metric-note">${latestEntry ? renderEmptyValue(latestEntry["Контрагент"]) : renderEmptyValue(null)}</div>
          ${latestEntry && !isEmptyValue(latestEntry["ДатаКП"])
            ? `<div class="metric-note">Дата КП: ${renderDateValue(latestEntry["ДатаКП"])}</div>`
            : ""}
          ${latestEntry && !isEmptyValue(latestEntry["НомерКП"])
            ? `<div class="metric-note">КП: ${renderEmptyValue(latestEntry["НомерКП"])}</div>`
            : ""}
          ${latestSelection.sameLatestDateCount > 1
            ? `<div class="metric-note latest-purchase-note">Последняя запись за ${escapeHtml(formatDateDisplay(latestEntry["ДатаКП"]))}</div>`
            : ""}
        </div>
        <div class="purchase-metric-card metric-card accent">
          <div class="metric-label">${averageGroups.length === 1 ? "Средняя закупочная цена" : "Средние закупочные цены"}</div>
          ${renderAveragePurchasePrices(averageGroups)}
          <div class="metric-note">${averageGroups.length > 1
            ? "Среднее рассчитано отдельно для каждой валюты"
            : "Учитываются все числовые закупочные цены"}</div>
        </div>
      </div>
      <div class="purchase-list price-list collapsible-list-section" data-expand-list-section="purchase" data-expanded="false">
        <h4>Список закупочных цен</h4>
        ${purchaseEntries.length > 0
          ? purchaseEntries
            .map((entry, index) => renderPurchasePriceCard(entry, index, {
              isOverflow: index >= PURCHASE_LIST_INITIAL_LIMIT
            }))
            .join("")
          : `<div class="empty-value">${EMPTY_TEXT}</div>`}
        ${purchaseEntries.length > PURCHASE_LIST_INITIAL_LIMIT
          ? renderExpandListButton(
            "purchase",
            purchaseEntries.length,
            "Показать все закупочные цены",
            "Свернуть закупочные цены"
          )
          : ""}
      </div>
    </section>
  `;
}

function renderAveragePurchasePrices(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return `<div class="metric-value">${renderEmptyValue(null)}</div>`;
  }

  if (groups.length === 1) {
    const group = groups[0];
    return `
      <div class="metric-value">${escapeHtml(formatAverageMoney(group.average, group.currencyLabel))}</div>
      <div class="average-price-count">Записей: ${escapeHtml(group.count)}</div>
    `;
  }

  return `
    <div class="average-price-list">
      ${groups.map((group) => `
        <div class="average-price-row">
          <span class="average-currency">${escapeHtml(group.currencyLabel)}</span>
          <span class="average-value">${escapeHtml(formatAverageNumber(group.average))}</span>
          <span class="average-price-count">${escapeHtml(group.count)} шт.</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderPurchasePriceCard(entry, index, options = {}) {
  const competitor = isCompetitorEntry(entry);
  const classes = ["purchase-price-card", "price-item", "collapsible-item"];

  if (competitor) {
    classes.push("competitor-price");
  }

  if (options.isOverflow) {
    classes.push("is-collapsed");
  }

  return `
    <article class="${classes.join(" ")}"${options.isOverflow ? ' data-collapsible-overflow="true"' : ""}>
      <div class="price-title purchase-price-card-header">
        <span>${index + 1}. ${renderEmptyValue(entry["Контрагент"])}</span>
        ${competitor ? renderCompetitorBadge() : ""}
      </div>
      ${!isEmptyValue(entry["ТипКонтрагента"]) ? renderFieldRow("Тип контрагента", entry["ТипКонтрагента"]) : ""}
      ${renderFieldRow("Цена закупки", formatMoney(getPurchasePrice(entry), getPurchaseCurrency(entry)))}
      ${!isEmptyValue(entry["ДатаКП"]) ? renderFieldRowHtml("Дата КП", renderDateValue(entry["ДатаКП"])) : ""}
      ${!isEmptyValue(entry["НомерКП"]) ? renderFieldRow("Номер КП", entry["НомерКП"]) : ""}
      ${!isEmptyValue(entry["Клиент"]) || !isEmptyValue(entry["СтатусКП"]) ? `
        <div class="purchase-context">
          ${!isEmptyValue(entry["Клиент"]) ? `<span>${renderEmptyValue(entry["Клиент"])}</span>` : ""}
          ${!isEmptyValue(entry["СтатусКП"])
            ? `<span class="quote-status ${getQuoteStatusClass(entry["СтатусКП"])}">${renderEmptyValue(entry["СтатусКП"])}</span>`
            : ""}
        </div>
      ` : ""}
    </article>
  `;
}

function renderQuoteHistorySection(data) {
  const quoteEntries = getQuoteEntries(data["ИсторияЦен"]);
  const quoteGroups = groupQuoteEntries(quoteEntries);

  return `
    <section class="section-card quote-history-section">
      <h3>История КП / предложений</h3>
      <div class="quote-list collapsible-list-section" data-expand-list-section="quotes" data-expanded="false">
        ${quoteGroups.length > 0
          ? quoteGroups
            .map((group, index) => renderQuoteGroupCard(group, index, {
              isOverflow: index >= QUOTE_GROUPS_INITIAL_LIMIT
            }))
            .join("")
          : `<div class="empty-value">${EMPTY_TEXT}</div>`}
        ${quoteGroups.length > QUOTE_GROUPS_INITIAL_LIMIT
          ? renderExpandListButton(
            "quotes",
            quoteGroups.length,
            "Показать всю историю КП",
            "Свернуть историю КП"
          )
          : ""}
      </div>
    </section>
  `;
}

function renderQuoteGroupCard(group, index, options = {}) {
  const classes = ["quote-group-card", "quote-card", "collapsible-item"];

  if (options.isOverflow) {
    classes.push("is-collapsed");
  }

  return `
    <article class="${classes.join(" ")}"${options.isOverflow ? ' data-collapsible-overflow="true"' : ""}>
      <div class="quote-group-header quote-card-header">
        <div>
          <div class="quote-card-kicker">КП ${index + 1}</div>
          <div class="quote-card-title">КП ${renderEmptyValue(group.number)}</div>
        </div>
        <span class="quote-status ${getQuoteStatusClass(group.status)}">${renderEmptyValue(group.status)}</span>
      </div>
      <div class="quote-meta">
        ${renderFieldRowHtml("Дата КП", renderDateValue(group.date))}
        ${renderFieldRow("Клиент", group.client)}
      </div>
      <div class="quote-offers-title">Предложения: ${escapeHtml(group.entries.length)}</div>
      <div class="quote-offers-list">
        ${group.entries.map((entry, offerIndex) => renderQuoteOfferRow(entry, offerIndex)).join("")}
      </div>
    </article>
  `;
}

function renderQuoteOfferRow(entry, index) {
  const competitor = isCompetitorEntry(entry);
  const classes = ["quote-offer-row"];

  if (competitor) {
    classes.push("competitor-price");
  }

  return `
    <div class="${classes.join(" ")}">
      <div class="quote-offer-header">
        <span>${index + 1}. ${renderEmptyValue(entry["Контрагент"])}</span>
        ${competitor ? renderCompetitorBadge() : ""}
      </div>
      ${!isEmptyValue(entry["ТипКонтрагента"])
        ? `<div class="quote-offer-type">${renderEmptyValue(entry["ТипКонтрагента"])}</div>`
        : ""}
      <div class="quote-offer-prices">
        <div><span>Закупка</span><strong>${escapeHtml(formatMoney(getPurchasePrice(entry), getPurchaseCurrency(entry)))}</strong></div>
        <div><span>Цена КП</span><strong>${escapeHtml(formatMoney(getQuotePrice(entry), getQuoteCurrency(entry)))}</strong></div>
      </div>
    </div>
  `;
}

function renderQuoteCard(entry, index, options = {}) {
  const group = createQuoteGroup([entry], `single:${index}`, index);
  return renderQuoteGroupCard(group, index, options);
}

function renderLatestEfesQuoteSection(data) {
  const result = findLatestEfesQuote(data["ИсторияЦен"]);

  if (result.latestInPeriod) {
    return `
      <section class="section-card latest-efes-quote-section">
        <h3>Последнее КП по Эфес</h3>
        <div class="efes-last-quote-card${isCompetitorEntry(result.latestInPeriod) ? " competitor-price" : ""}">
          ${renderLatestEfesQuoteDetails(result.latestInPeriod)}
        </div>
      </section>
    `;
  }

  return `
    <section class="section-card latest-efes-quote-section">
      <h3>Последнее КП по Эфес</h3>
        <div class="efes-last-quote-empty">За последние 12 месяцев КП по Эфес не найдено</div>
      ${result.latestOverall ? `
        <div class="efes-last-quote-outside-note">Последнее найденное КП по Эфес вне периода 12 месяцев</div>
        <div class="efes-last-quote-card outside-period${isCompetitorEntry(result.latestOverall) ? " competitor-price" : ""}">
          ${renderLatestEfesQuoteDetails(result.latestOverall)}
        </div>
      ` : ""}
    </section>
  `;
}

function renderLatestEfesQuoteDetails(entry) {
  return `
    <div class="quote-card-header">
      <div class="quote-card-title">КП ${renderEmptyValue(entry["НомерКП"])}</div>
      ${isCompetitorEntry(entry) ? renderCompetitorBadge() : ""}
    </div>
    ${renderFieldRowHtml("Дата КП", renderDateValue(entry["ДатаКП"]))}
    ${renderFieldRow("Клиент", entry["Клиент"])}
    ${renderFieldRow("Цена КП", formatMoney(getQuotePrice(entry), getQuoteCurrency(entry)))}
    ${renderFieldRow("Статус КП", entry["СтатусКП"], {
      valueClass: `quote-status ${getQuoteStatusClass(entry["СтатусКП"])}`
    })}
    ${renderFieldRow("Контрагент", entry["Контрагент"])}
    ${isNumberValue(getPurchasePrice(entry))
      ? renderFieldRow("Цена закупки", formatMoney(getPurchasePrice(entry), getPurchaseCurrency(entry)))
      : ""}
  `;
}

function renderCompetitorBadge() {
  return `<span class="competitor-badge">Конкурент</span>`;
}

function renderPricesSection(prices) {
  return renderPurchasePricesSection({ "ИсторияЦен": prices });
}

function renderInfoSection(data) {
  return renderProductSummary(data, "");
}

function renderShipmentsSection(data) {
  return renderDataSection("История поставок", data["ИсторияПоставок"]);
}

function renderClaimsSection(data) {
  return renderDataSection("Данные рекламаций", getClaimsData(data));
}

function renderSapCodesSection(data) {
  const sapCodes = data["СписокСапКодов"];

  if (!Array.isArray(sapCodes) || sapCodes.length === 0) {
    return `
      <section class="section-card sap-codes-section">
        <h3>SAP-коды</h3>
        <div class="empty-value">${EMPTY_TEXT}</div>
      </section>
    `;
  }

  return `
    <section class="section-card sap-codes-section">
      <h3>SAP-коды</h3>
      <div class="records-count">Записей: ${sapCodes.length}</div>
      <div class="records-list sap-codes-list collapsible-list-section" data-expand-list-section="sap" data-expanded="false">
        ${sapCodes.map((item, index) => renderSapCodeItem(item, index, {
          isOverflow: index >= SAP_CODES_INITIAL_LIMIT
        })).join("")}
        ${sapCodes.length > SAP_CODES_INITIAL_LIMIT
          ? renderExpandListButton(
            "sap",
            sapCodes.length,
            "Показать все SAP-коды",
            "Свернуть SAP-коды"
          )
          : ""}
      </div>
    </section>
  `;
}

function renderSapCodeItem(item, index, options = {}) {
  const itemClasses = ["sap-code-card", "record-item", "sap-code-item", "collapsible-item"];

  if (options.isOverflow) {
    itemClasses.push("is-collapsed");
  }

  const itemAttributes = options.isOverflow ? ' data-collapsible-overflow="true"' : "";

  if (item && typeof item === "object" && !Array.isArray(item)) {
    const hasStructuredSapFields = Object.prototype.hasOwnProperty.call(item, "Клиент")
      || Object.prototype.hasOwnProperty.call(item, "SAPКод");

    if (!hasStructuredSapFields) {
      return `
        <article class="${itemClasses.join(" ")}"${itemAttributes}>
          <div class="record-title">${index + 1}.</div>
          ${Object.entries(item).map(([key, value]) => renderFieldRow(key, value)).join("")}
        </article>
      `;
    }

    return `
      <article class="${itemClasses.join(" ")}"${itemAttributes}>
        <div class="record-title">${index + 1}.</div>
        ${renderFieldRow("Клиент", item["Клиент"])}
        ${renderFieldRow("SAP-код", item["SAPКод"])}
      </article>
    `;
  }

  if (typeof item !== "string") {
    return `
      <article class="${itemClasses.join(" ")}"${itemAttributes}>
        <div class="record-title">${index + 1}.</div>
        <div class="field-value">${renderEmptyValue(item)}</div>
      </article>
    `;
  }

  const lastCommaIndex = item.lastIndexOf(",");

  if (lastCommaIndex === -1) {
    return `
      <article class="${itemClasses.join(" ")}"${itemAttributes}>
        <div class="record-title">${index + 1}.</div>
        <div class="field-value">${renderEmptyValue(item)}</div>
      </article>
    `;
  }

  const client = item.slice(0, lastCommaIndex).trim();
  const sapCode = item.slice(lastCommaIndex + 1).trim();

  return `
    <article class="${itemClasses.join(" ")}"${itemAttributes}>
      <div class="record-title">${index + 1}.</div>
      ${renderFieldRow("Клиент", client)}
      ${renderFieldRow("SAP-код", sapCode)}
    </article>
  `;
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

function renderRawJsonBlock(result) {
  if (!SHOW_RAW_1C_RESPONSE) {
    return "";
  }

  const status = result.status === undefined || result.status === null || result.status === ""
    ? "недоступен"
    : result.status;
  const contentType = result.contentType || "";
  const rawText = result.rawText === undefined || result.rawText === null ? "" : String(result.rawText);
  const metaParts = [
    `Код: ${result.code || ""}`,
    `HTTP: ${status}`
  ];

  if (contentType) {
    metaParts.push(`Content-Type: ${contentType}`);
  }

  let prettyJson = "";

  if (Object.prototype.hasOwnProperty.call(result, "data")) {
    try {
      prettyJson = JSON.stringify(result.data, null, 2);
    } catch {
      // Parsed server responses are serializable; keep the raw text if an unexpected value is not.
    }
  }

  const responseBody = prettyJson || rawText || "Тело ответа пустое.";

  return `
    <details class="raw-response-details">
      <summary class="raw-response-summary">Сырой ответ 1С</summary>
      <div class="raw-response-content">
        <div class="raw-json-meta">${metaParts.map((part) => escapeHtml(part)).join(" | ")}</div>
        <pre class="raw-json-pre">${escapeHtml(responseBody)}</pre>
      </div>
    </details>
  `;
}

function renderRawResponseBlock(result) {
  return renderRawJsonBlock(result);
}

function renderBackendErrorResponse(status, statusText, data, rawText, diagnosticResult) {
  resultBlock.className = "result-card";
  resultBlock.innerHTML = `${renderBackendErrorSection(status, statusText, data, rawText, {
    showTechnicalResponse: !diagnosticResult
  })}${diagnosticResult ? renderRawResponseBlock(diagnosticResult) : ""}`;
}

function renderBackendErrorSection(status, statusText, data, rawText, options = {}) {
  const showTechnicalResponse = options.showTechnicalResponse !== false;

  return `
    <section class="section-card error-card">
      <h3>1С вернула ошибку</h3>
      ${renderFieldRow("HTTP-статус", `${status} ${statusText || ""}`.trim())}
      ${data && typeof data === "object" && !Array.isArray(data)
        ? renderStructuredValue(data)
        : renderFieldRow("Ответ", data)}
      ${showTechnicalResponse ? `<details class="details-block">
        <summary>Технический ответ</summary>
        <pre class="technical-response">${escapeHtml(rawText || "Тело ответа пустое.")}</pre>
      </details>` : ""}
    </section>
  `;
}

function getLastPrice(prices) {
  return Array.isArray(prices) && prices.length > 0 ? prices[prices.length - 1] : null;
}

function renderSummaryField(label, value, options = {}) {
  const itemClasses = ["summary-item"];
  const valueClasses = ["field-value"];

  if (options.featured) {
    itemClasses.push("summary-item-featured");
  }

  if (options.fullWidth) {
    itemClasses.push("summary-item-wide");
  }

  if (options.multiline) {
    valueClasses.push("multiline-value");
  }

  return `
    <div class="${itemClasses.join(" ")}">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="${valueClasses.join(" ")}">${renderEmptyValue(value)}</div>
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

function renderFieldRow(label, value, options = {}) {
  const valueHtml = value && typeof value === "object"
    ? renderStructuredValue(value)
    : renderEmptyValue(value);
  const valueClasses = ["field-value"];

  if (options.multiline) {
    valueClasses.push("multiline-value");
  }

  if (options.valueClass) {
    valueClasses.push(options.valueClass);
  }

  return `
    <div class="field-row">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="${valueClasses.join(" ")}">${valueHtml}</div>
    </div>
  `;
}

function renderFieldRowHtml(label, valueHtml) {
  return `
    <div class="field-row">
      <div class="field-label">${escapeHtml(label)}</div>
      <div class="field-value">${valueHtml}</div>
    </div>
  `;
}

function renderCurrency(currency) {
  return isEmptyValue(currency) ? "" : escapeHtml(normalizePurchaseCurrency(currency).currencyLabel);
}

function renderPriceValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return escapeHtml(formatMoneyNumber(value));
  }

  return escapeHtml(value);
}

function renderTechnicalFallback(message, rawText, diagnosticResult) {
  resultBlock.className = "result-card";
  resultBlock.innerHTML = `${renderTechnicalFallbackSection(message, rawText, {
    showTechnicalResponse: !diagnosticResult
  })}${diagnosticResult ? renderRawResponseBlock(diagnosticResult) : ""}`;
}

function renderTechnicalFallbackSection(message, rawText, options = {}) {
  const showTechnicalResponse = options.showTechnicalResponse !== false;

  return `
    <section class="section-card error-card">
      <h3>${escapeHtml(message)}</h3>
      ${showTechnicalResponse ? `<details class="details-block">
        <summary>Технический ответ</summary>
        <pre class="technical-response">${escapeHtml(rawText)}</pre>
      </details>` : ""}
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
  const resultView = buildResultView(result.data, result.code, {
    showTechnicalResponse: false
  });

  return `
    <article class="code-result-card success">
      <header class="code-result-header">
        <h3>Код: ${escapeHtml(result.code)}</h3>
        <span class="code-result-badge ok">HTTP ${escapeHtml(result.status)}</span>
      </header>
      <div class="${escapeHtml(resultView.className)} nested-result">
        ${resultView.html}
      </div>
      ${renderRawResponseBlock(result)}
    </article>
  `;
}

function renderMultiErrorCard(result) {
  const statusValue = result.status ? `HTTP ${result.status}` : "";

  return `
    <article class="code-result-card failed">
      <header class="code-result-header">
        <h3>Код: ${escapeHtml(result.code || "")}</h3>
        <span class="code-result-badge error">Ошибка</span>
      </header>
      <section class="section-card error-card">
        ${statusValue ? renderFieldRow("HTTP-статус", statusValue) : ""}
        ${renderFieldRow("Сообщение", result.error || "Запрос завершился ошибкой.")}
      </section>
      ${renderRawResponseBlock(result)}
    </article>
  `;
}

function setResultMessage(message) {
  resultBlock.className = "result-card empty";
  resultBlock.textContent = message;
}

function handleResultClick(event) {
  const target = event && event.target;

  if (!target || typeof target.closest !== "function") {
    return;
  }

  const button = target.closest("button[data-expand-list]");

  if (button) {
    toggleExpandableList(button);
  }
}

function toggleExpandableList(button) {
  if (!button || typeof button.closest !== "function") {
    return false;
  }

  const section = button.closest("[data-expand-list-section]");

  if (!section || typeof section.querySelectorAll !== "function") {
    return false;
  }

  const isExpanded = button.getAttribute("aria-expanded") === "true";
  const nextExpanded = !isExpanded;
  const overflowItems = section.querySelectorAll("[data-collapsible-overflow='true']");

  overflowItems.forEach((item) => {
    item.classList.toggle("is-collapsed", !nextExpanded);
  });

  section.dataset.expanded = String(nextExpanded);
  button.setAttribute("aria-expanded", String(nextExpanded));
  button.textContent = nextExpanded
    ? button.dataset.collapseLabel
    : `${button.dataset.expandLabel} (${button.dataset.total})`;

  return nextExpanded;
}

function renderExpandListButton(listName, total, expandLabel, collapseLabel) {
  return `
    <button
      type="button"
      class="expand-list-button"
      data-expand-list="${escapeHtml(listName)}"
      data-expand-label="${escapeHtml(expandLabel)}"
      data-collapse-label="${escapeHtml(collapseLabel)}"
      data-total="${escapeHtml(total)}"
      aria-expanded="false"
    >${escapeHtml(expandLabel)} (${escapeHtml(total)})</button>
  `;
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

function formatEmpty(value) {
  return isEmptyValue(value) ? EMPTY_TEXT : String(value);
}

function isNumberValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundMoneyValue(value) {
  return Math.round((value + Math.sign(value || 1) * 1e-9) * 100) / 100;
}

function addThousandsSeparators(value) {
  const parts = String(value).split(".");
  const sign = parts[0].startsWith("-") ? "-" : "";
  const integerDigits = sign ? parts[0].slice(1) : parts[0];
  const formattedInteger = integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  return `${sign}${formattedInteger}${parts.length > 1 ? `.${parts[1]}` : ""}`;
}

function formatMoneyNumber(value) {
  if (!isNumberValue(value)) {
    return String(value);
  }

  const rounded = roundMoneyValue(value);
  const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);

  return addThousandsSeparators(formatted);
}

function formatAverageNumber(value) {
  return isNumberValue(value)
    ? addThousandsSeparators(roundMoneyValue(value).toFixed(2))
    : EMPTY_TEXT;
}

function formatMoney(value, currency) {
  if (isEmptyValue(value)) {
    return EMPTY_TEXT;
  }

  const formattedValue = isNumberValue(value) ? formatMoneyNumber(value) : String(value);
  const formattedCurrency = normalizePurchaseCurrency(currency).currencyLabel;

  return `${formattedValue} ${formattedCurrency}`;
}

function formatAverageMoney(value, currencyLabel) {
  return `${formatAverageNumber(value)} ${isEmptyValue(currencyLabel) ? EMPTY_TEXT : currencyLabel}`;
}

function normalizeText(value) {
  return isEmptyValue(value) ? "" : String(value).trim().toLowerCase();
}

function normalizePurchaseCurrency(value) {
  if (isEmptyValue(value)) {
    return {
      currencyKey: "NO_CURRENCY",
      currencyLabel: EMPTY_TEXT
    };
  }

  const normalized = String(value).trim().replace(/\s+/g, " ").toUpperCase();

  if (["РУБ.", "РУБ", "RUB", "₽"].includes(normalized)) {
    return {
      currencyKey: "RUB",
      currencyLabel: "Руб."
    };
  }

  if (["EUR", "€"].includes(normalized)) {
    return {
      currencyKey: "EUR",
      currencyLabel: "EUR"
    };
  }

  return {
    currencyKey: normalized,
    currencyLabel: normalized
  };
}

function isCompetitorEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }

  return entry["ЭтоКонкурент"] === true
    || normalizeText(entry["ТипКонтрагента"]) === "конкурент";
}

function getPurchasePrice(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  if (isNumberValue(entry["ЦенаЗакупки"])) {
    return entry["ЦенаЗакупки"];
  }

  return isNumberValue(entry["Цена"]) ? entry["Цена"] : null;
}

function getPurchaseCurrency(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }

  if (!isEmptyValue(entry["ВалютаЗакупки"])) {
    return String(entry["ВалютаЗакупки"]).trim();
  }

  return isEmptyValue(entry["Валюта"]) ? "" : String(entry["Валюта"]).trim();
}

function getQuotePrice(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry["ЦенаКП"]
    : null;
}

function getQuoteCurrency(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || isEmptyValue(entry["ВалютаКП"])) {
    return "";
  }

  return String(entry["ВалютаКП"]).trim();
}

function hasQuotePrice(entry) {
  const value = getQuotePrice(entry);
  return isNumberValue(value) || (typeof value === "string" && value.trim() !== "");
}

function hasQuoteData(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }

  return !isEmptyValue(entry["ДатаКП"])
    || !isEmptyValue(entry["НомерКП"])
    || hasQuotePrice(entry);
}

function getPurchaseEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.filter((entry) => isNumberValue(getPurchasePrice(entry)));
}

function getQuoteEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.filter((entry) => hasQuoteData(entry));
}

function findLatestPurchaseEntry(entries) {
  return getLatestPurchaseSelection(entries).entry;
}

function getLatestPurchaseSelection(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entry: null,
      latestDate: null,
      sameLatestDateCount: 0
    };
  }

  let latestDatedEntry = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  let sameLatestDateCount = 0;

  entries.forEach((entry) => {
    const parsedDate = parseDateSafe(entry && entry["ДатаКП"]);

    if (!parsedDate) {
      return;
    }

    const timestamp = parsedDate.getTime();

    if (timestamp > latestTimestamp) {
      latestDatedEntry = entry;
      latestTimestamp = timestamp;
      sameLatestDateCount = 1;
      return;
    }

    if (timestamp === latestTimestamp) {
      latestDatedEntry = entry;
      sameLatestDateCount += 1;
    }
  });

  if (latestDatedEntry) {
    return {
      entry: latestDatedEntry,
      latestDate: new Date(latestTimestamp),
      sameLatestDateCount
    };
  }

  return {
    entry: entries[entries.length - 1],
    latestDate: null,
    sameLatestDateCount: 0
  };
}

function calculateAveragePurchasePricesByCurrency(entries) {
  const purchaseEntries = getPurchaseEntries(entries);

  if (purchaseEntries.length === 0) {
    return [];
  }

  const groups = new Map();

  purchaseEntries.forEach((entry) => {
    const currency = normalizePurchaseCurrency(getPurchaseCurrency(entry));

    if (!groups.has(currency.currencyKey)) {
      groups.set(currency.currencyKey, {
        currencyKey: currency.currencyKey,
        currencyLabel: currency.currencyLabel,
        sum: 0,
        count: 0
      });
    }

    const group = groups.get(currency.currencyKey);
    group.sum += getPurchasePrice(entry);
    group.count += 1;
  });

  return [...groups.values()].map((group) => ({
    currencyKey: group.currencyKey,
    currencyLabel: group.currencyLabel,
    average: roundMoneyValue(group.sum / group.count),
    count: group.count
  }));
}

function calculateAveragePurchasePrice(entries) {
  const groups = calculateAveragePurchasePricesByCurrency(entries);

  if (groups.length === 0) {
    return null;
  }

  if (groups.length === 1) {
    return {
      value: formatAverageNumber(groups[0].average).replaceAll(" ", ""),
      currency: groups[0].currencyLabel === EMPTY_TEXT ? "" : groups[0].currencyLabel,
      count: groups[0].count,
      groups
    };
  }

  return {
    value: null,
    currency: "",
    count: groups.reduce((total, group) => total + group.count, 0),
    groups
  };
}

function calculateAveragePrice(prices) {
  return calculateAveragePurchasePrice(prices);
}

function parseDateSafe(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const normalizedValue = value.trim();
  const isoDateMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateMatch) {
    const year = Number(isoDateMatch[1]);
    const month = Number(isoDateMatch[2]);
    const day = Number(isoDateMatch[3]);
    const parsedIsoDate = new Date(Date.UTC(year, month - 1, day));

    if (
      parsedIsoDate.getUTCFullYear() !== year
      || parsedIsoDate.getUTCMonth() !== month - 1
      || parsedIsoDate.getUTCDate() !== day
    ) {
      return null;
    }

    return parsedIsoDate;
  }

  const parsedDate = new Date(normalizedValue);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function formatDateDisplay(value) {
  const parsedDate = parseDateSafe(value);

  if (!parsedDate) {
    return formatEmpty(value);
  }

  const day = String(parsedDate.getUTCDate()).padStart(2, "0");
  const month = String(parsedDate.getUTCMonth() + 1).padStart(2, "0");
  const year = parsedDate.getUTCFullYear();

  return `${day}.${month}.${year}`;
}

function renderDateValue(value) {
  const parsedDate = parseDateSafe(value);

  if (!parsedDate) {
    return renderEmptyValue(value);
  }

  return `<time datetime="${escapeHtml(String(value).trim())}">${escapeHtml(formatDateDisplay(value))}</time>`;
}

function getFirstNonEmptyEntryValue(entries, key) {
  const entry = entries.find((item) => item && !isEmptyValue(item[key]));
  return entry ? entry[key] : null;
}

function createQuoteGroup(entries, key, sourceIndex) {
  const dates = entries
    .map((entry) => parseDateSafe(entry && entry["ДатаКП"]))
    .filter((date) => date !== null);

  return {
    key,
    sourceIndex,
    number: getFirstNonEmptyEntryValue(entries, "НомерКП"),
    date: getFirstNonEmptyEntryValue(entries, "ДатаКП"),
    client: getFirstNonEmptyEntryValue(entries, "Клиент"),
    status: getFirstNonEmptyEntryValue(entries, "СтатусКП"),
    sortTimestamp: dates.length > 0
      ? Math.max(...dates.map((date) => date.getTime()))
      : null,
    entries: [...entries]
  };
}

function getQuoteGroupKey(entry, index) {
  if (!isEmptyValue(entry && entry["НомерКП"])) {
    return `number:${String(entry["НомерКП"]).trim()}`;
  }

  const date = isEmptyValue(entry && entry["ДатаКП"]) ? "" : String(entry["ДатаКП"]).trim();
  const client = normalizeText(entry && entry["Клиент"]);

  if (date !== "" || client !== "") {
    return `fallback:${date}|${client}`;
  }

  return `ungrouped:${index}`;
}

function groupQuoteEntries(entries) {
  const quoteEntries = getQuoteEntries(entries);
  const groupedEntries = new Map();

  quoteEntries.forEach((entry, index) => {
    const key = getQuoteGroupKey(entry, index);

    if (!groupedEntries.has(key)) {
      groupedEntries.set(key, {
        entries: [],
        sourceIndex: index
      });
    }

    groupedEntries.get(key).entries.push(entry);
  });

  return [...groupedEntries.entries()]
    .map(([key, group]) => createQuoteGroup(group.entries, key, group.sourceIndex))
    .sort((left, right) => {
      if (left.sortTimestamp !== null && right.sortTimestamp !== null) {
        return right.sortTimestamp - left.sortTimestamp || left.sourceIndex - right.sourceIndex;
      }

      if (left.sortTimestamp !== null) {
        return -1;
      }

      if (right.sortTimestamp !== null) {
        return 1;
      }

      return left.sourceIndex - right.sourceIndex;
    });
}

function getQuoteStatusClass(status) {
  const normalizedStatus = normalizeText(status);

  if (normalizedStatus === "") {
    return "status-neutral";
  }

  const rejectedMarkers = ["отклонено", "отказ", "проиграно", "отменено"];
  const pendingMarkers = ["на рассмотрении", "в работе", "отправлено", "ожидает", "согласование"];
  const successMarkers = ["выполнено", "согласовано", "принято", "заказ", "выиграно"];

  if (rejectedMarkers.some((marker) => normalizedStatus.includes(marker))) {
    return "status-rejected";
  }

  if (pendingMarkers.some((marker) => normalizedStatus.includes(marker))) {
    return "status-pending";
  }

  if (successMarkers.some((marker) => normalizedStatus.includes(marker))) {
    return "status-success";
  }

  return "status-neutral";
}

function isEfesClient(value) {
  const client = normalizeText(value);
  const efesMarkers = ["эфес", "инбев эфес", "аб инбев эфес", "ab inbev efes"];

  return client !== "" && efesMarkers.some((marker) => client.includes(marker));
}

function findLatestEfesQuote(entries, now = new Date()) {
  const currentDate = parseDateSafe(now) || new Date();
  const periodStart = new Date(currentDate.getTime());
  periodStart.setMonth(periodStart.getMonth() - 12);

  const candidates = getQuoteEntries(entries)
    .filter((entry) => isEfesClient(entry["Клиент"]) && hasQuotePrice(entry))
    .map((entry) => ({
      entry,
      date: parseDateSafe(entry["ДатаКП"])
    }))
    .filter((candidate) => (
      candidate.date !== null
      && candidate.date.getTime() <= currentDate.getTime()
    ))
    .sort((left, right) => right.date.getTime() - left.date.getTime());
  const withinPeriod = candidates.filter((candidate) => (
    candidate.date.getTime() >= periodStart.getTime()
  ));

  return {
    latestInPeriod: withinPeriod.length > 0 ? withinPeriod[0].entry : null,
    latestOverall: candidates.length > 0 ? candidates[0].entry : null,
    periodStart,
    now: currentDate
  };
}

function normalizeNumber(value) {
  return isNumberValue(value) ? value : null;
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
