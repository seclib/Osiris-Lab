'use strict';

const EventEmitter = require('events');
const path = require('path');
const { BaseSensor } = require('./base-sensor');

function asPositiveNumber(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nowIso() {
  return new Date().toISOString();
}

function lifecycleSnapshot(lifecycle) {
  const {
    attachedInstance,
    restartTimer,
    ...publicLifecycle
  } = lifecycle;
  return publicLifecycle;
}

function findSensorExport(definition) {
  const explicit = definition.Sensor || definition.default || definition.sensor;
  if (typeof explicit === 'function') return explicit;

  for (const value of Object.values(definition)) {
    if (typeof value !== 'function') continue;
    if (value.prototype instanceof BaseSensor) return value;
  }

  for (const [name, value] of Object.entries(definition)) {
    if (typeof value === 'function' && /sensor$/i.test(name)) return value;
  }

  return null;
}

function normalizeDefinition(id, definition) {
  if (typeof definition === 'function') {
    return { id, Sensor: definition, defaults: {} };
  }

  if (!definition || typeof definition !== 'object') {
    throw new Error(`invalid_sensor_definition:${id}`);
  }

  const Sensor = findSensorExport(definition);
  const createSensor = definition.createSensor || definition.create || definition.factory;
  return {
    id: definition.id || id,
    Sensor,
    createSensor,
    defaults: definition.defaults || definition.config || {},
  };
}

function isSensorInstance(value) {
  return value && typeof value.start === 'function' && typeof value.stop === 'function' && typeof value.health === 'function';
}

class SensorRegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || console;
    this.baseOptions = options.baseOptions || {};
    this.autoRestart = options.autoRestart !== false;
    this.failureThreshold = asPositiveNumber(options.failureThreshold ?? process.env.SENSOR_REGISTRY_FAILURE_THRESHOLD, 3, 1);
    this.restartCooldownMs = asPositiveNumber(options.restartCooldownMs ?? process.env.SENSOR_REGISTRY_RESTART_COOLDOWN_MS, 15000, 1000);
    this.maxRestarts = asPositiveNumber(options.maxRestarts ?? process.env.SENSOR_REGISTRY_MAX_RESTARTS, 0, 0);
    this.healthCheckIntervalMs = asPositiveNumber(options.healthCheckIntervalMs ?? process.env.SENSOR_REGISTRY_HEALTH_INTERVAL_MS, 15000, 1000);
    this.definitions = new Map();
    this.instances = new Map();
    this.instanceOptions = new Map();
    this.desired = new Set();
    this.lifecycle = new Map();
    this.monitorTimer = null;
  }

  register(id, definition, defaults = {}) {
    const normalized = normalizeDefinition(id, definition);
    normalized.defaults = { ...normalized.defaults, ...defaults };
    this.definitions.set(normalized.id, normalized);
    this.lifecycleFor(normalized.id).status = 'REGISTERED';
    return this;
  }

  load(modulePath, id = null, defaults = {}) {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
    const loaded = require(resolved);
    const sensorId = id || loaded.id || path.basename(modulePath, path.extname(modulePath));
    return this.register(sensorId, loaded, defaults);
  }

  loadMany(entries = []) {
    for (const entry of entries) {
      if (typeof entry === 'string') {
        this.load(entry);
        continue;
      }

      if (!entry || typeof entry !== 'object') throw new Error('invalid_sensor_registry_entry');
      if (entry.module || entry.path) {
        this.load(entry.module || entry.path, entry.id, entry.defaults || entry.options || {});
      } else if (entry.Sensor || entry.createSensor || entry.factory) {
        this.register(entry.id, entry, entry.defaults || entry.options || {});
      } else {
        throw new Error(`invalid_sensor_registry_entry:${entry.id || 'unknown'}`);
      }
    }
    return this;
  }

  create(id, overrides = {}, options = {}) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`sensor_not_registered:${id}`);
    if (this.instances.has(id) && !options.force) return this.instances.get(id);

    const sensorOptions = {
      ...this.baseOptions,
      ...definition.defaults,
      ...overrides,
      id,
    };

    let instance;
    if (definition.createSensor) {
      instance = definition.createSensor(sensorOptions);
    } else if (definition.Sensor) {
      instance = new definition.Sensor(sensorOptions);
    } else {
      throw new Error(`sensor_factory_missing:${id}`);
    }

    if (!isSensorInstance(instance)) {
      throw new Error(`invalid_sensor_instance:${id}`);
    }

    if (!(instance instanceof BaseSensor)) {
      this.log('warn', 'sensor_instance_not_base_sensor', { id });
    }

    this.instanceOptions.set(id, sensorOptions);
    this.instances.set(id, instance);
    this.lifecycleFor(id).status = instance.enabled === false ? 'DISABLED' : 'CREATED';
    this.attachSupervision(id, instance);
    return instance;
  }

  createFromConfig(config = {}) {
    const sensors = Array.isArray(config.sensors) ? config.sensors : [];
    for (const sensor of sensors) {
      if (!sensor?.id) throw new Error('sensor_config_missing_id');
      if (!this.definitions.has(sensor.id)) {
        if (!sensor.module && !sensor.path) throw new Error(`sensor_config_missing_module:${sensor.id}`);
        this.load(sensor.module || sensor.path, sensor.id, sensor.defaults || {});
      }
      const { id, module, path: sensorPath, defaults, options, ...topLevelOptions } = sensor;
      this.create(sensor.id, { ...topLevelOptions, ...(options || {}) });
    }
    return this;
  }

  async start(ids = null) {
    const selected = ids ? new Set(ids) : null;
    const started = [];

    for (const [id, definition] of this.definitions.entries()) {
      if (selected && !selected.has(id)) continue;
      const instance = await this.startSensor(id, definition.defaults);
      if (instance.enabled === false) continue;
      started.push(id);
    }

    return started;
  }

  async startSensor(id, overrides = {}) {
    let instance = this.instances.get(id);
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    if (instance && hasOverrides && instance.stopped) {
      const existingOptions = this.instanceOptions.get(id) || {};
      this.instances.delete(id);
      instance = this.create(id, { ...existingOptions, ...overrides, id }, { force: true });
    }
    if (!instance) instance = this.create(id, overrides);

    const lifecycle = this.lifecycleFor(id);
    this.desired.add(id);
    lifecycle.desired = true;
    lifecycle.lastStartAttemptAt = nowIso();

    if (instance.enabled === false) {
      lifecycle.status = 'DISABLED';
      return instance;
    }

    if (!instance.stopped) {
      lifecycle.status = 'RUNNING';
      return instance;
    }

    try {
      lifecycle.status = 'STARTING';
      await instance.start();
      lifecycle.status = 'RUNNING';
      lifecycle.startedAt = nowIso();
      lifecycle.lastError = null;
      this.emit('sensor_started', { id });
      this.log('info', 'sensor_started', { id });
      return instance;
    } catch (error) {
      lifecycle.status = 'FAILED';
      lifecycle.lastError = errorMessage(error);
      lifecycle.lastFailureAt = nowIso();
      this.emit('sensor_start_failed', { id, error });
      this.log('error', 'sensor_start_failed', { id, error: lifecycle.lastError });
      this.scheduleRestart(id, 'start_failed', error);
      throw error;
    }
  }

  async stopSensor(id, options = {}) {
    const instance = this.instances.get(id);
    const lifecycle = this.lifecycleFor(id);
    if (options.forgetDesired !== false) this.desired.delete(id);
    lifecycle.desired = this.desired.has(id);
    this.clearRestartTimer(id);

    if (!instance) {
      lifecycle.status = 'STOPPED';
      return null;
    }

    await instance.stop();
    lifecycle.status = 'STOPPED';
    lifecycle.stoppedAt = nowIso();
    this.emit('sensor_stopped', { id });
    this.log('info', 'sensor_stopped', { id });
    return instance;
  }

  async restartSensor(id, reason = 'manual') {
    const lifecycle = this.lifecycleFor(id);
    lifecycle.status = 'RESTARTING';
    lifecycle.restarting = true;
    lifecycle.lastRestartReason = reason;
    this.clearRestartTimer(id);

    const existing = this.instances.get(id);
    if (existing) {
      try {
        await existing.stop();
      } catch (error) {
        this.log('warn', 'sensor_stop_before_restart_failed', { id, error: errorMessage(error) });
      }
    }

    this.instances.delete(id);
    const overrides = this.instanceOptions.get(id) || {};
    const instance = this.create(id, overrides, { force: true });
    this.desired.add(id);
    lifecycle.desired = true;

    try {
      if (instance.enabled !== false) await instance.start();
      lifecycle.status = instance.enabled === false ? 'DISABLED' : 'RUNNING';
      lifecycle.restarts += 1;
      lifecycle.lastRestartAt = nowIso();
      lifecycle.lastError = null;
      this.emit('sensor_restarted', { id, reason });
      this.log('warn', 'sensor_restarted', { id, reason, restarts: lifecycle.restarts });
      return instance;
    } catch (error) {
      lifecycle.status = 'FAILED';
      lifecycle.lastError = errorMessage(error);
      lifecycle.lastFailureAt = nowIso();
      this.emit('sensor_restart_failed', { id, reason, error });
      this.log('error', 'sensor_restart_failed', { id, reason, error: lifecycle.lastError });
      this.scheduleRestart(id, 'restart_failed', error);
      throw error;
    } finally {
      lifecycle.restarting = false;
    }
  }

  async stop() {
    this.stopMonitor();
    const errors = [];
    for (const [id, instance] of this.instances.entries()) {
      try {
        await this.stopSensor(id);
      } catch (error) {
        errors.push({ id, error: errorMessage(error) });
      }
    }
    if (errors.length) {
      const error = new Error('sensor_registry_stop_failed');
      error.errors = errors;
      throw error;
    }
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  list() {
    return [...this.definitions.keys()];
  }

  health() {
    const sensors = [...this.definitions.keys()].map((id) => {
      const instance = this.instances.get(id);
      return {
        id,
        desired: this.desired.has(id),
        lifecycle: lifecycleSnapshot(this.lifecycleFor(id)),
        health: instance ? instance.health() : { id, status: 'NOT_CREATED', enabled: false },
      };
    });

    const hasFailed = sensors.some((sensor) => ['FAILED', 'RESTART_EXHAUSTED'].includes(sensor.lifecycle.status));
    const hasDegraded = sensors.some((sensor) => sensor.health.status === 'DEGRADED' || sensor.lifecycle.status === 'RESTART_SCHEDULED');

    return {
      status: hasFailed ? 'CRITICAL' : hasDegraded ? 'DEGRADED' : 'OK',
      registered: this.definitions.size,
      running: this.instances.size,
      desired: this.desired.size,
      autoRestart: this.autoRestart,
      failureThreshold: this.failureThreshold,
      restartCooldownMs: this.restartCooldownMs,
      maxRestarts: this.maxRestarts,
      sensors,
    };
  }

  lifecycleFor(id) {
    if (!this.lifecycle.has(id)) {
      this.lifecycle.set(id, {
        status: 'UNKNOWN',
        desired: false,
        restarts: 0,
        restarting: false,
        restartScheduledAt: null,
        restartDueAt: null,
        lastRestartAt: null,
        lastRestartReason: null,
        lastStartAttemptAt: null,
        lastFailureAt: null,
        lastError: null,
        startedAt: null,
        stoppedAt: null,
      });
    }
    return this.lifecycle.get(id);
  }

  attachSupervision(id, instance) {
    const lifecycle = this.lifecycleFor(id);
    if (lifecycle.attachedInstance === instance) return;
    lifecycle.attachedInstance = instance;

    instance.on('failure', (error) => {
      lifecycle.lastFailureAt = nowIso();
      lifecycle.lastError = errorMessage(error);
      this.emit('sensor_failure', { id, error });

      const health = instance.health();
      if (this.autoRestart && this.desired.has(id) && health.consecutiveFailures >= this.failureThreshold) {
        this.scheduleRestart(id, 'failure_threshold', error);
      }
    });

    instance.on('poll', (event) => {
      lifecycle.status = 'RUNNING';
      lifecycle.lastError = null;
      this.emit('sensor_poll', { id, ...event });
    });
  }

  scheduleRestart(id, reason, error = null) {
    if (!this.autoRestart || !this.desired.has(id)) return false;

    const lifecycle = this.lifecycleFor(id);
    if (lifecycle.restartTimer || lifecycle.restarting) return false;
    if (this.maxRestarts > 0 && lifecycle.restarts >= this.maxRestarts) {
      lifecycle.status = 'RESTART_EXHAUSTED';
      lifecycle.lastError = error ? errorMessage(error) : lifecycle.lastError;
      this.log('error', 'sensor_restart_exhausted', { id, reason, restarts: lifecycle.restarts });
      return false;
    }

    const retryAfterMs = asPositiveNumber(error?.retryAfterMs, 0, 0);
    const delayMs = Math.max(this.restartCooldownMs, retryAfterMs);
    lifecycle.status = 'RESTART_SCHEDULED';
    lifecycle.lastRestartReason = reason;
    lifecycle.restartScheduledAt = nowIso();
    lifecycle.restartDueAt = new Date(Date.now() + delayMs).toISOString();
    lifecycle.restartTimer = setTimeout(() => {
      lifecycle.restartTimer = null;
      this.restartSensor(id, reason).catch((restartError) => {
        this.scheduleRestart(id, 'restart_failed', restartError);
      });
    }, delayMs);
    lifecycle.restartTimer.unref?.();

    this.emit('sensor_restart_scheduled', { id, reason, delayMs });
    this.log('warn', 'sensor_restart_scheduled', { id, reason, delayMs });
    return true;
  }

  clearRestartTimer(id) {
    const lifecycle = this.lifecycleFor(id);
    if (lifecycle.restartTimer) clearTimeout(lifecycle.restartTimer);
    lifecycle.restartTimer = null;
    lifecycle.restartDueAt = null;
  }

  startMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this.supervise(), this.healthCheckIntervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  supervise() {
    for (const id of this.desired) {
      const instance = this.instances.get(id);
      if (!instance) {
        this.scheduleRestart(id, 'missing_instance');
        continue;
      }

      const health = instance.health();
      if (instance.enabled !== false && instance.stopped) {
        this.scheduleRestart(id, 'unexpected_stop');
        continue;
      }

      if (instance.enabled !== false && health.consecutiveFailures >= this.failureThreshold) {
        this.scheduleRestart(id, 'health_failure_threshold');
      }
    }
  }

  log(level, message, fields = {}) {
    const logger = this.logger?.[level] || this.logger?.log || console.log;
    logger.call(this.logger, message, fields);
  }

  static fromEnv(options = {}) {
    const registry = new SensorRegistry(options);
    const raw = process.env.OSIRIS_SENSORS_JSON;
    if (!raw) return registry;

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return registry.loadMany(parsed);
    return registry.createFromConfig(parsed);
  }
}

module.exports = {
  SensorRegistry,
  normalizeDefinition,
};
