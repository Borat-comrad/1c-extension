const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(projectRoot, "price_history_new_contract_test_responses.json");
const popupPath = path.join(projectRoot, "popup.js");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const popupSource = fs.readFileSync(popupPath, "utf8");

function createElement(id) {
  return {
    id,
    value: "",
    textContent: "",
    className: "",
    innerHTML: "",
    disabled: false,
    addEventListener() {}
  };
}

function createContext() {
  const elements = {};
  const context = {
    console,
    TextEncoder,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements[id]) {
          elements[id] = createElement(id);
        }

        return elements[id];
      }
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {},
          async remove() {}
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(popupSource, context);
  return context;
}

function addCheck(checks, name, passed) {
  checks.push({ name, passed: Boolean(passed) });
}

function countOccurrences(text, pattern) {
  return (text.match(new RegExp(pattern, "g")) || []).length;
}

function findCard(html, className, text) {
  const pattern = new RegExp(`<article class="[^"]*${className}[^"]*">[\\s\\S]*?<\\/article>`, "g");
  return (html.match(pattern) || []).find((card) => card.includes(text)) || "";
}

function buildResult(testCase, checks) {
  const failedChecks = checks.filter((check) => !check.passed);
  return {
    id: testCase.id,
    title: testCase.title,
    status: failedChecks.length === 0 ? "pass" : "fail",
    checks,
    failedChecks
  };
}

function runCase(testCase) {
  const context = createContext();
  const checks = [];
  const view = context.buildResultView(testCase.response, testCase.inputCode);
  const html = view.html;
  const history = testCase.response["ИсторияЦен"];

  addCheck(checks, "Ответ распознан новым renderer", !html.includes("формат отличается от ожидаемого"));
  addCheck(checks, "Карточка детали присутствует", html.includes("product-summary-card"));
  addCheck(checks, "Закупки и КП разделены", html.includes("Закупочные цены") && html.includes("История КП / предложений"));

  if (testCase.id === "NC01") {
    const rawHtml = context.renderRawJsonBlock({
      code: testCase.inputCode,
      status: 200,
      contentType: "application/json",
      rawText: JSON.stringify(testCase.response),
      data: testCase.response
    });

    addCheck(checks, "Бренд показан в summary", html.includes("Бренд") && html.includes("GEA Grasso"));
    addCheck(checks, "Многострочное наименование использует multiline-value", html.includes("multiline-value") && html.includes("IP65 4.....20MA"));
    addCheck(checks, "Закупочная цена показана отдельно", html.includes("1632.80 EUR") && html.includes("purchase-price-card"));
    addCheck(checks, "Цена КП показана отдельно", html.includes("2612 EUR") && html.includes("quote-card"));
    addCheck(checks, "Дата и номер КП показаны", html.includes("2026-06-12") && html.includes("БЕВ26-КП-00008412"));
    addCheck(checks, "SAP-код объектом показан", html.includes("sap-code-card") && html.includes("Балтика группа пивоваренных компаний") && html.includes("d1.711.450.003"));
    addCheck(checks, "Сырой JSON остаётся видимым и экранированным", rawHtml.includes("raw-json-block") && rawHtml.includes("Сырой JSON от 1С") && rawHtml.includes("&quot;ИсторияЦен&quot;"));
  }

  if (testCase.id === "NC02") {
    addCheck(checks, "Закупочная цена есть", html.includes("420 EUR"));
    addCheck(checks, "Пустая история КП не падает", html.includes("quote-history-section") && !html.includes('class="quote-card'));
    addCheck(checks, "Пустая история КП показывает нет данных", html.includes("История КП / предложений") && html.includes("нет данных"));
  }

  if (testCase.id === "NC03") {
    const latest = context.findLatestEfesQuote(history, new Date("2026-07-01T12:00:00Z"));
    const purchaseHtml = context.renderPurchasePricesSection(testCase.response);
    const quoteHtml = context.renderQuoteHistorySection(testCase.response);

    addCheck(checks, "Блок последнего КП по Эфес показан", html.includes("Последнее КП по Эфес") && html.includes("efes-last-quote-card"));
    addCheck(checks, "Выбрано самое свежее КП Эфес в фиксированном периоде", latest.latestInPeriod && latest.latestInPeriod["НомерКП"] === "EFES-LATEST");
    addCheck(checks, "В UI показано самое свежее КП Эфес", html.includes("EFES-LATEST"));
    addCheck(checks, "Цена только КП не попала в закупки", !purchaseHtml.includes("999 EUR") && quoteHtml.includes("999 EUR"));
    addCheck(checks, "Некорректная дата безопасно отклоняется", context.parseDateSafe("2026-99-99") === null);
  }

  if (testCase.id === "NC04") {
    addCheck(checks, "Старое поле Цена работает как закупка", html.includes("106.31 EUR") && html.includes("purchase-price-card"));
    addCheck(checks, "Старая Валюта используется как fallback", context.getPurchaseCurrency(history[0]) === "EUR");
    addCheck(checks, "Старая SAP-строка разобрана по последней запятой", html.includes("Клиент") && html.includes("Балтика группа пивоваренных компаний") && html.includes("d1.821.601.068"));
    addCheck(checks, "Строковые цены не входят в среднее", context.calculateAveragePurchasePrice([
      { "Цена": 10, "Валюта": "EUR" },
      { "Цена": "20", "Валюта": "EUR" }
    ]).value === "10.00");
  }

  if (testCase.id === "NC05") {
    addCheck(checks, "Пустой производитель показан как нет данных", html.includes("Производитель оборудования") && html.includes("нет данных"));
    addCheck(checks, "Группа показана независимо от производителя", html.includes("Группа / производитель") && html.includes("Резервная группа"));
    addCheck(checks, "Пустой код конечного производителя не ломает summary", html.includes("Код конечного производителя"));
    addCheck(checks, "Пустая валюта показана как нет данных", html.includes("25 нет данных"));
    addCheck(checks, "Пустая ЦенаКП не создаёт карточку КП", !html.includes('class="quote-card'));
  }

  if (testCase.id === "NC06") {
    const purchaseHtml = context.renderPurchasePricesSection(testCase.response);
    const quoteHtml = context.renderQuoteHistorySection(testCase.response);
    const nameOnlyPurchaseCard = findCard(purchaseHtml, "purchase-price-card", "КИП");
    const nameOnlyQuoteCard = findCard(quoteHtml, "quote-card", "КИП");

    addCheck(checks, "ЭтоКонкурент true распознаётся", context.isCompetitorEntry(history[0]));
    addCheck(checks, "ТипКонтрагента Конкурент распознаётся после нормализации", context.isCompetitorEntry(history[1]));
    addCheck(checks, "Название без структурированного признака не распознаётся", !context.isCompetitorEntry(history[2]));
    addCheck(checks, "Две закупочные строки конкурентов выделены", countOccurrences(purchaseHtml, "competitor-price") === 2);
    addCheck(checks, "Две карточки КП конкурентов выделены", countOccurrences(quoteHtml, "competitor-price") === 2);
    addCheck(checks, "Бейдж Конкурент показан", countOccurrences(`${purchaseHtml}${quoteHtml}`, "competitor-badge") === 4);
    addCheck(checks, "Строка с названием КИП не выделена автоматически", nameOnlyPurchaseCard !== "" && nameOnlyQuoteCard !== "" && !nameOnlyPurchaseCard.includes("competitor-price") && !nameOnlyQuoteCard.includes("competitor-price"));
    addCheck(checks, "Среднее включает конкурентные строки", html.includes("110.00 EUR"));
    addCheck(checks, "В popup.js нет хардкода названий", !popupSource.includes("КИП") && !popupSource.includes("Сталкер"));
  }

  return buildResult(testCase, checks);
}

const results = fixture.testCases.map(runCase);
const failed = results.filter((result) => result.status === "fail");

console.log(JSON.stringify({
  fixturePath,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
