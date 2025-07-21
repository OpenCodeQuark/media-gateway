
import fs from 'fs/promises';
import path from 'path';
import { setTimeout } from 'timers/promises';

export function scheduleCleanup(directory, maxAgeMinutes) {
  const interval = Math.min(30, maxAgeMinutes) * 60 * 1000; // Max 30 min interval

  const cleaner = async () => {
    try {
      const now = Date.now();
      const files = await fs.readdir(directory);

      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        const ageMinutes = (now - stats.birthtime) / (1000 * 60);

        if (ageMinutes > maxAgeMinutes) {
          await fs.unlink(filePath);
          console.log(`Cleaned up: ${file}`);
        }
      }
    } catch (error) {
      console.error('Cleanup error:', error.message);
    } finally {
      setTimeout(interval, cleaner);
    }
  };

  // Initial run
  setTimeout(interval, cleaner);
  console.log(`File cleanup scheduled every ${interval / 60000} minutes`);
}
