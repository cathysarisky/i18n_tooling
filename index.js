#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { analyzePR } from './src/analyzer.js';
import { postComments, deleteEmptyPendingReview } from './src/github.js';
import fs from 'fs/promises';
import path from 'path';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('ghost-i18n-tooling')
  .description('Analyze Ghost PR changes and validate with AI')
  .version('1.0.0');

program
  .command('analyze <pr-number>')
  .description('Analyze a specific PR and generate validation report')
  .option('-o, --output <file>', 'Output file for the report (relative to ai_validations/)', '')
  .option('-d, --dry-run', 'Run analysis without posting comments')
  .action(async (prNumber, options) => {
    try {
      console.log(chalk.blue(`🔍 Analyzing PR #${prNumber}...`));
      
      // Ensure ai_validations directory exists
      const aiValidationsDir = path.join(process.cwd(), 'ai_validations');
      await fs.mkdir(aiValidationsDir, { recursive: true });
      
      // Set default output path if not specified
      if (!options.output) {
        options.output = path.join('ai_validations', `${prNumber}.json`);
      } else if (!options.output.includes('/') && !options.output.includes('\\')) {
        // If just a filename is provided, put it in ai_validations
        options.output = path.join('ai_validations', options.output);
      }
      
      const report = await analyzePR(prNumber, options);
      
      if (options.dryRun) {
        console.log(chalk.yellow('📝 Dry run mode - no comments will be posted'));
      } else {
        console.log(chalk.green('✅ Analysis complete!'));
        console.log(chalk.cyan(`📊 Report saved to: ${options.output}`));
      }
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('post <pr-number>')
  .description('Post approved comments from a report to a PR')
  .action(async (prNumber) => {
    try {
      const reportFile = `ai_validations/${prNumber}.json`;
      console.log(chalk.blue(`📤 Posting comments to PR #${prNumber} from ${reportFile}...`));
      
      await postComments(prNumber, reportFile);
      
      console.log(chalk.green('✅ Comments posted successfully!'));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('review <pr-number>')
  .description('Analyze a PR and post comments in one step')
  .option('-d, --dry-run', 'Run analysis without posting comments')
  .action(async (prNumber, options) => {
    try {
      console.log(chalk.blue(`🔍 Starting full review process for PR #${prNumber}...`));
      
      // Step 1: Analyze
      console.log(chalk.cyan('\n📋 Step 1: Analyzing PR...'));
      const report = await analyzePR(prNumber, options);
      
      if (!report) {
        console.log(chalk.red('❌ Analysis failed or no i18n files found.'));
        return;
      }
      
      // Step 2: Post comments (unless dry run)
      if (options.dryRun) {
        console.log(chalk.yellow('\n📝 Dry run mode - skipping comment posting'));
        console.log(chalk.blue(`📊 Report saved to: ai_validations/${prNumber}.json`));
      } else {
        console.log(chalk.cyan('\n📤 Step 2: Posting comments...'));
        const reportFile = `ai_validations/${prNumber}.json`;
        await postComments(prNumber, reportFile);
        console.log(chalk.green('\n✅ Full review process completed!'));
      }
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('clean-pending <pr-number>')
  .description('Delete an empty pending review for a PR (if it exists)')
  .action(async (prNumber) => {
    try {
      await deleteEmptyPendingReview(prNumber);
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program.parse(); 