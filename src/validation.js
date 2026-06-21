import { badRequest } from './errors.js';
import { normalizeText } from './utils.js';

export function object(value, name = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('VALIDATION_ERROR', `${name} must be an object`);
  return value;
}

export function text(value, name, { required = true, max = 100 } = {}) {
  const result = normalizeText(value);
  if (required && !result) throw badRequest('VALIDATION_ERROR', `${name} is required`);
  if (result.length > max) throw badRequest('VALIDATION_ERROR', `${name} must not exceed ${max} characters`);
  return result;
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest('VALIDATION_ERROR', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw badRequest('VALIDATION_ERROR', `${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function array(value, name, { min = 0, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw badRequest('VALIDATION_ERROR', `${name} must contain between ${min} and ${max} items`);
  }
  return value;
}

export function idText(value, name = 'id') {
  const result = text(value, name, { max: 80 });
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw badRequest('VALIDATION_ERROR', `${name} is invalid`);
  return result;
}

export function optionalVersion(value, name) {
  if (value === undefined || value === null) return null;
  return integer(value, name, { min: 0, max: 2147483647 });
}
