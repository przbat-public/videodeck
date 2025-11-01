#!/usr/bin/env node

/**
 * Wrapper script that allows Jest Runner extension to run Vitest tests
 * This script translates Jest Runner commands to Vitest commands
 * Note: This file uses CommonJS syntax despite being in an ES module project
 */

import { spawn } from 'child_process';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { chdir } from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get arguments passed by Jest Runner
const args = process.argv.slice(2);

// Find the test file path (usually the first argument that ends with .test.ts or .test.tsx)
const testFileIndex = args.findIndex(arg => /\.(test|spec)\.(ts|tsx)$/.test(arg));
const testFile = testFileIndex >= 0 ? args[testFileIndex] : null;

// Extract test name from -t flag (Jest uses -t, Vitest also uses -t)
const testNameIndex = args.indexOf('-t');
const testName = testNameIndex >= 0 && args[testNameIndex + 1] ? args[testNameIndex + 1] : null;

// Build vitest command
const vitestArgs = ['run'];

if (testFile) {
  // Convert relative path to absolute if needed
  const absoluteTestFile = isAbsolute(testFile) 
    ? testFile 
    : join(process.cwd(), testFile);
  vitestArgs.push(absoluteTestFile);
}

if (testName) {
  vitestArgs.push('-t', testName);
}

// Get vitest binary path
const vitestPath = join(__dirname, 'node_modules', '.bin', 'vitest');

// Change to client directory
chdir(__dirname);

// Run vitest
const vitestProcess = spawn(vitestPath, vitestArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

vitestProcess.on('exit', (code) => {
  process.exit(code || 0);
});

vitestProcess.on('error', (error) => {
  console.error('Error running vitest:', error);
  process.exit(1);
});

