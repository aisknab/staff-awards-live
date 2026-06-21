import { randomBytes } from 'node:crypto';
import { assertSupportedNodeVersion } from '../src/config.js';

assertSupportedNodeVersion();
console.log(randomBytes(48).toString('base64url'));
