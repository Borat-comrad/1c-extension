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
  return /"ИсторияЦен"\s*:/.test(mainHtml)
    || /"ИсторияПоставок"\s*:/.test(mainHtml)
    || /{\s*"[^"]+"\s*:/.test(mainHtml);
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
  const checks = [];

  context.renderMultiResults([
    {
      code: "A",
      ok: true,
      status: 200,
      data: successResponse
    },
    {
      code: "B",
      ok: false,
      status: 404,
      error: "Код не найден",
      rawText: JSON.stringify({ message: "Код не найден", code: "B" })
    }
  ]);

  const html = elements.result.innerHTML;

  addCheck(checks, "Успешная карточка отображается", html.includes("Код: A") && html.includes("metric-card primary"));
  addCheck(checks, "Ошибочная карточка отображается", html.includes("Код: B") && html.includes("Код не найден"));
  addCheck(checks, "Общий поиск не падает и показывает summary", html.includes("Результаты поиска") && html.includes("Успешно") && html.includes("Ошибок"));
  addCheck(checks, "Сырой JSON не попадает в основной UI", !containsRawJson(html));

  return buildResult("M06", "Несколько кодов: часть успешна, часть с ошибкой", checks, {
    statusText: elements.status.textContent
  });
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
    await runConcurrencyCase()
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
