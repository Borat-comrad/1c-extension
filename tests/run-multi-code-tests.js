const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(projectRoot, "price_history_test_responses.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

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

function createContext(fetchMock) {
  const elements = {};
  let fetchCalls = 0;

  const context = {
    console,
    TextEncoder,
    setTimeout,
    clearTimeout,
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
    },
    async fetch(...args) {
      fetchCalls += 1;
      if (fetchMock) {
        return fetchMock(...args);
      }

      throw new Error("Unexpected fetch call.");
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "popup.js"), "utf8"), context);

  return {
    context,
    elements,
    getFetchCalls() {
      return fetchCalls;
    }
  };
}

function stripDetails(html) {
  return html.replace(/<details[\s\S]*?<\/details>/gi, "");
}

function containsRawJson(html) {
  const mainHtml = stripDetails(html);
  return /&quot;ИсторияЦен&quot;\s*:/.test(mainHtml)
    || /&quot;ИсторияПоставок&quot;\s*:/.test(mainHtml)
    || /{\s*&quot;[^&]+&quot;\s*:/.test(mainHtml);
}

function addCheck(checks, name, passed) {
  checks.push({ name, passed: Boolean(passed) });
}

function buildResult(id, title, checks, extra = {}) {
  const failedChecks = checks.filter((check) => !check.passed);

  return {
    id,
    title,
    status: failedChecks.length === 0 ? "pass" : "fail",
    checks,
    failedChecks,
    ...extra
  };
}

function assertParseCase(id, title, input, expected) {
  const { context } = createContext();
  const actual = context.parseCodeInput(input);
  const checks = [];

  addCheck(checks, "Получен ожидаемый список кодов", JSON.stringify(actual) === JSON.stringify(expected));
  addCheck(checks, "Порядок первых вхождений сохранён", actual.every((code, index) => code === expected[index]));

  return buildResult(id, title, checks, { input, actual, expected });
}

async function runTooManyCodesCase() {
  const env = createContext();
  const codeInput = env.elements.code;
  const loginInput = env.elements.login;
  const passwordInput = env.elements.password;
  const fetchButton = env.elements.fetchButton;
  const statusBlock = env.elements.status;
  const codes = Array.from({ length: 21 }, (_, index) => `C${index + 1}`);
  const checks = [];

  codeInput.value = codes.join(", ");
  loginInput.value = "user";
  passwordInput.value = "password";

  await fetchButton.listeners.click();

  addCheck(checks, "Запросы не отправляются", env.getFetchCalls() === 0);
  addCheck(checks, "Показана ошибка про максимум 20 кодов", statusBlock.textContent === "Слишком много кодов за один поиск. Максимум: 20.");

  return buildResult("M05", "Больше 20 кодов блокируются до отправки запросов", checks, {
    fetchCalls: env.getFetchCalls(),
    statusText: statusBlock.textContent
  });
}

function runMixedRenderCase() {
  const { context, elements } = createContext();
  const successResponse = fixture.testCases[0].response;
  const successRawText = JSON.stringify(successResponse);
  const errorData = { message: "Код не найден", code: "B" };
  const checks = [];

  context.renderMultiResults([
    {
      code: "A",
      ok: true,
      status: 200,
      contentType: "application/json; charset=utf-8",
      rawText: successRawText,
      data: successResponse
    },
    {
      code: "B",
      ok: false,
      status: 404,
      contentType: "application/json",
      error: "Код не найден",
      rawText: JSON.stringify(errorData),
      data: errorData
    }
  ]);

  const html = elements.result.innerHTML;

  addCheck(checks, "Успешная карточка отображается", html.includes("Код: A") && html.includes("metric-card primary"));
  addCheck(checks, "Ошибочная карточка отображается", html.includes("Код: B") && html.includes("Код не найден"));
  addCheck(checks, "Общий поиск не падает и показывает summary", html.includes("Результаты поиска") && html.includes("Успешно") && html.includes("Ошибок"));
  addCheck(checks, "В каждой карточке один свёрнутый диагностический блок", (html.match(/raw-response-details/g) || []).length === 2 && !html.includes("<details class=\"raw-response-details\" open"));
  addCheck(checks, "Диагностический JSON не дублируется", (html.match(/raw-json-pre/g) || []).length === 2 && !html.includes("Сырой JSON от 1С"));
  addCheck(checks, "В диагностике сохранены отдельные метаданные кодов", html.includes("Код: A | HTTP: 200 | Content-Type: application/json; charset=utf-8") && html.includes("Код: B | HTTP: 404 | Content-Type: application/json"));
  addCheck(checks, "Обновлённый summary работает внутри multi-code карточки", html.includes("product-summary-card") && html.includes("Группа / производитель") && html.includes("Код конечного производителя"));

  return buildResult("M06", "Несколько кодов: часть успешна, часть с ошибкой", checks, {
    statusText: elements.status.textContent
  });
}

async function runFetchMetadataCase() {
  const validRawText = '{\n  "value": 42\n}';
  const invalidRawText = "<html>not json</html>";
  const httpRawText = '{"message":"missing"}';
  const responses = [
    {
      ok: true,
      status: 201,
      statusText: "Created",
      contentType: "application/json; charset=utf-8",
      rawText: validRawText
    },
    {
      ok: true,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      rawText: invalidRawText
    },
    {
      ok: false,
      status: 404,
      statusText: "Not Found",
      contentType: "application/problem+json",
      rawText: httpRawText
    }
  ];
  let responseIndex = 0;
  const { context } = createContext(async () => {
    const response = responses[responseIndex];
    responseIndex += 1;

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? response.contentType : null;
        }
      },
      async text() {
        return response.rawText;
      }
    };
  });
  const checks = [];
  const validResult = await context.fetchPriceHistoryForCode("VALID", "user", "password");
  const invalidResult = await context.fetchPriceHistoryForCode("INVALID", "user", "password");
  const httpResult = await context.fetchPriceHistoryForCode("MISSING", "user", "password");

  addCheck(checks, "Успешный JSON сохраняет сырой текст без изменений", validResult.ok && validResult.rawText === validRawText);
  addCheck(checks, "Успешный JSON сохраняет status и Content-Type", validResult.status === 201 && validResult.contentType === "application/json; charset=utf-8");
  addCheck(checks, "Успешный JSON остаётся доступен как data", validResult.data && validResult.data.value === 42);
  addCheck(checks, "Невалидный JSON сохраняет исходный responseText", !invalidResult.ok && invalidResult.rawText === invalidRawText && invalidResult.contentType === "text/html");
  addCheck(checks, "HTTP-ошибка сохраняет rawText и метаданные", !httpResult.ok && httpResult.status === 404 && httpResult.contentType === "application/problem+json" && httpResult.rawText === httpRawText);
  addCheck(checks, "JSON тела HTTP-ошибки также разобран", httpResult.data && httpResult.data.message === "missing");

  return buildResult("M08", "Результат запроса сохраняет rawText, status и Content-Type", checks);
}

async function runConcurrencyCase() {
  const { context } = createContext();
  const checks = [];
  const items = Array.from({ length: 7 }, (_, index) => index + 1);
  let active = 0;
  let maxActive = 0;

  const results = await context.runWithConcurrencyLimit(items, 2, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    await new Promise((resolve) => setTimeout(resolve, 10));

    active -= 1;
    return item * 10;
  });

  addCheck(checks, "Одновременно активно не больше 2 worker-функций", maxActive <= 2);
  addCheck(checks, "Результаты возвращаются в исходном порядке", JSON.stringify(results) === JSON.stringify(items.map((item) => item * 10)));

  return buildResult("M07", "Лимит параллельности", checks, {
    maxActive,
    results
  });
}

async function main() {
  const results = [
    assertParseCase("M01", "A, B, C сохраняет 3 кода и порядок", "A, B, C", ["A", "B", "C"]),
    assertParseCase("M02", "Пробелы после запятых очищаются", "A,  B,   C", ["A", "B", "C"]),
    assertParseCase("M03", "Пустые элементы удаляются", "A,, B, , C,", ["A", "B", "C"]),
    assertParseCase("M04", "Дубликаты удаляются с сохранением первых вхождений", "A, B, A, C, B", ["A", "B", "C"]),
    await runTooManyCodesCase(),
    runMixedRenderCase(),
    await runConcurrencyCase(),
    await runFetchMetadataCase()
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
