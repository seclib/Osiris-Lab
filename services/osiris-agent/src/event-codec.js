'use strict';

function fieldsToObject(fields) {
  if (Array.isArray(fields)) {
    const object = {};
    for (let i = 0; i < fields.length; i += 2) object[String(fields[i])] = fields[i + 1];
    return object;
  }
  return fields || {};
}

function decodeEvent(fields) {
  const object = fieldsToObject(fields);
  if (object.event) return JSON.parse(object.event);
  return {
    id: object.id,
    type: object.type,
    timestamp: object.timestamp,
    geo: JSON.parse(object.geo || '{}'),
    payload: JSON.parse(object.payload || '{}'),
    metadata: JSON.parse(object.metadata || '{}'),
  };
}

function encodeFields(record) {
  const fields = {};
  for (const [key, value] of Object.entries(record)) {
    fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return fields;
}

function flatFieldArgs(fields) {
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    args.push(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return args;
}

function parseStreamResponse(response) {
  if (!Array.isArray(response)) return [];
  const output = [];
  for (const streamResult of response) {
    const stream = streamResult?.[0];
    const messages = streamResult?.[1] || [];
    for (const message of messages) {
      output.push({ stream, id: message[0], fields: fieldsToObject(message[1]) });
    }
  }
  return output;
}

function parseAutoClaimResponse(response, stream) {
  if (!Array.isArray(response)) return { nextId: '0-0', messages: [] };
  const messages = Array.isArray(response[1]) ? response[1] : [];
  return {
    nextId: response[0] || '0-0',
    messages: messages.map((message) => ({
      stream,
      id: message[0],
      fields: fieldsToObject(message[1]),
    })),
  };
}

function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') errors.push('invalid_event');
  if (!event?.id) errors.push('missing_id');
  if (!['adsb', 'ais', 'weather', 'quake', 'wildfire'].includes(event?.type)) errors.push('invalid_type');
  if (!event?.timestamp || Number.isNaN(Date.parse(event.timestamp))) errors.push('invalid_timestamp');
  if (!Number.isFinite(event?.geo?.lat) || !Number.isFinite(event?.geo?.lon)) errors.push('invalid_geo');
  return errors;
}

module.exports = {
  decodeEvent,
  encodeFields,
  fieldsToObject,
  flatFieldArgs,
  parseAutoClaimResponse,
  parseStreamResponse,
  validateEvent,
};
