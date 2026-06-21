import { stdin, stdout } from 'node:process';
import { assertSupportedNodeVersion } from '../src/config.js';
import { hashPassword } from '../src/security.js';

assertSupportedNodeVersion();
if (!stdin.isTTY) throw new Error('Run this command in an interactive terminal so the password can be entered without echoing.');

const first = await hiddenPrompt('New admin password: ');
const second = await hiddenPrompt('Confirm password: ');
if (first.length < 12) throw new Error('Use an admin password of at least 12 characters.');
if (first !== second) throw new Error('Passwords did not match.');
console.log(await hashPassword(first));

function hiddenPrompt(label) {
  return new Promise((resolve, reject) => {
    let value = '';
    let complete = false;
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const finish = (callback) => {
      if (complete) return;
      complete = true;
      cleanup();
      callback();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(() => reject(new Error('Cancelled')));
        if (character === '\r' || character === '\n') return finish(() => resolve(value));
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}
