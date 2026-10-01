# Film Agent — Economic Generation Router

Ядро «Free → Cheap → Premium» из дополнения к ТЗ. OmniRoute — только gateway-слой за интерфейсом `GenerationProvider`.

## Состояние репозитория на старте
Репозиторий был пуст (нет frontend/backend/MongoDB/auth/Docker/OmniRoute), поэтому п. 61 ТЗ свёлся к выбору автономного TypeScript-пакета без зависимостей. Хранилища (jobs, cache, ledger, anchors) сейчас in-memory за узкими классами; при интеграции в Firmspace их заменяют на Mongo/Redis, а `tenantId` уже сквозной.

## Реализовано (Phase 1–2 + ядро Phase 4)
| ТЗ | Модуль |
|---|---|
| §3–4 Model Registry, tiers из конфигурируемых порогов цены | `registry.ts`, `config.ts` |
| §17 Provider Discovery Worker (`/v1/models` + каталог метаданных) | `discovery.ts` |
| §22–24 `GenerationProvider`, `OmniRouteAdapter`, direct fallback | `gateway.ts` |
| §11–12, 34 Budget Controller, reservations, emergency | `budget.ts` |
| §18–19 Quota tracker, reset-time, симуляция в плане | `quota.ts`, `planner.ts` |
| §36–37 Circuit breaker, retry/backoff/jitter, idempotency | `health.ts`, `retry.ts`, `orchestrator.ts` |
| §5–10, 14–16, 20–21, 25, 31, 35, 55–56 Router: capability check, free-first, score, continuity, model lock, policy, fallback chain, decision log | `router.ts`, `ledger.ts` |
| §9–10 QA decision, max attempts per tier, escalation | `qa.ts`, `orchestrator.ts` |
| §13, 32 Generation Plan / film-level оптимизатор, §40 savings | `planner.ts`, `ledger.ts` |
| §15 Shot classifier (importance, required quality) | `classifier.ts` |
| §30, 53 result cache, no-duplicate jobs | `orchestrator.ts` |
| §38–39, 58 GenerationTransaction, агрегаты, статистика моделей | `ledger.ts`, `stats.ts` |

В коде нет имён моделей и цен: цены/качество/capabilities приходят из каталога метаданных (`MetadataCatalog`) или из реестра, tier выводится из порогов в `RouterConfig`. Модель без цены или без данных о качестве **отклоняется**, а не угадывается.

## НЕ реализовано (следующие фазы)
- Реальный `QualityEvaluator` (VLM/метрики) — есть интерфейс и тестовая заглушка.
- Asset Library / reuse-first (§28–29), Image→Video пайплайн (§27), сам сценарий/storyboard/shot-planner агенты.
- Audio/FFmpeg/upscale/сборка фильма, BullMQ-очереди, Mongo-схемы, secrets, admin panel, дашборд, docker-compose.
- Cost Optimization Agent на LLM: роутер уже не умеет повышать budget/hardLimit (`authorizeIncrease` — только явно).
- Приёмочный тест §63 на реальных API — требует развёрнутого OmniRoute и ключей.

## Допущения, требующие проверки
- Форма запроса `/v1/videos/generations` (поля `duration`, `image` и т. п.) и ответа (`data[].url`, `usage.cost`) взята по OpenAI-конвенции, не сверена с задеплоенной версией OmniRoute. Переопределяется через `mapVideoBody` и др. Асинхронный polling видео не реализован.
- `/v1/models` обычно не содержит цен/качества/modality — они берутся из каталога метаданных.
- Бесплатные квоты провайдеров — через `QuotaTracker.set()`; пока неизвестная квота считается неограниченной (при ошибке провайдера срабатывает эскалация).

## Запуск
```
npm install && npm run typecheck && npm test
```
