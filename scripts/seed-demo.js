import { assertSupportedNodeVersion, loadConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import { ResultService } from '../src/result-service.js';
import { EventService } from '../src/event-service.js';

assertSupportedNodeVersion();
if (!process.argv.includes('--yes')) throw new Error('This creates a draft event in the configured database. Re-run with: npm run seed -- --yes');
const config = loadConfig();
const database = new Database(config.databasePath, { migrationsDir: config.migrationsDir });
try {
  const results = new ResultService(database, config);
  const events = new EventService(database, config, results);
  const nominees = [
    'Alex Smith | Sales', 'Blair Chen | Engineering', 'Casey Jones | Operations', 'Dev Singh | Marketing',
    'Emilia Park | Finance', 'Frank Wilson | Product', 'Georgia Brown | People', 'Harper Lee | Support',
  ].map((line, index) => {
    const [displayName, subtitle] = line.split('|').map((part) => part.trim());
    return { key: `n${index + 1}`, displayName, subtitle };
  });
  const eligibleNomineeKeys = nominees.map((nominee) => nominee.key);
  const event = events.saveConfig({
    title: 'Staff Awards Demo',
    subtitle: 'A safe event to rehearse the controller workflow',
    participantLimit: 30,
    nominees,
    awards: [
      { title: 'Mr Mute', description: 'The person most likely to deliver their best point while still on mute', eligibleNomineeKeys },
      { title: 'Reply All Hero', description: 'For services to unnecessarily broad email distribution', eligibleNomineeKeys },
      { title: 'Meeting That Could Have Been an Email', description: 'For outstanding contributions to calendar congestion', eligibleNomineeKeys },
      { title: 'Spreadsheet Sorcerer', description: 'For making spreadsheets do things nobody thought were legal', eligibleNomineeKeys },
    ],
  });
  console.log(JSON.stringify({ created: true, eventId: event.id, title: event.title }));
} finally {
  database.close();
}
