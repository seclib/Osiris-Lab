# OSIRIS-Lab v2 — Workflow Designer Service

Service de gestion de workflows DAG (Directed Acyclic Graph) pour OSIRIS-Lab v2.

## Architecture

**Références :**

| Document | Section |
|----------|---------|
| `docs/ARCHITECTURE.md` | §3.2 GraphQL BFF, §4.1 Workflow model, §5.2.4 Workflow flow |
| `docs/BACKEND_ARCHITECTURE.md` | §8 Clean Architecture, §2.3 Go service template |
| `docs/IMPLEMENTATION_PLAN_P1_P2.md` | Plan complet P1 |
| `docs/SCALING_STRATEGY.md` | §3 Workflow scaling |

**Stack :** Node.js + Express + PostgreSQL + NATS JetStream

**Patterns :** Clean Architecture / DDD / CQRS / Result Pattern / Event Driven

## Structure du code

```
src/
├── domain/                        # Cœur métier (DDD)
│   ├── entities/
│   │   ├── Workflow.ts            # Aggregate Root (state machine draft→active→paused→archived)
│   │   ├── WorkflowExecution.ts   # Execution lifecycle (running→completed/failed/cancelled)
│   │   └── WorkflowStep.ts        # Step lifecycle (pending→running→completed/failed/skipped)
│   ├── value-objects/
│   │   └── DAG.ts                 # DAG, WorkflowNode, WorkflowEdge, DAGValidator
│   └── events/
│       └── WorkflowEvents.ts      # 8 domain events typés
│
├── application/                   # Cas d'usage (CQRS)
│   ├── commands/
│   │   ├── CreateWorkflowCommand.ts
│   │   ├── UpdateWorkflowCommand.ts
│   │   └── DeleteWorkflowCommand.ts
│   └── queries/
│       └── GetWorkflowQuery.ts    # GetWorkflow, ListWorkflows, GetGraph, GetExecution
│
├── infrastructure/               # Adaptateurs externes
│   ├── database/
│   │   ├── PostgresWorkflowRepository.ts  # 3 repositories (Workflow, Execution, Step)
│   │   └── migrations/
│   │       ├── 001_create_workflows.sql
│   │       └── 002_add_performance_indexes.sql
│   ├── nats/
│   │   └── WorkflowEventPublisher.ts    # Publisher NATS avec metrics
│   └── repositories/
│       └── IWorkflowRepository.ts       # Interfaces Result pattern
│
└── presentation/                 # Couche HTTP
    ├── routes/
    │   └── workflow.routes.ts    # 6 endpoints REST
    └── index.ts                  # Entry point Express

tests/
└── unit/
    ├── domain/
    │   ├── workflow.test.ts      # 22 tests (création, state machine, update)
    │   └── dag-validator.test.ts # 13 tests (cycles, edges, limites)
```

## API REST

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/workflows` | Créer un workflow (valide name + DAG) |
| `PUT` | `/workflows/:id` | Mettre à jour le DAG (optimistic locking) |
| `DELETE` | `/workflows/:id` | Supprimer un workflow |
| `GET` | `/workflows` | Lister (filtre status, pagination limit/offset) |
| `GET` | `/workflows/:id` | Détail + 5 dernières exécutions |
| `GET` | `/workflows/:id/graph` | Récupérer le DAG |
| `GET` | `/workflows/executions/:id` | Détail exécution + steps |
| `GET` | `/health` | Health check |

## Events NATS

| Subject | Payload | Description |
|---------|---------|-------------|
| `workflow.created` | `{workflow_id, name, version, dag, created_by}` | Workflow créé |
| `workflow.updated` | `{workflow_id, version, changes, dag, updated_by}` | Workflow modifié |
| `workflow.deleted` | `{workflow_id, deleted_by}` | Workflow supprimé |

## Tests

```bash
# Tous les tests
npm test

# Tests unitaires uniquement
npm run test:unit

# Tests d'intégration
npm run test:integration
```

Total : **35 tests** (22 Workflow + 13 DAGValidator)

## Développement

```bash
# Lancer en développement
npm run dev

# Migrations
npm run migrate

# Build
npm run build
```

## Déploiement

```bash
docker compose --env-file .env.v2 -f docker-compose.v2.yml build workflow-designer
docker compose --env-file .env.v2 -f docker-compose.v2.yml up -d workflow-designer