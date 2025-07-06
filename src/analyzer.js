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
  const aiAnalysis = await analyzeAllFilesWithAI(allFileChanges, pr.title, pr, contextContent);

  // Process AI analysis results back into file-specific format
  for (const fileChange of allFileChanges) {
    const fileComments = aiAnalysis.comments.filter(comment => 
      comment.filename === fileChange.filename
    );
    
    let overallComment = "My AI helper left you a few comments.  I always believe the human over the AI, so feel free to disregard them!  Leave me a comment when you're satisfied with everything, please. :) ";
    if (aiAnalysis.overall) {
      overallComment += `\n\n
      My AI helper says: ${aiAnalysis.overall}`;
    }

    analysisResults.push({
      filename: fileChange.filename,
      status: fileChange.status,
      additions: fileChange.additions,
      deletions: fileChange.deletions,
      changedLines: fileChange.changedLines,
      comments: fileComments,
      overall: overallComment || '',
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
    overallComment: aiAnalysis.overall || "My AI helper left you a few comments. I always believe the human over the AI, so feel free to disregard them! Leave me a comment when you're satisfied with everything, please. :)",
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

async function analyzeAllFilesWithAI(allFileChanges, prTitle, pr, contextContent) {
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
We are validating translations from English to the given language.

Please validate these i18n additions or changes across multiple files.

Focus specifically on:
- Is there any attempt to deface? 
- Are there any typos or grammar errors?
- Are the translations accurate and appropriate?

These translations are generally produced by a human who is a native speaker of the target language.
Word any feedback in a polite way that respects their authority as the native speaker.  Ask questions 
about things that might be errors.  "Would ___ be better?"  "Is the spelling of ___ correct?" 

Match the punctuation of the original English.  Translators should not add or remove punctuation. You don't need
to phrase that as a question.

Do not nitpick wording too much.  Only leave a comment or suggestion if it looks like an error on the part of the translator.

Raise any number of issues.

Do not make fluffy suggestions or offer compliments.  Only make suggestions if they are specific and actionable.

Write an "overall" section only if there is a general pattern affecting multiple lines, like inconsistent usage of formal vs informal, or inconsistent choices
of translation style.  (These sorts of comments could also go on a single line, if there is only one problem.)  Do not write 
a summary. Do not repeat what's already in issues or suggestions.

Format your response as JSON with the following structure:
{
  "comments": [
    {
      "type": "error|warning|info|suggestion",
      "filename": "filename.json",
      "diffPosition": diffPosition,
      "message": "My AI helper says: [Your feedback here - be specific and actionable]"
    }
  ],
  "overall": "Any overall comments that don't belong on one line. Do not duplicate the comments. Do not summarize. 
  If the issue is already covered in the comments, do not repeat it. An 'overall' section is optional.
  You can also say LGTM, no issues."
}

CRITICAL: For each issue or suggestion, you MUST use the exact diffPosition value that corresponds to the specific line containing the translation you are commenting on. 
You must also include the filename for each comment.

The valid diffPosition values for each file are:
${validPositions.map(pos => `${pos.filename}: ${pos.diffPosition}`).join(', ')}

IMPORTANT: Look at the translation content in each line and use the diffPosition that matches the line containing the specific translation you want to comment on.
Do not make up or guess diffPositions. Do not reference line content or file line number for comment placement.
Only comment on ADDED lines (translations that were added). Do not comment on deleted lines.

Do not include the specific line number or diffPosition in the message field. 

Directions provided to the translator:
Notes & tips
🔖 For help getting started, see https://forum.ghost.org/t/help-translate-ghost-beta/37461 - the original directions were only for portal, but can be generalized to any language file.

🤖 NO AI translations, please. Native/very fluent speakers only.

✉ Read your email! Please make sure you have your Github notifications sent somewhere you will see them. Most PRs need at least one round of adjustment before merging.

🆕 New Github users are welcome! When you submit your PR, please make sure that the "files changed" tab shows only the changes you intended to make. If you have questions, please leave a comment and I'll try to help get you sorted out.

👋 Formality: Ghost's brand has a friendly and fairly informal tone. If your language has both formal and informal form, choose one or the other and use it consistently. Most languages are using the informal version, but if the informal version might be considered rude, then choose the formal.

🤗 All kinds of people use Ghost. When possible, prefer gender-neutral language.

👍 Translations should work for a variety of Ghost sites. Choose translations that will make sense for both personal blogs/newsletters and news publications.

👉 Please @ cathysarisky if you add a language PR. Thanks!

Common issues to avoid & other notes:
Please give your PR a descriptive title that includes the language you are working on.
Check before starting that there isn't another PR for the same language. If there is, please review it rather than duplicating work.
Consult the context.json file if you aren't sure how a string will be used.
We use "Jamie Larson" for a placeholder in any field that needs a name. Please do not transliterate. Please do not replace with "Name". Instead, choose a name that will be recognized as a name in your language. Choose something uncontroversial and common. If possible, choose a non-gendered name.
Do not translate variables (inside {}). Do not add variables. 
Watch out for "You are receiving this because you are a %%{status}%% subscriber to {site}.'", which takes the "free", "trialing", "paid", and "complimentary" strings in the %%{status}%% field. These strings need to work together.
If you are changing existing translations, please leave an explanation of why.
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

  try {
    const response = await openai.beta.chat.completions.parse({
      model: "gpt-4.1",
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

async function generateOverallComment(allFileChanges, prTitle, pr, contextContent) {
  if (allFileChanges.length === 0) {
    return null;
  }

  const directions = {
    role: 'developer',
    content: `You are an AI assistant analyzing i18n (internationalization) changes across multiple files in a Ghost (blogging and newsletter publishing platform) repository.

Please provide ONE overall assessment of the translation quality across all files in this PR.

Focus on:
- Overall translation quality and consistency
- Any patterns or trends across multiple files
- General tone and style consistency
- Any systemic issues that affect multiple translations

Do NOT provide line-specific comments - those are handled separately. Focus only on the big picture.

Format your response as a single, concise overall comment that summarizes the translation quality for the entire PR. Keep it friendly and constructive.

If the translations look good overall, you can simply say "LGTM" or "All translations look good!"`
  };

  const content = `PR Title: ${prTitle}

Ghost i18n context file for reference:
${contextContent ? contextContent : 'Not available'}

Files and changes in this PR:
${allFileChanges.map((file, index) => 
  `${index + 1}. ${file.filename}: ${file.additions} additions, ${file.deletions} deletions`
).join('\n')}

Please provide ONE overall assessment of the translation quality for this entire PR.`;

  try {
    const response = await openai.beta.chat.completions.parse({
      model: "gpt-4.1",
      messages: [
        directions,
        { role: 'assistant', content: content }
      ],
      response_format: {type: 'json_object'}
    });
    
    if (!response.choices[0] || !response.choices[0].message || !response.choices[0].message.content || response.choices[0].refusal) {
      console.log(chalk.red(`    ❌ AI overall analysis failed`));
      return "❌ AI overall analysis failed";
    }
    
    const aiResponse = JSON.parse(response.choices[0].message.content);
    return aiResponse.overall || "My AI helper left you a few comments. I always believe the human over the AI, so feel free to disregard them! Leave me a comment when you're satisfied with everything, please. :)";

  } catch (error) {
    console.log(chalk.red(`    ❌ AI overall analysis failed:`), error.message);
    return "❌ AI overall analysis failed";
  }
} 