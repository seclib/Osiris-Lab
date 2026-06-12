'use strict';

const path = require('path');
const { BaseSensor } = require('./base-sensor');

function normalizeDefinition(id, definition) {
  if (typeof definition === 'function') {
    return { id, Sensor: definition, defaults: {} };
  }

  if (!definition || typeof definition !== 'object') {
    throw new Error(`invalid_sensor_definition:${id}`);
  }

  const Sensor = definition.Sensor || definition.default || definition.sensor;
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

class SensorRegistry {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.baseOptions = options.baseOptions || {};
    this.definitions = new Map();
    this.instances = new Map();
  }

  register(id, definition, defaults = {}) {
    const normalized = normalizeDefinition(id, definition);
    normalized.defaults = { ...normalized.defaults, ...defaults };
    this.definitions.set(normalized.id, normalized);
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

  create(id, overrides = {}) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`sensor_not_registered:${id}`);

    const options = {
      ...this.baseOptions,
      ...definition.defaults,
      ...overrides,
      id,
    };

    let instance;
    if (definition.createSensor) {
      instance = definition.createSensor(options);
    } else if (definition.Sensor) {
      instance = new definition.Sensor(options);
    } else {
      throw new Error(`sensor_factory_missing:${id}`);
    }

    if (!isSensorInstance(instance)) {
      throw new Error(`invalid_sensor_instance:${id}`);
    }

    if (!(instance instanceof BaseSensor)) {
      this.log('warn', 'sensor_instance_not_base_sensor', { id });
    }

    this.instances.set(id, instance);
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
      this.create(sensor.id, sensor.options || sensor);
    }
    return this;
  }

  async start(ids = null) {
    const selected = ids ? new Set(ids) : null;
    const started = [];

    for (const [id, definition] of this.definitions.entries()) {
      if (selected && !selected.has(id)) continue;
      const instance = this.instances.get(id) || this.create(id, definition.defaults);
      if (instance.enabled === false) continue;
      await instance.start();
      started.push(id);
    }

    return started;
  }

  async stop() {
    const errors = [];
    for (const [id, instance] of this.instances.entries()) {
      try {
        await instance.stop();
      } catch (error) {
        errors.push({ id, error: error instanceof Error ? error.message : String(error) });
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
    return {
      registered: this.definitions.size,
      running: this.instances.size,
      sensors: [...this.instances.values()].map((sensor) => sensor.health()),
    };
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
