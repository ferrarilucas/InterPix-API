import dotenv from 'dotenv';
import path from 'path';
import { runMigrations } from '../shared/migrations';

dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

export async function setup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_TEST;
  if (!connectionString) {
    throw new Error('DATABASE_URL_TEST nao definida');
  }
  process.env.DATABASE_URL = connectionString;
  await runMigrations(connectionString);
}
