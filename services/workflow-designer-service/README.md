# Workflow Designer Service

Service de conception et d'exécution de workflows visuels pour OSIRIS-Lab v2 avec intégration Temporal.io.

## Architecture

Ce service suit la **Clean Architecture** avec séparation des responsabilités:

```
services/workflow-designer-service/
├── src/
│   ├── domain/                      # Couche métier (pure)
│   │   ├── entities/
│   │   │   ├── Workflow.ts              # Entité Workflow (DAG)
│   │   │   └── WorkflowExecution.ts     # Entité Execution
│   │   ├── events/
│   │   │   └── WorkflowEvents.ts        # Events NATS
│   │   ├── repositories/
│   │   │   └── IWorkflowRepository.ts   # Interface repository
│   │   └── services/
│   │       └── WorkflowDomainService.ts # Règles métier + DAG validation
│   │
│   ├── application/                 # Use Cases
│   │   ├── commands/
│   │   │   ├── CreateWorkflowCommand.ts
│   │   │   └── ExecuteWorkflowCommand.ts
│   │   └── queries/
│   │       └── GetWorkflowQuery.ts
│   │
│   ├── infrastructure/              # Implémentations techniques
│   │   ├── database/
│   │   │   └── PostgresWorkflowRepository.ts (existant)
│   │   ├── temporal/                 # À implémenter
│   │   │   ├── TemporalClient.ts
│   │   │   └── WorkflowWorker.ts
│   │   └── nats/
│   │       └── WorkflowEventPublisher.ts (existant)
│   │
│   ├── presentation/                # API endpoints
│   │   └── routes/
│   │       └── workflow.routes.ts (existant)
│   │
│   └── index.ts                     # Point d'entrée (existant)
│
├── migrations/
│   ├── 001_create_workflows.sql     (existant)
│   └── 002_add_performance_indexes.sql (existant)
│
├── package.json                     (mis à jour)
├── tsconfig.json                    (existant)
└── Dockerfile                       (existant)
```

## Fonctionnalités

### 1. Workflow DAG (Directed Acyclic Graph)

**Types de nœuds supportés:**
- `INPUT` - Point d'entrée du workflow
- `OUTPUT` - Point de sortie du workflow
- `PROCESS` - Traitement générique
- `AI` - Tâche IA (analyse, raisonnement)
- `CONDITION` - Branchement conditionnel
- `LOOP` - Boucle d'itération
- `NOTIFICATION` - Envoyer notification
- `SIEM` - Intégration SIEM

**Caractéristiques:**
- Validation automatique du DAG
- Détection de cycles
- Vérification des nœuds connectés
- Validation des configurations

### 2. Exécution de Workflows

**Modes d'exécution:**
- **Manuel** - Déclenché par utilisateur
- **Event-driven** - Déclenché par events NATS
- **Scheduled** - Exécution périodique (via Temporal)

**Fonctionnalités:**
- Exécution séquentielle ou parallèle
- Gestion des états (PENDING, RUNNING, COMPLETED, FAILED)
- Retry automatique en cas d'échec
- Timeout configurable par nœud
- Events temps réel à chaque étape

### 3. Intégration Temporal.io

**Architecture:**
```
┌─────────────────────────────────────────┐
│  Workflow Designer Service              │
│  ┌───────────────────────────────────┐  │
│  │  CreateWorkflowCommand            │  │
│  │  ExecuteWorkflowCommand           │  │
│  └──────────────┬────────────────────┘  │
└─────────────────┼───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Temporal.io Cluster                    │
│  ┌───────────────────────────────────┐  │
│  │  Workflow Definition              │  │
│  │  - DAG structure                  │  │
│  │  - Node configurations            │  │
│  │  - Retry policies                 │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  Activity Workers                 │  │
│  │  - Process nodes                  │  │
│  │  - AI nodes                       │  │
│  │  - Notification nodes             │  │
│  │  - SIEM nodes                     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 4. Event-Driven Architecture

**Events NATS publiés:**

```typescript
// workflow.created
{
  type: "workflow.created",
  payload: {
    workflow_id: "uuid",
    name: "OSINT Analysis Pipeline",
    version: 1,
    dag: { nodes: [...], edges: [...] },
    created_by: "user_uuid"
  }
}

// workflow.execution.started
{
  type: "workflow.execution.started",
  payload: {
    execution_id: "uuid",
    workflow_id: "uuid",
    workflow_version: 1,
    input: {},
    started_at: "2025-06-18T14:30:00Z"
  }
}

// workflow.step.started
{
  type: "workflow.step.started",
  payload: {
    execution_id: "uuid",
    step_id: "uuid",
    node_id: "node_1",
    node_type: "ai",
    started_at: "2025-06-18T14:30:00Z"
  }
}

// workflow.step.completed
{
  type: "workflow.step.completed",
  payload: {
    execution_id: "uuid",
    step_id: "uuid",
    node_id: "node_1",
    status: "completed",
    output: {},
    duration_ms: 1500,
    completed_at: "2025-06-18T14:30:01Z"
  }
}

// workflow.execution.completed
{
  type: "workflow.execution.completed",
  payload: {
    execution_id: "uuid",
    workflow_id: "uuid",
    status: "completed",
    output: {},
    duration_ms: 5000,
    completed_at: "2025-06-18T14:30:05Z"
  }
}
```

## API Endpoints

### REST API

```http
POST /workflows
Content-Type: application/json

{
  "name": "OSINT Analysis Pipeline",
  "description": "Analyze threat intelligence",
  "dag": {
    "nodes": [
      { "id": "1", "type": "input", "name": "Start" },
      { "id": "2", "type": "ai", "name": "Entity Resolution" },
      { "id": "3", "type": "process", "name": "Threat Analysis" },
      { "id": "4", "type": "notification", "name": "Send Alert" },
      { "id": "5", "type": "output", "name": "End" }
    ],
    "edges": [
      { "from": "1", "to": "2" },
      { "from": "2", "to": "3" },
      { "from": "3", "to": "4" },
      { "from": "4", "to": "5" }
    ]
  },
  "createdBy": "user_123"
}
```

```http
POST /workflows/:id/execute
Content-Type: application/json

{
  "input": {
    "entity_id": "entity_456",
    "analysis_type": "threat_assessment"
  },
  "triggeredBy": "user_123"
}
```

```http
GET /workflows/:id/graph
```

```http
GET /workflows?status=active&limit=50
```

## Configuration

### Environment Variables

```env
# Server
PORT=4002
NATS_URL=nats://localhost:4222
DATABASE_URL=postgresql://osiris:osiris@localhost:5432/osiris

# Temporal
TEMPORAL_HOST=temporal:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=workflow-queue

# Redis (for workflow state)
REDIS_URL=redis://localhost:6379
```

## Database Schema

### Tables

**workflows:**
```sql
- id (UUID, PK)
- name (VARCHAR)
- description (TEXT)
- dag (JSONB) - DAG structure
- version (INT)
- status (VARCHAR) - draft/active/paused/archived
- created_by (UUID)
- created_at, updated_at
```

**workflow_executions:**
```sql
- id (UUID, PK)
- workflow_id (UUID, FK)
- workflow_version (INT)
- status (VARCHAR) - pending/running/completed/failed
- input (JSONB)
- output (JSONB)
- error (TEXT)
- started_at, completed_at
- triggered_by (UUID)
```

**workflow_steps:**
```sql
- id (UUID, PK)
- execution_id (UUID, FK)
- node_id (VARCHAR)
- node_type (VARCHAR)
- status (VARCHAR)
- input (JSONB)
- output (JSONB)
- error (TEXT)
- started_at, completed_at
- duration_ms (INT)
```

## Domain Services

### WorkflowDomainService

**Responsabilités:**
- Validation des workflows
- Vérification des règles métier
- Calcul de l'ordre d'exécution (topological sort)
- Détection de cycles
- Estimation de durée

**Méthodes principales:**
```typescript
validate(workflow: Workflow): WorkflowValidationResult
canExecute(workflow: Workflow): { canExecute: boolean; reason?: string }
getExecutionOrder(workflow: Workflow): string[]  // Topological sort
getExecutionGroups(workflow: Workflow): string[][]  // Parallel execution
estimateDuration(workflow: Workflow): { estimatedMs: number; confidence: string }
```

## Intégration avec Autres Services

### Notification Service
```typescript
// Déclencher notification à la fin d'un workflow
await nats.publish('notification.requested', {
  userId: 'user_123',
  type: 'info',
  severity: 'medium',
  title: 'Workflow Completed',
  message: 'OSINT analysis completed',
  channels: ['websocket', 'email']
});
```

### Alert Service
```typescript
// Déclencher alerte si workflow échoue
if (execution.status === 'failed') {
  await nats.publish('alert.triggered', {
    severity: 'high',
    title: 'Workflow Failed',
    workflowId: workflow.id
  });
}
```

### Plugin System
```typescript
// Plugins peuvent fournir des nœuds custom
plugin.registerWorkflowNode('custom-analyzer', {
  type: 'ai',
  name: 'Custom Analyzer',
  execute: async (input) => {
    // Custom logic
  }
});
```

## Temporal.io Integration

### Workflow Definition

```typescript
// temporal/Workflows.ts
import { Workflow } from '@temporalio/workflow';

export class OSINTWorkflow {
  async execute(input: WorkflowInput): Promise<WorkflowOutput> {
    // Execute nodes in topological order
    const order = this.getExecutionOrder(input.dag);
    
    for (const nodeId of order) {
      await this.executeNode(nodeId, input);
    }
    
    return { success: true };
  }
}
```

### Activity Definition

```typescript
// temporal/Activities.ts
import { activity } from '@temporalio/activity';

export class WorkflowActivities {
  async executeAINode(config: any): Promise<any> {
    // Call AI Engine
  }
  
  async executeProcessNode(config: any): Promise<any> {
    // Process data
  }
  
  async sendNotification(config: any): Promise<any> {
    // Call Notification Service
  }
}
```

## Performance

### Cibles
- Création workflow: <200ms
- Démarrage exécution: <500ms
- Exécution étape: <100ms (overhead)
- Throughput: 1000 workflows/sec
- Disponibilité: 99.9%

### Optimisations
- Connection pooling PostgreSQL
- Redis cache pour workflows actifs
- Index DB optimisés
- Temporal pour fiabilité et scaling

## Sécurité

### RBAC
- `workflow:create` - Créer workflows
- `workflow:read` - Lire workflows
- `workflow:update` - Modifier workflows
- `workflow:delete` - Supprimer workflows
- `workflow:execute` - Exécuter workflows

### Validation
- Validation stricte du DAG
- Vérification des permissions par nœud
- Audit log de toutes les exécutions
- Timeout et resource limits

## Prochaines Étapes

1. **Implémenter Temporal.io Worker** - Connecter avec Temporal cluster
2. **Infrastructure Database** - Créer PostgresWorkflowRepository
3. **Infrastructure NATS** - Créer WorkflowEventPublisher
4. **Routes API** - Implémenter workflow.routes.ts
5. **Frontend** - React Flow builder
6. **Tests** - Unit + Integration + E2E

## License

MIT