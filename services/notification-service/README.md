# Notification Service

Service de notification temps réel pour OSIRIS-Lab v2 avec support WebSocket, Push (FCM/APNs) et Email.

## Architecture

Ce service suit la **Clean Architecture** avec séparation des responsabilités:

```
services/notification-service/
├── src/
│   ├── domain/                    # Couche métier (pure, pas de dépendances)
│   │   ├── entities/
│   │   │   └── Notification.ts           # Entité Notification
│   │   ├── events/
│   │   │   └── NotificationEvents.ts     # Events NATS
│   │   ├── repositories/
│   │   │   └── INotificationRepository.ts # Interface repository
│   │   └── services/
│   │       └── NotificationDomainService.ts # Règles métier
│   │
│   ├── application/               # Couche application (use cases)
│   │   ├── commands/
│   │   │   ├── SendNotificationCommand.ts
│   │   │   └── MarkNotificationReadCommand.ts
│   │   └── queries/
│   │       └── GetNotificationsQuery.ts
│   │
│   ├── infrastructure/            # Implémentations techniques
│   │   ├── database/
│   │   │   └── PostgresNotificationRepository.ts
│   │   ├── nats/
│   │   │   └── NotificationEventPublisher.ts
│   │   ├── websocket/
│   │   │   └── SocketIOGateway.ts
│   │   └── adapters/
│   │       ├── PushNotificationAdapter.ts
│   │       └── EmailNotificationAdapter.ts
│   │
│   ├── presentation/              # API endpoints
│   │   └── routes/
│   │       └── notification.routes.ts
│   │
│   └── index.ts                   # Point d'entrée
│
├── migrations/
│   └── 001_create_notifications.sql
│
├── package.json
├── tsconfig.json
└── Dockerfile
```

## Fonctionnalités

### 1. Notification Temps Réel (WebSocket)
- Connexion WebSocket via Socket.IO
- Authentification utilisateur
- Envoi instantané de notifications
- Gestion des utilisateurs connectés

### 2. Push Notifications (FCM/APNs)
- Firebase Cloud Messaging (Android)
- Apple Push Notification Service (iOS)
- Support multi-appareils
- Gestion des priorités par canal

### 3. Email Notifications
- Templates HTML responsives
- Support multi-destinataires
- Priorité selon sévérité
- Format texte + HTML

### 4. Event-Driven Architecture
- Publication d'events NATS
- `notification.requested` - Nouvelle notification
- `notification.sent` - Notification envoyée
- `notification.delivered` - Notification livrée
- `notification.failed` - Échec d'envoi
- `notification.read` - Notification lue

## API Endpoints

### REST API

```http
POST /notifications
Content-Type: application/json

{
  "userId": "user_123",
  "type": "alert",
  "severity": "critical",
  "title": "Critical IOC Detected",
  "message": "Malware hash found on web-server-01",
  "channels": ["websocket", "push", "email"],
  "priority": 5,
  "data": {
    "ioc_id": "ioc_456",
    "event_id": "evt_789"
  }
}
```

```http
GET /notifications/:userId?limit=50&offset=0&unreadOnly=false
```

```http
PATCH /notifications/:notificationId/read
Content-Type: application/json

{
  "userId": "user_123"
}
```

```http
GET /notifications/:userId/unread-count
```

### WebSocket Events

**Client → Server:**
```javascript
// Authenticate
socket.emit('authenticate', 'user_123');

// Mark as read
socket.emit('notification:read', { notificationId: 'notif_001' });
```

**Server → Client:**
```javascript
// Receive notification
socket.on('notification:received', (notification) => {
  console.log('New notification:', notification);
});

// Read acknowledgment
socket.on('notification:read:ack', (data) => {
  console.log('Notification marked as read:', data);
});
```

## Configuration

### Environment Variables

```env
# Server
PORT=4000
WEBSOCKET_PORT=4001
NATS_URL=nats://localhost:4222
DATABASE_URL=postgresql://osiris:osiris@localhost:5432/osiris

# CORS
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:4000

# Email (SMTP)
EMAIL_FROM=notifications@osiris.ai
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Firebase (Push)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY=your-private-key
FIREBASE_CLIENT_EMAIL=your-client-email
```

## Installation

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev

# Run in production
npm start
```

## Docker

```bash
# Build image
docker build -t notification-service .

# Run container
docker run -p 4000:4000 -p 4001:4001 \
  -e DATABASE_URL=postgresql://osiris:osiris@postgres:5432/osiris \
  -e NATS_URL=nats://nats:4222 \
  notification-service
```

## Database Migration

```bash
# Apply migration
psql -U osiris -d osiris -f migrations/001_create_notifications.sql

# Or using Node.js
npm run migrate
```

## Tests

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage
npm run test:coverage
```

## Observabilité

### Metrics
- `notification.created` - Compteur de notifications créées
- `notification.validation_failed` - Erreurs de validation
- `notification.create_failed` - Erreurs de création
- `notification.create_duration_ms` - Latence de création

### Logs
Tous les logs sont structurés en JSON avec:
- `timestamp`
- `level` (info/warn/error)
- `service` (notification-service)
- `action`
- `context` (données métier)

### Traces
Les traces distribuées passent par Grafana Tempo via Alloy.

## Sécurité

### RBAC
- `notification:create` - Créer des notifications
- `notification:read` - Lire ses notifications
- `notification:read:all` - Lire toutes les notifications (admin)
- `notification:delete` - Supprimer des notifications

### Audit Log
Toutes les actions sont loguées:
- Qui (userId/service)
- Quoi (action)
- Quand (timestamp)
- Où (IP, service)
- Pourquoi (contexte)

## Performance

### Cibles
- Latence P95: <100ms
- Throughput: 10K notifications/sec
- WebSocket: 50K connexions simultanées
- Disponibilité: 99.9%

### Optimisations
- Connection pooling PostgreSQL
- Redis cache pour préférences utilisateur
- Index DB optimisés
- WebSocket scaling via Redis adapter

## Intégration avec Autres Services

### Alert Service
```typescript
// Lorsqu'une alerte critique est déclenchée
await nats.publish('alert.triggered', {
  alertId: 'alert_123',
  severity: 'critical',
  // ...
});

// Notification service écoute et envoie
```

### BFF (GraphQL)
```graphql
subscription {
  notificationReceived(userId: "user_123") {
    id
    type
    severity
    title
    message
    read
    createdAt
  }
}
```

## Prochaines Étapes

1. **Intégration Firebase** - Implémenter FCM/APNs réel
2. **Intégration SMTP** - Configurer Nodemailer avec provider email
3. **Redis Adapter** - Scaling WebSocket horizontal
4. **Tests** - Unit + Integration + Load tests
5. **Monitoring** - Dashboards Grafana

## License

MIT