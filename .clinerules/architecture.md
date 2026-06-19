# OSIRIS ARCHITECTURE RULES

- Event-driven system (NATS JetStream)
- Plugin-based architecture
- AI-first design
- Graph-based intelligence layer
- Distributed microservices

No service is allowed to directly depend on another service.

All communication MUST go through:

- Event Bus (NATS)
- or API Gateway
