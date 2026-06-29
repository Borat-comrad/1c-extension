const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const fixtureCandidates = [
  path.join(projectRoot, "tests", "fixtures", "price_history_test_responses.json"),
  path.join(projectRoot, "price_history_test_responses.json")
];
const fixturePath = fixtureCandidates.find((candidate) => fs.existsSync(candidate));

if (!fixturePath) {
  throw new Error("Fixture file price_history_test_responses.json was not found.");
}

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
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "popup.js"), "utf8"), context);

  return {
    context,
    resultBlock: elements.result,
    statusBlock: elements.status
  };
}

function stripDetails(html) {
  return html.replace(/<details[\s\S]*?<\/details>/gi, "");
}

function countOccurrences(text, pattern) {
  return (text.match(new RegExp(pattern, "g")) || []).length;
}

function containsRawJson(html) {
  const mainHtml = stripDetails(html);
  return /"ИсторияЦен"\s*:/.test(mainHtml)
    || /"ИсторияПоставок"\s*:/.test(mainHtml)
    || /{\s*"[^"]+"\s*:/.test(mainHtml);
}

function runCase(testCase) {
  const { context, resultBlock, statusBlock } = createContext();

  if (testCase.rawResponseText !== undefined) {
    vm.runInContext(
      `handleSuccessfulResponse(${JSON.stringify(testCase.rawResponseText)}, ${JSON.stringify(testCase.inputCode || "")});`,
      context
    );
  } else if (testCase.httpStatus && testCase.httpStatus >= 400) {
    vm.runInContext(
      `showError(makeHttpErrorMessage(${JSON.stringify(testCase.httpStatus)}, "Internal Server Error"));
       handleHttpErrorResponse(${JSON.stringify(testCase.httpStatus)}, "Internal Server Error", ${JSON.stringify(JSON.stringify(testCase.response))});`,
      context
    );
  } else {
    vm.runInContext(
      `showOk("Запрос успешен. HTTP-статус: 200");
       handleSuccessfulResponse(${JSON.stringify(JSON.stringify(testCase.response))}, ${JSON.stringify(testCase.inputCode || "")});`,
      context
    );
  }

  return evaluateCase(testCase, resultBlock, statusBlock);
}

function evaluateCase(testCase, resultBlock, statusBlock) {
  const html = resultBlock.innerHTML || resultBlock.textContent || "";
  const mainHtml = stripDetails(html);
  const checks = [];

  addCheck(checks, "Основной UI не содержит сырой JSON", !containsRawJson(html));

  if (testCase.rawResponseText !== undefined) {
    addCheck(checks, "Показана понятная ошибка парсинга JSON", html.includes("JSON не удалось разобрать"));
    addCheck(checks, "HTML из сырого ответа экранирован", html.includes("&lt;html&gt;") && !mainHtml.includes("<html>"));
    addCheck(checks, "Технический ответ спрятан в details", html.includes("<details") && html.includes("Технический ответ"));
    return buildResult(testCase, checks, html, statusBlock);
  }

  if (testCase.httpStatus && testCase.httpStatus >= 400) {
    addCheck(checks, "Статус backend показан понятно", statusBlock.textContent.includes(`Ошибка ${testCase.httpStatus}`));
    addCheck(checks, "JSON-обертка ошибки разобрана в поля", html.includes("source_status") && html.includes("1С вернула внутреннюю ошибку"));
    addCheck(checks, "Сырой ответ доступен только в technical details", html.includes("<details") && html.includes("Технический ответ"));
    return buildResult(testCase, checks, html, statusBlock);
  }

  const expected = testCase.expected || {};

  if (expected.fallback) {
    addCheck(checks, "Неожиданный формат уходит в fallback", html.includes("формат отличается от ожидаемого"));
    addCheck(checks, "Технический ответ спрятан в details", html.includes("<details") && html.includes("Технический ответ"));
    return buildResult(testCase, checks, html, statusBlock);
  }

  addCheck(checks, "Показан код производителя", html.includes(testCase.inputCode));

  if (expected.lastPrice) {
    addCheck(checks, `Показана последняя цена: ${expected.lastPrice}`, html.includes(expected.lastPrice));
  }

  if (expected.averagePrice) {
    addCheck(checks, `Показана средняя цена: ${expected.averagePrice}`, html.includes(expected.averagePrice));
  }

  if (typeof expected.pricesCount === "number") {
    addCheck(checks, `Количество строк цен: ${expected.pricesCount}`, countOccurrences(html, "price-item") === expected.pricesCount);
    addCheck(checks, "Список всех цен присутствует", html.includes("price-list"));
  }

  if (expected.emptyFieldsShouldShow || expected.emptyArraysShouldShow || expected.pricesCount === 0) {
    addCheck(checks, "Пустые значения показаны как нет данных", html.includes("нет данных"));
  }

  if (expected.shipmentsCount) {
    addCheck(checks, `Поставки отображены: ${expected.shipmentsCount}`, html.includes("История поставок") && html.includes(`Записей: ${expected.shipmentsCount}`));
  }

  if (expected.claimsCount) {
    addCheck(checks, `Рекламации отображены: ${expected.claimsCount}`, html.includes("Данные рекламаций") && html.includes(`Записей: ${expected.claimsCount}`));
  }

  if (expected.sapCodesCount) {
    addCheck(checks, `SAP-коды отображены: ${expected.sapCodesCount}`, html.includes("Список SAP-кодов") && html.includes(`Записей: ${expected.sapCodesCount}`));
  }

  if (expected.additionalFields) {
    addCheck(checks, "Дополнительные top-level поля отображены", html.includes("Дополнительные данные") && html.includes("Значение А") && html.includes("Цена устарела"));
  }

  if (expected.claims) {
    addCheck(checks, "Поддержаны оба варианта поля рекламаций", html.includes("OLD-TYPO-FIELD") && html.includes("CORRECT-FIELD"));
  }

  if (expected.security) {
    addCheck(checks, "HTML/JS значения экранированы", html.includes("&lt;script&gt;") && html.includes("&lt;b&gt;") && !mainHtml.includes("<script>") && !mainHtml.includes("<b>"));
  }

  return buildResult(testCase, checks, html, statusBlock);
}

function addCheck(checks, name, passed) {
  checks.push({ name, passed: Boolean(passed) });
}

function buildResult(testCase, checks, html, statusBlock) {
  const failedChecks = checks.filter((check) => !check.passed);

  return {
    id: testCase.id,
    title: testCase.title,
    purpose: testCase.purpose,
    status: failedChecks.length === 0 ? "pass" : "fail",
    checks,
    failedChecks,
    statusText: statusBlock.textContent,
    renderedSignals: collectRenderedSignals(html)
  };
}

function collectRenderedSignals(html) {
  return {
    hasSummary: html.includes("summary-grid"),
    hasLastPriceCard: html.includes("metric-card primary"),
    hasAveragePriceCard: html.includes("metric-card accent"),
    hasPriceList: html.includes("price-list"),
    hasDetails: html.includes("<details"),
    priceItems: countOccurrences(html, "price-item"),
    recordItems: countOccurrences(html, "record-item")
  };
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
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
