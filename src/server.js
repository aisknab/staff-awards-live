import { assertSupportedNodeVersion, loadConfig } from './config.js';
import { createApplication } from './app.js';

assertSupportedNodeVersion();
const config = loadConfig();
const application = createApplication({ config });

await application.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'Shutdown requested', signal })}\n`);
  try {
    await application.stop();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', message: 'Shutdown failed', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
