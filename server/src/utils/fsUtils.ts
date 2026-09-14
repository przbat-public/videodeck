import fs from 'fs/promises';

/**
 * File names in a folder without the dotfiles (the app's own helper files:
 * `.videos-index.json` and friends must never be mistaken for videos).
 */
export async function listVisibleFiles(folderPath: string): Promise<string[]> {
  const files = await fs.readdir(folderPath);
  return files.filter((file) => !file.startsWith('.'));
}
