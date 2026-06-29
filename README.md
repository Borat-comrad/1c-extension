# gmail-1c-extension

Chrome Extension popup для получения и отображения истории цен из 1С по коду производителя.

## Демо-проверка расширения

1. Откройте Chrome на машине, где есть доступ к 1С-сервису.
2. Перейдите в `chrome://extensions`.
3. Включите `Developer mode`.
4. Нажмите `Load unpacked`.
5. Выберите папку проекта `gmail-1c-extension`.
6. Откройте popup расширения.
7. Введите тестовый код производителя:

```text
0-905-21-102-2
```

8. Введите логин и пароль 1С.
9. Нажмите `Получить историю цен`.

Ожидаемый результат в UI:

- показан код производителя;
- показана последняя цена;
- показана средняя арифметическая цена;
- ниже показан список всех цен;
- остальные разделы ответа 1С показаны человекочитаемо;
- основной UI не показывает сырой JSON.

## Локальная проверка рендера фикстур

Обычная команда:

```powershell
node tests\run-render-fixtures.js
```

Если системный `node` недоступен, используйте bundled Node.js из Codex runtime:

```powershell
& "C:\Users\Nikolai Paliy\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tests\run-render-fixtures.js
```

Ожидаемый итог:

```text
total: 14
passed: 14
failed: 0
```

Тест-раннер использует `price_history_test_responses.json` и не выполняет реальный запрос в 1С.
