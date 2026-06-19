# 📊 OSIRIS Logging Stack — Documentation

## Vue d'ensemble

Stack de logging centralisée pour OSIRIS basée sur **Grafana Alloy** (remplacement de Promtail), **Loki** (stockage) et **Grafana** (visualisation).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OSIRIS Logging Stack                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────┐ │
│  │   Alloy      │─────▶│     Loki     │─────▶│ Grafana  │ │
│  │  (Collector) │      │  (Storage)   │      │ (UI)     │ │
│  └──────────────┘      └──────────────┘      └──────────┘ │
│         │                       │                  │       │
│         │                       │                  │       │
│         ▼                       ▼                  ▼       │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────┐ │
│  │ Docker Logs  │      │   Index +    │      │ Dashboards│ │
│  │ + Metrics    │      │   Query      │      │ + Alerts  │ │
│  └──────────────┘      └──────────────┘      └──────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Composants

| Composant | Image | Port | Rôle |
|-----------|-------|------|------|
| **Alloy** | `grafana/alloy:latest` | - | Collecte logs Docker + métriques |
| **Loki** | `grafana/loki:latest` | 3101 | Stockage et indexation des logs |
| **Grafana** | `grafana/grafana:latest` | 3001 | Visualisation et tableaux de bord |

## Démarrage rapide

### Option 1 : Déploiement séparé (recommandé)

```bash
# 1. Créer le réseau de logging
docker network create osiris-logging

# 2. Démarrer la stack de logging
docker compose -f alloy/docker-compose.logging.yml up -d

# 3. Vérifier le statut
docker compose -f alloy/docker-compose.logging.yml ps

# 4. Accéder à Grafana
# URL: http://localhost:3001
# Login: admin / Mot de passe: ${GRAFANA_ADMIN_PASSWORD:-admin}
```

### Option 2 : Intégration dans docker-compose.yml principal

```bash
# 1. Éditer docker-compose.yml et décommenter la section "LOGGING STACK"

# 2. Démarrer avec la stack principale
docker compose up -d

# 3. Vérifier
docker compose ps
```

## Configuration

### Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Mot de passe admin Grafana |

### Fichiers de configuration

```
alloy/
├── config.alloy              # Configuration Alloy (collecte)
├── docker-compose.logging.yml # Stack de logging
└── README.md                 # Cette documentation

loki/
└── loki-config.yml           # Configuration Loki (stockage)

grafana/
└── provisioning/
    ├── datasources/
    │   └── loki.yml          # Datasource Loki
    └── dashboards/
        ├── dashboards.yml    # Provisioning des dashboards
        └── osiris-overview.json  # Dashboard par défaut
```

## Accès aux services

| Service | URL | Identifiants |
|---------|-----|--------------|
| **Grafana** | http://localhost:3001 | admin / admin |
| **Loki** | http://localhost:3101 | Aucun (auth désactivée) |
| **Alloy** | http://localhost:8080 | Aucun |

## Tableaux de bord

### Dashboard par défaut: OSIRIS — Overview

- **Logs par Service** — Volume de logs par conteneur
- **Erreurs par Niveau** — Répartition error/warn/info
- **Statut des Conteneurs** — État de santé des services

### Requêtes Loki utiles

```logql
# Tous les logs d'un service
{container_name="osiris"}

# Erreurs uniquement
{level=~"error|critical"}

# Logs des dernières 5 minutes
{container_name=~"osiris|osiris-intel"} | json

# Erreurs avec contexte
{level="error"} | json | line_format "{{.time}} {{.container_name}} {{.log}}"
```

## Migration depuis Promtail

**Note:** Le projet OSIRIS utilise déjà Grafana Alloy. Cette section est conservée pour référence si vous migrez depuis une ancienne installation utilisant Promtail.

```bash
# 1. Exporter la configuration Promtail
docker run grafana/alloy:latest migrate promtail /path/to/promtail.yaml /path/to/config.alloy

# 2. Tester la configuration
docker run grafana/alloy:latest test /path/to/config.alloy

# 3. Déployer Alloy
docker compose -f alloy/docker-compose.logging.yml up -d

# 4. Arrêter Promtail
docker compose stop promtail
docker compose rm promtail
```

## Dépannage

### Alloy ne collecte pas les logs

```bash
# Vérifier les logs Alloy
docker compose -f alloy/docker-compose.logging.yml logs osiris-alloy

# Vérifier l'accès au socket Docker
docker compose exec osiris-alloy ls -la /var/run/docker.sock

# Tester la collecte
docker compose exec osiris-alloy alloy fmt /etc/alloy/config.alloy
```

### Loki ne reçoit pas les logs

```bash
# Vérifier Loki
docker compose -f alloy/docker-compose.logging.yml logs osiris-loki

# Tester l'API Loki
curl http://localhost:3101/ready

# Vérifier les labels
curl -G -s "http://localhost:3101/loki/api/v1/labels" | jq .
```

### Grafana n'affiche pas les logs

```bash
# Vérifier le datasource
# Dans Grafana: Configuration > Data Sources > Loki > Test

# Vérifier les logs bruts
curl -G -s "http://localhost:3101/loki/api/v1/query_range" \
  --data-urlencode 'query={container_name="osiris"}' \
  --data-urlencode 'limit=10' | jq .
```

## Bonnes pratiques

### 1. Rétention des logs

```yaml
# loki/loki-config.yml
table_manager:
  retention_deletes_enabled: true
  retention_period: 720h  # 30 jours
```

### 2. Limites de requêtes

```yaml
limits_config:
  max_query_series: 5000
  max_entries_limit_per_query: 5000
```

### 3. Sécurité

- ⚠️ **Auth désactivée** (`auth_enabled: false`) — Activer en production
- ⚠️ **Pas de TLS** — Ajouter un reverse proxy (nginx) en production
- ⚠️ **Réseau non isolé** — Utiliser des réseaux Docker séparés

### 4. Monitoring

```bash
# Vérifier l'utilisation du disque
docker compose -f alloy/docker-compose.logging.yml exec osiris-loki df -h /loki

# Vérifier les métriques Loki
curl http://localhost:3101/metrics | grep loki_ingester_streams
```

## Coûts estimés

| Service | Stockage | RAM | CPU |
|---------|----------|-----|-----|
| Loki | 10-50 GB | 512 MB | 0.5 core |
| Grafana | 1 GB | 256 MB | 0.1 core |
| Alloy | 1 GB | 128 MB | 0.1 core |

**Total:** ~1 GB RAM, ~1 core CPU, ~50 GB stockage pour 30 jours de logs.

## Ressources

- [Grafana Alloy Documentation](https://grafana.com/docs/alloy/latest/)
- [Loki Documentation](https://grafana.com/docs/loki/latest/)
- [Migration Guide Promtail → Alloy](https://grafana.com/docs/alloy/latest/migrate/from-promtail/)
- [Grafana Documentation](https://grafana.com/docs/grafana/latest/)

## Support

Pour les problèmes :
1. Vérifier les logs : `docker compose -f alloy/docker-compose.logging.yml logs`
2. Consulter la documentation officielle
3. Ouvrir une issue sur GitHub