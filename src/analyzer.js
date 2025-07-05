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

    const addedLines = changedLines.filter(line => line.type === 'added');
    console.log(chalk.cyan(`    📝 Found ${addedLines.length} added lines to analyze`));

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
      overall: aiAnalysis.overall || '',
    };

  } catch (error) {
    console.error(chalk.red(`    ❌ Error analyzing ${file.filename}:`), error.message);
    return {
      filename: file.filename,
      error: error.message,
      issues: [],
      suggestions: [],
      overall: '',
    };
  }
}

function extractChangedLines(diff) {
  const lines = diff.split('\n');
  const changedLines = [];
  let fileLineNumber = 0;
  let addedLineNumber = 0;
  let removedLineNumber = 0;
  let globalDiffPosition = 0; // global position across all hunks
  let addedCount = 0;
  let deletedCount = 0;

  console.log(chalk.gray(`    🔍 Analyzing diff with ${lines.length} lines...`));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match) {
        removedLineNumber = parseInt(match[1]);
        addedLineNumber = parseInt(match[3]);
        fileLineNumber = addedLineNumber;
        // DO NOT increment globalDiffPosition for hunk headers
        console.log(chalk.gray(`    📍 Hunk: -${removedLineNumber} +${addedLineNumber} (fileLineNumber: ${fileLineNumber})`));
      }
    } else {
      globalDiffPosition++;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        // Only track added lines (translations that were added)
        const addedLine = {
          type: 'added',
          content: line.substring(1),
          fileLineNumber: fileLineNumber,
          diffPosition: globalDiffPosition
        };
        changedLines.push(addedLine);
        console.log(chalk.gray(`    ➕ Added line ${addedCount + 1}: diffPosition=${globalDiffPosition}, fileLine=${fileLineNumber}, content="${line.substring(1).substring(0, 50)}..."`));
        fileLineNumber++;
        addedCount++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Track deleted lines for logging but don't include them in analysis
        deletedCount++;
        removedLineNumber++;
        console.log(chalk.gray(`    ➖ Deleted line: diffPosition=${globalDiffPosition}, content="${line.substring(1).substring(0, 50)}..."`));
      } else if (!line.startsWith('+++') && !line.startsWith('---')) {
        // Context lines (unchanged lines)
        fileLineNumber++;
      }
    }
  }
  
  console.log(chalk.gray(`    📊 Found ${addedCount} added lines and ${deletedCount} deleted lines (only analyzing added lines)`));
  return changedLines;
}

async function analyzeWithAI(filename, changedLines, prTitle) {
  // Only analyze added lines (translations that were added)
  const addedLines = changedLines.filter(line => line.type === 'added');
  
  if (addedLines.length === 0) {
    return {
      issues: [],
      suggestions: [],
      overall: "No added translations to analyze"
    };
  }

  const directions = {
    role: 'developer',
    content: `You are an AI assistant analyzing i18n (internationalization) changes in a Ghost 
    (blogging and newsletter publishing platform) repository.
We are validating translations from English to the given language.

Please validate these i18n additions or changes.

Focus specifically on:
- Is there any attempt to deface? 
- Are there any typos or grammar errors?
- Are the translations accurate and appropriate?

These translations are generally produced by a human who is a native speaker of the target language.
Word any feedback in a polite way that respects their authority as the native speaker.  Ask questions 
about things that might be errors.  "Would ___ be better?"  "Is the spelling of ___ correct?" 

Match the punctuation of the original English.  Translators should not add or remove punctuation.

Do not nitpick wording too much.  Only leave a comment or suggestion if it looks like an error on the part of the translator.

Raise any number of issues.

Make a maximum of two suggestions.  Do not make fluffy suggestions or offer compliments.

Write an "overall" section only if there is a general pattern affecting multiple lines, like inconsistent usage of formal vs informal, or inconsistent choices
of translation style.  (These sorts of comments could also go on a single line, if there is only one problem.)

Format your response as JSON with the following structure:
{
  "issues": [
    {
      "type": "error|warning|info",
      "diffPosition": diffPosition,
      "message": "Why it might be wrong, and how to fix it"
    }
  ],
  "suggestions": [
    {
      "type": "improvement",
      "message": "Why it might be wrong, and how to fix it",
      "diffPosition": diffPosition
    }
  ],
  "overall": "Any overall comments that don't belong on one line. Do not duplicate the issues or suggestions. Do not summarize. 
  If the issue is already covered in the issues or suggestions, do not repeat it.  An 'overall' section is optional.
  You can also say LGTM, no issues."
}

CRITICAL: For each issue or suggestion, you MUST use the exact diffPosition value that corresponds to the specific line containing the translation you are commenting on. 
The valid diffPosition values are: ${addedLines.map(line => line.diffPosition).join(', ')}

IMPORTANT: Look at the translation content in each line and use the diffPosition that matches the line containing the specific translation you want to comment on.
Do not make up or guess diffPositions. Do not reference line content or file line number for comment placement.
Only comment on ADDED lines (translations that were added). Do not comment on deleted lines.
`
  };

  const content = `PR Title: ${prTitle}
File: ${filename}

Added Lines (translations to analyze):
${addedLines.map((line, index) => 
  `${index + 1}. [ADDED] diffPosition ${line.diffPosition}: ${line.content}`
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
        overall: "AI analysis failed - no valid response"
      };
    }
    
    const aiResponse = JSON.parse(response.choices[0].message.content);
    
    // Validate that all diffPosition values are valid (only added lines)
    const validPositions = addedLines.map(line => line.diffPosition);
    
    if (aiResponse.issues) {
      aiResponse.issues = aiResponse.issues.filter(issue => {
        if (!validPositions.includes(issue.diffPosition)) {
          console.log(chalk.yellow(`    ⚠️  Skipping issue with invalid diffPosition ${issue.diffPosition} (not an added line)`));
          return false;
        }
        return true;
      });
    }
    
    if (aiResponse.suggestions) {
      aiResponse.suggestions = aiResponse.suggestions.filter(suggestion => {
        if (!validPositions.includes(suggestion.diffPosition)) {
          console.log(chalk.yellow(`    ⚠️  Skipping suggestion with invalid diffPosition ${suggestion.diffPosition} (not an added line)`));
          return false;
        }
        return true;
      });
    }
    
    return aiResponse;

  } catch (error) {
    console.log(chalk.red(`    ❌ AI analysis failed for ${filename}:`), error.message);
    return {
      issues: [],
      suggestions: [],
      overall: "AI analysis failed"
    };
  }
} 