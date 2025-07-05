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

  // Collect all comments from all files
  const allComments = [];
  const overallComments = [];
  
  for (const file of report.files) {
    if (file.issues.length > 0 || file.suggestions.length > 0 || file.overall) {
      // Process issues
      for (const issue of file.issues) {
        if (typeof issue.diffPosition === 'number' && issue.diffPosition > 0) {
          allComments.push({
            path: file.filename,
            position: issue.diffPosition,
            body: formatLineComment(issue, 'issue')
          });
        }
      }

      // Process suggestions
      for (const suggestion of file.suggestions) {
        if (typeof suggestion.diffPosition === 'number' && suggestion.diffPosition > 0) {
          allComments.push({
            path: file.filename,
            position: suggestion.diffPosition,
            body: formatLineComment(suggestion, 'suggestion')
          });
        }
      }

      // Collect overall comments
      if (file.overall && file.overall.trim()) {
        overallComments.push(`${file.filename}: ${file.overall}`);
      }
    }
  }

  console.log(chalk.blue(`📝 Preparing ${allComments.length} line comments for ${report.files.filter(f => f.issues.length > 0 || f.suggestions.length > 0 || f.overall).length} files...`));

  if (allComments.length === 0 && overallComments.length === 0) {
    console.log(chalk.yellow('⚠️  No comments to post'));
    return;
  }

  // Create a single draft review with all comments
  try {
    // Check for existing pending reviews
    const { data: existingReviews } = await octokit.pulls.listReviews({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
    });

    const pendingReview = existingReviews.find(review => review.state === 'PENDING');
    
    if (pendingReview) {
      // Update existing pending review
      console.log(chalk.blue(`📝 Found existing pending review, adding ${allComments.length} comments...`));
      
      // Add new comments to existing review
      for (const comment of allComments) {
        await octokit.pulls.createReviewComment({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          pull_number: prNumber,
          body: comment.body,
          commit_id: pendingReview.commit_id,
          path: comment.path,
          position: comment.position
        });
      }

      // Update review body if there are overall comments
      if (overallComments.length > 0) {
        const newBody = pendingReview.body 
          ? `${pendingReview.body}\n\n---\n${formatOverallComments(overallComments)}`
          : formatOverallComments(overallComments);
          
        await octokit.pulls.updateReview({
          owner: process.env.GITHUB_OWNER,
          repo: process.env.GITHUB_REPO,
          pull_number: prNumber,
          review_id: pendingReview.id,
          body: newBody
        });
      }

      console.log(chalk.green(`✅ Added ${allComments.length} comments to existing review`));
      
    } else {
      // Create new draft review with all comments
      const reviewBody = overallComments.length > 0 
        ? formatOverallComments(overallComments)
        : undefined;

      await octokit.pulls.createReview({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        pull_number: prNumber,
        comments: allComments,
        body: reviewBody,
        // No event specified = creates a draft review
      });

      console.log(chalk.green(`✅ Created draft review with ${allComments.length} line comments`));
      console.log(chalk.blue(`📝 You can now edit the review in GitHub before submitting it`));
    }
    
  } catch (error) {
    console.error(chalk.red(`❌ Failed to create/update review:`), error.message);
  }

  console.log(chalk.green('✅ All line comments posted successfully!'));
}

function formatLineComment(item, type) {
  const icon = type === 'issue' ? getIssueIcon(item.type) : '💡';
  
  let body = `My AI helper says: ${icon} ${item.message}\n\n`;
  
  return body;
}

function formatOverallComments(overallComments) {
  const formattedComments = overallComments.map(comment => `📋 ${comment}`).join('\n\n');
  return `${formattedComments}\n\n---\n*Drafted with Ghost i18n tooling*`;
}

function formatOverallComment(overall) {
  return `📋 ${overall}\n\n---\n*Drafted with Ghost i18n tooling*`;
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

export async function deleteEmptyPendingReview(prNumber) {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
    });
    const pendingReview = reviews.find(r => r.state === 'PENDING');
    if (!pendingReview) {
      console.log('No pending review found.');
      return;
    }
    // Check for comments on the pending review
    const { data: comments } = await octokit.pulls.listCommentsForReview({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      pull_number: prNumber,
      review_id: pendingReview.id,
    });
    if (comments.length === 0) {
      await octokit.pulls.deletePendingReview({
        owner: process.env.GITHUB_OWNER,
        repo: process.env.GITHUB_REPO,
        pull_number: prNumber,
        review_id: pendingReview.id,
      });
      console.log('✅ Deleted empty pending review.');
    } else {
      console.log('❌ Pending review has comments and will not be deleted.');
    }
  } catch (error) {
    console.error('Error deleting pending review:', error.message);
  }
}


 