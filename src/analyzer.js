import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize APIs
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function analyzePR(prNumber, options = {}) {
  console.log(chalk.blue('📋 Fetching PR data...'));
  
  // Fetch PR details
  const { data: pr } = await octokit.pulls.get({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    pull_number: prNumber,
  });

  console.log(chalk.green(`✅ PR #${prNumber}: ${pr.title}`));

  // Fetch PR files
  const { data: files } = await octokit.pulls.listFiles({
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    pull_number: prNumber,
  });

  console.log(chalk.blue(`📁 Found ${files.length} changed files`));

  // Filter for i18n locale files only
  const i18nPattern = /^ghost\/i18n\/locales\/.*\.json$/;
  const relevantFiles = files.filter(file => i18nPattern.test(file.filename));
  const nonI18nFiles = files.filter(file => !i18nPattern.test(file.filename));

  // Display information about non-i18n files
  if (nonI18nFiles.length > 0) {
    console.log(chalk.yellow(`⚠️  Skipping ${nonI18nFiles.length} non-i18n files:`));
    nonI18nFiles.forEach(file => {
      console.log(chalk.gray(`    - ${file.filename} (${file.status})`));
    });
    console.log(chalk.blue(`   Only files matching 'ghost/i18n/locales/**/**.json' will be analyzed.\n`));
  }

  if (relevantFiles.length === 0) {
    console.log(chalk.red('❌ No i18n locale files found in this PR.'));
    console.log(chalk.blue('   This tool only analyzes files matching: ghost/i18n/locales/**/**.json'));
    return null;
  }

  console.log(chalk.blue(`🔍 Analyzing ${relevantFiles.length} i18n locale files...`));

  const analysisResults = [];

  for (const file of relevantFiles) {
    console.log(chalk.cyan(`  📄 ${file.filename}`));
    
    const fileAnalysis = await analyzeFile(file, pr);
    if (fileAnalysis) {
      analysisResults.push(fileAnalysis);
    }
  }

  // Generate report
  const report = {
    prNumber: parseInt(prNumber),
    prTitle: pr.title,
    prUrl: pr.html_url,
    analyzedAt: new Date().toISOString(),
    files: analysisResults,
    skippedFiles: nonI18nFiles.map(f => ({ filename: f.filename, status: f.status })),
    summary: {
      totalFiles: files.length,
      i18nFiles: relevantFiles.length,
      skippedFiles: nonI18nFiles.length,
      filesWithIssues: analysisResults.filter(r => r.issues.length > 0).length,
      totalIssues: analysisResults.reduce((sum, r) => sum + r.issues.length, 0),
    }
  };

  // Save report
  const outputFile = options.output || path.join('ai_validations', `${prNumber}.json`);
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
  
  console.log(chalk.green(`📊 Analysis complete! Found ${report.summary.totalIssues} potential issues in ${report.summary.i18nFiles} i18n files`));
  
  return report;
}

async function analyzeFile(file, pr) {
  try {
    // Get the diff content
    const diff = file.patch;
    
    if (!diff) {
      console.log(chalk.yellow(`    ⚠️  No diff available for ${file.filename}`));
      return null;
    }

    // Extract changed lines
    const changedLines = extractChangedLines(diff);
    
    if (changedLines.length === 0) {
      console.log(chalk.yellow(`    ⚠️  No changed lines found in ${file.filename}`));
      return null;
    }

    console.log(chalk.cyan(`    📝 Found ${changedLines.length} changed lines`));

    // Analyze with AI
    const aiAnalysis = await analyzeWithAI(file.filename, changedLines, pr.title);
    
    return {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changedLines: changedLines,
      issues: aiAnalysis.issues || [],
      suggestions: aiAnalysis.suggestions || [],
      aiSummary: aiAnalysis.summary || '',
    };

  } catch (error) {
    console.error(chalk.red(`    ❌ Error analyzing ${file.filename}:`), error.message);
    return {
      filename: file.filename,
      error: error.message,
      issues: [],
      suggestions: [],
    };
  }
}

function extractChangedLines(diff) {
  const lines = diff.split('\n');
  const changedLines = [];
  let currentLineNumber = 0;
  let addedLineNumber = 0;
  let removedLineNumber = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('@@')) {
      // Parse the @@ line to get line numbers
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match) {
        removedLineNumber = parseInt(match[1]);
        addedLineNumber = parseInt(match[3]);
        currentLineNumber = addedLineNumber;
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      // Added line
      changedLines.push({
        type: 'added',
        content: line.substring(1),
        lineNumber: currentLineNumber,
        position: currentLineNumber
      });
      currentLineNumber++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line
      changedLines.push({
        type: 'removed',
        content: line.substring(1),
        lineNumber: removedLineNumber,
        position: removedLineNumber
      });
      removedLineNumber++;
    } else if (!line.startsWith('+++') && !line.startsWith('---')) {
      // Context line (unchanged)
      currentLineNumber++;
      removedLineNumber++;
    }
  }
  
  return changedLines;
}

async function analyzeWithAI(filename, changedLines, prTitle) {
  const directions = {
    role: 'developer',
    content: `You are an AI assistant analyzing i18n (internationalization) changes in a Ghost 
    (blogging and newsletter publishing platform) repository.
We are validating translations from English to the given language.

Please analyze these i18n changes and provide:
1. Any potential issues or concerns
2. Suggestions for improvements
3. A brief summary of the changes

Focus specifically on:
- **Translation Quality**: Are the translations accurate and appropriate?
- **Cultural Sensitivity**: Are the translations culturally appropriate?
- **Context**: Do the translations make sense in their intended context?
- Is there any attempt to deface? 
- Are there any typos or grammar errors?

Format your response as JSON with the following structure:
{
  "issues": [
    {
      "type": "error|warning|info",
      "message": "Description of the issue",
      "line": "line number or content",
      "position": line_number,
      "suggestion": "How to fix it"
    }
  ],
  "suggestions": [
    {
      "type": "improvement",
      "message": "Description of the suggestion",
      "line": "line number or content",
      "position": line_number
    }
  ],
  "summary": "Brief summary of the i18n changes and overall assessment"
}`
  };

  const content = `PR Title: ${prTitle}
File: ${filename}

Changed Lines:
${changedLines.map((line, index) => 
  `${index + 1}. [${line.type.toUpperCase()}] Line ${line.position}: ${line.content}`
).join('\n')}`;

  try {
    const response = await openai.beta.chat.completions.parse({
      model: "gpt-4o-mini",
      messages: [
        directions,
        { role: 'assistant', content: content }
      ],
      response_format: {type: 'json_object'}
    });
    
    if (!response.choices[0] || !response.choices[0].message || !response.choices[0].message.content || response.choices[0].refusal) {
      console.log(chalk.red(`    ❌ AI response failed for ${filename}`));
      return {
        issues: [],
        suggestions: [],
        summary: "AI analysis failed - no valid response"
      };
    }
    
    return JSON.parse(response.choices[0].message.content);

  } catch (error) {
    console.log(chalk.red(`    ❌ AI analysis failed for ${filename}:`), error.message);
    return {
      issues: [],
      suggestions: [],
      summary: "AI analysis failed"
    };
  }
} 