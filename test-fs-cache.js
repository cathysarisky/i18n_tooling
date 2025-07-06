#!/usr/bin/env node

import { getOriginalFileContent } from './src/analyzer.js';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

async function testFilesystemCache() {
  console.log(chalk.blue('🧪 Testing filesystem caching for context.json...\n'));
  
  // Clean up any existing cache
  const cacheFile = path.join('cache', 'context.json');
  try {
    await fs.unlink(cacheFile);
    console.log(chalk.gray('🗑️  Removed existing cache file'));
  } catch (error) {
    // Cache file doesn't exist, that's fine
  }
  
  // First call - should fetch from GitHub and create cache
  console.log(chalk.cyan('📞 Call 1: Should fetch from GitHub and cache'));
  const result1 = await getOriginalFileContent('ghost/i18n/locales/context.json');
  console.log(chalk.green(`✅ Result 1: ${result1 ? result1.length : 0} characters\n`));
  
  // Check if cache file was created
  try {
    const stats = await fs.stat(cacheFile);
    console.log(chalk.green(`✅ Cache file created at: ${cacheFile}`));
    console.log(chalk.gray(`   Size: ${stats.size} bytes, Modified: ${stats.mtime}\n`));
  } catch (error) {
    console.log(chalk.red(`❌ Cache file not created: ${error.message}\n`));
  }
  
  // Second call - should use cache
  console.log(chalk.cyan('📞 Call 2: Should use cache'));
  const result2 = await getOriginalFileContent('ghost/i18n/locales/context.json');
  console.log(chalk.green(`✅ Result 2: ${result2 ? result2.length : 0} characters\n`));
  
  // Third call - should use cache
  console.log(chalk.cyan('📞 Call 3: Should use cache'));
  const result3 = await getOriginalFileContent('ghost/i18n/locales/context.json');
  console.log(chalk.green(`✅ Result 3: ${result3 ? result3.length : 0} characters\n`));
  
  // Verify results are identical
  if (result1 && result2 && result3 && result1 === result2 && result2 === result3) {
    console.log(chalk.green('🎉 Filesystem cache test passed! All results are identical.'));
  } else {
    console.log(chalk.red('❌ Filesystem cache test failed! Results are not identical.'));
  }
  
  // Show cache file info
  try {
    const stats = await fs.stat(cacheFile);
    console.log(chalk.blue(`\n📁 Cache file info:`));
    console.log(chalk.gray(`   Path: ${cacheFile}`));
    console.log(chalk.gray(`   Size: ${stats.size} bytes`));
    console.log(chalk.gray(`   Modified: ${stats.mtime}`));
    console.log(chalk.gray(`   Age: ${Math.round((Date.now() - stats.mtime.getTime()) / 1000)} seconds`));
  } catch (error) {
    console.log(chalk.red(`❌ Could not read cache file: ${error.message}`));
  }
}

testFilesystemCache().catch(console.error); 