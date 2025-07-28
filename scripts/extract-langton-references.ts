#!/usr/bin/env bun

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

interface MatchResult {
  file: string;
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
}

async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function traverse(currentDir: string) {
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Skipping directory ${currentDir}: ${error}`);
    }
  }

  await traverse(dir);
  return files;
}

async function findLangtonReferences(filePath: string): Promise<MatchResult[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const matches: MatchResult[] = [];

    const langtonRegex = /langton/gi;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (langtonRegex.test(line)) {
        // Reset regex for next match
        langtonRegex.lastIndex = 0;

        const contextBefore = [];
        const contextAfter = [];

        // Get 10 lines before
        for (let j = Math.max(0, i - 10); j < i; j++) {
          contextBefore.push(`${j + 1}→${lines[j]}`);
        }

        // Get 10 lines after
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + 10); j++) {
          contextAfter.push(`${j + 1}→${lines[j]}`);
        }

        matches.push({
          file: filePath,
          lineNumber: i + 1,
          line: `${i + 1}→${line}`,
          contextBefore,
          contextAfter
        });
      }
    }

    return matches;
  } catch (error) {
    console.warn(`Error reading file ${filePath}: ${error}`);
    return [];
  }
}

async function main() {
  const serverDir = 'server';
  // const testsDir = 'tests/unit';
  // const tests2Dir = 'tests/config';
  // const tests3Dir = 'tests/e2e';
  // const tests4Dir = 'tests/utils';

  if (!existsSync(serverDir) || !existsSync(testsDir)) {
    console.error('server/ or tests/ directory not found');
    process.exit(1);
  }

  console.log('Finding all files in server/ and tests/ directories...');

  const serverFiles = await getAllFiles(serverDir);
  const testFiles = await getAllFiles(testsDir);
  const test2Files = await getAllFiles(tests2Dir);
  const test3Files = await getAllFiles(tests3Dir);
  const test4Files = await getAllFiles(tests4Dir);
  const allFiles = [...serverFiles, ...testFiles, ...test2Files, ...test3Files, ...test4Files,];

  console.log(`Found ${allFiles.length} files to search...`);

  const allMatches: MatchResult[] = [];

  for (const file of allFiles) {
    const matches = await findLangtonReferences(file);
    allMatches.push(...matches);
  }

  console.log(`Found ${allMatches.length} references to 'langton'`);

  // Group matches by file
  const matchesByFile = new Map<string, MatchResult[]>();

  for (const match of allMatches) {
    if (!matchesByFile.has(match.file)) {
      matchesByFile.set(match.file, []);
    }
    matchesByFile.get(match.file)!.push(match);
  }

  // Generate the output
  let output = `# Langton References Report
# Generated on ${new Date().toISOString()}
# Found ${allMatches.length} references across ${matchesByFile.size} files

`;

  // Sort files for consistent output
  const sortedFiles = Array.from(matchesByFile.keys()).sort();

  for (const file of sortedFiles) {
    const matches = matchesByFile.get(file)!;

    output += `<${file}>\n`;
    output += `Found ${matches.length} reference${matches.length === 1 ? '' : 's'} to 'langton'\n\n`;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];

      output += `=== Match ${i + 1} at line ${match.lineNumber} ===\n`;

      // Context before
      if (match.contextBefore.length > 0) {
        output += '--- Context Before ---\n';
        for (const line of match.contextBefore) {
          output += `${line}\n`;
        }
      }

      // The match line (highlighted)
      output += '--- MATCH ---\n';
      output += `>>> ${match.line} <<<\n`;

      // Context after
      if (match.contextAfter.length > 0) {
        output += '--- Context After ---\n';
        for (const line of match.contextAfter) {
          output += `${line}\n`;
        }
      }

      output += '\n';
    }

    output += `</${file}>\n\n`;
  }

  // Write to file
  const outputFile = 'intermediates/13-langton-to-tadpole/langton-references-report.txt';
  await writeFile(outputFile, output, 'utf-8');

  console.log(`Report saved to ${outputFile}`);
  console.log(`Summary:`);
  console.log(`- Total references: ${allMatches.length}`);
  console.log(`- Files with references: ${matchesByFile.size}`);
  console.log(`- Files searched: ${allFiles.length}`);
}

main().catch(console.error);
