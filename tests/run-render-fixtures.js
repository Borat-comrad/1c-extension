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
  return /&quot;ИсторияЦен&quot;\s*:/.test(mainHtml)
    || /&quot;ИсторияПоставок&quot;\s*:/.test(mainHtml)
    || /{\s*&quot;[^&]+&quot;\s*:/.test(mainHtml);
}

function runCase(testCase) {
  const { context, resultBlock, statusBlock } = createContext();
  const code = testCase.inputCode || "";

  if (testCase.rawResponseText !== undefined) {
    context.renderSingleFetchResult({
      code,
      ok: false,
      status: 200,
      contentType: "text/html; charset=utf-8",
      rawText: testCase.rawResponseText,
      error: "Ответ получен, но JSON не удалось разобрать.",
      errorType: "invalid_json"
    });
  } else if (testCase.httpStatus && testCase.httpStatus >= 400) {
    context.renderSingleFetchResult(
      context.buildHttpErrorResult(
        code,
        testCase.httpStatus,
        "Internal Server Error",
        "application/json; charset=utf-8",
        JSON.stringify(testCase.response)
      )
    );
  } else {
    context.renderSingleFetchResult({
      code,
      ok: true,
      status: 200,
      contentType: "application/json; charset=utf-8",
      rawText: JSON.stringify(testCase.response),
      data: testCase.response
    });
  }

  return evaluateCase(testCase, resultBlock, statusBlock);
}

function evaluateCase(testCase, resultBlock, statusBlock) {
  const html = resultBlock.innerHTML || resultBlock.textContent || "";
  const mainHtml = stripDetails(html);
  const checks = [];

  addCheck(checks, "Диагностический блок виден сразу", mainHtml.includes("raw-json-block") && mainHtml.includes("Сырой ответ 1С"));
  addCheck(checks, "В диагностическом блоке показаны код и HTTP status", mainHtml.includes(`Код: ${testCase.inputCode || ""}`) && mainHtml.includes(`HTTP: ${testCase.httpStatus || 200}`));
  addCheck(checks, "Content-Type показан", mainHtml.includes("Content-Type:"));

  if (testCase.rawResponseText !== undefined) {
    addCheck(checks, "Показана понятная ошибка парсинга JSON", html.includes("JSON не удалось разобрать"));
    addCheck(checks, "HTML из сырого ответа экранирован", html.includes("&lt;html&gt;") && !mainHtml.includes("<html>"));
    addCheck(checks, "Исходный невалидный ответ виден вне details", mainHtml.includes("&lt;html&gt;"));
    return buildResult(testCase, checks, html, statusBlock);
  }

  addCheck(checks, "Сырой и pretty JSON показаны в диагностическом блоке", containsRawJson(html) && mainHtml.includes("Сырой текст ответа") && mainHtml.includes("Сырой JSON от 1С"));

  if (testCase.httpStatus && testCase.httpStatus >= 400) {
    addCheck(checks, "HTTP status backend показан понятно", mainHtml.includes(`HTTP: ${testCase.httpStatus}`));
    addCheck(checks, "JSON-обертка ошибки разобрана в поля", html.includes("source_status") && html.includes("1С вернула внутреннюю ошибку"));
    addCheck(checks, "Сырой ответ ошибки виден вне technical details", mainHtml.includes("source_status"));
    return buildResult(testCase, checks, html, statusBlock);
  }

  const expected = testCase.expected || {};

  if (expected.fallback) {
    addCheck(checks, "Неожиданный формат уходит в fallback", html.includes("формат отличается от ожидаемого"));
    addCheck(checks, "Диагностический блок остаётся видимым после fallback", mainHtml.includes("Сырой JSON от 1С"));
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
    hasRawResponseBlock: html.includes("raw-json-block"),
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
