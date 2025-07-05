import { Octokit } from '@octokit/rest';
import fs from 'fs/promises';
import chalk from 'chalk';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export async function postComments(prNumber, reportFile) {
  console.log(chalk.blue('📖 Loading report...'));
  
  // Load the report
  const reportContent = await fs.readFile(reportFile, 'utf8');
  const report = JSON.parse(reportContent);
  
  console.log(chalk.green(`✅ Loaded report for PR #${report.prNumber}`));
  console.log(chalk.cyan(`📊 Found ${report.summary.totalIssues} issues across ${report.summary.filesWithIssues} files`));

  // Group comments by file
  const commentsByFile = {};
  
  for (const file of report.files) {
    if (file.issues.length > 0 || file.suggestions.length > 0) {
      commentsByFile[file.filename] = {
        issues: file.issues,
        suggestions: file.suggestions,
        changedLines: file.changedLines || []
      };
    }
  }

  console.log(chalk.blue(`📝 Preparing line comments for ${Object.keys(commentsByFile).length} files...`));

  // Post line comments for each file
  for (const [filename, analysis] of Object.entries(commentsByFile)) {
    await postLineComments(prNumber, filename, analysis);
  }

  console.log(chalk.green('✅ All line comments posted successfully!'));
}

async function postLineComments(prNumber, filename, analysis) {
  console.log(chalk.cyan(`  📄 Posting line comments for ${filename}...`));

  const comments = [];
  
  // Process issues
  for (const issue of analysis.issues) {
    if (issue.line && issue.position) {
      comments.push({
        path: filename,
        position: issue.position,
        body: formatLineComment(issue, 'issue')
      });
    }
  }

  // Process suggestions
  for (const suggestion of analysis.suggestions) {
    if (suggestion.line && suggestion.position) {
      comments.push({
        path: filename,
        position: suggestion.position,
        body: formatLineComment(suggestion, 'suggestion')
      });
    }
  }

  if (comments.length === 0) {
    console.log(chalk.yellow(`    ⚠️  No line-specific comments for ${filename}`));
    return;
  }

  try {
    // Create a draft review with line comments
    // This creates a pending review that you can edit before submitting
    await octokit.pulls.createReview({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
      comments: comments,
      // No event specified = creates a draft review
    });

    console.log(chalk.green(`    ✅ Created draft review with ${comments.length} line comments for ${filename}`));
    console.log(chalk.blue(`    📝 You can now edit the review in GitHub before submitting it`));
    
  } catch (error) {
    console.error(chalk.red(`    ❌ Failed to create draft review for ${filename}:`), error.message);
  }
}

function formatLineComment(item, type) {
  const icon = type === 'issue' ? getIssueIcon(item.type) : '💡';
  const prefix = type === 'issue' ? item.type.toUpperCase() : 'SUGGESTION';
  
  let body = `${icon} **${prefix}**: ${item.message}\n\n`;
  
  if (item.suggestion) {
    body += `**Suggestion**: ${item.suggestion}\n\n`;
  }
  
  return body;
}

function getIssueIcon(type) {
  switch (type.toLowerCase()) {
    case 'error':
      return '❌';
    case 'warning':
      return '⚠️';
    case 'info':
      return 'ℹ️';
    default:
      return '📝';
  }
}


 