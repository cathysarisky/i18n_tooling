import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { extractAddedLinesWithRelativeNumbers } from './diff-util.js';

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

// Cache for context.json file (24-hour expiration)
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CONTEXT_CACHE_FILE = path.join(CACHE_DIR, 'context.json');
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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

  // Get context.json once for all files (cached for 24 hours)
  console.log(chalk.blue('📖 Fetching context.json (will be cached for 24 hours)...'));
  const contextContent = await getOriginalFileContent('ghost/i18n/locales/context.json');

  // Collect all file changes for consolidated AI analysis
  const allFileChanges = [];
  
  for (const file of relevantFiles) {
    console.log(chalk.cyan(`  📄 ${file.filename}`));
    
    // Extract changed lines for this file
    const diff = file.patch;
    if (!diff) {
      console.log(chalk.yellow(`    ⚠️  No diff available for ${file.filename}`));
      continue;
    }

    const changedLines = extractChangedLines(diff);
    if (changedLines.length === 0) {
      console.log(chalk.yellow(`    ⚠️  No changed lines found in ${file.filename}`));
      continue;
    }

    const addedLines = changedLines.filter(line => line.type === 'added');
    console.log(chalk.cyan(`    📝 Found ${addedLines.length} added lines to analyze`));

    // Get the current file content from the PR for context
    const currentFileContent = await getCurrentFileContent(file.filename, pr);

    allFileChanges.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changedLines: changedLines,
      currentFileContent: currentFileContent
    });
  }

  // Analyze all files together with a single AI call
  const aiAnalysis = await analyzeAllFilesWithAI(allFileChanges, pr.title, pr, contextContent, options.debug || process.env.DEBUG === 'true');

  // Generate the overall comment for the entire PR (not per file)
  let overallComment = "My AI helper 🤖 left you a few comments.  I always believe the human over the AI, so feel free to disregard them after you take a careful look! \n\n Leave me a comment when you're satisfied with everything, please. :) ";
  if (aiAnalysis.overall) {
    overallComment += `\n\n🤖 AI: ${aiAnalysis.overall}`;
  }

  // Process AI analysis results back into file-specific format
  for (const fileChange of allFileChanges) {
    const fileComments = aiAnalysis.comments.filter(comment => 
      comment.filename === fileChange.filename
    );
    
    analysisResults.push({
      filename: fileChange.filename,
      status: fileChange.status,
      additions: fileChange.additions,
      deletions: fileChange.deletions,
      changedLines: fileChange.changedLines,
      comments: fileComments,
    });
  }

  // Generate report
  const report = {
    prNumber: parseInt(prNumber),
    prTitle: pr.title,
    prUrl: pr.html_url,
    analyzedAt: new Date().toISOString(),
    files: analysisResults,
    skippedFiles: nonI18nFiles.map(f => ({ filename: f.filename, status: f.status })),
    overallComment: overallComment,
    summary: {
      totalFiles: files.length,
      i18nFiles: relevantFiles.length,
      skippedFiles: nonI18nFiles.length,
      filesWithComments: analysisResults.filter(r => r.comments && r.comments.length > 0).length,
      totalComments: analysisResults.reduce((sum, r) => sum + (r.comments ? r.comments.length : 0), 0),
    }
  };

  // Save report
  const outputFile = options.output || path.join('ai_validations', `${prNumber}.json`);
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
  
  console.log(chalk.green(`📊 Analysis complete! Found ${report.summary.totalComments} potential comments in ${report.summary.i18nFiles} i18n files`));
  
  return report;
}



function extractChangedLines(diff) {
  // Use the shared diff utility to get added lines with relative line numbers
  const addedLines = extractAddedLinesWithRelativeNumbers(diff);
  let addedCount = 0;
  let deletedCount = 0;
  const lines = diff.split('\n');
  let removedLineNumber = 0;
  let globalDiffPosition = 0;

  // For logging and to keep the same interface as before, we also count deleted lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match) {
        removedLineNumber = parseInt(match[1]);
      }
    } else {
      globalDiffPosition++;
      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedCount++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletedCount++;
        removedLineNumber++;
      }
    }
  }

  // Log summary
  console.log(chalk.gray(`    📊 Found ${addedCount} added lines and ${deletedCount} deleted lines (only analyzing added lines)`));

  // Map to the expected format for downstream code
  return addedLines.map(l => ({
    type: 'added',
    content: l.content,
    diffPosition: l.relativeLine, // This is the correct GitHub API position
    fileLineNumber: l.newLine
  }));
}



export async function getOriginalFileContent(filename) {
  try {
    // Ensure cache directory exists
    await fs.mkdir(CACHE_DIR, { recursive: true });
    
    // Check if we have a valid cached version
    const now = Date.now();
    try {
      const stats = await fs.stat(CONTEXT_CACHE_FILE);
      const age = now - stats.mtime.getTime();
      
      if (age < CACHE_EXPIRY) {
        const cachedContent = await fs.readFile(CONTEXT_CACHE_FILE, 'utf8');
        console.log(chalk.gray(`    📖 Using cached context.json (${cachedContent.length} characters)`));
        return cachedContent;
      }
    } catch (error) {
      // Cache file doesn't exist or is invalid, will fetch fresh
    }

    console.log(chalk.gray(`    📖 Fetching context.json from Ghost repository...`));
    
    // Fetch the context.json file from the Ghost repository
    const { data: fileContent } = await octokit.repos.getContent({
      owner: 'TryGhost',
      repo: 'Ghost',
      path: 'ghost/i18n/locales/context.json',
      ref: 'main' // or 'master' depending on the default branch
    });
    
    // Decode the content (GitHub returns it base64 encoded)
    const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
    
    // Save to cache file
    await fs.writeFile(CONTEXT_CACHE_FILE, content, 'utf8');
    
    console.log(chalk.gray(`    ✅ Found context.json (${content.length} characters) - cached for 24 hours`));
    return content;
    
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️  Could not fetch context.json: ${error.message}`));
    return null;
  }
}

async function getCurrentFileContent(filename, pr) {
  try {
    console.log(chalk.gray(`    📖 Fetching current file content from PR...`));
    
    // Get the file content from the PR's head branch
    const { data: fileContent } = await octokit.repos.getContent({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      path: filename,
      ref: pr.head.sha // Use the PR's head commit SHA instead of branch name
    });
    
    // Decode the content (GitHub returns it base64 encoded)
    const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
    
    console.log(chalk.gray(`    ✅ Found current file content (${content.length} characters)`));
    return content;
    
  } catch (error) {
    console.log(chalk.yellow(`    ⚠️  Could not fetch current file content: ${error.message}`));
    return null;
  }
}

async function analyzeAllFilesWithAI(allFileChanges, prTitle, pr, contextContent, debug = false) {
  // Filter out files with no added lines
  const filesWithChanges = allFileChanges.filter(file => {
    const addedLines = file.changedLines.filter(line => line.type === 'added');
    return addedLines.length > 0;
  });

  if (filesWithChanges.length === 0) {
    return {
      comments: [],
      overall: "No added translations to analyze"
    };
  }

  // Get all valid diffPosition values for the AI
  const validPositions = filesWithChanges.flatMap(file => 
    file.changedLines.filter(line => line.type === 'added').map(line => ({
      filename: file.filename,
      diffPosition: line.diffPosition
    }))
  );

  const directions = {
    role: 'developer',
    content: `You are an AI assistant analyzing i18n (internationalization) changes in a Ghost 
    (blogging and newsletter publishing platform) repository.
We are validating translations from English to the given language.  Do not critique or correct the English, only the translations.

Please validate these i18n additions or changes across multiple files.

Focus specifically on:
- Is there any attempt to deface? 
- Are there any typos or grammar errors?
- Are the translations accurate and appropriate?

These translations were produced by a human who is a native speaker of the target language.
Word any feedback in a polite way that respects their authority as the native speaker.  Ask questions 
about things that might be errors.  "Is the spelling of ___ correct?"  Say "I think" or "I suspect".
Be polite and deferential to the translator's expertise, 
but tell them if you suspect they've made an error.

Match the ending punctuation of the original English.  Translators should not add or remove punctuation. You don't need
to phrase that as a question.  

Say "please" occasionally.

Do not nitpick wording too much.  Only leave a comment or suggestion if it looks like an error on the part of the translator.

Raise any number of issues.

Only make suggestions if they are specific and actionable.

### Write an overall comment:
- Overall translation quality and consistency
- Any patterns or trends across multiple files
- General tone and style consistency
- Any systemic issues that affect multiple translations
- Do NOT repeat what's already listed in the comments. 

### Format your response as JSON with the following structure:
{
  "comments": [
    {
      "type": "error|warning|info|suggestion",
      "filename": "filename.json",
      "diffPosition": diffPosition,
      "message": "[Your feedback here - be specific and actionable - please write in English]"
    }
  ],
  "overall": "[An 'overall' section is optional.  If you have any overall comments, please write them here.  Finish your comment with 'Thank you!' in the translator's own language.]"  
}

CRITICAL: For each issue or suggestion, you MUST use the exact diffPosition value that corresponds to the specific line containing the translation you are commenting on. 
You must also include the filename for each comment.

The valid diffPosition values for each file are:
${validPositions.map(pos => `${pos.filename}: ${pos.diffPosition}`).join(', ')}

IMPORTANT: Look at the translation content in each line and use the diffPosition that matches the line containing the specific translation you want to comment on.

### Directions provided to the translator:

- Formality: Ghost's brand has a friendly and fairly informal tone. If your language has both formal and informal form, choose one or the other and use it consistently. Most languages are using the informal version, but if the informal version might be considered rude, then choose the formal.
- All kinds of people use Ghost. When possible, prefer gender-neutral language.
- Translations should work for a variety of Ghost sites. Choose translations that will make sense for both personal blogs/newsletters and news publications.

### Common issues to avoid & other notes:

Consult the context.json file if you aren't sure how a string will be used.

In English, we use "Jamie Larson" for a placeholder in any field that needs a name. Please do not transliterate. Please do not replace with "Name". Instead, replace Jamie Larson with a name that will be recognized as a name in your language. Choose something uncontroversial and common. If possible, choose a non-gendered name.

Do not translate variables (inside {}). Do not add variables. If a translator has omitted a variable or made an error in the variable name, please note that in your comment.

Watch out for "You are receiving this because you are a %%{status}%% subscriber to {site}.'", which takes the "free", "trialing", "paid", and "complimentary" strings in the %%{status}%% field. These strings need to produce good grammar when substituted.

`
  };

  // Build content with all files
  const filesContent = filesWithChanges.map((file, index) => {
    const addedLines = file.changedLines.filter(line => line.type === 'added');
    return `File ${index + 1}: ${file.filename}
Current file content (for context):
${file.currentFileContent ? file.currentFileContent : 'Not available'}

Added Lines (translations to analyze):
${addedLines.map((line, lineIndex) => 
  `${lineIndex + 1}. [ADDED] diffPosition ${line.diffPosition}: ${line.content}`
).join('\n')}`;
  }).join('\n\n');

  const content = `PR Title: ${prTitle}

Ghost i18n context file for reference:
${contextContent ? contextContent : 'Not available'}

Files and changes in this PR:
${filesContent}`;

  if (debug) {
    console.log(chalk.blue('\n🤖 AI Request Details:'));
    console.log(chalk.gray('='.repeat(80)));
    console.log(chalk.cyan('📋 System Prompt:'));
    console.log(chalk.gray(directions.content));
    console.log(chalk.gray('='.repeat(80)));
    console.log(chalk.cyan('📄 User Content:'));
    console.log(chalk.gray(content));
    console.log(chalk.gray('='.repeat(80)));
    console.log(chalk.blue(`📊 Sending request to OpenAI (${content.length} characters)...`));
  }

  try {
    const response = await openai.beta.chat.completions.parse({
      model: "o4-mini",
      messages: [
        directions,
        { role: 'assistant', content: content }
      ],
      response_format: {type: 'json_object'}
    });
    
    if (!response.choices[0] || !response.choices[0].message || !response.choices[0].message.content || response.choices[0].refusal) {
      console.log(chalk.red(`    ❌ AI response failed`));
      return {
        comments: [],
        overall: "AI analysis failed - no valid response"
      };
    }
    
    const aiResponse = JSON.parse(response.choices[0].message.content);
    
    if (debug) {
      console.log(chalk.green('\n✅ AI Response:'));
      console.log(chalk.gray('='.repeat(80)));
      console.log(chalk.gray(JSON.stringify(aiResponse, null, 2)));
      console.log(chalk.gray('='.repeat(80)));
    }

    
    if (aiResponse.comments) {
      aiResponse.comments = aiResponse.comments.filter(comment => {
        const isValid = validPositions.some(pos => 
          pos.filename === comment.filename && pos.diffPosition === comment.diffPosition
        );
        if (!isValid) {
          console.log(chalk.yellow(`    ⚠️  Skipping comment with invalid position: ${comment.filename}:${comment.diffPosition}`));
        }
        return isValid;
      });
    }
    
    return aiResponse;

  } catch (error) {
    console.log(chalk.red(`    ❌ AI analysis failed:`), error.message);
    return {
      comments: [],
      overall: "AI analysis failed"
    };
  }
}
