const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const popupPath = path.join(projectRoot, "popup.js");
const popupSource = fs.readFileSync(popupPath, "utf8");

function createElement(id) {
  return {
    id,
    value: "",
    textContent: "",
    className: "",
    innerHTML: "",
    disabled: false,
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }
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
  return { context, elements };
}

function addCheck(checks, name, passed) {
  checks.push({ name, passed: Boolean(passed) });
}

function countOccurrences(text, pattern) {
  return (text.match(new RegExp(pattern, "g")) || []).length;
}

function buildResult(id, title, checks) {
  const failedChecks = checks.filter((check) => !check.passed);
  return {
    id,
    title,
    status: failedChecks.length === 0 ? "pass" : "fail",
    checks,
    failedChecks
  };
}

function createClassList(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    toggle(className, force) {
      if (force) {
        classes.add(className);
      } else {
        classes.delete(className);
      }
    },
    contains(className) {
      return classes.has(className);
    }
  };
}

function createExpandableHarness(total, expandLabel, collapseLabel) {
  const items = Array.from({ length: total }, () => ({
    classList: createClassList(["is-collapsed"])
  }));
  const section = {
    dataset: { expanded: "false" },
    querySelectorAll() {
      return items;
    }
  };
  const attributes = new Map([["aria-expanded", "false"]]);
  const button = {
    dataset: {
      expandLabel,
      collapseLabel,
      total: String(total)
    },
    textContent: `${expandLabel} (${total})`,
    closest() {
      return section;
    },
    getAttribute(name) {
      return attributes.get(name);
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };

  return { button, section, items };
}

function runCurrencyAveragesCase() {
  const { context } = createContext();
  const checks = [];
  const entries = [
    { "ЦенаЗакупки": 41770.2, "ВалютаЗакупки": " Руб. " },
    { "ЦенаЗакупки": 3848, "ВалютаЗакупки": "руб" },
    { "ЦенаЗакупки": 3945, "ВалютаЗакупки": "RUB" },
    { "ЦенаЗакупки": 3990, "ВалютаЗакупки": "₽" },
    { "ЦенаЗакупки": 4468, "ВалютаЗакупки": "РУБ." },
    { "ЦенаЗакупки": 101.44, "ВалютаЗакупки": "eur" },
    { "ЦенаЗакупки": 106.31, "ВалютаЗакупки": "€" }
  ];
  const groups = context.calculateAveragePurchasePricesByCurrency(entries);
  const rub = groups.find((group) => group.currencyKey === "RUB");
  const eur = groups.find((group) => group.currencyKey === "EUR");
  const html = context.renderPurchasePricesSection({ "ИсторияЦен": entries });

  addCheck(checks, "Созданы две валютные группы", groups.length === 2);
  addCheck(checks, "Рублёвые варианты нормализованы", rub && rub.currencyLabel === "Руб." && rub.count === 5);
  addCheck(checks, "EUR-варианты нормализованы", eur && eur.currencyLabel === "EUR" && eur.count === 2);
  addCheck(checks, "Средняя рублей рассчитана отдельно", rub && rub.average === 11604.24);
  addCheck(checks, "Средняя EUR рассчитана отдельно", eur && eur.average === 103.88);
  addCheck(checks, "В UI нет единого среднего разных валют", !html.includes("разные валюты") && !html.includes("8318.42") && !html.includes("7340.77"));
  addCheck(checks, "Денежный формат использует разделитель тысяч", context.formatMoney(41770.2, "руб") === "41 770.20 Руб." && context.formatMoney(3848, "RUB") === "3 848 Руб.");

  return buildResult("UF01", "Средние закупочные цены по валютам", checks);
}

function runLatestPurchaseCase() {
  const { context } = createContext();
  const checks = [];
  const entries = [
    { id: "older", "ДатаКП": "2026-07-01", "ЦенаЗакупки": 10 },
    { id: "latest-first", "ДатаКП": "2026-07-14", "ЦенаЗакупки": 20 },
    { id: "invalid", "ДатаКП": "bad-date", "ЦенаЗакупки": 30 },
    { id: "latest-last", "ДатаКП": "2026-07-14", "ЦенаЗакупки": 40 }
  ];
  const selection = context.getLatestPurchaseSelection(entries);
  const noDates = context.getLatestPurchaseSelection([
    { id: "first", "ЦенаЗакупки": 1 },
    { id: "last", "ЦенаЗакупки": 2 }
  ]);
  const originalOrder = entries.map((entry) => entry.id).join(",");

  addCheck(checks, "Выбрана запись с максимальной датой", selection.entry && selection.entry.id === "latest-last");
  addCheck(checks, "При одинаковой дате выбрана последняя исходная строка", selection.sameLatestDateCount === 2);
  addCheck(checks, "Без дат выбран последний элемент", noDates.entry && noDates.entry.id === "last");
  addCheck(checks, "Исходный массив не сортируется на месте", entries.map((entry) => entry.id).join(",") === originalOrder);
  addCheck(checks, "Дата подписи форматируется для пользователя", context.formatDateDisplay("2026-07-14") === "14.07.2026");

  return buildResult("UF02", "Детерминированная последняя закупочная цена", checks);
}

function runQuoteGroupingCase() {
  const { context } = createContext();
  const checks = [];
  const sharedNumber = "БЕВ26-КП-00006728";
  const entries = [
    {
      "ДатаКП": "2026-07-06",
      "НомерКП": sharedNumber,
      "Клиент": "АБ ИнБев Эфес в г. Калуга АО",
      "Контрагент": "BBM SERVICE SRL.",
      "ЦенаЗакупки": 106.31,
      "ВалютаЗакупки": "EUR",
      "ЦенаКП": 212.7,
      "ВалютаКП": "EUR",
      "СтатусКП": "На рассмотрении"
    },
    {
      "ДатаКП": "2026-07-06",
      "НомерКП": sharedNumber,
      "Клиент": "АБ ИнБев Эфес в г. Калуга АО",
      "Контрагент": "Лайнком",
      "ЦенаЗакупки": 3848,
      "ВалютаЗакупки": "Руб.",
      "ЦенаКП": 84.1,
      "ВалютаКП": "EUR",
      "СтатусКП": "На рассмотрении"
    },
    {
      "ДатаКП": "2026-07-06",
      "НомерКП": sharedNumber,
      "Клиент": "АБ ИнБев Эфес в г. Калуга АО",
      "Контрагент": "Лайнком",
      "ЦенаЗакупки": 3990,
      "ВалютаЗакупки": "Руб.",
      "ЦенаКП": 84.1,
      "ВалютаКП": "EUR",
      "СтатусКП": "На рассмотрении"
    }
  ];
  const groups = context.groupQuoteEntries(entries);
  const html = context.renderQuoteHistorySection({ "ИсторияЦен": entries });

  addCheck(checks, "Одинаковый номер создаёт одну группу", groups.length === 1 && countOccurrences(html, "quote-group-card") === 1);
  addCheck(checks, "Все строки предложения сохранены", groups[0].entries.length === 3 && countOccurrences(html, "quote-offer-row") === 3);
  addCheck(checks, "Одинаковый поставщик с разными ценами не объединён", countOccurrences(html, "Лайнком") === 2 && html.includes("3 848 Руб.") && html.includes("3 990 Руб."));
  addCheck(checks, "Статус группы промежуточный", html.includes("status-pending"));
  addCheck(checks, "Цена КП привязана к строке поставщика", html.includes("212.70 EUR") && countOccurrences(html, "84.10 EUR") === 2);

  return buildResult("UF03", "Группировка истории КП", checks);
}

function runStatusCase() {
  const { context } = createContext();
  const checks = [];

  addCheck(checks, "На рассмотрении → pending", context.getQuoteStatusClass("  На рассмотрении ") === "status-pending");
  addCheck(checks, "Выполнено → success", context.getQuoteStatusClass("ВЫПОЛНЕНО") === "status-success");
  addCheck(checks, "Отклонено → rejected", context.getQuoteStatusClass("Отклонено") === "status-rejected");
  addCheck(checks, "Неизвестный статус → neutral", context.getQuoteStatusClass("Новый внутренний статус") === "status-neutral");
  addCheck(checks, "Пустой статус → neutral", context.getQuoteStatusClass("") === "status-neutral");

  return buildResult("UF04", "Семантика статусов КП", checks);
}

function runCollapsingCase() {
  const { context } = createContext();
  const checks = [];
  const purchaseEntries = Array.from({ length: 9 }, (_, index) => ({
    "Контрагент": `Поставщик ${index + 1}`,
    "ЦенаЗакупки": index + 1,
    "ВалютаЗакупки": "EUR"
  }));
  const purchaseHtml = context.renderPurchasePricesSection({ "ИсторияЦен": purchaseEntries });
  const openingCards = purchaseHtml.match(/<article class="[^"]*purchase-price-card[^"]*"/g) || [];
  const firstHarness = createExpandableHarness(5, "Показать все закупочные цены", "Свернуть закупочные цены");
  const secondHarness = createExpandableHarness(5, "Показать все закупочные цены", "Свернуть закупочные цены");

  addCheck(checks, "При 9 закупках отрисованы все данные", openingCards.length === 9);
  addCheck(checks, "По умолчанию видимы только первые 4", openingCards.filter((card) => !card.includes("is-collapsed")).length === 4);
  addCheck(checks, "Есть доступная кнопка раскрытия", purchaseHtml.includes('type="button"') && purchaseHtml.includes("Показать все закупочные цены (9)") && purchaseHtml.includes('aria-expanded="false"'));

  context.toggleExpandableList(firstHarness.button);
  addCheck(checks, "Первое нажатие раскрывает полный список", firstHarness.items.every((item) => !item.classList.contains("is-collapsed")) && firstHarness.button.textContent === "Свернуть закупочные цены");
  addCheck(checks, "Второй результат остаётся свёрнутым", secondHarness.items.every((item) => item.classList.contains("is-collapsed")) && secondHarness.button.getAttribute("aria-expanded") === "false");

  context.toggleExpandableList(firstHarness.button);
  addCheck(checks, "Повторное нажатие сворачивает список", firstHarness.items.every((item) => item.classList.contains("is-collapsed")) && firstHarness.button.textContent === "Показать все закупочные цены (5)");

  const quoteEntries = Array.from({ length: 5 }, (_, index) => ({
    "ДатаКП": `2026-07-${String(index + 1).padStart(2, "0")}`,
    "НомерКП": `КП-${index + 1}`,
    "Клиент": "Клиент",
    "ЦенаКП": 10 + index,
    "ВалютаКП": "EUR"
  }));
  const quoteHtml = context.renderQuoteHistorySection({ "ИсторияЦен": quoteEntries });
  const quoteCards = quoteHtml.match(/<article class="[^"]*quote-group-card[^"]*"/g) || [];
  addCheck(checks, "История КП показывает первые 3 группы", quoteCards.length === 5 && quoteCards.filter((card) => !card.includes("is-collapsed")).length === 3);

  return buildResult("UF05", "Независимое сворачивание списков", checks);
}

function runDiagnosticCase() {
  const { context, elements } = createContext();
  const checks = [];
  const data = { "ИсторияЦен": [{ "Цена": 10, "Валюта": "EUR" }] };
  const rawText = JSON.stringify(data);
  const block = context.renderRawJsonBlock({
    code: "A",
    status: 200,
    contentType: "application/json; charset=utf-8",
    rawText,
    data
  });

  addCheck(checks, "Диагностика — один закрытый details", countOccurrences(block, "raw-response-details") === 1 && !block.includes(" open"));
  addCheck(checks, "HTTP-метаданные сохранены", block.includes("Код: A | HTTP: 200 | Content-Type: application/json; charset=utf-8"));
  addCheck(checks, "JSON показан только один раз", countOccurrences(block, "raw-json-pre") === 1 && countOccurrences(block, "&quot;ИсторияЦен&quot;") === 1);
  addCheck(checks, "Дублирующий заголовок отсутствует", !block.includes("Сырой JSON от 1С"));

  context.renderMultiResults([
    { code: "A", ok: true, status: 200, contentType: "application/json", rawText, data },
    { code: "B", ok: true, status: 200, contentType: "application/json", rawText, data }
  ]);
  const multiHtml = elements.result.innerHTML;
  addCheck(checks, "В multi-code один details на код", countOccurrences(multiHtml, "raw-response-details") === 2 && countOccurrences(multiHtml, "raw-json-pre") === 2);

  return buildResult("UF06", "Единый диагностический блок", checks);
}

function runEfesCompatibilityCase() {
  const { context } = createContext();
  const checks = [];
  const entries = [
    {
      "ДатаКП": "2026-06-20",
      "НомерКП": "EFES-LATEST",
      "Клиент": "АБ ИнБев Эфес",
      "Контрагент": "Supplier A",
      "ЦенаЗакупки": 100,
      "ВалютаЗакупки": "EUR",
      "ЦенаКП": 150,
      "ВалютаКП": "EUR"
    },
    {
      "ДатаКП": "2026-06-20",
      "НомерКП": "EFES-LATEST",
      "Клиент": "АБ ИнБев Эфес",
      "Контрагент": "Supplier B",
      "ЦенаЗакупки": 120,
      "ВалютаЗакупки": "EUR",
      "ЦенаКП": 180,
      "ВалютаКП": "EUR"
    }
  ];
  const latest = context.findLatestEfesQuote(entries, new Date("2026-07-01T12:00:00Z"));
  const html = context.renderLatestEfesQuoteDetails(latest.latestInPeriod);

  addCheck(checks, "Поиск Эфес продолжает находить свежее КП", latest.latestInPeriod && latest.latestInPeriod["НомерКП"] === "EFES-LATEST");
  addCheck(checks, "Цена и поставщик остаются из одной строки", html.includes("Supplier A") && html.includes("150 EUR") && html.includes("100 EUR") && !html.includes("Supplier B"));

  return buildResult("UF07", "Совместимость блока Эфес", checks);
}

const results = [
  runCurrencyAveragesCase(),
  runLatestPurchaseCase(),
  runQuoteGroupingCase(),
  runStatusCase(),
  runCollapsingCase(),
  runDiagnosticCase(),
  runEfesCompatibilityCase()
];
const failed = results.filter((result) => result.status === "fail");

console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
